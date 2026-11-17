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

import { CHAINS, DEFAULTS, STORAGE_KEYS, LIMITS, DATA_PATHS, PROBE_CHAIN_IDS, APP_VERSION, PRICE_FETCH, TX_TYPE_GROUPS, chainInfo, TRON_FETCH } from "./config.js";
import { createI18n } from "./i18n.js";
import en from "./locales/en.js";
import fr from "./locales/fr.js";
import { isValidAddress, isFailedTx, shortAddress, displayAddress, nodeId, explorerUrl } from "./format.js";
import { TRON_CHAIN_ID, parseTronAddress, tronTypes, sampleSize } from "./tron.js";
import { createTronClient } from "./tronClient.js";
import { loadKnownAddresses, knownEntry, knownLabel, knownCategory, chainsForKnownAddress, isAllChainEntry } from "./knownAddresses.js";
import { serializeWorkspace, parseWorkspace } from "./workspace.js";
import { estimateScan } from "./dryRun.js";
import { addressEvidence, sameAddressLinks } from "./chainTwins.js";
import { classifyHubs } from "./sinkFaucet.js";
import { findCycleNodes } from "./roundTrips.js";
import { findPeelChains } from "./peelChain.js";
import { scoreNode } from "./riskScore.js";
import { flagsForEdge } from "./riskFlags.js";
import { buildCanonicalIndex, isFakeToken } from "./fakeToken.js";
import { parseSpamList, isSpam } from "./display.js";
import { findDeposits } from "./depositDetect.js";
import { inferBridges } from "./bridgeInfer.js";
import { detectAddress } from "./blockchainDetect.js";
import { rankChainActivity, probeChains } from "./chainProbe.js";
import { methodName } from "./selectors.js";
import { priceKeyFor, usdForEdge, usdCounts, createPriceService } from "./usdPrice.js";
import { GraphStore } from "./graphStore.js";
import { RateLimiter } from "./rateLimiter.js";
import { createEtherscanClient } from "./etherscanClient.js";
import { createQueryLog } from "./queryLog.js";
import { CAVEATS, retrievalSummary, observedSampling, providersSummary, knownDataSnapshot, queryLogDocument, footerLines, fileStamp } from "./evidence.js";
import { runScan, loadOlder, selectedTypes } from "./scanner.js";
import { historyState } from "./history.js";
import { createGraphView } from "./render/network.js";
import { createPalette } from "./render/palette.js";
import { attachInteractions, rotateGraph, selectHighDegree } from "./render/interaction.js";
import { exportPng, exportPdf, exportCsv, exportEvidenceBundle, triggerDownload } from "./render/export.js";
import {
  renderNodeDetails,
  renderEdgeDetails,
  renderBundleDetails,
  createLogger,
  renderChainFilter,
  renderTwinDetails,
  renderBridgeDetails,
  createStatus,
  createRequestIndicator,
  renderQueryLog,
} from "./ui.js";

const $ = (id) => document.getElementById(id);
const clampInt = (raw, { min, max }, fallback) => {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};
// EVM + Tron (ruling 17). EVM-only lists (Look, Load-on-chain, probe, twins evidence) use CHAINS.
const chainById = chainInfo;
const isTron = (id) => String(id) === TRON_CHAIN_ID;
// Explorer host for a record's chain; an unknown chain gets no link (no fallback host).
const explorerFor = (id) => chainById(id)?.explorer || null;
const chainLabel = (id) => chainById(id)?.name || t("chain.unknown", { id });
// Chain tag on labels: only once the graph spans 2+ chains; an unknown chain is always tagged.
const getChainTag = (id) => (chainById(id) ? (store.chains().length >= 2 ? chainLabel(id) : null) : chainLabel(id));
// Chains hidden by the Filters card (display projection only; the store keeps them).
let hiddenChains = new Set();
function refreshChainFilter() {
  const cs = store.chains();
  $("chainFilter").hidden = cs.length < 2;
  renderChainFilter($("chainFilterList"), {
    chains: cs.map((chainId) => ({ chainId, name: chainLabel(chainId) })),
    hidden: hiddenChains,
    onToggle: (chainId, visible) => {
      if (visible) hiddenChains.delete(chainId);
      else hiddenChains.add(chainId);
      applyDisplayOptions();
    },
  });
}
function syncChainUi() {
  const cs = store.chains();
  hiddenChains = cs.length < 2 ? new Set() : new Set([...hiddenChains].filter((c) => cs.includes(c)));
  $("legendChainTag").hidden = cs.length < 2;
  $("twinToggleRow").hidden = cs.length < 2;
  $("legendTwinKey").hidden = cs.length < 2 || !$("twinToggle").checked;
  $("bridgeToggleRow").hidden = cs.length < 2;
  refreshChainFilter();
  applyDisplayOptions(); // also refreshes the projection
}
// Tx types ticked in the scan form (what a scan or a load fetches).
const formTypes = () =>
  selectedTypes({
    normal: $("typeNormal").checked,
    internal: $("typeInternal").checked,
    token: $("typeToken").checked,
  });
// The types a load on `chainId` fetches: TronGrid serves txlist, internal and TRC-20 only.
const typesFor = (chainId, types = formTypes()) => (isTron(chainId) ? tronTypes(types) : types);

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
// details, CSV) — every lookup uses the edge's own chain.
const isFakeTokenEdge = (e) => isFakeToken(e, e.chainId, canonicalIndex);
const isSpamEdge = (e) => isSpam(e, { spamContractsFor: spam.contractsFor, spamSymbols: spam.symbols });
const flagCtx = { category: (a, chainId) => knownCategory(a, chainId, knownData), isFakeToken: isFakeTokenEdge };

// --- Feature Layer 2 state --------------------------------------------------
let hubMap = new Map(); // node id -> 'sink' | 'faucet'
let hubOn = false;      // whether hub de-emphasis is active

// Exchange deposit heuristic: a derived display projection, never stored, never in workspaces.
let depositMap = new Map(); // node id -> DepositEvidence
const depositCtx = {
  known: (a, chainId) => knownEntry(a, chainId, knownData),
  // Imitation / spam-listed fake Transfer(from=N) events are dropped (unknown spoofed tokens can still dilute).
  ignoreEdge: (e) => isFakeTokenEdge(e) || isSpamEdge(e),
  // A forged token Transfer cannot create a mark alone: only native coin or a known token vouches.
  trustedToken: (contract, chainId) => knownCategory(contract, chainId, knownData) === "token",
};
// Re-applies only nodes whose evidence changed; re-renders an open details panel on one of them.
function recomputeDeposits() {
  const prev = depositMap;
  depositMap = findDeposits(store.listNodes(), store.listEdges(), depositCtx);
  const changed = [...new Set([...prev.keys(), ...depositMap.keys()])]
    .filter((id) => JSON.stringify(prev.get(id)) !== JSON.stringify(depositMap.get(id)));
  if (!changed.length) return;
  view.refreshNodes(changed);
  if (currentDetail?.kind === "node" && changed.includes(currentDetail.id)) rerenderDetails();
}

// Deposit marks and bridge inference follow store changes, coalesced to one macrotask. A details
// re-render flushes a pending recompute first, so a panel never shows a pre-change level.
let derivedQueued = false;
function flushDerived() {
  if (!derivedQueued) return;
  derivedQueued = false;
  recomputeDeposits();
  recomputeBridges();
}

