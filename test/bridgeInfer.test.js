import { describe, test, expect } from "bun:test";
import { inferBridges, sanitizeBridgeDecisions } from "../src/bridgeInfer.js";
import { LIMITS } from "../src/config.js";
import { GraphStore } from "../src/graphStore.js";
import { tronRows, TRON_CHAIN_ID } from "../src/tron.js";
import { readFileSync } from "node:fs";

const A = (n) => "0x" + String(n).repeat(40).slice(0, 40);
const ZERO = A(0), USER = A(1), BRIDGE = A(2), L2BRIDGE = A(3), RECIP = A(4), OTHER = A(5), WETH = A(6), USDC1 = A(7), USDC137 = A(8), EXCH = A(9), BRIDGE2 = A(23), SANC = A(24);
const KNOWN = {
  "1": {
    [BRIDGE]: { label: "RootChainManager", category: "bridge" },
    [BRIDGE2]: { label: "ERC20 gateway", category: "bridge" },
    [USDC1]: { label: "USD Coin", category: "token", symbol: "USDC" },
    [EXCH]: { label: "Binance 14", category: "exchange" },
    [SANC]: { label: "Ronin exploiter", category: "sanctioned" },
  },
  "137": {
    [L2BRIDGE]: { label: "Polygon L2 bridge", category: "bridge" },
    [WETH]: { label: "WETH (PoS)", category: "token", symbol: "WETH" },
    [USDC137]: { label: "USDC (PoS)", category: "token", symbol: "USDC" },
  },
  "42161": { [WETH]: { label: "WETH (Arbitrum)", category: "token", symbol: "WETH" } },
};
const NATIVE = { "1": "ETH", "137": "POL", "42161": "ETH" };
const ctx = {
  known: (a, c) => KNOWN[String(c)]?.[a] || null,
  ignoreEdge: () => false,
  trustedToken: (contract, c) => KNOWN[String(c)]?.[contract]?.category === "token",
  nativeSymbol: (c) => NATIVE[String(c)] || null,
};
const T = 1_700_000_000;
const ETH20 = "20000000000000000000";
const w = (v) => (String(v).startsWith("0x") ? String(v).slice(2) : BigInt(v).toString(16)).padStart(64, "0");
const call = (sel, ...args) => sel + args.map(w).join("");
let seq = 0;
const edge = (chainId, from, to, over = {}) => {
  const n = ++seq;
  const action = over.action || "txlist";
  const hash = over.hash || `0x${n}`;
  return {
    key: `${chainId}|${action}|${hash}|${from}|${to}|${over.tokenContract || ""}||${n}`,
    chainId, action, from, to, fromId: `${chainId}:${from}`, toId: `${chainId}:${to}`, hash,
    symbol: NATIVE[chainId] || "", tokenContract: "", tokenDecimal: "", value: ETH20,
    timeStamp: String(T), blockNumber: "100", rawInput: "", methodArgs: [], ...over,
  };
};
const deposit = (over = {}) => edge("1", USER, BRIDGE, { rawInput: call("0x4faa8a26", RECIP), ...over }); // depositEtherFor(RECIP)
const mint = (over = {}) => edge("137", ZERO, RECIP, { action: "tokentx", symbol: "WETH", tokenContract: WETH, tokenDecimal: "18", timeStamp: String(T + 1800), ...over });
const DONE = { oldestBlock: "0", blockPage: 0, pageSize: 0, done: true, count: 1 };
const ALL = { txlist: DONE, txlistinternal: DONE, tokentx: DONE };
const node = (chainId, address, history) => ({ id: `${chainId}:${address}`, chainId, address, depth: 1, isRoot: false, alias: null, ...(history ? { history } : {}) });
const recip = (history = ALL, chainId = "137") => node(chainId, RECIP, history);
const run = (edges, nodes = [recip()], c = ctx) => inferBridges(nodes, edges, c);
const only = (r) => { expect(r.candidates.length).toBe(1); return r.candidates[0]; };

