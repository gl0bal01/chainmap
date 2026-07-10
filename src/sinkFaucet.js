// =============================================================================
// sinkFaucet.js — pure, DOM-free hub classification (Feature Layer 2). Flags
// addresses that behave like a SINK (receives from many, sends to ~none) or a
// FAUCET (sends to many, receives from ~none) so the view can de-emphasize
// them. Degree is counted over DISTINCT counterparties (not raw edge count)
// so bundled/parallel edges between the same pair don't skew the ratio.
// No vis, no DOM — Node-testable.
// =============================================================================

/**
 * @typedef {'sink'|'faucet'} HubKind
 */

/**
 * Classify hub-like addresses from edge flow.
 *
 * inDeg(addr)  = number of DISTINCT addresses with an edge from -> addr
 * outDeg(addr) = number of DISTINCT addresses addr has an edge -> to
 *
 * SINK   if inDeg  >= minDegree AND inDeg  >= outDeg * ratio (outDeg may be 0)
 * FAUCET if outDeg >= minDegree AND outDeg >= inDeg  * ratio (inDeg  may be 0)
 *
 * If an address qualifies as both by the math (only possible when inDeg and
 * outDeg are close under a low ratio), the larger side wins; ties favor sink.
 * Self-loops (from === to) are ignored entirely. Unclassified addresses are
 * omitted from the result.
 *
 * @param {import('./graphStore.js').NodeRecord[]} nodes  known graph nodes (candidate addresses)
 * @param {import('./graphStore.js').EdgeRecord[]} edges  graph edges (from/to lowercased addresses)
 * @param {{ minDegree?:number, ratio?:number }} [opts]
 * @returns {Map<string, HubKind>} address -> 'sink' | 'faucet'
 */
export function classifyHubs(nodes, edges, opts) {
  const o = opts || {};
  const minDegree = typeof o.minDegree === "number" ? o.minDegree : 6;
  const ratio = typeof o.ratio === "number" ? o.ratio : 4;

  /** @type {Map<string, Set<string>>} address -> distinct senders */
  const inSets = new Map();
  /** @type {Map<string, Set<string>>} address -> distinct recipients */
  const outSets = new Map();

  for (const e of edges || []) {
    if (!e) continue;
    const from = String(e.from || "").toLowerCase();
    const to = String(e.to || "").toLowerCase();
    if (!from || !to || from === to) continue; // ignore self-loops

    let out = outSets.get(from);
    if (!out) { out = new Set(); outSets.set(from, out); }
    out.add(to);

    let inn = inSets.get(to);
    if (!inn) { inn = new Set(); inSets.set(to, inn); }
    inn.add(from);
  }

  const addresses = new Set();
  for (const n of nodes || []) {
    if (n && n.address) addresses.add(String(n.address).toLowerCase());
  }
  for (const a of inSets.keys()) addresses.add(a);
  for (const a of outSets.keys()) addresses.add(a);

  const result = new Map();
  for (const addr of addresses) {
    const inDeg = inSets.has(addr) ? inSets.get(addr).size : 0;
    const outDeg = outSets.has(addr) ? outSets.get(addr).size : 0;
    const isSink = inDeg >= minDegree && inDeg >= outDeg * ratio;
    const isFaucet = outDeg >= minDegree && outDeg >= inDeg * ratio;

    if (isSink && isFaucet) {
      result.set(addr, inDeg >= outDeg ? "sink" : "faucet");
    } else if (isSink) {
      result.set(addr, "sink");
    } else if (isFaucet) {
      result.set(addr, "faucet");
    }
  }
  return result;
}

/**
 * Display de-emphasis factor for a classified hub kind.
 * @param {HubKind|string|undefined|null} kind
 * @returns {number} 0.4 for 'sink'/'faucet', 1 otherwise
 */
export function hubDim(kind) {
  return kind === "sink" || kind === "faucet" ? 0.4 : 1;
}
