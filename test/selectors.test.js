import { test, expect } from "bun:test";
import { methodName, SELECTORS, SELECTOR_PARAMS, paramNames } from "../src/selectors.js";

test("methodName decodes known selectors, case-insensitive", () => {
  expect(methodName("0xa9059cbb")).toBe("transfer(address,uint256)");
  expect(methodName("0xA9059CBB")).toBe("transfer(address,uint256)");
  expect(methodName("0x7ff36ab5")).toBe("swapExactETHForTokens(uint256,address[],address,uint256)");
});

test("methodName returns null for unknown / empty", () => {
  expect(methodName("0xdeadbeef")).toBeNull();
  expect(methodName("")).toBeNull();
  expect(methodName(undefined)).toBeNull();
});

test("selector dictionary keys are well-formed 0x+8 hex, no junk", () => {
  for (const k of Object.keys(SELECTORS)) {
    expect(k).toMatch(/^0x[0-9a-f]{8}$/);
    expect(typeof SELECTORS[k]).toBe("string");
    expect(SELECTORS[k].length).toBeGreaterThan(0);
  }
});

test("paramNames returns ordered names for known selector", () => {
  expect(paramNames("0xa9059cbb")).toEqual(["recipient", "amount"]);
  expect(paramNames("0xA9059CBB")).toEqual(["recipient", "amount"]); // case-insensitive
  expect(paramNames("0xdeadbeef")).toBeNull();
});

test("every SELECTOR_PARAMS key exists in SELECTORS", () => {
  for (const sel of Object.keys(SELECTOR_PARAMS)) {
    expect(SELECTORS[sel]).toBeDefined();
  }
});

const BRIDGE = {
  "0x9a2ac6d5": ["depositETHTo(address,uint32,bytes)", ["destRecipient", "minGasLimit"]],
  "0x838b2520": ["depositERC20To(address,address,address,uint256,uint32,bytes)", ["l1Token", "l2Token", "destRecipient", "amount", "minGasLimit"]],
  "0xe11013dd": ["bridgeETHTo(address,uint32,bytes)", ["destRecipient", "minGasLimit"]],
  "0x540abf73": ["bridgeERC20To(address,address,address,uint256,uint32,bytes)", ["localToken", "remoteToken", "destRecipient", "amount", "minGasLimit"]],
  "0xa3a79548": ["withdrawTo(address,address,uint256,uint32,bytes)", ["l2Token", "destRecipient", "amount", "minGasLimit"]],
  "0xb1a1a882": ["depositETH(uint32,bytes)", ["minGasLimit"]],
  "0xd2ce7d65": ["outboundTransfer(address,address,uint256,uint256,uint256,bytes)", ["token", "destRecipient", "amount", "maxGas", "gasPriceBid"]],
  "0x4fb1a07b": ["outboundTransferCustomRefund(address,address,address,uint256,uint256,uint256,bytes)", ["token", "refundTo", "destRecipient", "amount", "maxGas", "gasPriceBid"]],
  "0x439370b1": ["depositEth()", []],
  "0x4faa8a26": ["depositEtherFor(address)", ["destRecipient"]],
  "0xe3dec8fb": ["depositFor(address,address,bytes)", ["destRecipient", "rootToken"]],
  "0xce0b63ce": ["depositETH(address,uint256,uint256)", ["destRecipient", "amount", "gasLimit"]],
  "0xf219fa66": ["depositERC20(address,address,uint256,uint256)", ["token", "destRecipient", "amount", "gasLimit"]],
  "0x7b939232": ["depositV3(address,address,address,address,uint256,uint256,uint256,address,uint32,uint32,uint32,bytes)",
    ["depositor", "destRecipient", "inputToken", "outputToken", "inputAmount", "outputAmount", "destChainId", "exclusiveRelayer", "quoteTimestamp", "fillDeadline", "exclusivityDeadline"]],
  "0xdeace8f5": ["sendToL2(uint256,address,uint256,uint256,uint256,address,uint256)", ["destChainId", "destRecipient", "amount", "amountOutMin", "deadline", "relayer", "relayerFee"]],
  "0xeea0d7b2": ["swapAndSend(uint256,address,uint256,uint256,uint256,uint256,uint256,uint256)",
    ["destChainId", "destRecipient", "amount", "bonderFee", "amountOutMin", "deadline", "destinationAmountOutMin", "destinationDeadline"]],
  "0x01e4f53a": ["relayTokens(address,uint256)", ["destRecipient", "amount"]],
  "0xad58bdd1": ["relayTokens(address,address,uint256)", ["token", "destRecipient", "amount"]],
  "0x522ea81a": ["bridgeToken(address,uint256,address)", ["token", "amount", "destRecipient"]],
};

test("bridge selectors: exact signatures and leading static param names", () => {
  for (const [sel, [sig, names]] of Object.entries(BRIDGE)) {
    expect([sel, SELECTORS[sel]]).toEqual([sel, sig]);
    expect([sel, SELECTOR_PARAMS[sel] ?? []]).toEqual([sel, names]);
  }
});

test("no bridge selector names a param `recipient` (hidden-recipient flag and real_recipient stay same-chain)", () => {
  for (const sel of Object.keys(BRIDGE)) expect(SELECTOR_PARAMS[sel] || []).not.toContain("recipient");
});