describe("deposits", () => {
  test("native deposit with a decoded recipient: full record, no candidate without a release", () => {
    const d = deposit();
    const r = run([d]);
    expect([...r.deposits.keys()]).toEqual([d.key]);
    expect(r.deposits.get(d.key)).toEqual({
      key: d.key, chainId: "1", from: USER, fromId: `1:${USER}`, bridge: BRIDGE, bridgeLabel: "RootChainManager",
      hash: d.hash, timeStamp: T, value: ETH20, decimals: 18, asset: "ETH",
      recipient: RECIP, basis: "calldata", destChainId: null,
    });
    expect(r.candidates).toEqual([]);
  });

  test("token deposit uses the curated symbol; an internal deposit keeps the contract as depositor (ruling 5)", () => {
    const tok = edge("1", USER, BRIDGE, { action: "tokentx", symbol: "FAKE", tokenContract: USDC1, tokenDecimal: "6", value: "5000000" });
    const int = edge("1", OTHER, BRIDGE, { action: "txlistinternal" });
    const r = run([tok, int]);
    expect(r.deposits.get(tok.key)).toMatchObject({ asset: "USDC", decimals: 6, recipient: USER, basis: "sender" });
    expect(r.deposits.get(int.key)).toMatchObject({ from: OTHER, asset: "ETH", recipient: OTHER, basis: "sender" });
  });

  test("not deposits: NFT, zero/unparseable value, unknown decimals, ignored, bridge plumbing, zero-address sender, non-bridge target", () => {
    const ign = deposit();
    const bad = [
      deposit({ action: "tokennfttx", tokenContract: USDC1, tokenDecimal: "0", value: "1" }),
      ...["0", "", "1.5", "-5", "0x10", undefined, 7].map((value) => deposit({ value })),
      edge("1", USER, BRIDGE, { action: "tokentx", tokenContract: USDC1, tokenDecimal: "", value: "5" }),
      edge("1", BRIDGE2, BRIDGE),
      edge("1", ZERO, BRIDGE, { action: "tokentx", tokenContract: USDC1, tokenDecimal: "6" }),
      edge("1", USER, OTHER),
    ];
    expect(run([...bad, ign], [], { ...ctx, ignoreEdge: (e) => e === ign }).deposits.size).toBe(0);
  });
});

