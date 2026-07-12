import { test, expect, describe } from "bun:test";
import { findBridgeExits, matchReleases } from "../src/bridgeFollow.js";

const REG = {
  "1": {
    "0xbbbb000000000000000000000000000000000001": { name: "Test Bridge", kind: "lock-mint", destChains: [137] },
    "0xbbbb000000000000000000000000000000000002": { name: "LP Bridge", kind: "liquidity", destChains: [10] },
  },
};

const edge = (o) => ({
  from: "0xdead000000000000000000000000000000000001",
  to: "0xbbbb000000000000000000000000000000000001",
  amountText: "50", symbol: "ETH", timeStamp: "1700000000", hash: "0xh1",
  methodId: "", methodArgs: [], ...o,
});

describe("findBridgeExits", () => {
  test("detects a lock-mint bridge edge; recipient defaults to depositor", () => {
    const exits = findBridgeExits([edge({})], REG, 1);
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({
      bridgeAddr: "0xbbbb000000000000000000000000000000000001",
      name: "Test Bridge", kind: "lock-mint", destChains: [137],
      amountText: "50", symbol: "ETH", timeStamp: "1700000000",
      depositor: "0xdead000000000000000000000000000000000001",
      recipient: "0xdead000000000000000000000000000000000001", // defaults to depositor
      hash: "0xh1",
    });
  });

  test("uses a decoded recipient arg (by name) when present and valid", () => {
    const exits = findBridgeExits([edge({
      methodArgs: [{ type: "address", value: "0xFEED000000000000000000000000000000000009", name: "recipient" }],
    })], REG, 1);
    expect(exits[0].recipient).toBe("0xfeed000000000000000000000000000000000009"); // lowercased
  });

  test("liquidity bridge is returned but tagged kind:liquidity", () => {
    const exits = findBridgeExits([edge({ to: "0xbbbb000000000000000000000000000000000002" })], REG, 1);
    expect(exits[0].kind).toBe("liquidity");
  });

  test("ignores edges whose 'to' is not a registered bridge, and other chains", () => {
    expect(findBridgeExits([edge({ to: "0x0000000000000000000000000000000000000009" })], REG, 1)).toEqual([]);
    expect(findBridgeExits([edge({})], REG, 137)).toEqual([]);
    expect(findBridgeExits([], REG, 1)).toEqual([]);
    expect(findBridgeExits([edge({})], null, 1)).toEqual([]);
  });

  test("does not mutate its inputs (pure over plain edge arrays)", () => {
    const edges = [edge({})];
    const snapshot = JSON.stringify(edges);
    findBridgeExits(edges, REG, 1);
    expect(JSON.stringify(edges)).toBe(snapshot);
  });
});

const EXIT = {
  recipient: "0xfeed000000000000000000000000000000000009",
  amountText: "50", timeStamp: "1700000000",
};
const cand = (o) => ({ to: "0xfeed000000000000000000000000000000000009", timeStamp: "1700000600", amountText: "50", hash: "0xr", symbol: "WETH", ...o });

describe("matchReleases", () => {
  test("recipient + forward-time + tight amount => exact, sorted first", () => {
    const r = matchReleases(EXIT, [cand({})]);
    expect(r).toHaveLength(1);
    expect(r[0].confidence).toBe("exact");
    expect(r[0].matched.recipient).toBe(true);
    expect(r[0].matched.timeDeltaSecs).toBe(600);
  });

  test("excludes wrong recipient, and releases before the exit (time must move forward)", () => {
    expect(matchReleases(EXIT, [cand({ to: "0x0000000000000000000000000000000000000001" })])).toEqual([]);
    expect(matchReleases(EXIT, [cand({ timeStamp: "1699999999" })])).toEqual([]);
  });

  test("excludes releases outside the time window", () => {
    expect(matchReleases(EXIT, [cand({ timeStamp: String(1700000000 + 90000) })], { windowSecs: 86400 })).toEqual([]);
  });

  test("loose amount => amount+time; indeterminate amount => weak", () => {
    expect(matchReleases(EXIT, [cand({ amountText: "49" })])[0].confidence).toBe("amount+time"); // ~2% off
    expect(matchReleases(EXIT, [cand({ amountText: "indeterminate" })])[0].confidence).toBe("weak");
  });

  test("orders exact before amount+time before weak", () => {
    const r = matchReleases(EXIT, [
      cand({ amountText: "indeterminate", hash: "0xw" }),
      cand({ amountText: "49", hash: "0xa" }),
      cand({ amountText: "50", hash: "0xe" }),
    ]);
    expect(r.map((x) => x.hash)).toEqual(["0xe", "0xa", "0xw"]);
  });
});
