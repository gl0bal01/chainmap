// =============================================================================
// main.js — composition root. Wires the DOM (index.html) to the modules.
//
// Stage A: i18n bootstrap + language toggle + chain list + persistence.
// Stage C (this file): construct GraphStore + GraphView + interactions, wire
// Start/Stop/Reset to scanner.runScan, export (PNG/PDF/CSV), details panel,
// logger, status, request indicator, sampling banner, alias rename, prune,
// rotation, high-degree select, fit, address-format + locale live refresh.
//
// graphStore is the single source of truth; the view mirrors it via events. This
// file only orchestrates — it never mutates vis DataSets directly.
// =============================================================================

import { CHAINS, DEFAULTS, STORAGE_KEYS, LIMITS, DATA_PATHS, PROBE_CHAIN_IDS } from "./config.js";
import { createI18n } from "./i18n.js";
import en from "./locales/en.js";
import fr from "./locales/fr.js";
import { isValidAddress, isFailedTx, shortAddress } from "./format.js";
import { loadKnownAddresses, knownEntry, knownLabel, knownCategory, chainsForKnownAddress } from "./knownAddresses.js";
import { serializeWorkspace, parseWorkspace } from "./workspace.js";
import { estimateScan } from "./dryRun.js";
import { classifyHubs } from "./sinkFaucet.js";
import { findCycleNodes } from "./roundTrips.js";
import { findPeelChains } from "./peelChain.js";
import { scoreNode } from "./riskScore.js";
import { flagsForEdge } from "./riskFlags.js";
import { buildCanonicalIndex, isFakeToken } from "./fakeToken.js";
import { parseSpamList } from "./display.js";
import { detectAddress } from "./blockchainDetect.js";
import { rankChainActivity, probeChains } from "./chainProbe.js";
import { methodName } from "./selectors.js";
import { GraphStore } from "./graphStore.js";
import { RateLimiter } from "./rateLimiter.js";
import { createEtherscanClient } from "./etherscanClient.js";
import { runScan, loadOlder, selectedTypes } from "./scanner.js";
import { historyState } from "./history.js";
import { createGraphView } from "./render/network.js";
import { createPalette } from "./render/palette.js";
import { attachInteractions, rotateGraph, selectHighDegree } from "./render/interaction.js";
import { exportPng, exportPdf, exportCsv, triggerDownload } from "./render/export.js";
import {
  renderNodeDetails,
  renderEdgeDetails,
  renderBundleDetails,
  createLogger,
  createStatus,
  createRequestIndicator,
} from "./ui.js";

const $ = (id) => document.getElementById(id);
const clampInt = (raw, { min, max }, fallback) => {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};
const explorerFor = (chainId) => {
  const c = CHAINS.find((x) => String(x.id) === String(chainId));
  return c ? c.explorer : "etherscan.io";
};
const nativeSymbolFor = (chainId) => {
  const c = CHAINS.find((x) => String(x.id) === String(chainId));
  return c ? c.native : "ETH";
};
const chainName = (id) => (CHAINS.find((c) => String(c.id) === String(id)) || {}).name || String(id);
// Tx types ticked in the scan form (what a scan or a load fetches).
const formTypes = () =>
  selectedTypes({
    normal: $("typeNormal").checked,
    internal: $("typeInternal").checked,
    token: $("typeToken").checked,
  });

// --- i18n bootstrap ---------------------------------------------------------
const dictionaries = { en, fr };
const savedLocale = localStorage.getItem(STORAGE_KEYS.locale) || DEFAULTS.locale;
const i18n = createI18n({ dictionaries, locale: savedLocale, fallbackLocale: "en" });
const t = (k, p) => i18n.t(k, p);

// --- module singletons (constructed in init) --------------------------------
let store;
let view;
let interactions;
let logger;
let status;
let indicator;

// --- Feature Layer 1 data (bundled local JSON, no third-party network) ------
let knownData = {}; // chain-scoped known-address labels
let canonicalIndex = new Map(); // chain -> SYMBOL -> official token contracts (rebuilt from knownData)
let spam = parseSpamList([]); // per-chain spam contracts + global spam symbols
// The ONE flag ctx for every flagsForEdge call site (risk score, graph view,
// details, CSV) — chain-bound at call time via dataChain().
const isFakeTokenEdge = (edge) => isFakeToken(edge, dataChain(), canonicalIndex);
const flagCtx = { category: (a) => knownCategory(a, dataChain(), knownData), isFakeToken: isFakeTokenEdge };

// --- Feature Layer 2 state --------------------------------------------------
let hubMap = new Map(); // address -> 'sink' | 'faucet'
let hubOn = false;      // whether hub de-emphasis is active

