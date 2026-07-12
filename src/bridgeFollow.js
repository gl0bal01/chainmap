// =============================================================================
// bridgeFollow.js — pure, DOM-free bridge-follow logic. Detects fund exits into
// known lock-mint bridges and correlates candidate releases on the destination
// chain. NO graphStore, NO vis, NO DOM. Confidence is always a candidate label,
// never "confirmed". Node-testable.
// =============================================================================

import { isValidAddress, lc } from "./format.js";
import { bridgeInfo } from "./bridgeRegistry.js";

function argByName(args, name) {
  const a = (args || []).find((x) => x && x.name === name);
  return a ? a.value : null;
}

/**
 * Find fund exits into known bridges among a set of edges.
 * @param {import('./graphStore.js').EdgeRecord[]} edges
 * @param {import('./bridgeRegistry.js').BridgeData} registry
 * @param {number|string} chainId  chain the edges belong to
 * @returns {Array<{bridgeAddr:string,name:string,kind:string,destChains:number[],
 *   amountText:string,symbol:string,timeStamp:string,depositor:string,recipient:string,hash:string}>}
 */
export function findBridgeExits(edges, registry, chainId) {
  const out = [];
  if (!registry || !Array.isArray(edges)) return out;
  for (const e of edges) {
    if (!e) continue;
    const to = lc(e.to);
    const entry = bridgeInfo(to, chainId, registry);
    if (!entry) continue;
    const depositor = lc(e.from);
    const decoded = argByName(e.methodArgs, "recipient");
    const recipient = decoded && isValidAddress(decoded) ? lc(decoded) : depositor;
    out.push({
      bridgeAddr: to,
      name: entry.name,
      kind: entry.kind,
      destChains: entry.destChains || [],
      amountText: e.amountText || "",
      symbol: e.symbol || "",
      timeStamp: e.timeStamp || "",
      depositor,
      recipient,
      hash: e.hash || "",
    });
  }
  return out;
}
