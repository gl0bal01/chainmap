// Stage C integration test — drives the REAL main.js composition root under a DOM
// emulator (happy-dom) with window.vis + fetch stubbed, so a full scan runs with
// NO browser and NO API key. Also asserts the real ui.js renderers are XSS-inert.
import { test, expect, beforeAll } from "bun:test";
import { Window } from "happy-dom";
import KNOWN from "../data/known-addresses.json";
import V2 from "./fixtures/workspace-v2.json";
import { PROBE_CHAIN_IDS } from "../src/config.js";

const A = (n) => "0x" + String(n).repeat(40).slice(0, 40); // 40-hex address helper
const ROOT = A(1), N2 = A(2), N3 = A(3), N4 = A(4), TOKEN = A(9);
const ID = (chainId, a) => `${chainId}:${a}`; // store node id (= vis node id)

// Canned Etherscan responses keyed by `action`. Includes a FAILED tx (must be
// dropped) and a token transfer (distinct contract).
const CANNED = {
  txlist: [
    { from: ROOT, to: N2, value: "1000000000000000000", hash: "0xaaa", isError: "0", txreceipt_status: "1", timeStamp: "1700000000", blockNumber: "100" },
    { from: ROOT, to: N3, value: "500000000000000000", hash: "0xbad", isError: "1", txreceipt_status: "0", timeStamp: "1700000001", blockNumber: "101" }, // FAILED -> dropped
  ],
  tokentx: [
    { from: ROOT, to: N4, value: "5000000", hash: "0xccc", tokenSymbol: "USDC", tokenDecimal: "6", contractAddress: TOKEN, timeStamp: "1700000002", blockNumber: "102" },
  ],
};

// Every Etherscan (non-`data/`) URL main.js requests, in order.
const apiUrls = [];
// How many times main.js has received data/known-addresses.json (see knownLoaded()).
let knownLoads = 0;
let spamLoads = 0;
// Spam list served instead of the real (empty) data/spam-tokens.json: dedicated
// contracts no other test uses, so existing expectations are unaffected.
const SPAM_STAR = "0x" + "c".repeat(40), SPAM_137 = "0x" + "d".repeat(40);
const SPAM_FIXTURE = { "*": [SPAM_STAR], "137": [SPAM_137] };
// When set, API fetches wait on it (abortable via the request signal) so a test
// can hold a scan/load in flight deterministically.
let apiGate = null;

function stubFetch() {
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    // Local bundled datasets (known-addresses / spam-tokens / demo-workspace): serve the real files.
    if (u.includes("data/")) {
      const path = u.replace(/^\.?\//, "");
      try {
        const text = await Bun.file(path).text();
        const json = async () => {
          const data = JSON.parse(text);
          if (path.includes("known-addresses")) knownLoads++;
          if (path.includes("spam-tokens")) { spamLoads++; return SPAM_FIXTURE; }
          return data;
        };
        return { ok: true, status: 200, headers: { get: () => null }, json };
      } catch {
        return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) };
      }
    }
    apiUrls.push(u);
    if (apiGate) {
      await new Promise((resolve, reject) => {
        apiGate.then(resolve);
        if (init && init.signal) {
          init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
        }
      });
    }
    const action = new URL(u).searchParams.get("action");
    const result = CANNED[action] || [];
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ status: result.length ? "1" : "0", message: result.length ? "OK" : "No transactions found", result: result.length ? result : "No transactions found" }),
    };
  };
}

function stubVis() {
  class FakeDataSet {
    constructor(init) { this.items = new Map(); if (init) this.add(init); }
    add(o) { for (const it of [].concat(o)) this.items.set(it.id, it); }
    update(o) { for (const it of [].concat(o)) this.items.set(it.id, { ...(this.items.get(it.id) || {}), ...it }); }
    remove(id) { for (const i of [].concat(id)) this.items.delete(i); }
    clear() { this.items.clear(); }
    get(id) { return id === undefined ? [...this.items.values()] : this.items.get(id) || null; }
    getIds() { return [...this.items.keys()]; }
    get length() { return this.items.size; }
  }
  class FakeDataView {
    constructor(ds, opts) { this.ds = ds; this.filter = (opts && opts.filter) || (() => true); }
    get(id) {
      if (id !== undefined) { const it = this.ds.get(id); return it && this.filter(it) ? it : null; }
      return this.ds.get().filter(this.filter);
    }
    getIds() { return this.get().map((i) => i.id); }
    refresh() {}
    get length() { return this.get().length; }
  }
  class FakeNetwork {
    constructor(container, data) { FakeNetwork.first = FakeNetwork.first || this; FakeNetwork.last = this; this.nodes = data.nodes; this.edges = data.edges; this._sel = []; this._on = {}; }
    on(ev, fn) { (this._on[ev] = this._on[ev] || []).push(fn); }
    off(ev, fn) { this._on[ev] = (this._on[ev] || []).filter((f) => f !== fn); }
    getSelectedNodes() { return this._sel; }
    setSelection({ nodes }) { this._sel = nodes || []; }
    setData(data) { this.nodes = data.nodes; this.edges = data.edges; }
    setOptions() {}
    getConnectedEdges(id) { return this.edges.get().filter((e) => e.from === id || e.to === id).map((e) => e.id); }
    getPositions(ids) { const o = {}; for (const id of ids || this.nodes.getIds()) o[id] = { x: 0, y: 0 }; return o; }
    once() {} moveNode() {} fit() {} destroy() {} DOMtoCanvas(p) { return p; }
  }
  FakeNetwork.first = null;
  return { DataSet: FakeDataSet, DataView: FakeDataView, Network: FakeNetwork };
}

