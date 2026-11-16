import { describe, test, expect } from "bun:test";
import { findDeposits, delayParts } from "../src/depositDetect.js";

const A = (n) => "0x" + String(n).repeat(40).slice(0, 40);
const N = A(1), EX = A(2), EX2 = A(3), OTHER = A(4), SRC = A(5), USDT = A(6), NFT = A(7);
const id = (a, c = "1") => `${c}:${a}`;
const HIST = { txlist: {}, tokentx: {} }; // only the presence of an action matters
const node = (a, over = {}) => ({ id: id(a, over.chainId || "1"), chainId: "1", address: a, history: HIST, ...over });
let seq = 0;
const edge = (from, to, over = {}) => {
  const chainId = over.chainId || "1";
  return {
    key: `k${++seq}`, chainId, action: "txlist", from, to, fromId: id(from, chainId), toId: id(to, chainId),
    symbol: "ETH", tokenContract: "", value: "1000", timeStamp: "1000", ...over,
  };
};
const KNOWN = {
  "1": {
    [EX]: { label: "Binance 14 (hot wallet)", category: "exchange" },
    [EX2]: { label: "Kraken 4", category: "exchange" },
  },
};
const ctx = { known: (a, c) => KNOWN[String(c)]?.[a] || null };
const run = (nodes, edges, c = ctx) => findDeposits(nodes, edges, c);
const TOK = { action: "tokentx", symbol: "USDT", tokenContract: USDT };
const times = (k, f) => Array.from({ length: k }, f);

describe("findDeposits — positives", () => {
  test("native sweep: full evidence", () => {
    const r = run([node(N)], [edge(SRC, N, { value: "1000", timeStamp: "100" }), edge(N, EX, { value: "990", timeStamp: "700" })]);
    expect([...r.keys()]).toEqual([id(N)]);
    expect(r.get(id(N))).toEqual({
      walletId: id(EX), wallet: EX, label: "Binance 14 (hot wallet)", swept: 1, outgoing: 1,
      assets: [{ symbol: "ETH", contract: "", sharePct: 100 }], maxDelaySec: 600, timedSweeps: 1,
    });
  });

  test("token sweep: the asset is the token contract", () => {
    const r = run([node(N)], [edge(N, EX, { ...TOK, value: "5000000" })]);
    expect(r.get(id(N)).assets).toEqual([{ symbol: "USDT", contract: USDT, sharePct: 100 }]);
  });

  test("internal sweep counts only when txlistinternal was fetched", () => {
    const internal = edge(N, EX, { action: "txlistinternal" });
    expect(run([node(N, { history: { ...HIST, txlistinternal: {} } })], [internal]).get(id(N)).swept).toBe(1);
    expect(run([node(N)], [internal]).size).toBe(0);
  });
});

describe("findDeposits — each criterion", () => {
  test("unfetched: needs both txlist and tokentx history", () => {
    for (const history of [undefined, { txlist: {} }, { tokentx: {} }]) {
      expect(run([node(N, { history })], [edge(N, EX)]).size).toBe(0);
    }
  });

  test("a known entity is never judged", () => {
    const c = { known: (a, chainId) => (a === N ? { label: "Router", category: "router" } : ctx.known(a, chainId)) };
    expect(run([node(N)], [edge(N, EX)], c).size).toBe(0);
  });

  test("two different exchange wallets: silent", () => {
    expect(run([node(N)], [edge(N, EX), edge(N, EX2)]).size).toBe(0);
  });

  test("count share: 9 of 10 passes, 8 of 10 fails", () => {
    const outs = (k) => [...times(k, () => edge(N, EX, { value: "100" })), ...times(10 - k, () => edge(N, OTHER, { value: "1" }))];
    expect(run([node(N)], outs(9)).get(id(N))).toMatchObject({ swept: 9, outgoing: 10 });
    expect(run([node(N)], outs(8)).size).toBe(0);
  });

  test("value share: 90% passes, 89% fails", () => {
    const mk = (sweeps, other) => [...sweeps.map((value) => edge(N, EX, { value })), edge(N, OTHER, { value: other })];
    expect(run([node(N)], mk(times(9, () => "10"), "10")).get(id(N)).assets[0].sharePct).toBe(90);
    expect(run([node(N)], mk([...times(8, () => "10"), "9"], "11")).size).toBe(0);
  });

  test("value share is per asset; an asset never swept is not value-judged", () => {
    const r = run([node(N)], [...times(9, () => edge(N, EX, { ...TOK, value: "10" })), edge(N, OTHER, { value: "1000000" })]);
    expect(r.get(id(N))).toMatchObject({ swept: 9, outgoing: 10, assets: [{ symbol: "USDT", contract: USDT, sharePct: 100 }] });
  });

  test("NFT edges are ignored", () => {
    const h = { ...HIST, tokennfttx: {} };
    const nft = { action: "tokennfttx", tokenContract: NFT, value: "1" };
    expect(run([node(N, { history: h })], [edge(N, EX), edge(N, OTHER, nft)]).get(id(N)).outgoing).toBe(1);
    expect(run([node(N, { history: h })], [edge(N, EX, nft)]).size).toBe(0);
  });

  test("zero-value and unparseable values are skipped (never throw)", () => {
    const junk = ["0", "", "-5", "1.5", "0x10", "abc", undefined, null, true, 7].map((value) => edge(N, OTHER, { value }));
    expect(run([node(N)], [edge(N, EX), ...junk]).get(id(N)).outgoing).toBe(1);
    expect(run([node(N)], [edge(N, EX, { value: "0" })]).size).toBe(0);
  });

  test("ignoreEdge drops edges (imitation / spam tokens)", () => {
    const fake = edge(N, OTHER, { action: "tokentx", symbol: "USDT", tokenContract: A(8) });
    expect(run([node(N)], [edge(N, EX), fake]).size).toBe(0);
    expect(run([node(N)], [edge(N, EX), fake], { ...ctx, ignoreEdge: (e) => e === fake }).get(id(N)).outgoing).toBe(1);
  });

  test("self-loops are not outflows", () => {
    expect(run([node(N)], [edge(N, EX), edge(N, N, { value: "5" })]).get(id(N)).outgoing).toBe(1);
  });
});

