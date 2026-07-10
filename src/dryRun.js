// =============================================================================
// dryRun.js — pure, DOM-free estimator for warning the user before a large BFS
// scan. Given what we learn from the root's first hop (neighbor count) plus
// the scan settings, estimate total addresses touched / API calls / wall-clock.
//
// This is a ROUGH UPPER-BOUND model, not a simulation of scanner.js: it assumes
// every address at a given depth has the SAME branching factor as the root's
// first hop, and it does not model per-address/per-action enqueue dedup. Real
// scans will typically visit fewer addresses (dedup collapses shared
// neighbors), so this is intentionally pessimistic.
// =============================================================================

/**
 * @typedef {object} ScanEstimate
 * @property {number} addresses  estimated total addresses added to the graph (rounded)
 * @property {number} apiCalls   estimated total Etherscan calls (rounded)
 * @property {number} seconds    estimated wall-clock time at the given rps (1 decimal)
 */

/**
 * @typedef {object} EstimateScanOptions
 * @property {number} firstHopNeighbors  neighbors discovered from the root's first hop
 * @property {number} maxDepth           BFS depth cap
 * @property {number} typesCount         number of selected tx-type actions (e.g. 1-3)
 * @property {number} rps                requests/sec the limiter is paced at
 * @property {number} maxTxPerAddress    per-address per-action sample size (accepted for
 *                                        future use; does not affect apiCalls — it bounds
 *                                        rows fetched per call, not the call count)
 * @property {number} safetyCap          hard ceiling on total addresses processed
 */

/**
 * Clamp `value` to a finite number no smaller than `min`. Non-numeric,
 * NaN, +/-Infinity, or below-min inputs all collapse to `min`.
 * @param {unknown} value
 * @param {number} min
 * @returns {number}
 */
function clampMin(value, min) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < min) return min;
  return n;
}

/**
 * Same as {@link clampMin} but floors to an integer (for count-like inputs:
 * neighbor/type/depth counts). `min` itself must be an integer.
 * @param {unknown} value
 * @param {number} min
 * @returns {number}
 */
function clampMinInt(value, min) {
  return Math.floor(clampMin(value, min));
}

/**
 * Estimate the cost of a BFS scan BEFORE running it, using the branching
 * factor observed from the root's first hop.
 *
 * Model (rough UPPER-BOUND):
 *  - branching factor `b = max(1, firstHopNeighbors)` — every address is
 *    assumed to fan out like the root did.
 *  - Frontier growth capped by `safetyCap`: `total` starts at 1 (the root),
 *    `frontier` starts at 1. For each depth `d` from 1 to `maxDepth`, the new
 *    frontier is `min(frontier * b, remaining capacity)` and is added to
 *    `total`. Growth stops as soon as `total >= safetyCap` (total is then
 *    clamped to exactly `safetyCap`).
 *  - `expandedAddresses` = addresses at depth < maxDepth, i.e. `total` minus
 *    the LAST frontier added (those addresses are added-but-not-expanded,
 *    either because they hit `maxDepth` or the `safetyCap`). Floored at 1 —
 *    this is an estimate, never zero API activity.
 *  - `apiCalls = expandedAddresses * max(1, typesCount)`. `maxTxPerAddress`
 *    does NOT affect this — it bounds rows per call, not the number of calls.
 *  - `seconds = apiCalls / max(1, rps)`.
 *
 * All inputs are guarded against non-finite/negative values (clamped to their
 * minimum). Pure function, no DOM/IO.
 *
 * @param {EstimateScanOptions} options
 * @returns {ScanEstimate}
 */
export function estimateScan(options) {
  const opts = options || {};

  const firstHopNeighbors = clampMinInt(opts.firstHopNeighbors, 0);
  const maxDepth = clampMinInt(opts.maxDepth, 0);
  const typesCount = clampMinInt(opts.typesCount, 0);
  const rps = clampMin(opts.rps, 0);
  // Accepted for future use (affects rows fetched, not call count) — still
  // guarded so callers can't pass garbage through unchecked.
  clampMinInt(opts.maxTxPerAddress, 0);
  const safetyCap = clampMinInt(opts.safetyCap, 1);

  const b = Math.max(1, firstHopNeighbors);

  let total = 1; // root
  let frontier = 1; // depth-0 frontier (the root itself)

  for (let d = 1; d <= maxDepth; d++) {
    if (total >= safetyCap) {
      total = safetyCap;
      frontier = 0;
      break;
    }
    const remaining = safetyCap - total;
    frontier = Math.min(frontier * b, remaining);
    total += frontier;
    if (total >= safetyCap) {
      total = safetyCap;
      break;
    }
  }

  const expandedAddresses = Math.max(1, total - frontier);
  const apiCallsRaw = expandedAddresses * Math.max(1, typesCount);
  const apiCalls = Math.round(apiCallsRaw);
  const addresses = Math.round(total);
  const secondsRaw = apiCalls / Math.max(1, rps);
  const seconds = Math.round(secondsRaw * 10) / 10;

  return { addresses, apiCalls, seconds };
}
