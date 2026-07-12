import { test, expect, describe } from "bun:test";
import { findBridgeExits } from "../src/bridgeFollow.js";

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
