import { test, expect } from "bun:test";
import { decodeCall, summarizeCall, decodeCalldataWords, decodeInputText } from "../src/abiDecode.js";

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

// --- decodeCalldataWords: always-decode-the-full-layout word breakdown -----

test("decodeCalldataWords extracts the 4-byte selector", () => {
  const input = "0xa9059cbb" + pad(addr.slice(2)) + pad("de0b6b3a7640000");
  const d = decodeCalldataWords(input);
  expect(d.selector).toBe("0xa9059cbb");
});

test("decodeCalldataWords on transfer(address,uint256): word0 address set, word1 uint == amount", () => {
  const input = "0xa9059cbb" + pad(addr.slice(2)) + pad("de0b6b3a7640000"); // 1e18
  const d = decodeCalldataWords(input);
  expect(d.words.length).toBe(2);
  expect(d.words[0]).toEqual({ index: 0, hex: "0x" + pad(addr.slice(2)), uint: BigInt(addr).toString(), address: addr.toLowerCase() });
  expect(d.words[1].uint).toBe("1000000000000000000");
});

test("decodeCalldataWords returns null for no calldata", () => {
  expect(decodeCalldataWords("0x")).toBeNull();
  expect(decodeCalldataWords("")).toBeNull();
});

test("decodeCalldataWords: all-f word decodes to the correct big-int decimal", () => {
  const input = "0xa9059cbb" + "f".repeat(64);
  const d = decodeCalldataWords(input);
  expect(d.words[0].uint).toBe((2n ** 256n - 1n).toString());
});

test("decodeCalldataWords: non-address word (nonzero top bytes) has address null but uint set", () => {
  const input = "0xa9059cbb" + "1".repeat(64); // top 12 bytes are not zero
  const d = decodeCalldataWords(input);
  expect(d.words[0].address).toBeNull();
  expect(d.words[0].uint).toBe(BigInt("0x" + "1".repeat(64)).toString());
});

test("decodeCalldataWords: a trailing partial word (< 64 hex chars) is included without throwing", () => {
  const input = "0xa9059cbb" + pad(addr.slice(2)) + "abcd"; // trailing partial word
  const d = decodeCalldataWords(input);
  expect(d.words.length).toBe(2);
  expect(d.words[1].hex).toBe("0xabcd");
  expect(d.words[1].uint).toBe(BigInt("0xabcd").toString());
  expect(d.words[1].address).toBeNull();
});

// --- decodeInputText: readable UTF-8 message hidden in raw calldata ---------

const hexOf = (s) => "0x" + Array.from(new TextEncoder().encode(s)).map((b) => b.toString(16).padStart(2, "0")).join("");

test("decodeInputText surfaces a plain-text message carried in the input", () => {
  expect(decodeInputText(hexOf("gm fren, wagmi"))).toBe("gm fren, wagmi");
});

test("decodeInputText keeps UTF-8 letters and squeezes whitespace/control noise", () => {
  expect(decodeInputText(hexOf("café\n\n  note"))).toBe("café note");
});

test("decodeInputText surfaces non-Latin messages (Cyrillic / CJK)", () => {
  expect(decodeInputText(hexOf("привет мир"))).toBe("привет мир");
  expect(decodeInputText(hexOf("你好世界这是消息"))).toBe("你好世界这是消息");
});

test("decodeInputText gates out ABI-encoded binary (transfer calldata) -> empty", () => {
  const input = "0xa9059cbb" + pad(addr.slice(2)) + pad("de0b6b3a7640000");
  expect(decodeInputText(input)).toBe("");
});

test("decodeInputText returns empty for no/short/invalid calldata", () => {
  expect(decodeInputText("0x")).toBe("");
  expect(decodeInputText("")).toBe("");
  expect(decodeInputText(null)).toBe("");
  expect(decodeInputText("0xzz")).toBe(""); // non-hex
});

test("decodeInputText below the alphanumeric gate (too little text) -> empty", () => {
  expect(decodeInputText(hexOf("hi"))).toBe(""); // only 2 alnum, under the 4-char gate
});
