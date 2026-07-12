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

import { CHAINS, DEFAULTS, STORAGE_KEYS, LIMITS, DATA_PATHS } from "./config.js";
import { createI18n } from "./i18n.js";
import en from "./locales/en.js";
import fr from "./locales/fr.js";
import { isValidAddress, isFailedTx, shortAddress } from "./format.js";
import { loadKnownAddresses, knownLabel, knownCategory } from "./knownAddresses.js";
import { serializeWorkspace, parseWorkspace } from "./workspace.js";
import { estimateScan } from "./dryRun.js";
import { classifyHubs } from "./sinkFaucet.js";
import { findCycleNodes } from "./roundTrips.js";
import { scoreNode } from "./riskScore.js";
import { flagsForEdge } from "./riskFlags.js";
import { detectAddress } from "./blockchainDetect.js";
import { GraphStore } from "./graphStore.js";
import { RateLimiter } from "./rateLimiter.js";
import { createEtherscanClient } from "./etherscanClient.js";
import { runScan, selectedTypes } from "./scanner.js";
import { createGraphView } from "./render/network.js";
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
const spamContracts = new Set();
const spamSymbols = new Set();

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
  const chainId = $("chainSelect").value;
  const categoryFor = (a) => knownCategory(a, chainId, knownData);
  // Risk flags from this node's own outgoing edges (unlimited approvals, mixer/bridge/sanctioned recipients).
  const flags = outEdges.flatMap((e) => flagsForEdge(e, { category: categoryFor }));
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
    spamContracts,
    spamSymbols,
  });
}

// --- scan lifecycle state ---------------------------------------------------
let scanning = false;
let abortController = null;
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
  });
}