describe("findDeposits — math", () => {
  test("share is floored: 999 of 1000 shows 99", () => {
    const r = run([node(N)], [...times(9, () => edge(N, EX, { value: "111" })), edge(N, OTHER, { value: "1" })]);
    expect(r.get(id(N)).assets[0].sharePct).toBe(99);
  });

  test("BigInt beyond 2^53: the 90% boundary is exact", () => {
    const sweeps = () => times(9, () => edge(N, EX, { value: "1000000000000000001" }));
    expect(run([node(N)], [...sweeps(), edge(N, OTHER, { value: "1000000000000000002" })]).size).toBe(0);
    expect(run([node(N)], [...sweeps(), edge(N, OTHER, { value: "1000000000000000001" })]).get(id(N)).assets[0].sharePct).toBe(90);
  });
});

describe("findDeposits — delay", () => {
  test("latest same-asset inflow at or before each sweep; max over timed sweeps", () => {
    const r = run([node(N)], [
      edge(SRC, N, { timeStamp: "100" }),
      edge(SRC, N, { timeStamp: "400" }),
      edge(N, EX, { timeStamp: "400" }), // equal timestamp counts as prior -> 0
      edge(N, EX, { timeStamp: "1000" }), // latest prior inflow 400 -> 600
      edge(SRC, N, { timeStamp: "2000" }), // after every sweep: ignored
    ]);
    expect(r.get(id(N))).toMatchObject({ swept: 2, maxDelaySec: 600, timedSweeps: 2 });
  });

  test("delay: none, same-asset only, mixed, garbage", () => {
    // a native gas top-up never times a token sweep
    let r = run([node(N)], [edge(SRC, N, { timeStamp: "100" }), edge(N, EX, { ...TOK, timeStamp: "200" })]);
    expect(r.get(id(N))).toMatchObject({ maxDelaySec: null, timedSweeps: 0 });
    // one sweep timed, the other had no prior inflow
    r = run([node(N)], [edge(SRC, N, { ...TOK, timeStamp: "150" }), edge(N, EX, { ...TOK, timeStamp: "100" }), edge(N, EX, { ...TOK, timeStamp: "200" })]);
    expect(r.get(id(N))).toMatchObject({ swept: 2, maxDelaySec: 50, timedSweeps: 1 });
    // missing / garbage timestamps never time a sweep
    r = run([node(N)], [edge(SRC, N, { timeStamp: "" }), edge(N, EX, { timeStamp: "abc" })]);
    expect(r.get(id(N))).toMatchObject({ maxDelaySec: null, timedSweeps: 0 });
    // a zero-value (poisoning) inflow never times a sweep
    r = run([node(N)], [edge(SRC, N, { value: "0", timeStamp: "100" }), edge(N, EX, { timeStamp: "200" })]);
    expect(r.get(id(N))).toMatchObject({ maxDelaySec: null, timedSweeps: 0 });
  });
});

describe("findDeposits — scope", () => {
  test("chain isolation: same address on two chains, exchange known only on chain 1", () => {
    const r = run(
      [node(N), node(N, { chainId: "56" })],
      [edge(N, EX), edge(N, EX, { chainId: "56" }), edge(N, OTHER, { chainId: "56" }), edge(N, OTHER, { chainId: "56" })],
    );
    expect([...r.keys()]).toEqual([id(N)]);
    expect(r.get(id(N)).outgoing).toBe(1);
  });

  test("no exchange-bound outflow, empty input or no known() -> empty map", () => {
    expect(run([node(N)], [edge(N, OTHER)]).size).toBe(0);
    expect(findDeposits([], [], ctx).size).toBe(0);
    expect(findDeposits(undefined, undefined, ctx).size).toBe(0);
    expect(findDeposits([node(N)], [edge(N, EX)], {}).size).toBe(0);
  });
});

test("delayParts rounds up into minutes / hours / days, minimum 1", () => {
  expect(delayParts(0)).toEqual({ key: "duration.m", params: { n: 1 } });
  expect(delayParts(600)).toEqual({ key: "duration.m", params: { n: 10 } });
  expect(delayParts(3599)).toEqual({ key: "duration.m", params: { n: 60 } });
  expect(delayParts(3600)).toEqual({ key: "duration.h", params: { n: 1 } });
  expect(delayParts(5400)).toEqual({ key: "duration.h", params: { n: 2 } });
  expect(delayParts(86400)).toEqual({ key: "duration.d", params: { n: 1 } });
  expect(delayParts(90000)).toEqual({ key: "duration.d", params: { n: 2 } });
});
