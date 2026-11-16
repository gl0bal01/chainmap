import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import knownData from "../data/known-addresses.json";
import curated from "../data/sources/curated.json";
import { KNOWN_CATEGORIES, CHAINS } from "../src/config.js";
import { isValidAddress, lc } from "../src/format.js";

describe("data/known-addresses.json validity", () => {
  const CHAIN_KEYS = new Set(["*", ...CHAINS.map((c) => String(c.id))]);

  test("top level keys are '*' or a supported chain id", () => {
    for (const chainId of Object.keys(knownData)) {
      expect(CHAIN_KEYS.has(chainId)).toBe(true);
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

  test("every entry has a non-empty source and an ISO added date", () => {
    for (const chain of Object.values(knownData)) {
      for (const entry of Object.values(chain)) {
        expect(typeof entry.source).toBe("string");
        expect(entry.source.trim().length).toBeGreaterThan(0);
        expect(entry.added).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  test("token entries carry an uppercase symbol and integer decimals", () => {
    for (const chain of Object.values(knownData)) {
      for (const entry of Object.values(chain)) {
        if (entry.category !== "token") continue;
        expect(typeof entry.symbol).toBe("string");
        expect(entry.symbol.length).toBeGreaterThan(0);
        expect(entry.symbol).toBe(entry.symbol.toUpperCase());
        expect(Number.isInteger(entry.decimals)).toBe(true);
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

const BLOCKED_HOSTS = [...CHAINS.map((c) => c.explorer), "arkhamintelligence.com", "arkm.com", "nansen.ai"];

test("curated seed never asserts 'sanctioned' (sanctions come only from the OFAC import)", () => {
  expect(Array.isArray(curated)).toBe(true);
  expect(curated.filter((r) => r.category === "sanctioned")).toEqual([]);
});

// Every "sanctioned" entry must trace to ONE OFAC import: "*" entries carry the
// generator's exact source (single publish date); chain entries need a "*" twin
// and end their source with the same snapshot date.
const OFAC_SOURCE = /^OFAC SDN list, published (\d{4}-\d{2}-\d{2})$/;
const OFAC_SUFFIX = /; OFAC SDN list, published (\d{4}-\d{2}-\d{2})$/;
function ofacProvenanceProblems(data) {
  const star = data["*"] || {};
  const problems = [], dates = new Set();
  if (!Object.values(star).some((e) => e.category === "sanctioned")) problems.push("no '*' sanctioned entries");
  for (const [chainId, chain] of Object.entries(data)) {
    for (const [addr, e] of Object.entries(chain)) {
      const at = `${chainId}:${addr}`;
      if (e.label.endsWith(" (OFAC SDN)") && e.category !== "sanctioned") problems.push(`${at} OFAC label, category ${e.category}`);
      if (e.category !== "sanctioned") continue;
      if (!e.label.endsWith(" (OFAC SDN)")) problems.push(`${at} label lacks (OFAC SDN)`);
      if (chainId === "*") {
        const m = OFAC_SOURCE.exec(e.source);
        if (m) dates.add(m[1]);
        else problems.push(`${at} source not the OFAC import: ${e.source}`);
      } else {
        if (star[addr]?.category !== "sanctioned") problems.push(`${at} sanctioned without a '*' OFAC entry`);
        const m = OFAC_SUFFIX.exec(e.source);
        if (m) dates.add(m[1]);
        else problems.push(`${at} source lacks the OFAC snapshot date`);
      }
    }
  }
  if (dates.size > 1) problems.push(`OFAC sources span ${dates.size} publish dates`);
  return problems;
}

test("OFAC import is present under '*', and every 'sanctioned' entry traces to it", () => {
  expect(ofacProvenanceProblems(knownData)).toEqual([]);
});

test("OFAC provenance check rejects hand-edited sanctions", () => {
  const A = "0x" + "ab".repeat(20), B = "0x" + "cd".repeat(20);
  const ofac = (date) => ({ label: "X (OFAC SDN)", category: "sanctioned", source: `OFAC SDN list, published ${date}`, added: date });
  expect(ofacProvenanceProblems({ "*": { [A]: ofac("2026-11-13") } })).toEqual([]);
  expect(ofacProvenanceProblems({ "*": { [A]: { ...ofac("2026-11-13"), source: "some blog" } } })).toEqual([`*:${A} source not the OFAC import: some blog`]);
  expect(ofacProvenanceProblems({ "*": { [A]: ofac("2026-11-13"), [B]: ofac("2025-01-01") } })).toEqual(["OFAC sources span 2 publish dates"]);
  expect(ofacProvenanceProblems({ "*": { [A]: ofac("2026-11-13") }, 1: { [B]: { ...ofac("2026-11-13"), source: "x" } } })).toEqual([`1:${B} sanctioned without a '*' OFAC entry`, `1:${B} source lacks the OFAC snapshot date`]);
  const chainRow = (source) => ({ "*": { [A]: ofac("2026-11-13") }, 1: { [A]: { ...ofac("2026-11-13"), source } } });
  expect(ofacProvenanceProblems(chainRow("https://x; OFAC SDN list, published 2026-11-13"))).toEqual([]);
  expect(ofacProvenanceProblems(chainRow("https://x"))).toEqual([`1:${A} source lacks the OFAC snapshot date`]);
  expect(ofacProvenanceProblems(chainRow("https://x; OFAC SDN list, published 2025-01-01"))).toEqual(["OFAC sources span 2 publish dates"]);
  expect(ofacProvenanceProblems({ "*": { [A]: ofac("2026-11-13") }, 1: { [B]: { ...ofac("2026-11-13"), category: "other" } } })).toEqual([`1:${B} OFAC label, category other`]);
  expect(ofacProvenanceProblems({ "*": { [A]: { ...ofac("2026-11-13"), label: "X" } } })).toEqual([`*:${A} label lacks (OFAC SDN)`]);
});

test("no source URL points at an explorer label cloud / Arkham / Nansen", () => {
  for (const chain of Object.values(knownData)) {
    for (const e of Object.values(chain)) {
      if (!/^https?:\/\//i.test(e.source)) continue;
      const host = new URL(e.source).hostname;
      expect(BLOCKED_HOSTS.some((b) => host === b || host.endsWith("." + b))).toBe(false);
    }
  }
});
