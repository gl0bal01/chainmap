// Stage C integration test — drives the REAL main.js composition root under a DOM
// emulator (happy-dom) with window.vis + fetch stubbed, so a full scan runs with
// NO browser and NO API key. Also asserts the real ui.js renderers are XSS-inert.
import { test, expect, beforeAll } from "bun:test";
import { Window } from "happy-dom";

const A = (n) => "0x" + String(n).repeat(40).slice(0, 40); // 40-hex address helper
const ROOT = A(1), N2 = A(2), N3 = A(3), N4 = A(4), TOKEN = A(9);

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

function stubFetch() {
  globalThis.fetch = async (url) => {
    const u = String(url);
    // Local bundled datasets (known-addresses / spam-tokens / demo-workspace): serve the real files.
    if (u.includes("data/")) {
      const path = u.replace(/^\.?\//, "");
      try {
        const text = await Bun.file(path).text();
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => JSON.parse(text) };
      } catch {
        return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) };
      }
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
    constructor() { this.items = new Map(); }
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
    get() { return this.ds.get().filter(this.filter); }
    getIds() { return this.get().map((i) => i.id); }
    refresh() {}
    get length() { return this.get().length; }
  }
  class FakeNetwork {
    constructor(container, data) { this.nodes = data.nodes; this.edges = data.edges; this._sel = []; this._on = {}; }
    on(ev, fn) { (this._on[ev] = this._on[ev] || []).push(fn); }
    off(ev, fn) { this._on[ev] = (this._on[ev] || []).filter((f) => f !== fn); }
    getSelectedNodes() { return this._sel; }
    setSelection({ nodes }) { this._sel = nodes || []; }
    setData(data) { this.nodes = data.nodes; this.edges = data.edges; }
    setOptions() {}
    getConnectedEdges(id) { return this.edges.get().filter((e) => e.from === id || e.to === id).map((e) => e.id); }
    getPositions(ids) { const o = {}; for (const id of ids || this.nodes.getIds()) o[id] = { x: 0, y: 0 }; return o; }
    moveNode() {} fit() {} destroy() {} DOMtoCanvas(p) { return p; }
  }
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
  store.addNode(ROOT, { depth: 0, isRoot: true });
  store.addNode(N2, { depth: 1 });
  store.addNode(N4, { depth: 1 });
  store.addEdge({ action: "txlist", group: "normal", color: "#000", from: ROOT, to: N2, tx: { value: "1000000000000000000", hash: "0x1", tokenDecimal: "18" } }); // 1
  store.addEdge({ action: "txlist", group: "normal", color: "#000", from: ROOT, to: N4, tx: { value: "5000000000000000000", hash: "0x2", tokenDecimal: "18" } }); // 5

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
  store.addNode(ROOT, { depth: 0, isRoot: true });
  store.addNode(N2, { depth: 1 });
  store.addEdge({ action: "txlist", group: "normal", color: "#0", from: ROOT, to: N2, tx: { value: "1000000000000000000", hash: "0x1", tokenDecimal: "18" } });
  store.addEdge({ action: "txlist", group: "normal", color: "#0", from: ROOT, to: N2, tx: { value: "2000000000000000000", hash: "0x2", tokenDecimal: "18" } });

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

  store.addNode(ROOT, { depth: 0, isRoot: true });
  store.addNode(N2, { depth: 1 });
  store.addEdge({ action: "txlist", group: "normal", color: "#0", from: ROOT, to: N2, tx: { value: "1000000000000000000", hash: "0x1", tokenDecimal: "18" } });
  view.setBundling(true);
  expect(view.network.edges.get().length).toBe(1);
  store.removeNodes([N2]);
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

test("workspace serialize -> parse -> loadSnapshot round-trips through the store", async () => {
  const { GraphStore } = await import("../src/graphStore.js");
  const { serializeWorkspace, parseWorkspace } = await import("../src/workspace.js");
  const a = new GraphStore();
  a.addNode(ROOT, { depth: 0, isRoot: true });
  a.addNode(N2, { depth: 1 });
  a.setAlias(N2, "friend");
  a.addEdge({ action: "txlist", group: "normal", color: "#0", from: ROOT, to: N2, tx: { value: "1000000000000000000", hash: "0x1", tokenDecimal: "18" } });

  const ws = serializeWorkspace({ chainId: "1", root: ROOT, nodes: a.listNodes(), edges: a.listEdges(), filters: {}, layout: "force", annotations: [] });
  const res = parseWorkspace(JSON.stringify(ws));
  expect(res.ok).toBe(true);

  const b = new GraphStore();
  b.loadSnapshot(res.data.nodes, res.data.edges);
  expect(b.stats()).toEqual({ nodes: 2, edges: 1 });
  expect(b.getAlias(N2)).toBe("friend");
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