// Inferred bridge links: derived like depositMap (never stored, never fed back into the store).
// Investigator decisions are session state; they never reach inferBridges (ruling 2).
let bridgeState = { deposits: new Map(), candidates: [] };
let bridgeDecisions = new Map(); // candidate id -> { deposit, release, decision, at }
const bridgeCtx = { ...depositCtx, nativeSymbol: (c) => chainById(c)?.native || null };
// Look loads the full value set whatever the form boxes say (ruling 1).
const VALUE_TYPES = [TX_TYPE_GROUPS.normal[0], TX_TYPE_GROUPS.internal[0], TX_TYPE_GROUPS.token[0]];
const bridgeSig = () => JSON.stringify([[...bridgeState.deposits.values()], bridgeState.candidates]);
// A decision shows only on the exact pair it was made on (its two edge keys; the id is never parsed).
const decisionOf = (c) => {
  const d = bridgeDecisions.get(c.id);
  return d && d.deposit === c.depositKey && d.release === c.releaseKey ? d : null;
};
function recomputeBridges() {
  const prev = bridgeSig();
  bridgeState = inferBridges(store.listNodes(), store.listEdges(), bridgeCtx);
  syncBridgeLinks();
  if (bridgeSig() !== prev && (currentDetail?.kind === "bridge" || currentDetail?.kind === "edge")) rerenderDetails();
}
// The view draws exactly what it is given: rejected candidates are left out here. Compared with
// the view's own list (a reset empties it, a node:remove sweep leaves it stale): an unchanged list
// is not resent, since setBridgeLinks rebuilds bundles (never mid-scan for nothing).
function syncBridgeLinks() {
  const links = [];
  if ($("bridgeToggle").checked) {
    for (const c of bridgeState.candidates) {
      const decision = decisionOf(c)?.decision ?? null;
      if (decision !== "rejected") links.push({ id: c.id, a: c.a, b: c.b, level: c.level, decision });
    }
  }
  if (JSON.stringify(links) !== JSON.stringify(view.getBridgeLinks())) view.setBridgeLinks(links);
  $("legendBridgeInferred").hidden = !links.some((l) => l.decision !== "confirmed");
  $("legendBridgeConfirmed").hidden = !links.some((l) => l.decision === "confirmed");
}
// Decisions that still point at two edges of the graph: all a saved workspace may carry.
const savedDecisions = () =>
  [...bridgeDecisions.values()]
    .filter((d) => store.hasEdgeKey(d.deposit) && store.hasEdgeKey(d.release))
    .map(({ deposit, release, decision, at }) => ({ deposit, release, decision, at }));
// Spec ruling 9: rejected candidates still count in `candidates` and their level.
function bridgeCounts() {
  const n = { candidates: 0, low: 0, medium: 0, high: 0, confirmedByInvestigator: 0, rejectedByInvestigator: 0 };
  for (const c of bridgeState.candidates) {
    n.candidates++;
    n[c.level]++;
    const d = decisionOf(c)?.decision;
    if (d === "confirmed") n.confirmedByInvestigator++;
    else if (d === "rejected") n.rejectedByInvestigator++;
  }
  return n;
}
function decideBridge(id, decision) {
  const c = bridgeState.candidates.find((x) => x.id === id);
  if (!c) return rerenderDetails();
  if (decision) bridgeDecisions.set(id, { deposit: c.depositKey, release: c.releaseKey, decision, at: new Date().toISOString() });
  else bridgeDecisions.delete(id);
  syncBridgeLinks();
  rerenderDetails();
}
// Also opens rejected candidates (from the deposit row's Open); a vanished one clears the panel.
function showBridgeDetails(id) {
  const c = bridgeState.candidates.find((x) => x.id === id);
  const edgeOf = (key) => store.listEdges().find((e) => e.key === key);
  const dep = c && bridgeState.deposits.get(c.depositKey);
  const D = dep && edgeOf(c.depositKey);
  const R = D && edgeOf(c.releaseKey);
  if (!R) return clearDetails();
  currentDetail = { kind: "bridge", id };
  const side = (e) => ({ amountText: e.amountText, symbol: e.symbol, chainName: chainLabel(e.chainId), explorer: explorerFor(e.chainId), hash: e.hash });
  renderBridgeDetails($("detailsContent"), {
    ...c,
    rejected: bridgeState.candidates.filter((x) => x.depositKey === c.depositKey && decisionOf(x)?.decision === "rejected").length,
    deposit: { ...side(D), bridgeLabel: dep.bridgeLabel },
    release: { ...side(R), recipient: R.to },
    decision: decisionOf(c),
  }, {
    i18n,
    busy: scanning || detecting,
    onConfirm: () => decideBridge(id, "confirmed"),
    onReject: () => decideBridge(id, "rejected"),
    onClear: () => decideBridge(id, null),
    onLoadOlder: () => lookForRelease(c.depositKey, R.chainId),
  });
}
// The "Bridge deposit" row of a deposit edge's details.
function bridgeDepositView(dep) {
  // Look chains: the decoded destination first, then probe order, then table order (stable sort).
  const rank = (c) => (String(c.id) === dep.destChainId ? -1 : probePriority(c.id));
  return {
    bridgeLabel: dep.bridgeLabel,
    recipient: dep.recipient,
    basis: dep.basis,
    destChainName: dep.destChainId ? chainLabel(dep.destChainId) : null,
    depositorCategory: depositCtx.known(dep.from, dep.chainId)?.category ?? null,
    candidates: bridgeState.candidates.filter((c) => c.depositKey === dep.key).map((c) => ({
      id: c.id, level: c.level, chainName: chainLabel(store.getNode(c.b)?.chainId), status: decisionOf(c)?.decision || "unreviewed",
    })),
    lookChains: CHAINS.filter((c) => String(c.id) !== dep.chainId).sort((x, y) => rank(x) - rank(y))
      .map((c) => ({ chainId: String(c.id), name: c.name })),
    busy: scanning || detecting,
    onOpen: showBridgeDetails,
    onLook: (chainId) => lookForRelease(dep.key, chainId),
  };
}
// Look (and an uncovered candidate's Load older): the deposit's recipient on `chainId`, full value
// set, one click = one load. An existing node gets its next older page; else it is added and loaded.
function lookForRelease(depositKey, chainId) {
  const dep = bridgeState.deposits.get(depositKey);
  const depositor = dep && store.getNode(dep.fromId);
  if (!dep?.recipient || !depositor) return rerenderDetails();
  const id = nodeId(chainId, dep.recipient);
  if (store.hasNode(id)) return loadOlderFor(id, VALUE_TYPES);
  return loadNewNode(chainId, dep.recipient, { depth: depositor.depth + 1, isRoot: false }, VALUE_TYPES);
}

// Query log (evidence exports): every Etherscan request any feature makes, keyed-out.
// Reset clears it, a workspace load replaces it, the demo empties it; deleting nodes keeps it.
const queryLog = createQueryLog();
// The client's epoch is read at creation (one client per operation): a request still in
// flight after a reset / workspace load / demo load is dropped, never logged in the new log.
const makeClient = (apiKey, chainId) => {
  const epoch = queryLog.epoch;
  return createEtherscanClient({ apiKey, chainId, onQuery: (r) => queryLog.add(r, epoch).then(refreshQueryLogUi) });
};
// Same epoch rule. The TronGrid key goes to the client only (header), never to a log line.
const makeTronClient = (rps) => {
  const epoch = queryLog.epoch;
  return createTronClient({
    apiKey: $("tronKey").value.trim() || undefined,
    minIntervalMs: 1000 / rps,
    onQuery: (r) => queryLog.add(r, epoch).then(refreshQueryLogUi),
  });
};
const clientFor = (chainId, rps) => (isTron(chainId) ? makeTronClient(rps) : makeClient($("apiKey").value.trim(), chainId));
const formRps = () => clampInt($("rps").value, LIMITS.rps, DEFAULTS.rps);
// Ruling 10: TronGrid gets 2 rps keyless, the form rate capped at 10 with a key.
const rpsFor = (chainId) =>
  !isTron(chainId) ? formRps() : $("tronKey").value.trim() ? Math.min(formRps(), TRON_FETCH.keyedMaxRps) : TRON_FETCH.keylessRps;
