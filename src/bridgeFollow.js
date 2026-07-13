// =============================================================================
// bridgeFollow.js — pure, DOM-free bridge-follow logic. Detects fund exits into
// known lock-mint bridges and correlates candidate releases on the destination
// chain. NO graphStore, NO vis, NO DOM. Confidence is always a candidate label,
// never "confirmed". Node-testable.
// =============================================================================

import { isValidAddress, lc, formatUnits } from "./format.js";
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
    const paramName = entry.recipientParam || "recipient";
    const decoded = argByName(e.methodArgs, paramName);
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

const RANK = { exact: 0, "amount+time": 1, weak: 2 };

/**
 * Correlate candidate dest-chain releases to a bridge exit. Pure; candidates are
 * pre-normalized (see Task 4 orchestrator). Never asserts a match — every result
 * carries a candidate confidence.
 * @param {{recipient:string,amountText:string,timeStamp:string}} exit
 * @param {Array<{to:string,timeStamp:string,amountText:string,hash:string,symbol:string}>} candidates
 * @param {{windowSecs?:number,exactTol?:number,looseTol?:number}} [opts]
 * @returns {Array<{hash:string,to:string,symbol:string,confidence:'exact'|'amount+time'|'weak',
 *   matched:{recipient:boolean,amountDelta:number|null,timeDeltaSecs:number}}>}
 */
export function matchReleases(exit, candidates, opts) {
  const o = opts || {};
  const windowSecs = typeof o.windowSecs === "number" ? o.windowSecs : 86400;
  const exactTol = typeof o.exactTol === "number" ? o.exactTol : 0.005;
  const looseTol = typeof o.looseTol === "number" ? o.looseTol : 0.05;
  if (!exit || !Array.isArray(candidates)) return [];
  const recipient = lc(exit.recipient);
  if (!recipient) return [];
  const exitTs = Number(exit.timeStamp);
  const exitAmt = Number(exit.amountText);
  const out = [];
  for (const c of candidates) {
    if (!c || lc(c.to) !== recipient) continue;
    const ts = Number(c.timeStamp);
    if (!Number.isFinite(ts) || !Number.isFinite(exitTs)) continue;
    const dt = ts - exitTs;
    if (dt < 0 || dt > windowSecs) continue; // forward time, within window
    const candAmt = Number(c.amountText);
    let confidence = "weak";
    let amountDelta = null;
    if (Number.isFinite(candAmt) && Number.isFinite(exitAmt) && exitAmt > 0) {
      amountDelta = Math.abs(candAmt - exitAmt) / exitAmt;
      confidence = amountDelta <= exactTol ? "exact" : amountDelta <= looseTol ? "amount+time" : "weak";
    }
    out.push({ hash: c.hash, to: recipient, symbol: c.symbol || "", confidence,
      matched: { recipient: true, amountDelta, timeDeltaSecs: dt } });
  }
  out.sort((a, b) => (RANK[a.confidence] - RANK[b.confidence]) || (a.matched.timeDeltaSecs - b.matched.timeDeltaSecs));
  return out;
}

/**
 * Normalize a raw Etherscan tx into a matchReleases candidate. Native txs
 * (no tokenDecimal) use 18 decimals; token txs use the tx's tokenDecimal.
 * @param {Record<string,string>} tx
 * @returns {{to:string,timeStamp:string,amountText:string,hash:string,symbol:string}}
 */
function normalizeTx(tx) {
  const dec = tx.tokenDecimal != null && tx.tokenDecimal !== "" ? tx.tokenDecimal : 18;
  const amt = formatUnits(tx.value, dec);
  return {
    to: lc(tx.to),
    timeStamp: tx.timeStamp || "",
    amountText: amt.indeterminate ? "indeterminate" : amt.text,
    hash: tx.hash || "",
    symbol: tx.tokenSymbol || "",
  };
}

/**
 * Scan the destination chain for candidate releases of a bridge exit. Sets the
 * client to the dest chain, fetches the recipient's recent inbound native +
 * ERC-20 txs (sampled "latest N", desc), normalizes, and correlates. Never
 * throws — resolves [] on any fetch failure so callers can invoke it defensively.
 * Restores the client's chain id in a `finally` (on success AND on error), so a
 * client shared with the rest of the app is safe to pass in — it is left exactly
 * as it was found. Backward-compatible: if the injected client has no
 * `getChainId` (e.g. a minimal test fake), the restore is skipped rather than
 * throwing.
 * @param {{client:any, limiter:{run:(fn:()=>Promise<any>)=>Promise<any>},
 *   exit:any, destChainId:number, offset?:number, windowSecs?:number, signal?:any}} args
 * @returns {Promise<any[]>}
 */
export async function followBridgeExit(args) {
  const { client, limiter, exit, destChainId, offset = 25, windowSecs, signal } = args || {};
  if (!client || !exit || !exit.recipient) return [];
  const prevChainId = typeof client.getChainId === "function" ? client.getChainId() : null;
  try {
    client.setChainId(destChainId);
    const actions = ["txlist", "txlistinternal", "tokentx"];
    const raw = [];
    for (const action of actions) {
      const txs = await limiter.run(() =>
        client.fetchAction(exit.recipient, action, { offset, sort: "desc", signal })
      );
      if (Array.isArray(txs)) raw.push(...txs);
    }
    const candidates = raw.map(normalizeTx);
    return matchReleases(exit, candidates, windowSecs ? { windowSecs } : undefined);
  } catch {
    return [];
  } finally {
    if (prevChainId != null) client.setChainId(prevChainId);
  }
}
