import { test, expect } from "bun:test";
import { decodeCall } from "../src/abiDecode.js";

const pad = (h) => h.padStart(64, "0");
const addr = "0x1111111111111111111111111111111111111111";

test("decodes transfer(address,uint256): recipient + amount", () => {
  const input = "0xa9059cbb" + pad(addr.slice(2)) + pad("de0b6b3a7640000"); // 1e18
  const d = decodeCall(input);
  expect(d.signature).toBe("transfer(address,uint256)");
  expect(d.args[0]).toEqual({ type: "address", value: addr });
  expect(d.args[1]).toEqual({ type: "uint256", value: "1000000000000000000" });
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
  expect(t.args[1]).toEqual({ type: "bool", value: "true" });
  const f = decodeCall("0xa22cb465" + pad(addr.slice(2)) + pad("0"));
  expect(f.args[1]).toEqual({ type: "bool", value: "false" });
});
