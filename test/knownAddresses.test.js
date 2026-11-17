import { test, expect } from "bun:test";
import { knownEntry, loadKnownAddresses, knownLabel, knownCategory, chainsForKnownAddress, isAllChainEntry } from "../src/knownAddresses.js";

const DATA = {
  "1": {
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": { label: "WETH", category: "contract" },
  },
};
const fakeFetch = (ok, body) => async () => ({ ok, json: async () => body });

test("knownLabel: chain-scoped, case-insensitive, null on miss", () => {
  expect(knownLabel("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", 1, DATA)).toBe("WETH");
  expect(knownLabel("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", "1", DATA)).toBe("WETH");
  expect(knownLabel("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", 137, DATA)).toBeNull(); // other chain
  expect(knownLabel("0x0000000000000000000000000000000000000001", 1, DATA)).toBeNull();
  expect(knownLabel("0xabc", 1, null)).toBeNull();
});

test("loadKnownAddresses returns data on ok, {} on failure (never throws)", async () => {
  expect(await loadKnownAddresses(fakeFetch(true, DATA))).toEqual(DATA);
  expect(await loadKnownAddresses(fakeFetch(false, DATA))).toEqual({});
  expect(await loadKnownAddresses(async () => { throw new Error("network"); })).toEqual({});
  expect(await loadKnownAddresses(fakeFetch(true, "not-an-object"))).toEqual({});
});

const CAT_DATA = { "1": { "0xabc0000000000000000000000000000000000001": { label: "Tornado", category: "mixer" } } };

test("knownCategory returns category for known addr, null otherwise", () => {
  expect(knownCategory("0xABC0000000000000000000000000000000000001", 1, CAT_DATA)).toBe("mixer");
  expect(knownCategory("0x0000000000000000000000000000000000000009", 1, CAT_DATA)).toBeNull();
  expect(knownCategory("0xabc0000000000000000000000000000000000001", 137, CAT_DATA)).toBeNull();
  expect(knownLabel("0xabc0000000000000000000000000000000000001", 1, CAT_DATA)).toBe("Tornado");
});

const MULTI_DATA = {
  "1": { "0xabc0000000000000000000000000000000000001": { label: "Tornado Cash", category: "mixer" } },
  "56": { "0xabc0000000000000000000000000000000000001": { label: "Tornado Cash (BSC)", category: "mixer" } },
  "137": { "0x0000000000000000000000000000000000000002": { label: "Other", category: "exchange" } },
};

test("chainsForKnownAddress: single hit has correct chainId (number)/label/category", () => {
  const hits = chainsForKnownAddress("0xabc0000000000000000000000000000000000001", CAT_DATA);
  expect(hits).toEqual([{ chainId: 1, label: "Tornado", category: "mixer" }]);
  expect(hits[0].chainId).toBe(1);
  expect(typeof hits[0].chainId).toBe("number");
});

test("chainsForKnownAddress: address present on two chains returns both hits", () => {
  const hits = chainsForKnownAddress("0xabc0000000000000000000000000000000000001", MULTI_DATA);
  expect(hits).toHaveLength(2);
  expect(hits).toEqual([
    { chainId: 1, label: "Tornado Cash", category: "mixer" },
    { chainId: 56, label: "Tornado Cash (BSC)", category: "mixer" },
  ]);
});

test("chainsForKnownAddress: unknown address returns []", () => {
  expect(chainsForKnownAddress("0x0000000000000000000000000000000000000009", MULTI_DATA)).toEqual([]);
});

test("chainsForKnownAddress: case-insensitive (uppercase input matches lowercased key)", () => {
  const hits = chainsForKnownAddress("0xABC0000000000000000000000000000000000001", CAT_DATA);
  expect(hits).toEqual([{ chainId: 1, label: "Tornado", category: "mixer" }]);
});

test("chainsForKnownAddress: null/empty data or address returns []", () => {
  expect(chainsForKnownAddress("0xabc0000000000000000000000000000000000001", null)).toEqual([]);
  expect(chainsForKnownAddress("0xabc0000000000000000000000000000000000001", {})).toEqual([]);
  expect(chainsForKnownAddress("", CAT_DATA)).toEqual([]);
  expect(chainsForKnownAddress(null, CAT_DATA)).toEqual([]);
});

