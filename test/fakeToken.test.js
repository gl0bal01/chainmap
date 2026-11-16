import { test, expect } from "bun:test";
import { normalizeSymbol, buildCanonicalIndex, isFakeToken } from "../src/fakeToken.js";

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const P_USDC = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
const P_USDCE = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
const OTHER = "0x" + "e".repeat(40);
const tok = (o) => ({ label: "t", category: "token", source: "https://e", added: "2026-11-16", ...o });
const DATA = {
  "*": { ["0x" + "f".repeat(40)]: tok({ symbol: "DAI" }) },
  "1": { [USDC]: tok({ symbol: "USDC" }), [USDT]: tok({ symbol: "USDT" }), ["0x7a250d5630b4cf539739df2c5dacb4c659f2488d"]: { label: "r", category: "router", source: "x", added: "2026-11-16" } },
  "137": { [P_USDC]: tok({ symbol: "USDC" }), [P_USDCE]: tok({ symbol: "USDC" }) },
};
const idx = buildCanonicalIndex(DATA);
const tx = (o) => ({ action: "tokentx", group: "token", symbol: "USDT", tokenContract: USDT, ...o });

test("normalizeSymbol: NFKC full-width, Cyrillic/Greek look-alikes, ₮, whitespace/zero-width/punctuation", () => {
  expect(normalizeSymbol("ＵＳＤＴ")).toBe("USDT");
  expect(normalizeSymbol("UЅDТ")).toBe("USDT"); // Cyrillic Ѕ, Т
  expect(normalizeSymbol("USDΤ")).toBe("USDT"); // Greek Τ
  expect(normalizeSymbol("USD₮")).toBe("USDT"); // ₮
  expect(normalizeSymbol(" usdt​ ")).toBe("USDT");
  expect(normalizeSymbol("USDC.e")).toBe("USDCE");
  expect(normalizeSymbol(undefined)).toBe("");
  expect(normalizeSymbol(123)).toBe("");
});

test("buildCanonicalIndex: chain-specific token entries only", () => {
  expect([...idx.get("1").get("USDC")]).toEqual([USDC]);
  expect(idx.has("*")).toBe(false);
  expect([...idx.get("1").keys()].sort()).toEqual(["USDC", "USDT"]);
});

test("canonical contract is not fake (checksum case too); same symbol, other contract is fake", () => {
  expect(isFakeToken(tx(), "1", idx)).toBe(false);
  expect(isFakeToken(tx({ tokenContract: "0xdAC17F958D2ee523a2206206994597C13D831ec7" }), 1, idx)).toBe(false);
  expect(isFakeToken(tx({ tokenContract: OTHER }), "1", idx)).toBe(true);
});

test("look-alike symbols are fake on a non-canonical contract", () => {
  expect(isFakeToken(tx({ symbol: "UЅDТ", tokenContract: OTHER }), "1", idx)).toBe(true);
  expect(isFakeToken(tx({ symbol: "ＵＳＤＴ", tokenContract: OTHER }), "1", idx)).toBe(true);
});

test("every contract in a multi-contract canonical set is not fake", () => {
  expect(isFakeToken(tx({ symbol: "USDC", tokenContract: P_USDC }), "137", idx)).toBe(false);
  expect(isFakeToken(tx({ symbol: "USDC", tokenContract: P_USDCE }), "137", idx)).toBe(false);
  expect(isFakeToken(tx({ symbol: "USDC", tokenContract: OTHER }), "137", idx)).toBe(true);
});

test("never guesses: unknown chain, non-canonical symbol, NFT, native are not fake", () => {
  expect(isFakeToken(tx({ tokenContract: OTHER }), "81457", idx)).toBe(false);
  expect(isFakeToken(tx({ symbol: "USDC.e", tokenContract: OTHER }), "1", idx)).toBe(false);
  expect(isFakeToken(tx({ symbol: "DAI", tokenContract: OTHER }), "1", idx)).toBe(false); // '*' tokens are canonical nowhere
  expect(isFakeToken(tx({ action: "tokennfttx", tokenContract: OTHER }), "1", idx)).toBe(false);
  expect(isFakeToken(tx({ action: "txlist", group: "normal", tokenContract: "" }), "1", idx)).toBe(false);
});

test("untrusted inputs never throw", () => {
  expect(isFakeToken(null, "1", idx)).toBe(false);
  expect(isFakeToken(tx({ symbol: null, tokenContract: OTHER }), "1", idx)).toBe(false);
  expect(isFakeToken(tx({ symbol: 7, tokenContract: OTHER }), "1", idx)).toBe(false);
  expect(isFakeToken(tx({ tokenContract: undefined }), "1", idx)).toBe(false);
  expect(isFakeToken(tx({ tokenContract: OTHER }), "1", undefined)).toBe(false);
  expect(buildCanonicalIndex(null).size).toBe(0);
});
