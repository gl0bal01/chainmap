import { test, expect } from "bun:test";
import { edgeAmountNumber, isSpam, passesFilters, filtersActive, edgeWidth, bundleEdges, ageColor } from "../src/display.js";

const edge = (over) => ({ amountText: "1", symbol: "ETH", tokenContract: "", ...over });

test("edgeAmountNumber parses amountText, bad -> 0", () => {
  expect(edgeAmountNumber(edge({ amountText: "2.5" }))).toBe(2.5);
  expect(edgeAmountNumber(edge({ amountText: "" }))).toBe(0);
  expect(edgeAmountNumber(edge({ amountText: "abc" }))).toBe(0);
  expect(edgeAmountNumber(edge({ amountText: undefined }))).toBe(0);
});

test("isSpam matches by contract or symbol (lowercased)", () => {
  const opts = { spamContracts: new Set(["0xabc"]), spamSymbols: new Set(["scam"]) };
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
    { key: "k1", from: "0xa", to: "0xb", symbol: "ETH", tokenContract: "", color: "#1", group: "normal", amountText: "1" },
    { key: "k2", from: "0xa", to: "0xb", symbol: "ETH", tokenContract: "", color: "#1", group: "normal", amountText: "2" },
    { key: "k3", from: "0xa", to: "0xb", symbol: "USDC", tokenContract: "0xc", color: "#2", group: "token", amountText: "5" },
    { key: "k4", from: "0xa", to: "0xz", symbol: "ETH", tokenContract: "", color: "#1", group: "normal", amountText: "9" },
  ];
  const bundles = bundleEdges(edges);
  expect(bundles.length).toBe(3); // (a->b ETH), (a->b USDC), (a->z ETH)
  const ab = bundles.find((b) => b.from === "0xa" && b.to === "0xb" && b.symbol === "ETH");
  expect(ab.count).toBe(2);
  expect(ab.total).toBe(3);
  expect(ab.totalText).toBe("3");
  expect(ab.memberKeys).toEqual(["k1", "k2"]); // per-tx keys preserved for detail/CSV
});