beforeAll(async () => {
  const html = (await Bun.file(new URL("../index.html", import.meta.url)).text())
    .replace(/<script[\s\S]*?<\/script>/g, ""); // strip vendored + module scripts; we import main.js ourselves
  const window = new Window({ url: "http://localhost/" });
  window.document.write(html);
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.localStorage = window.localStorage;
  globalThis.sessionStorage = window.sessionStorage;
  globalThis.navigator = window.navigator;
  globalThis.Event = window.Event; // main.js dispatches `new Event("change")` on happy-dom elements
  globalThis.Node = window.Node; // browser builtin ui.js relies on (value instanceof Node)
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  window.vis = stubVis();
  window.jspdf = { jsPDF: class {} };
  stubFetch();
  await import("../src/main.js"); // runs init() (document is 'complete')
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);

test("shell renders in English by default", () => {
  expect($("startBtn").textContent).toBe("Start scan");
  expect($("stopBtn").textContent).toBe("Stop");
});

test("real scan renders graph, drops failed tx, reports sampled counts", async () => {
  $("apiKey").value = "TESTKEY";
  $("address").value = ROOT;
  $("depth").value = "1"; // bound: root expanded, neighbors added-not-expanded
  $("startBtn").click();

  // poll until the status line shows completion
  let text = "";
  for (let i = 0; i < 60; i++) {
    text = $("status").textContent || "";
    if (/Done/.test(text)) break;
    await sleep(50);
  }
  // 3 nodes (root, N2, N4) — N3 dropped because its tx failed; 2 edges (tx1, token)
  expect(text).toBe("Done — 3 addresses, 2 links");
  expect($("samplingBanner").hidden).toBe(false);
  expect($("samplingBanner").textContent).toContain("latest 20"); // maxTx default
});

test("language toggle switches every string live (EN -> FR)", () => {
  expect($("startBtn").textContent).toBe("Start scan");
  $("langToggle").click();
  expect($("startBtn").textContent).toBe("Lancer le scan");
  expect($("stopBtn").textContent).toBe("Arrêter");
  expect(document.documentElement.getAttribute("lang")).toBe("fr");
  $("langToggle").click(); // back to EN for isolation
  expect($("startBtn").textContent).toBe("Start scan");
});

test("display filters hide edges live without touching the store", async () => {
  const { GraphStore } = await import("../src/graphStore.js");
  const { createGraphView } = await import("../src/render/network.js");
  const store = new GraphStore();
  const view = createGraphView(document.createElement("div"), store, {
    i18n: { t: (k) => k },
    getAddressFormat: () => "short",
  });
  store.addNode("1", ROOT, { depth: 0, isRoot: true });
  store.addNode("1", N2, { depth: 1 });
  store.addNode("1", N4, { depth: 1 });
  store.addEdge({ chainId: "1", action: "txlist", group: "normal", color: "#000", from: ROOT, to: N2, tx: { value: "1000000000000000000", hash: "0x1", tokenDecimal: "18" } }); // 1
  store.addEdge({ chainId: "1", action: "txlist", group: "normal", color: "#000", from: ROOT, to: N4, tx: { value: "5000000000000000000", hash: "0x2", tokenDecimal: "18" } }); // 5

  expect(view.network.edges.get().length).toBe(2);
  view.setDisplayOptions({ minAmount: 3 });
  expect(view.network.edges.get().length).toBe(1); // only the "5" survives
  expect(store.listEdges().length).toBe(2); // store is the full truth, untouched
  view.setDisplayOptions({ minAmount: 0 });
  expect(view.network.edges.get().length).toBe(2); // filter reversible
});

test("edge bundling collapses parallel A->B edges; store keeps per-tx rows", async () => {
  const { GraphStore } = await import("../src/graphStore.js");
  const { createGraphView } = await import("../src/render/network.js");
  const store = new GraphStore();
  const view = createGraphView(document.createElement("div"), store, {
    i18n: { t: (k) => k },
    getAddressFormat: () => "short",
  });
  store.addNode("1", ROOT, { depth: 0, isRoot: true });
  store.addNode("1", N2, { depth: 1 });
  store.addEdge({ chainId: "1", action: "txlist", group: "normal", color: "#0", from: ROOT, to: N2, tx: { value: "1000000000000000000", hash: "0x1", tokenDecimal: "18" } });
  store.addEdge({ chainId: "1", action: "txlist", group: "normal", color: "#0", from: ROOT, to: N2, tx: { value: "2000000000000000000", hash: "0x2", tokenDecimal: "18" } });

  expect(view.network.edges.get().length).toBe(2);
  view.setBundling(true);
  const bundled = view.network.edges.get();
  expect(bundled.length).toBe(1); // two A->B collapse into one arrow
  expect(bundled[0].data.count).toBe(2);
  expect(bundled[0].data.memberKeys.length).toBe(2); // per-tx keys preserved for drill-down
  expect(store.listEdges().length).toBe(2); // store still holds both per-tx rows
  view.setBundling(false);
  expect(view.network.edges.get().length).toBe(2); // reversible
});

test("reset clears annotations; bundled arrows rebuild on prune (review fixes)", async () => {
  const { GraphStore } = await import("../src/graphStore.js");
  const { createGraphView } = await import("../src/render/network.js");
  const store = new GraphStore();
  const view = createGraphView(document.createElement("div"), store, { i18n: { t: (k) => k }, getAddressFormat: () => "short" });

  view.addAnnotation("ghost note");
  expect(view.getAnnotations().length).toBe(1);
  store.reset();
  expect(view.getAnnotations().length).toBe(0); // no stale annotations leak into next graph

  store.addNode("1", ROOT, { depth: 0, isRoot: true });
  store.addNode("1", N2, { depth: 1 });
  store.addEdge({ chainId: "1", action: "txlist", group: "normal", color: "#0", from: ROOT, to: N2, tx: { value: "1000000000000000000", hash: "0x1", tokenDecimal: "18" } });
  view.setBundling(true);
  expect(view.network.edges.get().length).toBe(1);
  store.removeNodes([ID("1", N2)]);
  expect(view.network.edges.get().length).toBe(0); // bundle rebuilt after the member was pruned
});

test("demo mode loads the bundled workspace through real main.js (no API key)", async () => {
  $("apiKey").value = ""; // demo must work with NO key
  $("demoBtn").click();
  let log = "";
  for (let i = 0; i < 60; i++) {
    log = $("logContent").textContent || "";
    if (/Demo workspace loaded/.test(log)) break;
    await sleep(25);
  }
  expect(log).toContain("Demo workspace loaded"); // parseWorkspace -> applyWorkspace -> loadSnapshot ran cleanly
});

test("edge details decode the 4-byte method selector for contract calls", async () => {
  const ui = await import("../src/ui.js");
  const container = document.createElement("div");
  ui.renderEdgeDetails(container, {
    key: "k", action: "txlist", group: "normal", from: ROOT, to: N2, hash: "0x1",
    symbol: "ETH", amountText: "5", amountIndeterminate: false, tokenContract: "", tokenId: "",
    value: "5", timeStamp: "1700000000", blockNumber: "1",
    hasData: true, methodId: "0x7ff36ab5",
  }, { i18n: { t: (k) => k, getLocale: () => "en" }, explorer: "etherscan.io", getAlias: () => null });
  expect(container.textContent).toContain("0x7ff36ab5");
  expect(container.textContent).toContain("swapExactETHForTokens"); // decoded signature shown
});

test("edge details surface a human-readable UTF-8 message hidden in calldata", async () => {
  const ui = await import("../src/ui.js");
  const i18n = { t: (k) => k, getLocale: () => "en" };
  const msg = "gm fren, wagmi";
  const rawInput = "0x" + Array.from(new TextEncoder().encode(msg)).map((b) => b.toString(16).padStart(2, "0")).join("");

  const withText = document.createElement("div");
  ui.renderEdgeDetails(withText, {
    key: "k", action: "txlist", group: "normal", from: ROOT, to: N2, hash: "0x1",
    symbol: "ETH", amountText: "1", amountIndeterminate: false, tokenContract: "", tokenId: "",
    value: "1", timeStamp: "1", blockNumber: "1", hasData: true, methodId: "", methodArgs: [], rawInput,
  }, { i18n, explorer: "etherscan.io", getAlias: () => null });
  expect(withText.textContent).toContain("details.inputText"); // row label rendered
  expect(withText.textContent).toContain(msg); // the decoded message itself

  // ABI-encoded binary (transfer) has no readable text -> no inputText row.
  const noText = document.createElement("div");
  ui.renderEdgeDetails(noText, {
    key: "k", action: "txlist", group: "normal", from: ROOT, to: N2, hash: "0x1",
    symbol: "ETH", amountText: "1", amountIndeterminate: false, tokenContract: "", tokenId: "",
    value: "1", timeStamp: "1", blockNumber: "1",
    hasData: true, methodId: "0xa9059cbb", methodArgs: [], rawInput: "0xa9059cbb" + "0".repeat(128),
  }, { i18n, explorer: "etherscan.io", getAlias: () => null });
  expect(noText.textContent).not.toContain("details.inputText");
});

test("appbar search button opens the command palette (touch-reachable, no Ctrl+K)", () => {
  const palette = document.getElementById("palette");
  const btn = document.getElementById("searchBtn");
  expect(btn).not.toBeNull();
  expect(palette.hidden).toBe(true); // closed initially
  btn.click();
  expect(palette.hidden).toBe(false); // same modal Ctrl/Cmd+K opens
});

test("node details show risk; edge details show decoded args", async () => {
  const ui = await import("../src/ui.js");
  const i18n = { t: (k) => k, getLocale: () => "en" };

  const nc = document.createElement("div");
  ui.renderNodeDetails(nc, { address: ROOT, depth: 0, isRoot: true, alias: null }, {
    i18n, explorer: "etherscan.io", onRename: () => {},
    risk: { level: "high", reasons: ["risk.cycle", "risk.sink"] },
  });
  expect(nc.textContent).toContain("risk.high");
  expect(nc.textContent).toContain("risk.cycle"); // reasons surfaced

  const ec = document.createElement("div");
  ui.renderEdgeDetails(ec, {
    key: "k", action: "txlist", group: "normal", from: ROOT, to: N2, hash: "0x1",
    symbol: "ETH", amountText: "1", amountIndeterminate: false, tokenContract: "", tokenId: "",
    value: "1", timeStamp: "1", blockNumber: "1",
    hasData: true, methodId: "0xa9059cbb", methodArgs: [{ type: "address", value: N4 }],
  }, { i18n, explorer: "etherscan.io", getAlias: () => null });
  expect(ec.textContent).toContain(N4); // decoded transfer recipient revealed
});

test("edge details render an interpolated call summary + risk flags for calldata", async () => {
  const { createI18n } = await import("../src/i18n.js");
  const en = (await import("../src/locales/en.js")).default;
  const fr = (await import("../src/locales/fr.js")).default;
  const ui = await import("../src/ui.js");
  const i18n = createI18n({ dictionaries: { en, fr }, locale: "en" });

  // approve(spender, MAX_UINT256) -> summary line + "unlimited approval" flag.
  const MAX_UINT256 = (2n ** 256n - 1n).toString();
  const container = document.createElement("div");
  ui.renderEdgeDetails(container, {
    key: "k", action: "txlist", group: "normal", from: ROOT, to: N4, hash: "0x1",
    symbol: "USDC", amountText: "0", amountIndeterminate: false, tokenContract: TOKEN, tokenId: "",
    value: "0", timeStamp: "1700000000", blockNumber: "1",
    hasData: true, methodId: "0x095ea7b3",
    methodArgs: [
      { type: "address", value: N4, name: "spender" },
      { type: "uint256", value: MAX_UINT256, name: "amount" },
    ],
  }, { i18n, explorer: "etherscan.io", getAlias: () => null });

  expect(container.textContent).toContain("►"); // summary row rendered
  expect(container.textContent).toContain("Approve"); // real i18n text, not the raw "summary.approve" key
  expect(container.textContent).not.toContain("{amount}"); // params were interpolated, not left literal
  expect(container.textContent).not.toContain("{spender}");
  expect(container.textContent).toContain("⚠"); // risk-flags row rendered
  expect(container.textContent).toContain("unlimited approval"); // flag.approvalUnlimited resolved
  expect(container.textContent).toContain("spender"); // decoded arg uses its named role, not "#1 address"
});

test("edge details skip the summary row when decoded params are unresolved (legacy edge without named args), but still show a summary with no placeholders", async () => {
  const { createI18n } = await import("../src/i18n.js");
  const en = (await import("../src/locales/en.js")).default;
  const fr = (await import("../src/locales/fr.js")).default;
  const ui = await import("../src/ui.js");
  const i18n = createI18n({ dictionaries: { en, fr }, locale: "en" });

  // transfer(recipient, amount), but methodArgs are missing `name` — e.g. a workspace
  // saved before named-args existed. argByName finds nothing -> summary.params values
  // are all null. Rendering "Transfer {amount} -> {recipient}" verbatim would be worse
  // than no summary row at all, so it must be skipped entirely.
  const legacy = document.createElement("div");
  ui.renderEdgeDetails(legacy, {
    key: "k", action: "txlist", group: "normal", from: ROOT, to: N4, hash: "0x1",
    symbol: "USDC", amountText: "5", amountIndeterminate: false, tokenContract: TOKEN, tokenId: "",
    value: "5000000", timeStamp: "1700000000", blockNumber: "1",
    hasData: true, methodId: "0xa9059cbb",
    methodArgs: [
      { type: "address", value: N4 }, // no `name`
      { type: "uint256", value: "5000000" }, // no `name`
    ],
  }, { i18n, explorer: "etherscan.io", getAlias: () => null });
  expect(legacy.textContent).not.toContain("{amount}"); // no literal placeholder leaked
  expect(legacy.textContent).not.toContain("{recipient}");
  expect(legacy.textContent).not.toContain("►"); // summary row not rendered at all

  // Tornado-style deposit(bytes32) -> summary.mixerDeposit with an EMPTY params object.
  // Empty params has no placeholders to fail to resolve, so it must still render.
  const mixer = document.createElement("div");
  ui.renderEdgeDetails(mixer, {
    key: "k", action: "txlist", group: "normal", from: ROOT, to: N4, hash: "0x2",
    symbol: "ETH", amountText: "1", amountIndeterminate: false, tokenContract: "", tokenId: "",
    value: "1000000000000000000", timeStamp: "1700000000", blockNumber: "1",
    hasData: true, methodId: "0xb214faa5",
    methodArgs: [{ type: "bytes32", value: "0x00" }],
  }, { i18n, explorer: "etherscan.io", getAlias: () => null });
  expect(mixer.textContent).toContain("►"); // summary row still rendered (no placeholders to fail)
  expect(mixer.textContent).toContain(i18n.t("summary.mixerDeposit")); // real i18n text
});

test("edge details format decoded amounts using the edge's real token decimals, never a silent 18 default", async () => {
  const { createI18n } = await import("../src/i18n.js");
  const en = (await import("../src/locales/en.js")).default;
  const fr = (await import("../src/locales/fr.js")).default;
  const ui = await import("../src/ui.js");
  const i18n = createI18n({ dictionaries: { en, fr }, locale: "en" });

  // transfer(recipient, amount) of 5,000,000 base units of a 6-decimal token (USDC-like) == 5 tokens.
  // If tokenDecimal were lost off the edge (undefined -> formatUnits silently assumes 18), this would
  // render as "0.000005" (5000000 / 1e18) instead of the true "5" — a confidently WRONG magnitude.
  const baseEdge = {
    key: "k", action: "txlist", group: "normal", from: ROOT, to: N4, hash: "0x1",
    symbol: "USDC", amountText: "5", amountIndeterminate: false, tokenContract: TOKEN, tokenId: "",
    value: "5000000", timeStamp: "1700000000", blockNumber: "1",
    hasData: true, methodId: "0xa9059cbb",
    methodArgs: [
      { type: "address", value: N4, name: "recipient" },
      { type: "uint256", value: "5000000", name: "amount" },
    ],
  };

  // Known decimals ("6", as graphStore.addEdge now persists from tx.tokenDecimal) -> correct
  // magnitude in both the decoded-arg row and the interpolated call summary.
  const known = document.createElement("div");
  ui.renderEdgeDetails(known, { ...baseEdge, tokenDecimal: "6" }, { i18n, explorer: "etherscan.io", getAlias: () => null });
  expect(known.textContent).toContain("5.000000 USDC"); // decoded arg row: correct 6-decimal magnitude (ui.js uses raw formatUnits text, untrimmed)
  expect(known.textContent).toContain("Transfer 5.000000 USDC"); // summary row: correct 6-decimal magnitude
  expect(known.textContent).not.toContain("0.000000 USDC"); // NOT the wrong 18-decimal magnitude (5000000 base units / 1e18 rounds to 0 at 6 fractional digits)

  // Unknown decimals ("", as graphStore.addEdge persists when tx.tokenDecimal is absent) -> honest
  // raw fallback in both spots, never a silently-wrong 18-decimal number.
  const unknown = document.createElement("div");
  ui.renderEdgeDetails(unknown, { ...baseEdge, tokenDecimal: "" }, { i18n, explorer: "etherscan.io", getAlias: () => null });
  expect(unknown.textContent).toContain("5000000 (raw)"); // decoded arg row: raw, not formatted
  expect(unknown.textContent).toContain("Transfer 5000000"); // summary row: raw, not formatted
  expect(unknown.textContent).not.toContain("0.000000 USDC"); // NOT the wrong 18-decimal magnitude
  expect(unknown.textContent).not.toContain("5.000000 USDC"); // NOT the (unrelated) correct 6-decimal magnitude either
});

test("workspace serialize -> parse -> loadSnapshot round-trips through the store", async () => {
  const { GraphStore } = await import("../src/graphStore.js");
  const { serializeWorkspace, parseWorkspace } = await import("../src/workspace.js");
  const a = new GraphStore();
  a.addNode("1", ROOT, { depth: 0, isRoot: true });
  a.addNode("1", N2, { depth: 1 });
  a.setAlias(ID("1", N2), "friend");
  a.addEdge({ chainId: "1", action: "txlist", group: "normal", color: "#0", from: ROOT, to: N2, tx: { value: "1000000000000000000", hash: "0x1", tokenDecimal: "18" } });

  const ws = serializeWorkspace({ root: ROOT, nodes: a.listNodes(), edges: a.listEdges(), filters: {}, layout: "force", annotations: [] });
  const res = parseWorkspace(JSON.stringify(ws));
  expect(res.ok).toBe(true);

  const b = new GraphStore();
  b.loadSnapshot(res.data.nodes, res.data.edges);
  expect(b.stats()).toEqual({ nodes: 2, edges: 1 });
  expect(b.getAlias(ID("1", N2))).toBe("friend");
  expect(b.checkInvariants().ok).toBe(true); // restored graph holds all invariants
});

test("ui renderers are XSS-inert (alias + spoofed token symbol)", async () => {
  const ui = await import("../src/ui.js");
  const container = document.createElement("div");
  const payload = '<img src=x onerror="alert(1)">';

  // Node details with a malicious alias
  ui.renderNodeDetails(container, { address: ROOT, depth: 0, isRoot: true, alias: payload }, {
    i18n: { t: (k) => k, getLocale: () => "en" },
    explorer: "etherscan.io",
    onRename: () => {},
  });
  expect(container.querySelector("img")).toBeNull(); // payload NOT parsed as HTML
  expect(container.textContent).toContain(payload); // present, but as inert text

  // Edge details with a spoofed token symbol
  const container2 = document.createElement("div");
  ui.renderEdgeDetails(container2, {
    key: "k", action: "tokentx", group: "token", from: ROOT, to: N2, hash: "0xabc",
    symbol: payload, amountText: "1", amountIndeterminate: false, tokenContract: TOKEN,
    tokenId: "", value: "1", timeStamp: "1700000000", blockNumber: "1",
  }, {
    i18n: { t: (k) => k, getLocale: () => "en" },
    explorer: "etherscan.io",
    getAlias: () => null,
  });
  expect(container2.querySelector("img")).toBeNull();
  expect(container2.textContent).toContain(payload);
});

test("decoded input words show the integer; address-shaped words marked as candidates (never hide the value)", async () => {
  const ui = await import("../src/ui.js");
  const container = document.createElement("div");

  // Build a transfer(recipient, amount) calldata where amount = 1 ETH (10^18).
  // The amount word is address-shaped (< 2^160), so pre-fix would show ONLY the
  // address interpretation, hiding the true integer. Post-fix shows the integer
  // first, then marks the address as a candidate.
  const ONE_ETH_HEX = (10n ** 18n).toString(16); // "de0b6b3a7640000"
  const recipientPadded = "0000000000000000000000004444444444444444444444444444444444444444"; // N4 padded to 64
  const amountPadded = ONE_ETH_HEX.padStart(64, "0"); // amount padded to 64
  const rawInput = "0xa9059cbb" + recipientPadded + amountPadded; // selector + word1 + word2

  ui.renderEdgeDetails(container, {
    key: "k", action: "txlist", group: "normal", from: ROOT, to: N2, hash: "0x1",
    symbol: "ETH", amountText: "1", amountIndeterminate: false, tokenContract: "", tokenId: "",
    value: "1000000000000000000", timeStamp: "1700000000", blockNumber: "1",
    hasData: true, methodId: "0xa9059cbb", rawInput,
  }, { i18n: { t: (k) => k, getLocale: () => "en" }, explorer: "etherscan.io", getAlias: () => null });

  // The decoded input section must show the integer value of the amount word,
  // not hide it behind the address interpretation.
  expect(container.textContent).toContain("1000000000000000000");
  // And the recipient word must be marked as a candidate address with "addr?".
  expect(container.textContent).toContain("addr?");
});

test("node details render a Source provenance row only when getKnownSource returns a value (XSS-inert)", async () => {
  const { createI18n } = await import("../src/i18n.js");
  const en = (await import("../src/locales/en.js")).default;
  const fr = (await import("../src/locales/fr.js")).default;
  const ui = await import("../src/ui.js");
  const i18n = createI18n({ dictionaries: { en, fr }, locale: "en" });
  const node = { address: ROOT, depth: 0, isRoot: false, alias: null };

  // WITH a source -> the "Source" row renders with the provenance string (real i18n label).
  const withSrc = document.createElement("div");
  ui.renderNodeDetails(withSrc, node, {
    i18n, explorer: "etherscan.io", onRename: () => {},
    getKnownSource: () => "OFAC SDN 2022",
  });
  expect(withSrc.textContent).toContain(i18n.t("details.source")); // "Source", not the raw key
  expect(withSrc.textContent).toContain("OFAC SDN 2022"); // provenance shown

  // dep ABSENT -> no provenance row, no crash.
  const noDep = document.createElement("div");
  ui.renderNodeDetails(noDep, node, { i18n, explorer: "etherscan.io", onRename: () => {} });
  expect(noDep.textContent).not.toContain(i18n.t("details.source")); // no "Source" row at all

  // dep returns null (address has no source) -> no provenance row.
  const nullSrc = document.createElement("div");
  ui.renderNodeDetails(nullSrc, node, {
    i18n, explorer: "etherscan.io", onRename: () => {},
    getKnownSource: () => null,
  });
  expect(nullSrc.textContent).not.toContain(i18n.t("details.source")); // no "Source" row at all

  // XSS: a malicious source string is inert (textContent, never parsed as HTML).
  const xss = document.createElement("div");
  const payload = '<img src=x onerror="alert(1)">';
  ui.renderNodeDetails(xss, node, {
    i18n, explorer: "etherscan.io", onRename: () => {},
    getKnownSource: () => payload,
  });
  expect(xss.querySelector("img")).toBeNull(); // NOT parsed as HTML
  expect(xss.textContent).toContain(payload); // present as inert text
});

test("demo workspace showcases every investigator overlay (6 categories, all 5 risk flags, peel chain, NFT) and holds store invariants", async () => {
  const { parseWorkspace } = await import("../src/workspace.js");
  const { GraphStore } = await import("../src/graphStore.js");
  const { flagsForEdge } = await import("../src/riskFlags.js");
  const { findPeelChains } = await import("../src/peelChain.js");
  const { knownCategory } = await import("../src/knownAddresses.js");

  const demo = JSON.parse(await Bun.file(new URL("../data/demo-workspace.json", import.meta.url)).text());
  const knownData = JSON.parse(await Bun.file(new URL("../data/known-addresses.json", import.meta.url)).text());
  const cat = (a) => knownCategory(a, "1", knownData);
  const dNodes = demo.graph.nodes;
  const dEdges = demo.graph.edges;
  const flagsOf = (hash) => flagsForEdge(dEdges.find((e) => e.hash === hash), { category: cat });

  // Store invariants: every edge endpoint resolves to a node. A corrupted/typo'd
  // address would drop the edge (endpoint invariant) — this catches it.
  const parsed = parseWorkspace(JSON.stringify(demo));
  expect(parsed.ok).toBe(true);
  const store = new GraphStore();
  store.loadSnapshot(parsed.data.nodes, parsed.data.edges);
  expect(store.checkInvariants().ok).toBe(true);
  expect(store.listEdges().length).toBe(dEdges.length); // no edge silently dropped
  expect(demo.version).toBe(3);
  expect(store.chains()).toEqual(["1", "42161"]);
  const { addressEvidence, sameAddressLinks } = await import("../src/chainTwins.js");
  const { CHAINS } = await import("../src/config.js");
  const keyLinks = sameAddressLinks(store.listNodes(), addressEvidence(store.listEdges(), CHAINS)).filter((l) => l.basis === "key");
  const F3 = "0xf00d000000000000000000000000000000000003";
  expect(keyLinks.length).toBe(1);
  expect(keyLinks[0]).toMatchObject({ address: F3, a: ID("1", F3), b: ID("42161", F3) });

  // All 6 known categories appear as labeled nodes (the demo's USDC is a canonical `token`).
  const cats = new Set(dNodes.filter((n) => n.chainId === "1").map((n) => cat(n.address)).filter(Boolean));
  for (const c of ["sanctioned", "mixer", "bridge", "exchange", "router", "token"]) {
    expect(cats.has(c)).toBe(true);
  }

  // All 5 risk-flag types fire in the demo.
  expect(flagsOf("0xb1")).toContain("flag.approvalUnlimited"); // approve(spender, MAX_UINT)
  expect(flagsOf("0xb2")).toContain("flag.hiddenRecipient");   // transfer recipient != tx target
  expect(flagsOf("0xa2")).toContain("flag.mixer");             // Tornado deposit
  expect(flagsOf("0xb7")).toContain("flag.bridge");            // send into a known bridge
  expect(cat(demo.root)).toBe("sanctioned");                   // root node is a sanctioned entity

  // Peel chain: a >=3-node forwarding chain through the illustrative 0xf00d hops.
  const peelHit = findPeelChains(store.listEdges()).some(
    (p) => p.length >= 3 && p.includes(ID("1", "0xf00d000000000000000000000000000000000002"))
  );
  expect(peelHit).toBe(true);

  // NFT (ERC-721) edge present with a tokenId (dedup key carries tokenID).
  const nft = dEdges.find((e) => e.action === "tokennfttx");
  expect(nft).toBeDefined();
  expect(nft.tokenId).toBe("8817");

  // Round-trip preserved: root <-> Uniswap (ETH out, USDC back).
  const uni = "0x7a250d5630b4cf539739df2c5dacb4c659f2488d";
  expect(dEdges.some((e) => e.from === demo.root && e.to === uni)).toBe(true);
  expect(dEdges.some((e) => e.from === uni && e.to === demo.root)).toBe(true);
});

test("demo shows the same-key hop", async () => {
  $("resetBtn").click();
  $("demoBtn").click();
  for (let i = 0; i < 80 && !twins().length; i++) await sleep(25);
  expect(twins().length).toBe(1);
  expect($("legendTwinKey").hidden).toBe(false);
  const F3 = "0xf00d000000000000000000000000000000000003";
  const lab = (c) => window.vis.Network.first.nodes.get(ID(c, F3)).label;
  expect(lab("1").endsWith("\nEthereum")).toBe(true);
  expect(lab("42161").endsWith("\nArbitrum One")).toBe(true);
});

test("scan marks nodes with more history using a dashed border", async () => {
  $("resetBtn").click();
  $("apiKey").value = "TESTKEY";
  $("address").value = ROOT;
  $("maxTxPerAddress").value = "2"; // canned txlist returns 2 rows = N -> full batch
  $("depth").value = "1";
  $("startBtn").click();
  for (let i = 0; i < 60; i++) {
    if (/Done/.test($("status").textContent || "")) break;
    await sleep(50);
  }
  // first = the network main.js created (other tests build throwaway views)
  const nodes = window.vis.Network.first.nodes.get();
  expect(nodes.find((n) => n.id === ID("1", ROOT)).shapeProperties.borderDashes).toEqual([4, 3]);
  expect(nodes.find((n) => n.id === ID("1", N2)).shapeProperties.borderDashes).toBe(false);
  const rc = nodes.find((n) => n.id === ID("1", ROOT)).color;
  expect(rc.border).toBe("#e8eef7");
  expect(typeof rc.background).toBe("string");
  expect(nodes.find((n) => n.id === ID("1", N2)).color?.border).not.toBe("#e8eef7");
  $("maxTxPerAddress").value = "20";
});

async function historyEnv() {
  const { createI18n } = await import("../src/i18n.js");
  const en = (await import("../src/locales/en.js")).default;
  const fr = (await import("../src/locales/fr.js")).default;
  const ui = await import("../src/ui.js");
  const i18n = createI18n({ dictionaries: { en, fr }, locale: "en" });
  const render = (history, extra = {}) => {
    const c = document.createElement("div");
    ui.renderNodeDetails(c, { address: ROOT, depth: 0, isRoot: true, alias: null }, {
      i18n, explorer: "etherscan.io", onRename: () => {}, history, pageSize: 20, onLoadOlder: () => {}, ...extra,
    });
    return c;
  };
  const renderOther = (otherChains, extra = {}) => render(undefined, { otherChains, ...extra });
  return { render, renderOther };
}
const H = (state, count, action = "txlist", labelKey = "tx.type.normal") => ({ action, labelKey, state, count });

test("node details list per-type history states", async () => {
  const { render } = await historyEnv();
  const c = render([H("more", 40), H("unloaded", 0, "tokentx", "tx.type.erc20")]);
  expect(c.textContent).toContain("Normal: 40 rows fetched · older available");
  expect(c.textContent).toContain("ERC-20: not loaded");
});

test("load button: older / first / complete states", async () => {
  const { render } = await historyEnv();
  let calls = 0;
  const more = render([H("more", 40), H("unloaded", 0, "tokentx", "tx.type.erc20")], { onLoadOlder: () => calls++ });
  const b = more.querySelectorAll("button")[1];
  expect(b.textContent).toBe("Load older (+20)");
  expect(b.disabled).toBe(false);
  b.click();
  expect(calls).toBe(1);
  expect(b.disabled).toBe(true);

  const first = render([H("unloaded", 0), H("unloaded", 0, "tokentx", "tx.type.erc20")]);
  expect(first.querySelectorAll("button")[1].textContent).toBe("Load transactions (+20)");

  const done = render([H("complete", 5), H("complete", 3, "tokentx", "tx.type.erc20")]);
  const d = done.querySelectorAll("button")[1];
  expect(d.textContent).toBe("Complete for selected types");
  expect(d.disabled).toBe(true);
});

test("blocked load shows the reason and disables the button", async () => {
  const { render } = await historyEnv();
  const blocked = render([H("more", 40)], { loadBlocked: { key: "error.unknownChain", params: { id: "999999" } } });
  expect(blocked.querySelectorAll("button")[1].disabled).toBe(true);
  expect(blocked.textContent).toContain("Chain 999999 is not supported by this build");
  const busy = render([H("more", 40)], { busy: true });
  expect(busy.querySelectorAll("button")[1].disabled).toBe(true);
  expect(busy.textContent).not.toContain("is not supported by this build");
});

// --- Load older wiring (main.js): node chain, busy guard, workspace chain ---
const until = async (pred) => {
  for (let i = 0; i < 60 && !pred(); i++) await sleep(50);
};
// main.js loads the bundled known-address data async at init: wait until it was
// delivered, then one macrotask so main.js's await continuation has assigned it.
const knownLoaded = async () => {
  await until(() => knownLoads > 0);
  await sleep(0);
  expect(knownLoads).toBeGreaterThan(0);
};
const setChain = (id) => {
  $("chainSelect").value = id;
  $("chainSelect").dispatchEvent(new window.Event("change"));
};
const restoreForm = () => {
  $("maxTxPerAddress").value = "20";
  setChain("1");
};
async function freshScan(maxTx) {
  $("resetBtn").click();
  $("apiKey").value = "TESTKEY";
  $("address").value = ROOT;
  $("depth").value = "1";
  $("maxTxPerAddress").value = maxTx;
  $("startBtn").click();
  await until(() => /Done/.test($("status").textContent || ""));
  expect($("status").textContent).toContain("Done");
}
// freshScan on chain 1, then a second scan of ROOT on Arbitrum into the same graph.
// Returns the API URLs the second scan issued.
async function twoChainScan(maxTx = "20") {
  await freshScan(maxTx); // chain 1
  const n = apiUrls.length;
  setChain("42161");
  $("address").value = ROOT;
  $("startBtn").click();
  await until(() => !$("startBtn").disabled);
  await sleep(0); // let main.js's chain-sync microtask run
  return apiUrls.slice(n);
}
const openRoot = () => window.vis.Network.first._on.click[0]({ nodes: [ID("1", ROOT)], edges: [] });
const loadBtn = () => $("detailsContent").querySelectorAll("button")[1];
const txlistUrls = () => apiUrls.filter((u) => new URL(u).searchParams.get("action") === "txlist");
const lastTxlist = () => new URL(txlistUrls().at(-1)).searchParams;
const waitLoaded = () => until(() => /Loaded/.test($("status").textContent || ""));

test("load older goes through details with an inclusive endblock, then pages inside the block", async () => {
  try {
    await freshScan("2"); // txlist returns 2 rows = N -> root has older history
    openRoot();
    expect(loadBtn().textContent).toBe("Load older (+2)");
    loadBtn().click();
    expect($("status").textContent).toContain("Loading older history");
    await waitLoaded();
    let q = lastTxlist();
    expect(q.get("endblock")).toBe("100"); // inclusive: re-reads the cut-off boundary block
    expect(q.get("startblock")).toBe("0");
    expect(q.get("page")).toBe("1");
    expect($("logContent").textContent).toContain("Load older " + ROOT);

    // Both canned rows sit at/above block 100 -> no progress -> page inside block 100.
    loadBtn().click();
    await waitLoaded();
    q = lastTxlist();
    expect(q.get("startblock")).toBe("100");
    expect(q.get("endblock")).toBe("100");
    expect(q.get("page")).toBe("2");
  } finally {
    restoreForm();
  }
});

test("double click starts one load", async () => {
  try {
    await freshScan("2");
    openRoot();
    const n = txlistUrls().length;
    const b = loadBtn();
    b.click();
    // A plain Event bypasses happy-dom's disabled-button block, so main.js's own
    // busy guard (not just the button's disabled state) must stop the 2nd load.
    b.dispatchEvent(new window.Event("click"));
    await waitLoaded();
    await sleep(50);
    expect(txlistUrls().length).toBe(n + 1);
  } finally {
    restoreForm();
  }
});

test("saved workspace records the graph's chain, not the selector's", async () => {
  const orig = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  let captured = null;
  URL.createObjectURL = (b) => ((captured = b), "blob:x");
  URL.revokeObjectURL = () => {};
  try {
    await freshScan("20");
    setChain("137");
    $("saveBtn").click();
    expect(captured).not.toBeNull();
    const ws = JSON.parse(await captured.text());
    expect(ws.version === 3 && ws.graph.nodes.every((n) => n.chainId === "1")).toBe(true);
  } finally {
    URL.createObjectURL = orig.create;
    URL.revokeObjectURL = orig.revoke;
    restoreForm();
  }
});

test("node details without history, or with an empty one, render only Rename and no History row", async () => {
  const { render } = await historyEnv();
  for (const c of [render(undefined), render([])]) {
    const buttons = c.querySelectorAll("button");
    expect(buttons.length).toBe(1);
    expect(buttons[0].textContent).toBe("Rename (alias)");
    expect(c.textContent).not.toContain("History");
  }
});

test("Other chains block lists twins, focuses on click, offers alias apply", async () => {
  const { renderOther } = await historyEnv();
  const none = renderOther({ twins: [], canApplyAlias: false, onFocusTwin: () => {}, onApplyAlias: () => {} });
  expect(none.textContent).toContain("Other chains");
  expect(none.textContent).toContain("none");
  expect(none.querySelectorAll("button").length).toBe(1); // Rename only
  const focused = [];
  let applied = 0;
  const oc = (extra) => ({
    twins: [{ id: ID("42161", ROOT), chainName: "Arbitrum One", basis: "key" }, { id: ID("56", ROOT), chainName: "BNB Chain", basis: "address" }],
    canApplyAlias: false, onFocusTwin: (id) => focused.push(id), onApplyAlias: () => applied++, ...extra,
  });
  const c = renderOther(oc());
  const btns = [...c.querySelectorAll("button")].map((b) => b.textContent);
  expect(btns).toContain("Arbitrum One — same key");
  expect(btns).toContain("BNB Chain — same address only — likely unrelated");
  expect(btns).not.toContain("Apply alias to same-key twins");
  c.querySelectorAll("button")[1].click();
  expect(focused).toEqual([ID("42161", ROOT)]);
  const a = [...renderOther(oc({ canApplyAlias: true })).querySelectorAll("button")].find((b) => b.textContent === "Apply alias to same-key twins");
  a.click();
  expect(applied).toBe(1);
  const busy = [...renderOther(oc({ canApplyAlias: true }), { busy: true }).querySelectorAll("button")].find((b) => b.textContent === "Apply alias to same-key twins");
  expect(busy.disabled).toBe(true);
});

test("Other chains probe lines, Load on {chain} buttons and the chain select", async () => {
  const { renderOther } = await historyEnv();
  const probe = [
    { chainId: "42161", name: "Arbitrum One", state: "active" },
    { chainId: "8453", name: "Base", state: "inactive" },
    { chainId: "56", name: "BNB Chain", state: "plan" },
    { chainId: "10", name: "Optimism", state: "error" },
  ];
  const loaded = [];
  let checks = 0;
  const oc = {
    twins: [], canApplyAlias: false, onFocusTwin: () => {}, onApplyAlias: () => {},
    probe, loadable: probe.map(({ chainId, name }) => ({ chainId, name })),
    onCheckOtherChains: () => checks++, onLoadOnChain: (c) => loaded.push(c),
  };
  const c = renderOther(oc);
  for (const s of ["Arbitrum One — recent activity found", "Base — no recent normal/token activity found",
    "BNB Chain — needs a paid Etherscan plan", "Optimism — check failed"]) expect(c.textContent).toContain(s);
  const btns = (root) => [...root.querySelectorAll("button")];
  btns(c).find((b) => b.textContent === "Check other chains").click();
  expect(checks).toBe(1);
  btns(c).find((b) => b.textContent === "Load on Arbitrum One").click();
  expect(loaded).toEqual(["42161"]);
  expect(btns(c).some((b) => b.textContent === "Load on Base")).toBe(false); // inactive: no probe-line button
  const sel = c.querySelector("select");
  sel.value = "8453";
  sel.dispatchEvent(new window.Event("change"));
  btns(c).find((b) => b.textContent === "Load on Base").click();
  expect(loaded).toEqual(["42161", "8453"]);
  const busy = btns(renderOther(oc, { busy: true })).filter((b) => b.textContent === "Check other chains" || b.textContent.startsWith("Load on "));
  expect(busy.length).toBe(3); // Check + the active line's Load + the select's Load
  expect(busy.every((b) => b.disabled)).toBe(true);
});

test("blocked note is linked to the load button via aria-describedby", async () => {
  const { render } = await historyEnv();
  const c = render([H("more", 40)], { loadBlocked: { key: "error.unknownChain", params: { id: "999999" } } });
  const id = c.querySelectorAll("button")[1].getAttribute("aria-describedby");
  expect(id).toBeTruthy();
  expect(c.querySelector("#" + id).textContent).toContain("Chain 999999 is not supported by this build");
  expect(render([H("more", 40)]).querySelectorAll("button")[1].hasAttribute("aria-describedby")).toBe(false);
});

// --- Load older fix round 1: busy-guarded workspace apply, stopped load, live details ---
const gate = () => {
  let release;
  apiGate = new Promise((r) => (release = r));
  return () => {
    apiGate = null;
    release();
  };
};
const nodeIds = () => window.vis.Network.first.nodes.getIds().sort();
const DEMO_ROOT = "0x098b716b8aaf21512996dc57eb0615e2383e2f96";

test("workspace/demo apply is refused while a load is running (store unchanged, counts not mis-credited)", async () => {
  let release = () => {};
  try {
    await freshScan("2");
    const before = nodeIds();
    openRoot();
    release = gate();
    loadBtn().click(); // load now holds its txlist fetch
    $("demoBtn").click();
    await until(() => /Busy/.test($("logContent").textContent || ""));
    expect($("logContent").textContent).toContain("Busy — wait for the current scan or load to finish");
    release();
    await waitLoaded();
    expect($("status").textContent).toContain("Loaded 0 new transfers"); // not the demo's edges
    expect(nodeIds()).toEqual(before);
    expect($("logContent").textContent).not.toContain("Demo workspace loaded");
  } finally {
    release();
    restoreForm();
  }
});

test("a load stopped mid-fetch reports Stopped, not Loaded", async () => {
  let release = () => {};
  try {
    await freshScan("2");
    openRoot();
    release = gate();
    loadBtn().click();
    $("stopBtn").click();
    await until(() => /Stopped|Loaded/.test($("status").textContent || ""));
    expect($("status").textContent).toContain("Stopped — loaded 0 new transfers");
  } finally {
    release();
    restoreForm();
  }
});

test("details re-render live when the type selection or page size changes", async () => {
  try {
    $("typeInternal").checked = false; // scan without internal -> it stays unloaded
    await freshScan("20"); // N=20 > canned rows -> scanned types complete
    openRoot();
    expect(loadBtn().textContent).toBe("Complete for selected types");
    expect(loadBtn().disabled).toBe(true);
    $("typeInternal").checked = true;
    $("typeInternal").dispatchEvent(new window.Event("change"));
    expect(loadBtn().disabled).toBe(false);
    expect(loadBtn().textContent).toBe("Load older (+20)");
    $("maxTxPerAddress").value = "5";
    $("maxTxPerAddress").dispatchEvent(new window.Event("input")); // live, not on blur
    expect(loadBtn().textContent).toBe("Load older (+5)");
  } finally {
    $("typeInternal").checked = true;
    restoreForm();
  }
});

test("details explorer link stays on the graph's chain after switching the selector", async () => {
  try {
    await freshScan("20");
    setChain("137");
    openRoot();
    expect($("detailsContent").querySelector("a").href).toContain("etherscan.io/address/");
  } finally {
    restoreForm();
  }
});

test("risk, labels and CSV category stay on the graph's chain after switching the selector", async () => {
  const orig = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  let captured = null;
  URL.createObjectURL = (b) => ((captured = b), "blob:x");
  URL.revokeObjectURL = () => {};
  const openDemoRoot = () => window.vis.Network.first._on.click[0]({ nodes: [ID("1", DEMO_ROOT)], edges: [] });
  const csv = async () => {
    captured = null;
    $("exportCsvBtn").click();
    await until(() => captured);
    return captured.text();
  };
  try {
    $("resetBtn").click();
    $("demoBtn").click();
    await until(() => /Demo workspace loaded/.test($("logContent").textContent || ""));
    openDemoRoot();
    const risk = $("detailsContent").textContent;
    expect(risk).toContain("sanctioned"); // DEMO_ROOT is an OFAC-listed chain-1 address
    const before = await csv();
    expect(before).toContain("flag.sanctioned"); // edge to a chain-1 OFAC-listed recipient
    const demoLabel = () => {
      const n = window.vis.Network.first.nodes.get().find((x) => x.id === ID("1", DEMO_ROOT));
      return `${n.label}|${n.title}`;
    };
    const label = demoLabel();
    expect(label).toContain("Ronin Exploiter"); // chain-1 known label
    expect(label).toContain("⛔"); // chain-1 category icon (sanctioned)
    setChain("137"); // no chain-137 entry for DEMO_ROOT
    openDemoRoot();
    expect($("detailsContent").textContent).toBe(risk);
    expect(await csv()).toBe(before);
    expect(demoLabel()).toBe(label);
  } finally {
    URL.createObjectURL = orig.create;
    URL.revokeObjectURL = orig.revoke;
    restoreForm();
  }
});

test("load on a demo graph shows the sampling banner and reports failed requests", async () => {
  const realFetch = globalThis.fetch;
  try {
    $("resetBtn").click();
    $("demoBtn").click();
    await until(() => /Demo workspace loaded/.test($("logContent").textContent || ""));
    expect($("samplingBanner").hidden).toBe(true);
    $("apiKey").value = "TESTKEY";
    globalThis.fetch = async (url, init) =>
      String(url).includes("data/")
        ? realFetch(url, init)
        : { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ status: "0", message: "NOTOK", result: "Invalid API Key" }) };
    window.vis.Network.first._on.click[0]({ nodes: [ID("1", DEMO_ROOT)], edges: [] });
    loadBtn().click();
    await waitLoaded();
    expect($("status").textContent).toContain("Loaded 0 new transfers");
    expect($("status").textContent).toMatch(/— [1-9]\d* request\(s\) failed \(see log\)/);
    expect($("samplingBanner").hidden).toBe(false);
  } finally {
    globalThis.fetch = realFetch;
    restoreForm();
  }
});

