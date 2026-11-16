import { test, expect } from "bun:test";
import { addressEvidence, sameAddressLinks } from "../src/chainTwins.js";

const CH = [{ id: 1 }, { id: 10 }, { id: 8453 }, { id: 2741, nativeAA: true }];
const X = "0x" + "a".repeat(40), Y = "0x" + "b".repeat(40), T = "0x" + "c".repeat(40);
const ed = (chainId, action, from, to, extra = {}) => ({ chainId, action, from, to, fromId: `${chainId}:${from}`, toId: `${chainId}:${to}`, tokenContract: "", ...extra });
const nd = (chainId, address) => ({ id: `${chainId}:${address}`, chainId, address });

test("eoa: the from of a top-level txlist edge", () => {
  expect([...addressEvidence([ed("1", "txlist", X, Y)], CH)]).toEqual([[`1:${X}`, "eoa"]]);
});
test("contract: the from of an internal edge, or a tokenContract", () => {
  const ev = addressEvidence([ed("1", "txlistinternal", X, Y), ed("8453", "tokentx", Y, X, { tokenContract: T })], CH);
  expect(ev.get(`1:${X}`)).toBe("contract");
  expect(ev.get(`8453:${T}`)).toBe("contract");
  expect(ev.has(`8453:${Y}`)).toBe(false);
});
test("eoa wins over contract evidence in either order (EIP-7702)", () => {
  const a = ed("1", "txlistinternal", X, Y), b = ed("1", "txlist", X, Y);
  expect(addressEvidence([a, b], CH).get(`1:${X}`)).toBe("eoa");
  expect(addressEvidence([b, a], CH).get(`1:${X}`)).toBe("eoa");
});
test("native-AA chain evidence is ignored", () => {
  expect(addressEvidence([ed("2741", "txlist", X, Y)], CH).size).toBe(0);
});
test("basis key when any twin has eoa evidence, address otherwise; no self-pairs", () => {
  const nodes = [nd("8453", X), nd("1", X), nd("1", Y), nd("8453", Y), nd("1", T)];
  const ev = new Map([[`1:${X}`, "eoa"], [`1:${Y}`, "contract"], [`8453:${Y}`, "contract"]]);
  expect(sameAddressLinks(nodes, ev)).toEqual([
    { address: X, a: `1:${X}`, b: `8453:${X}`, basis: "key" },
    { address: Y, a: `1:${Y}`, b: `8453:${Y}`, basis: "address" },
  ]);
});
test("contracts at one address on two chains are never same-key (Permit2-style)", () => {
  const edges = [ed("1", "tokentx", X, Y, { tokenContract: T }), ed("8453", "txlistinternal", T, Y)];
  expect(sameAddressLinks([nd("1", T), nd("8453", T)], addressEvidence(edges, CH)).map((l) => l.basis)).toEqual(["address"]);
});
test("an eoa seen only on a native-AA chain gives no key basis", () => {
  expect(sameAddressLinks([nd("1", X), nd("2741", X)], addressEvidence([ed("2741", "txlist", X, Y)], CH))[0].basis).toBe("address");
});
test("three chains give every pair in numeric chain order", () => {
  expect(sameAddressLinks([nd("8453", X), nd("10", X), nd("1", X)], new Map()).map((l) => [l.a, l.b]))
    .toEqual([[`1:${X}`, `10:${X}`], [`1:${X}`, `8453:${X}`], [`10:${X}`, `8453:${X}`]]);
});
