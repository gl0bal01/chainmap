import { test, expect } from "bun:test";
import { loadKnownAddresses, knownLabel, knownCategory } from "../src/knownAddresses.js";

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