test("a second scan on the same chain into a non-empty graph still runs", async () => {
  try {
    await freshScan("20");
    const n = apiUrls.length;
    $("address").value = N2;
    $("startBtn").click();
    await until(() => !$("startBtn").disabled);
    const added = apiUrls.slice(n);
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((u) => new URL(u).searchParams.get("chainid") === "1")).toBe(true);
  } finally {
    restoreForm();
  }
});

test("long annotations wrap to a fixed width instead of one ultra-wide line (demo note)", async () => {
  $("resetBtn").click();
  $("demoBtn").click();
  let note;
  for (let i = 0; i < 80 && !note; i++) {
    await sleep(25);
    note = window.vis.Network.first.nodes.get().find((n) => String(n.id).startsWith("note:"));
  }
  expect(note).toBeTruthy();
  expect(note.label.length).toBeGreaterThan(300); // the demo's long disclaimer is kept in full
  expect(note.widthConstraint).toEqual({ maximum: 300 }); // ...but wrapped, so fit() doesn't shrink the graph
});

test("detect chain: a curated chain-1 address selects Ethereum with no API call", async () => {
  await knownLoaded();
  try {
    $("resetBtn").click();
    setChain("137");
    $("apiKey").value = "TESTKEY"; // a key is present, so only the local shortcut can avoid the probe
    $("address").value = DEMO_ROOT;
    const n = apiUrls.length;
    $("detectChainBtn").click();
    await until(() => $("chainSelect").value === "1");
    expect($("chainSelect").value).toBe("1");
    expect($("addressDetect").textContent).toContain("Ethereum");
    expect(apiUrls.slice(n).filter((u) => u.includes("api.etherscan.io"))).toEqual([]);
  } finally {
    $("apiKey").value = "";
    $("address").value = "";
    restoreForm();
  }
});

