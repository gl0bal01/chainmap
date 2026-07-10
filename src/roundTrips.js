// =============================================================================
// roundTrips.js — pure, DOM-free cycle detection for the graph. A "round-trip"
// is value that returns to an address it already touched (A↔B, or A→B→C→A) —
// a strong layering / wash-trading signal for investigators.
//
// Uses Tarjan's strongly-connected-components: any node in an SCC of size > 1 is
// on a directed cycle; self-loops (A→A) count too. Graphs are small (bounded by
// safetyCap), so a recursive implementation is fine.
// =============================================================================

/**
 * Addresses that lie on a directed cycle (round-trip).
 * @param {import('./graphStore.js').NodeRecord[]} nodes
 * @param {import('./graphStore.js').EdgeRecord[]} edges
 * @returns {Set<string>}
 */
export function findCycleNodes(nodes, edges) {
  /** @type {Map<string,string[]>} */
  const adj = new Map();
  const ensure = (a) => {
    let list = adj.get(a);
    if (!list) { list = []; adj.set(a, list); }
    return list;
  };
  (nodes || []).forEach((n) => { if (n && n.address) ensure(n.address); });

  const result = new Set();
  (edges || []).forEach((e) => {
    if (!e || !e.from || !e.to) return;
    ensure(e.from);
    ensure(e.to);
    if (e.from === e.to) result.add(e.from); // self-loop is its own round-trip
    else ensure(e.from).push(e.to);
  });

  let index = 0;
  const idx = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];

  function strongConnect(v) {
    idx.set(v, index);
    low.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) || []) {
      if (!idx.has(w)) {
        strongConnect(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), idx.get(w)));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1) comp.forEach((a) => result.add(a));
    }
  }

  for (const v of adj.keys()) if (!idx.has(v)) strongConnect(v);
  return result;
}