describe("recipient", () => {
  test("calldata from a same-hash txlist call into a known bridge, for a token deposit", () => {
    const c = edge("1", USER, BRIDGE, { hash: "0xt1", value: "0", rawInput: call("0x01e4f53a", RECIP, 5000000) }); // relayTokens(address,uint256)
    const tok = edge("1", USER, BRIDGE2, { hash: "0xt1", action: "tokentx", tokenContract: USDC1, tokenDecimal: "6", value: "5000000" });
    const r = run([c, tok]);
    expect([...r.deposits.keys()]).toEqual([tok.key]); // the zero-value call itself is not a deposit
    expect(r.deposits.get(tok.key)).toMatchObject({ recipient: RECIP, basis: "calldata" });
  });

  test("never from stored methodArgs, a `recipient` arg, a zero/short decode, another sender or a non-bridge target", () => {
    const cases = [
      deposit({ rawInput: "", methodArgs: [{ type: "address", value: RECIP, name: "destRecipient" }] }),
      deposit({ rawInput: call("0xa9059cbb", RECIP, 1) }), // transfer(recipient, amount)
      deposit({ rawInput: call("0x4faa8a26", ZERO) }),
      deposit({ rawInput: "0x4faa8a26" }),
      deposit({ rawInput: "0x4faa8a26" + "zz".repeat(32) }),
    ];
    for (const d of cases) expect(run([d]).deposits.get(d.key)).toMatchObject({ recipient: USER, basis: "sender", destChainId: null });
    for (const [h, from, to] of [["0xt2", USER, OTHER], ["0xt3", OTHER, BRIDGE]]) {
      const c = edge("1", from, to, { hash: h, value: "0", rawInput: call("0x4faa8a26", RECIP) });
      const tok = edge("1", USER, BRIDGE, { hash: h, action: "tokentx", tokenContract: USDC1, tokenDecimal: "6", value: "5" });
      expect(run([c, tok]).deposits.get(tok.key)).toMatchObject({ recipient: USER, basis: "sender" });
    }
  });

  test("a known depositor without calldata has no recipient and no candidate", () => {
    const d = edge("1", EXCH, BRIDGE);
    const r = run([d, mint({ to: EXCH, toId: `137:${EXCH}` })], [node("137", EXCH, ALL)]);
    expect(r.deposits.get(d.key)).toMatchObject({ recipient: null, basis: null });
    expect(r.candidates).toEqual([]);
  });

  test("ruling 6: only an exchange/router/mixer/token depositor gets no recipient; sanctioned, burn or other gets the sender basis", () => {
    const d = edge("1", SANC, BRIDGE);
    const r = run([d, mint({ to: SANC, toId: `137:${SANC}` })], [node("137", SANC, ALL)]);
    expect(r.deposits.get(d.key)).toMatchObject({ recipient: SANC, basis: "sender" });
    expect(only(r)).toMatchObject({ basis: "sender", sender: "mint", level: "medium" });
    const as = (category) => ({ ...ctx, known: (a, c) => (a === OTHER && String(c) === "1" ? { label: "x", category } : ctx.known(a, c)) });
    const o = edge("1", OTHER, BRIDGE);
    for (const cat of ["exchange", "router", "mixer", "token"]) expect(run([o], [], as(cat)).deposits.get(o.key)).toMatchObject({ recipient: null, basis: null });
    for (const cat of ["sanctioned", "burn", "other"]) expect(run([o], [], as(cat)).deposits.get(o.key)).toMatchObject({ recipient: OTHER, basis: "sender" });
  });

  test("destChainId: kept when a CHAINS id; a release on another chain is no candidate", () => {
    const v3 = (chain) => call("0x7b939232", USER, RECIP, USDC1, USDC137, 5000000, 4990000, chain, ZERO, 0, 0, 0, 384);
    const d = deposit({ rawInput: v3(42161) });
    const arb = edge("42161", OTHER, RECIP, { action: "txlistinternal", timeStamp: String(T + 60) });
    const r = run([d, mint(), arb], [recip(), recip(ALL, "42161")]);
    expect(r.deposits.get(d.key).destChainId).toBe("42161");
    expect(r.candidates.map((c) => c.releaseKey)).toEqual([arb.key]);
    const odd = deposit({ rawInput: v3(999999) });
    expect(run([odd]).deposits.get(odd.key).destChainId).toBeNull();
  });
});

