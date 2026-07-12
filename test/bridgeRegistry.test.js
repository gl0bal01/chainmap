import { test, expect, describe } from "bun:test";
import { loadBridges, bridgeInfo } from "../src/bridgeRegistry.js";
import bridgesData from "../data/bridges.json";
import { CHAINS } from "../src/config.js";
import { isValidAddress } from "../src/format.js";

const fakeFetch = (ok, body) => async () => ({ ok, json: async () => body });

describe("loadBridges", () => {
  test("returns data on ok, {} on failure (never throws)", async () => {
    const d = { "1": { "0xabc0000000000000000000000000000000000001": { name: "X", kind: "lock-mint", destChains: [137] } } };
    expect(await loadBridges(fakeFetch(true, d))).toEqual(d);
    expect(await loadBridges(fakeFetch(false, d))).toEqual({});
    expect(await loadBridges(async () => { throw new Error("net"); })).toEqual({});
    expect(await loadBridges(fakeFetch(true, "nope"))).toEqual({});
  });
});

describe("bridgeInfo", () => {
  const data = { "1": { "0xabc0000000000000000000000000000000000001": { name: "X", kind: "lock-mint", destChains: [137] } } };
  test("chain-scoped, case-insensitive lookup; null on miss", () => {
    expect(bridgeInfo("0xABC0000000000000000000000000000000000001", 1, data).name).toBe("X");
    expect(bridgeInfo("0xabc0000000000000000000000000000000000001", "1", data).kind).toBe("lock-mint");
    expect(bridgeInfo("0xabc0000000000000000000000000000000000001", 137, data)).toBeNull();
    expect(bridgeInfo("0x0000000000000000000000000000000000000009", 1, data)).toBeNull();
    expect(bridgeInfo("0xabc", 1, null)).toBeNull();
  });
});

describe("data/bridges.json validity", () => {
  const chainIds = new Set(CHAINS.map((c) => c.id));
  test("keys numeric chain-id strings; addresses lowercased+valid; kind + destChains sound", () => {
    for (const chainId of Object.keys(bridgesData)) {
      expect(String(Number(chainId))).toBe(chainId);
      for (const [addr, entry] of Object.entries(bridgesData[chainId])) {
        expect(addr).toBe(addr.toLowerCase());
        expect(isValidAddress(addr)).toBe(true);
        expect(["lock-mint", "liquidity"]).toContain(entry.kind);
        expect(Array.isArray(entry.destChains)).toBe(true);
        expect(entry.destChains.length).toBeGreaterThan(0);
        for (const dc of entry.destChains) expect(chainIds.has(dc)).toBe(true); // dest chain must be supported
        expect(typeof entry.name).toBe("string");
        expect(entry.name.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