const dateToEpoch = (v) => {
  if (!v) return 0;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
};
const epochToLocal = (secs) => {
  if (!secs) return "";
  const d = new Date(secs * 1000);
  if (Number.isNaN(d.getTime())) return "";
  // <input type="datetime-local"> is LOCAL wall-clock; shift off the tz offset so
  // save->load round-trips (dateToEpoch parses the input as local too).
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
function recomputeHubs() {
  hubMap = classifyHubs(store.listNodes(), store.listEdges());
}

// Re-apply the current hide-faucets/hide-sinks checkbox state to the view.
// Called from the checkbox handlers AND after anything that can introduce
// newly-classified hubs (scan completion, workspace load) so "Hide faucets"/
// "Hide sinks" never go stale — mirrors how the dim-only hubToggle
// self-corrects post-scan via `if (hubOn) view.refreshHubs()`.
function syncHubHidden() {
  view.setHubHidden({ faucet: $("hideFaucetsChk").checked, sink: $("hideSinksChk").checked });
}

// Per-node risk from the graph's own signals (cycle / hub / degree / calldata /
// known). Explainable — every reason surfaced in the details panel.
function computeRisk(address) {
  const inC = new Set();
  const outC = new Set();
  const outEdges = [];
  let hasCall = false;
  for (const e of store.listEdges()) {
    if (e.to === address) { inC.add(e.from); if (e.hasData) hasCall = true; }
    if (e.from === address) { outC.add(e.to); if (e.hasData) hasCall = true; outEdges.push(e); }
  }
  const cyc = findCycleNodes(store.listNodes(), store.listEdges());
  const chainId = dataChain();
  const categoryFor = (a) => knownCategory(a, chainId, knownData);
  // Risk flags from this node's own outgoing edges (unlimited approvals, mixer/bridge/sanctioned recipients).
  const flags = outEdges.flatMap((e) => flagsForEdge(e, flagCtx));
  return scoreNode({
    inDeg: inC.size,
    outDeg: outC.size,
    hubKind: hubMap.get(address) || null,
    onCycle: cyc.has(address),
    hasContractCalls: hasCall,
    known: !!knownLabel(address, chainId, knownData),
    approvalRisk: flags.includes("flag.approvalUnlimited"),
    sanctioned: categoryFor(address) === "sanctioned" || flags.includes("flag.sanctioned"),
  });
}
function applyDisplayOptions() {
  view.setDisplayOptions({
    minAmount: parseFloat($("minAmount").value) || 0,
    hideZero: $("hideZeroToggle").checked,
    hideSpam: $("hideSpamToggle").checked,
    minTime: dateToEpoch($("dateFrom").value),
    maxTime: dateToEpoch($("dateTo").value),
    spamContracts: spam.contractsFor(dataChain()),
    spamSymbols: spam.symbols,
    isFakeToken: isFakeTokenEdge,
  });
}

// --- scan lifecycle state ---------------------------------------------------
let scanning = false; // a scan OR a load is running (see withBusy) — never both
// Chain the current graph was built on (scan on an empty graph / workspace / demo);
// null after reset. Etherscan data from two chains must never mix in one graph.
let graphChainId = null;
/** Remember the current details selection so it can be re-rendered on locale change. */
let currentDetail = null; // { kind:'node'|'edge', id }

// ---------------------------------------------------------------------------
// Static shell wiring (config-driven)
// ---------------------------------------------------------------------------
function populateChains() {
  const sel = $("chainSelect");
  CHAINS.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = String(c.id);
    opt.textContent = `${c.name} (chainid ${c.id})`;
    sel.appendChild(opt);
  });
  sel.value = localStorage.getItem(STORAGE_KEYS.chainId) || "1";
  sel.addEventListener("change", () => {
    localStorage.setItem(STORAGE_KEYS.chainId, sel.value);
    if (view) view.refreshLabels(); // known-address labels are chain-scoped
    rerenderDetails(); // load button reflects the chain guard
  });
}

// Bundled local datasets: known-address labels + spam token list. Same-origin
// fetch (CSP connect-src 'self'); failures are non-fatal (app still runs).
async function loadLocalData() {
  knownData = await loadKnownAddresses();
  canonicalIndex = buildCanonicalIndex(knownData);
  if (view) view.refreshLabels(); // known labels never wait on the spam request
  try {
    const resp = await fetch(DATA_PATHS.spamTokens);
    if (resp.ok) spam = parseSpamList(await resp.json());
  } catch {
    /* spam list optional */
  }
  if (view) applyDisplayOptions(); // re-project: spam sets + edge flags (known data, canonical index)
}

function wirePersistedInputs() {
  const apiKey = $("apiKey");
  const rememberKey = $("rememberKey");
  // The key is a bearer credential. Persist to localStorage ONLY when the user
  // opts in ("Remember"); otherwise keep it in sessionStorage (cleared when the
  // tab closes). A key already saved from a previous session keeps the toggle on.
  const persisted = localStorage.getItem(STORAGE_KEYS.apiKey);
  apiKey.value = persisted ?? sessionStorage.getItem(STORAGE_KEYS.apiKey) ?? "";
  if (rememberKey) rememberKey.checked = persisted != null;

  const persistApiKey = () => {
    const val = apiKey.value.trim();
    if (rememberKey && rememberKey.checked) {
      localStorage.setItem(STORAGE_KEYS.apiKey, val);
      sessionStorage.removeItem(STORAGE_KEYS.apiKey);
    } else {
      sessionStorage.setItem(STORAGE_KEYS.apiKey, val);
      localStorage.removeItem(STORAGE_KEYS.apiKey);
    }
  };
  apiKey.addEventListener("change", persistApiKey);
  if (rememberKey) rememberKey.addEventListener("change", persistApiKey);

  const fmt = $("addressFormat");
  fmt.value = localStorage.getItem(STORAGE_KEYS.addressFormat) || DEFAULTS.addressFormat;
  fmt.addEventListener("change", () => {
    localStorage.setItem(STORAGE_KEYS.addressFormat, fmt.value);
    if (view) view.refreshLabels();
  });
}

// ---------------------------------------------------------------------------
// Locale — apply to shell + retranslate dynamic panels live
// ---------------------------------------------------------------------------
// Live chain detection on the address field: EVM -> scannable here; a non-EVM
// address (BTC/SOL/…) warns + links to the right explorer instead of a failed scan.
function renderAddressDetect() {
  const el = $("addressDetect");
  if (!el) return;
  el.replaceChildren();
  el.className = "detect";
  const res = detectAddress($("address").value);
  if (!res.input) return;
  if (res.isEvm) {
    el.classList.add("ok");
    el.textContent = t("detect.evm");
  } else if (res.primary) {
    el.classList.add("warn");
    el.textContent = t("detect.nonEvm", { chain: res.matches.map((m) => m.name).join(" / ") }) + " ";
    const a = document.createElement("a");
    a.href = res.primary.explorer + encodeURIComponent(res.input);
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = t("detect.viewExplorer");
    el.appendChild(a);
  } else {
    el.classList.add("warn");
    el.textContent = t("detect.unknown");
  }
}