describe("candidate filters", () => {
  test("same chain, other address, self-transfer, NFT, zero value, unknown decimals, ignored: no candidate", () => {
    const d = deposit();
    const nope = [
      edge("1", OTHER, RECIP, { timeStamp: String(T + 60) }),
      mint({ to: OTHER, toId: `137:${OTHER}` }),
      edge("137", RECIP, RECIP, { action: "tokentx", symbol: "WETH", tokenContract: WETH, tokenDecimal: "18", timeStamp: String(T + 60) }),
      mint({ action: "tokennfttx" }),
      mint({ value: "0" }),
      mint({ tokenDecimal: "" }),
    ];
    expect(run([d, ...nope]).candidates).toEqual([]);
    const ign = mint();
    expect(run([d, ign], undefined, { ...ctx, ignoreEdge: (e) => e === ign }).candidates).toEqual([]);
  });

  test("timing: 0 s and exactly 14 d qualify; before, after 14 d or garbage do not", () => {
    for (const dt of [0, 14 * 86400]) expect(only(run([deposit(), mint({ timeStamp: String(T + dt) })])).delaySec).toBe(dt);
    for (const ts of [String(T - 1), String(T + 14 * 86400 + 1), "", "abc", "1e9"]) {
      expect(run([deposit(), mint({ timeStamp: ts })]).candidates).toEqual([]);
    }
  });

  test("amount: exact BigInt cross-multiplication, 6 vs 18 decimals beyond 2^53", () => {
    const d = edge("1", USER, BRIDGE, { action: "tokentx", symbol: "USDC", tokenContract: USDC1, tokenDecimal: "6", value: "9007199254740993" });
    const rel = (value) => edge("137", L2BRIDGE, USER, { action: "tokentx", symbol: "USDC", tokenContract: USDC137, tokenDecimal: "18", value, timeStamp: String(T + 60) });
    const users = [node("137", USER, ALL)];
    expect(only(run([d, rel("9007199254740993000000000000")], users))).toMatchObject({ amount: "equal", feeBps: 0 });
    expect(run([d, rel("9007199254740993000000000001")], users).candidates).toEqual([]);
    expect(only(run([d, rel("9007199254740992999999999999")], users))).toMatchObject({ amount: "fee", feeBps: 0 });
  });

  test("fee: 3.00 % qualifies, 3.01 % and a larger release do not", () => {
    const d = deposit({ value: "10000" });
    const rel = (value) => edge("42161", OTHER, RECIP, { action: "txlistinternal", value, timeStamp: String(T + 60) });
    const nodes = [recip(ALL, "42161")];
    expect(only(run([d, rel("9700")], nodes))).toMatchObject({ amount: "fee", feeBps: 300 });
    expect(only(run([d, rel("9701")], nodes))).toMatchObject({ amount: "fee", feeBps: 299 });
    expect(only(run([d, rel("10000")], nodes))).toMatchObject({ amount: "equal", feeBps: 0 });
    for (const v of ["9699", "10001"]) expect(run([d, rel(v)], nodes).candidates).toEqual([]);
  });

  test("asset: ETH↔WETH both ways; any other symbol pair never", () => {
    expect(only(run([deposit(), mint()])).amount).toBe("equal");
    const back = edge("137", USER, L2BRIDGE, { action: "tokentx", symbol: "WETH", tokenContract: WETH, tokenDecimal: "18" });
    const eth1 = edge("1", BRIDGE, USER, { action: "txlistinternal", timeStamp: String(T + 3600) });
    expect(only(run([back, eth1], [node("1", USER, ALL)]))).toMatchObject({ amount: "equal", sender: "bridge" });
    for (const over of [{ symbol: "USDT", tokenContract: OTHER }, { symbol: "WPOL", tokenContract: OTHER }]) {
      expect(run([deposit(), mint(over)]).candidates).toEqual([]);
    }
    expect(run([deposit(), edge("137", OTHER, RECIP, { timeStamp: String(T + 60) })]).candidates).toEqual([]); // native POL
  });

  test("asset: the unwrapped side must be the native of its own edge's chain (ruling 8)", () => {
    const tok = (chainId, from, to, symbol, over = {}) => edge(chainId, from, to, { action: "tokentx", symbol, tokenContract: OTHER, tokenDecimal: "18", ...over });
    const dep = (chainId, symbol) => tok(chainId, USER, chainId === "1" ? BRIDGE : L2BRIDGE, symbol);
    const rel = (chainId, symbol) => tok(chainId, OTHER, USER, symbol, { timeStamp: String(T + 60) });
    const users = [node("1", USER, ALL), node("137", USER, ALL)];
    expect(run([dep("1", "WETH"), rel("137", "ETH")], users).candidates).toEqual([]); // ETH is not Polygon's native
    expect(run([dep("1", "POL"), rel("137", "WPOL")], users).candidates).toEqual([]); // POL is not Ethereum's native
    const pol = edge("137", USER, L2BRIDGE, { symbol: "POL" });
    expect(only(run([pol, rel("1", "WPOL")], users))).toMatchObject({ amount: "equal", trusted: false, level: "low" });
  });
});

