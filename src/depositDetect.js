// =============================================================================
// depositDetect.js — pure, DOM-free exchange deposit-address heuristic.
// Exchanges give each customer a unique deposit address and later sweep it to a
// hot wallet. So an address whose sampled outflow goes (nearly) entirely to ONE
// known exchange wallet is LIKELY a deposit address of that exchange — a lead,
// shown with its evidence, never a fact. Display projection: reads the store's
// nodes/edges, never mutates them. Per chain by construction (node ids are
// chainId:address; every known() lookup uses the record's own chain).
// =============================================================================

/**
 * @typedef {object} DepositEvidence
 * @property {string} walletId   node id of the one exchange wallet
 * @property {string} wallet     its address
 * @property {string} label      its known label on that chain (address if none)
 * @property {number} swept      outgoing value transfers that went to it
 * @property {number} outgoing   outgoing value transfers judged
 * @property {{symbol:string, contract:string, sharePct:number}[]} assets per swept asset; contract "" = native
 * @property {number|null} maxDelaySec longest sweep delay after the latest prior same-asset inflow; null = none seen
 * @property {number} timedSweeps sweeps that had such an inflow in the store
 */

const MIN_SHARE = 90; // % — count share AND per-asset value share (conservative)
const VALUE_ACTIONS = new Set(["txlist", "txlistinternal", "tokentx"]);

/** Raw base-unit integer string -> BigInt; anything else -> null (skipped). */
const units = (v) => (typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : null);
/** Asset key: the token contract for ERC-20, "" for native (normal + internal). */
const assetOf = (e) => (e.action === "tokentx" ? String(e.tokenContract || "").toLowerCase() : "");
/** UNIX seconds from a decimal-digit timestamp; null otherwise (no Infinity / 1e9 / NaN from workspaces). */
const secs = (e) => {
  const t = /^\d+$/.test(String(e.timeStamp)) ? Number(e.timeStamp) : 0;
  return Number.isSafeInteger(t) && t > 0 ? t : null;
};

/**
 * @param {import('./graphStore.js').NodeRecord[]} nodes
 * @param {import('./graphStore.js').EdgeRecord[]} edges
 * @param {{ known:(address:string, chainId:string)=>(import('./knownAddresses.js').KnownEntry|null),
 *           ignoreEdge?:(edge:import('./graphStore.js').EdgeRecord)=>boolean,
 *           trustedToken?:(contract:string, chainId:string)=>boolean }} ctx
 *   trustedToken: may a token sweep vouch for a mark? Absent -> only native sweeps do.
 * @returns {Map<string, DepositEvidence>} node id -> evidence, marked nodes only
 */
export function findDeposits(nodes, edges, ctx) {
  const out = new Map();
  const known = ctx && ctx.known;
  if (typeof known !== "function") return out;
  const ignore = (ctx && ctx.ignoreEdge) || (() => false);
  const trusted = (ctx && ctx.trustedToken) || (() => false);

  const outOf = new Map();
  const inOf = new Map();
  const push = (m, k, e) => (m.get(k) || m.set(k, []).get(k)).push(e);
  for (const e of edges || []) {
    if (!e || e.fromId === e.toId) continue; // self-loops are not flows
    push(outOf, e.fromId, e);
    push(inOf, e.toId, e);
  }

  for (const n of nodes || []) {
    const h = n && n.history;
    if (!h || !h.txlist || !h.tokentx) continue; // 1. its own txs were fetched
    if (known(n.address, n.chainId)) continue; // 2. never a known entity
    // 3. value transfers of an action N itself fetched (same rule for inflows)
    const counts = (e) => VALUE_ACTIONS.has(e.action) && !!h[e.action] && (units(e.value) ?? 0n) > 0n && !ignore(e);
    const O = (outOf.get(n.id) || []).filter(counts);
    const S = O.filter((e) => known(e.to, e.chainId)?.category === "exchange"); // 4.
    if (!S.length || S.some((e) => e.toId !== S[0].toId)) continue; // 5. one wallet
    if (S.length * 100 < O.length * MIN_SHARE) continue; // 6. count share
    // 9. any contract can emit Transfer(from=N): a mark needs one native or trusted-token sweep
    if (!S.some((e) => e.action !== "tokentx" || trusted(assetOf(e), e.chainId))) continue;

    const swept = new Set(S);
    const sums = new Map(); // asset -> { symbol, all, swept }
    for (const e of O) {
      const a = assetOf(e);
      if (!sums.has(a)) sums.set(a, { symbol: e.symbol || "", all: 0n, swept: 0n });
      const s = sums.get(a);
      s.all += units(e.value);
      if (swept.has(e)) s.swept += units(e.value);
    }
    const assets = [...sums].filter(([, s]) => s.swept > 0n);
    if (assets.some(([, s]) => s.swept * 100n < s.all * BigInt(MIN_SHARE))) continue; // 7. value share

    // Delay: evidence only. ponytail: O(sweeps x inflows) per node; fine for sampled graphs.
    const ins = (inOf.get(n.id) || []).filter(counts);
    let maxDelaySec = null;
    let timedSweeps = 0;
    for (const e of S) {
      const t = secs(e);
      if (t === null) continue;
      let last = null;
      for (const i of ins) {
        const ti = secs(i);
        if (ti !== null && ti <= t && assetOf(i) === assetOf(e) && (last === null || ti > last)) last = ti;
      }
      if (last === null) continue;
      timedSweeps++;
      maxDelaySec = Math.max(maxDelaySec ?? 0, t - last);
    }

    const w = S[0];
    out.set(n.id, {
      walletId: w.toId,
      wallet: w.to,
      label: known(w.to, w.chainId)?.label || w.to,
      swept: S.length,
      outgoing: O.length,
      assets: assets.map(([contract, s]) => ({ symbol: s.symbol, contract, sharePct: Number((s.swept * 100n) / s.all) })),
      maxDelaySec,
      timedSweeps,
    });
  }
  return out;
}

/**
 * Sweep delay -> i18n duration parts. Rounded UP (the copy says "within"),
 * minimum 1: under an hour in minutes, under a day in hours, else days.
 * @param {number} sec
 * @returns {{ key:'duration.m'|'duration.h'|'duration.d', params:{ n:number } }}
 */
export function delayParts(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const [key, unit] = s < 3600 ? ["duration.m", 60] : s < 86400 ? ["duration.h", 3600] : ["duration.d", 86400];
  return { key, params: { n: Math.max(1, Math.ceil(s / unit)) } };
}
