import { beforeEach, describe, expect, test } from "bun:test";
import { EXPORT_PIXELS, RESOLUTION_PRESETS } from "../src/config.js";
import { csvEscape, formatTimestamp } from "../src/format.js";
import {
  buildCsvRows,
  computeExportSize,
  csvText,
  exportCsv,
  exportEvidenceBundle,
  exportPdf,
  exportPng,
  renderExportCanvas,
  triggerDownload,
} from "../src/render/export.js";
import { nodeLabel } from "../src/render/labels.js";
import { sha256Hex } from "../src/queryLog.js";
import { readZip } from "./fixtures/readZip.js";

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
      "method", "method_sig", "real_recipient", "decoded_amount", "risk_flags", "chain_id", "likely_deposit_of", "deposit_evidence", "usd_value",
    ].join(",");
    expect(lines[1]).toBe(expectedHeader);

    // Node rows (order preserved), alias with a comma gets quoted.
    const nodeARow = [
      "node", NODE_A.address, csvEscape(NODE_A.alias), String(NODE_A.depth), "1",
      "", "", "", "", "", "", "", "",
      "", "", "", "", "", "1", "", "", "",
    ].join(",");
    const nodeBRow = [
      "node", NODE_B.address, "", String(NODE_B.depth), "0",
      "", "", "", "", "", "", "", "",
      "", "", "", "", "", "1", "", "", "",
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
      "", "", "", "", "", "1", "", "", "",
    ].join(",");
    const edge2Row = [
      "edge", "", "", "", "",
      EDGE_2.group, EDGE_2.from, EDGE_2.to, EDGE_2.amountText, csvEscape(EDGE_2.symbol),
      EDGE_2.hash, EDGE_2.blockNumber, csvEscape(formatTimestamp(EDGE_2.timeStamp)),
      "", "", "", "", "", "1", "", "", "",
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
      "method", "method_sig", "real_recipient", "decoded_amount", "risk_flags", "chain_id", "likely_deposit_of", "deposit_evidence", "usd_value",
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
const DEPOSIT_CAVEAT = "; likely_deposit_of is a heuristic (nearly all of the address's sampled outflow went to one known exchange wallet) - not an attribution";
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
  expect(rows[1].slice(-4)).toEqual(["chain_id", "likely_deposit_of", "deposit_evidence", "usd_value"]);
  expect(rows[2].slice(-4)).toEqual(["1", "Binance 14 (hot wallet)", "wallet=0xex;swept=9/10;share=ETH:100%,USDT:93%;max_delay_s=600", ""]);
  expect(rows[3].slice(-4)).toEqual(["1", "", "", ""]);
  expect(rows[4].slice(-4)).toEqual(["1", "", "", ""]); // edge row
  const none = buildCsvRows(makeFakeStore([a], []), {
    category: () => null,
    deposits: new Map([[a.id, { ...DEP, assets: [DEP.assets[0]], maxDelaySec: null, timedSweeps: 0 }]]),
  });
  expect(none[2].at(-2)).toBe("wallet=0xex;swept=9/10;share=ETH:100%;max_delay_s=none");
});

test("no deposit -> no deposit caveat; twins get independent cells; multi-chain caveat first", () => {
  expect(buildCsvRows(makeFakeStore([withId(NODE_A)], []), { category: () => null })[0][0]).toBe(SINGLE_CAVEAT);
  const one = withId(NODE_A), arb = withId({ ...NODE_A, chainId: "42161" });
  const rows = buildCsvRows(makeFakeStore([one, arb], []), { category: () => null, deposits: new Map([[arb.id, DEP]]) });
  expect(rows[0][0]).toBe(SINGLE_CAVEAT + MULTI + DEPOSIT_CAVEAT);
  expect(rows[2].slice(-3)).toEqual(["", "", ""]);
  expect(rows[3].at(-3)).toBe("Binance 14 (hot wallet)");
});

