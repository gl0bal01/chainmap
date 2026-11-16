import { test, expect } from "bun:test";
import { edgeAmountNumber, isSpam, passesFilters, filtersActive, edgeWidth, bundleEdges, ageColor, parseSpamList } from "../src/display.js";

const edge = (over) => ({ amountText: "1", symbol: "ETH", tokenContract: "", ...over });

test("edgeAmountNumber parses amountText, bad -> 0", () => {
  expect(edgeAmountNumber(edge({ amountText: "2.5" }))).toBe(2.5);
  expect(edgeAmountNumber(edge({ amountText: "" }))).toBe(0);
  expect(edgeAmountNumber(edge({ amountText: "abc" }))).toBe(0);
  expect(edgeAmountNumber(edge({ amountText: undefined }))).toBe(0);
});

test("isSpam matches by contract or symbol (lowercased)", () => {
  const opts = { spamContractsFor: () => new Set(["0xabc"]), spamSymbols: new Set(["scam"]) };
  expect(isSpam(edge({ tokenContract: "0xABC" }), opts)).toBe(true);
  expect(isSpam(edge({ symbol: "SCAM" }), opts)).toBe(true);
  expect(isSpam(edge({ symbol: "USDC", tokenContract: "0x1" }), opts)).toBe(false);
});

test("passesFilters: hideZero, minAmount, hideSpam", () => {
  expect(passesFilters(edge({ amountText: "0" }), { hideZero: true })).toBe(false);
  expect(passesFilters(edge({ amountText: "0" }), { hideZero: false })).toBe(true);
  expect(passesFilters(edge({ amountText: "0.4" }), { minAmount: 1 })).toBe(false);
  expect(passesFilters(edge({ amountText: "1.4" }), { minAmount: 1 })).toBe(true);
  const spam = { hideSpam: true, spamSymbols: new Set(["junk"]) };
  expect(passesFilters(edge({ symbol: "JUNK" }), spam)).toBe(false);
  expect(passesFilters(edge({ symbol: "ETH" }), spam)).toBe(true);
  expect(passesFilters(edge(), {})).toBe(true); // no filters -> visible
});

test("filtersActive reflects engaged filters", () => {
  expect(filtersActive({})).toBe(false);
  expect(filtersActive({ minAmount: 0, hideZero: false, hideSpam: false })).toBe(false);
  expect(filtersActive({ minAmount: 2 })).toBe(true);
  expect(filtersActive({ hideZero: true })).toBe(true);
  expect(filtersActive({ hideSpam: true })).toBe(true);
});

test("edgeWidth: sqrt-scaled [1,8], uniform when no max", () => {
  expect(edgeWidth(5, 0)).toBe(1);
  expect(edgeWidth(5, -1)).toBe(1);
  expect(edgeWidth(0, 100)).toBe(1);
  expect(edgeWidth(100, 100)).toBe(8);
  expect(edgeWidth(25, 100)).toBeCloseTo(1 + 0.5 * 7, 5); // ratio .25 -> sqrt .5
  expect(edgeWidth(200, 100)).toBe(8); // clamped
});

test("ageColor: neutral on unknown/single, hue shifts old->recent", () => {
  const neutral = ageColor(0, 0, 0);
  expect(neutral).toContain("hsl(215"); // neutral gray for unknown / single-ts
  expect(ageColor(NaN, 100, 200)).toBe(neutral);
  const old = ageColor(100, 100, 200); // oldest -> hue 210 (blue)
  const recent = ageColor(200, 100, 200); // newest -> hue 30 (amber)
  expect(old).toBe("hsl(210, 72%, 42%)");
  expect(recent).toBe("hsl(30, 72%, 68%)");
});