const EXT_DATA = {
  "1": {
    "0xabc0000000000000000000000000000000000001": {
      label: "Tornado Cash: 100 ETH",
      category: "mixer",
      source: "OFAC SDN 2022-08-08",
      added: "2026-07-12",
    },
  },
};

test("extended records (source/added) still resolve label/category and chains", () => {
  expect(knownLabel("0xABC0000000000000000000000000000000000001", 1, EXT_DATA)).toBe("Tornado Cash: 100 ETH");
  expect(knownCategory("0xabc0000000000000000000000000000000000001", 1, EXT_DATA)).toBe("mixer");
  expect(chainsForKnownAddress("0xabc0000000000000000000000000000000000001", EXT_DATA)).toEqual([
    { chainId: 1, label: "Tornado Cash: 100 ETH", category: "mixer" },
  ]);
});

const S = "0x098b716b8aaf21512996dc57eb0615e2383e2f96";
const STAR = {
  "*": { [S]: { label: "LAZARUS GROUP (OFAC SDN)", category: "sanctioned", source: "OFAC SDN list, published 2026-11-13", added: "2026-11-13" } },
  "1": { [S]: { label: "Ronin Exploiter (OFAC SDN)", category: "sanctioned", source: "https://example.org/a", added: "2026-07-12" } },
};

test("knownEntry: chain-specific beats '*', '*' answers any other chain, null on miss", () => {
  expect(knownEntry(S.toUpperCase().replace("0X", "0x"), 1, STAR).label).toBe("Ronin Exploiter (OFAC SDN)");
  expect(knownEntry(S, "137", STAR).label).toBe("LAZARUS GROUP (OFAC SDN)");
  expect(knownEntry("0x0000000000000000000000000000000000000009", 1, STAR)).toBeNull();
  expect(knownEntry(S, 1, null)).toBeNull();
  expect(knownEntry("constructor", 1, { "1": {} })).toBeNull(); // inherited keys never match
});

test("knownLabel / knownCategory fall back to '*'", () => {
  expect(knownLabel(S, 56, STAR)).toBe("LAZARUS GROUP (OFAC SDN)");
  expect(knownCategory(S, 56, STAR)).toBe("sanctioned");
});

test("chainsForKnownAddress: chain-specific first, then one '*' item", () => {
  expect(chainsForKnownAddress(S, STAR)).toEqual([
    { chainId: 1, label: "Ronin Exploiter (OFAC SDN)", category: "sanctioned" },
    { chainId: "*", label: "LAZARUS GROUP (OFAC SDN)", category: "sanctioned" },
  ]);
});

test("isAllChainEntry is true only when the '*' bucket answers", () => {
  expect(isAllChainEntry(S, "1", STAR)).toBe(false);
  expect(isAllChainEntry(S, "137", STAR)).toBe(true);
  expect(isAllChainEntry("0x" + "9".repeat(40), "137", STAR)).toBe(false);
});

test("Tron never takes the \"*\" bucket; EVM chains still do; a Tron-specific row applies", async () => {
  const { TRON_CHAIN_ID } = await import("../src/tron.js");
  const E = { label: "Everywhere", category: "exchange" };
  const hex = "d1c4bb7b2f39aba5707711719b2236b5b605af2e";
  const data = { "*": { ["0x" + hex]: E, ["41" + hex]: E } };
  expect(knownEntry("41" + hex, TRON_CHAIN_ID, data)).toBeNull();
  expect(isAllChainEntry("41" + hex, TRON_CHAIN_ID, data)).toBe(false);
  expect(knownEntry("41" + hex, "1", data)).toBe(E);
  const own = { label: "Tron own", category: "exchange" };
  expect(knownEntry("41" + hex, TRON_CHAIN_ID, { ...data, [TRON_CHAIN_ID]: { ["41" + hex]: own } })).toBe(own);
});
