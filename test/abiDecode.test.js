import { test, expect } from "bun:test";
import { decodeCall, summarizeCall } from "../src/abiDecode.js";

const pad = (h) => h.padStart(64, "0");
const addr = "0x1111111111111111111111111111111111111111";

test("decodes transfer(address,uint256): recipient + amount", () => {
  const input = "0xa9059cbb" + pad(addr.slice(2)) + pad("de0b6b3a7640000"); // 1e18
  const d = decodeCall(input);
  expect(d.signature).toBe("transfer(address,uint256)");
  expect(d.args[0]).toEqual({ type: "address", value: addr, name: "recipient" });
  expect(d.args[1]).toEqual({ type: "uint256", value: "1000000000000000000", name: "amount" });
});

test("stops at first dynamic type (swapExactETHForTokens: uint then address[])", () => {
  const input = "0x7ff36ab5" + pad("d2f13f7789f0000") + pad("60") + pad("0"); // amountOutMin, offset, deadline...
  const d = decodeCall(input);
  expect(d.args.length).toBe(1); // only the leading uint256; address[] is dynamic -> stop
  expect(d.args[0].type).toBe("uint256");
});

test("unknown selector -> signature null, no args; no calldata -> null", () => {
  const d = decodeCall("0xdeadbeef" + pad("1"));
  expect(d.signature).toBeNull();
  expect(d.args).toEqual([]);
  expect(decodeCall("0x")).toBeNull();
  expect(decodeCall("")).toBeNull();
});

test("bool decodes truthy/zero", () => {
  const t = decodeCall("0xa22cb465" + pad(addr.slice(2)) + pad("1")); // setApprovalForAll(address,bool)
  expect(t.args[1]).toEqual({ type: "bool", value: "true", name: "approved" });
  const f = decodeCall("0xa22cb465" + pad(addr.slice(2)) + pad("0"));
  expect(f.args[1]).toEqual({ type: "bool", value: "false", name: "approved" });
});

const padSel = (h) => h.replace(/^0x/, "").padStart(64, "0");

test("decodeCall attaches param names for known selectors", () => {
  const addr2 = "0x1111111111111111111111111111111111111111";
  const d = decodeCall("0xa9059cbb" + padSel(addr2) + padSel("64")); // transfer(0x11.., 100)
  expect(d.args[0]).toEqual({ type: "address", value: addr2, name: "recipient" });
  expect(d.args[1]).toEqual({ type: "uint256", value: "100", name: "amount" });
});

test("summarizeCall builds a transfer summary key + raw params", () => {
  const addr2 = "0x2222222222222222222222222222222222222222";
  const d = decodeCall("0xa9059cbb" + padSel(addr2) + padSel("64"));
  const s = summarizeCall(d);
  expect(s).toEqual({ key: "summary.transfer", params: { amount: "100", recipient: addr2 } });
});

test("summarizeCall handles setApprovalForAll true/false", () => {
  const op = "0x3333333333333333333333333333333333333333";
  const grant = decodeCall("0xa22cb465" + padSel(op) + padSel("1"));
  expect(summarizeCall(grant)).toEqual({ key: "summary.approveAll", params: { operator: op } });
  const revoke = decodeCall("0xa22cb465" + padSel(op) + padSel("0"));
  expect(summarizeCall(revoke)).toEqual({ key: "summary.revokeAll", params: { operator: op } });
});

test("summarizeCall returns null for unknown/undecodable calls", () => {
  expect(summarizeCall({ methodId: "0xdeadbeef", args: [] })).toBeNull();
  expect(summarizeCall(null)).toBeNull();
});