describe("factors and levels", () => {
  test("high: decoded recipient, mint of a curated token, equal, unique, covered — full candidate", () => {
    const d = deposit(), r = mint();
    expect(run([d, r]).candidates).toEqual([{
      id: `${d.key}>${r.key}`, depositKey: d.key, releaseKey: r.key, a: `1:${USER}`, b: `137:${RECIP}`,
      delaySec: 1800, amount: "equal", feeBps: 0, sender: "mint", senderLabel: null, basis: "calldata",
      trusted: true, forDeposit: 1, forRelease: 1, covered: true, level: "high",
    }]);
  });

  test("release sender: a known bridge on the release chain; a mint only for tokentx from 0x0; else other", () => {
    expect(only(run([deposit(), mint({ from: L2BRIDGE, fromId: `137:${L2BRIDGE}` })]))).toMatchObject({ sender: "bridge", senderLabel: "Polygon L2 bridge", level: "high" });
    const z = edge("42161", ZERO, RECIP, { action: "txlistinternal", timeStamp: String(T + 60) });
    expect(only(run([deposit(), z], [recip(ALL, "42161")]))).toMatchObject({ sender: "other", senderLabel: null, level: "medium" });
  });

  test("caps: fee → medium; untrusted asset → low; depositor fallback alone → low, with a mint → medium", () => {
    expect(only(run([deposit(), mint({ value: "19900000000000000000" })]))).toMatchObject({ amount: "fee", feeBps: 50, level: "medium" });
    expect(only(run([deposit(), mint({ tokenContract: OTHER })]))).toMatchObject({ trusted: false, level: "low" });
    const uc = edge("1", USER, BRIDGE, { hash: "0xu1", value: "0", rawInput: call("0x4faa8a26", RECIP) });
    const ud = edge("1", USER, BRIDGE, { hash: "0xu1", action: "tokentx", symbol: "WETH", tokenContract: OTHER, tokenDecimal: "18" });
    expect(only(run([uc, ud, mint()]))).toMatchObject({ basis: "calldata", sender: "mint", trusted: false, level: "low" }); // untrusted deposit side
    const plain = deposit({ rawInput: "" });
    const toUser = (over = {}) => edge("137", OTHER, USER, { action: "tokentx", symbol: "WETH", tokenContract: WETH, tokenDecimal: "18", timeStamp: String(T + 60), ...over });
    const users = [node("137", USER, ALL)];
    expect(only(run([plain, toUser()], users))).toMatchObject({ basis: "sender", sender: "other", level: "low" });
    expect(only(run([plain, toUser({ from: ZERO, fromId: `137:${ZERO}` })], users))).toMatchObject({ sender: "mint", level: "medium" });
  });

  test("ambiguity on either side keeps every candidate low; counts are distinct transactions", () => {
    const d = deposit();
    expect(run([d, mint(), mint({ timeStamp: String(T + 3600) })]).candidates.map((c) => [c.forDeposit, c.forRelease, c.level]))
      .toEqual([[2, 1, "low"], [2, 1, "low"]]);
    expect(run([d, deposit({ timeStamp: String(T + 60) }), mint()]).candidates.map((c) => [c.forDeposit, c.forRelease, c.level]))
      .toEqual([[1, 2, "low"], [1, 2, "low"]]);
  });

  test("one candidate per release transaction: the smallest edge key wins (ruling 3)", () => {
    const x = mint({ hash: "0xr", key: "137|tokentx|0xr|b" }), y = mint({ hash: "0xr", key: "137|tokentx|0xr|a" });
    expect(only(run([deposit(), x, y]))).toMatchObject({ releaseKey: "137|tokentx|0xr|a", forDeposit: 1, forRelease: 1, level: "high" });
  });

  test("covered: the recipient's own sample must reach back to the deposit for every arrival action", () => {
    const d = deposit(), r = mint();
    const cov = (nodes, extra = []) => only(run([d, r, ...extra], nodes)).covered;
    const MORE = { oldestBlock: "50", blockPage: 0, pageSize: 0, done: false, count: 20 };
    const old = (blockNumber) => edge("137", OTHER, RECIP, { action: "tokentx", symbol: "X", tokenContract: OTHER, tokenDecimal: "18", value: "1", timeStamp: String(T - 10), blockNumber });
    expect(cov([])).toBe(false);
    expect(cov([recip({ txlist: DONE, txlistinternal: DONE })])).toBe(false);
    expect(cov([recip({ tokentx: DONE })])).toBe(true);
    expect(cov([recip({ tokentx: MORE })])).toBe(false);
    expect(cov([recip({ tokentx: MORE })], [old("50")])).toBe(true);
    expect(cov([recip({ tokentx: MORE })], [old("49")])).toBe(false); // outside its own window (spec ruling 7)
    const oldTx = edge("137", OTHER, RECIP, { value: "1", timeStamp: String(T - 10), blockNumber: "60" }); // txlist, in window
    expect(cov([recip({ tokentx: MORE })], [oldTx])).toBe(false); // an edge of another action never covers tokentx
    expect(only(run([d, r], [recip({ tokentx: MORE })])).level).toBe("low");
    const n = edge("42161", OTHER, RECIP, { action: "txlistinternal", timeStamp: String(T + 60) });
    expect(only(run([d, n], [recip({ txlist: DONE }, "42161")])).covered).toBe(false);
    expect(only(run([d, n], [recip({ txlist: DONE, txlistinternal: DONE }, "42161")])).covered).toBe(false); // tokentx too: a WETH release could hide there
    expect(only(run([d, n], [recip(ALL, "42161")])).covered).toBe(true);
  });

  test("covered: the deposit's asset sets the required actions, whatever kind the found release is (ETH ↔ WETH)", () => {
    const wethArb = (over = {}) => edge("42161", ZERO, RECIP, { action: "tokentx", symbol: "WETH", tokenContract: WETH, tokenDecimal: "18", timeStamp: String(T + 1800), ...over });
    const native = edge("42161", OTHER, RECIP, { action: "txlistinternal", timeStamp: String(T + 60) });
    const tokenOnly = [recip({ tokentx: DONE }, "42161")];
    // An ETH deposit: native ETH on Arbitrum could also be its release, and native history was never fetched.
    expect(only(run([deposit(), wethArb()], tokenOnly))).toMatchObject({ covered: false, level: "low" });
    expect(run([deposit(), wethArb(), native], tokenOnly).candidates.map((c) => c.level)).toEqual(["low", "low"]);
    expect(only(run([deposit(), wethArb()], [recip(ALL, "42161")]))).toMatchObject({ covered: true, level: "high" });
    // A WETH deposit (W-pair with Arbitrum's native ETH) needs the native actions too.
    const wc = edge("1", USER, BRIDGE, { hash: "0xw1", value: "0", rawInput: call("0x4faa8a26", RECIP) });
    const wd = edge("1", USER, BRIDGE, { hash: "0xw1", action: "tokentx", symbol: "WETH", tokenContract: OTHER, tokenDecimal: "18" });
    expect(only(run([wc, wd, wethArb()], tokenOnly)).covered).toBe(false);
    expect(only(run([wc, wd, wethArb()], [recip(ALL, "42161")])).covered).toBe(true);
    // An asset no native release can match (ETH → Polygon, native POL) needs tokentx only.
    expect(only(run([deposit(), mint()], [recip({ tokentx: DONE })])).covered).toBe(true);
  });

  test("covered: an edge in the boundary block `oldestBlock` proves only a deposit strictly after it (same-second boundary)", () => {
    const d = deposit(), r = mint();
    const MORE = { oldestBlock: "50", blockPage: 0, pageSize: 0, done: false, count: 20 };
    const at = (blockNumber, ts) => edge("137", OTHER, RECIP, { action: "tokentx", symbol: "X", tokenContract: OTHER, tokenDecimal: "18", value: "1", timeStamp: String(ts), blockNumber });
    const cov = (x) => only(run([d, r, x], [recip({ tokentx: MORE })])).covered;
    expect(cov(at("50", T))).toBe(false); // block 50 may be partly fetched: a same-second release could hide in it
    expect(cov(at("50", T - 1))).toBe(true);
    expect(cov(at("51", T))).toBe(true); // a later block is fully fetched
    expect(cov(at("51", T + 1))).toBe(false);
  });

  test("covered is indexed once per node, never rescanned per candidate (hub: 100×100 equal pairs + 3,000 other edges)", () => {
    const MORE = { oldestBlock: "50", blockPage: 0, pageSize: 0, done: false, count: 20 };
    const deps = Array.from({ length: 100 }, (_, i) => deposit({ timeStamp: String(T + i) }));
    const rels = Array.from({ length: 100 }, (_, i) => mint({ timeStamp: String(T + 3600 + i) }));
    let reads = 0;
    const others = Array.from({ length: 3000 }, (_, i) => {
      const e = edge("137", OTHER, RECIP, { action: "tokentx", symbol: "X", tokenContract: OTHER, tokenDecimal: "18", value: "1", timeStamp: String(T + 90000 + i) });
      delete e.blockNumber;
      Object.defineProperty(e, "blockNumber", { enumerable: true, get() { if (++reads > 3000) throw new Error("recipient edges rescanned per candidate"); return "60"; } });
      return e;
    });
    const r = run([...deps, ...rels, ...others], [recip({ tokentx: MORE })]);
    expect(r.candidates.length).toBe(10000);
    expect(r.candidates.every((c) => !c.covered && c.level === "low")).toBe(true);
    expect(reads).toBeLessThanOrEqual(3000);
  });

  test("level is always low|medium|high; inputs are never mutated", () => {
    const edges = [deposit(), deposit({ rawInput: "" }), mint(), mint({ value: "19900000000000000000" }), mint({ tokenContract: OTHER }),
      edge("42161", ZERO, RECIP, { action: "txlistinternal", timeStamp: String(T + 60) })];
    const nodes = [recip(), recip({ txlist: DONE }, "42161")];
    const before = structuredClone({ edges, nodes });
    const r = run(edges, nodes);
    expect(r.candidates.length).toBe(4);
    expect(r.candidates.every((c) => ["low", "medium", "high"].includes(c.level))).toBe(true);
    expect({ edges, nodes }).toEqual(before);
  });

  test("empty input or no ctx.known → empty result", () => {
    for (const r of [inferBridges([], [], ctx), inferBridges(undefined, undefined, ctx), inferBridges([], [deposit()], {})]) {
      expect(r.deposits.size).toBe(0);
      expect(r.candidates).toEqual([]);
    }
  });
});