test("exportCsv forwards deps.deposits", () => {
  const a = withId(NODE_A);
  exportCsv(makeFakeStore([a], []), { onLog: () => {}, category: () => null, deposits: new Map([[a.id, DEP]]) });
  const lines = capturedCsvText().split("\n");
  expect(lines[0]).toBe(SINGLE_CAVEAT + DEPOSIT_CAVEAT);
  expect(lines[0].startsWith('"')).toBe(false);
  expect(lines[2]).toContain("wallet=0xex;swept=9/10");
});

// ---------------------------------------------------------------------------
// P5 evidence exports: CSV provenance, csvText, canvas footer/badge, bundle.
// ---------------------------------------------------------------------------

const EXPORTED_AT = "2026-11-16T10:15:30.123Z";
const RETR = { queries: 3, dropped: 0, first: "2026-11-16T10:00:00.000Z", last: "2026-11-16T10:05:00.000Z", fullyLogged: true };
const SIGNALS = "; labels/risk flags/imitation-token/likely-deposit/same-key marks are signals - not facts";
const CSV_HEADER_LINE = "row_type,address,alias,depth,is_root,tx_type,from,to,amount,symbol,hash,block,date,method,method_sig,real_recipient,decoded_amount,risk_flags,chain_id,likely_deposit_of,deposit_evidence,usd_value";
const enc = (s) => new TextEncoder().encode(s);

test("CSV line 1 provenance: exported + retrieved + signals, comma-free, header on line 2", () => {
  const rows = buildCsvRows(makeFakeStore([withId(NODE_A)], []), { category: () => null, provenance: { exportedAt: EXPORTED_AT, retrieval: RETR } });
  expect(rows[0][0]).toBe(SINGLE_CAVEAT + "; exported 2026-11-16T10:15:30.123Z UTC; retrieved 2026-11-16T10:00:00.000Z to 2026-11-16T10:05:00.000Z UTC (see query log)" + SIGNALS);
  expect(rows[0][0].includes(",")).toBe(false);
  expect(rows[1].join(",")).toBe(CSV_HEADER_LINE);
});

test("CSV line 1 provenance: retrieval unknown wording, still comma-free", () => {
  const line = buildCsvRows(makeFakeStore([withId(NODE_A)], []), { category: () => null, provenance: { exportedAt: EXPORTED_AT, retrieval: null } })[0][0];
  expect(line).toContain("; retrieval time unknown (no query log)");
  expect(line).not.toContain("retrieved ");
  expect(line.includes(",")).toBe(false);
  expect(line.endsWith(SIGNALS)).toBe(true);
});

test("CSV line 1 provenance: partial retrieval is stated", () => {
  const line = buildCsvRows(makeFakeStore([withId(NODE_A)], []), { category: () => null, provenance: { exportedAt: EXPORTED_AT, retrieval: { ...RETR, fullyLogged: false } } })[0][0];
  expect(line).toContain("; retrieved 2026-11-16T10:00:00.000Z to 2026-11-16T10:05:00.000Z UTC (see query log); part of this graph has no logged retrieval");
  expect(line.includes(",")).toBe(false);
});

