import { beforeEach, describe, expect, test } from "bun:test";
import { EXPORT_PIXELS, RESOLUTION_PRESETS } from "../src/config.js";
import { csvEscape, formatTimestamp } from "../src/format.js";
import {
  computeExportSize,
  exportCsv,
  exportPdf,
  exportPng,
  renderExportCanvas,
  triggerDownload,
} from "../src/render/export.js";

// ---------------------------------------------------------------------------
// Minimal DOM shim so exportCsv's `triggerDownload` (anchor-click download) can
// run under bun (no jsdom). We only need enough surface for
// document.createElement("a") + document.body.appendChild + click()/remove().
// The canvas/PDF paths (renderExportCanvas/exportPng/exportPdf) are NOT
// exercised here — they need `window.vis` / jsPDF, which is genuinely DOM/vis
// territory and is manually QA'd at Stage C instead.
// ---------------------------------------------------------------------------
globalThis.document = {
  createElement: () => ({ style: {}, click() {}, remove() {} }),
  body: { appendChild() {} },
};

// Capture what exportCsv hands to `new Blob(...)` so we can assert on the exact
// CSV text without depending on async Blob-reading APIs. Subclassing the real
// (bun-native) Blob keeps `URL.createObjectURL` happy since the object is still
// a genuine Blob instance.
let capturedBlobParts = null;
const NativeBlob = globalThis.Blob;
globalThis.Blob = class extends NativeBlob {
  constructor(parts, opts) {
    super(parts, opts);
    capturedBlobParts = parts;
  }
};

beforeEach(() => {
  capturedBlobParts = null;
});

describe("module import", () => {
  test("no DOM/vis side effects at import time", () => {
    expect(typeof computeExportSize).toBe("function");
    expect(typeof renderExportCanvas).toBe("function");
    expect(typeof exportPng).toBe("function");
    expect(typeof exportPdf).toBe("function");
    expect(typeof exportCsv).toBe("function");
    expect(typeof triggerDownload).toBe("function");
  });
});

describe("computeExportSize — fixed presets", () => {
  test("hd: exact dims, not capped, not warned", () => {
    const r = computeExportSize("hd", 10);
    expect(r.w).toBe(RESOLUTION_PRESETS.hd.w);
    expect(r.h).toBe(RESOLUTION_PRESETS.hd.h);
    expect(r.pixels).toBe(RESOLUTION_PRESETS.hd.w * RESOLUTION_PRESETS.hd.h);
    expect(r.capped).toBe(false);
    expect(r.warn).toBe(false);
  });

  test("qhd: exact dims, not capped, not warned", () => {
    const r = computeExportSize("qhd", 10);
    expect(r.w).toBe(RESOLUTION_PRESETS.qhd.w);
    expect(r.h).toBe(RESOLUTION_PRESETS.qhd.h);
    expect(r.pixels).toBe(RESOLUTION_PRESETS.qhd.w * RESOLUTION_PRESETS.qhd.h);
    expect(r.capped).toBe(false);
    expect(r.warn).toBe(false);
  });

  test("uhd: exact dims, not capped, not warned", () => {
    const r = computeExportSize("uhd", 10);
    expect(r.w).toBe(RESOLUTION_PRESETS.uhd.w);
    expect(r.h).toBe(RESOLUTION_PRESETS.uhd.h);
    expect(r.pixels).toBe(RESOLUTION_PRESETS.uhd.w * RESOLUTION_PRESETS.uhd.h);
    expect(r.capped).toBe(false);
    expect(r.warn).toBe(false);
  });

  test("unknown preset falls back to qhd (matches reference app.js)", () => {
    const r = computeExportSize("bogus", 10);
    expect(r.w).toBe(RESOLUTION_PRESETS.qhd.w);
    expect(r.h).toBe(RESOLUTION_PRESETS.qhd.h);
  });

  test("pixels always equals w*h", () => {
    for (const preset of ["hd", "qhd", "uhd"]) {
      const r = computeExportSize(preset, 5);
      expect(r.pixels).toBe(r.w * r.h);
    }
  });
});

describe("computeExportSize — auto", () => {
  test("small node count clamps to the 2400 floor", () => {
    const r = computeExportSize("auto", 1);
    expect(r.w).toBe(2400);
    expect(r.h).toBe(Math.round(2400 * 0.6));
    expect(r.pixels).toBe(r.w * r.h);
    expect(r.capped).toBe(false);
    expect(r.warn).toBe(false);
  });

  test("mid node count scales linearly (n*260) before hitting the ceiling", () => {
    const r = computeExportSize("auto", 20); // 20*260 = 5200, within [2400,10000]
    expect(r.w).toBe(5200);
    expect(r.h).toBe(Math.round(5200 * 0.6));
    expect(r.capped).toBe(false);
  });

  test("huge node count: clamps to 10000 wide, then pixel-guard caps it", () => {
    const r = computeExportSize("auto", 1000); // 1000*260 = 260000 -> clamped to 10000
    // Pre-guard would have been 10000 x 6000 = 60,000,000 px > cap.
    expect(r.capped).toBe(true);
    expect(r.pixels).toBeLessThanOrEqual(EXPORT_PIXELS.cap);
    expect(r.pixels).toBe(r.w * r.h);
    expect(r.warn).toBe(true); // still well above the warn threshold post-clamp
    expect(r.w).toBeLessThan(10000);
    expect(r.h).toBeLessThan(6000);
  });

  test("zero/negative node count is floored to 1 (still hits the 2400 floor)", () => {
    const r = computeExportSize("auto", 0);
    expect(r.w).toBe(2400);
    const r2 = computeExportSize("auto", -5);
    expect(r2.w).toBe(2400);
  });
});