async function loadAsDemo(ws, done = /Demo workspace loaded/) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, init) => (String(u).includes("demo-workspace")
    ? { ok: true, status: 200, headers: { get: () => null }, json: async () => ws }
    : realFetch(u, init));
  try {
    $("resetBtn").click();
    $("demoBtn").click();
    await until(() => done.test($("logContent").textContent || ""));
  } finally {
    globalThis.fetch = realFetch;
  }
}
async function captureCsv() {
  const orig = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  let captured = null;
  URL.createObjectURL = (b) => ((captured = b), "blob:x");
  URL.revokeObjectURL = () => {};
  try {
    $("exportCsvBtn").click();
    await until(() => captured);
    return await captured.text();
  } finally {
    URL.createObjectURL = orig.create;
    URL.revokeObjectURL = orig.revoke;
  }
}
const wsEdge = (over) => ({
  key: `${over.action || "txlist"}|${over.hash}|${ROOT}|${over.to || N2}|${over.tokenContract || ""}|`, action: "txlist", group: "normal", color: "#4f8ef7",
  from: ROOT, to: N2, symbol: "ETH", tokenContract: "", tokenId: "", value: "1000000", tokenDecimal: "6",
  amountText: "1", amountIndeterminate: false, hasData: false, methodId: "", methodArgs: [], timeStamp: "1700000000", blockNumber: "1",
  ...over,
});
const STAR_ONLY = Object.keys(KNOWN["*"] || {}).find((a) => KNOWN["*"][a].category === "sanctioned" && !Object.keys(KNOWN).some((c) => c !== "*" && KNOWN[c][a]));
const v3Edge = (over) => { const e = wsEdge(over); const chainId = over.chainId || "1"; return { ...e, chainId, key: `${chainId}|${e.key}` }; };
const v3ws = (nodes, edges) => ({ version: 3, root: ROOT, graph: { nodes, edges } });
const v3Node = (chainId, address, over = {}) => ({ chainId, address, depth: 1, isRoot: false, alias: null, ...over });
const ONE_ONLY = Object.keys(KNOWN["1"]).find((x) => KNOWN["1"][x].category === "mixer" && !(KNOWN["*"] || {})[x] && !(KNOWN["56"] || {})[x]);
const visNode = (id) => window.vis.Network.first.nodes.get().find((n) => n.id === id);