/** Fake DOM + canvas + vis + URL for the canvas/bundle paths; restored in finally. */
async function fakeCanvasEnv(run) {
  const saved = {
    document: globalThis.document, window: globalThis.window, raf: globalThis.requestAnimationFrame,
    create: URL.createObjectURL, revoke: URL.revokeObjectURL,
  };
  const env = { divs: [], anchors: [], canvases: [], dataSets: [], blobs: [], fills: [], images: [] };
  const ctx = {
    font: "10px sans-serif", texts: [],
    fillRect: (...a) => env.fills.push(a),
    drawImage: (...a) => env.images.push(a),
    fillText(text, x, y) { ctx.texts.push({ text, x, y, font: ctx.font }); },
    measureText: (s) => ({ width: s.length * parseFloat(ctx.font) * 0.6 }),
  };
  env.ctx = ctx;
  globalThis.document = {
    body: { appendChild() {} },
    createElement(tag) {
      if (tag === "canvas") {
        const c = { width: 0, height: 0, getContext: () => ctx, toDataURL: () => "data:image/png;base64,", toBlob: (cb) => cb(new Blob([Uint8Array.of(0x89, 0x50, 0x4e, 0x47)])) };
        env.canvases.push(c);
        return c;
      }
      const el = { style: {}, remove() {}, click() { if (tag === "a") env.anchors.push(el.download); } };
      if (tag === "div") env.divs.push(el);
      return el;
    },
  };
  class DataSet {
    constructor(items) { this.items = [...items]; env.dataSets.push(this); }
    add(item) { this.items.push(item); }
  }
  class Network {
    constructor(container) {
      this.canvas = { frame: { canvas: { width: parseInt(container.style.width), height: parseInt(container.style.height) } } };
    }
    once(ev, cb) { if (ev === "afterDrawing") this.cb = cb; }
    fit() { this.cb(); }
    destroy() {}
  }
  globalThis.window = { vis: { DataSet, Network } };
  globalThis.requestAnimationFrame = (cb) => cb();
  URL.createObjectURL = (b) => { env.blobs.push(b); return "blob:fake"; };
  URL.revokeObjectURL = () => {};
  env.view = { getPositions: (ids) => Object.fromEntries(ids.map((i) => [i, { x: 0, y: 0 }])) };
  try {
    return await run(env);
  } finally {
    globalThis.document = saved.document;
    globalThis.window = saved.window;
    globalThis.requestAnimationFrame = saved.raf;
    URL.createObjectURL = saved.create;
    URL.revokeObjectURL = saved.revoke;
  }
}

const blobBytes = async (b) => new Uint8Array(await b.arrayBuffer());
const storeAB = () => ({ ...makeFakeStore([withId(NODE_A), withId(NODE_B)], [EDGE_1]), stats: () => ({ nodes: 2, edges: 1 }) });

test("csvText bytes = exportCsv bytes (BOM included)", async () => {
  const store = makeFakeStore([withId(NODE_A)], [EDGE_1]);
  const ctx = { category: () => null, provenance: { exportedAt: EXPORTED_AT, retrieval: RETR } };
  expect(csvText(store, ctx).startsWith("﻿")).toBe(true);
  await fakeCanvasEnv(async (env) => {
    exportCsv(store, { onLog: () => {}, ...ctx });
    const bytes = await blobBytes(env.blobs[0]);
    expect(bytes).toEqual(enc(csvText(store, ctx)));
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes).split("\n")[0]).toContain("; exported 2026-11-16T10:15:30.123Z UTC");
  });
});

test("badge line: appended to the node label only when badge() returns text", async () => {
  const A = NODE_A.address;
  await fakeCanvasEnv(async (env) => {
    await renderExportCanvas(env.view, storeAB(), {
      size: computeExportSize("hd", 2), addressFormat: "short",
      badge: (n) => (n.address === A ? "🏦 likely deposit → Binance" : null),
    });
    const items = env.dataSets[0].items;
    expect(items[0].label).toBe(nodeLabel(NODE_A, { addressFormat: "short", chainTag: null }) + "\n🏦 likely deposit → Binance");
    expect(items[1].label).toBe(nodeLabel(NODE_B, { addressFormat: "short", chainTag: null }));
  });
});

test("footer band is carved inside the size; long lines shrink, none is cut off", async () => {
  const size = computeExportSize("hd", 2);
  const footer = Array.from({ length: 6 }, (_, i) => String(i).repeat(i < 3 ? 140 : 260));
  await fakeCanvasEnv(async (env) => {
    const canvas = await renderExportCanvas(env.view, storeAB(), { size, addressFormat: "short", footer });
    const fontPx = Math.max(12, Math.round(1920 / 120));
    const band = 6 * Math.round(fontPx * 1.5) + fontPx;
    expect(env.divs[0].style.height).toBe(1080 - band + "px");
    expect(canvas.width).toBe(1920);
    expect(canvas.height).toBe(1080);
    const texts = env.ctx.texts;
    expect(texts.map((t) => t.text)).toEqual(footer);
    const pad = fontPx;
    for (const t of texts) {
      expect(t.text.length * parseFloat(t.font) * 0.6).toBeLessThanOrEqual(1920 - 2 * pad);
      expect(t.y).toBeGreaterThanOrEqual(1080 - band);
      expect(t.x).toBe(pad);
    }
    expect(parseFloat(texts[0].font)).toBe(fontPx); // 140 chars fit at full size
    expect(parseFloat(texts[5].font)).toBeLessThan(fontPx); // 260 chars had to shrink
    expect(parseFloat(texts[5].font)).toBeGreaterThanOrEqual(8);
  });
});