// ---------------------------------------------------------------------------
// exportCsv — pure string-building behavior, driven through a fake store.
// ---------------------------------------------------------------------------

function makeFakeStore(nodes, edges) {
  return {
    listNodes: () => nodes,
    listEdges: () => edges,
  };
}

const NODE_A = { address: "0xaaaa000000000000000000000000000000aaaa", depth: 0, isRoot: true, alias: "Root, Alice" };
const NODE_B = { address: "0xbbbb000000000000000000000000000000bbbb", depth: 1, isRoot: false, alias: null };

const EDGE_1 = {
  key: "k1", action: "txlist", group: "normal", color: "#4f8ef7",
  from: NODE_A.address, to: NODE_B.address, hash: "0xhash1",
  symbol: "ETH", tokenContract: "", tokenId: "",
  value: "1500000000000000000", amountText: "1.500000", amountIndeterminate: false,
  timeStamp: "1700000000", blockNumber: "123456",
};
const EDGE_2 = {
  key: "k2", action: "tokentx", group: "token", color: "#4fd67a",
  from: NODE_B.address, to: NODE_A.address, hash: "0xhash2",
  symbol: 'Weird "Token"', tokenContract: "0xtoken0000000000000000000000000000000001", tokenId: "",
  value: "1000000", amountText: "1.000000", amountIndeterminate: false,
  timeStamp: "1700000100", blockNumber: "123457",
};

function capturedCsvText() {
  expect(capturedBlobParts).not.toBeNull();
  expect(capturedBlobParts.length).toBe(1);
  // Strip the leading UTF-8 BOM the implementation prepends.
  return capturedBlobParts[0].replace(/^﻿/, "");
}

describe("exportCsv", () => {
  test("empty store -> log.exportEmpty, no CSV built", () => {
    const logs = [];
    const store = makeFakeStore([], []);
    exportCsv(store, { onLog: (e) => logs.push(e) });

    expect(capturedBlobParts).toBeNull();
    expect(logs).toEqual([{ level: "error", key: "log.exportEmpty" }]);
  });

  test("builds header + node rows + edge rows, escapes fields, prepends sampling caveat, logs success", () => {
    const logs = [];
    const store = makeFakeStore([NODE_A, NODE_B], [EDGE_1, EDGE_2]);
    exportCsv(store, { onLog: (e) => logs.push(e) });

    const csv = capturedCsvText();
    const lines = csv.split("\n");

    // First line: sampling caveat comment (not the header).
    expect(lines[0].startsWith("# sampling caveat")).toBe(true);
    expect(lines[0].toLowerCase()).toContain("sampl");

    // Second line: exact header row.
    const expectedHeader = [
      "row_type", "address", "alias", "depth", "is_root",
      "tx_type", "from", "to", "amount", "symbol", "hash", "block", "date",
    ].join(",");
    expect(lines[1]).toBe(expectedHeader);

    // Node rows (order preserved), alias with a comma gets quoted.
    const nodeARow = [
      "node", NODE_A.address, csvEscape(NODE_A.alias), String(NODE_A.depth), "1",
      "", "", "", "", "", "", "", "",
    ].join(",");
    const nodeBRow = [
      "node", NODE_B.address, "", String(NODE_B.depth), "0",
      "", "", "", "", "", "", "", "",
    ].join(",");
    expect(lines[2]).toBe(nodeARow);
    expect(lines[3]).toBe(nodeBRow);
    expect(csvEscape(NODE_A.alias)).toBe('"Root, Alice"'); // sanity: comma triggers quoting

    // Edge rows: plain fields unescaped, quote-containing symbol escaped/doubled.
    const edge1Row = [
      "edge", "", "", "", "",
      EDGE_1.group, EDGE_1.from, EDGE_1.to, EDGE_1.amountText, EDGE_1.symbol,
      EDGE_1.hash, EDGE_1.blockNumber, csvEscape(formatTimestamp(EDGE_1.timeStamp)),
    ].join(",");
    const edge2Row = [
      "edge", "", "", "", "",
      EDGE_2.group, EDGE_2.from, EDGE_2.to, EDGE_2.amountText, csvEscape(EDGE_2.symbol),
      EDGE_2.hash, EDGE_2.blockNumber, csvEscape(formatTimestamp(EDGE_2.timeStamp)),
    ].join(",");
    expect(lines[4]).toBe(edge1Row);
    expect(lines[5]).toBe(edge2Row);
    expect(csvEscape(EDGE_2.symbol)).toBe('"Weird ""Token"""'); // sanity: quotes doubled+quoted

    expect(lines.length).toBe(6);

    expect(logs).toEqual([{ level: "info", key: "log.exportCsv" }]);
  });

  test("node with no edges still exports (edge section simply empty)", () => {
    const logs = [];
    const store = makeFakeStore([NODE_A], []);
    exportCsv(store, { onLog: (e) => logs.push(e) });

    const lines = capturedCsvText().split("\n");
    expect(lines.length).toBe(3); // caveat + header + one node row
    expect(logs).toEqual([{ level: "info", key: "log.exportCsv" }]);
  });
});