// Bundled local datasets: known-address labels + spam token list. Same-origin
// fetch (CSP connect-src 'self'); failures are non-fatal (app still runs).
async function loadLocalData() {
  knownData = await loadKnownAddresses();
  if (view) view.refreshLabels();
  try {
    const resp = await fetch(DATA_PATHS.spamTokens);
    if (resp.ok) {
      const list = await resp.json();
      if (Array.isArray(list)) {
        for (const raw of list) {
          const s = String(raw).toLowerCase();
          if (s.startsWith("0x")) spamContracts.add(s);
          else spamSymbols.add(s);
        }
      }
    }
  } catch {
    /* spam list optional */
  }
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

function refreshDynamicI18n() {
  // Sampling banner carries a {n} param, so applyTo (param-less) can't own it.
  const banner = $("samplingBanner");
  if (!banner.hidden) {
    const n = clampInt($("maxTxPerAddress").value, LIMITS.maxTxPerAddress, DEFAULTS.maxTxPerAddress);
    banner.textContent = t("sampling.banner", { n });
  }
  if (indicator) indicator.setActive(scanning);
  renderAddressDetect();
  rerenderDetails();
}

function applyLocale() {
  i18n.applyTo(document);
  document.documentElement.setAttribute("lang", i18n.getLocale());
  refreshDynamicI18n();
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
function showNodeDetails(address) {
  const node = store.getNode(address);
  if (!node) return;
  currentDetail = { kind: "node", id: address };
  renderNodeDetails($("detailsContent"), node, {
    i18n,
    explorer: explorerFor($("chainSelect").value),
    onRename: promptAlias,
    risk: computeRisk(address),
  });
}

function showEdgeDetails(edgeKey) {
  const data = view.getEdgeData(edgeKey); // EdgeRecord, or a BundledEdge when bundling is on
  if (!data) return;
  currentDetail = { kind: "edge", id: edgeKey };
  const chainId = $("chainSelect").value;
  const deps = {
    i18n,
    explorer: explorerFor(chainId),
    getAlias: (a) => store.getAlias(a),
    getKnownLabel: (a) => knownLabel(a, chainId, knownData),
    getCategory: (a) => knownCategory(a, chainId, knownData),
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
// Scan
// ---------------------------------------------------------------------------
async function startScan() {
  if (scanning) return;

  const apiKey = $("apiKey").value.trim();
  const address = $("address").value.trim();
  const chainId = $("chainSelect").value;
  const maxDepth = clampInt($("depth").value, LIMITS.depth, DEFAULTS.depth);
  const maxTxPerAddress = clampInt($("maxTxPerAddress").value, LIMITS.maxTxPerAddress, DEFAULTS.maxTxPerAddress);
  const safetyCap = clampInt($("safetyCap").value, LIMITS.safetyCap, DEFAULTS.safetyCap);
  const rps = clampInt($("rps").value, LIMITS.rps, DEFAULTS.rps);
  const types = selectedTypes({
    normal: $("typeNormal").checked,
    internal: $("typeInternal").checked,
    token: $("typeToken").checked,
  });

  if (!apiKey) return logger.log({ level: "error", key: "error.apiKeyRequired" });
  if (!isValidAddress(address)) return logger.log({ level: "error", key: "error.invalidAddress" });
  if (!types.length) return logger.log({ level: "error", key: "error.noTypeSelected" });

  scanning = true;
  abortController = new AbortController();
  const limiter = new RateLimiter(rps);
  const client = createEtherscanClient({ apiKey, chainId });

  $("startBtn").disabled = true;
  $("stopBtn").disabled = false;
  $("address").disabled = true;
  collapseControls(); // give the map the full surface once a scan begins

  const banner = $("samplingBanner");
  banner.hidden = false;
  banner.textContent = t("sampling.banner", { n: maxTxPerAddress });
  indicator.setActive(true);

  logger.log({
    level: "info",
    key: "log.scanStart",
    params: { root: address.toLowerCase(), depth: maxDepth, types: types.map((x) => t(x.labelKey)).join(", ") },
  });

  // Stop aborts in-flight fetches AND drops the limiter queue.
  const onStop = () => {
    abortController.abort();
    limiter.clear();
    logger.log({ level: "info", key: "log.stopRequested" });
  };
  $("stopBtn").addEventListener("click", onStop, { once: true });

  let summary;
  try {
    summary = await runScan({
      client,
      store,
      limiter,
      root: address,
      maxDepth,
      maxTxPerAddress,
      safetyCap,
      types,
      signal: abortController.signal,
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
    });
  } finally {
    scanning = false;
    indicator.setActive(false);
    $("startBtn").disabled = false;
    $("stopBtn").disabled = true;
    $("stopBtn").removeEventListener("click", onStop);
    $("address").disabled = false;
  }

  if (!summary) return; // runScan only rejects on programmer error; guard the post-scan path anyway
  if (summary.capped) logger.log({ level: "error", key: "log.safetyCap", params: { cap: safetyCap } });
  logger.log({
    level: "info",
    key: "log.scanDone",
    params: { nodes: summary.nodes, edges: summary.edges, calls: summary.apiCalls },
  });
  status.set(t("status.done", { nodes: summary.nodes, edges: summary.edges }));

  view.refreshProjection(); // normalize edge widths + rebuild bundles now the graph is complete
  recomputeHubs();
  if (hubOn) view.refreshHubs();

  const inv = store.checkInvariants();
  // Dev signal only — never dump inv.errors (they embed addresses / tx hashes)
  // into the console where an extension or shoulder-surfer could read them.
  if (!inv.ok) console.warn(`graphStore invariant violation: ${inv.errors.length} issue(s)`);
}

function resetGraph() {
  if (scanning) return;
  store.reset(); // view clears via 'reset' event
  logger.clear();
  status.clear();
  clearDetails();
  $("samplingBanner").hidden = true;
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
    chainId: $("chainSelect").value,
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

function applyWorkspace(ws) {
  if (ws.chainId) $("chainSelect").value = String(ws.chainId);
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
  view.refreshLabels();
  view.setBundling(!!f.bundle);
  applyDisplayOptions();
  clearDetails();
}

function loadWorkspaceFromText(text) {
  const res = parseWorkspace(text);
  if (!res.ok) return logger.log({ level: "error", key: "log.workspaceError", params: { error: res.error } });
  applyWorkspace(res.data);
  const s = store.stats();
  logger.log({ level: "info", key: "log.workspaceLoaded", params: { nodes: s.nodes, edges: s.edges } });
}

async function loadDemo() {
  try {
    const resp = await fetch(DATA_PATHS.demo);
    if (!resp.ok) throw new Error(String(resp.status));
    const res = parseWorkspace(await resp.json());
    if (!res.ok) throw new Error(res.error);
    applyWorkspace(res.data);
    logger.log({ level: "info", key: "log.demoLoaded" });
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
  const types = selectedTypes({
    normal: $("typeNormal").checked,
    internal: $("typeInternal").checked,
    token: $("typeToken").checked,
  });
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
  $("exportCsvBtn").addEventListener("click", () => exportCsv(store, { onLog }));

  // Noise-reduction filters (live display projection; store is untouched).
  $("minAmount").addEventListener("input", applyDisplayOptions);
  $("hideZeroToggle").addEventListener("change", applyDisplayOptions);
  $("hideSpamToggle").addEventListener("change", applyDisplayOptions);
  $("bundleToggle").addEventListener("change", () => view.setBundling($("bundleToggle").checked));
  $("address").addEventListener("input", renderAddressDetect);

  // Layer 2 — date range, layout, hubs, annotations, workspace, estimate.
  $("dateFrom").addEventListener("change", applyDisplayOptions);
  $("dateTo").addEventListener("change", applyDisplayOptions);
  $("layoutSelect").addEventListener("change", () => view.setLayout($("layoutSelect").value));
  $("hubToggle").addEventListener("change", () => {
    hubOn = $("hubToggle").checked;
    if (hubOn) recomputeHubs();
    view.refreshHubs();
  });
  $("roundTripToggle").addEventListener("change", () => view.setRoundTrip($("roundTripToggle").checked));
  $("ageToggle").addEventListener("change", () => view.setColorByAge($("ageToggle").checked));
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
    getKnownLabel: (address) => knownLabel(address, $("chainSelect").value, knownData),
    getHubKind: (address) => (hubOn ? hubMap.get(address) || null : null),
    getCategory: (address) => knownCategory(address, $("chainSelect").value, knownData),
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
