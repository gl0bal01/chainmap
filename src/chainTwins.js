// Same-address evidence across chains (pure, DOM-free).
import { nodeId } from "./format.js";

/** Per-node evidence from edges: 'eoa' (signed a top-level tx) beats 'contract'.
 *  Native-AA chains are skipped: a "signed" tx there is not key evidence. */
export function addressEvidence(edges, chainsConfig) {
  const aa = new Set(chainsConfig.filter((c) => c.nativeAA).map((c) => String(c.id)));
  const ev = new Map();
  const mark = (id, kind) => {
    if (ev.get(id) !== "eoa") ev.set(id, kind);
  };
  for (const e of edges) {
    if (aa.has(String(e.chainId))) continue;
    if (e.action === "txlist") mark(e.fromId, "eoa");
    else if (e.action === "txlistinternal") mark(e.fromId, "contract");
    if (e.tokenContract) mark(nodeId(e.chainId, e.tokenContract), "contract");
  }
  return ev;
}

/** Pairs of nodes sharing an address across chains. basis 'key' iff any twin signed. */
export function sameAddressLinks(nodes, evidence) {
  const groups = new Map();
  for (const n of nodes) {
    if (!groups.has(n.address)) groups.set(n.address, []);
    groups.get(n.address).push(n);
  }
  const out = [];
  for (const [address, g] of groups) {
    g.sort((x, y) => Number(x.chainId) - Number(y.chainId));
    const basis = g.some((n) => evidence.get(n.id) === "eoa") ? "key" : "address";
    for (let i = 0; i < g.length; i++)
      for (let j = i + 1; j < g.length; j++) out.push({ address, a: g[i].id, b: g[j].id, basis });
  }
  return out;
}
