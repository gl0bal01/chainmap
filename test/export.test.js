import { beforeEach, describe, expect, test } from "bun:test";
import { EXPORT_PIXELS, RESOLUTION_PRESETS } from "../src/config.js";
import { csvEscape, formatTimestamp } from "../src/format.js";
import {
  buildCsvRows,
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

const SINGLE_CAVEAT = "# sampling caveat: partial/sampled data (latest transactions per address per type) - not full on-chain history; not forensic-complete";
const NODE_A = { chainId: "1", address: "0xaaaa000000000000000000000000000000aaaa", depth: 0, isRoot: true, alias: "Root, Alice" };
const NODE_B = { chainId: "1", address: "0xbbbb000000000000000000000000000000bbbb", depth: 1, isRoot: false, alias: null };

const EDGE_1 = {
  key: "k1", chainId: "1", action: "txlist", group: "normal", color: "#4f8ef7",
  from: NODE_A.address, to: NODE_B.address, hash: "0xhash1",
  symbol: "ETH", tokenContract: "", tokenId: "",
  value: "1500000000000000000", amountText: "1.500000", amountIndeterminate: false,
  timeStamp: "1700000000", blockNumber: "123456",
};
const EDGE_2 = {
  key: "k2", chainId: "1", action: "tokentx", group: "token", color: "#4fd67a",
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
    expect(lines[0]).toBe(SINGLE_CAVEAT);
    expect(lines[0].toLowerCase()).toContain("sampl");

    // Second line: exact header row.
    const expectedHeader = [
      "row_type", "address", "alias", "depth", "is_root",
      "tx_type", "from", "to", "amount", "symbol", "hash", "block", "date",
      "method", "method_sig", "real_recipient", "decoded_amount", "risk_flags", "chain_id", "likely_deposit_of", "deposit_evidence",
    ].join(",");
    expect(lines[1]).toBe(expectedHeader);

    // Node rows (order preserved), alias with a comma gets quoted.
    const nodeARow = [
      "node", NODE_A.address, csvEscape(NODE_A.alias), String(NODE_A.depth), "1",
      "", "", "", "", "", "", "", "",
      "", "", "", "", "", "1", "", "",
    ].join(",");
    const nodeBRow = [
      "node", NODE_B.address, "", String(NODE_B.depth), "0",
      "", "", "", "", "", "", "", "",
      "", "", "", "", "", "1", "", "",
    ].join(",");
    expect(lines[2]).toBe(nodeARow);
    expect(lines[3]).toBe(nodeBRow);
    expect(csvEscape(NODE_A.alias)).toBe('"Root, Alice"'); // sanity: comma triggers quoting

    // Edge rows: plain fields unescaped, quote-containing symbol escaped/doubled.
    // EDGE_1/EDGE_2 carry no calldata (hasData unset) -> decoded columns blank.
    const edge1Row = [
      "edge", "", "", "", "",
      EDGE_1.group, EDGE_1.from, EDGE_1.to, EDGE_1.amountText, EDGE_1.symbol,
      EDGE_1.hash, EDGE_1.blockNumber, csvEscape(formatTimestamp(EDGE_1.timeStamp)),
      "", "", "", "", "", "1", "", "",
    ].join(",");
    const edge2Row = [
      "edge", "", "", "", "",
      EDGE_2.group, EDGE_2.from, EDGE_2.to, EDGE_2.amountText, csvEscape(EDGE_2.symbol),
      EDGE_2.hash, EDGE_2.blockNumber, csvEscape(formatTimestamp(EDGE_2.timeStamp)),
      "", "", "", "", "", "1", "", "",
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

// ---------------------------------------------------------------------------
// buildCsvRows — pure row builder extracted out of exportCsv (Task 9: decoded
// method / real recipient / decoded amount / risk-flags columns).
// ---------------------------------------------------------------------------

describe("buildCsvRows", () => {
  test("CSV header includes decoded columns", () => {
    const rows = buildCsvRows(makeFakeStore([{ address: "0xa", depth: 0, isRoot: true }], []), { category: () => null });
    const header = rows[1];
    expect(header).toEqual([
      "row_type", "address", "alias", "depth", "is_root",
      "tx_type", "from", "to", "amount", "symbol", "hash", "block", "date",
      "method", "method_sig", "real_recipient", "decoded_amount", "risk_flags", "chain_id", "likely_deposit_of", "deposit_evidence",
    ]);
  });

  test("edge row carries decoded method + real recipient + flags", () => {
    const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const edge = {
      group: "normal", from: "0xa", to: "0xtoken", amountText: "0", symbol: "", hash: "0xh", blockNumber: "1", timeStamp: "0",
      hasData: true, methodId: "0xa9059cbb",
      methodArgs: [{ type: "address", value: B, name: "recipient" }, { type: "uint256", value: "100", name: "amount" }],
    };
    const rows = buildCsvRows(makeFakeStore([], [edge]), { category: () => null });
    const row = rows.find((r) => r[0] === "edge");
    expect(row).toContain("transfer(address,uint256)"); // method_sig
    expect(row).toContain(B); // real_recipient
  });

  test("risk_flags is computed for plain (no-calldata) edges, incl. flag.fakeToken", () => {
    const edge = { group: "token", action: "tokentx", from: "0xa", to: "0xb", amountText: "1", symbol: "USDT", hash: "0xh", blockNumber: "1", timeStamp: "0", hasData: false };
    const rows = buildCsvRows(makeFakeStore([], [edge]), { category: () => null, isFakeToken: () => true });
    expect(rows.find((r) => r[0] === "edge")[17]).toBe("flag.fakeToken");
  });
});

test("multi-chain CSV: chain_id on every row, caveat extended on line 1, header still line 2", () => {
  const rows = buildCsvRows(makeFakeStore([{ ...NODE_A, chainId: "1" }, { ...NODE_A, chainId: "42161" }], [{ ...EDGE_1, chainId: "42161" }]), { category: () => null });
  expect(rows[0][0]).toBe(SINGLE_CAVEAT + "; multi-chain: each row belongs to its chain_id — the same address on two chains is two rows; a shared address implies no transfer");
  expect(rows[1][18]).toBe("chain_id");
  expect(rows.slice(2).map((r) => r[18])).toEqual(["1", "42161", "42161"]);
});
test("risk_flags uses each edge's chain", () => {
  const category = (addr, chainId) => (chainId === "1" ? "mixer" : null);
  const rows = buildCsvRows(makeFakeStore([], [{ ...EDGE_1, chainId: "1" }, { ...EDGE_1, key: "k9", chainId: "56" }]), { category });
  expect(rows.filter((r) => r[0] === "edge").map((r) => [r[17], r[18]])).toEqual([["flag.mixer", "1"], ["", "56"]]);
});

const MULTI = "; multi-chain: each row belongs to its chain_id — the same address on two chains is two rows; a shared address implies no transfer";
const DEPOSIT_CAVEAT = "; likely_deposit_of is a heuristic (nearly all of the address's sampled outflow went to one known exchange wallet), not an attribution";
const DEP = {
  walletId: "1:0xex", wallet: "0xex", label: "Binance 14 (hot wallet)", swept: 9, outgoing: 10,
  assets: [{ symbol: "ETH", contract: "", sharePct: 100 }, { symbol: "USDT", contract: "0xt", sharePct: 93 }],
  maxDelaySec: 600, timedSweeps: 9,
};
const withId = (n) => ({ ...n, id: `${n.chainId}:${n.address}` });

test("deposit columns: label + evidence on node rows only, caveat on line 1, after chain_id", () => {
  const a = withId(NODE_A), b = withId(NODE_B);
  const rows = buildCsvRows(makeFakeStore([a, b], [EDGE_1]), { category: () => null, deposits: new Map([[a.id, DEP]]) });
  expect(rows[0][0]).toBe(SINGLE_CAVEAT + DEPOSIT_CAVEAT);
  expect(rows[1].slice(-3)).toEqual(["chain_id", "likely_deposit_of", "deposit_evidence"]);
  expect(rows[2].slice(-3)).toEqual(["1", "Binance 14 (hot wallet)", "wallet=0xex;swept=9/10;share=ETH:100%,USDT:93%;max_delay_s=600"]);
  expect(rows[3].slice(-3)).toEqual(["1", "", ""]);
  expect(rows[4].slice(-3)).toEqual(["1", "", ""]); // edge row
  const none = buildCsvRows(makeFakeStore([a], []), {
    category: () => null,
    deposits: new Map([[a.id, { ...DEP, assets: [DEP.assets[0]], maxDelaySec: null, timedSweeps: 0 }]]),
  });
  expect(none[2].at(-1)).toBe("wallet=0xex;swept=9/10;share=ETH:100%;max_delay_s=none");
});

test("no deposit -> no deposit caveat; twins get independent cells; multi-chain caveat first", () => {
  expect(buildCsvRows(makeFakeStore([withId(NODE_A)], []), { category: () => null })[0][0]).toBe(SINGLE_CAVEAT);
  const one = withId(NODE_A), arb = withId({ ...NODE_A, chainId: "42161" });
  const rows = buildCsvRows(makeFakeStore([one, arb], []), { category: () => null, deposits: new Map([[arb.id, DEP]]) });
  expect(rows[0][0]).toBe(SINGLE_CAVEAT + MULTI + DEPOSIT_CAVEAT);
  expect(rows[2].slice(-2)).toEqual(["", ""]);
  expect(rows[3].at(-2)).toBe("Binance 14 (hot wallet)");
});

test("exportCsv forwards deps.deposits", () => {
  const a = withId(NODE_A);
  exportCsv(makeFakeStore([a], []), { onLog: () => {}, category: () => null, deposits: new Map([[a.id, DEP]]) });
  const lines = capturedCsvText().split("\n");
  expect(lines[0]).toBe(csvEscape(SINGLE_CAVEAT + DEPOSIT_CAVEAT)); // caveat has a comma -> quoted
  expect(lines[2]).toContain("wallet=0xex;swept=9/10");
});
