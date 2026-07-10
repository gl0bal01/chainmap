// =============================================================================
// display.js — pure, DOM-free display-projection helpers for noise reduction
// (Feature Layer 1). The store keeps the FULL graph; these decide what the view
// shows and how thick each edge is. No vis, no DOM — Node-testable.
//
// Threshold caveat: `minAmount` compares against each edge's nominal decimal
// amount (edge.amountText) uniformly across tokens — it is a per-edge magnitude
// filter, NOT a fiat-normalized one (ETH vs USDC are not converted).
// =============================================================================

/**
 * Numeric magnitude of an edge for weighting/threshold. Parses the already-
 * formatted decimal `amountText`; unparseable / indeterminate → 0.
 * @param {import('./graphStore.js').EdgeRecord} edge
 * @returns {number}
 */
export function edgeAmountNumber(edge) {
  const n = Number(edge && edge.amountText);
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {import('./graphStore.js').EdgeRecord} edge
 * @param {{ spamContracts?:Set<string>, spamSymbols?:Set<string> }} opts
 * @returns {boolean} true if the edge is a known spam/airdrop token.
 */
export function isSpam(edge, opts) {
  if (!edge) return false;
  const contracts = opts && opts.spamContracts;
  const symbols = opts && opts.spamSymbols;
  const contract = (edge.tokenContract || "").toLowerCase();
  const symbol = (edge.symbol || "").toLowerCase();
  if (contracts && contract && contracts.has(contract)) return true;
  if (symbols && symbol && symbols.has(symbol)) return true;
  return false;
}

/**
 * Whether an edge passes the active display filters (i.e. should be VISIBLE).
 * `minTime`/`maxTime` are UNIX seconds; edges with an unknown/unparseable
 * timeStamp are NOT excluded by the time range (can't be judged).
 * @param {import('./graphStore.js').EdgeRecord} edge
 * @param {{ minAmount?:number, hideZero?:boolean, hideSpam?:boolean,
 *           minTime?:number, maxTime?:number,
 *           spamContracts?:Set<string>, spamSymbols?:Set<string> }} opts
 * @returns {boolean}
 */
export function passesFilters(edge, opts) {
  const o = opts || {};
  const amount = edgeAmountNumber(edge);
  if (o.hideZero && amount === 0) return false;
  if (o.minAmount > 0 && amount < o.minAmount) return false;
  if (o.hideSpam && isSpam(edge, o)) return false;
  const ts = Number(edge && edge.timeStamp);
  if (Number.isFinite(ts) && ts > 0) {
    if (o.minTime && ts < o.minTime) return false;
    if (o.maxTime && ts > o.maxTime) return false;
  }
  return true;
}

/**
 * True iff any filter is actually engaged (lets the view skip node-visibility
 * recomputation when nothing is filtered).
 * @param {{ minAmount?:number, hideZero?:boolean, hideSpam?:boolean }} opts
 * @returns {boolean}
 */
export function filtersActive(opts) {
  const o = opts || {};
  return Boolean((o.minAmount && o.minAmount > 0) || o.hideZero || o.hideSpam || o.minTime || o.maxTime);
}

/**
 * Amount-weighted edge width in [1, 8]: thicker = larger relative flow.
 * sqrt scaling so small flows stay visible. maxAmount<=0 → uniform 1.
 * @param {number} amount
 * @param {number} maxAmount
 * @returns {number}
 */
export function edgeWidth(amount, maxAmount) {
  if (!Number.isFinite(maxAmount) || maxAmount <= 0) return 1;
  const ratio = Math.min(1, Math.max(0, amount / maxAmount));
  return 1 + Math.sqrt(ratio) * 7;
}

/** Round a summed amount for display without float dust ("3.0000001" -> "3"). */
function formatTotal(n) {
  return String(Number(n.toFixed(6)));
}

/**
 * Age-based edge color: old transfers are cool/dim, recent ones warm/bright, so
 * a "color by age" view shows how fresh each flow is. Unknown ts or a single-
 * timestamp graph -> neutral. Pure.
 * @param {number} ts   edge UNIX seconds
 * @param {number} min  oldest ts in the graph
 * @param {number} max  newest ts in the graph
 * @returns {string} hsl(...) color
 */
export function ageColor(ts, min, max) {
  if (!Number.isFinite(ts) || ts <= 0 || !(max > min)) return "hsl(215, 15%, 60%)";
  const r = Math.min(1, Math.max(0, (ts - min) / (max - min))); // 0 = oldest, 1 = newest
  const hue = Math.round(210 - r * 180); // 210 (blue, old) -> 30 (amber, recent)
  const light = Math.round(42 + r * 26); // dim -> bright
  return `hsl(${hue}, 72%, ${light}%)`;
}

/**
 * @typedef {object} BundledEdge
 * @property {string} id          synthetic bundle id ("bundle:from|to|contract|symbol")
 * @property {string} from
 * @property {string} to
 * @property {string} symbol
 * @property {string} tokenContract
 * @property {string} color
 * @property {'normal'|'internal'|'token'} group
 * @property {number} count       number of collapsed transfers
 * @property {number} total       summed nominal amount
 * @property {string} totalText   display-formatted total
 * @property {boolean} hasData    any collapsed member carried input calldata
 * @property {string[]} memberKeys underlying per-tx edge keys (preserved for detail/CSV)
 */

/**
 * Collapse many per-tx edges into one weighted arrow per (from,to,contract,symbol)
 * so same-unit transfers sum meaningfully. The store keeps every per-tx edge; this
 * is a DISPLAY aggregation only — memberKeys let the UI drill back to the rows.
 * @param {import('./graphStore.js').EdgeRecord[]} edges
 * @returns {BundledEdge[]}
 */
export function bundleEdges(edges) {
  const map = new Map();
  for (const e of edges) {
    const contract = (e.tokenContract || "").toLowerCase();
    const symbol = (e.symbol || "").toLowerCase();
    const key = `${e.from}|${e.to}|${contract}|${symbol}`;
    let b = map.get(key);
    if (!b) {
      b = {
        id: `bundle:${key}`,
        from: e.from, to: e.to,
        symbol: e.symbol || "", tokenContract: e.tokenContract || "",
        color: e.color, group: e.group,
        count: 0, total: 0, hasData: false, memberKeys: [],
      };
      map.set(key, b);
    }
    b.count += 1;
    b.total += edgeAmountNumber(e);
    if (e.hasData) b.hasData = true; // bundle flagged if any member carried calldata
    b.memberKeys.push(e.key);
  }
  return [...map.values()].map((b) => ({ ...b, totalText: formatTotal(b.total) }));
}