test("detect chain: an address known only on '*' keeps the selector and falls through to the API probe", async () => {
  await knownLoaded(); // else an unloaded dataset would fall through too (false pass)
  expect(STAR_ONLY).toBeTruthy(); // the data must hold a '*'-only sanctioned address
  try {
    $("resetBtn").click();
    setChain("137");
    $("apiKey").value = "";
    $("address").value = STAR_ONLY;
    $("detectChainBtn").click();
    await until(() => /Etherscan API key/.test($("logContent").textContent || ""));
    expect($("chainSelect").value).toBe("137");
    expect($("logContent").textContent).toContain("Please enter your Etherscan API key.");
  } finally {
    $("address").value = "";
    restoreForm();
  }
});

test("detect chain: a chain-1 + '*' address names Ethereum and all EVM chains", async () => {
  await knownLoaded();
  try {
    $("resetBtn").click();
    setChain("137");
    $("apiKey").value = "";
    $("address").value = DEMO_ROOT;
    $("detectChainBtn").click();
    await until(() => $("chainSelect").value === "1");
    expect($("addressDetect").textContent).toContain("Ethereum, all EVM chains");
  } finally {
    $("address").value = "";
    restoreForm();
  }
});

test("a '*'-only OFAC address is labeled, badged, sourced and risk-scored on a non-Ethereum graph", async () => {
  await knownLoaded();
  expect(STAR_ONLY).toBeTruthy();
  try {
    await loadAsDemo({
      version: 2, chainId: "137", root: ROOT,
      nodes: [{ address: ROOT, depth: 0, isRoot: true, alias: null }, { address: STAR_ONLY, depth: 1, isRoot: false, alias: null }],
      edges: [wsEdge({ hash: "0xs1", to: STAR_ONLY, symbol: "POL" })],
    });
    const node = window.vis.Network.first.nodes.get().find((n) => n.id === ID("137", STAR_ONLY));
    expect(`${node.label}|${node.title}`).toContain("(OFAC SDN)");
    expect(`${node.label}|${node.title}`).toContain("⛔");
    window.vis.Network.first._on.click[0]({ nodes: [ID("137", STAR_ONLY)], edges: [] });
    expect($("detailsContent").textContent).toContain("OFAC SDN list, published");
    expect($("detailsContent").textContent).toContain("sanctioned entity");
  } finally {
    $("resetBtn").click();
    restoreForm();
  }
});

