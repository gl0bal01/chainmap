import { test, expect } from "bun:test";
import { loadKnownAddresses, knownLabel, knownCategory, chainsForKnownAddress } from "../src/knownAddresses.js";

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
