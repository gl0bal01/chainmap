import { test, expect } from "bun:test";
import { decodeCall } from "../src/abiDecode.js";
import { flagsForEdge, resolvedRecipient, MAX_UINT256, flagSeverity, edgeSeverity } from "../src/riskFlags.js";

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

test("flagSeverity: mixer/bridge/sanctioned are high, others are info", () => {
  expect(flagSeverity("flag.mixer")).toBe("high");
  expect(flagSeverity("flag.bridge")).toBe("high");
  expect(flagSeverity("flag.sanctioned")).toBe("high");
  expect(flagSeverity("flag.approvalUnlimited")).toBe("info");
  expect(flagSeverity("flag.hiddenRecipient")).toBe("info");
});

test("edgeSeverity: high when any high-severity flag present, even mixed with info", () => {
  expect(edgeSeverity(["flag.mixer"])).toBe("high");
  expect(edgeSeverity(["flag.approvalUnlimited", "flag.bridge"])).toBe("high");
  expect(edgeSeverity(["flag.sanctioned", "flag.hiddenRecipient"])).toBe("high");
});

test("edgeSeverity: info when only info flags present", () => {
  expect(edgeSeverity(["flag.approvalUnlimited"])).toBe("info");
  expect(edgeSeverity(["flag.hiddenRecipient", "flag.approvalUnlimited"])).toBe("info");
});

test("edgeSeverity: null for no flags", () => {
  expect(edgeSeverity([])).toBeNull();
  expect(edgeSeverity(null)).toBeNull();
  expect(edgeSeverity(undefined)).toBeNull();
});

test("fakeToken flag comes from the injected predicate and is info tier", () => {
  const e = { action: "tokentx", methodId: "", to: A, hasData: false, methodArgs: [] };
  expect(flagsForEdge(e, { category: () => null, isFakeToken: () => true })).toContain("flag.fakeToken");
  expect(flagsForEdge(e, { category: () => null, isFakeToken: () => false })).toEqual([]);
  expect(flagsForEdge(e, noCat)).toEqual([]);
  expect(flagSeverity("flag.fakeToken")).toBe("info");
  expect(edgeSeverity(["flag.fakeToken"])).toBe("info");
  expect(edgeSeverity(["flag.fakeToken", "flag.mixer"])).toBe("high");
});

test("flagsForEdge looks the recipient up on the edge's own chain", () => {
  const seen = [];
  const ctx = { category: (addr, chainId) => (seen.push(chainId), addr === A && chainId === "1" ? "mixer" : null) };
  expect(flagsForEdge({ chainId: "1", to: A, methodArgs: [] }, ctx)).toContain("flag.mixer");
  expect(flagsForEdge({ chainId: "56", to: A, methodArgs: [] }, ctx)).not.toContain("flag.mixer");
  expect(seen).toEqual(["1", "56"]);
});

test("a bridge call into a known bridge still flags bridge, never hiddenRecipient", () => {
  const BR = "0x" + "b".repeat(40), DEST = "0x" + "d".repeat(40);
  const w = (h) => h.padStart(64, "0");
  const edge = { chainId: "1", to: BR, methodId: "0x9a2ac6d5", methodArgs: decodeCall("0x9a2ac6d5" + w(DEST.slice(2)) + w("30d40") + w("60")).args };
  expect(edge.methodArgs.map((a) => a.name)).toEqual(["destRecipient", "minGasLimit"]); // decoded, yet never read as `recipient`
  const flags = flagsForEdge(edge, { category: (a, c) => (a === BR && c === "1" ? "bridge" : null) });
  expect(flags).toContain("flag.bridge");
  expect(flags).not.toContain("flag.hiddenRecipient");
  expect(resolvedRecipient(edge)).toBe(BR);
});

test("a Tron TRC-20 transfer has no calldata, so no hiddenRecipient flag", async () => {
  const { GraphStore } = await import("../src/graphStore.js");
  const { tronRows, TRON_CHAIN_ID } = await import("../src/tron.js");
  const { readFileSync } = await import("node:fs");
  const row = tronRows("tokentx", JSON.parse(readFileSync("test/fixtures/tron/trc20.json", "utf8")))[0];
  const edge = new GraphStore().addEdge({ chainId: TRON_CHAIN_ID, action: "tokentx", group: "token", color: "#000", from: row.from, to: row.to, tx: row });
  expect(edge.hasData).toBe(false);
  expect(edge.methodArgs).toEqual([]);
  expect(flagsForEdge(edge, noCat)).not.toContain("flag.hiddenRecipient");
});
