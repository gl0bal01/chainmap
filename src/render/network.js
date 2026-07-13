// =============================================================================
// render/network.js — vis-network setup + store->view mirroring + display
// projection (Feature Layer 1 noise reduction).
// The only module owning the LIVE on-screen view via `window.vis` (render/export.js
// also uses window.vis, but only for a throwaway offscreen export network).
//
// Projection: the store is mirrored 1:1 into base DataSets (full graph, source of
// truth). The Network renders vis DataViews layered on top — an edge DataView
// applies the active filters (threshold / hide-zero / hide-spam) and a node
// DataView hides nodes left with no visible edges. Edge width is amount-weighted.
// Filtering never mutates the store, so CSV/detail keep every per-tx row.
// NOTE: needs vis-network + a real DOM; manual canvas QA deferred to Stage C+.
// =============================================================================

import { TX_TYPE_GROUPS } from "../config.js";
import * as labels from "./labels.js";
import { passesFilters, filtersActive, edgeAmountNumber, edgeWidth, bundleEdges, ageColor } from "../display.js";
import { findCycleNodes } from "../roundTrips.js";
import { shouldHideNode } from "../sinkFaucet.js";
import { edgeSeverity } from "../riskFlags.js";
import { methodName } from "../selectors.js";
import { decodeInputText } from "../abiDecode.js";
import { escapeHtml } from "../format.js";

/**
 * @typedef {object} DisplayOptions
 * @property {number}  [minAmount]
 * @property {boolean} [hideZero]
 * @property {boolean} [hideSpam]
 * @property {Set<string>} [spamContracts]
 * @property {Set<string>} [spamSymbols]
 */

/**
 * @typedef {object} GraphView
 * @property {any} network
 * @property {(opts?:object)=>void} fit
 * @property {(ids?:string[])=>Record<string,{x:number,y:number}>} getPositions
 * @property {()=>void} refreshLabels
 * @property {()=>void} refreshProjection            recompute widths + filtered views
 * @property {(opts:DisplayOptions)=>void} setDisplayOptions
 * @property {(address:string)=>boolean} hasRenderedNode is this node currently visible?
 * @property {(address:string)=>void} focusNode select + center a visible node (no-op if hidden)
 * @property {(key:string)=>(string|null)} selectEdge resolve a raw edge key to the rendered id (bundle-aware) and select it; never throws
 * @property {()=>void} destroy
 */

// Etherscan action -> i18n label key, reused for edge hover titles.
const ACTION_LABEL_KEYS = new Map();
Object.values(TX_TYPE_GROUPS).forEach((infos) => {
  infos.forEach((info) => ACTION_LABEL_KEYS.set(info.action, info.labelKey));
});

function edgeTitle(edge, i18n) {
  const key = ACTION_LABEL_KEYS.get(edge.action) || `tx.type.${edge.group}`;
  return i18n.t(key);
}

// Hover tooltip for a contract-call edge: type + decoded method (selector name)
// + any human-readable calldata text, so the decoded data shows on the graph
// itself — no click into the details panel needed. The calldata text is
// untrusted, and vis renders string titles via innerHTML, so escape it (never
// strip — escapeHtml keeps the message intact and is safe in that context).
function edgeDataTitle(edge, i18n) {
  const parts = [`${edgeTitle(edge, i18n)} · ${i18n.t("legend.data")}`];
  const name = edge.methodId ? methodName(edge.methodId) : null;
  if (name) parts.push(`${edge.methodId} ${name}`);
  const text = decodeInputText(edge.rawInput);
  if (text) parts.push(`“${escapeHtml(text.slice(0, 80))}”`);
  return parts.join(" · ");
}

const DEFAULT_FIT_OPTS = { animation: { duration: 400, easingFunction: "easeInOutQuad" } };

function buildOptions(layout) {
  const options = {
    nodes: { shape: "dot", size: 14, font: { color: "#e6e6e6", size: 12 }, borderWidth: 1 },
    edges: {
      arrows: { to: { enabled: true, scaleFactor: 0.6 } },
      smooth: { type: "dynamic" },
      font: { size: 9, color: "#aab2c0", strokeWidth: 0 },
      color: { inherit: false },
    },
    physics: {
      stabilization: false,
      barnesHut: { gravitationalConstant: -6000, springLength: 140, springConstant: 0.02 },
    },
    interaction: { hover: true, multiselect: true },
  };
  if (layout === "hierarchical") {
    options.layout = { hierarchical: { enabled: true, direction: "LR", sortMethod: "directed" } };
  }
  return options;
}

