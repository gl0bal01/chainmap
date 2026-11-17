// =============================================================================
// bridgeInfer.js — pure, DOM-free bridge-deposit detection and candidate releases.
// A value transfer into a known bridge is a deposit; a later transfer on another
// chain to the expected recipient, same asset, equal or fee-reduced amount, is a
// CANDIDATE release: a lead with its observed factors and a low/medium/high level,
// never a fact. Investigator decisions never enter here (they never change a level).
// Display projection: reads the store's nodes/edges, never mutates them. Value math
// is BigInt only.
// =============================================================================
import { decodeCall } from "./abiDecode.js";
import { decimalsFor } from "./usdPrice.js";
import { isValidAddress, parseChainId } from "./format.js";
import { CHAINS } from "./config.js";
import { units, secs } from "./depositDetect.js";

/**
 * @typedef {object} BridgeDeposit
 * @property {string} key          deposit edge key
 * @property {string} chainId
 * @property {string} from         depositor (the edge's own `from`, also for internal txs)
 * @property {string} fromId
 * @property {string} bridge       the known bridge contract
 * @property {string} bridgeLabel  its known label (address if none)
 * @property {string} hash
 * @property {number|null} timeStamp UNIX seconds; null = unusable
 * @property {string} value        raw base units
 * @property {number} decimals
 * @property {string} asset        uppercased asset symbol
 * @property {string|null} recipient expected recipient on the other side; null = none assumed
 * @property {'calldata'|'sender'|null} basis
 * @property {string|null} destChainId decoded destination chain, only when a CHAINS id
 */

/**
 * @typedef {object} BridgeCandidate
 * @property {string} id           `${depositKey}>${releaseKey}`
 * @property {string} depositKey
 * @property {string} releaseKey
 * @property {string} a            deposit.fromId
 * @property {string} b            release.toId
 * @property {number} delaySec
 * @property {'equal'|'fee'} amount
 * @property {number} feeBps       floor((d - r) * 10000 / d)
 * @property {'bridge'|'mint'|'other'} sender
 * @property {string|null} senderLabel
 * @property {'calldata'|'sender'} basis
 * @property {boolean} trusted     both assets native or a trusted token on their chain
 * @property {number} forDeposit   distinct release txs proposed for this deposit
 * @property {number} forRelease   distinct deposit txs this release tx is proposed for
 * @property {boolean} covered     the recipient's own sample reaches back to the deposit
 * @property {'low'|'medium'|'high'} level
 */

const MAX_DELAY_SEC = 14 * 86400;
const MAX_FEE_BPS = 300;
const VALUE_ACTIONS = new Set(["txlist", "txlistinternal", "tokentx"]);
const NATIVE_ACTIONS = new Set(["txlist", "txlistinternal"]);
/** Known depositors that act for others: no recipient is assumed (spec ruling 6). */
const ACTS_FOR_OTHERS = new Set(["exchange", "router", "bridge", "mixer", "token"]);
const ZERO = "0x" + "0".repeat(40);
const CHAIN_IDS = new Set(CHAINS.map((c) => String(c.id)));

/**
 * @param {import('./graphStore.js').NodeRecord[]} nodes read only for `history`
 * @param {import('./graphStore.js').EdgeRecord[]} edges
 * @param {{ known:(address:string, chainId:string)=>(import('./knownAddresses.js').KnownEntry|null),
 *           ignoreEdge?:(edge:import('./graphStore.js').EdgeRecord)=>boolean,
 *           trustedToken?:(contract:string, chainId:string)=>boolean,
 *           nativeSymbol?:(chainId:string)=>(string|null) }} ctx
 * @returns {{ deposits: Map<string, BridgeDeposit>, candidates: BridgeCandidate[] }} candidates sorted by id
 */
