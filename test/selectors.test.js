import { test, expect } from "bun:test";
import { methodName, SELECTORS } from "../src/selectors.js";

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