test("bundleEdges: collapses same from|to|contract|symbol, keeps member keys", () => {
  const edges = [
    { key: "k1", from: "0xa", to: "0xb", fromId: "1:0xa", toId: "1:0xb", symbol: "ETH", tokenContract: "", color: "#1", group: "normal", amountText: "1" },
    { key: "k2", from: "0xa", to: "0xb", fromId: "1:0xa", toId: "1:0xb", symbol: "ETH", tokenContract: "", color: "#1", group: "normal", amountText: "2" },
    { key: "k3", from: "0xa", to: "0xb", fromId: "1:0xa", toId: "1:0xb", symbol: "USDC", tokenContract: "0xc", color: "#2", group: "token", amountText: "5" },
    { key: "k4", from: "0xa", to: "0xz", fromId: "1:0xa", toId: "1:0xz", symbol: "ETH", tokenContract: "", color: "#1", group: "normal", amountText: "9" },
  ];
  const bundles = bundleEdges(edges);
  expect(bundles.length).toBe(3); // (a->b ETH), (a->b USDC), (a->z ETH)
  const ab = bundles.find((b) => b.from === "0xa" && b.to === "0xb" && b.symbol === "ETH");
  expect(ab.count).toBe(2);
  expect(ab.total).toBe(3);
  expect(ab.totalText).toBe("3");
  expect(ab.memberKeys).toEqual(["k1", "k2"]); // per-tx keys preserved for detail/CSV
});

test("hideSpam also hides edges the isFakeToken predicate flags", () => {
  const fake = (e) => e.symbol === "USDT";
  expect(passesFilters(edge({ symbol: "USDT" }), { hideSpam: true, isFakeToken: fake })).toBe(false);
  expect(passesFilters(edge({ symbol: "USDT" }), { hideSpam: false, isFakeToken: fake })).toBe(true);
  expect(passesFilters(edge({ symbol: "USDC" }), { hideSpam: true, isFakeToken: fake })).toBe(true);
  expect(passesFilters(edge({ symbol: "USDT" }), { hideSpam: true })).toBe(true);
});

test("parseSpamList: legacy array = '*', per-chain contracts, global symbols", () => {
  const legacy = parseSpamList(["0xAbC", "SCAM"]);
  expect(legacy.contractsFor("1").has("0xabc")).toBe(true);
  expect(legacy.contractsFor(56).has("0xabc")).toBe(true);
  expect(legacy.symbols.has("scam")).toBe(true);
  const keyed = parseSpamList({ "*": ["0xaaa"], "56": ["0xBBB", "Junk"] });
  expect([...keyed.contractsFor("56")].sort()).toEqual(["0xaaa", "0xbbb"]);
  expect([...keyed.contractsFor("1")]).toEqual(["0xaaa"]);
  expect(keyed.symbols.has("junk")).toBe(true);
});

test("parseSpamList: malformed input yields empty sets, never throws", () => {
  for (const bad of [null, undefined, 42, "x", { "1": "0xnotarray" }, { "1": [null, 7, {}] }]) {
    const p = parseSpamList(bad);
    expect(p.contractsFor("1").size).toBe(0);
    expect(p.symbols.size).toBe(0);
  }
});

test("bundles are per chain: native ETH X→Y on Ethereum and on Arbitrum are two bundles", () => {
  const mk = (key, chainId) => ({ key, chainId, from: "0xa", to: "0xb", fromId: `${chainId}:0xa`, toId: `${chainId}:0xb`, symbol: "ETH", tokenContract: "", color: "#1", group: "normal", amountText: "1" });
  expect(bundleEdges([mk("k1", "1"), mk("k2", "42161")]).map((b) => [b.chainId, b.fromId, b.toId, b.from, b.count]))
    .toEqual([["1", "1:0xa", "1:0xb", "0xa", 1], ["42161", "42161:0xa", "42161:0xb", "0xa", 1]]);
});

test("isSpam scopes spam contracts to the edge's chain", () => {
  const spamContractsFor = (c) => new Set(c === "137" ? ["0xd"] : []);
  expect(isSpam(edge({ chainId: "137", tokenContract: "0xD" }), { spamContractsFor })).toBe(true);
  expect(isSpam(edge({ chainId: "1", tokenContract: "0xd" }), { spamContractsFor })).toBe(false);
});

test("hiddenChains hides that chain's edges only and engages filtersActive", () => {
  const hiddenChains = new Set(["42161"]);
  expect(passesFilters(edge({ chainId: "42161" }), { hiddenChains })).toBe(false);
  expect(passesFilters(edge({ chainId: "1" }), { hiddenChains })).toBe(true);
  expect(filtersActive({ hiddenChains })).toBe(true);
  expect(filtersActive({ hiddenChains: new Set() })).toBe(false);
});