export function inferBridges(nodes, edges, ctx) {
  const deposits = new Map();
  const candidates = [];
  const known = ctx && ctx.known;
  if (typeof known !== "function") return { deposits, candidates };
  const ignore = ctx.ignoreEdge || (() => false);
  const trustedToken = ctx.trustedToken || (() => false);
  const nativeOf = (c) => String((ctx.nativeSymbol && ctx.nativeSymbol(c)) || "").toUpperCase();
  const cat = (a, c) => known(a, c)?.category;
  const contractOf = (e) => String(e.tokenContract || "").toLowerCase();
  const isNative = (e) => NATIVE_ACTIONS.has(e.action);
  const assetOf = (e) => {
    if (isNative(e)) return nativeOf(e.chainId);
    const k = known(contractOf(e), e.chainId);
    return String((k?.category === "token" && k.symbol) || e.symbol || "").toUpperCase();
  };
  const trusted = (e) => isNative(e) || trustedToken(contractOf(e), e.chainId);

  // One indexing pass (this runs after every graph change).
  const push = (m, k, e) => (m.get(k) || m.set(k, []).get(k)).push(e);
  const calls = new Map(); // `${chainId}|${hash}` -> txlist edges, any value
  const into = new Map(); // recipient address -> value edges
  const incident = new Map(); // node id -> edges
  const values = [];
  for (const e of edges || []) {
    if (!e) continue;
    if (e.action === "txlist" && e.hash) push(calls, `${e.chainId}|${e.hash}`, e);
    push(incident, e.fromId, e);
    if (e.toId !== e.fromId) push(incident, e.toId, e);
    if (VALUE_ACTIONS.has(e.action) && (units(e.value) ?? 0n) > 0n && decimalsFor(e) !== null && !ignore(e)) {
      values.push(e);
      push(into, e.to, e);
    }
  }
  const history = new Map();
  for (const n of nodes || []) if (n) history.set(n.id, n.history);

  // Deposits.
  const depositEdges = [];
  for (const e of values) {
    if (cat(e.to, e.chainId) !== "bridge") continue;
    const fromCat = cat(e.from, e.chainId);
    if (fromCat === "bridge" || e.from === ZERO) continue;
    let recipient = null, basis = null, destChainId = null;
    for (const c of calls.get(`${e.chainId}|${e.hash}`) || []) {
      if (c.from !== e.from || cat(c.to, c.chainId) !== "bridge") continue;
      const args = decodeCall(c.rawInput)?.args || []; // rawInput only, never stored methodArgs
      const to = args.find((x) => x.name === "destRecipient")?.value;
      if (!isValidAddress(to) || to.toLowerCase() === ZERO) continue;
      recipient = to.toLowerCase();
      basis = "calldata";
      const dc = parseChainId(args.find((x) => x.name === "destChainId")?.value);
      destChainId = CHAIN_IDS.has(dc) ? dc : null;
      break;
    }
    if (!basis && !ACTS_FOR_OTHERS.has(fromCat)) {
      recipient = e.from;
      basis = "sender";
    }
    deposits.set(e.key, {
      key: e.key, chainId: e.chainId, from: e.from, fromId: e.fromId,
      bridge: e.to, bridgeLabel: known(e.to, e.chainId)?.label || e.to,
      hash: e.hash, timeStamp: secs(e), value: e.value, decimals: decimalsFor(e), asset: assetOf(e),
      recipient, basis, destChainId,
    });
    depositEdges.push(e);
  }

  // Raw candidates, one per (deposit, release tx): the smallest release edge key (ruling 3).
  const raw = []; // { D, E, groups: Map<relTx, {R, amount, feeBps}> }
  const depsOfRelease = new Map(); // relTx -> Set<deposit tx>
  for (const E of depositEdges) {
    const D = deposits.get(E.key);
    if (!D.recipient || D.timeStamp === null) continue;
    const groups = new Map();
    for (const R of into.get(D.recipient) || []) {
      if (R.chainId === D.chainId || (D.destChainId && R.chainId !== D.destChainId) || R.from === R.to) continue;
      const t = secs(R);
      if (t === null || t < D.timeStamp || t - D.timeStamp > MAX_DELAY_SEC) continue;
      const x = D.asset, y = assetOf(R);
      if (!x || !y || !(x === y || (x === "W" + y && y === nativeOf(R.chainId)) || (y === "W" + x && x === nativeOf(D.chainId)))) continue;
      // Cross-multiply raw base units by the other side's decimals (BigInt only).
      const d = units(D.value) * 10n ** BigInt(decimalsFor(R));
      const r = units(R.value) * 10n ** BigInt(D.decimals);
      const amount = r === d ? "equal" : r < d && r * 10000n >= d * BigInt(10000 - MAX_FEE_BPS) ? "fee" : null;
      if (!amount) continue;
      const relTx = R.hash ? `${R.chainId}|${R.hash}|${R.to}` : R.key;
      const prev = groups.get(relTx);
      if (!prev || R.key < prev.R.key) groups.set(relTx, { R, t, amount, feeBps: Number(((d - r) * 10000n) / d) });
    }
    if (!groups.size) continue;
    raw.push({ D, E, groups });
    const depTx = D.hash ? `${D.chainId}|${D.hash}` : D.key;
    for (const relTx of groups.keys()) (depsOfRelease.get(relTx) || depsOfRelease.set(relTx, new Set()).get(relTx)).add(depTx);
  }

  // Factors and level.
  for (const { D, E, groups } of raw) {
    for (const [relTx, { R, t, amount, feeBps }] of groups) {
      const sender = cat(R.from, R.chainId) === "bridge" ? "bridge" : R.from === ZERO && R.action === "tokentx" ? "mint" : "other";
      const isTrusted = trusted(E) && trusted(R);
      const forDeposit = groups.size;
      const forRelease = depsOfRelease.get(relTx).size;
      // Ruling 7: every arrival action is done, or an edge of the recipient's own fetched window reaches back.
      const h = history.get(R.toId);
      const covered = !!h && (isNative(R) ? ["txlist", "txlistinternal"] : ["tokentx"]).every((a) => {
        const entry = h[a];
        if (!entry) return false;
        if (entry.done === true) return true;
        const oldest = units(entry.oldestBlock);
        return oldest !== null && (incident.get(R.toId) || []).some((x) => {
          const ts = secs(x), block = units(x.blockNumber);
          return x.action === a && ts !== null && ts <= D.timeStamp && block !== null && block >= oldest;
        });
      });
      const unique = forDeposit === 1 && forRelease === 1 && covered;
      const level = unique && isTrusted && amount === "equal" && D.basis === "calldata" && sender !== "other" ? "high"
        : unique && isTrusted && (D.basis === "calldata" || sender !== "other") ? "medium" : "low";
      candidates.push({
        id: `${D.key}>${R.key}`, depositKey: D.key, releaseKey: R.key, a: D.fromId, b: R.toId,
        delaySec: t - D.timeStamp, amount, feeBps, sender,
        senderLabel: sender === "bridge" ? known(R.from, R.chainId)?.label || null : null,
        basis: D.basis, trusted: isTrusted, forDeposit, forRelease, covered, level,
      });
    }
  }
  candidates.sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  return { deposits, candidates };
}
