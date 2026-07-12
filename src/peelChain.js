// =============================================================================
// peelChain.js — pure, DOM-free "peel chain" detection. A peel chain is a
// sequence A->B->C->… where each node forwards ~the same amount it just
// received, onward to a single next hop — the classic laundering pattern where
// value hops through fresh throwaway addresses. Node-testable; no vis, no DOM.
//
// Amount basis: parses edge.amountText (nominal per-token magnitude, NOT fiat-
// normalized) — same basis as display.edgeAmountNumber.
// =============================================================================

function amt(edge) {
  const n = Number(edge && edge.amountText);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Find peel/forwarding chains.
 * @param {import('./graphStore.js').EdgeRecord[]} edges
 * @param {{ minLen?:number, keepRatio?:number, slack?:number }} [opts]
 *   minLen   minimum node count in a chain (default 3)
 *   keepRatio forwarded/received must be >= this (default 0.9)
 *   slack    forwarded may exceed received by up to this factor (default 1.1)
 * @returns {string[][]} ordered address paths
 */
export function findPeelChains(edges, opts) {
  const o = opts || {};
  const minLen = typeof o.minLen === "number" ? o.minLen : 3;
  const keepRatio = typeof o.keepRatio === "number" ? o.keepRatio : 0.9;
  const slack = typeof o.slack === "number" ? o.slack : 1.1;

  // Build out-adjacency (distinct next hops) and in-degree over distinct senders.
  const outMap = new Map(); // addr -> [{to, edge}]
  const inSet = new Map();  // addr -> Set(from)
  const outSet = new Map(); // addr -> Set(to)
  for (const e of edges || []) {
    if (!e) continue;
    const from = String(e.from || "").toLowerCase();
    const to = String(e.to || "").toLowerCase();
    if (!from || !to || from === to) continue;
    if (!outMap.has(from)) outMap.set(from, []);
    outMap.get(from).push({ to, edge: e });
    if (!outSet.has(from)) outSet.set(from, new Set());
    outSet.get(from).add(to);
    if (!inSet.has(to)) inSet.set(to, new Set());
    inSet.get(to).add(from);
  }

  const inDeg = (a) => (inSet.has(a) ? inSet.get(a).size : 0);
  const outDeg = (a) => (outSet.has(a) ? outSet.get(a).size : 0);

  // A node is a "pass-through" if it has exactly one distinct sender and one
  // distinct recipient — value came in and went straight back out.
  const isPassThrough = (a) => inDeg(a) === 1 && outDeg(a) === 1;

  const forwards = (recvEdge, sendEdge) => {
    const recv = amt(recvEdge);
    const sent = amt(sendEdge);
    if (recv <= 0) return false;
    const r = sent / recv;
    if (Number(sendEdge.timeStamp) < Number(recvEdge.timeStamp)) return false; // time must not go backward
    return r >= keepRatio && r <= slack;
  };

  const chains = [];
  const usedStarts = new Set();

  // Start from edges whose source is NOT a pass-through (chain heads).
  for (const e of edges || []) {
    if (!e) continue;
    const from = String(e.from || "").toLowerCase();
    const to = String(e.to || "").toLowerCase();
    if (!from || !to || from === to) continue;
    if (isPassThrough(from)) continue;             // not a head
    const startKey = from + ">" + to;
    if (usedStarts.has(startKey)) continue;

    const path = [from, to];
    let recvEdge = e;
    let cursor = to;
    // Extend while the next node is a pass-through that forwards ~the same amount.
    while (isPassThrough(cursor)) {
      const outs = outMap.get(cursor) || [];
      if (outs.length !== 1) break;
      const next = outs[0];
      if (!forwards(recvEdge, next.edge)) break;
      if (path.includes(next.to)) break;           // no cycles
      path.push(next.to);
      recvEdge = next.edge;
      cursor = next.to;
    }
    if (path.length >= minLen) {
      usedStarts.add(startKey);
      chains.push(path);
    }
  }
  return chains;
}
