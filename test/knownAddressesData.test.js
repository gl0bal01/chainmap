import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import knownData from "../data/known-addresses.json";
import { KNOWN_CATEGORIES } from "../src/config.js";
import { isValidAddress, lc } from "../src/format.js";

describe("data/known-addresses.json validity", () => {
  test("top level is an object keyed by numeric chain-id strings", () => {
    expect(knownData && typeof knownData).toBe("object");
    for (const chainId of Object.keys(knownData)) {
      expect(String(Number(chainId))).toBe(chainId); // "1" ok, "0x1"/"eth" not
      expect(typeof knownData[chainId]).toBe("object");
    }
  });

  test("every address key is lowercased and a valid address", () => {
    for (const chainId of Object.keys(knownData)) {
      for (const addr of Object.keys(knownData[chainId])) {
        expect(addr).toBe(lc(addr));
        expect(isValidAddress(addr)).toBe(true);
      }
    }
  });

  test("every entry has a non-empty label and a category in KNOWN_CATEGORIES", () => {
    for (const chainId of Object.keys(knownData)) {
      for (const [addr, entry] of Object.entries(knownData[chainId])) {
        expect(typeof entry.label).toBe("string");
        expect(entry.label.trim().length).toBeGreaterThan(0);
        expect(KNOWN_CATEGORIES).toContain(entry.category); // fails loudly on a typo/new category
      }
    }
  });

  test("optional source/added, when present, are non-empty strings", () => {
    for (const chainId of Object.keys(knownData)) {
      for (const entry of Object.values(knownData[chainId])) {
        if ("source" in entry) {
          expect(typeof entry.source).toBe("string");
          expect(entry.source.trim().length).toBeGreaterThan(0);
        }
        if ("added" in entry) {
          expect(typeof entry.added).toBe("string");
          expect(entry.added.trim().length).toBeGreaterThan(0);
        }
      }
    }
  });

  test("no duplicate address key within a chain (catches literal dup keys JSON.parse would collapse)", () => {
    const raw = readFileSync(new URL("../data/known-addresses.json", import.meta.url), "utf8");
    // Each address present in the parsed data must appear in the RAW text exactly
    // as many times as the number of chains that contain it. A literal duplicate
    // key inside one chain (which JSON.parse silently collapses to one) pushes the
    // raw count above that expected number and fails here. Multi-chain legit repeats
    // (same address on chains 1 and 56) are counted correctly.
    const expected = new Map(); // addr -> number of chains that contain it
    for (const chainId of Object.keys(knownData)) {
      for (const addr of Object.keys(knownData[chainId])) {
        expected.set(addr, (expected.get(addr) || 0) + 1);
      }
    }
    for (const [addr, exp] of expected) {
      const re = new RegExp('"' + addr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"\\s*:', "g");
      const actual = (raw.match(re) || []).length;
      expect(actual).toBe(exp);
    }
  });
});