const hostFor = (chainId) => (isTron(chainId) ? "api.trongrid.io" : "api.etherscan.io");
// Title on every change; the table only while the panel is open.
function refreshQueryLogUi() {
  const entries = queryLog.entries();
  $("queryLogTitle").textContent = t("queryLog.title", { n: entries.length });
  if ($("queryLogPanel").open) {
    renderQueryLog($("queryLogContent"), entries, { i18n, dropped: queryLog.dropped, unloggedData: queryLog.unloggedData, limit: LIMITS.queryLog });
  }
}

// USD estimates (opt-in #usdToggle: off at load, never persisted). One price service per query-log
// epoch, on its own limiter (never the scan's): a price is shown only after its request was logged in
// that epoch, and an epoch change (reset / workspace / demo) drops the cache.
let usdDataOk = null; // R4: true once known-address + spam data loaded OK, false = fail closed for the session
let usdDoneDue = false; // a want() queued pairs: log.usdDone once the queue drains
let usdRefreshQueued = false;
let usdNoDataLogged = false;
const usdActive = () => $("usdToggle").checked && usdDataOk === true;
// R5: an address that is a root on ANY chain is never sent.
const rootAddrs = () => new Set(store.listNodes().filter((n) => n.isRoot).map((n) => n.address));
function usdCtx() {
  const roots = rootAddrs();
  return { isFakeToken: isFakeTokenEdge, isSpam: isSpamEdge, isRoot: (_chainId, a) => roots.has(a) };
}
// Re-checked by the service just before each request (a contract that became a root since is dropped).
const usdAllowed = (coin) => coin.startsWith("coingecko:") || !rootAddrs().has(coin.slice(coin.indexOf(":") + 1));
// The one valuation for details, CSV and MANIFEST; undefined while USD is not shown.
// Every consumer calls it synchronously (details render, CSV / bundle click), so it reads one epoch's cache.
function usdFn() {
  if (!usdActive()) return undefined;
  const ctx = usdCtx();
  return (e) => usdForEdge(e, ctx, (c, ts) => prices.get(c, ts));
}
function makePrices() {
  const epoch = queryLog.epoch;
  const svc = createPriceService({
    onQuery: (r) => queryLog.add(r, epoch).then(refreshQueryLogUi),
    limiter: new RateLimiter(PRICE_FETCH.rps),
    allowed: usdAllowed,
  });
  svc.onChange(queueUsdRefresh);
  return svc;
}
let prices = makePrices();
// onChange may fire synchronously inside want(): coalesced to one macrotask, by which time
// usdDoneDue is already set (R8).
function queueUsdRefresh() {
  if (usdRefreshQueued) return;
  usdRefreshQueued = true;
  setTimeout(() => {
    usdRefreshQueued = false;
    if (currentDetail?.kind === "edge") rerenderDetails();
    const s = prices.stats();
    if (!usdDoneDue || s.pending) return;
    usdDoneDue = false;
    logger.log({ level: s.error > 0 ? "error" : "info", key: "log.usdDone", params: { priced: s.ok, unknown: s.none, failed: s.error } });
  }, 0);
}
function wantAll() {
  if (!usdActive()) return;
  const ctx = usdCtx();
  const keys = store.listEdges().map((e) => priceKeyFor(e, ctx)).filter((k) => !("skip" in k));
  if (prices.want(keys) > 0) usdDoneDue = true;
}
// Called right after the query log's epoch changed.
function newPriceEpoch() {
  prices.clear();
  prices = makePrices();
  usdDoneDue = false;
  wantAll();
}
function onUsdToggle() {
  const on = $("usdToggle").checked;
  if (on && usdDataOk === false && !usdNoDataLogged) {
    usdNoDataLogged = true;
    logger.log({ level: "error", key: "log.usdNoData" });
  }
  if (on) wantAll();
  else {
    prices.cancel(); // does not notify: disarm the drain log here
    usdDoneDue = false;
  }
  rerenderDetails();
}

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
function computeRisk(id) {
  const { address, chainId } = store.getNode(id);
  const inC = new Set();
  const outC = new Set();
  const outEdges = [];
  let hasCall = false;
  for (const e of store.listEdges()) {
    if (e.toId === id) { inC.add(e.fromId); if (e.hasData) hasCall = true; }
    if (e.fromId === id) { outC.add(e.toId); if (e.hasData) hasCall = true; outEdges.push(e); }
  }
  const cyc = findCycleNodes(store.listNodes(), store.listEdges());
  // Risk flags from this node's own outgoing edges (unlimited approvals, mixer/bridge/sanctioned recipients).
  const flags = outEdges.flatMap((e) => flagsForEdge(e, flagCtx));
  return scoreNode({
    inDeg: inC.size,
    outDeg: outC.size,
    hubKind: hubMap.get(id) || null,
    deposit: depositMap.has(id),
    onCycle: cyc.has(id),
    hasContractCalls: hasCall,
    known: !!knownLabel(address, chainId, knownData),
    approvalRisk: flags.includes("flag.approvalUnlimited"),
    sanctioned: knownCategory(address, chainId, knownData) === "sanctioned" || flags.includes("flag.sanctioned"),
  });
}
function applyDisplayOptions() {
  view.setDisplayOptions({
    minAmount: parseFloat($("minAmount").value) || 0,
    hideZero: $("hideZeroToggle").checked,
    hideSpam: $("hideSpamToggle").checked,
    minTime: dateToEpoch($("dateFrom").value),
    maxTime: dateToEpoch($("dateTo").value),
    hiddenChains,
    spamContractsFor: spam.contractsFor,
    spamSymbols: spam.symbols,
    isFakeToken: isFakeTokenEdge,
  });
  dropStaleTwinDetail();
}
// A twin link is derived: once it is gone (prune, toggle, refresh) its details panel is stale.
function dropStaleTwinDetail() {
  if (currentDetail?.kind === "edge" && String(currentDetail.id).startsWith("twin:") && !view.getEdgeData(currentDetail.id)) clearDetails();
}

// --- scan lifecycle state ---------------------------------------------------
let scanning = false; // a scan OR a load is running (see withBusy) — never both
/** Remember the current details selection so it can be re-rendered on locale change. */
let currentDetail = null; // { kind:'node'|'edge'|'bridge', id }

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
  // Tron is an explicit per-session choice (ruling 16): never persisted, never restored.
  const tron = document.createElement("option");
  tron.value = TRON_CHAIN_ID;
  tron.setAttribute("data-i18n", "chain.tronOption");
  tron.textContent = t("chain.tronOption");
  sel.appendChild(tron);
  const stored = localStorage.getItem(STORAGE_KEYS.chainId) || "1";
  sel.value = CHAINS.some((c) => String(c.id) === stored) ? stored : "1";
  if (sel.value !== stored) localStorage.setItem(STORAGE_KEYS.chainId, "1"); // stale or Tron: written back only when stale
  // The selector is only the chain for the next scan: nodes keep their own chain.
  sel.addEventListener("change", () => {
    if (sel.value !== TRON_CHAIN_ID) localStorage.setItem(STORAGE_KEYS.chainId, sel.value);
    syncTronBox();
  });
  syncTronBox();
}