test("imitation USDT: ⓘ on the graph, flagged in details + CSV, hidden by Hide spam; canonical USDC untouched", async () => {
  await knownLoaded();
  const FAKE = "0x" + "e".repeat(40);
  const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"; // chain-1 `token` row in data/known-addresses.json
  const tok = (hash, symbol, contract) => wsEdge({ hash, action: "tokentx", group: "token", color: "#4fd67a", symbol, tokenContract: contract });
  const shown = () => window.vis.Network.first.edges.get();
  const byHash = (h) => shown().find((e) => e.data.hash === h);
  try {
    await loadAsDemo({
      version: 2, chainId: "1", root: ROOT,
      nodes: [{ address: ROOT, depth: 0, isRoot: true, alias: null }, { address: N2, depth: 1, isRoot: false, alias: null }],
      edges: [tok("0xf1", "USDT", FAKE), tok("0xf2", "USDC", USDC)],
    });
    expect(byHash("0xf1").label).toContain("ⓘ");
    expect(byHash("0xf1").title).toContain("imitation token — not the official contract");
    expect(byHash("0xf2").label).not.toContain("ⓘ");
    $("langToggle").click(); // a locale switch re-renders edge tooltips
    try { expect(byHash("0xf1").title).toContain("faux jeton — pas le contrat officiel"); }
    finally { $("langToggle").click(); }
    expect(byHash("0xf1").title).toContain("imitation token — not the official contract");
    window.vis.Network.first._on.click[0]({ nodes: [], edges: [byHash("0xf1").id] });
    expect($("detailsContent").textContent).toContain("imitation token — not the official contract");
    const lines = (await captureCsv()).split("\n");
    expect(lines.find((l) => l.includes(",0xf1,"))).toContain("flag.fakeToken");
    expect(lines.find((l) => l.includes(",0xf2,"))).not.toContain("flag.fakeToken");
    $("hideSpamToggle").checked = true;
    $("hideSpamToggle").dispatchEvent(new window.Event("change"));
    expect(shown().map((e) => e.data.hash)).toEqual(["0xf2"]);
  } finally {
    $("hideSpamToggle").checked = false;
    $("hideSpamToggle").dispatchEvent(new window.Event("change"));
    $("resetBtn").click();
    restoreForm();
  }
});

test("a view refresh fully restyles an edge whose flags appeared after it was drawn", async () => {
  const { createGraphView } = await import("../src/render/network.js");
  const { GraphStore } = await import("../src/graphStore.js");
  const { createI18n } = await import("../src/i18n.js");
  const en = (await import("../src/locales/en.js")).default;
  let flags = []; // stands in for flags before the known data / canonical index load
  const store = new GraphStore();
  const view = createGraphView(document.createElement("div"), store, {
    i18n: createI18n({ dictionaries: { en }, locale: "en", fallbackLocale: "en" }),
    getAddressFormat: () => "short",
    getEdgeFlags: () => flags,
  });
  try {
    const e = wsEdge({ hash: "0xr1", action: "tokentx", group: "token", symbol: "USDT", tokenContract: "0x" + "e".repeat(40) });
    store.loadSnapshot(
      [{ chainId: "1", address: ROOT, depth: 0, isRoot: true, alias: null }, { chainId: "1", address: N2, depth: 1, isRoot: false, alias: null }],
      [{ ...e, chainId: "1", key: `1|${e.key}` }],
    );
    const edge = () => window.vis.Network.last.edges.get()[0];
    expect(edge().label).not.toContain("ⓘ");
    flags = ["flag.fakeToken"];
    view.refreshProjection();
    expect(edge().label).toContain("ⓘ");
    expect(edge().title).toContain("imitation token — not the official contract");
    expect(edge().dashes).toEqual([2, 3]);
  } finally {
    view.destroy();
  }
});

test("spam contracts follow each edge's chain: '*' hidden everywhere, '137' only on 137 edges", async () => {
  await knownLoaded();
  await until(() => spamLoads > 0);
  await sleep(0);
  const tok = (chainId, hash, contract) => v3Edge({ chainId, hash, action: "tokentx", group: "token", color: "#4fd67a", symbol: "SPAMX", tokenContract: contract });
  try {
    await loadAsDemo(v3ws(
      [v3Node("1", ROOT, { depth: 0, isRoot: true }), v3Node("1", N2), v3Node("137", ROOT, { depth: 0, isRoot: true }), v3Node("137", N2)],
      [tok("137", "0xp2", SPAM_137), tok("1", "0xp4", SPAM_137), tok("1", "0xp1", SPAM_STAR), v3Edge({ chainId: "1", hash: "0xp3" })],
    ));
    $("hideSpamToggle").checked = true;
    $("hideSpamToggle").dispatchEvent(new window.Event("change"));
    expect(window.vis.Network.first.edges.get().map((e) => e.data.hash).sort()).toEqual(["0xp3", "0xp4"]);
  } finally {
    $("hideSpamToggle").checked = false;
    $("hideSpamToggle").dispatchEvent(new window.Event("change"));
    $("resetBtn").click();
    restoreForm();
  }
});

// --- per-record chain lookups (labels, flags, explorer, fake tokens) ---------
const twinRoots = (chainIds) => chainIds.map((c) => v3Node(c, ROOT, { depth: 0, isRoot: true }));
const clickNode = (id) => window.vis.Network.first._on.click[0]({ nodes: [id], edges: [] });
const edgeByHash = (h) => window.vis.Network.first.edges.get().find((e) => e.data.hash === h);

test("a chain-1-only label never reaches its chain-56 twin", async () => {
  await knownLoaded();
  expect(ONE_ONLY).toBeTruthy();
  const label = KNOWN["1"][ONE_ONLY].label;
  try {
    await loadAsDemo(v3ws(
      [...twinRoots(["1", "56"]), v3Node("1", ONE_ONLY), v3Node("56", ONE_ONLY)],
      [v3Edge({ chainId: "1", hash: "0xm1", to: ONE_ONLY }), v3Edge({ chainId: "56", hash: "0xm2", to: ONE_ONLY, symbol: "BNB" })],
    ));
    expect(visNode(ID("1", ONE_ONLY)).label).toContain(label);
    expect(visNode(ID("1", ONE_ONLY)).title).toContain("🌀");
    expect(visNode(ID("56", ONE_ONLY)).label).not.toContain(label);
    expect(visNode(ID("56", ONE_ONLY)).title).not.toContain("🌀");
    clickNode(ID("56", ONE_ONLY));
    expect($("detailsContent").textContent).toContain(ONE_ONLY); // the 56 node's details rendered
    expect($("detailsContent").textContent).not.toContain("Source");
    expect($("detailsContent").textContent).not.toContain("labeled entity");
    expect(edgeByHash("0xm1").label).toContain("⚠");
    expect(edgeByHash("0xm2").label).not.toContain("⚠");
  } finally {
    $("resetBtn").click();
    restoreForm();
  }
});

test("a '*' entry badges both twins and says it is listed for all EVM chains", async () => {
  await knownLoaded();
  expect(STAR_ONLY).toBeTruthy();
  const PHRASE = "listed for all EVM chains (address-level designation)";
  try {
    await loadAsDemo(v3ws([...twinRoots(["1", "56"]), v3Node("1", STAR_ONLY), v3Node("56", STAR_ONLY)], []));
    for (const c of ["1", "56"]) {
      expect(visNode(ID(c, STAR_ONLY)).title).toContain("⛔");
      expect(visNode(ID(c, STAR_ONLY)).title).toContain(PHRASE);
    }
    $("langToggle").click(); // the tooltip note is re-translated live
    try { expect(visNode(ID("56", STAR_ONLY)).title).toContain("listée pour toutes les chaînes EVM (désignation au niveau de l'adresse)"); }
    finally { $("langToggle").click(); }
    clickNode(ID("56", STAR_ONLY));
    const source = [...$("detailsContent").querySelectorAll("tr")].find((tr) => tr.firstChild.textContent === "Source");
    expect(source.textContent).toContain("OFAC SDN list, published");
    expect(source.textContent).toContain(PHRASE);
  } finally {
    $("resetBtn").click();
    restoreForm();
  }
});

test("Other chains lists same-key and address-only twins and focuses on click", async () => {
  const net = window.vis.Network.first;
  net.focus = () => {};
  net.selectNodes = (n) => net.setSelection({ nodes: n });
  net.getScale = () => 1;
  try {
    await twoChainScan();
    clickNode(ID("1", ROOT));
    const btn = (txt) => [...$("detailsContent").querySelectorAll("button")].find((b) => b.textContent === txt);
    btn("Arbitrum One — same key").click();
    expect($("detailsContent").querySelector("a").href).toContain("arbiscan.io/address/");
    clickNode(ID("1", N2));
    expect(btn("Arbitrum One — same address only — likely unrelated")).toBeTruthy();
  } finally {
    delete net.focus;
    delete net.selectNodes;
    delete net.getScale;
    restoreForm();
  }
});

test("alias apply targets same-key twins only and never overwrites", async () => {
  const origPrompt = window.prompt;
  const btn = (txt) => [...$("detailsContent").querySelectorAll("button")].find((b) => b.textContent === txt);
  const APPLY = "Apply alias to same-key twins";
  try {
    await twoChainScan();
    window.prompt = () => "Suspect";
    clickNode(ID("1", ROOT));
    btn("Rename (alias)").click();
    btn(APPLY).click();
    expect(visNode(ID("42161", ROOT)).label.startsWith("Suspect")).toBe(true);
    window.prompt = () => "Other";
    clickNode(ID("42161", ROOT));
    btn("Rename (alias)").click();
    window.prompt = () => "Suspect2";
    clickNode(ID("1", ROOT));
    btn("Rename (alias)").click();
    expect(btn(APPLY)).toBeUndefined();
    expect(visNode(ID("42161", ROOT)).label.startsWith("Other")).toBe(true);
    expect(visNode(ID("42161", N2)).label.startsWith("Suspect")).toBe(false);
  } finally {
    window.prompt = origPrompt;
    restoreForm();
  }
});

// --- Check other chains / Load on {chain} (details panel) --------------------
const detailBtn = (txt) => [...$("detailsContent").querySelectorAll("button")].find((b) => b.textContent === txt);
// A 1-chain scan, then probe ROOT's other chains at 30 req/s (11 chains at the default 3 req/s outlast `until`).
async function probeRoot() {
  await freshScan("20");
  $("rps").value = "30";
  clickNode(ID("1", ROOT));
  const n = apiUrls.length;
  detailBtn("Check other chains").click();
  await until(() => !$("startBtn").disabled);
  return apiUrls.slice(n);
}

test("Check other chains probes the probe set minus chains already holding the address", async () => {
  try {
    const qs = (await probeRoot()).map((u) => new URL(u).searchParams);
    expect(new Set(qs.map((q) => q.get("chainid")))).toEqual(new Set(PROBE_CHAIN_IDS.filter((c) => c !== 1).map(String)));
    expect(qs.every((q) => ["txlist", "tokentx"].includes(q.get("action")) && q.get("offset") === "1")).toBe(true);
    expect($("detailsContent").textContent).toContain("Arbitrum One — recent activity found");
    await freshScan("20"); // store reset -> probe results are session facts, gone
    clickNode(ID("1", ROOT));
    expect($("detailsContent").textContent).not.toContain("recent activity found");
  } finally {
    $("rps").value = "3";
    restoreForm();
  }
});