/**
 * @param {HTMLElement} container
 * @param {import('../graphStore.js').GraphStore} store
 * @param {{ i18n:import('../i18n.js').I18n, getAddressFormat:()=>('short'|'full'),
 *           getLayout?:()=>('force'|'hierarchical'),
 *           getKnownLabel?:(address:string)=>(string|null),
 *           getHubKind?:(address:string)=>('sink'|'faucet'|null),
 *           getHubDimOn?:()=>boolean,
 *           getCategory?:(address:string)=>(string|null),
 *           getEdgeFlags?:(edge:import('../graphStore.js').EdgeRecord)=>string[] }} deps
 * @returns {GraphView}
 */
export function createGraphView(container, store, deps) {
  const { i18n, getAddressFormat, getLayout, getKnownLabel, getHubKind, getHubDimOn, getCategory, getEdgeFlags } = deps;
  const vis = window.vis;

  const nodesDS = new vis.DataSet([]); // full graph (mirror of store) + annotation nodes
  const edgesDS = new vis.DataSet([]);

  /** @type {DisplayOptions} */
  const display = { minAmount: 0, hideZero: false, hideSpam: false, minTime: 0, maxTime: 0, spamContracts: new Set(), spamSymbols: new Set() };
  let visibleNodes = null; // null => show all; Set => only these
  let maxAmount = 0;
  let bundled = false;
  let hubHidden = { faucet: false, sink: false }; // reversible faucet/sink hide (display projection only)
  // Investigator overlays
  let roundTripOn = false;
  let roundTripSet = new Set(); // addresses on a directed cycle
  let peelNodes = new Set(); // addresses on a highlighted peel chain
  const PEEL_COLOR = "#7b61ff";
  let colorByAge = false;
  let ageMin = 0;
  let ageMax = 0;
  const bundledDS = new vis.DataSet([]); // collapsed edges when bundling is on

  // Annotations (sticky notes): non-graph overlay nodes with id "note:N".
  const annotations = []; // { id, text, x, y }
  let annCounter = 0;

  const edgesView = new vis.DataView(edgesDS, { filter: (e) => passesFilters(e.data, display) });
  const nodesView = new vis.DataView(nodesDS, {
    filter: (n) => {
      if (n.group === "annotation") return true;
      if (!(visibleNodes === null || visibleNodes.has(n.id))) return false;
      // Node DataSet items only carry `.id` (the lowercased address) — applyNode()
      // never sets a separate `.address` field — so look hub kind up by id.
      const kind = getHubKind ? getHubKind(n.id) : null;
      return !shouldHideNode(kind, hubHidden);
    },
  });

  const layout = getLayout ? getLayout() : "force";
  const network = new vis.Network(container, { nodes: nodesView, edges: edgesView }, buildOptions(layout));

  const knownFor = (address) => (getKnownLabel ? getKnownLabel(address) : null);

  const hubFor = (address) => (getHubKind ? getHubKind(address) : null);

  const catFor = (address) => (getCategory ? getCategory(address) : null);
  const CAT_ICON = { mixer: "🌀", bridge: "🌉", sanctioned: "⛔" };

  const flagsForEdgeView = (edge) => (getEdgeFlags ? getEdgeFlags(edge) : []);
  const RISK_COLOR = { high: "#e0603a", info: "#d8b24a" }; // red danger, soft-amber info
  const RISK_MARK = { high: "⚠", info: "ⓘ" };

  function applyNode(node) {
    const knownLabel = knownFor(node.address);
    const visual = labels.nodeVisual(node, { knownLabel });
    const hub = hubFor(node.address); // 'sink' | 'faucet' | null — used for title + (elsewhere) hide filter
    const dimOn = getHubDimOn ? getHubDimOn() : false; // dim-only toggle, decoupled from hide
    const bg = hub && dimOn ? "#3f4048" : visual.color; // de-emphasize detected sink/faucet hubs only when dim-only toggle is on
    const rt = roundTripOn && roundTripSet.has(node.address); // on a cycle -> amber ring
    const onPeel = peelNodes.has(node.address); // on a highlighted peel chain -> violet ring (wins over round-trip)
    const cat = catFor(node.address);
    const icon = CAT_ICON[cat] || "";
    const baseTitle = hub ? `${visual.title} · ${i18n.t("risk." + hub)}` : visual.title;
    const ringColor = onPeel ? PEEL_COLOR : (rt ? "#e8b84f" : null);
    nodesDS.update({
      id: node.address,
      label: labels.nodeLabel(node, { addressFormat: getAddressFormat(), knownLabel }),
      color: ringColor ? { background: bg, border: ringColor } : bg,
      borderWidth: ringColor ? 3 : 1,
      title: icon ? `${icon} ${baseTitle}` : baseTitle,
    });
  }

  function applyEdge(edge) {
    const amount = edgeAmountNumber(edge);
    if (amount > maxAmount) maxAmount = amount;
    const base = labels.edgeLabel(edge);
    // Contract-call edges (non-empty calldata) are dashed + marked "✱" so an
    // investigator can spot interactions vs plain transfers at a glance.
    // Risk-flagged edges escalate further, tiered by severity: 'high' (mixer/
    // bridge/sanctioned — money-flow waypoints or blocklist hits) gets the loud
    // red "⚠" treatment; 'info' (unlimited approval, hidden recipient — context,
    // not a verdict) gets a quieter amber "ⓘ" so it doesn't drown out real danger.
    const flags = flagsForEdgeView(edge);
    const sev = edgeSeverity(flags);
    const label = sev ? `${base ? base + " " : ""}${RISK_MARK[sev]}` : (edge.hasData ? (base ? `${base} ✱` : "✱") : base);
    const title = sev
      ? `${edgeTitle(edge, i18n)} · ${RISK_MARK[sev]} ${flags.map((k) => i18n.t(k)).join(", ")}`
      : (edge.hasData ? edgeDataTitle(edge, i18n) : edgeTitle(edge, i18n));
    edgesDS.add({
      id: edge.key,
      from: edge.from,
      to: edge.to,
      label,
      color: { color: sev ? RISK_COLOR[sev] : edgeColorFor(edge) },
      title,
      width: sev === "high" ? edgeWidth(amount, maxAmount) + 2 : sev === "info" ? edgeWidth(amount, maxAmount) + 1 : edgeWidth(amount, maxAmount),
      dashes: sev === "high" ? [6, 4] : sev === "info" ? [2, 3] : !!edge.hasData,
      data: edge,
    });
  }

  /** Edge color: age gradient when "color by age" is on, else the tx-type color. */
  function edgeColorFor(edge) {
    if (colorByAge) return ageColor(Number(edge.timeStamp), ageMin, ageMax);
    return edge.color;
  }

  /** Recompute amount max + age range, then push width + color to every edge. */
  function restyleEdges() {
    maxAmount = 0;
    let aMin = Infinity;
    let aMax = -Infinity;
    const items = edgesDS.get();
    items.forEach((it) => {
      const a = edgeAmountNumber(it.data);
      if (a > maxAmount) maxAmount = a;
      const t = Number(it.data.timeStamp);
      if (Number.isFinite(t) && t > 0) { if (t < aMin) aMin = t; if (t > aMax) aMax = t; }
    });
    ageMin = Number.isFinite(aMin) ? aMin : 0;
    ageMax = Number.isFinite(aMax) ? aMax : 0;
    // Respect flags here too — otherwise this recompute (amount/age refresh, filter
    // changes, …) would clobber the tiered risk color applyEdge set.
    edgesDS.update(items.map((it) => {
      const sev = edgeSeverity(flagsForEdgeView(it.data));
      const base = edgeWidth(edgeAmountNumber(it.data), maxAmount);
      return {
        id: it.id,
        width: sev === "high" ? base + 2 : sev === "info" ? base + 1 : base,
        color: { color: sev ? RISK_COLOR[sev] : edgeColorFor(it.data) },
      };
    }));
  }

  function recomputeVisibleNodes() {
    if (!filtersActive(display)) {
      visibleNodes = null;
      return;
    }
    const ids = new Set();
    edgesView.get().forEach((e) => {
      ids.add(e.from);
      ids.add(e.to);
    });
    store.listNodes().forEach((n) => {
      if (n.isRoot) ids.add(n.address);
    });
    visibleNodes = ids;
  }

  // Bundling: collapse the currently-visible per-tx edges into one arrow per
  // (from,to,contract,symbol). Store per-tx rows are untouched; memberKeys let the
  // detail panel drill back. Rebuilt from the FILTERED edge view.
  function rebuildBundles() {
    const records = edgesView.get().map((e) => e.data);
    const bundles = bundleEdges(records);
    let maxTotal = 0;
    bundles.forEach((b) => { if (b.total > maxTotal) maxTotal = b.total; });
    const flagsByKey = new Map(records.map((r) => [r.key, flagsForEdgeView(r)]));
    bundledDS.clear();
    bundledDS.add(
      bundles.map((b) => {
        const label = `${b.count}×  ${b.totalText} ${b.symbol}`.trim();
        const memberFlags = [...new Set((b.memberKeys || []).flatMap((k) => flagsByKey.get(k) || []))];
        const sev = edgeSeverity(memberFlags);
        const baseWidth = edgeWidth(b.total, maxTotal);
        const baseTitle = `${b.count} tx — ${b.totalText} ${b.symbol}`.trim();
        return {
          id: b.id,
          from: b.from,
          to: b.to,
          label: sev ? `${label} ${RISK_MARK[sev]}` : (b.hasData ? `${label} ✱` : label),
          color: { color: sev ? RISK_COLOR[sev] : b.color },
          width: sev === "high" ? baseWidth + 2 : sev === "info" ? baseWidth + 1 : baseWidth,
          dashes: sev === "high" ? [6, 4] : sev === "info" ? [2, 3] : !!b.hasData,
          title: sev ? `${baseTitle} · ${RISK_MARK[sev]} ${memberFlags.map((k) => i18n.t(k)).join(", ")}` : baseTitle,
          data: b,
          bundle: true,
        };
      })
    );
  }

  function refreshProjection() {
    edgesView.refresh();
    restyleEdges();
    if (roundTripOn) roundTripSet = findCycleNodes(store.listNodes(), store.listEdges());
    store.listNodes().forEach(applyNode); // reapply hub-dim + round-trip ring
    recomputeVisibleNodes();
    nodesView.refresh();
    if (bundled) rebuildBundles();
  }

  function setRoundTrip(on) {
    roundTripOn = !!on;
    roundTripSet = roundTripOn ? findCycleNodes(store.listNodes(), store.listEdges()) : new Set();
    store.listNodes().forEach(applyNode);
  }

  function setPeelChains(chains) {
    peelNodes = new Set((chains || []).flat());
    store.listNodes().forEach(applyNode);
  }

  function setColorByAge(on) {
    colorByAge = !!on;
    restyleEdges();
    if (bundled) rebuildBundles();
  }

  function setBundling(on) {
    bundled = !!on;
    if (bundled) {
      rebuildBundles();
      network.setData({ nodes: nodesView, edges: bundledDS });
    } else {
      network.setData({ nodes: nodesView, edges: edgesView });
    }
  }

  /** Return the underlying data for an edge id — an EdgeRecord, or a BundledEdge
   *  (with `.memberKeys`) when bundling is on. Null if not found. */
  function getEdgeData(id) {
    const item = (bundled ? bundledDS : edgesDS).get(id);
    return item ? item.data : null;
  }

  function setDisplayOptions(opts) {
    if (!opts) return;
    if (opts.minAmount !== undefined) display.minAmount = Number(opts.minAmount) || 0;
    if (opts.hideZero !== undefined) display.hideZero = !!opts.hideZero;
    if (opts.hideSpam !== undefined) display.hideSpam = !!opts.hideSpam;
    if (opts.minTime !== undefined) display.minTime = Number(opts.minTime) || 0;
    if (opts.maxTime !== undefined) display.maxTime = Number(opts.maxTime) || 0;
    if (opts.spamContracts) display.spamContracts = opts.spamContracts;
    if (opts.spamSymbols) display.spamSymbols = opts.spamSymbols;
    refreshProjection();
  }

  // --- layout / hubs / annotations -----------------------------------------

  /** Switch between force-directed and hierarchical (left-to-right) layout live. */
  function setLayout(mode) {
    if (mode === "hierarchical") {
      network.setOptions({ layout: { hierarchical: { enabled: true, direction: "LR", sortMethod: "directed" } } });
    } else {
      network.setOptions({
        layout: { hierarchical: { enabled: false } },
        physics: { enabled: true, barnesHut: { gravitationalConstant: -6000, springLength: 140, springConstant: 0.02 } },
      });
    }
  }

  /** Re-apply node visuals (e.g. after hub classification changes). */
  function refreshHubs() {
    store.listNodes().forEach(applyNode);
  }

  /** Reversibly hide classified faucet/sink nodes from the node view. Display
   *  projection only — the store (and thus CSV/detail data) is untouched, and
   *  dangling edges to a hidden node simply stop rendering (vis-network hides
   *  edges whose endpoint isn't in the node view). */
  function setHubHidden(next) {
    hubHidden = { faucet: !!(next && next.faucet), sink: !!(next && next.sink) };
    nodesView.refresh();
  }

  /** True iff `address` is currently visible in the (filtered) node view — used
   *  by the command palette to decide whether a jump-to needs an auto-reveal. */
  function hasRenderedNode(address) {
    return nodesView.get(address) != null;
  }

  /** Select + center a node the palette jumped to. No-op (no throw) if the node
   *  isn't currently in the view — caller reveals it first. */
  function focusNode(address) {
    if (nodesView.get(address) == null) return;
    network.selectNodes([address]);
    network.focus(address, { scale: network.getScale(), animation: true });
  }

  /** Resolve a RAW store edge key to whatever id is CURRENTLY RENDERED for it
   *  and select it — never throws, unlike a bare `network.selectEdges`/
   *  `setSelection`, which raise a RangeError for an id vis-network doesn't
   *  currently know about (e.g. the raw key while bundling is on collapses it
   *  into a `bundle:...` id, or the edge is filtered out of the active view).
   *  bundling OFF: selects `key` itself if it's still in edgesDS.
   *  bundling ON: selects the bundle whose memberKeys contains `key`.
   *  Returns the id actually selected, or null if nothing was selected. */
  function selectEdge(key) {
    if (!bundled) {
      if (edgesDS.get(key) == null) return null;
      try {
        network.selectEdges([key]);
        return key;
      } catch {
        return null;
      }
    }
    const bundle = bundledDS.get().find((b) => b.data && Array.isArray(b.data.memberKeys) && b.data.memberKeys.includes(key));
    if (!bundle) return null;
    try {
      network.selectEdges([bundle.id]);
      return bundle.id;
    } catch {
      return null;
    }
  }

  function addAnnotationAt(text, x, y) {
    const id = `note:${annCounter++}`;
    const ann = { id, text: String(text), x: x || 0, y: y || 0 };
    annotations.push(ann);
    nodesDS.add({
      id,
      label: ann.text,
      group: "annotation",
      shape: "box",
      physics: false,
      x: ann.x,
      y: ann.y,
      color: { background: "#2a2410", border: "#6b5a1a" },
      font: { color: "#e8d68a" },
    });
    return ann;
  }

  function addAnnotation(text) {
    return addAnnotationAt(text, 0, 0);
  }

  function clearAnnotations() {
    annotations.forEach((a) => nodesDS.remove(a.id));
    annotations.length = 0;
  }

  /** Current annotations with live positions (for save/export). */
  function getAnnotations() {
    const pos = network.getPositions(annotations.map((a) => a.id));
    return annotations.map((a) => ({ text: a.text, x: (pos[a.id] || a).x, y: (pos[a.id] || a).y }));
  }

  function setAnnotations(list) {
    clearAnnotations();
    (list || []).forEach((a) => addAnnotationAt(a.text, a.x, a.y));
  }

  const unsubscribe = store.subscribe((e) => {
    switch (e.type) {
      case "node:add":
      case "node:update":
        applyNode(e.node);
        if (filtersActive(display)) {
          recomputeVisibleNodes();
          nodesView.refresh();
        }
        break;
      case "node:remove": {
        // Store already emits edge:remove for each connected edge from edgesDS;
        // this sweep is defensive (when bundled, network shows bundledDS so these
        // ids won't match — the real removal came via the edge:remove events).
        const edgeIds = network.getConnectedEdges(e.address);
        if (edgeIds.length) edgesDS.remove(edgeIds);
        nodesDS.remove(e.address);
        if (bundled) rebuildBundles();
        break;
      }
      case "edge:add":
        applyEdge(e.edge);
        if (filtersActive(display)) {
          recomputeVisibleNodes();
          nodesView.refresh();
        }
        break;
      case "edge:remove":
        edgesDS.remove(e.key);
        if (bundled) rebuildBundles(); // keep collapsed arrows current when a member is pruned
        break;
      case "alias:set": {
        const node = store.getNode(e.address);
        if (node) applyNode(node);
        break;
      }
      case "reset":
        nodesDS.clear();
        edgesDS.clear();
        bundledDS.clear();
        annotations.length = 0;
        annCounter = 0;
        maxAmount = 0;
        visibleNodes = null;
        break;
      default:
        break;
    }
  });

  return {
    network,
    fit: (opts) => network.fit(opts || DEFAULT_FIT_OPTS),
    getPositions: (ids) => network.getPositions(ids ?? nodesDS.getIds()),
    refreshLabels: () => store.listNodes().forEach(applyNode),
    refreshProjection,
    setDisplayOptions,
    setBundling,
    getEdgeData,
    setLayout,
    setRoundTrip,
    setPeelChains,
    setColorByAge,
    refreshHubs,
    setHubHidden,
    hasRenderedNode,
    focusNode,
    selectEdge,
    addAnnotation,
    clearAnnotations,
    getAnnotations,
    setAnnotations,
    destroy: () => {
      unsubscribe();
      network.destroy();
    },
  };
}