describe("sanitizeBridgeDecisions", () => {
  const K1 = "1|txlist|0xd|a|b||", K2 = "137|tokentx|0xr|c|d|e|", K3 = "137|tokentx|0xs|c|d|e|";
  const has = (k) => [K1, K2, K3].includes(k);
  const item = (over = {}) => ({ deposit: K1, release: K2, decision: "confirmed", at: "2026-11-17T10:00:00Z", ...over });

  test("a valid item is rebuilt from its four fields; at normalised; id = deposit>release", () => {
    const { decisions, invalid } = sanitizeBridgeDecisions([item({ extra: 1, level: "high" })], has);
    expect(invalid).toBe(0);
    expect([...decisions]).toEqual([[`${K1}>${K2}`, { deposit: K1, release: K2, decision: "confirmed", at: "2026-11-17T10:00:00.000Z" }]]);
  });

  test("bad decision, at, key or unknown edge: dropped and counted", () => {
    const bad = [
      ...["verified", "Confirmed", "", undefined].map((decision) => item({ decision })),
      ...["2026-02-30T00:00:00Z", "yesterday", 123, "2026-11-17T10:00:00+01:00"].map((at) => item({ at })),
      item({ deposit: "txlist|0xd" }), item({ deposit: "1|" + "x".repeat(299) }), item({ release: 7 }), item({ release: "137|unknown" }),
      null, "x", [],
    ];
    const r = sanitizeBridgeDecisions([...bad, item({ decision: "rejected" })], has);
    expect(r.invalid).toBe(bad.length);
    expect([...r.decisions.values()].map((d) => d.decision)).toEqual(["rejected"]);
  });

  test("__proto__ / constructor never survive; Object.prototype untouched", () => {
    const raw = JSON.parse(`[{"__proto__":{"polluted":1},"constructor":{"x":1},"deposit":"${K1}","release":"${K2}","decision":"confirmed","at":"2026-11-17T10:00:00Z"}]`);
    expect(Object.hasOwn(raw[0], "__proto__")).toBe(true); // the forged own key is really there
    const v = [...sanitizeBridgeDecisions(raw, has).decisions.values()][0];
    expect(Object.keys(v)).toEqual(["deposit", "release", "decision", "at"]);
    expect(Object.hasOwn(v, "__proto__")).toBe(false);
    expect("polluted" in v).toBe(false);
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });

  test("cap: only LIMITS.bridgeDecisions items are read, the rest are counted invalid", () => {
    const many = Array.from({ length: LIMITS.bridgeDecisions + 3 }, (_, i) => item({ release: `137|r${i}` }));
    const r = sanitizeBridgeDecisions(many, () => true);
    expect(r.decisions.size).toBe(LIMITS.bridgeDecisions);
    expect(r.invalid).toBe(3);
    expect([...r.decisions.keys()].pop().endsWith(`r${LIMITS.bridgeDecisions - 1}`)).toBe(true);
  });

  test("duplicates: the first occurrence wins", () => {
    const r = sanitizeBridgeDecisions([item(), item({ decision: "rejected" }), item({ release: K3 })], has);
    expect([...r.decisions.values()].map((d) => [d.release, d.decision])).toEqual([[K2, "confirmed"], [K3, "confirmed"]]);
    expect(r.invalid).toBe(1);
  });

  test("non-array → empty, nothing counted", () => {
    for (const raw of [undefined, null, {}, "[]", 3]) expect(sanitizeBridgeDecisions(raw, has)).toEqual({ decisions: new Map(), invalid: 0 });
  });
});

describe("Tron is never a bridge source or release", () => {
  const TO = A(4);
  const tronEdge = (chainId, to = TO) => {
    const store = new GraphStore();
    return store.addEdge({ chainId, action: "tokentx", group: "token", color: "#000", from: row.from, to, tx: row });
  };
  const row = tronRows("tokentx", JSON.parse(readFileSync("test/fixtures/tron/trc20.json", "utf8")))[0];
  const c = { ...ctx, known: (a) => (a === TO ? { category: "bridge" } : null) };
  test("a Tron token transfer into a bridge-labelled recipient is no deposit; the same edge on chain 1 is", () => {
    expect(inferBridges([], [tronEdge(TRON_CHAIN_ID)], c).deposits.size).toBe(0);
    expect(inferBridges([], [tronEdge("1")], c).deposits.size).toBe(1);
  });
  test("a same-amount Tron edge to the recipient is never a release candidate", () => {
    const d = deposit();
    const r = run([d, tronEdge(TRON_CHAIN_ID, RECIP)], [recip()]);
    expect(r.candidates.some((x) => String(x.releaseKey).startsWith(TRON_CHAIN_ID + "|"))).toBe(false);
  });
});