test("no footer -> composite height = raw height, no text drawn", async () => {
  const size = computeExportSize("hd", 2);
  await fakeCanvasEnv(async (env) => {
    const canvas = await renderExportCanvas(env.view, storeAB(), { size, addressFormat: "short" });
    expect(env.divs[0].style.height).toBe(size.h + "px");
    expect(canvas.height).toBe(size.h);
    expect(env.ctx.texts).toEqual([]);
  });
});

test("exportPng and exportPdf forward footer and badge to the canvas render", async () => {
  const deps = { preset: "hd", addressFormat: "short", onLog: () => {}, footer: ["provenance line"], badge: () => "B!" };
  class FakePdf { addImage() {} save() {} }
  for (const run of [(env) => exportPng(env.view, storeAB(), deps), (env) => exportPdf(env.view, storeAB(), { ...deps, jsPDF: FakePdf })]) {
    await fakeCanvasEnv(async (env) => {
      await run(env);
      expect(env.ctx.texts.map((t) => t.text)).toEqual(["provenance line"]);
      expect(env.dataSets[0].items.every((n) => n.label.endsWith("\nB!"))).toBe(true);
    });
  }
});

const bundleDeps = (over = {}) => ({
  preset: "hd", addressFormat: "short", footer: ["f1"], badge: () => null,
  category: () => null, exportedAt: EXPORTED_AT, retrieval: RETR,
  workspaceText: '{"version":3}', queryLogText: '{"entries":[]}',
  manifest: { chains: [{ chainId: "1", name: "Ethereum" }], roots: ["1:" + NODE_A.address], sampling: {}, data: {} },
  ...over,
});

test("bundle: no crypto.subtle -> log.bundleNoCrypto, nothing downloaded", async () => {
  const savedCrypto = globalThis.crypto;
  const logs = [];
  try {
    globalThis.crypto = {};
    await fakeCanvasEnv(async (env) => {
      await exportEvidenceBundle(env.view, storeAB(), bundleDeps({ onLog: (e) => logs.push(e) }));
      expect(env.anchors).toEqual([]);
      expect(env.blobs).toEqual([]);
    });
  } finally {
    globalThis.crypto = savedCrypto;
  }
  expect(logs).toEqual([{ level: "error", key: "log.bundleNoCrypto" }]);
});

test("bundle: PNG omitted when capped, bundle still produced", async () => {
  expect(computeExportSize("auto", 39).capped).toBe(true);
  const nodes = Array.from({ length: 39 }, (_, i) => withId({ ...NODE_B, address: "0x" + String(i).padStart(40, "0") }));
  const store = { ...makeFakeStore(nodes, []), stats: () => ({ nodes: 39, edges: 0 }) };
  const logs = [];
  await fakeCanvasEnv(async (env) => {
    await exportEvidenceBundle(env.view, store, bundleDeps({ preset: "auto", onLog: (e) => logs.push(e) }));
    expect(logs[0]).toEqual({ level: "error", key: "log.bundlePngOmitted", params: { pixels: computeExportSize("auto", 39).pixels } });
    const members = readZip(await blobBytes(env.blobs[0]));
    expect(members.map((m) => m.name)).toEqual(["graph.csv", "workspace.json", "query-log.json", "MANIFEST.json", "SHA256SUMS"]);
    const manifest = JSON.parse(new TextDecoder().decode(members[3].bytes));
    expect(manifest.omitted[0]).toEqual({ name: "graph.png", reason: "too-large" });
    expect(env.dataSets).toEqual([]); // never rendered
  });
});