test("Stop cancels the probe", async () => {
  let release = () => {};
  try {
    await freshScan("20");
    clickNode(ID("1", ROOT));
    const n = apiUrls.length;
    release = gate();
    detailBtn("Check other chains").click();
    $("stopBtn").click();
    release();
    await until(() => !$("startBtn").disabled);
    expect(apiUrls.length - n).toBeLessThan(22);
    expect($("startBtn").disabled).toBe(false);
    // A stopped probe is discarded, never shown (or cached) as if it were complete.
    const text = $("detailsContent").textContent;
    for (const s of ["recent activity found", "no recent normal/token activity found", "needs a paid Etherscan plan", "check failed"]) {
      expect(text).not.toContain(s);
    }
  } finally {
    release();
    restoreForm();
  }
});

test("Load on Arbitrum One creates the twin as a root, copies no alias, draws a same-key link", async () => {
  const origPrompt = window.prompt;
  try {
    await probeRoot();
    window.prompt = () => "Suspect";
    detailBtn("Rename (alias)").click();
    detailBtn("Load on Arbitrum One").click();
    await waitLoaded();
    expect(lastTxlist().get("chainid")).toBe("42161");
    const v = visNode(ID("42161", ROOT));
    expect(v).toBeTruthy();
    expect(v.color).toBe("#e63946"); // root colour: the twin is the investigator's subject on B
    expect(v.label).not.toContain("Suspect");
    expect(twins().length).toBe(1);
    expect($("logContent").textContent).toContain("Added Arbitrum One — graph now spans 2 chains.");
  } finally {
    window.prompt = origPrompt;
    $("rps").value = "3";
    restoreForm();
  }
});

test("the load picker lists mainnets in probe order first", async () => {
  try {
    await freshScan("20");
    clickNode(ID("1", ROOT));
    const first = $("detailsContent").querySelector("select option").value;
    expect(first).toBe(String(PROBE_CHAIN_IDS.find((c) => c !== 1))); // 8453 (Base), not Sepolia
  } finally {
    restoreForm();
  }
});

test("a Load on {chain} stopped before any page removes the node and logs it as info", async () => {
  let release = () => {};
  try {
    await freshScan("20");
    clickNode(ID("1", ROOT));
    const sel = $("detailsContent").querySelector("select");
    sel.value = "42161";
    sel.dispatchEvent(new window.Event("change"));
    release = gate();
    detailBtn("Load on Arbitrum One").click();
    $("stopBtn").click();
    release();
    await until(() => /Nothing could be loaded/.test($("logContent").textContent || ""));
    expect(window.vis.Network.first.nodes.getIds().some((id) => String(id).startsWith("42161:"))).toBe(false);
    const line = [...$("logContent").children].find((l) => l.textContent.includes("Nothing could be loaded on Arbitrum One"));
    expect(line.className).not.toBe("err");
  } finally {
    release();
    restoreForm();
  }
});

test("a load that fetches nothing leaves no phantom node", async () => {
  const realFetch = globalThis.fetch;
  try {
    await freshScan("20");
    clickNode(ID("1", ROOT));
    globalThis.fetch = async (url, init) =>
      String(url).includes("data/")
        ? realFetch(url, init)
        : { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ status: "0", message: "NOTOK", result: "Invalid API Key" }) };
    const sel = $("detailsContent").querySelector("select");
    sel.value = "42161";
    sel.dispatchEvent(new window.Event("change"));
    detailBtn("Load on Arbitrum One").click();
    await waitLoaded();
    expect(window.vis.Network.first.nodes.getIds().some((id) => String(id).startsWith("42161:"))).toBe(false);
    expect($("logContent").textContent).toContain("Nothing could be loaded on Arbitrum One; the node was not added.");
    expect([...$("logContent").children].at(-1).className).toBe("err"); // failed, not stopped
  } finally {
    globalThis.fetch = realFetch;
    restoreForm();
  }
});

test("explorer links follow each record's chain; an unknown chain gives no link", async () => {
  try {
    await loadAsDemo(v3ws(
      [...twinRoots(["1", "42161", "999999"]), v3Node("999999", N2)],
      [v3Edge({ chainId: "999999", hash: "0xu1" })],
    ));
    clickNode(ID("1", ROOT));
    expect($("detailsContent").querySelector("a").href).toContain("etherscan.io/address/");
    clickNode(ID("42161", ROOT));
    expect($("detailsContent").querySelector("a").href).toContain("arbiscan.io/address/");
    clickNode(ID("999999", ROOT));
    expect($("detailsContent").textContent).toContain(ROOT);
    expect($("detailsContent").querySelector("a")).toBeNull();
    window.vis.Network.first._on.click[0]({ nodes: [], edges: [edgeByHash("0xu1").id] });
    expect($("detailsContent").textContent).toContain(N2); // the edge's details rendered
    expect($("detailsContent").textContent).not.toContain("View tx");
    expect($("detailsContent").querySelector("a")).toBeNull();
  } finally {
    $("resetBtn").click();
    restoreForm();
  }
});

test("imitation USDT is flagged on Ethereum, not on a chain with no canonical USDT", async () => {
  await knownLoaded();
  const FAKE = "0x" + "e".repeat(40);
  const tok = (chainId, hash) => v3Edge({ chainId, hash, action: "tokentx", group: "token", color: "#4fd67a", symbol: "USDT", tokenContract: FAKE });
  try {
    await loadAsDemo(v3ws(
      [...twinRoots(["1", "42161"]), v3Node("1", N2), v3Node("42161", N2)],
      [tok("1", "0xf1"), tok("42161", "0xf3")],
    ));
    expect(edgeByHash("0xf1").label).toContain("ⓘ");
    expect(edgeByHash("0xf3").label).not.toContain("ⓘ");
  } finally {
    $("resetBtn").click();
    restoreForm();
  }
});

test("a v2 workspace with no chain takes the selector's chain and says so; a newer version is refused, localized", async () => {
  try {
    setChain("137");
    await loadAsDemo({ version: 2, root: ROOT, nodes: [{ address: ROOT, depth: 0, isRoot: true, alias: null }], edges: [] });
    expect($("logContent").textContent).toContain("Workspace had no chain; assumed Polygon.");
    expect(window.vis.Network.first.nodes.getIds()).toContain(ID("137", ROOT));
    expect($("chainSelect").value).toBe("137");

    await loadAsDemo({ version: 4, graph: { nodes: [], edges: [] } }, /newer chainmap/);
    expect($("logContent").textContent).toContain("This workspace was made by a newer chainmap — update the app to open it.");
    expect($("logContent").textContent).not.toContain("Demo workspace loaded");
  } finally {
    $("resetBtn").click();
    restoreForm();
  }
});

test("CSV: chain_id on every row, per-chain flags, multi-chain caveat", async () => {
  await knownLoaded();
  try {
    await loadAsDemo(v3ws(
      [...twinRoots(["1", "56"]), v3Node("1", ONE_ONLY), v3Node("56", ONE_ONLY)],
      [v3Edge({ chainId: "1", hash: "0xm1", to: ONE_ONLY }), v3Edge({ chainId: "56", hash: "0xm2", to: ONE_ONLY, symbol: "BNB" })],
    ));
    const lines = (await captureCsv()).split("\n");
    expect(lines[0]).toContain("multi-chain");
    expect(lines[1].startsWith("row_type,")).toBe(true);
    const data = lines.filter((l) => /^(node|edge),/.test(l));
    expect(data.length).toBe(6);
    for (const l of data) expect(/,(1|56)$/.test(l)).toBe(true);
    const m1 = lines.find((l) => l.includes("0xm1")), m2 = lines.find((l) => l.includes("0xm2"));
    expect(m1).toContain("flag.mixer");
    expect(m1.endsWith(",1")).toBe(true);
    expect(m2).not.toContain("flag.mixer");
    expect(m2.endsWith(",56")).toBe(true);
  } finally {
    $("resetBtn").click();
    restoreForm();
  }
});

// --- multi-chain: scans and loads run on any chain into the same graph -------
test("scan on another chain adds a root on that chain", async () => {
  try {
    const second = await twoChainScan();
    expect(nodeIds()).toEqual(["1", "42161"].flatMap((c) => [ROOT, N2, N4].map((x) => ID(c, x))).sort());
    expect(window.vis.Network.first.edges.get().filter((e) => e.data.hash === "0xaaa").map((e) => e.id.split("|")[0]).sort()).toEqual(["1", "42161"]);
    expect(second.length).toBeGreaterThan(0);
    expect(second.every((u) => new URL(u).searchParams.get("chainid") === "42161")).toBe(true);
    expect($("status").textContent).toBe("Done — 6 addresses, 4 links");
    expect($("logContent").textContent).toContain("Added Arbitrum One — graph now spans 2 chains.");
  } finally {
    restoreForm();
  }
});

test("load older uses the node's chain, never the selector's", async () => {
  try {
    await twoChainScan("2");
    setChain("1");
    clickNode(ID("42161", ROOT));
    expect(loadBtn().disabled).toBe(false);
    loadBtn().click();
    await waitLoaded();
    expect(lastTxlist().get("chainid")).toBe("42161");
    clickNode(ID("1", ROOT));
    loadBtn().click();
    await waitLoaded();
    expect(lastTxlist().get("chainid")).toBe("1");
  } finally {
    restoreForm();
  }
});

test("switching the selector never relabels or blocks a node", async () => {
  try {
    await freshScan("2"); // full batch -> "Load older" (N=20 would leave every type complete, button disabled anyway)
    const label = visNode(ID("1", ROOT)).label;
    setChain("137");
    expect(visNode(ID("1", ROOT)).label).toBe(label);
    openRoot();
    expect(loadBtn().disabled).toBe(false);
  } finally {
    restoreForm();
  }
});

test("unknown-chain node: load disabled with a reason, no request", async () => {
  try {
    await loadAsDemo(v3ws([v3Node("999999", ROOT, { depth: 0, isRoot: true })], []));
    $("apiKey").value = "TESTKEY";
    clickNode(ID("999999", ROOT));
    expect(loadBtn().disabled).toBe(true);
    expect($("detailsContent").textContent).toContain("Chain 999999 is not supported by this build");
    const n = apiUrls.length;
    loadBtn().dispatchEvent(new window.Event("click")); // even if the handler fires, main.js refuses
    await sleep(50);
    expect(apiUrls.length).toBe(n);
  } finally {
    $("resetBtn").click();
    restoreForm();
  }
});

test("a scan on a chain this build lacks is refused, localized, with no request", async () => {
  const opt = document.createElement("option");
  opt.value = "999999";
  $("chainSelect").appendChild(opt); // e.g. a stale persisted selection
  try {
    await freshScan("20");
    const n = apiUrls.length;
    setChain("999999");
    $("startBtn").click();
    await sleep(50);
    expect(apiUrls.length).toBe(n);
    expect($("logContent").textContent).toContain("Chain 999999 is not supported by this build — scan and load are disabled for it.");
  } finally {
    opt.remove();
    restoreForm();
  }
});

test("pruning one twin leaves the other chain intact", async () => {
  try {
    await twoChainScan();
    window.vis.Network.first.setSelection({ nodes: [ID("42161", ROOT)] });
    $("deleteNodesBtn").click();
    expect(nodeIds()).not.toContain(ID("42161", ROOT));
    expect(nodeIds()).toContain(ID("1", ROOT));
    expect(nodeIds()).toContain(ID("42161", N2)); // only the selected id goes
    expect(window.vis.Network.first.edges.get().filter((e) => e.id.startsWith("1|")).length).toBe(2);
  } finally {
    window.vis.Network.first.setSelection({ nodes: [] });
    restoreForm();
  }
});

