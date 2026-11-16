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

test("txlist from on a chain absent from config gives no eoa evidence (fail closed)", () => {
  const ev = addressEvidence([ed("999999", "txlist", X, Y)], CH);
  expect(ev.size).toBe(0);
  expect(sameAddressLinks([nd("1", X), nd("999999", X)], ev)[0].basis).toBe("address");
});
test("chain order is numeric, not string (56 before 137)", () => {
  expect(sameAddressLinks([nd("137", X), nd("56", X)], new Map()).map((l) => [l.a, l.b]))
    .toEqual([[`56:${X}`, `137:${X}`]]);
});
test("eoa on one chain makes every pair in a 3-chain group key", () => {
  const ev = new Map([[`10:${X}`, "eoa"]]);
  const links = sameAddressLinks([nd("1", X), nd("10", X), nd("8453", X)], ev);
  expect(links.length).toBe(3);
  expect(links.every((l) => l.basis === "key")).toBe(true);
});
test("system senders (zero address, OP-stack depositor) are never key evidence", () => {
  const ZERO = "0x" + "0".repeat(40), DEPOSITOR = "0xdeaddeaddeaddeaddeaddeaddeaddeaddead0001";
  const ev = addressEvidence([ed("1", "txlist", ZERO, Y), ed("10", "txlist", DEPOSITOR, Y)], CH);
  expect(ev.has(`1:${ZERO}`)).toBe(false);
  expect(ev.has(`10:${DEPOSITOR}`)).toBe(false);
  expect(sameAddressLinks([nd("1", ZERO), nd("10", ZERO)], ev)[0].basis).toBe("address");
});