// Sampling banner carries a {n} param, so applyTo (param-less) can't own it.
function showSamplingBanner(n) {
  const banner = $("samplingBanner");
  banner.hidden = false;
  banner.textContent = t("sampling.banner", { n });
}

function refreshDynamicI18n() {
  if (!$("samplingBanner").hidden) {
    showSamplingBanner(clampInt($("maxTxPerAddress").value, LIMITS.maxTxPerAddress, DEFAULTS.maxTxPerAddress));
  }
  if (indicator) indicator.setActive(scanning);
  renderAddressDetect();
  rerenderDetails();
}

function applyLocale() {
  i18n.applyTo(document);
  document.documentElement.setAttribute("lang", i18n.getLocale());
  refreshDynamicI18n();
  if (view) view.refreshProjection(); // edge labels/tooltips carry translated flag text
}

function wireLanguageToggle() {
  $("langToggle").addEventListener("click", () => {
    const next = i18n.getLocale() === "en" ? "fr" : "en";
    i18n.setLocale(next);
    localStorage.setItem(STORAGE_KEYS.locale, next);
  });
  i18n.subscribe(applyLocale);
}

// Collapse the controls so the graph gets the whole surface. The checkbox
// semantics flip by breakpoint (desktop: checked = hidden; mobile: unchecked =
// drawer closed), so pick the state that maximizes the map on each.
function collapseControls() {
  const chk = $("controlsChk");
  if (chk) chk.checked = window.matchMedia("(min-width: 861px)").matches;
}

// Remember which control accordions are open across reloads.
function wirePanels() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.panels) || "{}"); } catch { saved = {}; }
  const panels = document.querySelectorAll("details[data-panel]");
  panels.forEach((d) => {
    const key = d.getAttribute("data-panel");
    if (Object.prototype.hasOwnProperty.call(saved, key)) d.open = !!saved[key];
    d.addEventListener("toggle", () => {
      const state = {};
      panels.forEach((p) => { state[p.getAttribute("data-panel")] = p.open; });
      localStorage.setItem(STORAGE_KEYS.panels, JSON.stringify(state));
    });
  });
}

// ---------------------------------------------------------------------------
// Details panel
// ---------------------------------------------------------------------------
// Chain the details/workspace describe: the graph's, falling back to the selector.
const dataChain = () => graphChainId || $("chainSelect").value;

// Refusal for using `chainId` against the current graph, or null when allowed.
function chainRefusal(chainId) {
  return graphChainId && chainId !== graphChainId
    ? { key: "error.chainMismatch", params: { chain: chainName(graphChainId) } }
    : null;
}

function showNodeDetails(address) {
  const node = store.getNode(address);
  if (!node) return;
  currentDetail = { kind: "node", id: address };
  const types = formTypes();
  renderNodeDetails($("detailsContent"), node, {
    i18n,
    explorer: explorerFor(dataChain()),
    onRename: promptAlias,
    risk: computeRisk(address),
    getKnownSource: (a) => knownEntry(a, dataChain(), knownData)?.source || null,
    history: historyState(node, types.map((x) => x.action)).map((h, i) => ({ ...h, labelKey: types[i].labelKey })),
    pageSize: clampInt($("maxTxPerAddress").value, LIMITS.maxTxPerAddress, DEFAULTS.maxTxPerAddress),
    onLoadOlder: () => loadOlderFor(address),
    busy: scanning || detecting,
    loadBlocked: chainRefusal($("chainSelect").value),
  });
}

function showEdgeDetails(edgeKey) {
  const data = view.getEdgeData(edgeKey); // EdgeRecord, or a BundledEdge when bundling is on
  if (!data) return;
  currentDetail = { kind: "edge", id: edgeKey };
  const chainId = dataChain();
  const deps = {
    i18n,
    explorer: explorerFor(chainId),
    getAlias: (a) => store.getAlias(a),
    getKnownLabel: (a) => knownLabel(a, chainId, knownData),
    getCategory: (a) => knownCategory(a, chainId, knownData),
    isFakeToken: isFakeTokenEdge,
  };
  if (data.memberKeys) renderBundleDetails($("detailsContent"), data, deps);
  else renderEdgeDetails($("detailsContent"), data, deps);
}

function rerenderDetails() {
  if (!currentDetail) return;
  if (currentDetail.kind === "node") showNodeDetails(currentDetail.id);
  else showEdgeDetails(currentDetail.id);
}

function clearDetails() {
  currentDetail = null;
  const el = $("detailsContent");
  el.textContent = t("details.empty");
}

function promptAlias(address) {
  const current = store.getAlias(address) || "";
  const next = window.prompt(t("alias.prompt", { addr: address }), current);
  if (next === null) return; // cancelled
  store.setAlias(address, next.trim() || null); // store emits alias:set -> view refreshes
  if (currentDetail && currentDetail.kind === "node" && currentDetail.id === address) {
    showNodeDetails(address);
  }
}

// ---------------------------------------------------------------------------
// Command palette (Ctrl/Cmd+K) — search the graph, jump to a match
// ---------------------------------------------------------------------------
// Build the ranked-search record list on demand (called on every keystroke via
// palette.js) so it always reflects the CURRENT store + chain-scoped labels —
// no separate index to keep in sync.
function buildSearchRecords() {
  const chainId = dataChain();
  const records = [];
  for (const node of store.listNodes()) {
    const alias = store.getAlias(node.address);
    const known = knownLabel(node.address, chainId, knownData);
    const category = knownCategory(node.address, chainId, knownData);
    records.push({
      kind: "node",
      id: node.address,
      title: alias || known || shortAddress(node.address),
      subtitle: node.address,
      text: [alias, known, category].filter(Boolean).map((s) => s.toLowerCase()),
      hex: [node.address],
    });
  }
  for (const edge of store.listEdges()) {
    const method = methodName(edge.methodId);
    records.push({
      kind: "edge",
      id: edge.key,
      title: method || `${edge.symbol} tx`,
      subtitle: `${shortAddress(edge.from)} → ${shortAddress(edge.to)}`,
      text: [method].filter(Boolean).map((s) => s.toLowerCase()),
      hex: [edge.hash].filter(Boolean),
    });
  }
  return records;
}