// The TronGrid notice + key field show only while Tron is the selected chain.
function syncTronBox() {
  $("tronBox").hidden = $("chainSelect").value !== TRON_CHAIN_ID;
}

// Bundled local datasets: known-address labels + spam token list. Same-origin
// fetch (CSP connect-src 'self'); failures are non-fatal (app still runs), but USD
// values need both (imitation/spam exclusion): resolves true only when both loaded OK.
async function loadLocalData() {
  knownData = await loadKnownAddresses();
  canonicalIndex = buildCanonicalIndex(knownData);
  if (view) view.refreshLabels(); // known labels never wait on the spam request
  let spamOk = false;
  try {
    const resp = await fetch(DATA_PATHS.spamTokens);
    if (resp.ok) {
      spam = parseSpamList(await resp.json());
      spamOk = true;
    }
  } catch {
    /* spam list optional for the graph; USD stays off without it */
  }
  if (view) recomputeDeposits(); // known + spam data feed the heuristic
  if (view) recomputeBridges(); // no bridge is known before this, so nothing was inferred
  if (view) applyDisplayOptions(); // re-project: spam sets + edge flags (known data, canonical index)
  return Object.keys(knownData).length > 0 && spamOk;
}

function wirePersistedInputs() {
  const rememberKey = $("rememberKey");
  // Keys are bearer credentials. Persist to localStorage ONLY when the user
  // opts in ("Remember"); otherwise keep them in sessionStorage (cleared when the
  // tab closes). A key already saved from a previous session keeps the toggle on.
  const keys = [[$("apiKey"), STORAGE_KEYS.apiKey], [$("tronKey"), STORAGE_KEYS.tronKey]];
  for (const [input, name] of keys) input.value = localStorage.getItem(name) ?? sessionStorage.getItem(name) ?? "";
  if (rememberKey) rememberKey.checked = keys.some(([, name]) => localStorage.getItem(name) != null);

  for (const [input, name] of keys) {
    const persist = () => {
      const val = input.value.trim();
      if (rememberKey && rememberKey.checked) {
        localStorage.setItem(name, val);
        sessionStorage.removeItem(name);
      } else {
        sessionStorage.setItem(name, val);
        localStorage.removeItem(name);
      }
    };
    input.addEventListener("change", persist);
    if (rememberKey) rememberKey.addEventListener("change", persist);
  }

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
  const tron = res.isEvm ? null : parseTronAddress(res.input);
  if (res.isEvm) {
    el.classList.add("ok");
    el.textContent = t("detect.evm");
  } else if (tron) { // hint only: never touches the selector, sends no request
    el.classList.add("warn");
    el.textContent = t("detect.tron") + " ";
    const a = document.createElement("a");
    a.href = explorerUrl(TRON_CHAIN_ID, "address", tron);
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = t("detect.viewExplorer");
    el.appendChild(a);
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
let samplingN = DEFAULTS.maxTxPerAddress; // the N last shown (TronGrid may cap the form's)
function showSamplingBanner(n) {
  samplingN = n;
  const banner = $("samplingBanner");
  banner.hidden = false;
  banner.textContent = t("sampling.banner", { n });
}

function refreshDynamicI18n() {
  if (!$("samplingBanner").hidden) {
    showSamplingBanner(samplingN);
  }
  if (indicator) indicator.setActive(scanning);
  renderAddressDetect();
  rerenderDetails();
  refreshQueryLogUi();
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
// A chain this build has no entry for (e.g. from a newer workspace): no scan, no load.
const unsupportedChain = (chainId) => (chainById(chainId) ? null : { key: "error.unknownChain", params: { id: chainId } });

// Why a scan or load on `chainId` can't run now ({key, params?}), or null.
function loadRefusal(chainId, types = formTypes()) {
  if (!isTron(chainId) && !$("apiKey").value.trim()) return { key: "error.apiKeyRequired" };
  if (!types.length) return { key: "error.noTypeSelected" };
  return unsupportedChain(chainId);
}

// Log "Added {chain}" when a scan brought a new chain into a multi-chain graph.
function logChainAdded(before, chainId) {
  const n = store.chains().length;
  if (!before.includes(chainId) && n >= 2) logger.log({ level: "info", key: "log.chainAdded", params: { chain: chainLabel(chainId), n } });
}

// Same-address nodes on other chains, from the links touching `node` (derived, never stored).
function otherChainsFor(node) {
  const twins = [];
  for (const l of sameAddressLinks(store.listNodes(), addressEvidence(store.listEdges(), CHAINS))) {
    const other = l.a === node.id ? l.b : l.b === node.id ? l.a : null;
    if (other) twins.push({ id: other, chainName: chainLabel(store.getNode(other).chainId), basis: l.basis });
  }
  return {
    twins,
    canApplyAlias: !!node.alias && twins.some((x) => x.basis === "key" && !store.getNode(x.id).alias),
    onFocusTwin: (tid) => revealAndFocus({ kind: "node", id: tid }),
    onApplyAlias: () => applyAliasToTwins(node.id),
    probe: probeCache.get(node.address) || null,
    // Probe-priority order first (mainnets), so the picker never defaults to a testnet.
    loadable: CHAINS.filter((c) => !store.hasNode(nodeId(String(c.id), node.address)))
      .sort((x, y) => probePriority(x.id) - probePriority(y.id))
      .map((c) => ({ chainId: String(c.id), name: c.name })),
    onCheckOtherChains: () => checkOtherChains(node.id),
    onLoadOnChain: (chainId) => loadOnChain(node.id, chainId),
  };
}

const probePriority = (id) => {
  const i = PROBE_CHAIN_IDS.indexOf(id);
  return i < 0 ? PROBE_CHAIN_IDS.length : i;
};

// "Check other chains" results per address (session only, not graph facts): cleared on every store reset.
const probeCache = new Map();

// Probe this address on the probe set's chains it isn't on yet, as THE network op (Stop cancels it).
async function checkOtherChains(id) {
  const node = store.getNode(id);
  if (!node) return;
  if (scanning || detecting) return rerenderDetails();
  if (!$("apiKey").value.trim()) {
    logger.log({ level: "error", key: "error.apiKeyRequired" });
    return rerenderDetails();
  }
  const candidates = PROBE_CHAIN_IDS.filter((c) => !store.hasNode(nodeId(String(c), node.address)))
    .map((c) => ({ chainId: c, name: chainLabel(c) }));
  await withBusy(async ({ signal, limiter }) => {
    const results = await probeChains(node.address, candidates, { probeOne: probeOneChain, limiter, signal });
    if (signal.aborted) return; // a stopped probe is partial: discard it, never show it as complete
    // Stored before withBusy's final re-render, so the results show as soon as Stop/Start re-enable.
    probeCache.set(node.address, rankChainActivity(results).ranked.map((r) => ({
      chainId: String(r.chainId),
      name: r.name,
      state: r.planRequired ? "plan" : r.error ? "error" : r.active ? "active" : "inactive",
    })));
  });
}

// One first-load page of this address on another chain (no BFS). The new node takes the
// source's depth and root flag, never its alias.
async function loadOnChain(id, chainId) {
  const src = store.getNode(id);
  if (!src) return;
  return loadNewNode(chainId, src.address, { depth: src.depth, isRoot: src.isRoot }, formTypes());
}

// One first-load page of `address` on `chainId` (no BFS) into a new node with `meta`, for
// `types`; if nothing could be fetched the node is removed again. Shared by loadOnChain and Look.
async function loadNewNode(chainId, address, meta, types) {
  if (scanning || detecting) return rerenderDetails();
  const refusal = loadRefusal(chainId, types);
  if (refusal) {
    logger.log({ level: "error", ...refusal });
    return rerenderDetails();
  }
  const newId = nodeId(chainId, address);
  if (store.hasNode(newId)) return rerenderDetails(); // already there: never load into, or remove, an existing node
  const before = store.chains();
  store.addNode(chainId, address, meta);
  const res = await loadOlderFor(newId, types);
  if (res && !res.stopped && !res.errors && res.newEdges === 0) {
    store.removeNodes([newId]); // fetched fine, nothing there: never keep an isolated node
    logger.log({ level: "info", key: "log.loadOnChainNone", params: { chain: chainLabel(chainId) } });
  } else if (store.getNode(newId)?.history) {
    logChainAdded(before, chainId);
  } else {
    store.removeNodes([newId]);
    // Stopped by the user: info, not a failure.
    logger.log({ level: res?.stopped ? "info" : "error", key: "log.loadOnChainEmpty", params: { chain: chainLabel(chainId) } });
  }
  rerenderDetails(); // whatever the user selected meanwhile, not a jump back to the source
}

// Copy this node's alias to same-key twins that have none; never overwrites.
function applyAliasToTwins(id) {
  const node = store.getNode(id);
  if (!node || !node.alias) return;
  const targets = otherChainsFor(node).twins.filter((x) => x.basis === "key" && !store.getNode(x.id).alias);
  targets.forEach((x) => store.setAlias(x.id, node.alias));
  logger.log({ level: "info", key: "log.aliasApplied", params: { n: targets.length } });
  rerenderDetails();
}

function showNodeDetails(id) {
  const node = store.getNode(id);
  if (!node) return;
  currentDetail = { kind: "node", id };
  const types = typesFor(node.chainId);
  renderNodeDetails($("detailsContent"), node, {
    i18n,
    explorer: explorerFor(node.chainId),
    onRename: promptAlias,
    risk: computeRisk(id),
    deposit: depositMap.get(id) || null,
    getKnownSource: (a) => {
      const source = knownEntry(a, node.chainId, knownData)?.source || null;
      return source && isAllChainEntry(a, node.chainId, knownData) ? `${source} — ${t("details.allChainsListing")}` : source;
    },
    history: historyState(node, types.map((x) => x.action)).map((h, i) => ({ ...h, labelKey: types[i].labelKey })),
    pageSize: sampleSize(node.chainId, clampInt($("maxTxPerAddress").value, LIMITS.maxTxPerAddress, DEFAULTS.maxTxPerAddress)),
    onLoadOlder: () => loadOlderFor(id),
    busy: scanning || detecting,
    loadBlocked: unsupportedChain(node.chainId),
    otherChains: isTron(node.chainId) ? null : otherChainsFor(node), // ruling 3: no twins / other-chain loads for Tron
  });
}

function showEdgeDetails(edgeKey) {
  // EdgeRecord, or a BundledEdge when bundling is on; a raw key opened before bundling is read
  // from the store. Gone (pruned, reset): clear, never leave a stale panel with dead buttons.
  const data = view.getEdgeData(edgeKey) ?? store.listEdges().find((e) => e.key === edgeKey);
  if (!data) return clearDetails();
  if (data.bridge) return showBridgeDetails(data.id);
  currentDetail = { kind: "edge", id: edgeKey };
  if (data.twin) {
    const lab = (id) => chainLabel(store.getNode(id)?.chainId);
    return renderTwinDetails($("detailsContent"), { address: data.address, chains: [lab(data.a), lab(data.b)] }, { i18n });
  }
  const deps = {
    i18n,
    explorer: explorerFor(data.chainId),
    getAlias: (a) => store.getAlias(nodeId(data.chainId, a)),
    getKnownLabel: (a) => knownLabel(a, data.chainId, knownData),
    getCategory: (a) => knownCategory(a, data.chainId, knownData),
    isFakeToken: isFakeTokenEdge,
  };
  if (data.memberKeys) renderBundleDetails($("detailsContent"), data, deps);
  else {
    const usd = usdFn();
    const dep = bridgeState.deposits.get(data.key);
    renderEdgeDetails($("detailsContent"), data, { ...deps, usd: usd ? usd(data) : null, bridgeDeposit: dep ? bridgeDepositView(dep) : null });
  }
}

function rerenderDetails() {
  flushDerived(); // never re-render from derived state that predates the last store change
  if (!currentDetail) return;
  if (currentDetail.kind === "node") showNodeDetails(currentDetail.id);
  else if (currentDetail.kind === "bridge") showBridgeDetails(currentDetail.id);
  else showEdgeDetails(currentDetail.id);
}

function clearDetails() {
  currentDetail = null;
  const el = $("detailsContent");
  el.textContent = t("details.empty");
}

function promptAlias(id) {
  const node = store.getNode(id);
  if (!node) return;
  const next = window.prompt(t("alias.prompt", { addr: displayAddress(node.address) }), node.alias || "");
  if (next === null) return; // cancelled
  store.setAlias(id, next.trim() || null); // store emits alias:set -> view refreshes
  if (currentDetail && currentDetail.kind === "node" && currentDetail.id === id) {
    showNodeDetails(id);
  }
}

// ---------------------------------------------------------------------------
// Command palette (Ctrl/Cmd+K) — search the graph, jump to a match
// ---------------------------------------------------------------------------
// Build the ranked-search record list on demand (called on every keystroke via
// palette.js) so it always reflects the CURRENT store + chain-scoped labels —
// no separate index to keep in sync.
function buildSearchRecords() {
  const records = [];
  const multi = store.chains().length >= 2;
  for (const node of store.listNodes()) {
    const alias = store.getAlias(node.id);
    const known = knownLabel(node.address, node.chainId, knownData);
    const category = knownCategory(node.address, node.chainId, knownData);
    records.push({
      kind: "node",
      id: node.id,
      title: alias || known || shortAddress(node.address),
      subtitle: multi ? `${displayAddress(node.address)} · ${chainLabel(node.chainId)}` : displayAddress(node.address),
      text: [alias, known, category].filter(Boolean).map((s) => s.toLowerCase()),
      hex: [node.address, displayAddress(node.address)],
    });
  }
  for (const edge of store.listEdges()) {
    const method = methodName(edge.methodId);
    records.push({
      kind: "edge",
      id: edge.key,
      title: method || `${edge.symbol} tx`,
      subtitle: `${shortAddress(edge.from)} → ${shortAddress(edge.to)}${multi ? ` · ${chainLabel(edge.chainId)}` : ""}`,
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
function revealNode(id) {
  if (view.hasRenderedNode(id)) return;

  const chain = store.getNode(id)?.chainId;
  if (hiddenChains.delete(chain)) {
    refreshChainFilter();
    applyDisplayOptions();
    if (view.hasRenderedNode(id)) return;
  }

  // Only the toggle matching THIS node's own hub kind can be hiding it — clearing
  // the other one too would be a no-op for this reveal and surprise the user by
  // silently changing an unrelated filter.
  const kind = hubMap.get(id);
  if (kind === "faucet" && $("hideFaucetsChk").checked) {
    $("hideFaucetsChk").checked = false;
    syncHubHidden();
  } else if (kind === "sink" && $("hideSinksChk").checked) {
    $("hideSinksChk").checked = false;
    syncHubHidden();
  }

  if (!view.hasRenderedNode(id)) {
    $("minAmount").value = 0;
    $("hideZeroToggle").checked = false;
    $("hideSpamToggle").checked = false;
    $("dateFrom").value = "";
    $("dateTo").value = "";
    applyDisplayOptions();
  }

  const node = store.getNode(id);
  logger.log({ level: "info", key: "palette.revealed", params: { addr: shortAddress(node ? node.address : "") } });
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
  revealNode(edge.fromId);
  revealNode(edge.toId);
  view.fit({ nodes: [edge.fromId, edge.toId], animation: { duration: 400, easingFunction: "easeInOutQuad" } });
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
async function withBusy(fn, { rps, host } = {}) {
  scanning = true;
  const abortController = new AbortController();
  const limiter = new RateLimiter(rps ?? formRps());
  const onStop = () => {
    abortController.abort();
    limiter.clear();
    logger.log({ level: "info", key: "log.stopRequested" });
  };
  $("startBtn").disabled = true;
  $("stopBtn").disabled = false;
  $("address").disabled = true;
  $("detectChainBtn").disabled = true;
  indicator.setActive(true, host ?? "api.etherscan.io");
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

// The address field as a root on `chainId` (canonical lowercase), or null after logging why.
// Tron takes a checksummed T… or 41 hex in any case; the field is already trimmed.
function parseRoot(chainId, address) {
  const root = isTron(chainId) ? parseTronAddress(address) : isValidAddress(address) ? address.toLowerCase() : null;
  if (!root) logger.log({ level: "error", key: isTron(chainId) ? "error.invalidTronAddress" : "error.invalidAddress" });
  return root;
}

// Per-address N on `chainId` (ruling 14: TronGrid caps it at 200); logs when the form asks for more.
function sampleFor(chainId) {
  const asked = clampInt($("maxTxPerAddress").value, LIMITS.maxTxPerAddress, DEFAULTS.maxTxPerAddress);
  const n = sampleSize(chainId, asked);
  if (n < asked) logger.log({ level: "info", key: "log.tronLimitCapped", params: { n, asked } });
  return n;
}

async function startScan() {
  if (scanning) return;

  const apiKey = $("apiKey").value.trim();
  const address = $("address").value.trim();
  const chainId = $("chainSelect").value;
  const maxDepth = clampInt($("depth").value, LIMITS.depth, DEFAULTS.depth);
  const safetyCap = clampInt($("safetyCap").value, LIMITS.safetyCap, DEFAULTS.safetyCap);
  const types = typesFor(chainId);

  if (!apiKey && !isTron(chainId)) return logger.log({ level: "error", key: "error.apiKeyRequired" });
  const root = parseRoot(chainId, address);
  if (!root) return;
  // Roots accumulate on any supported chain: another chain adds a root on that chain.
  const refusal = loadRefusal(chainId, types);
  if (refusal) return logger.log({ level: "error", ...refusal });
  const before = store.chains();

  const maxTxPerAddress = sampleFor(chainId);
  const rps = rpsFor(chainId);
  const client = clientFor(chainId, rps);

  collapseControls(); // give the map the full surface once a scan begins

  showSamplingBanner(maxTxPerAddress);

  logger.log({
    level: "info",
    key: "log.scanStart",
    params: { root: displayAddress(root), depth: maxDepth, types: types.map((x) => t(x.labelKey)).join(", ") },
  });

  const summary = await withBusy(({ signal, limiter }) =>
    runScan({
      client,
      store,
      limiter,
      chainId,
      root,
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
    }),
    { rps, host: hostFor(chainId) }
  );

  if (!summary) return; // runScan only rejects on programmer error; guard the post-scan path anyway
  if (summary.capped) logger.log({ level: "error", key: "log.safetyCap", params: { cap: safetyCap } });
  logger.log({
    level: "info",
    key: "log.scanDone",
    params: { nodes: summary.nodes, edges: summary.edges, calls: summary.apiCalls },
  });
  logChainAdded(before, chainId);
  status.set(
    summary.planRequired
      ? t("status.planRequired", { chain: chainLabel(chainId) })
      : t("status.done", { nodes: summary.nodes, edges: summary.edges })
  );

  afterGraphChange();
}

// Details-panel "Load older": fetch the next older page per selected type for
// one node, on THAT node's chain. Counterparties are added, never expanded.
async function loadOlderFor(id, types = formTypes()) {
  const node = store.getNode(id);
  if (!node) return;
  // Busy (or probing chains): ignore, but re-render so the clicked button isn't left disabled.
  if (scanning || detecting) return rerenderDetails();
  types = typesFor(node.chainId, types);
  const refusal = loadRefusal(node.chainId, types);
  if (refusal) {
    logger.log({ level: "error", ...refusal });
    return rerenderDetails();
  }

  const maxTxPerAddress = sampleFor(node.chainId);
  showSamplingBanner(maxTxPerAddress); // loaded rows are a sample too (demo/workspace graphs hide it)
  status.set(t("status.loadingOlder", { addr: shortAddress(node.address) }));

  const rps = rpsFor(node.chainId);
  const res = await withBusy(({ signal, limiter }) =>
    loadOlder({
      client: clientFor(node.chainId, rps),
      store,
      limiter,
      chainId: node.chainId,
      address: node.address,
      types,
      maxTxPerAddress,
      signal,
      onLog: (e) => logger.log(e),
    }),
    { rps, host: hostFor(node.chainId) }
  );

  afterGraphChange();
  rerenderDetails();
  logger.log({
    level: "info",
    key: "log.loadOlderDone",
    params: { addr: displayAddress(node.address), edges: res.newEdges, nodes: res.newNodes, calls: res.apiCalls },
  });
  const done = { edges: res.newEdges, addr: shortAddress(node.address), errors: res.errors };
  const key = res.stopped ? "status.loadOlderStopped" : res.errors ? "status.loadOlderErrors" : "status.loadOlderDone";
  status.set(res.planRequired ? t("status.planRequired", { chain: chainLabel(node.chainId) }) : t(key, done));
  return res;
}

function resetGraph() {
  if (scanning) return;
  store.reset(); // view clears via 'reset' event
  bridgeDecisions = new Map();
  logger.clear();
  status.clear();
  clearDetails();
  $("samplingBanner").hidden = true;
  queryLog.clear();
  refreshQueryLogUi();
  newPriceEpoch();
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
  const client = makeClient(apiKey, chainId);
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
    const chains = localHits.map((h) => (h.chainId === "*" ? t("details.allChains") : chainLabel(h.chainId))).join(", ");
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
// Provenance for one export: time, retrieval window from the query log, footer lines (UI language).
function exportContext() {
  const exportedAt = new Date().toISOString();
  const retrieval = retrievalSummary(queryLog.toJSON());
  const bridgeLinks = view.getBridgeLinks().map((l) => {
    const confirmed = l.decision === "confirmed";
    return { a: l.a, b: l.b, confirmed, label: t(confirmed ? "bridge.linkConfirmed" : "bridge.link") };
  });
  const footer = footerLines({ t, appVersion: APP_VERSION, exportedAt, retrieval, bridges: bridgeLinks.length > 0, tron: store.chains().includes(TRON_CHAIN_ID) });
  return { exportedAt, retrieval, bridgeLinks, footer };
}
// The live view's badge line (network.js), baked into PNG/PDF.
const depositBadge = (n) => {
  const d = depositMap.get(n.id);
  return d ? t("deposit.badge", { label: d.label }) : null;
};

function currentFilters() {
  return {
    minAmount: parseFloat($("minAmount").value) || 0,
    hideZero: $("hideZeroToggle").checked,
    hideSpam: $("hideSpamToggle").checked,
    bundle: $("bundleToggle").checked,
    minTime: dateToEpoch($("dateFrom").value),
    maxTime: dateToEpoch($("dateTo").value),
    hiddenChains: [...hiddenChains],
    showTwins: $("twinToggle").checked,
    showBridges: $("bridgeToggle").checked,
  };
}

// The ONE workspace / query-log text builders: Save and the evidence bundle write these exact bytes.
// Ruling 23: a Tron root is saved as its canonical 41 hex, never as lowercased base58.
const savedRoot = () => {
  const v = $("address").value.trim();
  return parseTronAddress(v) ?? (v.toLowerCase() || null);
};
const workspaceText = (savedAt) =>
  JSON.stringify(
    serializeWorkspace({
      root: savedRoot(),
      nodes: store.listNodes(),
      edges: store.listEdges(),
      filters: currentFilters(),
      layout: $("layoutSelect").value,
      annotations: view.getAnnotations(),
      bridgeDecisions: savedDecisions(),
      queryLog: queryLog.toJSON(),
      provenance: { savedAt, appVersion: APP_VERSION, caveats: CAVEATS },
    }),
    null,
    2
  );
const queryLogText = (exportedAt) => JSON.stringify(queryLogDocument(queryLog.toJSON(), exportedAt), null, 2);

function saveWorkspace() {
  if (!store.stats().nodes) return logger.log({ level: "error", key: "log.exportEmpty" });
  const url = URL.createObjectURL(new Blob([workspaceText(new Date().toISOString())], { type: "application/json" }));
  triggerDownload(url, "workspace.json");
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  logger.log({ level: "info", key: "log.workspaceSaved" });
}

// Returns false (and logs) when refused: a scan/load in flight would keep writing
// into the replaced graph — stray records, mis-credited counts. Checked here, at
// apply time, because demo/file loads resolve asynchronously after the click.
function applyWorkspace(ws) {
  if (scanning) {
    logger.log({ level: "error", key: "error.busy" });
    return false;
  }
  store.loadSnapshot(ws.nodes, ws.edges);
  // A single-chain graph drives the selector (the chain for the next scan).
  const cs = store.chains();
  if (cs.length === 1 && CHAINS.some((c) => String(c.id) === cs[0])) $("chainSelect").value = cs[0];
  syncTronBox();
  const f = ws.filters || {};
  $("minAmount").value = f.minAmount || 0;
  $("hideZeroToggle").checked = !!f.hideZero;
  $("hideSpamToggle").checked = !!f.hideSpam;
  $("bundleToggle").checked = !!f.bundle;
  $("dateFrom").value = epochToLocal(f.minTime);
  $("dateTo").value = epochToLocal(f.maxTime);
  hiddenChains = new Set((f.hiddenChains || []).filter((c) => cs.length >= 2 && cs.includes(c)));
  refreshChainFilter();
  if (ws.layout) {
    $("layoutSelect").value = ws.layout;
    view.setLayout(ws.layout);
  }
  view.setAnnotations(ws.annotations || []);
  recomputeHubs();
  if ($("hideFaucetsChk").checked || $("hideSinksChk").checked) syncHubHidden();
  if ($("peelChk").checked) view.setPeelChains(findPeelChains(store.listEdges(), {}));
  view.refreshLabels();
  $("twinToggle").checked = f.showTwins !== false;
  view.setTwins($("twinToggle").checked);
  $("bridgeToggle").checked = f.showBridges !== false;
  view.setBundling(!!f.bundle);
  applyDisplayOptions();
  syncChainUi();
  clearDetails();
  if (ws.assumedChainId) {
    logger.log({ level: "info", key: "log.workspaceAssumedChain", params: { chain: chainLabel(ws.assumedChainId) } });
  }
  return true;
}

// Parse refusal: the localized message when the workspace module names one.
function logWorkspaceRefusal(res) {
  logger.log(res.errorKey ? { level: "error", key: res.errorKey } : { level: "error", key: "log.workspaceError", params: { error: res.error } });
}

// Ruling 31: v1/v2 files predate Tron, so their chain fallback is never Tron: the selector when it
// is an EVM chain, else the stored EVM chain, else Ethereum.
const legacyChain = () => {
  const isEvm = (v) => CHAINS.some((c) => String(c.id) === v);
  const stored = localStorage.getItem(STORAGE_KEYS.chainId);
  return isEvm($("chainSelect").value) ? $("chainSelect").value : isEvm(stored) ? stored : "1";
};

function loadWorkspaceFromText(text) {
  const res = parseWorkspace(text, { fallbackChainId: legacyChain() });
  if (!res.ok) return logWorkspaceRefusal(res);
  const ws = res.data;
  if (!applyWorkspace(ws)) return;
  bridgeDecisions = new Map(ws.bridgeDecisions);
  // A file without a query log is "unknown", not "empty": its graph has no logged retrieval.
  if (ws.queryLog) queryLog.load(ws.queryLog);
  else {
    queryLog.clear();
    queryLog.markUnlogged();
  }
  if (ws.bridgeDecisionsInvalid > 0) logger.log({ level: "error", key: "log.bridgeDecisionsInvalid", params: { n: ws.bridgeDecisionsInvalid } });
  if (ws.queryLogInvalid) logger.log({ level: "error", key: "log.queryLogInvalid", params: { n: ws.queryLogInvalid } });
  refreshQueryLogUi();
  newPriceEpoch();
  const s = store.stats();
  logger.log({ level: "info", key: "log.workspaceLoaded", params: { nodes: s.nodes, edges: s.edges } });
}

async function loadDemo() {
  try {
    const resp = await fetch(DATA_PATHS.demo);
    if (!resp.ok) throw new Error(String(resp.status));
    const res = parseWorkspace(await resp.json(), { fallbackChainId: legacyChain() });
    if (!res.ok) return logWorkspaceRefusal(res);
    if (!applyWorkspace(res.data)) return;
    bridgeDecisions = new Map();
    // The demo was never retrieved under this log, whatever the file holds.
    queryLog.clear();
    queryLog.markUnlogged();
    refreshQueryLogUi();
    newPriceEpoch();
    logger.log({ level: "info", key: "log.demoLoaded" });
  } catch (e) {
    logger.log({ level: "error", key: "log.workspaceError", params: { error: String(e.message || e) } });
  }
}

async function runEstimate() {
  const apiKey = $("apiKey").value.trim();
  const address = $("address").value.trim();
  const chainId = $("chainSelect").value;
  if (!apiKey && !isTron(chainId)) return logger.log({ level: "error", key: "error.apiKeyRequired" });
  const root = parseRoot(chainId, address);
  if (!root) return;
  const types = typesFor(chainId);
  if (!types.length) return logger.log({ level: "error", key: "error.noTypeSelected" });

  const maxDepth = clampInt($("depth").value, LIMITS.depth, DEFAULTS.depth);
  const maxTxPerAddress = sampleFor(chainId);
  const safetyCap = clampInt($("safetyCap").value, LIMITS.safetyCap, DEFAULTS.safetyCap);
  const rps = rpsFor(chainId);
  const limiter = new RateLimiter(rps);
  const client = clientFor(chainId, rps);

  indicator.setActive(true, hostFor(chainId));
  let neighbors = 0;
  try {
    for (const ti of types) {
      const txs = await limiter.run(() => client.fetchAction(root, ti.action, { offset: maxTxPerAddress }));
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
    return logger.log({ level: "error", key: "error.fetch", params: { address: displayAddress(root), action: "estimate", message: e.message || String(e) } });
  }
  indicator.setActive(false);

  const est = estimateScan({ firstHopNeighbors: neighbors, maxDepth, typesCount: types.length, rps, maxTxPerAddress, safetyCap });
  logger.log({ level: "info", key: "log.estimate", params: { addresses: est.addresses, calls: est.apiCalls, seconds: est.seconds } });
}

// ---------------------------------------------------------------------------
// Prune / rotate / high-degree / fit / export
// ---------------------------------------------------------------------------
// The one prune path (Delete button and Delete/Backspace key).
function deleteSelectedNodes() {
  if (scanning) return logger.log({ level: "error", key: "error.busy" }); // the scan would re-add or mis-count them
  const selected = view.network.getSelectedNodes();
  if (!selected.length) return logger.log({ level: "error", key: "error.selectNodesFirst" });
  const { removedNodes } = store.removeNodes(selected);
  logger.log({ level: "info", key: "log.nodesDeleted", params: { n: removedNodes } });
  if (currentDetail && selected.includes(currentDetail.id)) clearDetails();
  dropStaleTwinDetail();
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
  // Image deps shared by PNG, PDF and the bundle's graph.png (footer = provenance band).
  const imageDeps = ({ footer, bridgeLinks }) => ({
    preset: $("exportResolution").value,
    addressFormat: $("addressFormat").value,
    annotations: view.getAnnotations(),
    chainTag: getChainTag,
    twinLinks: view.getTwinLinks(),
    twinLabel: t("details.twinKey"),
    bridgeLinks,
    footer,
    badge: depositBadge,
    onLog,
  });
  $("exportPngBtn").addEventListener("click", () => exportPng(view, store, imageDeps(exportContext())));
  $("exportPdfBtn").addEventListener("click", () =>
    exportPdf(view, store, { ...imageDeps(exportContext()), jsPDF: window.jspdf.jsPDF })
  );
  $("exportCsvBtn").addEventListener("click", () => {
    const { exportedAt, retrieval } = exportContext();
    exportCsv(store, { onLog, ...flagCtx, deposits: depositMap, usd: usdFn(), bridges: { candidates: bridgeState.candidates, decisions: bridgeDecisions }, provenance: { exportedAt, retrieval } });
  });
  $("exportQueryLogBtn").addEventListener("click", () => {
    const now = new Date();
    const url = URL.createObjectURL(new Blob([queryLogText(now.toISOString())], { type: "application/json" }));
    triggerDownload(url, `query-log-${fileStamp(now)}.json`);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    logger.log({ level: "info", key: "log.queryLogExported", params: { n: queryLog.entries().length } });
  });
  // Never rejects: exportEvidenceBundle logs its own failure (log.bundleFailed).
  $("evidenceBundleBtn").addEventListener("click", () => {
    const ctx = exportContext();
    const { exportedAt, retrieval } = ctx;
    const usd = usdFn();
    exportEvidenceBundle(view, store, {
      ...imageDeps(ctx),
      ...flagCtx,
      deposits: depositMap,
      bridges: { candidates: bridgeState.candidates, decisions: bridgeDecisions },
      usd,
      exportedAt,
      retrieval,
      workspaceText: workspaceText(exportedAt),
      queryLogText: queryLogText(exportedAt),
      manifest: {
        chains: store.chains().map((c) => ({ chainId: c, name: chainLabel(c) })),
        roots: store.listNodes().filter((n) => n.isRoot).map((n) => n.id),
        sampling: {
          formAtExport: {
            maxDepth: clampInt($("depth").value, LIMITS.depth, DEFAULTS.depth),
            maxTxPerAddress: clampInt($("maxTxPerAddress").value, LIMITS.maxTxPerAddress, DEFAULTS.maxTxPerAddress),
            safetyCap: clampInt($("safetyCap").value, LIMITS.safetyCap, DEFAULTS.safetyCap),
            types: formTypes().map((x) => x.action),
          },
          observed: observedSampling(queryLog.entries()),
        },
        providers: providersSummary(queryLog.entries()),
        data: { knownAddresses: knownDataSnapshot(knownData) },
        bridges: bridgeCounts(),
        prices: {
          shown: !!usd,
          queries: queryLog.entries().filter((e) => e.source === "defillama").length,
          ...(usd ? usdCounts(store.listEdges(), usd) : { priced: null, priceable: null }),
        },
      },
    });
  });
  $("queryLogPanel").addEventListener("toggle", refreshQueryLogUi);

  // Noise-reduction filters (live display projection; store is untouched).
  $("minAmount").addEventListener("input", applyDisplayOptions);
  $("hideZeroToggle").addEventListener("change", applyDisplayOptions);
  $("hideSpamToggle").addEventListener("change", applyDisplayOptions);
  $("bundleToggle").addEventListener("change", () => view.setBundling($("bundleToggle").checked));
  $("twinToggle").addEventListener("change", () => {
    view.setTwins($("twinToggle").checked);
    syncChainUi();
  });
  $("bridgeToggle").addEventListener("change", syncBridgeLinks);
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
  $("usdToggle").addEventListener("change", onUsdToggle);

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
    getKnownLabel: (a, c) => knownLabel(a, c, knownData),
    getChainTag,
    getKnownNote: (a, c) => (isAllChainEntry(a, c, knownData) ? t("details.allChainsListing") : null),
    // Returns the hub classification whenever ANY hub-driven feature is engaged
    // (the dim-only toggle OR either hide toggle) — not just when hubOn is on —
    // so "Hide faucets"/"Hide sinks" work independently of the dim toggle. The
    // DIM decision itself is separate — see getHubDimOn — so checking only
    // "Hide faucets" never greys out sinks too.
    getHubKind: (id) =>
      hubOn || $("hideFaucetsChk").checked || $("hideSinksChk").checked ? hubMap.get(id) || null : null,
    // Gates the grey "de-emphasized hub" node background in applyNode. ONLY the
    // dim-only hubToggle — independent of the hide checkboxes above — so
    // checking "Hide faucets" (hubToggle OFF) hides faucets without dimming
    // sinks (or anything else).
    getHubDimOn: () => hubOn,
    getCategory: (a, c) => knownCategory(a, c, knownData),
    getEdgeFlags: (edge) => flagsForEdge(edge, flagCtx),
    getDeposit: (id) => depositMap.get(id) || null,
  });
  // Chain tags / legend row depend on the distinct chain set: resync only when it changes.
  let lastChains = store.chains().join(",");
  view.setTwins(true);
  let chainSyncQueued = false;
  store.subscribe((e) => {
    if (e.type === "reset") probeCache.clear(); // incl. workspace/demo load (loadSnapshot resets)
    if (e.type !== "node:add" && e.type !== "node:remove" && e.type !== "reset") return;
    if (chainSyncQueued) return;
    chainSyncQueued = true;
    queueMicrotask(() => {
      chainSyncQueued = false;
      const now = store.chains().join(",");
      if (now === lastChains) return;
      lastChains = now;
      syncChainUi();
    });
  });
  store.subscribe((e) => {
    if (e.type === "alias:set" || derivedQueued) return;
    derivedQueued = true;
    setTimeout(flushDerived, 0);
  });
  // While USD is on, want the keys a graph change made priceable: new edges, or a root removed /
  // nodes updated (isRoot), which can turn a "root" skip into a key. Coalesced to one macrotask.
  let usdQueued = false;
  const usdEvents = new Set(["edge:add", "node:remove", "node:update"]);
  store.subscribe((e) => {
    if (!usdEvents.has(e.type) || usdQueued) return;
    usdQueued = true;
    setTimeout(() => { usdQueued = false; wantAll(); }, 0);
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
    onDelete: deleteSelectedNodes,
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
  $("usdToggle").checked = false; // never restored (a browser may restore form state on reload)
  // async; enriches labels + spam sets when ready, then arms USD (fail closed: a rejection counts as failed data)
  loadLocalData().catch(() => false).then((ok) => {
    usdDataOk = ok;
    onUsdToggle();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
