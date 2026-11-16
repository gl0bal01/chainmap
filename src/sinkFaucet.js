// =============================================================================
// sinkFaucet.js — pure, DOM-free hub classification (Feature Layer 2). Flags
// addresses that behave like a SINK (receives from many, sends to ~none) or a
// FAUCET (sends to many, receives from ~none) so the view can de-emphasize
// them. Degree is counted over DISTINCT counterparties (not raw edge count)
// so bundled/parallel edges between the same pair don't skew the ratio. Works
// over node ids (chain-scoped), so hubs are per chain.
// No vis, no DOM — Node-testable.
// =============================================================================

/**
 * @typedef {'sink'|'faucet'} HubKind
 */

/**
 * Classify hub-like nodes from edge flow (`e.fromId` -> `e.toId`).
 *
 * inDeg(id)  = number of DISTINCT node ids with an edge from -> id
 * outDeg(id) = number of DISTINCT node ids id has an edge -> to
 *
 * SINK   if inDeg  >= minDegree AND inDeg  >= outDeg * ratio (outDeg may be 0)
 * FAUCET if outDeg >= minDegree AND outDeg >= inDeg  * ratio (inDeg  may be 0)
 *
 * If an address qualifies as both by the math (only possible when inDeg and
 * outDeg are close under a low ratio), the larger side wins; ties favor sink.
 * Self-loops (fromId === toId) are ignored entirely. Unclassified nodes are
 * omitted from the result.
 *
 * @param {import('./graphStore.js').NodeRecord[]} nodes  known graph nodes (candidates, by `id`)
 * @param {import('./graphStore.js').EdgeRecord[]} edges  graph edges (fromId/toId node ids)
 * @param {{ minDegree?:number, ratio?:number }} [opts]
 * @returns {Map<string, HubKind>} node id -> 'sink' | 'faucet'
 */
export function classifyHubs(nodes, edges, opts) {
  const o = opts || {};
  const minDegree = typeof o.minDegree === "number" ? o.minDegree : 6;
  const ratio = typeof o.ratio === "number" ? o.ratio : 4;

  /** @type {Map<string, Set<string>>} node id -> distinct senders */
  const inSets = new Map();
  /** @type {Map<string, Set<string>>} node id -> distinct recipients */
  const outSets = new Map();

  for (const e of edges || []) {
    if (!e) continue;
    const from = e.fromId;
    const to = e.toId;
    if (!from || !to || from === to) continue; // ignore self-loops

    let out = outSets.get(from);
    if (!out) { out = new Set(); outSets.set(from, out); }
    out.add(to);

    let inn = inSets.get(to);
    if (!inn) { inn = new Set(); inSets.set(to, inn); }
    inn.add(from);
  }

  const ids = new Set();
  for (const n of nodes || []) {
    if (n && n.id) ids.add(n.id);
  }
  for (const a of inSets.keys()) ids.add(a);
  for (const a of outSets.keys()) ids.add(a);

  const result = new Map();
  for (const id of ids) {
    const inDeg = inSets.has(id) ? inSets.get(id).size : 0;
    const outDeg = outSets.has(id) ? outSets.get(id).size : 0;
    const isSink = inDeg >= minDegree && inDeg >= outDeg * ratio;
    const isFaucet = outDeg >= minDegree && outDeg >= inDeg * ratio;

    if (isSink && isFaucet) {
      result.set(id, inDeg >= outDeg ? "sink" : "faucet");
    } else if (isSink) {
      result.set(id, "sink");
    } else if (isFaucet) {
      result.set(id, "faucet");
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

/**
 * Whether a node should be hidden given the active hide toggles. Pure — the
 * caller (a vis DataView filter) decides what to do with the result; this
 * function never touches the store.
 * @param {HubKind|string|null|undefined} hubKind
 * @param {{ faucet?:boolean, sink?:boolean }} [hide]
 * @returns {boolean}
 */
export function shouldHideNode(hubKind, hide) {
  if (!hide) return false;
  if (hubKind === "faucet") return !!hide.faucet;
  if (hubKind === "sink") return !!hide.sink;
  return false;
}