// Best-effort auto-reveal for a palette jump-to: only clears the display
// projection — the store is untouched, so CSV/detail data stays complete (same
// invariant as the manual "Hide faucets/sinks" checkboxes). No-op if the node
// is already visible.
function revealNode(address) {
  if (view.hasRenderedNode(address)) return;

  // Only the toggle matching THIS node's own hub kind can be hiding it — clearing
  // the other one too would be a no-op for this reveal and surprise the user by
  // silently changing an unrelated filter.
  const kind = hubMap.get(address);
  if (kind === "faucet" && $("hideFaucetsChk").checked) {
    $("hideFaucetsChk").checked = false;
    syncHubHidden();
  } else if (kind === "sink" && $("hideSinksChk").checked) {
    $("hideSinksChk").checked = false;
    syncHubHidden();
  }

  if (!view.hasRenderedNode(address)) {
    $("minAmount").value = 0;
    $("hideZeroToggle").checked = false;
    $("hideSpamToggle").checked = false;
    $("dateFrom").value = "";
    $("dateTo").value = "";
    applyDisplayOptions();
  }

  logger.log({ level: "info", key: "palette.revealed", params: { addr: shortAddress(address) } });
}

// palette.js's onPick: reveal (if needed), select, focus/fit, open details.
function revealAndFocus(record) {
  if (record.kind === "node") {
    revealNode(record.id);
    view.focusNode(record.id);
    showNodeDetails(record.id);
    return;
  }
  const edge = store.listEdges().find((e) => e.key === record.id);
  if (!edge) return;
  revealNode(edge.from);
  revealNode(edge.to);
  view.fit({ nodes: [edge.from, edge.to], animation: { duration: 400, easingFunction: "easeInOutQuad" } });
  // selectEdge resolves record.id (a raw per-tx store key) to whatever id is
  // actually rendered — itself when unbundled, or the owning bundle when
  // bundling is on — and never throws, unlike a raw network.setSelection with a
  // possibly-stale/collapsed id. showEdgeDetails already branches on
  // memberKeys (see getEdgeData), so it's the same details path a normal click
  // takes for either kind of id.
  const rid = view.selectEdge(record.id);
  if (rid) {
    showEdgeDetails(rid);
  } else {
    logger.log({ level: "info", key: "palette.edgeNotShown" });
  }
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------
// Run `fn` as THE one network operation (scan or load): sets `scanning`, locks
// Start/address/detect, enables Stop, shows the request indicator. Stop aborts
// in-flight fetches AND drops the limiter queue. Callers check `scanning` first;
// that check plus this synchronous set is what keeps scans/loads from
// overlapping (loadOlder's counts are store-wide deltas, overlap would mis-credit).
async function withBusy(fn) {
  scanning = true;
  const abortController = new AbortController();
  const limiter = new RateLimiter(clampInt($("rps").value, LIMITS.rps, DEFAULTS.rps));
  const onStop = () => {
    abortController.abort();
    limiter.clear();
    logger.log({ level: "info", key: "log.stopRequested" });
  };
  $("startBtn").disabled = true;
  $("stopBtn").disabled = false;
  $("address").disabled = true;
  $("detectChainBtn").disabled = true;
  indicator.setActive(true);
  $("stopBtn").addEventListener("click", onStop, { once: true });
  rerenderDetails(); // load button -> disabled while busy
  try {
    return await fn({ signal: abortController.signal, limiter });
  } finally {
    scanning = false;
    indicator.setActive(false);
    $("startBtn").disabled = false;
    $("stopBtn").disabled = true;
    $("stopBtn").removeEventListener("click", onStop);
    $("address").disabled = false;
    $("detectChainBtn").disabled = false;
    rerenderDetails();
  }
}

// Post-processing once the graph has grown (end of a scan or a load).
function afterGraphChange() {
  view.refreshProjection(); // normalize edge widths + rebuild bundles now the graph is complete
  recomputeHubs();
  if (hubOn) view.refreshHubs();
  if ($("hideFaucetsChk").checked || $("hideSinksChk").checked) syncHubHidden();

  const inv = store.checkInvariants();
  // Dev signal only — never dump inv.errors (they embed addresses / tx hashes)
  // into the console where an extension or shoulder-surfer could read them.
  if (!inv.ok) console.warn(`graphStore invariant violation: ${inv.errors.length} issue(s)`);
}

async function startScan() {
  if (scanning) return;

  const apiKey = $("apiKey").value.trim();
  const address = $("address").value.trim();
  const chainId = $("chainSelect").value;
  const maxDepth = clampInt($("depth").value, LIMITS.depth, DEFAULTS.depth);
  const maxTxPerAddress = clampInt($("maxTxPerAddress").value, LIMITS.maxTxPerAddress, DEFAULTS.maxTxPerAddress);
  const safetyCap = clampInt($("safetyCap").value, LIMITS.safetyCap, DEFAULTS.safetyCap);
  const types = formTypes();

  if (!apiKey) return logger.log({ level: "error", key: "error.apiKeyRequired" });
  if (!isValidAddress(address)) return logger.log({ level: "error", key: "error.invalidAddress" });
  if (!types.length) return logger.log({ level: "error", key: "error.noTypeSelected" });
  // Roots on the same chain accumulate; another chain needs an empty graph.
  const refusal = store.stats().nodes > 0 && chainRefusal(chainId);
  if (refusal) return logger.log({ level: "error", ...refusal });
  graphChainId = chainId;
  applyDisplayOptions(); // per-chain spam contracts follow the graph chain

  // Native-value txs (no tokenSymbol) must show THIS chain's ticker, not a
  // hardcoded "ETH" — set before any edges are added so the whole scan is
  // consistent (a graph is single-chain per scan).
  store.setNativeSymbol(nativeSymbolFor(chainId));
  const client = createEtherscanClient({ apiKey, chainId });

  collapseControls(); // give the map the full surface once a scan begins

  showSamplingBanner(maxTxPerAddress);

  logger.log({
    level: "info",
    key: "log.scanStart",
    params: { root: address.toLowerCase(), depth: maxDepth, types: types.map((x) => t(x.labelKey)).join(", ") },
  });

  const summary = await withBusy(({ signal, limiter }) =>
    runScan({
      client,
      store,
      limiter,
      root: address,
      maxDepth,
      maxTxPerAddress,
      safetyCap,
      types,
      signal,
      onProgress: (p) =>
        status.set(
          t("status.analyzing", {
            addr: shortAddress(p.current),
            depth: p.depth,
            maxDepth: p.maxDepth,
            processed: p.processed,
            queued: p.queued,
            calls: p.apiCalls,
          })
        ),
      onLog: (e) => logger.log(e),
    })
  );

  if (!summary) return; // runScan only rejects on programmer error; guard the post-scan path anyway
  if (summary.capped) logger.log({ level: "error", key: "log.safetyCap", params: { cap: safetyCap } });
  logger.log({
    level: "info",
    key: "log.scanDone",
    params: { nodes: summary.nodes, edges: summary.edges, calls: summary.apiCalls },
  });
  status.set(
    summary.planRequired
      ? t("status.planRequired", { chain: chainName(chainId) })
      : t("status.done", { nodes: summary.nodes, edges: summary.edges })
  );

  afterGraphChange();
}

// Details-panel "Load older": fetch the next older page per selected type for
// one node, on the graph's chain. Counterparties are added, never expanded.
async function loadOlderFor(address) {
  // Busy (or probing chains): ignore, but re-render so the clicked button isn't left disabled.
  if (scanning || detecting) return rerenderDetails();
  const apiKey = $("apiKey").value.trim();
  const types = formTypes();
  const refusal = !apiKey
    ? { key: "error.apiKeyRequired" }
    : !types.length
      ? { key: "error.noTypeSelected" }
      : chainRefusal($("chainSelect").value);
  if (refusal) {
    logger.log({ level: "error", ...refusal });
    return rerenderDetails();
  }

  const maxTxPerAddress = clampInt($("maxTxPerAddress").value, LIMITS.maxTxPerAddress, DEFAULTS.maxTxPerAddress);
  store.setNativeSymbol(nativeSymbolFor(graphChainId));
  showSamplingBanner(maxTxPerAddress); // loaded rows are a sample too (demo/workspace graphs hide it)
  status.set(t("status.loadingOlder", { addr: shortAddress(address) }));

  const res = await withBusy(({ signal, limiter }) =>
    loadOlder({
      client: createEtherscanClient({ apiKey, chainId: graphChainId }),
      store,
      limiter,
      address,
      types,
      maxTxPerAddress,
      signal,
      onLog: (e) => logger.log(e),
    })
  );

  afterGraphChange();
  rerenderDetails();
  logger.log({
    level: "info",
    key: "log.loadOlderDone",
    params: { addr: address, edges: res.newEdges, nodes: res.newNodes, calls: res.apiCalls },
  });
  const done = { edges: res.newEdges, addr: shortAddress(address), errors: res.errors };
  const key = res.stopped ? "status.loadOlderStopped" : res.errors ? "status.loadOlderErrors" : "status.loadOlderDone";
  status.set(res.planRequired ? t("status.planRequired", { chain: chainName(graphChainId) }) : t(key, done));
}

function resetGraph() {
  if (scanning) return;
  graphChainId = null;
  store.reset(); // view clears via 'reset' event
  logger.clear();
  status.clear();
  clearDetails();
  $("samplingBanner").hidden = true;
}

// ---------------------------------------------------------------------------
// Detect chain — probe a curated set of chains for on-chain activity and
// auto-select the most active one. An EVM 0x… address is IDENTICAL across
// every EVM chain, so this is an activity probe, not string parsing (see
// blockchainDetect.js for the format-only EVM/non-EVM check). Honesty
// invariant: an address can be active on several chains — this surfaces all
// of them (ranked) and labels the auto-selected one "most active", never "the"
// chain.
// ---------------------------------------------------------------------------
let detecting = false;
let detectAbortController = null;

/**
 * Per-chain probe: does this address have ANY recent native tx or token
 * transfer on `chainId`? A fresh client is created per candidate because
 * createEtherscanClient binds apiKey+chainId at construction. No inner
 * .catch here on purpose — a hard failure (network/timeout/rate-limit/
 * invalid key) must propagate so probeChains' own try/catch can mark this
 * chain error:true, distinguishing "errored" from "genuinely inactive" (an
 * address with truly no txs resolves an empty array WITHOUT throwing).
 */
async function probeOneChain(chainId, address, signal) {
  const apiKey = $("apiKey").value.trim();
  const client = createEtherscanClient({ apiKey, chainId });
  const [native, token] = await Promise.all([
    client.fetchAction(address, "txlist", { offset: 1, page: 1, sort: "desc", signal }),
    client.fetchAction(address, "tokentx", { offset: 1, page: 1, sort: "desc", signal }),
  ]);
  return { hasNativeTx: native.length > 0, hasTokenTx: token.length > 0 };
}

function resetDetectChainBtn() {
  const btn = $("detectChainBtn");
  btn.disabled = false;
  btn.textContent = t("btn.detectChain");
  btn.setAttribute("data-i18n", "btn.detectChain");
}

async function startDetectChain() {
  // Clicking mid-probe cancels it (the button is in its Cancel state then).
  if (detecting) {
    if (detectAbortController) detectAbortController.abort();
    return;
  }
  if (scanning) return; // don't collide with an in-progress scan

  const address = $("address").value.trim();
  const el = $("addressDetect");
  if (!address) {
    logger.log({ level: "error", key: "detect.empty" });
    if (el) {
      el.className = "detect warn";
      el.textContent = t("detect.empty");
    }
    return;
  }
  const det = detectAddress(address);
  if (!det.isEvm) {
    logger.log({ level: "error", key: "detect.notEvm" });
    if (el) {
      el.className = "detect warn";
      el.textContent = t("detect.notEvm");
    }
    return;
  }

  // No-API shortcut: a known labeled address already tells us its chain(s) locally.
  const localHits = chainsForKnownAddress(address, knownData);
  // A "*"-only hit names no chain, so it falls through to the API probe.
  if (localHits.some((h) => h.chainId !== "*")) {
    const hit = localHits[0]; // first-listed chain-specific hit wins
    $("chainSelect").value = String(hit.chainId);
    $("chainSelect").dispatchEvent(new Event("change"));
    const chains = localHits.map((h) => (h.chainId === "*" ? t("details.allChains") : chainName(h.chainId))).join(", ");
    logger.log({ level: "info", key: "detect.localHit", params: { label: hit.label, chains } });
    if (el) {
      el.className = "detect ok";
      el.textContent = t("detect.localHit", { label: hit.label, chains });
    }
    return;
  }

  const apiKey = $("apiKey").value.trim();
  if (!apiKey) {
    logger.log({ level: "error", key: "error.apiKeyRequired" });
    return;
  }

  const candidates = PROBE_CHAIN_IDS.map((id) => {
    const c = CHAINS.find((x) => x.id === id);
    return { chainId: id, name: c ? c.name : String(id) };
  });

  const rps = clampInt($("rps").value, LIMITS.rps, DEFAULTS.rps);
  const limiter = new RateLimiter(rps);
  detectAbortController = new AbortController();
  detecting = true;
  rerenderDetails(); // load button -> disabled while probing

  const btn = $("detectChainBtn");
  btn.textContent = t("btn.cancelDetect");
  btn.setAttribute("data-i18n", "btn.cancelDetect");
  $("startBtn").disabled = true;
  $("address").disabled = true;
  indicator.setActive(true);

  try {
    const results = await probeChains(address, candidates, {
      probeOne: probeOneChain,
      limiter,
      signal: detectAbortController.signal,
      onProgress: (done, total) => {
        if (el) {
          el.className = "detect";
          el.textContent = t("detect.progress", { done, total });
        }
      },
    });

    if (detectAbortController.signal.aborted) {
      logger.log({ level: "info", key: "detect.cancelled" });
      if (el) {
        el.className = "detect warn";
        el.textContent = t("detect.cancelled");
      }
      return;
    }

    const { ranked, best } = rankChainActivity(results);
    if (best != null) {
      $("chainSelect").value = String(best);
      $("chainSelect").dispatchEvent(new Event("change"));
      const activeNames = ranked.filter((r) => r.active).map((r) => r.name);
      const bestCandidate = candidates.find((c) => c.chainId === best);
      const bestName = bestCandidate ? bestCandidate.name : String(best);
      const params = { chains: activeNames.join(", "), chain: bestName };
      logger.log({ level: "info", key: "detect.result", params });
      if (el) {
        el.className = "detect ok";
        el.textContent = t("detect.result", params);
      }
    } else {
      const params = { n: candidates.length };
      logger.log({ level: "info", key: "detect.none", params });
      if (el) {
        el.className = "detect warn";
        el.textContent = t("detect.none", params);
      }
    }
    // Chains skipped because the free key isn't allowed on them (not "inactive").
    const planNames = ranked.filter((r) => r.planRequired).map((r) => r.name);
    if (planNames.length) {
      const params = { chains: planNames.join(", ") };
      logger.log({ level: "info", key: "detect.planRequired", params });
      if (el) el.textContent += ` — ${t("detect.planRequired", params)}`;
    }
  } finally {
    detecting = false;
    detectAbortController = null;
    $("startBtn").disabled = false;
    $("address").disabled = false;
    // Restore the shared indicator to whatever the concurrent scan (if any)
    // needs; only turns fully idle when nothing else is running.
    indicator.setActive(scanning);
    resetDetectChainBtn();
    rerenderDetails();
  }
}

// ---------------------------------------------------------------------------
// Feature Layer 2 — workspace / demo / estimate / annotations / hubs
// ---------------------------------------------------------------------------
function currentFilters() {
  return {
    minAmount: parseFloat($("minAmount").value) || 0,
    hideZero: $("hideZeroToggle").checked,
    hideSpam: $("hideSpamToggle").checked,
    bundle: $("bundleToggle").checked,
    minTime: dateToEpoch($("dateFrom").value),
    maxTime: dateToEpoch($("dateTo").value),
  };
}

function saveWorkspace() {
  if (!store.stats().nodes) return logger.log({ level: "error", key: "log.exportEmpty" });
  const ws = serializeWorkspace({
    chainId: dataChain(), // the graph's chain, not whatever the selector shows now
    root: $("address").value.trim().toLowerCase() || null,
    nodes: store.listNodes(),
    edges: store.listEdges(),
    filters: currentFilters(),
    layout: $("layoutSelect").value,
    annotations: view.getAnnotations(),
  });
  const url = URL.createObjectURL(new Blob([JSON.stringify(ws, null, 2)], { type: "application/json" }));
  triggerDownload(url, "workspace.json");
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  logger.log({ level: "info", key: "log.workspaceSaved" });
}

// Returns false (and logs) when refused: a scan/load in flight would keep writing
// into the replaced graph — mixed chains, mis-credited counts. Checked here, at
// apply time, because demo/file loads resolve asynchronously after the click.
function applyWorkspace(ws) {
  if (scanning) {
    logger.log({ level: "error", key: "error.busy" });
    return false;
  }
  if (ws.chainId) $("chainSelect").value = String(ws.chainId);
  graphChainId = String(ws.chainId || $("chainSelect").value);
  store.loadSnapshot(ws.nodes, ws.edges);
  const f = ws.filters || {};
  $("minAmount").value = f.minAmount || 0;
  $("hideZeroToggle").checked = !!f.hideZero;
  $("hideSpamToggle").checked = !!f.hideSpam;
  $("bundleToggle").checked = !!f.bundle;
  $("dateFrom").value = epochToLocal(f.minTime);
  $("dateTo").value = epochToLocal(f.maxTime);
  if (ws.layout) {
    $("layoutSelect").value = ws.layout;
    view.setLayout(ws.layout);
  }
  view.setAnnotations(ws.annotations || []);
  recomputeHubs();
  if ($("hideFaucetsChk").checked || $("hideSinksChk").checked) syncHubHidden();
  if ($("peelChk").checked) view.setPeelChains(findPeelChains(store.listEdges(), {}));
  view.refreshLabels();
  view.setBundling(!!f.bundle);
  applyDisplayOptions();
  clearDetails();
  return true;
}

function loadWorkspaceFromText(text) {
  const res = parseWorkspace(text);
  if (!res.ok) return logger.log({ level: "error", key: "log.workspaceError", params: { error: res.error } });
  if (!applyWorkspace(res.data)) return;
  const s = store.stats();
  logger.log({ level: "info", key: "log.workspaceLoaded", params: { nodes: s.nodes, edges: s.edges } });
}

async function loadDemo() {
  try {
    const resp = await fetch(DATA_PATHS.demo);
    if (!resp.ok) throw new Error(String(resp.status));
    const res = parseWorkspace(await resp.json());
    if (!res.ok) throw new Error(res.error);
    if (applyWorkspace(res.data)) logger.log({ level: "info", key: "log.demoLoaded" });
  } catch (e) {
    logger.log({ level: "error", key: "log.workspaceError", params: { error: String(e.message || e) } });
  }
}

async function runEstimate() {
  const apiKey = $("apiKey").value.trim();
  const address = $("address").value.trim();
  const chainId = $("chainSelect").value;
  if (!apiKey) return logger.log({ level: "error", key: "error.apiKeyRequired" });
  if (!isValidAddress(address)) return logger.log({ level: "error", key: "error.invalidAddress" });
  const types = formTypes();
  if (!types.length) return logger.log({ level: "error", key: "error.noTypeSelected" });

  const maxDepth = clampInt($("depth").value, LIMITS.depth, DEFAULTS.depth);
  const maxTxPerAddress = clampInt($("maxTxPerAddress").value, LIMITS.maxTxPerAddress, DEFAULTS.maxTxPerAddress);
  const safetyCap = clampInt($("safetyCap").value, LIMITS.safetyCap, DEFAULTS.safetyCap);
  const rps = clampInt($("rps").value, LIMITS.rps, DEFAULTS.rps);
  const limiter = new RateLimiter(rps);
  const client = createEtherscanClient({ apiKey, chainId });
  const root = address.toLowerCase();

  indicator.setActive(true);
  let neighbors = 0;
  try {
    for (const ti of types) {
      const txs = await limiter.run(() => client.fetchAction(address, ti.action, { offset: maxTxPerAddress }));
      const set = new Set();
      for (const tx of txs) {
        if (isFailedTx(tx)) continue;
        const other = (tx.to || tx.contractAddress || "").toLowerCase();
        if (other && other !== root) set.add(other);
      }
      neighbors += set.size;
    }
  } catch (e) {
    indicator.setActive(false);
    return logger.log({ level: "error", key: "error.fetch", params: { address: root, action: "estimate", message: e.message || String(e) } });
  }
  indicator.setActive(false);

  const est = estimateScan({ firstHopNeighbors: neighbors, maxDepth, typesCount: types.length, rps, maxTxPerAddress, safetyCap });
  logger.log({ level: "info", key: "log.estimate", params: { addresses: est.addresses, calls: est.apiCalls, seconds: est.seconds } });
}

// ---------------------------------------------------------------------------
// Prune / rotate / high-degree / fit / export
// ---------------------------------------------------------------------------
function deleteSelectedNodes() {
  const selected = view.network.getSelectedNodes();
  if (!selected.length) return logger.log({ level: "error", key: "error.selectNodesFirst" });
  const { removedNodes } = store.removeNodes(selected);
  logger.log({ level: "info", key: "log.nodesDeleted", params: { n: removedNodes } });
  if (currentDetail && selected.includes(currentDetail.id)) clearDetails();
}

function wireControls() {
  $("startBtn").addEventListener("click", startScan);
  $("resetBtn").addEventListener("click", resetGraph);
  $("detectChainBtn").addEventListener("click", startDetectChain);
  $("deleteNodesBtn").addEventListener("click", deleteSelectedNodes);
  $("rotateLeftBtn").addEventListener("click", () => rotateGraph(view.network, -20));
  $("rotateRightBtn").addEventListener("click", () => rotateGraph(view.network, 20));
  $("fitViewBtn").addEventListener("click", () => view.fit());
  $("selectHighDegreeBtn").addEventListener("click", () => {
    const threshold = clampInt($("degreeThreshold").value, LIMITS.degreeThreshold, 15);
    const selected = selectHighDegree(view.network, threshold);
    logger.log({ level: "info", key: "log.selectHighDegree", params: { n: selected.length, threshold } });
  });

  const onLog = (e) => logger.log(e);
  const addressFormat = () => $("addressFormat").value;
  $("exportPngBtn").addEventListener("click", () =>
    exportPng(view, store, { preset: $("exportResolution").value, addressFormat: addressFormat(), annotations: view.getAnnotations(), onLog })
  );
  $("exportPdfBtn").addEventListener("click", () =>
    exportPdf(view, store, {
      preset: $("exportResolution").value,
      addressFormat: addressFormat(),
      jsPDF: window.jspdf.jsPDF,
      annotations: view.getAnnotations(),
      onLog,
    })
  );
  $("exportCsvBtn").addEventListener("click", () =>
    exportCsv(store, { onLog, ...flagCtx })
  );

  // Noise-reduction filters (live display projection; store is untouched).
  $("minAmount").addEventListener("input", applyDisplayOptions);
  $("hideZeroToggle").addEventListener("change", applyDisplayOptions);
  $("hideSpamToggle").addEventListener("change", applyDisplayOptions);
  $("bundleToggle").addEventListener("change", () => view.setBundling($("bundleToggle").checked));
  $("address").addEventListener("input", renderAddressDetect);
  // History row + load button follow the selected types and page size.
  // `input` (not `change`) for the page size: a blur-time rebuild would swallow the next Load click.
  for (const id of ["typeNormal", "typeInternal", "typeToken"]) $(id).addEventListener("change", rerenderDetails);
  $("maxTxPerAddress").addEventListener("input", rerenderDetails);

  // Layer 2 — date range, layout, hubs, annotations, workspace, estimate.
  $("dateFrom").addEventListener("change", applyDisplayOptions);
  $("dateTo").addEventListener("change", applyDisplayOptions);
  $("layoutSelect").addEventListener("change", () => view.setLayout($("layoutSelect").value));
  $("hubToggle").addEventListener("change", () => {
    hubOn = $("hubToggle").checked;
    if (hubOn) recomputeHubs();
    view.refreshHubs();
  });
  // Hide faucets/sinks: a reversible display projection (setHubHidden only
  // re-filters the node view — the store, and thus CSV/detail data, is
  // untouched). Independent of the dim-only hubToggle above.
  function applyHubHidden() {
    if ($("hideFaucetsChk").checked || $("hideSinksChk").checked) recomputeHubs();
    syncHubHidden();
  }
  $("hideFaucetsChk").addEventListener("change", applyHubHidden);
  $("hideSinksChk").addEventListener("change", applyHubHidden);
  $("roundTripToggle").addEventListener("change", () => view.setRoundTrip($("roundTripToggle").checked));
  $("ageToggle").addEventListener("change", () => view.setColorByAge($("ageToggle").checked));
  $("peelChk").addEventListener("change", () => {
    const on = $("peelChk").checked;
    const chains = on ? findPeelChains(store.listEdges(), {}) : [];
    view.setPeelChains(chains);
    logger.log({ level: "info", key: "log.peelChains", params: { n: chains.length } });
  });
  $("addNoteBtn").addEventListener("click", () => {
    const text = window.prompt(t("alias.notePrompt"), "");
    if (text && text.trim()) view.addAnnotation(text.trim());
  });
  $("clearNotesBtn").addEventListener("click", () => {
    view.clearAnnotations();
    logger.log({ level: "info", key: "log.notesCleared" });
  });
  $("estimateBtn").addEventListener("click", runEstimate);
  $("saveBtn").addEventListener("click", saveWorkspace);
  $("loadBtn").addEventListener("click", () => $("loadFile").click());
  $("loadFile").addEventListener("change", () => {
    const file = $("loadFile").files && $("loadFile").files[0];
    if (file) file.text().then(loadWorkspaceFromText);
    $("loadFile").value = "";
  });
  $("demoBtn").addEventListener("click", loadDemo);

  // Drag-and-drop a workspace .json onto the graph to load it.
  const graph = $("graph");
  graph.addEventListener("dragover", (e) => e.preventDefault());
  graph.addEventListener("drop", (e) => {
    e.preventDefault();
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) file.text().then(loadWorkspaceFromText);
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
function init() {
  populateChains();
  wirePersistedInputs();
  wireLanguageToggle();

  store = new GraphStore();
  view = createGraphView($("graph"), store, {
    i18n,
    getAddressFormat: () => $("addressFormat").value,
    getKnownLabel: (address) => knownLabel(address, dataChain(), knownData),
    // Returns the hub classification whenever ANY hub-driven feature is engaged
    // (the dim-only toggle OR either hide toggle) — not just when hubOn is on —
    // so "Hide faucets"/"Hide sinks" work independently of the dim toggle. The
    // DIM decision itself is separate — see getHubDimOn — so checking only
    // "Hide faucets" never greys out sinks too.
    getHubKind: (address) =>
      hubOn || $("hideFaucetsChk").checked || $("hideSinksChk").checked ? hubMap.get(address) || null : null,
    // Gates the grey "de-emphasized hub" node background in applyNode. ONLY the
    // dim-only hubToggle — independent of the hide checkboxes above — so
    // checking "Hide faucets" (hubToggle OFF) hides faucets without dimming
    // sinks (or anything else).
    getHubDimOn: () => hubOn,
    getCategory: (address) => knownCategory(address, dataChain(), knownData),
    getEdgeFlags: (edge) => flagsForEdge(edge, flagCtx),
  });
  logger = createLogger($("logContent"), i18n);
  status = createStatus($("status"));
  indicator = createRequestIndicator($("requestIndicator"), i18n);

  interactions = attachInteractions(view, store, {
    container: $("graph"),
    i18n,
    onNodeSelect: showNodeDetails,
    onEdgeSelect: showEdgeDetails,
    onAliasEdit: promptAlias,
    onLog: (e) => logger.log(e),
  });

  // Command palette also opens via Ctrl/Cmd+K; the appbar button is the visible,
  // touch-reachable entry point (mobile has no keyboard shortcut).
  const palette = createPalette({ i18n, getRecords: buildSearchRecords, onPick: revealAndFocus });
  $("searchBtn").addEventListener("click", () => palette.open());

  wireControls();
  wirePanels();
  applyLocale();
  clearDetails();
  loadLocalData(); // async; enriches labels + spam sets when ready
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