test("bundle: happy path — six files, CSV bytes = csvText, stamped name, zip sha256 logged", async () => {
  const logs = [];
  const store = storeAB();
  await fakeCanvasEnv(async (env) => {
    await exportEvidenceBundle(env.view, store, bundleDeps({ onLog: (e) => logs.push(e) }));
    const zipBytes = await blobBytes(env.blobs[0]);
    expect(env.blobs[0].type).toBe("application/zip");
    const members = readZip(zipBytes);
    expect(members.map((m) => m.name)).toEqual(["graph.csv", "workspace.json", "graph.png", "query-log.json", "MANIFEST.json", "SHA256SUMS"]);
    expect(members[0].bytes).toEqual(enc(csvText(store, { category: () => null, provenance: { exportedAt: EXPORTED_AT, retrieval: RETR } })));
    expect(members[1].bytes).toEqual(enc('{"version":3}'));
    expect(members[2].bytes).toEqual(Uint8Array.of(0x89, 0x50, 0x4e, 0x47));
    expect(members[3].bytes).toEqual(enc('{"entries":[]}'));
    const manifest = JSON.parse(new TextDecoder().decode(members[4].bytes));
    expect(manifest.graph).toEqual({ nodes: 2, edges: 1 });
    expect(manifest.retrieval).toEqual(RETR);
    expect(manifest.omitted).toEqual([]);
    expect(env.ctx.texts.map((t) => t.text)).toEqual(["f1"]); // footer reached the PNG
    expect(env.anchors).toHaveLength(1);
    expect(env.anchors[0]).toMatch(/^chainmap-evidence-\d{8}T\d{6}Z\.zip$/);
    expect(env.anchors[0]).toBe("chainmap-evidence-20261116T101530Z.zip");
    const done = logs.at(-1);
    expect(done.key).toBe("log.bundleExported");
    expect(done.params).toEqual({ sha256: await sha256Hex(zipBytes), files: 6 });
  });
});

test("bundle: the store changing during the PNG render does not skew MANIFEST graph counts (all snapshotted at click)", async () => {
  const nodes = [withId(NODE_A), withId(NODE_B)];
  const edges = [EDGE_1];
  const store = { listNodes: () => nodes, listEdges: () => edges, stats: () => ({ nodes: nodes.length, edges: edges.length }) };
  await fakeCanvasEnv(async (env) => {
    const create = document.createElement;
    document.createElement = (tag) => {
      const el = create(tag);
      if (tag === "canvas") {
        el.toBlob = (cb) => {
          nodes.push(withId({ ...NODE_B, address: "0x" + "c".repeat(40) })); // a scan adds data mid-export
          edges.push(EDGE_2);
          setTimeout(() => cb(new Blob([Uint8Array.of(0x89)])), 0);
        };
      }
      return el;
    };
    await exportEvidenceBundle(env.view, store, bundleDeps({ onLog: () => {} }));
    const members = readZip(await blobBytes(env.blobs[0]));
    const rows = new TextDecoder().decode(members[0].bytes).split("\n").slice(2);
    const manifest = JSON.parse(new TextDecoder().decode(members[4].bytes));
    expect(manifest.graph).toEqual({
      nodes: rows.filter((r) => r.startsWith("node,")).length,
      edges: rows.filter((r) => r.startsWith("edge,")).length,
    });
    expect(manifest.graph).toEqual({ nodes: 2, edges: 1 });
  });
});

test("bundle: null toBlob or a render failure -> log.bundleFailed, nothing downloaded, never rejects", async () => {
  const breakers = [
    () => {
      const create = document.createElement;
      document.createElement = (tag) => {
        const el = create(tag);
        if (tag === "canvas") el.toBlob = (cb) => cb(null);
        return el;
      };
    },
    () => { window.vis.Network = class { constructor() { throw new Error("boom"); } }; },
  ];
  for (const breakIt of breakers) {
    const logs = [];
    await fakeCanvasEnv(async (env) => {
      breakIt();
      await expect(exportEvidenceBundle(env.view, storeAB(), bundleDeps({ onLog: (e) => logs.push(e) }))).resolves.toBeUndefined();
      expect(env.anchors).toEqual([]);
      expect(env.blobs).toEqual([]);
    });
    expect(logs).toEqual([{ level: "error", key: "log.bundleFailed" }]);
  }
});

// ---------------------------------------------------------------------------
// usd_value column (P6): last column, blank unless the price is ok.
// ---------------------------------------------------------------------------