test("Ctrl+Arrow navigates across chains by node id", async () => {
  const net = window.vis.Network.first;
  try {
    await twoChainScan();
    net.getPositions = () => ({ [ID("1", ROOT)]: { x: 0, y: 0 }, [ID("42161", ROOT)]: { x: 100, y: 0 } });
    net.focus = () => {};
    net.getScale = () => 1;
    net.setSelection({ nodes: [ID("1", ROOT)] });
    document.activeElement?.blur?.(); // the handler ignores keys while an input has focus
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", ctrlKey: true }));
    expect($("detailsContent").querySelector("a").href).toContain("arbiscan.io/address/");
  } finally {
    delete net.getPositions;
    delete net.focus;
    delete net.getScale;
    net.setSelection({ nodes: [] });
    restoreForm();
  }
});

test("a two-chain graph with a note round-trips through save and load", async () => {
  const orig = { create: URL.createObjectURL, revoke: URL.revokeObjectURL, prompt: window.prompt };
  let captured = null;
  URL.createObjectURL = (b) => ((captured = b), "blob:x");
  URL.revokeObjectURL = () => {};
  const graphIds = () => nodeIds().filter((i) => !i.startsWith("note:"));
  try {
    await twoChainScan();
    window.prompt = () => "note";
    $("addNoteBtn").click();
    const before = graphIds();
    $("saveBtn").click();
    expect(captured).not.toBeNull();
    const saved = JSON.parse(await captured.text());
    expect(saved.version).toBe(3);
    expect([...new Set(saved.graph.nodes.map((n) => n.chainId))].sort()).toEqual(["1", "42161"]);
    expect(saved.annotations.length).toBe(1);
    await loadAsDemo(saved);
    expect(graphIds()).toEqual(before);
    expect(nodeIds().filter((i) => i.startsWith("note:")).length).toBe(1);
  } finally {
    URL.createObjectURL = orig.create;
    URL.revokeObjectURL = orig.revoke;
    window.prompt = orig.prompt;
    $("resetBtn").click();
    restoreForm();
  }
});

const legendShown = () => !$("legendChainTag").hidden;

test("a legacy v2 workspace renders exactly as before", async () => {
  try {
    await loadAsDemo(V2);
    const net = window.vis.Network.first;
    expect(net.nodes.get().filter((n) => !String(n.id).startsWith("note:") && n.label.includes("\nEthereum")).length).toBe(0);
    expect(net.edges.get().filter((e) => String(e.title).includes(" · Ethereum")).length).toBe(0);
    expect($("legendChainTag").hidden).toBe(true);
    expect($("chainFilter").hidden).toBe(true);
    expect($("twinToggleRow").hidden).toBe(true);
    expect(twins().length).toBe(0);
  } finally {
    $("resetBtn").click();
    restoreForm();
  }
});

const twins = () => window.vis.Network.first.edges.get().filter((e) => e.twin);

test("exactly one same-key link joins the two roots; address-only pairs are never drawn", async () => {
  try {
    await twoChainScan();
    expect(twins().length).toBe(1);
    expect(twins()[0]).toMatchObject({ from: ID("1", ROOT), to: ID("42161", ROOT), label: "same key" });
    expect(twins()[0].arrows.to.enabled).toBe(false);
    expect(twins().some((t) => [N2, N4].some((n) => t.from.endsWith(n)))).toBe(false);
    expect($("legendTwinKey").hidden).toBe(false);
  } finally {
    restoreForm();
  }
});

test("same-key links bypass filters, bundles and the high-degree count, and never reach CSV", async () => {
  try {
    await twoChainScan();
    $("minAmount").value = "999999";
    $("minAmount").dispatchEvent(new window.Event("input"));
    expect(twins().length).toBe(1);
    $("minAmount").value = "0";
    $("minAmount").dispatchEvent(new window.Event("input"));
    $("bundleToggle").checked = true;
    $("bundleToggle").dispatchEvent(new window.Event("change"));
    expect(twins().length).toBe(1);
    $("bundleToggle").checked = false;
    $("bundleToggle").dispatchEvent(new window.Event("change"));
    expect((await captureCsv()).split("\n").filter((l) => l.startsWith("edge,")).length).toBe(4);
    $("degreeThreshold").value = "3";
    $("selectHighDegreeBtn").click();
    expect($("logContent").textContent).toContain("0 node(s) with degree ≥ 3");
  } finally {
    $("minAmount").value = "0";
    $("bundleToggle").checked = false;
    restoreForm();
  }
});

test("toggle off hides the link and is saved", async () => {
  const orig = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  let captured = null;
  URL.createObjectURL = (b) => ((captured = b), "blob:x");
  URL.revokeObjectURL = () => {};
  try {
    await twoChainScan();
    $("twinToggle").checked = false;
    $("twinToggle").dispatchEvent(new window.Event("change"));
    expect(twins().length).toBe(0);
    expect($("legendTwinKey").hidden).toBe(true);
    $("saveBtn").click();
    expect(JSON.parse(await captured.text()).filters.showTwins).toBe(false);
  } finally {
    URL.createObjectURL = orig.create;
    URL.revokeObjectURL = orig.revoke;
    $("twinToggle").checked = true;
    $("twinToggle").dispatchEvent(new window.Event("change"));
    restoreForm();
  }
});

test("clicking a same-key link explains its basis", async () => {
  try {
    await twoChainScan();
    window.vis.Network.first._on.click[0]({ nodes: [], edges: [twins()[0].id] });
    const txt = $("detailsContent").textContent;
    expect(txt).toContain("Same-address link (not a transaction)");
    expect(txt).toContain("Ethereum ↔ Arbitrum One");
    expect(txt).toContain("Same owner is still an inference");
  } finally {
    restoreForm();
  }
});

test("PNG export draws the shown same-key link", async () => {
  try {
    await twoChainScan();
    $("exportPngBtn").click();
    const t = window.vis.Network.last.edges.get().filter((e) => String(e.id).startsWith("twin:"));
    expect(t.length).toBe(1);
    expect(t[0].dashes).toBeTruthy();
    expect(t[0].arrows.to.enabled).toBe(false);
    expect([t[0].from, t[0].to]).toEqual([ID("1", ROOT), ID("42161", ROOT)]);
  } finally {
    restoreForm();
  }
});

test("two chains: every node shows its chain line, edges name their chain, legend row shown", async () => {
  try {
    await twoChainScan();
    expect(visNode(ID("1", ROOT)).label.endsWith("\nEthereum")).toBe(true);
    expect(visNode(ID("42161", ROOT)).label.endsWith("\nArbitrum One")).toBe(true);
    const e = window.vis.Network.first.edges.get().find((x) => x.id.startsWith("42161|"));
    expect(e.title).toContain(" · Arbitrum One");
    expect(legendShown()).toBe(true);
  } finally {
    restoreForm();
  }
});

test("pruning back to one chain removes the chain line", async () => {
  try {
    await twoChainScan();
    const net = window.vis.Network.first;
    net.setSelection({ nodes: net.nodes.getIds().filter((i) => String(i).startsWith("42161:")) });
    $("deleteNodesBtn").click();
    await sleep(0);
    expect(net.nodes.get().some((n) => String(n.label).endsWith("\nEthereum"))).toBe(false);
    expect(legendShown()).toBe(false);
  } finally {
    window.vis.Network.first.setSelection({ nodes: [] });
    restoreForm();
  }
});

test("palette finds both twins of an address, subtitled with their chain", async () => {
  const subs = () => [...document.querySelectorAll("#paletteResults .palette-item-subtitle")].map((e) => e.textContent);
  const search = () => {
    $("searchBtn").click();
    $("paletteInput").value = ROOT;
    $("paletteInput").dispatchEvent(new window.Event("input"));
  };
  try {
    await twoChainScan();
    search();
    expect(subs()).toContain(`${ROOT} · Ethereum`);
    expect(subs()).toContain(`${ROOT} · Arbitrum One`);
    $("paletteInput").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await freshScan("20");
    search();
    expect(subs().filter((s) => s.startsWith(ROOT))).toEqual([ROOT]);
  } finally {
    $("paletteInput").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    restoreForm();
  }
});

test("an unknown-chain node is tagged 'chain 999999' even alone", async () => {
  try {
    await loadAsDemo(v3ws([v3Node("999999", ROOT, { depth: 0, isRoot: true })], []));
    expect(visNode(ID("999999", ROOT)).label.endsWith("\nchain 999999")).toBe(true);
  } finally {
    $("resetBtn").click();
    restoreForm();
  }
});

test("PNG export uses node ids and the chain line", async () => {
  try {
    await twoChainScan();
    $("exportPngBtn").click();
    const net = window.vis.Network.last;
    const nodes = net.nodes.get();
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n.label]));
    expect(byId[ID("1", ROOT)].endsWith("\nEthereum")).toBe(true);
    expect(byId[ID("42161", ROOT)].endsWith("\nArbitrum One")).toBe(true);
    for (const e of net.edges.get()) expect(e.from).toMatch(/^\d+:0x/), expect(e.to).toMatch(/^\d+:0x/);
  } finally {
    restoreForm();
  }
});

test("chain filter: shown at 2 chains, hides one chain's nodes and edges, store untouched, saved", async () => {
  const orig = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  let captured = null;
  try {
    await twoChainScan();
    expect($("chainFilter").hidden).toBe(false);
    expect($("chainFilterList").querySelectorAll("input[type=checkbox]").length).toBe(2);
    const net = window.vis.Network.first;
    const n1 = net.nodes.get().filter((n) => String(n.id).startsWith("1:")).length;
    const e1 = net.edges.get().filter((e) => e.id.startsWith("1|")).length;
    const box = $("chainFilterList").querySelector('[data-chain="42161"]');
    box.checked = false;
    box.dispatchEvent(new window.Event("change", { bubbles: true }));
    expect(net.nodes.get().some((n) => String(n.id).startsWith("42161:"))).toBe(false);
    expect(net.edges.get().some((e) => e.id.startsWith("42161|"))).toBe(false);
    expect(net.nodes.get().filter((n) => String(n.id).startsWith("1:")).length).toBe(n1);
    expect(net.edges.get().filter((e) => e.id.startsWith("1|")).length).toBe(e1);
    const rows = (await captureCsv()).split("\n").filter((l) => l.startsWith("node,") && l.endsWith(",42161"));
    expect(rows.length).toBe(3);
    URL.createObjectURL = (b) => ((captured = b), "blob:x");
    URL.revokeObjectURL = () => {};
    $("saveBtn").click();
    const saved = JSON.parse(await captured.text());
    expect(saved.filters.hiddenChains).toEqual(["42161"]);
    await loadAsDemo(saved);
    expect($("chainFilterList").querySelector('[data-chain="42161"]').checked).toBe(false);
    $("searchBtn").click();
    $("paletteInput").value = ROOT;
    $("paletteInput").dispatchEvent(new window.Event("input"));
    const item = [...document.querySelectorAll("#paletteResults .palette-item")].find((e) => e.textContent.includes("Arbitrum"));
    item.click();
    expect($("chainFilterList").querySelector('[data-chain="42161"]').checked).toBe(true);
    expect(window.vis.Network.first.nodes.get().some((n) => n.id === ID("42161", ROOT))).toBe(true);
  } finally {
    URL.createObjectURL = orig.create;
    URL.revokeObjectURL = orig.revoke;
    $("paletteInput").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    $("resetBtn").click();
    restoreForm();
  }
});
