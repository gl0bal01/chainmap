import { test, expect } from "bun:test";
import { flagsForEdge, resolvedRecipient, MAX_UINT256 } from "../src/riskFlags.js";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const noCat = { category: () => null };

test("unlimited approve to unknown spender flags approvalUnlimited", () => {
  const edge = { methodId: "0x095ea7b3", to: B, hasData: true,
    methodArgs: [{ type: "address", value: B, name: "spender" }, { type: "uint256", value: MAX_UINT256, name: "amount" }] };
  expect(flagsForEdge(edge, noCat)).toContain("flag.approvalUnlimited");
});

test("small approve does NOT flag approvalUnlimited", () => {
  const edge = { methodId: "0x095ea7b3", to: B, hasData: true,
    methodArgs: [{ type: "address", value: B, name: "spender" }, { type: "uint256", value: "1000000", name: "amount" }] };
  expect(flagsForEdge(edge, noCat)).not.toContain("flag.approvalUnlimited");
});

test("setApprovalForAll(true) flags approvalUnlimited; (false) does not", () => {
  const grant = { methodId: "0xa22cb465", to: B, hasData: true,
    methodArgs: [{ type: "address", value: B, name: "operator" }, { type: "bool", value: "true", name: "approved" }] };
  const revoke = { ...grant, methodArgs: [grant.methodArgs[0], { type: "bool", value: "false", name: "approved" }] };
  expect(flagsForEdge(grant, noCat)).toContain("flag.approvalUnlimited");
  expect(flagsForEdge(revoke, noCat)).not.toContain("flag.approvalUnlimited");
});

test("hidden recipient: decoded recipient differs from tx.to", () => {
  const edge = { methodId: "0xa9059cbb", to: A, hasData: true,
    methodArgs: [{ type: "address", value: B, name: "recipient" }, { type: "uint256", value: "5", name: "amount" }] };
  expect(flagsForEdge(edge, noCat)).toContain("flag.hiddenRecipient");
  expect(resolvedRecipient(edge)).toBe(B);
});

test("mixer flag from recipient category and from Tornado deposit selector", () => {
  const byCat = { methodId: "", to: A, hasData: false, methodArgs: [] };
  expect(flagsForEdge(byCat, { category: (a) => (a === A ? "mixer" : null) })).toContain("flag.mixer");
  const bySelector = { methodId: "0xb214faa5", to: B, hasData: true, methodArgs: [] };
  expect(flagsForEdge(bySelector, noCat)).toContain("flag.mixer");
});

test("bridge + sanctioned categories map to their flags", () => {
  const e = { methodId: "", to: A, hasData: false, methodArgs: [] };
  expect(flagsForEdge(e, { category: () => "bridge" })).toContain("flag.bridge");
  expect(flagsForEdge(e, { category: () => "sanctioned" })).toContain("flag.sanctioned");
});

test("clean plain transfer has no flags", () => {
  const edge = { methodId: "", to: A, hasData: false, methodArgs: [] };
  expect(flagsForEdge(edge, noCat)).toEqual([]);
});
