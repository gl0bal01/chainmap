// =============================================================================
// chainProbe.js — "Detect chain" activity probe. DOM-free, Node-testable.
//
// An EVM `0x…` address is identical across every EVM chain, so "detecting the
// chain" cannot be a string-format check (see blockchainDetect.js for that —
// it only tells you EVM vs non-EVM). Detection here means: probe a curated set
// of candidate chains for actual on-chain activity, then rank them. Honesty
// invariant: an address can be active on MANY chains — this surfaces all of
// them and calls out the most-active one, it never claims "the" chain.
// =============================================================================

/**
 * @typedef {{ chainId:number, name:string, hasNativeTx:boolean, hasTokenTx:boolean, error?:boolean }} ProbeResult
 */

/**
 * Rank probe results: active chains first (candidate/priority order
 * preserved), inactive/errored chains after (also in candidate order). A
 * chain is "active" iff it has activity AND did not error.
 * @param {ProbeResult[]} results
 * @returns {{ ranked: (ProbeResult & {active:boolean})[], best: number|null }}
 *   best = chainId of the first active chain in candidate order, or null if
 *   none are active.
 */
export function rankChainActivity(results) {
  const withActive = (results || []).map((r) => ({
    ...r,
    active: !r.error && !!(r.hasNativeTx || r.hasTokenTx),
  }));
  const actives = withActive.filter((r) => r.active);
  const inactives = withActive.filter((r) => !r.active);
  const ranked = [...actives, ...inactives];
  const best = actives.length ? actives[0].chainId : null;
  return { ranked, best };
}

/**
 * Probe each candidate chain for the address's activity, serialized via the
 * caller's limiter, cancellable, with progress. The per-chain probe itself is
 * injected (decouples this module from etherscanClient).
 * @param {string} address
 * @param {{chainId:number, name:string}[]} candidates
 * @param {{
 *   probeOne: (chainId:number, address:string, signal?:AbortSignal) => Promise<{hasNativeTx:boolean, hasTokenTx:boolean}>,
 *   limiter: { run:(fn:()=>Promise<any>)=>Promise<any> },
 *   signal?: AbortSignal,
 *   onProgress?: (done:number, total:number) => void
 * }} deps
 * @returns {Promise<ProbeResult[]>} one entry per candidate actually probed
 *   (error:true on a per-chain failure — a single chain's failure never
 *   aborts the whole probe; a real abort between candidates stops early and
 *   returns fewer than `candidates.length` results).
 */
export async function probeChains(address, candidates, deps) {
  const { probeOne, limiter, signal, onProgress } = deps;
  const total = candidates.length;
  const out = [];

  for (const candidate of candidates) {
    if (signal && signal.aborted) break;

    const { chainId, name } = candidate;
    try {
      const { hasNativeTx, hasTokenTx } = await limiter.run(() => probeOne(chainId, address, signal));
      out.push({ chainId, name, hasNativeTx: !!hasNativeTx, hasTokenTx: !!hasTokenTx });
    } catch {
      // A single chain's failure (network/timeout/rate-limit/etc.) is
      // isolated here and marked, never thrown — it must not abort probing
      // the remaining candidates.
      out.push({ chainId, name, hasNativeTx: false, hasTokenTx: false, error: true });
    }

    if (typeof onProgress === "function") onProgress(out.length, total);
  }

  return out;
}