describe("usd_value", () => {
  const OLD_HEADER = CSV_HEADER_LINE.replace(",usd_value", "").split(",");
  const okR = (text) => ({ state: "ok", cents: 1n, text, price: 1, at: 0, confidence: 1 });
  const results = [okR("2000.00"), { state: "pending" }, { state: "none" }, { state: "error" }, { state: "skip", reason: "nft" }, okR("<0.01")];
  const sixEdges = results.map((_, i) => ({ ...EDGE_1, key: "u" + i }));
  const usd = (e) => results[Number(e.key.slice(1))];
  const storeSix = () => makeFakeStore([withId(NODE_A)], sixEdges);

  test("usd_value is the last header column; existing positions unchanged", () => {
    const rows = buildCsvRows(storeSix(), { category: () => null });
    expect(rows[1].at(-1)).toBe("usd_value");
    expect(rows[1].slice(0, -1)).toEqual(OLD_HEADER);
  });

  test("blank when off", () => {
    const rows = buildCsvRows(makeFakeStore([withId(NODE_A)], [EDGE_1]), { category: () => null });
    expect(rows.slice(2).every((r) => r.at(-1) === "")).toBe(true);
    expect(rows[0][0]).not.toContain("usd_value");
  });

  test("filled only when ok", () => {
    const rows = buildCsvRows(storeSix(), { category: () => null, usd });
    const body = rows.slice(2);
    expect(body[0].at(-1)).toBe(""); // node row
    const cells = body.slice(1).map((r) => r.at(-1));
    expect(cells).toEqual(["2000.00", "", "", "", "", "<0.01"]);
    expect(cells.some((c) => c === "0" || c === "0.00")).toBe(false);
  });

  test("line 1 caveat with counts, comma-free", () => {
    const rows = buildCsvRows(storeSix(), { category: () => null, usd, provenance: { exportedAt: EXPORTED_AT, retrieval: RETR } });
    expect(rows[0][0]).toContain("usd priced 2 of 5 priceable transfers");
    expect(rows[0][0].includes(",")).toBe(false);
    const caveat = "; usd_value is an estimate (DefiLlama coins.llama.fi price within 1h of the transaction) - blank when unknown/unpriced/pending - amounts are exact in tokens; usd priced 2 of 5 priceable transfers (NFT/zero-value/imitation/spam-list/root-contract/unknown-data/unsupported-chain transfers are never priced)";
    expect(rows[0][0]).toContain(caveat + "; exported ");
    expect(csvText(storeSix(), { category: () => null, usd }).split("\n")[0].startsWith('"')).toBe(false);
  });

  test("exportCsv forwards usd", () => {
    exportCsv(makeFakeStore([withId(NODE_A)], [EDGE_1]), { onLog: () => {}, category: () => null, usd: () => okR("1.00") });
    expect(capturedCsvText()).toContain("usd priced 1 of 1");
  });

  test("bundle csv forwards usd", async () => {
    const store = storeAB();
    const u = () => okR("1.00");
    await fakeCanvasEnv(async (env) => {
      await exportEvidenceBundle(env.view, store, bundleDeps({ onLog: () => {}, usd: u }));
      const members = readZip(await blobBytes(env.blobs[0]));
      const text = new TextDecoder().decode(members[0].bytes);
      expect(text).toContain("usd priced 1 of 1");
      expect(members[0].bytes).toEqual(enc(csvText(store, { category: () => null, usd: u, provenance: { exportedAt: EXPORTED_AT, retrieval: RETR } })));
    });
  });
});

test("CSV real_recipient of a bridge call is the bridge (tx to), not the decoded destRecipient", () => {
  const DEST = "0x" + "d".repeat(40);
  const edge = { ...EDGE_1, hasData: true, methodId: "0x4faa8a26", methodArgs: [{ type: "address", value: DEST, name: "destRecipient" }] };
  const row = buildCsvRows(makeFakeStore([], [edge]), { category: () => null }).find((r) => r[0] === "edge");
  expect(row[14]).toBe("depositEtherFor(address)");
  expect(row[15]).toBe(EDGE_1.to);
});
