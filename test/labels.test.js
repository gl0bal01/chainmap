import { describe, test, expect } from "bun:test";
import { depthColor, nodeLabel, nodeVisual, edgeLabel } from "../src/render/labels.js";
import { ROOT_COLOR } from "../src/config.js";
import { shortAddress } from "../src/format.js";

const ADDR = "0x1234567890abcdef1234567890abcdef12345678";

describe("depthColor", () => {
  test("is deterministic for the same depth", () => {
    expect(depthColor(2)).toBe(depthColor(2));
  });

  test("follows the hsl((200 + depth*45) % 360, 65%, 55%) formula", () => {
    expect(depthColor(0)).toBe("hsl(200, 65%, 55%)");
    expect(depthColor(1)).toBe("hsl(245, 65%, 55%)");
    expect(depthColor(2)).toBe("hsl(290, 65%, 55%)");
  });

  test("wraps the hue past 360", () => {
    // 200 + 4*45 = 380 -> 380 % 360 = 20
    expect(depthColor(4)).toBe("hsl(20, 65%, 55%)");
  });
});

describe("nodeLabel", () => {
  test("no alias, short format -> shortAddress(address)", () => {
    const node = { address: ADDR, alias: null };
    expect(nodeLabel(node, { addressFormat: "short" })).toBe(shortAddress(ADDR));
  });

  test("no alias, full format -> raw address", () => {
    const node = { address: ADDR, alias: null };
    expect(nodeLabel(node, { addressFormat: "full" })).toBe(ADDR);
  });

  test("with alias, short format -> alias + short address", () => {
    const node = { address: ADDR, alias: "Exchange" };
    expect(nodeLabel(node, { addressFormat: "short" })).toBe(`Exchange\n(${shortAddress(ADDR)})`);
  });

  test("with alias, full format -> alias + full address", () => {
    const node = { address: ADDR, alias: "Exchange" };
    expect(nodeLabel(node, { addressFormat: "full" })).toBe(`Exchange\n(${ADDR})`);
  });

  test("knownLabel used when no user alias", () => {
    const node = { address: ADDR, alias: null };
    expect(nodeLabel(node, { addressFormat: "short", knownLabel: "WETH" })).toBe(`WETH\n(${shortAddress(ADDR)})`);
  });

  test("user alias wins over knownLabel", () => {
    const node = { address: ADDR, alias: "Mine" };
    expect(nodeLabel(node, { addressFormat: "short", knownLabel: "WETH" })).toBe(`Mine\n(${shortAddress(ADDR)})`);
  });
});

describe("nodeVisual", () => {
  test("root node uses ROOT_COLOR regardless of depth", () => {
    const node = { address: ADDR, alias: null, depth: 3, isRoot: true };
    expect(nodeVisual(node).color).toBe(ROOT_COLOR);
  });

  test("non-root node uses depthColor(depth)", () => {
    const node = { address: ADDR, alias: null, depth: 2, isRoot: false };
    expect(nodeVisual(node).color).toBe(depthColor(2));
  });

  test("title without alias is the raw address", () => {
    const node = { address: ADDR, alias: null, depth: 0, isRoot: true };
    expect(nodeVisual(node).title).toBe(ADDR);
  });

  test("title with alias is 'alias — address'", () => {
    const node = { address: ADDR, alias: "Exchange", depth: 0, isRoot: true };
    expect(nodeVisual(node).title).toBe(`Exchange — ${ADDR}`);
  });
});

describe("edgeLabel", () => {
  test("short label passes through as '<amountText> <symbol>'", () => {
    const edge = { amountText: "1.5", symbol: "ETH" };
    expect(edgeLabel(edge)).toBe("1.5 ETH");
  });

  test("label exactly 18 chars passes through", () => {
    const edge = { amountText: "1234567890123", symbol: "ABCD" }; // 13 + 1 + 4 = 18
    const label = edgeLabel(edge);
    expect(label.length).toBe(18);
    expect(label).toBe("1234567890123 ABCD");
  });

  test("label longer than 18 chars returns \"\"", () => {
    const edge = { amountText: "1234567890123", symbol: "ABCDE" }; // 13 + 1 + 5 = 19
    expect(edgeLabel(edge)).toBe("");
  });
});
