// Stage C integration test — drives the REAL main.js composition root under a DOM
// emulator (happy-dom) with window.vis + fetch stubbed, so a full scan runs with
// NO browser and NO API key. Also asserts the real ui.js renderers are XSS-inert.
import { test, expect, beforeAll } from "bun:test";
import { Window } from "happy-dom";
import KNOWN from "../data/known-addresses.json";
import V2 from "./fixtures/workspace-v2.json";
import { PROBE_CHAIN_IDS, APP_VERSION } from "../src/config.js";
import { sha256Hex } from "../src/queryLog.js";
import { USD_CAVEAT, BRIDGE_CAVEAT } from "../src/evidence.js";
import EN from "../src/locales/en.js";
import { readZip } from "./fixtures/readZip.js";
import TRON_TX from "./fixtures/tron/transactions.json";
import TRON_INTERNAL from "./fixtures/tron/internal.json";
import TRON_TRC20 from "./fixtures/tron/trc20.json";

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
// api.trongrid.io is never contacted: every request lands in tronCalls and is answered from the Task 2
// fixtures. TRON_CANNED is mutable (tests swap a page in); tronStatus is the HTTP status served.
const tronCalls = [];
const TRON_CANNED = { "transactions": TRON_TX, "internal-transactions": TRON_INTERNAL, "transactions/trc20": TRON_TRC20 };
let tronStatus = 200;
// coins.llama.fi is never contacted: priceStub answers every price request and records whether
// the USD box was on when it was sent. priceGate holds price requests like apiGate.
const priceCalls = [];
let priceGate = null;
const PRICE_TABLE = { "coingecko:ethereum": 2000 };
async function priceStub(u, init) {
  priceCalls.push({ url: u, init, boxOn: document.getElementById("usdToggle")?.checked === true });
  if (priceGate) {
    await new Promise((resolve, reject) => {
      priceGate.then(resolve);
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    });
  }
  const coins = {};
  for (const [coin, tss] of Object.entries(JSON.parse(new URL(u).searchParams.get("coins")))) {
    coins[coin] = { prices: tss.map((ts) => ({ timestamp: ts + 60, price: PRICE_TABLE[coin] ?? 1, confidence: 0.99 })) };
  }
  const bytes = new TextEncoder().encode(JSON.stringify({ coins }));
  return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => bytes.buffer };
}

function stubFetch() {
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith("https://coins.llama.fi/")) return priceStub(u, init);
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
    if (u.startsWith("https://api.trongrid.io/")) {
      tronCalls.push({ url: u, init });
      if (apiGate) {
        await new Promise((resolve, reject) => {
          apiGate.then(resolve);
          if (init && init.signal) {
            init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
          }
        });
      }
      const path = (u.match(/\/v1\/accounts\/[^/]+\/([^?]+)/) || [])[1];
      const body = TRON_CANNED[path] || { data: [], success: true, meta: {} };
      return {
        ok: tronStatus >= 200 && tronStatus < 300,
        status: tronStatus,
        headers: { get: () => null },
        arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer,
      };
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
      arrayBuffer: async () => new TextEncoder().encode(JSON.stringify({ status: result.length ? "1" : "0", message: result.length ? "OK" : "No transactions found", result: result.length ? result : "No transactions found" })).buffer,
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
  window.localStorage.setItem("etherscanChainId", "728126428"); // stale Tron choice from an older build: boot must fall back (ruling 16)
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

test("boot falls back from a stored Tron chain (ruling 16)", () => {
  expect($("chainSelect").value).toBe("1");
  expect(localStorage.getItem("etherscanChainId")).toBe("1");
  expect($("tronBox").hidden).toBe(true);
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

test("node details render the Exchange deposit row from evidence (textContent only)", async () => {
  const { createI18n } = await import("../src/i18n.js");
  const en = (await import("../src/locales/en.js")).default;
  const fr = (await import("../src/locales/fr.js")).default;
  const ui = await import("../src/ui.js");
  const i18n = createI18n({ dictionaries: { en, fr }, locale: "en" });
  const node = { address: ROOT, depth: 1, isRoot: false, alias: null };
  const evil = '<img src=x onerror="alert(1)">';
  const dep = {
    walletId: ID("1", N2), wallet: N2, label: evil, swept: 9, outgoing: 10,
    assets: [{ symbol: "ETH", contract: "", sharePct: 100 }, { symbol: evil, contract: TOKEN, sharePct: 93 }],
    maxDelaySec: 5400, timedSweeps: 7,
  };
  const render = (deposit) => {
    const box = document.createElement("div");
    ui.renderNodeDetails(box, node, { i18n, explorer: "etherscan.io", onRename: () => {}, deposit });
    return box;
  };
  const box = render(dep);
  expect(box.querySelector("img")).toBeNull();
  const txt = box.textContent;
  expect(txt).toContain("Exchange deposit");
  expect(txt).toContain(`Likely deposit address of ${evil} (heuristic)`);
  expect(txt).toContain("Forwarded 9 of 10 outgoing transfers to it");
  expect(txt).toContain("100% of the ETH outflow");
  expect(txt).toContain(`93% of the ${evil} outflow`);
  expect(txt).toContain("Swept within 2 h of the latest inflow (7 of 9 sweeps timed)");
  expect(txt).toContain("Based only on the sampled transactions; verify with the exchange.");
  const untimed = render({ ...dep, maxDelaySec: null, timedSweeps: 0 }).textContent;
  expect(untimed).toContain("No inflow seen before the sweep in the sampled data");
  expect(untimed).not.toContain("Swept within");
  expect(render(null).textContent).not.toContain("Exchange deposit");
});

test("graph view appends the deposit line + tooltip from getDeposit; refreshNodes re-applies; French", async () => {
  const { GraphStore } = await import("../src/graphStore.js");
  const { createGraphView } = await import("../src/render/network.js");
  const { createI18n } = await import("../src/i18n.js");
  const en = (await import("../src/locales/en.js")).default;
  const fr = (await import("../src/locales/fr.js")).default;
  const i18n = createI18n({ dictionaries: { en, fr }, locale: "en" });
  const store = new GraphStore();
  let dep = null;
  const view = createGraphView(document.createElement("div"), store, {
    i18n, getAddressFormat: () => "short", getDeposit: (id) => (id === ID("1", N2) ? dep : null),
  });
  try {
    store.addNode("1", ROOT, { depth: 0, isRoot: true });
    store.addNode("1", N2, { depth: 1 });
    const item = (id) => view.network.nodes.get(id);
    expect(item(ID("1", N2)).label).not.toContain("🏦");
    dep = { walletId: ID("1", N3), wallet: N3, label: "Binance 14 (hot wallet)", swept: 1, outgoing: 1, assets: [], maxDelaySec: null, timedSweeps: 0 };
    view.refreshNodes([ID("1", N2), "1:0xmissing"]); // unknown id: skipped, no throw
    expect(item(ID("1", N2)).label.endsWith("\n🏦 likely deposit → Binance 14 (hot wallet)")).toBe(true);
    expect(item(ID("1", N2)).title).toContain("🏦 likely deposit → Binance 14 (hot wallet) (heuristic)");
    expect(item(ID("1", ROOT)).label).not.toContain("🏦");
    i18n.setLocale("fr");
    view.refreshLabels();
    expect(item(ID("1", N2)).label).toContain("dépôt probable");
  } finally {
    view.destroy();
  }
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
  expect(store.chains()).toEqual(["1", "137", "42161"]);
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

const DEPOSIT = "0xdec0000000000000000000000000000000000001";
const BINANCE14 = "0x28c6c06298d514db089934071355e5743bf21d60";
const badged = (id) => (visNode(id)?.label || "").includes("🏦");
const DEP_HIST = {
  txlist: { oldestBlock: "1", blockPage: 0, pageSize: 0, done: true, count: 1 },
  tokentx: { oldestBlock: "0", blockPage: 0, pageSize: 0, done: true, count: 0 },
};

test("demo deposit evidence (pure): exactly one, 0xdec0…0001 -> Binance 14, 1/1, ETH 100%, 600 s", async () => {
  const { parseWorkspace } = await import("../src/workspace.js");
  const { GraphStore } = await import("../src/graphStore.js");
  const { findDeposits } = await import("../src/depositDetect.js");
  const { knownEntry } = await import("../src/knownAddresses.js");
  const demo = JSON.parse(await Bun.file(new URL("../data/demo-workspace.json", import.meta.url)).text());
  const store = new GraphStore();
  const parsed = parseWorkspace(JSON.stringify(demo));
  store.loadSnapshot(parsed.data.nodes, parsed.data.edges);
  const map = findDeposits(store.listNodes(), store.listEdges(), { known: (a, c) => knownEntry(a, c, KNOWN) });
  expect([...map.keys()]).toEqual([ID("1", DEPOSIT)]);
  expect(map.get(ID("1", DEPOSIT))).toEqual({
    walletId: ID("1", BINANCE14), wallet: BINANCE14, label: "Binance 14 (hot wallet)", swept: 1, outgoing: 1,
    assets: [{ symbol: "ETH", contract: "", sharePct: 100 }], maxDelaySec: 600, timedSweeps: 1,
  });
});

test("demo marks the illustrative deposit: badge, tooltip, details row, risk reason, CSV", async () => {
  await knownLoaded();
  try {
    $("resetBtn").click();
    $("demoBtn").click();
    const id = ID("1", DEPOSIT);
    await until(() => badged(id));
    expect(visNode(id).label).toContain("🏦 likely deposit → Binance 14 (hot wallet)");
    expect(visNode(id).title).toContain("(heuristic)");
    expect(badged(ID("1", DEMO_ROOT))).toBe(false);
    window.vis.Network.first._on.click[0]({ nodes: [id], edges: [] });
    const txt = $("detailsContent").textContent;
    expect(txt).toContain("Exchange deposit");
    expect(txt).toContain("Forwarded 1 of 1 outgoing transfers to it");
    expect(txt).toContain("100% of the ETH outflow");
    expect(txt).toContain("Swept within 10 min of the latest inflow (1 of 1 sweeps timed)");
    expect(txt).toContain("likely exchange deposit address");
    const lines = (await captureCsv()).split("\n");
    expect(lines[0]).toContain("likely_deposit_of is a heuristic");
    expect(lines[1].endsWith(",chain_id,likely_deposit_of,deposit_evidence,usd_value,bridge_inferred")).toBe(true);
    const row = lines.find((l) => l.startsWith(`node,${DEPOSIT},`));
    expect(row.endsWith(`,1,Binance 14 (hot wallet),wallet=${BINANCE14};swept=1/1;share=ETH:100%;max_delay_s=600,,`)).toBe(true);
  } finally {
    $("resetBtn").click();
  }
});

test("pruning the hot wallet removes the mark and its details row; reset + reload leaves no stale mark", async () => {
  await knownLoaded();
  try {
    $("resetBtn").click();
    $("demoBtn").click();
    const id = ID("1", DEPOSIT);
    await until(() => badged(id));
    window.vis.Network.first._on.click[0]({ nodes: [id], edges: [] });
    expect($("detailsContent").textContent).toContain("Exchange deposit");
    window.vis.Network.first.setSelection({ nodes: [ID("1", BINANCE14)] });
    $("deleteNodesBtn").click();
    await until(() => !badged(id));
    expect(badged(id)).toBe(false);
    await until(() => !$("detailsContent").textContent.includes("Exchange deposit"));
    expect($("detailsContent").textContent).not.toContain("Exchange deposit");
    // Reset + reload the SAME node (with history) but no sweep edge: the old evidence must not survive.
    $("resetBtn").click();
    $("demoBtn").click();
    await until(() => badged(id));
    expect(badged(id)).toBe(true);
    await loadAsDemo(v3ws(
      [v3Node("1", ROOT, { depth: 0, isRoot: true }), v3Node("1", DEPOSIT, { history: DEP_HIST })],
      [v3Edge({ hash: "0xs1", to: DEPOSIT })],
    ));
    await until(() => visNode(id) && !badged(id));
    expect(visNode(id)).toBeDefined();
    expect(badged(id)).toBe(false);
    window.vis.Network.first._on.click[0]({ nodes: [id], edges: [] });
    expect($("detailsContent").textContent).not.toContain("Exchange deposit");
    const lines = (await captureCsv()).split("\n");
    expect(lines[0]).not.toContain("likely_deposit_of");
    expect(lines.find((l) => l.startsWith(`node,${DEPOSIT},`)).endsWith(",1,,,,")).toBe(true);
  } finally {
    $("resetBtn").click();
    restoreForm();
  }
});

test("a saved workspace never carries deposit evidence", async () => {
  await knownLoaded();
  const orig = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  let captured = null;
  try {
    $("resetBtn").click();
    $("demoBtn").click();
    await until(() => badged(ID("1", DEPOSIT)));
    URL.createObjectURL = (b) => ((captured = b), "blob:x");
    URL.revokeObjectURL = () => {};
    $("saveBtn").click();
    const saved = JSON.parse(await captured.text());
    expect(saved.version).toBe(3);
    const keys = [Object.keys(saved), Object.keys(saved.graph), ...saved.graph.nodes.map(Object.keys), ...saved.graph.edges.map(Object.keys)].flat();
    expect(keys.filter((k) => /deposit/i.test(k))).toEqual([]);
  } finally {
    URL.createObjectURL = orig.create;
    URL.revokeObjectURL = orig.revoke;
    $("resetBtn").click();
  }
});

test("a scan whose root sweeps to a known exchange wallet is marked when the scan ends", async () => {
  await knownLoaded();
  const prev = { txlist: CANNED.txlist, tokentx: CANNED.tokentx };
  CANNED.txlist = [{ from: ROOT, to: BINANCE14, value: "1000000000000000000", hash: "0xdd1", isError: "0", txreceipt_status: "1", timeStamp: "1700000000", blockNumber: "100" }];
  CANNED.tokentx = [];
  try {
    await freshScan("20");
    await until(() => badged(ID("1", ROOT)));
    expect(visNode(ID("1", ROOT)).label).toContain("Binance 14 (hot wallet)");
  } finally {
    Object.assign(CANNED, prev);
    $("resetBtn").click();
    restoreForm();
  }
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
async function freshScan(maxTx, apiKey = "TESTKEY") {
  $("resetBtn").click();
  $("apiKey").value = apiKey;
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
    const noStamp = (text) => text.replace(/; exported \S+ UTC/, ""); // line 1 carries the export time
    expect(noStamp(await csv())).toBe(noStamp(before));
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
        : { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify({ status: "0", message: "NOTOK", result: "Invalid API Key" })).buffer };
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

async function loadAsDemo(ws, done = /Demo workspace loaded/, reset = true) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, init) => (String(u).includes("demo-workspace")
    ? { ok: true, status: 200, headers: { get: () => null }, json: async () => ws }
    : realFetch(u, init));
  try {
    if (reset) $("resetBtn").click();
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
        : { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify({ status: "0", message: "NOTOK", result: "Invalid API Key" })).buffer };
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
    for (const l of data) expect(/,(1|56),,,,$/.test(l)).toBe(true);
    const m1 = lines.find((l) => l.includes("0xm1")), m2 = lines.find((l) => l.includes("0xm2"));
    expect(m1).toContain("flag.mixer");
    expect(m1.endsWith(",1,,,,")).toBe(true);
    expect(m2).not.toContain("flag.mixer");
    expect(m2.endsWith(",56,,,,")).toBe(true);
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
    const rows = (await captureCsv()).split("\n").filter((l) => l.startsWith("node,") && l.endsWith(",42161,,,,"));
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

// --- final review fixes -----------------------------------------------------
test("twin edges diff-sync: an unchanged refresh adds/removes none; a locale switch retitles in place", async () => {
  const { GraphStore } = await import("../src/graphStore.js");
  const { createGraphView } = await import("../src/render/network.js");
  const store = new GraphStore();
  let loc = "en";
  const view = createGraphView(document.createElement("div"), store, { i18n: { t: (k) => `${loc}:${k}` }, getAddressFormat: () => "short" });
  store.addNode("1", ROOT, { depth: 0, isRoot: true });
  store.addNode("1", N2, { depth: 1 });
  store.addNode("42161", ROOT, { depth: 0, isRoot: true });
  store.addEdge({ chainId: "1", action: "txlist", group: "normal", color: "#0", from: ROOT, to: N2, tx: { value: "1", hash: "0x1", tokenDecimal: "18" } });
  view.setTwins(true);
  const ds = view.network.edges.ds;
  const calls = { add: 0, remove: 0 };
  const isTwin = (x) => String(x?.id ?? x).startsWith("twin:");
  const { add, remove } = ds;
  ds.add = function (o) { calls.add += [].concat(o).filter(isTwin).length; return add.call(this, o); };
  ds.remove = function (o) { calls.remove += [].concat(o).filter(isTwin).length; return remove.call(this, o); };
  const twin = () => ds.get().filter((e) => e.twin);
  view.refreshProjection();
  calls.add = calls.remove = 0;
  view.refreshProjection();
  expect(calls).toEqual({ add: 0, remove: 0 });
  expect(twin().length).toBe(1);
  loc = "fr";
  view.refreshProjection();
  expect(calls).toEqual({ add: 0, remove: 0 });
  expect(twin()[0]).toMatchObject({ title: "fr:legend.twinKey", label: "fr:details.twinKey" });
  view.setTwins(false);
  expect(twin().length).toBe(0);
});

test("a Load on {chain} that finds no transactions removes the node and says so, at info", async () => {
  const realFetch = globalThis.fetch;
  try {
    await freshScan("20");
    clickNode(ID("1", ROOT));
    globalThis.fetch = async (url, init) =>
      String(url).includes("data/") || !String(url).includes("chainid=42161")
        ? realFetch(url, init)
        : { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify({ status: "0", message: "No transactions found", result: "No transactions found" })).buffer };
    const sel = $("detailsContent").querySelector("select");
    sel.value = "42161";
    sel.dispatchEvent(new window.Event("change"));
    detailBtn("Load on Arbitrum One").click();
    await waitLoaded();
    await sleep(0);
    expect(window.vis.Network.first.nodes.getIds().some((id) => String(id).startsWith("42161:"))).toBe(false);
    const log = $("logContent").textContent;
    expect(log).toContain("No transactions found for this address on Arbitrum One; the node was not added.");
    expect(log).not.toContain("Added Arbitrum One");
    expect(log).not.toContain("Nothing could be loaded");
    expect([...$("logContent").children].at(-1).className).not.toBe("err");
  } finally {
    globalThis.fetch = realFetch;
    restoreForm();
  }
});

test("Load on {chain} leaves the details panel on whatever the user selected meanwhile", async () => {
  let release = () => {};
  try {
    await freshScan("20");
    clickNode(ID("1", ROOT));
    const sel = $("detailsContent").querySelector("select");
    sel.value = "42161";
    sel.dispatchEvent(new window.Event("change"));
    release = gate();
    detailBtn("Load on Arbitrum One").click();
    clickNode(ID("1", N2));
    release();
    await waitLoaded();
    await sleep(0);
    expect($("detailsContent").textContent).toContain(N2);
    expect($("detailsContent").textContent).not.toContain(ROOT);
  } finally {
    release();
    restoreForm();
  }
});

test("a twin link's details clear once the link is gone (toggle off, prune)", async () => {
  const net = window.vis.Network.first;
  const setTwins = (on) => {
    $("twinToggle").checked = on;
    $("twinToggle").dispatchEvent(new window.Event("change"));
  };
  const showTwin = () => {
    net._on.click[0]({ nodes: [], edges: [twins()[0].id] });
    expect($("detailsContent").textContent).toContain("Same-address link");
  };
  try {
    await twoChainScan();
    showTwin();
    setTwins(false);
    expect($("detailsContent").textContent).toBe("Click a node or an arrow in the graph.");
    setTwins(true);
    showTwin();
    net.setSelection({ nodes: [ID("42161", ROOT)] });
    $("deleteNodesBtn").click();
    expect($("detailsContent").textContent).toBe("Click a node or an arrow in the graph.");
  } finally {
    setTwins(true);
    net.setSelection({ nodes: [] });
    restoreForm();
  }
});

test("prune is refused while a scan runs (button and Delete key)", async () => {
  let release = () => {};
  const net = window.vis.Network.first;
  try {
    await freshScan("20");
    release = gate();
    $("startBtn").click();
    await until(() => apiUrls.length && $("startBtn").disabled);
    net.setSelection({ nodes: [ID("1", N2)] });
    $("deleteNodesBtn").click();
    document.activeElement?.blur?.();
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Delete" }));
    expect(nodeIds()).toContain(ID("1", N2));
    expect([...$("logContent").children].filter((l) => l.textContent.includes("Busy — wait")).length).toBe(2);
  } finally {
    $("stopBtn").click();
    release();
    await until(() => !$("startBtn").disabled);
    net.setSelection({ nodes: [] });
    restoreForm();
  }
});

test("palette edge subtitles name the chain once the graph spans 2 chains", async () => {
  const S = (a) => a.slice(0, 5) + "…" + a.slice(-4);
  const subs = () => [...document.querySelectorAll("#paletteResults .palette-item-subtitle")].map((e) => e.textContent);
  const search = (q) => {
    $("searchBtn").click();
    $("paletteInput").value = q;
    $("paletteInput").dispatchEvent(new window.Event("input"));
  };
  const close = () => $("paletteInput").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  try {
    await twoChainScan();
    search("0xaaa");
    expect(subs()).toContain(`${S(ROOT)} → ${S(N2)} · Ethereum`);
    expect(subs()).toContain(`${S(ROOT)} → ${S(N2)} · Arbitrum One`);
    close();
    await freshScan("20");
    search("0xaaa");
    expect(subs()).toEqual([`${S(ROOT)} → ${S(N2)}`]);
  } finally {
    close();
    restoreForm();
  }
});

// ---- query-log panel ----
async function qlogEnv() {
  const { createI18n } = await import("../src/i18n.js");
  const en = (await import("../src/locales/en.js")).default;
  const fr = (await import("../src/locales/fr.js")).default;
  const ui = await import("../src/ui.js");
  return { ui, i18n: createI18n({ dictionaries: { en, fr }, locale: "en" }) };
}
const qEntry = (i, over = {}) => ({
  at: `2026-11-16T10:00:${String(i % 60).padStart(2, "0")}.000Z`, chainId: "1", action: "txlist",
  params: { address: A(1), page: 1, offset: 20 }, httpStatus: 200, rows: 3,
  sha256: "ab".repeat(32), outcome: "ok", ...over,
});

test("renderQueryLog: rows newest first via textContent", async () => {
  const { ui, i18n } = await qlogEnv();
  const c = document.createElement("div");
  const evil = "<img src=x onerror=alert(1)>";
  ui.renderQueryLog(c, [qEntry(1, { action: evil }), qEntry(2)], { i18n, dropped: 0, unloggedData: false, limit: 5000 });
  const rows = c.querySelectorAll("tbody tr");
  expect(rows.length).toBe(2);
  expect(rows[0].textContent).toContain("10:00:02");
  expect(c.querySelector("img")).toBeNull();
  expect(rows[1].textContent).toContain(evil);
  const sha = [...rows[0].querySelectorAll("td")].find((td) => td.title === "ab".repeat(32));
  expect(sha.textContent.length).toBe(12);
});

test("renderQueryLog: 250 entries → 200 rows + showing note", async () => {
  const { ui, i18n } = await qlogEnv();
  const c = document.createElement("div");
  ui.renderQueryLog(c, Array.from({ length: 250 }, (_, i) => qEntry(i)), { i18n, dropped: 0, unloggedData: false, limit: 5000 });
  expect(c.querySelectorAll("tbody tr").length).toBe(200);
  expect(c.textContent).toContain("Showing the latest 200 of 250 requests.");
});

test("renderQueryLog: empty / dropped / unlogged notes", async () => {
  const { ui, i18n } = await qlogEnv();
  const c = document.createElement("div");
  ui.renderQueryLog(c, [], { i18n, dropped: 0, unloggedData: false, limit: 5000 });
  expect(c.textContent).toContain("No request logged in this session.");
  ui.renderQueryLog(c, [qEntry(1)], { i18n, dropped: 7, unloggedData: true, limit: 5000 });
  expect(c.textContent).toContain("7 older entries were dropped (log limit 5000).");
  expect(c.textContent).toContain("Part of this graph was not retrieved under this log");
  expect(c.textContent).not.toContain("No request logged");
});

const usdEdge = (over = {}) => ({
  key: "k", action: "txlist", group: "normal", from: ROOT, to: N2, hash: "0x1",
  symbol: "ETH", amountText: "5", amountIndeterminate: false, tokenContract: "", tokenId: "",
  value: "5", timeStamp: "1700000000", blockNumber: "1", hasData: false, ...over,
});
const usdRender = async (usd, over = {}, locale = "en") => {
  const { ui, i18n } = await qlogEnv();
  i18n.setLocale(locale);
  const el = document.createElement("div");
  ui.renderEdgeDetails(el, usdEdge(over), { i18n, explorer: null, getAlias: () => null, usd });
  return { el, i18n };
};

test("usd row: ok shows grouped estimate + unit hint", async () => {
  const EN = (await import("../src/locales/en.js")).default;
  const at = 1700002860;
  const usd = { state: "ok", text: "1234567.50", price: 2000, at, confidence: 0.99 };
  const { el } = await usdRender(usd);
  const t = el.textContent;
  expect(t).toContain(EN["usd.label"]);
  expect(t).toContain("≈ 1,234,567.50 USD");
  expect(t).toContain("2000 USD per ETH");
  expect(t).toContain(new Date(at * 1000).toISOString().slice(0, 16).replace("T", " "));
  expect(t).toContain("0.99");
  const fr = await usdRender(usd, {}, "fr");
  expect(fr.el.textContent).toMatch(/1\D234\D567,50/);
});

test("usd row: states", async () => {
  const EN = (await import("../src/locales/en.js")).default;
  for (const [usd, key] of [
    [{ state: "pending" }, "usd.pending"], [{ state: "none" }, "usd.unknown"],
    [{ state: "error" }, "usd.error"], [{ state: "skip", reason: "root" }, "usd.skip.root"],
  ]) {
    const { el } = await usdRender(usd);
    expect(el.textContent).toContain(EN[key]);
    expect(el.textContent).not.toContain("0.00");
  }
  const { el } = await usdRender({ state: "ok", text: "1.00", price: 1, at: 1700000000, confidence: null });
  expect(el.textContent).toContain("confidence —");
});

test("usd row absent when usd null/undefined", async () => {
  const EN = (await import("../src/locales/en.js")).default;
  for (const usd of [null, undefined]) {
    const { el } = await usdRender(usd);
    expect(el.textContent).not.toContain(EN["usd.label"]);
  }
});

test("usd row: hostile symbol stays text", async () => {
  const { el } = await usdRender({ state: "ok", text: "1.00", price: 1, at: 1700000000, confidence: 1 }, { symbol: "<img src=x onerror=alert(1)>" });
  expect(el.querySelector("img")).toBeNull();
});

test("query log price row", async () => {
  const { ui, i18n } = await qlogEnv();
  const coins = JSON.stringify({ "ethereum:0xaa": [1700000000], "ethereum:0xbb": [1700000000] });
  const priceEntry = {
    at: "2026-11-16T10:01:00.000Z", source: "defillama", chainId: null, action: "batchHistorical",
    params: { coins, searchWidth: "30m" }, httpStatus: 200, rows: 2, sha256: "cd".repeat(32), outcome: "ok",
  };
  const c = document.createElement("div");
  ui.renderQueryLog(c, [qEntry(1), priceEntry], { i18n, dropped: 0, unloggedData: false, limit: 5000 });
  const rows = c.querySelectorAll("tbody tr");
  const cells = [...rows[0].querySelectorAll("td")];
  expect(cells[1].textContent).toBe("DefiLlama");
  expect(cells[2].textContent).toBe("batchHistorical");
  expect(cells[3].textContent).toBe("2");
  expect(cells[3].title).toBe(coins);
  expect(cells[4].textContent).toBe("—");
  const eth = [...rows[1].querySelectorAll("td")];
  expect(eth[1].textContent).toBe("1");
  expect(eth[4].textContent).toBe("1/20");
});

test("shell has the bundle + query-log controls", () => {
  expect($("evidenceBundleBtn").textContent).toBe("Evidence bundle (.zip)");
  expect($("exportQueryLogBtn")).not.toBeNull();
});

// ---- P5 evidence exports: main.js wiring (query log lifecycle, provenance, bundle) ----
const QLOG_FILES = ["graph.csv", "workspace.json", "graph.png", "query-log.json", "MANIFEST.json", "SHA256SUMS"];
const qlogTitle = () => $("queryLogTitle").textContent;
const logCount = (re) => ($("logContent").textContent.match(re) || []).length;
const dec = (u8) => new TextDecoder().decode(u8);
const QL_ENTRY = {
  at: "2026-11-16T10:00:00.000Z", chainId: "1", action: "txlist",
  params: { chainid: "1", module: "account", action: "txlist", address: ROOT, startblock: "0", endblock: "99999999", page: "1", offset: "20", sort: "desc" },
  httpStatus: 200, rows: 1, sha256: "ab".repeat(32), outcome: "ok",
};
const qlWs = (entries) => ({
  ...v3ws([v3Node("1", ROOT, { depth: 0, isRoot: true }), v3Node("1", N2)], [v3Edge({ hash: "0xq1" })]),
  queryLog: { entries, dropped: 0, unloggedData: false },
});

// Records every Blob URL and anchor download main.js triggers; restores the globals in finally.
async function withDownloads(fn) {
  const P = window.HTMLAnchorElement.prototype;
  const orig = { create: URL.createObjectURL, revoke: URL.revokeObjectURL, ownClick: Object.hasOwn(P, "click"), click: P.click };
  const dl = { blobs: [], names: [] };
  URL.createObjectURL = (b) => (dl.blobs.push(b), "blob:x");
  URL.revokeObjectURL = () => {};
  P.click = function () { dl.names.push(this.download); };
  try {
    return await fn(dl);
  } finally {
    URL.createObjectURL = orig.create;
    URL.revokeObjectURL = orig.revoke;
    if (orig.ownClick) P.click = orig.click; else delete P.click;
  }
}
// Click `id` and wait for the Blob it downloads.
async function nextBlob(dl, id) {
  const n = dl.blobs.length;
  $(id).click();
  await until(() => dl.blobs.length > n);
  expect(dl.blobs.length).toBe(n + 1);
  return dl.blobs[n];
}
// Lets render/export.js draw on the fake vis network: afterDrawing fires on fit(), the vis canvas is
// 100x60 and composite canvases are fakes whose toBlob yields 4 PNG-signature bytes. Footer text is recorded.
async function withFakeExportCanvas(fn) {
  const P = window.vis.Network.prototype;
  const orig = { once: P.once, fit: P.fit, create: document.createElement };
  const fx = { texts: [] };
  const ctx = {
    font: "10px sans-serif", fillRect() {}, drawImage() {},
    fillText: (s) => fx.texts.push(s), measureText: (s) => ({ width: s.length }),
  };
  P.once = function (ev, cb) { if (ev === "afterDrawing") this._afterDrawing = cb; };
  P.fit = function () { if (this._afterDrawing) this._afterDrawing(); };
  Object.defineProperty(P, "canvas", { configurable: true, get: () => ({ frame: { canvas: { width: 100, height: 60 } } }) });
  document.createElement = function (tag, ...rest) {
    if (tag !== "canvas") return orig.create.call(this, tag, ...rest);
    return {
      width: 0, height: 0, getContext: () => ctx, toDataURL: () => "data:image/png;base64,",
      toBlob: (cb) => cb(new Blob([Uint8Array.of(0x89, 0x50, 0x4e, 0x47)])),
    };
  };
  try {
    return await fn(fx);
  } finally {
    P.once = orig.once;
    P.fit = orig.fit;
    delete P.canvas;
    delete document.createElement;
    if (document.createElement !== orig.create) document.createElement = orig.create;
  }
}
// Drop a workspace file on the graph and wait for its "Workspace loaded" line.
async function dropWorkspace(text) {
  const n = logCount(/Workspace loaded/g);
  const ev = new window.Event("drop");
  ev.dataTransfer = { files: [{ text: async () => text }] };
  $("graph").dispatchEvent(ev);
  await until(() => logCount(/Workspace loaded/g) > n);
  expect(logCount(/Workspace loaded/g)).toBe(n + 1);
}
const bundleBytes = (dl) => withFakeExportCanvas(async () => new Uint8Array(await (await nextBlob(dl, "evidenceBundleBtn")).arrayBuffer()));

test("API key appears in no artifact: log, workspace, CSV, query-log export, bundle, filenames, logger", async () => {
  const KEY = "SECRETKEY_P5_TEST";
  const prevKey = $("apiKey").value;
  try {
    await withDownloads(async (dl) => {
      await freshScan("20", KEY);
      expect(apiUrls.some((u) => u.includes(KEY))).toBe(true); // sanity: the key really was sent
      const ws = await (await nextBlob(dl, "saveBtn")).text();
      const csv = await (await nextBlob(dl, "exportCsvBtn")).text();
      const ql = await (await nextBlob(dl, "exportQueryLogBtn")).text();
      const saved = JSON.parse(ws);
      const n = saved.queryLog.entries.length;
      expect(n).toBeGreaterThan(0);
      expect(saved.queryLog.entries.every((e) => e.url.startsWith("https://api.etherscan.io/v2/api?"))).toBe(true);
      expect(JSON.parse(ql).entries.length).toBe(n);
      expect($("logContent").textContent).toContain(`Query log exported (${n} entries).`);
      // The bundle PNG and the PNG/PDF exports: record every footer line drawn on the canvas.
      const origPdf = window.jspdf;
      window.jspdf = { jsPDF: class { addImage() {} save() {} } };
      let zip, footers;
      try {
        ({ zip, footers } = await withFakeExportCanvas(async (fx) => {
          const z = new TextDecoder("latin1").decode(new Uint8Array(await (await nextBlob(dl, "evidenceBundleBtn")).arrayBuffer()));
          await until(() => /Evidence bundle exported/.test($("logContent").textContent));
          for (const [btn, done] of [["exportPngBtn", /Image \(PNG\) downloaded/g], ["exportPdfBtn", /PDF downloaded/g]]) {
            const c = logCount(done);
            $(btn).click();
            await until(() => logCount(done) > c);
          }
          return { zip: z, footers: fx.texts.join("\n") };
        }));
      } finally {
        window.jspdf = origPdf;
      }
      expect(footers.split("\n").length).toBeGreaterThanOrEqual(12); // 3 renders x >= 4 footer lines
      expect(footers).toContain("logged requests:");
      $("queryLogPanel").open = true;
      const panel = $("queryLogContent").textContent;
      expect(panel).toContain("0x111…1111"); // the requested address, from params
      expect(dl.names).toEqual([
        "workspace.json",
        expect.stringMatching(/^graph-\d+\.csv$/),
        expect.stringMatching(/^query-log-\d{8}T\d{6}Z\.json$/),
        expect.stringMatching(/^chainmap-evidence-\d{8}T\d{6}Z\.zip$/),
        expect.stringMatching(/^graph-\d+\.png$/),
      ]);
      const artifacts = { ws, csv, ql, zip, footers, names: dl.names.join("\n"), log: $("logContent").textContent, panel };
      for (const [name, text] of Object.entries(artifacts)) {
        expect([name, text.includes(KEY) || text.includes(KEY.slice(0, 9))]).toEqual([name, false]);
      }
    });
  } finally {
    $("queryLogPanel").open = false;
    $("apiKey").value = prevKey;
    $("resetBtn").click();
    restoreForm();
  }
});

test("evidence bundle from main: six verified files, complete retrieval, zip hash logged, shared text builders", async () => {
  try {
    await withDownloads(async (dl) => {
      await freshScan("20");
      const savedWs = await (await nextBlob(dl, "saveBtn")).text();
      const zip = await bundleBytes(dl);
      const files = readZip(zip);
      expect(files.map((f) => f.name)).toEqual(QLOG_FILES);
      const bytes = Object.fromEntries(files.map((f) => [f.name, f.bytes]));
      const sums = dec(bytes.SHA256SUMS).trimEnd().split("\n");
      expect(sums.map((l) => l.split("  ")[1])).toEqual(QLOG_FILES.slice(0, 5));
      for (const l of sums) {
        const [hex, name] = l.split("  ");
        expect(await sha256Hex(bytes[name])).toBe(hex);
      }
      const m = JSON.parse(dec(bytes["MANIFEST.json"]));
      expect(m.files.map((f) => f.name)).toEqual(QLOG_FILES.slice(0, 4));
      for (const f of m.files) {
        expect(f.sha256).toBe(await sha256Hex(bytes[f.name]));
        expect(f.bytes).toBe(bytes[f.name].length);
      }
      expect(m.retrieval.fullyLogged).toBe(true);
      expect(m.chains).toEqual([{ chainId: "1", name: "Ethereum" }]);
      expect(m.roots).toEqual([ID("1", ROOT)]);
      expect(m.sampling.formAtExport).toMatchObject({ maxDepth: 1, maxTxPerAddress: 20 });
      expect(m.sampling.observed.actions).toContain("txlist");
      expect(m.data.knownAddresses.entries).toBeGreaterThan(0);
      await until(() => /Evidence bundle exported/.test($("logContent").textContent));
      expect($("logContent").textContent).toContain(await sha256Hex(zip));
      // One exportedAt for every member; workspace.json is the saved workspace's text builder (bytes equal but for savedAt).
      const bundledWs = dec(bytes["workspace.json"]);
      expect(JSON.parse(bundledWs).savedAt).toBe(m.exportedAt);
      expect(savedWs.replace(JSON.parse(savedWs).savedAt, m.exportedAt)).toBe(bundledWs);
      expect(JSON.parse(dec(bytes["query-log.json"])).exportedAt).toBe(m.exportedAt);
      expect(dec(bytes["graph.csv"]).split("\n")[0]).toContain(`; exported ${m.exportedAt} UTC; retrieved ${m.retrieval.first} to ${m.retrieval.last} UTC`);
    });
  } finally {
    $("resetBtn").click();
    restoreForm();
  }
});

test("query log: reset clears it, workspace load restores it; delete-nodes keeps it; a locale switch re-renders it", async () => {
  try {
    await withDownloads(async (dl) => {
      await freshScan("20");
      const title = qlogTitle();
      const n = Number((/^Query log \((\d+)\)$/.exec(title) || [])[1]);
      expect(n).toBeGreaterThan(0);
      window.vis.Network.first.setSelection({ nodes: [ID("1", N2)] });
      $("deleteNodesBtn").click();
      expect($("logContent").textContent).toContain("1 node(s) removed");
      expect(qlogTitle()).toBe(title);
      $("queryLogPanel").open = true;
      expect($("queryLogContent").querySelectorAll("tbody tr").length).toBe(n);
      expect($("queryLogContent").textContent).toContain("Time (UTC)");
      $("langToggle").click();
      await until(() => qlogTitle() !== title);
      expect(qlogTitle()).toBe(`Journal des requêtes (${n})`);
      expect($("queryLogContent").textContent).toContain("Heure (UTC)");
      $("langToggle").click();
      await until(() => qlogTitle() === title);
      expect($("queryLogContent").textContent).toContain("Time (UTC)");
      const saved = await (await nextBlob(dl, "saveBtn")).text();
      $("resetBtn").click();
      expect(qlogTitle()).toBe("Query log (0)");
      expect($("queryLogContent").textContent).toContain("No request logged in this session.");
      await dropWorkspace(saved);
      expect(qlogTitle()).toBe(title);
      expect($("queryLogContent").querySelectorAll("tbody tr").length).toBe(n);
    });
  } finally {
    $("queryLogPanel").open = false;
    if (document.documentElement.getAttribute("lang") === "fr") $("langToggle").click();
    $("resetBtn").click();
    restoreForm();
  }
});

test("demo empties the query log even when the file has one; demo → save → load stays partial", async () => {
  const line1 = async (dl) => (await (await nextBlob(dl, "exportCsvBtn")).text()).split("\n")[0];
  try {
    await withDownloads(async (dl) => {
      await loadAsDemo(qlWs([QL_ENTRY]));
      expect(qlogTitle()).toBe("Query log (0)");
      expect(await line1(dl)).toContain("; retrieval time unknown (no query log)");
      const savedCopy = await (await nextBlob(dl, "saveBtn")).text();
      expect(JSON.parse(savedCopy).queryLog).toEqual({ entries: [], dropped: 0, unloggedData: true });
      await dropWorkspace(savedCopy);
      expect(qlogTitle()).toBe("Query log (0)");
      expect(await line1(dl)).toContain("; retrieval time unknown (no query log)");
    });
  } finally {
    $("resetBtn").click();
    restoreForm();
  }
});

test("invalid query-log entries in a loaded file are ignored and logged", async () => {
  try {
    $("resetBtn").click();
    await dropWorkspace(JSON.stringify(qlWs([QL_ENTRY, { ...QL_ENTRY, at: "yesterday" }, { ...QL_ENTRY, sha256: "XYZ" }])));
    expect($("logContent").textContent).toContain("2 invalid query-log entries in the file were ignored.");
    expect(qlogTitle()).toBe("Query log (1)");
  } finally {
    $("resetBtn").click();
    restoreForm();
  }
});

test("query log: an absent page/offset renders as —/—, never undefined", async () => {
  try {
    $("resetBtn").click();
    const { page, offset, ...params } = QL_ENTRY.params;
    await dropWorkspace(JSON.stringify(qlWs([{ ...QL_ENTRY, params }])));
    expect(qlogTitle()).toBe("Query log (1)");
    $("queryLogPanel").open = true;
    $("queryLogPanel").dispatchEvent(new window.Event("toggle"));
    const cells = [...$("queryLogContent").querySelectorAll("tbody tr td")].map((td) => td.textContent);
    expect(cells[4]).toBe("—/—");
    expect($("queryLogContent").textContent).not.toContain("undefined");
  } finally {
    $("queryLogPanel").open = false;
    $("resetBtn").click();
    restoreForm();
  }
});

test("query log: a request in flight across a reset never lands in the new log", async () => {
  let release = () => {};
  try {
    $("resetBtn").click();
    $("apiKey").value = "TESTKEY";
    $("address").value = ROOT;
    const n = apiUrls.length;
    release = gate();
    $("estimateBtn").click(); // its first fetch is now held
    await until(() => apiUrls.length > n);
    $("resetBtn").click();
    release();
    await until(() => /Estimated: /.test($("logContent").textContent));
    expect(qlogTitle()).toBe("Query log (0)");
  } finally {
    release();
    $("apiKey").value = "";
    $("address").value = "";
    $("resetBtn").click();
    restoreForm();
  }
});

test("PNG and PDF exports carry the provenance footer and the live view's deposit badge", async () => {
  await knownLoaded();
  const origPdf = window.jspdf;
  const pdfs = [];
  try {
    await withDownloads(async (dl) => {
      $("resetBtn").click();
      $("demoBtn").click();
      const id = ID("1", DEPOSIT);
      await until(() => badged(id));
      const live = visNode(id).label.split("\n").find((l) => l.startsWith("🏦"));
      expect(live).toBe("🏦 likely deposit → Binance 14 (hot wallet)");
      window.jspdf = { jsPDF: class { addImage() {} save(name) { pdfs.push(name); } } };
      await withFakeExportCanvas(async (fx) => {
        for (const [btn, done] of [["exportPngBtn", /Image \(PNG\) downloaded/], ["exportPdfBtn", /PDF downloaded/]]) {
          fx.texts.length = 0;
          $(btn).click();
          await until(() => done.test($("logContent").textContent));
          expect(window.vis.Network.last.nodes.get(id).label.endsWith("\n" + live)).toBe(true);
          expect(fx.texts.length).toBe(5);
          const ver = APP_VERSION.replace(/\./g, "\\.");
          expect(fx.texts[0]).toMatch(new RegExp(`^chainmap ${ver} — exported \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d UTC$`));
          expect(fx.texts.slice(1)).toEqual([EN["export.footer.retrievalUnknown"], EN["export.footer.sampling"], EN["export.footer.signals"], EN["export.footer.bridges"]]);
        }
      });
      expect(pdfs.length).toBe(1);
      expect(dl.names.some((n) => /^graph-\d+\.png$/.test(n))).toBe(true);
    });
  } finally {
    window.jspdf = origPdf;
    $("resetBtn").click();
  }
});

// ---- P6 USD values (opt-in): main.js wiring ----
const UH = (n) => "0x" + "f".repeat(63) + n; // distinct 66-char tx hashes
const USD_TS = "1600000000"; // hour 1599998400; the canned scan's 1700000000 falls in another hour
const usdTok = (hash, symbol, contract, over = {}) =>
  v3Edge({ hash, action: "tokentx", group: "token", color: "#4fd67a", symbol, tokenContract: contract, timeStamp: USD_TS, ...over });
const USD_E = {
  native: v3Edge({ hash: UH(1), value: "1000000000000000000", tokenDecimal: "", timeStamp: USD_TS }),
  tok: usdTok(UH(2), "FOO", N3, { value: "5000000" }),
  fake: usdTok(UH(3), "USDT", A(7)),
  spam: usdTok(UH(4), "SPAMX", SPAM_STAR),
  rootTok: usdTok(UH(5), "RT", ROOT),
  nft: usdTok(UH(6), "NFT", A(8), { action: "tokennfttx", tokenId: "7", tokenDecimal: "0", value: "1" }),
  zero: v3Edge({ hash: UH(7), to: N3, value: "0", timeStamp: USD_TS }),
};
const usdWs = (extraNodes = []) =>
  v3ws([v3Node("1", ROOT, { depth: 0, isRoot: true }), v3Node("1", N2), v3Node("1", N3), ...extraNodes], Object.values(USD_E));
const CANON_USDT = Object.keys(KNOWN["1"]).find((a) => KNOWN["1"][a].category === "token" && KNOWN["1"][a].symbol === "USDT");
const tick = (on) => {
  $("usdToggle").checked = on;
  $("usdToggle").dispatchEvent(new window.Event("change"));
};
const holdPrices = () => {
  let release;
  priceGate = new Promise((r) => (release = r));
  return () => {
    priceGate = null;
    release();
  };
};
const usdDone = () => logCount(/USD estimates:/g);
const coinsOf = (call) => JSON.parse(new URL(call.url).searchParams.get("coins"));
const pairsOf = (call) => Object.entries(coinsOf(call)).flatMap(([coin, tss]) => tss.map((ts) => `${coin}@${ts}`));
const openEdge = (hash) => {
  window.vis.Network.first._on.click[0]({ nodes: [], edges: [edgeByHash(hash).id] });
  return $("detailsContent").textContent;
};
// Local data settled (known addresses + spam list), then a fresh epoch holding `ws`.
async function usdLoad(ws = usdWs()) {
  await knownLoaded();
  await until(() => spamLoads > 0);
  await dropWorkspace(JSON.stringify(ws));
}
// Tick the box and wait for the drained queue's log.usdDone line; returns the calls it made.
async function tickAndDrain() {
  const n = usdDone(), c = priceCalls.length;
  tick(true);
  await until(() => usdDone() > n);
  expect(usdDone()).toBe(n + 1);
  return priceCalls.slice(c);
}
// DefiLlama rows of the open query-log panel, as cell texts.
const QL_OUTCOME = 8;
const openQueryLogPanel = () => {
  $("queryLogPanel").open = true;
  $("queryLogPanel").dispatchEvent(new window.Event("toggle"));
};
const priceRows = () => [...$("queryLogContent").querySelectorAll("tbody tr")]
  .map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent))
  .filter((cells) => cells[1] === "DefiLlama");
const bundleManifest = async () =>
  JSON.parse(dec(readZip(await withDownloads(bundleBytes)).find((f) => f.name === "MANIFEST.json").bytes));
const usdRestore = (release = () => {}) => {
  release();
  tick(false);
  priceGate = null;
  $("queryLogPanel").open = false;
  $("resetBtn").click();
  restoreForm();
};

test("usd: box off by default — scan, details, CSV, bundle, workspace load and demo make zero coins.llama.fi requests", async () => {
  const n = priceCalls.length;
  try {
    expect($("usdToggle").checked).toBe(false);
    await knownLoaded();
    await freshScan("20");
    const scanDetails = openEdge("0xaaa");
    const scanCsv = await captureCsv();
    expect((await bundleManifest()).prices).toBeNull(); // never ticked, no price entry in the log
    await dropWorkspace(JSON.stringify(usdWs()));
    const wsDetails = openEdge(USD_E.native.hash);
    const wsCsv = await captureCsv();
    await loadAsDemo(usdWs());
    const demoDetails = openEdge(USD_E.tok.hash);
    expect(priceCalls.length).toBe(n);
    for (const text of [scanDetails, wsDetails, demoDetails, scanCsv, wsCsv]) {
      expect(text).not.toContain(EN["usd.label"]);
      expect(text).not.toContain("usd priced");
    }
  } finally {
    usdRestore();
  }
});

test("usd: ticking prices the graph; URLs carry only coin ids, hour buckets and searchWidth", async () => {
  try {
    await usdLoad();
    const calls = await tickAndDrain();
    expect(calls.length).toBeGreaterThan(0);
    const coinIds = new Set(["coingecko:ethereum", "ethereum:" + N3]);
    const hashes = Object.values(USD_E).map((e) => e.hash);
    for (const c of calls) {
      const u = new URL(c.url);
      expect(u.origin).toBe("https://coins.llama.fi");
      expect(u.pathname).toBe("/batchHistorical");
      expect([...u.searchParams.keys()]).toEqual(["coins", "searchWidth"]);
      expect(u.searchParams.get("searchWidth")).toBe("30m");
      for (const [coin, tss] of Object.entries(coinsOf(c))) {
        expect(coinIds.has(coin)).toBe(true);
        for (const ts of tss) expect(ts % 3600).toBe(0);
      }
      const low = c.url.toLowerCase();
      for (const s of [ROOT, N2, ...hashes, "testkey", "apikey"]) expect(low).not.toContain(s);
      expect(Object.keys(c.init).sort()).toEqual(["cache", "credentials", "referrerPolicy", "signal"]);
      expect(c.init).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
    }
  } finally {
    usdRestore();
  }
});

test("usd: imitation, spam, root, NFT and zero transfers are never requested; the canonical contract never sent", async () => {
  try {
    expect(CANON_USDT).toBeTruthy();
    await usdLoad();
    await tickAndDrain();
    for (const c of priceCalls) {
      for (const a of [A(7), A(8), CANON_USDT, SPAM_STAR, ROOT]) expect(c.url.toLowerCase()).not.toContain(a.toLowerCase());
    }
    expect(openEdge(USD_E.fake.hash)).toContain(EN["usd.skip.imitation"]);
    expect(openEdge(USD_E.spam.hash)).toContain(EN["usd.skip.spam"]);
    expect(openEdge(USD_E.rootTok.hash)).toContain(EN["usd.skip.root"]);
    expect(openEdge(USD_E.nft.hash)).toContain(EN["usd.skip.nft"]);
    expect(openEdge(USD_E.zero.hash)).toContain(EN["usd.skip.zero"]);
    const native = openEdge(USD_E.native.hash);
    expect(native).toContain(EN["usd.label"]);
    expect(native).toContain("≈ 2,000.00 USD");
  } finally {
    usdRestore();
  }
});

test("usd: CSV usd_value last column and line-1 counts; MANIFEST prices block", async () => {
  try {
    await usdLoad();
    const calls = await tickAndDrain();
    const lines = (await captureCsv()).split("\n");
    expect(lines[1].endsWith(",usd_value,bridge_inferred")).toBe(true);
    const row = (e) => lines.find((l) => l.includes(e.hash));
    expect(row(USD_E.native).endsWith(",2000.00,")).toBe(true);
    expect(row(USD_E.tok).endsWith(",5.00,")).toBe(true);
    for (const k of ["fake", "spam", "rootTok", "nft", "zero"]) expect([k, row(USD_E[k]).endsWith(",")]).toEqual([k, true]);
    expect(lines[0]).toContain("usd priced 2 of 2 priceable transfers");

    const files = await withDownloads(async (dl) => readZip(await bundleBytes(dl)));
    const file = (name) => JSON.parse(dec(files.find((f) => f.name === name).bytes));
    const m = file("MANIFEST.json");
    expect(m.prices).toEqual({
      source: "DefiLlama (https://coins.llama.fi)", estimate: true, shown: true, note: expect.any(String),
      queries: calls.length, priced: 2, priceable: 2,
    });
    expect(m.caveats).toContain(USD_CAVEAT);
    const logged = file("query-log.json").entries.filter((e) => e.source === "defillama");
    expect(logged.length).toBe(calls.length);
    expect(logged.every((e) => e.chainId === null)).toBe(true);
  } finally {
    usdRestore();
  }
});

test("usd: store untouched by pricing", async () => {
  try {
    await usdLoad();
    const net = () => window.vis.Network.first;
    const snap = () => JSON.stringify([net().edges.get().map((e) => e.data), net().nodes.get()]);
    const before = snap();
    await tickAndDrain();
    expect(snap()).toBe(before);
  } finally {
    usdRestore();
  }
});

test("usd: untick mid-request aborts and never shows; re-tick re-requests only reverted pairs", async () => {
  let release = () => {};
  const outcome = QL_OUTCOME;
  try {
    await usdLoad();
    const done = new Set((await tickAndDrain()).flatMap(pairsOf)); // ok/none from here on
    expect(done.size).toBe(2);
    tick(false);
    // A scan into the same graph (same epoch) adds the canned 1 ETH transfer, in another hour. Box off: no request.
    const c0 = priceCalls.length;
    $("apiKey").value = "TESTKEY";
    $("address").value = ROOT;
    $("depth").value = "1";
    $("startBtn").click();
    await until(() => !$("startBtn").disabled);
    expect(edgeByHash("0xaaa")).toBeTruthy();
    expect(priceCalls.length).toBe(c0);

    openQueryLogPanel();
    expect(openEdge(USD_E.native.hash)).not.toContain(EN["usd.label"]);
    release = holdPrices();
    tick(true);
    expect(openEdge(USD_E.native.hash)).toContain("≈ 2,000.00 USD"); // cached, logged in this epoch
    await until(() => priceCalls.length > c0);
    const held = priceCalls.slice(c0);
    expect(held.map(pairsOf).flat().some((p) => done.has(p))).toBe(false);
    tick(false); // aborts the held request
    await until(() => priceRows().some((cells) => cells[outcome] === EN["queryLog.outcome.network"]));
    expect(priceRows().filter((cells) => cells[outcome] === EN["queryLog.outcome.network"]).length).toBe(1);
    expect($("detailsContent").textContent).not.toContain(EN["usd.label"]);
    release();

    const c1 = priceCalls.length;
    const again = await tickAndDrain();
    expect(c1).toBe(c0 + held.length);
    expect(again.length).toBeGreaterThan(0);
    const reverted = new Set(held.flatMap(pairsOf));
    for (const p of again.flatMap(pairsOf)) {
      expect(done.has(p)).toBe(false);
      expect(reverted.has(p)).toBe(true);
    }
    expect(openEdge("0xaaa")).toContain("≈ 2,000.00 USD");
    // On → off: the log keeps the price requests, so MANIFEST still says so, with nothing shown.
    tick(false);
    const m = await bundleManifest();
    expect(m.prices).toMatchObject({ shown: false, priced: null, priceable: null, queries: priceRows().length });
    expect(m.prices.queries).toBeGreaterThan(0);
    expect(m.caveats).not.toContain(USD_CAVEAT);
  } finally {
    usdRestore(release);
  }
});

test("usd: workspace load while on clears the cache and logs only in the new epoch", async () => {
  let release = () => {};
  try {
    await usdLoad();
    release = holdPrices();
    const c0 = priceCalls.length;
    tick(true);
    await until(() => priceCalls.length > c0);
    const n = usdDone(), c1 = priceCalls.length;
    expect(c1).toBe(c0 + 1);
    await dropWorkspace(JSON.stringify(usdWs())); // clear() aborts the held request; the new graph is requested at once
    expect(priceCalls.length).toBeGreaterThan(c1);
    release();
    await until(() => usdDone() > n);
    expect(usdDone()).toBe(n + 1);
    // The workspace has no query log: every entry is a price request of the new epoch, the aborted one dropped.
    expect(qlogTitle()).toBe(`Query log (${priceCalls.length - c1})`);
    expect($("usdToggle").checked).toBe(true);
  } finally {
    usdRestore(release);
  }
});

test("usd: non-root node contract is sent; unsendable once a root; requested again once that root is deleted", async () => {
  try {
    await usdLoad();
    const calls = await tickAndDrain();
    expect(calls.some((c) => Object.hasOwn(coinsOf(c), "ethereum:" + N3))).toBe(true);
    const n = usdDone(), c1 = priceCalls.length;
    // N3 becomes a root on chain 137 only: a root on ANY chain is never sent (R5).
    await dropWorkspace(JSON.stringify(usdWs([v3Node("137", N3, { depth: 0, isRoot: true })])));
    await until(() => usdDone() > n);
    expect(priceCalls.length).toBeGreaterThan(c1);
    for (const c of priceCalls.slice(c1)) expect(c.url.toLowerCase()).not.toContain(N3);
    expect(openEdge(USD_E.tok.hash)).toContain(EN["usd.skip.root"]);
    // Pruning the 137 root makes the token priceable again: it is requested, never left "fetching…".
    const n2 = usdDone(), c2 = priceCalls.length;
    window.vis.Network.first.setSelection({ nodes: [ID("137", N3)] });
    $("deleteNodesBtn").click();
    await until(() => usdDone() > n2);
    expect(priceCalls.slice(c2).some((c) => Object.hasOwn(coinsOf(c), "ethereum:" + N3))).toBe(true);
    expect(openEdge(USD_E.tok.hash)).toContain("≈ 5.00 USD");
  } finally {
    usdRestore();
  }
});

test("usd: never persisted", async () => {
  try {
    await usdLoad();
    await tickAndDrain();
    for (const s of [localStorage, sessionStorage]) {
      for (let i = 0; i < s.length; i++) expect(`${s.key(i)}=${s.getItem(s.key(i))}`).not.toMatch(/usd/i);
    }
    const saved = await withDownloads(async (dl) => JSON.parse(await (await nextBlob(dl, "saveBtn")).text()));
    const { queryLog: ql, ...rest } = saved;
    const keys = (o) => (o && typeof o === "object" ? Object.entries(o).flatMap(([k, v]) => [k, ...keys(v)]) : []);
    expect(keys(rest).filter((k) => /usd/i.test(k))).toEqual([]);
    expect(ql.entries.some((e) => e.source === "defillama")).toBe(true);
  } finally {
    usdRestore();
  }
});

test("usd: reset, workspace and demo with the box on renew the price epoch; scanned edges are requested", async () => {
  const ethScan = "coingecko:ethereum@" + Math.round(1700000000 / 3600) * 3600; // the canned 1 ETH transfer's pair
  // `resets`: the action clicks Reset, which clears the logger.
  const drained = async (action, resets = false) => {
    const n = resets ? 0 : usdDone(), c = priceCalls.length;
    await action();
    await until(() => usdDone() > n);
    expect(usdDone()).toBe(n + 1);
    return priceCalls.slice(c);
  };
  try {
    await knownLoaded();
    await until(() => spamLoads > 0);
    openQueryLogPanel();
    tick(true);
    // A scan with the box on: its edges are requested as they land (freshScan resets first, box on).
    const first = await drained(() => freshScan("20"), true);
    expect(first.flatMap(pairsOf)).toContain(ethScan);
    expect(priceRows().length).toBe(first.length);
    // Reset + the same scan: the pair is requested again (the cache went with the epoch), logged in the new one.
    const second = await drained(() => freshScan("20"), true);
    expect(second.flatMap(pairsOf)).toContain(ethScan);
    expect(priceRows().length).toBe(second.length);
    expect(openEdge("0xaaa")).toContain("≈ 2,000.00 USD");
    // Workspace load, then the same graph as a demo with no reset in between: the demo alone renews the epoch.
    const ws = await drained(() => dropWorkspace(JSON.stringify(usdWs())));
    expect(priceRows().length).toBe(ws.length);
    expect(logCount(/Demo workspace loaded/g)).toBe(0);
    const demo = await drained(() => loadAsDemo(usdWs(), undefined, false));
    expect(demo.flatMap(pairsOf).sort()).toEqual(ws.flatMap(pairsOf).sort());
    expect(priceRows().length).toBe(demo.length);
    expect(qlogTitle()).toBe(`Query log (${demo.length})`);
    expect(openEdge(USD_E.native.hash)).toContain("≈ 2,000.00 USD");
  } finally {
    usdRestore();
  }
});

test("usd: a contract that becomes a root while its request is queued is never sent (allowed re-check)", async () => {
  let release = () => {};
  const cannedTok = CANNED.tokentx;
  try {
    await usdLoad(v3ws([v3Node("1", ROOT, { depth: 0, isRoot: true }), v3Node("1", N2), v3Node("1", N3)], [USD_E.native]));
    release = holdPrices();
    const c0 = priceCalls.length;
    tick(true);
    await until(() => priceCalls.length > c0); // request 1 (native) held in flight
    expect(priceCalls.length).toBe(c0 + 1);
    // A same-epoch scan adds a FOO transfer of contract N3: its pair goes pending, queued behind request 1.
    CANNED.tokentx = [{ from: ROOT, to: N2, value: "5000000", hash: "0xn3tok", tokenSymbol: "FOO", tokenDecimal: "6", contractAddress: N3, timeStamp: "1700000002", blockNumber: "102" }];
    $("apiKey").value = "TESTKEY";
    $("address").value = ROOT;
    $("depth").value = "1";
    $("startBtn").click();
    await until(() => !$("startBtn").disabled && edgeByHash("0xn3tok"));
    await until(() => openEdge("0xn3tok").includes(EN["usd.pending"]));
    expect(openEdge("0xn3tok")).toContain(EN["usd.pending"]);
    expect(priceCalls.length).toBe(c0 + 1);
    // N3 is scanned as a root before its queued request is sent.
    $("address").value = N3;
    $("startBtn").click();
    await until(() => !$("startBtn").disabled);
    expect(openEdge("0xn3tok")).toContain(EN["usd.skip.root"]);
    const n = usdDone();
    release();
    await until(() => usdDone() > n);
    expect(usdDone()).toBe(n + 1);
    expect(priceCalls.length).toBeGreaterThan(c0 + 1); // the queued request still ran, without N3
    for (const c of priceCalls.slice(c0)) expect(c.url.toLowerCase()).not.toContain(N3);
  } finally {
    CANNED.tokentx = cannedTok;
    usdRestore(release);
  }
});

// Keep LAST: pins "box off → zero requests" across the whole suite.
test("usd: every coins.llama.fi request happened while the box was on", () => {
  expect(priceCalls.length).toBeGreaterThan(0);
  expect(priceCalls.every((c) => c.boxOn)).toBe(true);
  // only coin ids leave: never the API key, nor any tx hash of the suite's canned scan or USD fixtures
  const hashes = [...CANNED.txlist, ...CANNED.tokentx].map((t) => t.hash).concat([1, 2, 3, 4, 5, 6, 7].map(UH));
  for (const { url } of priceCalls) {
    const u = url.toLowerCase();
    expect(u.includes("testkey") || u.includes("apikey")).toBe(false);
    for (const h of hashes) expect(new RegExp(h + "(?![0-9a-f])").test(u)).toBe(false);
  }
});

// --- P7 bridge tracing ---------------------------------------------------------
const viewEnv = async () => {
  const { GraphStore } = await import("../src/graphStore.js");
  const { createGraphView } = await import("../src/render/network.js");
  const { createI18n } = await import("../src/i18n.js");
  const en = (await import("../src/locales/en.js")).default;
  const fr = (await import("../src/locales/fr.js")).default;
  const i18n = createI18n({ dictionaries: { en, fr }, locale: "en" });
  const store = new GraphStore();
  const view = createGraphView(document.createElement("div"), store, { i18n, getAddressFormat: () => "short" });
  return { store, view, i18n, items: () => view.network.edges.get().filter((e) => String(e.id).startsWith("bridge:")) };
};

test("inferred bridge links: dashed curved overlay, level tooltip, confirmed style, diff-synced, retitled in French", async () => {
  const { store, view, i18n, items } = await viewEnv();
  const { TX_TYPE_GROUPS } = await import("../src/config.js");
  try {
    store.addNode("1", ROOT, { depth: 0, isRoot: true });
    store.addNode("137", N2, { depth: 1 });
    const link = { id: "1|d>137|r", a: ID("1", ROOT), b: ID("137", N2), level: "high", decision: null };
    const ds = view.network.edges.ds;
    let adds = 0;
    const add = ds.add.bind(ds);
    ds.add = (x) => { adds++; return add(x); };
    view.setBridgeLinks([link]);
    view.setBridgeLinks([link]);
    expect(adds).toBe(1);
    const it = items()[0];
    expect(it).toMatchObject({ id: "bridge:1|d>137|r", from: ID("1", ROOT), to: ID("137", N2), overlay: true, bridge: true,
      label: "inferred — verify", title: "Inferred bridge link (high) — not proof", physics: false, dashes: [8, 5], smooth: { type: "curvedCW" } });
    expect(it.data).toEqual({ bridge: true, ...link });
    const inferred = it.color.color;
    expect([...Object.values(TX_TYPE_GROUPS).flat().map((t) => t.color), "#8b93a3"]).not.toContain(inferred);
    view.setBridgeLinks([{ ...link, decision: "confirmed" }]);
    expect(items()[0].label).toBe("confirmed by investigator");
    expect(items()[0].title).toContain("confirmed by the investigator");
    expect(items()[0].color.color).not.toBe(inferred);
    expect(adds).toBe(1);
    const got = view.getBridgeLinks();
    got[0].level = "x";
    expect(view.getBridgeLinks()).toEqual([{ ...link, decision: "confirmed" }]);
    i18n.setLocale("fr");
    view.refreshProjection();
    expect(items()[0].label).toBe("confirmé par l'enquêteur");
    expect(adds).toBe(1);
    view.setBridgeLinks([]);
    expect(items()).toEqual([]);
  } finally {
    view.destroy();
  }
});

test("bridge links ride through filters and bundles like twins, never make a node visible; reset clears; twins carry overlay", async () => {
  const { store, view, items } = await viewEnv();
  try {
    store.addNode("1", ROOT, { depth: 0, isRoot: true });
    store.addNode("1", N2, { depth: 1 });
    store.addNode("137", N3, { depth: 1 });
    store.addEdge({ chainId: "1", action: "txlist", group: "normal", color: "#0", from: ROOT, to: N2, tx: { value: "1000000000000000000", hash: "0x1" } });
    view.setBridgeLinks([{ id: "x", a: ID("1", ROOT), b: ID("137", N3), level: "low", decision: null }]);
    view.setDisplayOptions({ minAmount: 999 });
    expect(view.network.edges.get().map((e) => e.id)).toEqual(["bridge:x"]);
    expect(view.hasRenderedNode(ID("137", N3))).toBe(false);
    view.setDisplayOptions({ minAmount: 0 });
    view.setBundling(true);
    const bundledIds = view.network.edges.get().map((e) => String(e.id));
    expect(bundledIds.filter((id) => id !== "bridge:x" && !id.startsWith("bundle:"))).toEqual([]);
    expect(bundledIds).toContain("bridge:x");
    expect(bundledIds.some((id) => id.includes("undefined"))).toBe(false);
    view.setBridgeLinks([]);
    expect(view.network.edges.get().some((e) => String(e.id).startsWith("bridge:"))).toBe(false);
    view.setBridgeLinks([{ id: "x", a: ID("1", ROOT), b: ID("137", N3), level: "low", decision: null }]);
    expect(view.getEdgeData("bridge:x")).toMatchObject({ bridge: true, id: "x" });
    view.setBundling(false);
    store.reset();
    expect(view.getBridgeLinks()).toEqual([]);
    expect(items()).toEqual([]);
    store.addNode("1", ROOT, { depth: 0, isRoot: true });
    store.addNode("42161", ROOT, { depth: 0, isRoot: true });
    store.addNode("42161", N2, { depth: 1 });
    store.addEdge({ chainId: "42161", action: "txlist", group: "normal", color: "#0", from: ROOT, to: N2, tx: { value: "1", hash: "0x2" } });
    view.setTwins(true);
    expect(view.network.edges.get().filter((e) => e.twin).map((e) => [e.twin, e.overlay])).toEqual([[true, true]]);
  } finally {
    view.destroy();
  }
});

const EVIL = '<img src=x onerror="alert(1)">';
const uiEnv = async (locale = "en") => {
  const { createI18n } = await import("../src/i18n.js");
  const en = (await import("../src/locales/en.js")).default;
  const fr = (await import("../src/locales/fr.js")).default;
  return { ui: await import("../src/ui.js"), i18n: createI18n({ dictionaries: { en, fr }, locale }) };
};
const bView = (over = {}) => ({
  level: "high", amount: "equal", feeBps: 0, basis: "calldata", sender: "mint", senderLabel: null, trusted: true,
  forDeposit: 1, forRelease: 1, rejected: 0, covered: true, delaySec: 1800,
  deposit: { amountText: "20", symbol: "ETH", bridgeLabel: EVIL, chainName: "Ethereum", explorer: "etherscan.io", hash: "0xd1" },
  release: { amountText: "20", symbol: EVIL, recipient: N2, chainName: "Polygon", explorer: "polygonscan.com", hash: "0xr1" },
  decision: null, ...over,
});
const btnIn = (box, t) => [...box.querySelectorAll("button")].find((b) => b.textContent === t);

test("bridge link details: every line via textContent; decision buttons call their handlers", async () => {
  const { ui, i18n } = await uiEnv();
  const calls = [];
  const box = document.createElement("div");
  const deps = { i18n, busy: false, onConfirm: () => calls.push("c"), onReject: () => calls.push("r"), onClear: () => calls.push("x"), onLoadOlder: () => calls.push("l") };
  ui.renderBridgeDetails(box, bView(), deps);
  expect(box.querySelector("img")).toBeNull();
  const text = box.textContent;
  for (const s of [
    "Inferred bridge link — verify",
    "Confidence: high — inferred from amount, timing and recipient; not proof",
    `Deposit: 20 ETH into ${EVIL} on Ethereum`,
    `Possible release: 20 ${EVIL} to ${N2} on Polygon`,
    "Delay: 30 min", "Amount: equal", "Recipient: decoded from the deposit call",
    "Release sender: token mint (zero address)", "Not reviewed",
    "Inferred links are leads to verify on both explorers, never proof.",
  ]) expect(text).toContain(s);
  for (const s of ["candidate releases", "other deposit", "do not reach back", "curated token list"]) expect(text).not.toContain(s);
  expect([...box.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["https://etherscan.io/tx/0xd1", "https://polygonscan.com/tx/0xr1"]);
  expect(btnIn(box, "Clear decision").disabled).toBe(true);
  expect(btnIn(box, "Load older on Polygon")).toBeUndefined();
  btnIn(box, "Confirm (investigator)").click();
  btnIn(box, "Reject").click();
  expect(calls).toEqual(["c", "r"]);
});

test("bridge link details: fee, assumed recipient, bridge sender, untrusted, ambiguity, uncovered, decisions; French percent", async () => {
  const { ui, i18n } = await uiEnv();
  const calls = [];
  const deps = (busy = false) => ({ i18n, busy, onConfirm() {}, onReject() {}, onClear() {}, onLoadOlder: () => calls.push("l") });
  const render = (v, d = deps(), i = i18n) => { const b = document.createElement("div"); ui.renderBridgeDetails(b, v, { ...d, i18n: i }); return b; };
  const low = bView({ level: "low", amount: "fee", feeBps: 250, basis: "sender", sender: "bridge", senderLabel: "L2 bridge", trusted: false, forDeposit: 3, rejected: 1, forRelease: 2, covered: false });
  const box = render(low);
  for (const s of [
    "Amount: release is 2.50% lower — consistent with a bridge fee, or an unrelated transfer",
    "Recipient: assumed to be the depositor's own address (not decoded) — this alone never raises confidence",
    "Release sender: L2 bridge (a known bridge on Polygon)",
    "Asset: not in the curated token list — confidence kept low",
    "3 candidate releases for this deposit (1 rejected by the investigator)",
    "This release also fits 1 other deposit(s)",
    "The loaded transactions of the recipient on Polygon do not reach back to the deposit time — load older to look further",
  ]) expect(box.textContent).toContain(s);
  btnIn(box, "Load older on Polygon").click();
  expect(calls).toEqual(["l"]);
  expect(btnIn(render(low, deps(true)), "Load older on Polygon").disabled).toBe(true);
  expect(render(bView({ sender: "other" })).textContent).toContain("Release sender: not a known bridge");
  const at = "2026-11-17T10:00:00.000Z";
  const c = render(bView({ decision: { decision: "confirmed", at } }));
  expect(c.textContent).toContain("Confirmed by the investigator on 2026-11-17 10:00:00 UTC — an investigator assertion, not on-chain proof");
  expect(btnIn(c, "Confirm (investigator)").disabled).toBe(true);
  expect(btnIn(c, "Clear decision").disabled).toBe(false);
  const r = render(bView({ decision: { decision: "rejected", at } }));
  expect(r.textContent).toContain("Rejected by the investigator on 2026-11-17 10:00:00 UTC");
  expect(btnIn(r, "Reject").disabled).toBe(true);
  const fr = await uiEnv("fr");
  expect(render(low, deps(), fr.i18n).textContent).toContain("sortie inférieure de 2,50 %");
});

test("edge details: Bridge deposit row — recipient basis, candidate lines with Open, Look select; textContent only", async () => {
  const { ui, i18n } = await uiEnv();
  const edge = {
    key: "k", action: "txlist", group: "normal", from: ROOT, to: N2, hash: "0x1",
    symbol: "ETH", amountText: "5", amountIndeterminate: false, tokenContract: "", tokenId: "",
    value: "5", timeStamp: "1700000000", blockNumber: "1", hasData: false, methodId: "",
  };
  const opened = [], looked = [];
  const bd = (o = {}) => ({
    bridgeLabel: EVIL, recipient: N2, basis: "calldata", destChainName: null, depositorCategory: null, candidates: [],
    lookChains: [{ chainId: "8453", name: "Base" }, { chainId: "137", name: "Polygon" }], busy: false,
    onOpen: (id) => opened.push(id), onLook: (c) => looked.push(c), ...o,
  });
  const render = (b) => {
    const box = document.createElement("div");
    ui.renderEdgeDetails(box, edge, { i18n, explorer: "etherscan.io", getAlias: () => null, bridgeDeposit: b });
    return box;
  };
  const box = render(bd());
  expect(box.querySelector("img")).toBeNull();
  for (const s of [
    "Bridge deposit", `Deposit into a known bridge: ${EVIL}`,
    `Recipient on the other side: ${N2} — decoded from the deposit call`,
    "No candidate release in the loaded data. Candidates come only from transactions already loaded on other chains.",
    "Look for the release on",
  ]) expect(box.textContent).toContain(s);
  const sel = box.querySelector("select");
  expect(sel.getAttribute("aria-label")).toBe("Look for the release on");
  expect([...sel.options].map((o) => o.value)).toEqual(["8453", "137"]);
  expect(sel.value).toBe("8453");
  sel.value = "137";
  btnIn(box, "Look").click();
  expect(looked).toEqual(["137"]);
  const withC = render(bd({ candidates: [{ id: "c1", level: "high", chainName: "Polygon", status: "confirmed" }, { id: "c2", level: "low", chainName: "Polygon", status: "rejected" }] }));
  expect(withC.textContent).toContain("high · Polygon · confirmed by the investigator");
  expect(withC.textContent).toContain("low · Polygon · rejected by the investigator");
  expect(withC.textContent).not.toContain("No candidate");
  [...withC.querySelectorAll("button")].filter((b) => b.textContent === "Open").forEach((b) => b.click());
  expect(opened).toEqual(["c1", "c2"]);
  expect(render(bd({ basis: "sender" })).textContent).toContain("— assumed to be the depositor's own address (not decoded)");
  expect(render(bd({ destChainName: "Arbitrum One" })).textContent).toContain("Destination chain named in the call: Arbitrum One");
  const unk = render(bd({ recipient: null, basis: null, depositorCategory: "exchange" }));
  expect(unk.textContent).toContain("Recipient unknown — the depositor is a known exchange that may act for others; none is assumed.");
  expect(unk.querySelector("select")).toBeNull();
  expect(btnIn(unk, "Look")).toBeUndefined();
  expect(btnIn(render(bd({ busy: true })), "Look").disabled).toBe(true);
  expect(render(null).textContent).not.toContain("Bridge deposit");
});

// main.js wiring (shared instance): inferred links, details, decisions, Look.
const RCM = "0xa0c68c638235ee32657e8f720a23cec1bfc77c77"; // Polygon PoS RootChainManager: known bridge on chain 1
const WETH137 = "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619"; // curated WETH on Polygon
const ZERO = "0x" + "0".repeat(40);
const DEPOSITOR = A(5), RECIP = A(6), BT = 1700000000;
const etherFor = (to) => "0x4faa8a26" + to.slice(2).padStart(64, "0");
const DONE_H = { oldestBlock: "0", blockPage: 0, pageSize: 0, done: true, count: 1 };
const ALL_DONE = { txlist: DONE_H, txlistinternal: DONE_H, tokentx: DONE_H };
const depEdge = (over = {}) => v3Edge({ hash: "0xbd1", from: DEPOSITOR, to: RCM, value: "20000000000000000000", tokenDecimal: "", amountText: "20",
  hasData: true, methodId: "0x4faa8a26", rawInput: etherFor(RECIP), timeStamp: String(BT), ...over });
const relEdge = (over = {}) => v3Edge({ chainId: "137", action: "tokentx", group: "token", hash: "0xbr1", from: ZERO, to: RECIP, symbol: "WETH",
  tokenContract: WETH137, tokenDecimal: "18", value: "20000000000000000000", amountText: "20", timeStamp: String(BT + 1800), ...over });
const chain1Side = () => [v3Node("1", DEPOSITOR, { depth: 0, isRoot: true }), v3Node("1", RCM)];
const chain137Side = (history = ALL_DONE) => [v3Node("137", ZERO, { depth: 2 }), v3Node("137", RECIP, { history })];
const bridgeWs = (extra = [], history) => v3ws([...chain1Side(), ...chain137Side(history)], [depEdge(), relEdge(), ...extra]);
const DEP_KEY = depEdge().key, REL_KEY = relEdge().key;
const bridgeItems = () => window.vis.Network.first.edges.get().filter((e) => String(e.id).startsWith("bridge:"));
const clickEdge = (id) => window.vis.Network.first._on.click[0]({ nodes: [], edges: [id] });
const panel = () => $("detailsContent").textContent;
const triples = (urls) => urls.map((u) => new URL(u).searchParams).map((p) => [p.get("chainid"), p.get("address"), p.get("action")]);
// Every bridge test resets the graph and restores what the Look tests change (canned rows, key, type boxes).
async function withBridgeEnv(fn) {
  await knownLoaded();
  const canned = { txlist: CANNED.txlist, tokentx: CANNED.tokentx };
  const key = $("apiKey").value;
  try {
    await fn();
  } finally {
    Object.assign(CANNED, canned);
    $("apiKey").value = key;
    for (const id of ["typeNormal", "typeInternal", "typeToken"]) $(id).checked = true;
    $("resetBtn").click();
    restoreForm();
  }
}
// Open the deposit edge, wait for its Bridge deposit row, pick the Look chain.
async function openDepositOn(chainId) {
  clickEdge(DEP_KEY);
  await until(() => panel().includes("Look for the release on"));
  $("detailsContent").querySelector("select").value = chainId;
}

test("a decoded deposit and a curated-WETH mint draw one high inferred link; details; never a store edge; French label", () => withBridgeEnv(async () => {
  await loadAsDemo(bridgeWs());
  await until(() => bridgeItems().length === 1);
  const [item] = bridgeItems();
  expect(item).toMatchObject({ id: `bridge:${DEP_KEY}>${REL_KEY}`, from: ID("1", DEPOSITOR), to: ID("137", RECIP), label: "inferred — verify" });
  expect(item.title).toBe("Inferred bridge link (high) — not proof");
  expect((await captureCsv()).split("\n").filter((l) => l.startsWith("edge,")).length).toBe(2);
  clickEdge(item.id);
  for (const s of ["Inferred bridge link — verify", "Confidence: high — ", "Recipient: decoded from the deposit call",
    "Release sender: token mint (zero address)", "Amount: equal", "Not reviewed"]) expect(panel()).toContain(s);
  $("langToggle").click();
  try {
    expect(bridgeItems()[0].label).toBe("déduit — à vérifier");
    expect(bridgeItems()[0].title).toBe("Lien de pont déduit (confiance élevée) — pas une preuve");
    expect(panel()).toContain("Lien de pont déduit — à vérifier");
  } finally {
    $("langToggle").click();
  }
  expect(panel()).toContain("Inferred bridge link — verify");
  // The same graph reloaded (one recompute, identical links) is redrawn: main compares with the view's own list.
  await loadAsDemo(bridgeWs(), /Demo workspace loaded/, false);
  await until(() => logCount(/Demo workspace loaded/g) === 2 && bridgeItems().length === 1);
  expect(bridgeItems().length).toBe(1);
}));

test("confirm / reject / clear: the label follows; a rejected link is gone but opens from the deposit row; workspace load replaces, demo load and reset clear", () => withBridgeEnv(async () => {
  const label = () => bridgeItems()[0]?.label;
  await loadAsDemo(bridgeWs());
  await until(() => bridgeItems().length === 1);
  clickEdge(bridgeItems()[0].id);
  detailBtn("Confirm (investigator)").click();
  expect(label()).toBe("confirmed by investigator");
  expect(panel()).toMatch(/Confirmed by the investigator on \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC — an investigator assertion, not on-chain proof/);
  detailBtn("Reject").click();
  expect(bridgeItems()).toEqual([]);
  clickEdge(DEP_KEY);
  expect(panel()).toContain("high · Polygon · rejected by the investigator");
  detailBtn("Open").click();
  expect(panel()).toContain("Rejected by the investigator on");
  detailBtn("Clear decision").click();
  expect(label()).toBe("inferred — verify");
  expect(panel()).toContain("Not reviewed");
  detailBtn("Confirm (investigator)").click();
  expect(label()).toBe("confirmed by investigator");
  await loadAsDemo(bridgeWs(), /Demo workspace loaded/, false); // no reset first: the demo load itself clears
  await until(() => logCount(/Demo workspace loaded/g) === 2 && label() === "inferred — verify");
  expect(label()).toBe("inferred — verify");
  await dropWorkspace(JSON.stringify({ ...bridgeWs(), bridgeDecisions: [{ deposit: DEP_KEY, release: REL_KEY, decision: "confirmed", at: "2026-11-17T10:00:00Z" }] }));
  await until(() => label() === "confirmed by investigator");
  expect(label()).toBe("confirmed by investigator");
  $("resetBtn").click();
  await loadAsDemo(bridgeWs());
  await until(() => label() === "inferred — verify");
  expect(label()).toBe("inferred — verify");
}));

test("decisions never feed inferBridges: rejecting one of two candidates leaves the other low", () => withBridgeEnv(async () => {
  await loadAsDemo(bridgeWs([relEdge({ hash: "0xbr2", timeStamp: String(BT + 3600) })]));
  await until(() => bridgeItems().length === 2);
  expect(bridgeItems().map((e) => e.title.includes("(low)"))).toEqual([true, true]);
  clickEdge(bridgeItems()[0].id);
  detailBtn("Reject").click();
  expect(bridgeItems().length).toBe(1);
  expect(bridgeItems()[0].title).toContain("(low)");
  clickEdge(bridgeItems()[0].id);
  expect(panel()).toContain("2 candidate releases for this deposit (1 rejected by the investigator)");
}));

test("pruning the recipient removes the link and its open details; a selected link never breaks prune", () => withBridgeEnv(async () => {
  const net = window.vis.Network.first;
  await loadAsDemo(bridgeWs());
  await until(() => bridgeItems().length === 1);
  clickEdge(bridgeItems()[0].id);
  net.setSelection({ nodes: [] });
  $("deleteNodesBtn").click();
  expect($("logContent").textContent).toContain(EN["error.selectNodesFirst"]);
  expect(bridgeItems().length).toBe(1);
  net.setSelection({ nodes: [ID("137", RECIP)] });
  $("deleteNodesBtn").click();
  await until(() => !bridgeItems().length && !panel().includes("Inferred bridge link"));
  expect(bridgeItems()).toEqual([]);
  expect(panel()).not.toContain("Inferred bridge link");
  // The view resyncs from main's list on a locale switch: no stale link may come back.
  $("langToggle").click();
  $("langToggle").click();
  expect(bridgeItems()).toEqual([]);
}));

test("Look loads txlist+txlistinternal+tokentx for the recipient on the chosen chain through the query log, whatever the form boxes say; the candidate appears", () => withBridgeEnv(async () => {
  $("typeInternal").checked = false;
  $("typeToken").checked = false;
  await loadAsDemo(v3ws(chain1Side(), [depEdge()]));
  $("apiKey").value = "TESTKEY";
  CANNED.txlist = [];
  CANNED.tokentx = [{ from: ZERO, to: RECIP, value: "20000000000000000000", hash: "0xbr1", tokenSymbol: "WETH", tokenDecimal: "18",
    contractAddress: WETH137, timeStamp: String(BT + 1800), blockNumber: "200" }];
  await openDepositOn("137");
  for (const s of ["Bridge deposit", "decoded from the deposit call", "No candidate release in the loaded data"]) expect(panel()).toContain(s);
  const opts = [...$("detailsContent").querySelector("select").options].map((o) => o.value);
  expect(opts[0]).toBe("8453");
  expect(opts).not.toContain("1");
  const { CHAINS } = await import("../src/config.js");
  expect(opts.length).toBe(CHAINS.length - 1);
  const n = apiUrls.length;
  detailBtn("Look").click();
  await until(() => bridgeItems().length === 1 && !$("startBtn").disabled);
  expect(triples(apiUrls.slice(n))).toEqual([["137", RECIP, "txlist"], ["137", RECIP, "txlistinternal"], ["137", RECIP, "tokentx"]]);
  await until(() => qlogTitle() === "Query log (3)");
  expect(qlogTitle()).toBe("Query log (3)");
  expect((await captureCsv()).split("\n").find((l) => l.startsWith(`node,${RECIP},`))).toStartWith(`node,${RECIP},,1,0,`);
  expect(bridgeItems()[0].title).toContain("(high)");
  await until(() => panel().includes("high · Polygon · not reviewed"));
  expect(panel()).toContain("high · Polygon · not reviewed");
}));

test("Look where the recipient already exists = load older there with the full value set; no node added", () => withBridgeEnv(async () => {
  await loadAsDemo(v3ws([...chain1Side(), v3Node("137", RECIP, { history: { txlist: DONE_H } })], [depEdge()]));
  $("apiKey").value = "TESTKEY";
  CANNED.txlist = []; // the stub ignores `address`: the default rows would add unrelated edges
  CANNED.tokentx = [];
  const before = nodeIds();
  await openDepositOn("137");
  const n = apiUrls.length;
  detailBtn("Look").click();
  await until(() => !$("startBtn").disabled && apiUrls.length > n);
  expect(triples(apiUrls.slice(n))).toEqual([["137", RECIP, "txlistinternal"], ["137", RECIP, "tokentx"]]);
  expect(nodeIds()).toEqual(before);
}));

test("Look is refused without an API key: logged, no request, no node", () => withBridgeEnv(async () => {
  await loadAsDemo(v3ws(chain1Side(), [depEdge()]));
  $("apiKey").value = "";
  await openDepositOn("137");
  const n = apiUrls.length;
  detailBtn("Look").click();
  await until(() => $("logContent").textContent.includes(EN["error.apiKeyRequired"]));
  expect($("logContent").textContent).toContain(EN["error.apiKeyRequired"]);
  expect(apiUrls.length).toBe(n);
  expect(nodeIds().some((id) => id.startsWith("137:"))).toBe(false);
}));

test("an uncovered candidate's Load older reuses the Look path on the release chain", () => withBridgeEnv(async () => {
  await loadAsDemo(bridgeWs([], { tokentx: { oldestBlock: "50", blockPage: 0, pageSize: 0, done: false, count: 20 } }));
  await until(() => bridgeItems().length === 1);
  expect(bridgeItems()[0].title).toContain("(low)");
  clickEdge(bridgeItems()[0].id);
  expect(panel()).toContain("do not reach back");
  $("apiKey").value = "TESTKEY";
  CANNED.txlist = [];
  CANNED.tokentx = [];
  const n = apiUrls.length;
  // Every panel state from the click on: busy/idle (the Load older button) and the level shown.
  const seen = [];
  const mo = new window.MutationObserver(() => {
    const level = (panel().match(/Confidence: (\w+)/) || [])[1];
    const btn = detailBtn("Load older on Polygon");
    if (level) seen.push(`${btn ? (btn.disabled ? "busy" : "idle") : "-"}/${level}`);
  });
  mo.observe($("detailsContent"), { childList: true, subtree: true });
  try {
    detailBtn("Load older on Polygon").click();
    await until(() => !$("startBtn").disabled && bridgeItems()[0]?.title.includes("(high)") && seen.at(-1) === "-/high");
  } finally {
    mo.disconnect();
  }
  // Once the load is over the panel is never idle on the pre-load level (derived state is flushed first).
  expect(seen[0]).toBe("busy/low");
  expect(seen).not.toContain("idle/low");
  expect(seen.at(-1)).toBe("-/high");
  const sent = apiUrls.slice(n);
  expect(triples(sent)).toEqual([["137", RECIP, "txlist"], ["137", RECIP, "txlistinternal"], ["137", RECIP, "tokentx"]]);
  expect(new URL(sent[2]).searchParams.get("endblock")).toBe("50");
  expect(bridgeItems()[0].title).toContain("(high)");
}));

test("an open deposit panel clears when its deposit edge is pruned: no stale level, no dead Look", () => withBridgeEnv(async () => {
  await loadAsDemo(bridgeWs());
  await until(() => bridgeItems().length === 1);
  clickEdge(DEP_KEY);
  await until(() => panel().includes("high · Polygon · not reviewed"));
  window.vis.Network.first.setSelection({ nodes: [ID("1", RCM)] }); // the bridge contract: a natural hub to prune
  $("deleteNodesBtn").click();
  await until(() => !bridgeItems().length && panel() === EN["details.empty"]);
  expect(bridgeItems()).toEqual([]);
  expect(panel()).toBe(EN["details.empty"]);
}));

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

test("a confirmed decision: CSV status + caveat; the saved workspace carries it; drop-loading it restores it; an invalid entry is logged", () => withBridgeEnv(() => withDownloads(async (dl) => {
  await loadAsDemo(bridgeWs());
  await until(() => bridgeItems().length === 1);
  clickEdge(bridgeItems()[0].id);
  detailBtn("Confirm (investigator)").click();
  const csv = await (await nextBlob(dl, "exportCsvBtn")).text();
  expect(csv.split("\n")[0]).toContain("bridge_inferred lists");
  const dep = csv.split("\n").find((l) => l.includes(",0xbd1,"));
  const rel = csv.split("\n").find((l) => l.includes(",0xbr1,"));
  expect(dep.endsWith(`,release=137:0xbr1;to=${RECIP};confidence=high;status=confirmed-by-investigator`)).toBe(true);
  expect(rel.endsWith(`,deposit=1:0xbd1;from=${DEPOSITOR};confidence=high;status=confirmed-by-investigator`)).toBe(true);
  const saved = await (await nextBlob(dl, "saveBtn")).text();
  const ws = JSON.parse(saved);
  expect(ws.version).toBe(3);
  expect(ws.bridgeDecisions).toEqual([{ deposit: DEP_KEY, release: REL_KEY, decision: "confirmed", at: expect.stringMatching(ISO) }]);
  await loadAsDemo(bridgeWs(), /Demo workspace loaded/, false); // no reset first: the demo load itself clears
  await until(() => logCount(/Demo workspace loaded/g) === 2 && bridgeItems()[0]?.label === "inferred — verify");
  expect(bridgeItems()[0].label).toBe("inferred — verify");
  await dropWorkspace(saved);
  await until(() => bridgeItems()[0]?.label === "confirmed by investigator");
  expect(bridgeItems()[0].label).toBe("confirmed by investigator");
  await dropWorkspace(JSON.stringify({ ...ws, bridgeDecisions: [...ws.bridgeDecisions, { deposit: "x", release: "y", decision: "confirmed", at: "nope" }] }));
  expect($("logContent").textContent).toContain("1 invalid bridge decision(s) in the file were ignored.");
})));

test("toggle off hides links and legend; PNG/PDF omit them and their footer line; CSV still lists the candidate; showBridges is saved and restored", () => withBridgeEnv(() => withDownloads((dl) => withFakeExportCanvas(async (fx) => {
  const box = $("bridgeToggle");
  try {
    await loadAsDemo(bridgeWs());
    await until(() => bridgeItems().length === 1);
    expect($("bridgeToggleRow").hidden).toBe(false);
    expect($("legendBridgeInferred").hidden).toBe(false);
    expect($("legendBridgeConfirmed").hidden).toBe(true);
    const draw = async (btn, done) => {
      const n = logCount(done);
      fx.texts.length = 0;
      $(btn).click();
      await until(() => logCount(done) > n);
      return window.vis.Network.last.edges.get().some((e) => String(e.id).startsWith("bridge:"));
    };
    const PNG = /Image \(PNG\) downloaded/g, PDF = /PDF downloaded/g;
    expect(await draw("exportPngBtn", PNG)).toBe(true);
    expect(fx.texts.at(-1)).toBe(EN["export.footer.bridges"]);
    box.checked = false;
    box.dispatchEvent(new window.Event("change"));
    expect(bridgeItems()).toEqual([]);
    expect($("legendBridgeInferred").hidden).toBe(true);
    expect($("legendBridgeConfirmed").hidden).toBe(true);
    for (const [btn, done] of [["exportPngBtn", PNG], ["exportPdfBtn", PDF]]) {
      expect(await draw(btn, done)).toBe(false);
      expect(fx.texts).not.toContain(EN["export.footer.bridges"]);
    }
    const csv = await (await nextBlob(dl, "exportCsvBtn")).text();
    expect(csv.split("\n")[0]).toContain("bridge_inferred lists");
    expect(csv).toContain("confidence=high;status=unreviewed");
    const saved = await (await nextBlob(dl, "saveBtn")).text();
    expect(JSON.parse(saved).filters.showBridges).toBe(false);
    box.checked = true;
    box.dispatchEvent(new window.Event("change"));
    await until(() => bridgeItems().length === 1);
    await dropWorkspace(saved);
    expect(box.checked).toBe(false);
    expect(bridgeItems()).toEqual([]);
    const { showBridges, ...filters } = JSON.parse(saved).filters;
    await dropWorkspace(JSON.stringify({ ...JSON.parse(saved), filters }));
    expect(box.checked).toBe(true);
    await until(() => bridgeItems().length === 1);
  } finally {
    box.checked = true;
    box.dispatchEvent(new window.Event("change"));
  }
}))));

test("evidence bundle: MANIFEST bridges block + BRIDGE_CAVEAT; workspace.json carries the decision", () => withBridgeEnv(() => withDownloads(async (dl) => {
  await loadAsDemo(bridgeWs());
  await until(() => bridgeItems().length === 1);
  clickEdge(bridgeItems()[0].id);
  detailBtn("Confirm (investigator)").click();
  const files = readZip(await bundleBytes(dl));
  const file = (n) => dec(files.find((f) => f.name === n).bytes);
  const manifest = JSON.parse(file("MANIFEST.json"));
  expect(manifest.bridges).toEqual({ note: expect.any(String), candidates: 1, low: 0, medium: 0, high: 1, confirmedByInvestigator: 1, rejectedByInvestigator: 0 });
  expect(manifest.caveats).toContain(BRIDGE_CAVEAT);
  expect(JSON.parse(file("workspace.json")).bridgeDecisions.length).toBe(1);
  const csv = file("graph.csv").split("\n");
  expect(csv[0]).toContain("bridge_inferred lists inferred bridge candidates");
  expect(csv.find((l) => l.includes(",0xbd1,"))).toEndWith(`,release=137:0xbr1;to=${RECIP};confidence=high;status=confirmed-by-investigator`);
})));

test("reset clears investigator decisions: the same pair rebuilt by scan + Look is inferred again, and a save carries none", () => withBridgeEnv(() => withDownloads(async (dl) => {
  // A real scan of the depositor on chain 1 (no workspace/demo load: those clear decisions themselves), then Look on 137.
  const rebuild = async () => {
    $("resetBtn").click();
    $("apiKey").value = "TESTKEY";
    CANNED.txlist = [{ from: DEPOSITOR, to: RCM, value: "20000000000000000000", hash: "0xbd1", input: etherFor(RECIP), isError: "0",
      txreceipt_status: "1", timeStamp: String(BT), blockNumber: "100" }];
    CANNED.tokentx = [];
    setChain("1");
    $("address").value = DEPOSITOR;
    $("depth").value = "1";
    $("startBtn").click();
    await until(() => /Done/.test($("status").textContent || ""));
    CANNED.txlist = [];
    CANNED.tokentx = [{ from: ZERO, to: RECIP, value: "20000000000000000000", hash: "0xbr1", tokenSymbol: "WETH", tokenDecimal: "18",
      contractAddress: WETH137, timeStamp: String(BT + 1800), blockNumber: "200" }];
    clickEdge(window.vis.Network.first.edges.get().find((e) => String(e.id).includes("|0xbd1|")).id);
    await until(() => panel().includes("Look for the release on"));
    $("detailsContent").querySelector("select").value = "137";
    detailBtn("Look").click();
    await until(() => bridgeItems().length === 1 && !$("startBtn").disabled);
  };
  await rebuild();
  const id1 = bridgeItems()[0].id;
  clickEdge(id1);
  detailBtn("Confirm (investigator)").click();
  expect(bridgeItems()[0].label).toBe("confirmed by investigator");
  $("resetBtn").click();
  expect(bridgeItems()).toEqual([]);
  await rebuild();
  expect(bridgeItems()[0].id).toBe(id1);
  expect(bridgeItems()[0].label).toBe("inferred — verify");
  expect(JSON.parse(await (await nextBlob(dl, "saveBtn")).text()).bridgeDecisions).toBeUndefined();
})));

const F5 = "0xf00d000000000000000000000000000000000005";
test("demo bridge example (pure): one high candidate 0xe1 -> 0xe2; the sanctioned 0xb7 depositor is assumed the recipient, no candidate", async () => {
  const { parseWorkspace } = await import("../src/workspace.js");
  const { GraphStore } = await import("../src/graphStore.js");
  const { inferBridges } = await import("../src/bridgeInfer.js");
  const { knownEntry, knownCategory } = await import("../src/knownAddresses.js");
  const { CHAINS } = await import("../src/config.js");
  const demo = JSON.parse(await Bun.file(new URL("../data/demo-workspace.json", import.meta.url)).text());
  const store = new GraphStore();
  const parsed = parseWorkspace(JSON.stringify(demo));
  store.loadSnapshot(parsed.data.nodes, parsed.data.edges);
  const { deposits, candidates } = inferBridges(store.listNodes(), store.listEdges(), {
    known: (a, c) => knownEntry(a, c, KNOWN),
    trustedToken: (a, c) => knownCategory(a, c, KNOWN) === "token",
    nativeSymbol: (c) => CHAINS.find((x) => String(x.id) === String(c))?.native || null,
  });
  const hashOf = (k) => store.listEdges().find((e) => e.key === k).hash;
  expect(candidates.map((c) => [hashOf(c.depositKey), hashOf(c.releaseKey), c.level])).toEqual([["0xe1", "0xe2", "high"]]);
  expect([...deposits.values()].map((d) => d.hash).sort()).toEqual(["0xb7", "0xe1"]);
  expect([...deposits.values()].find((d) => d.hash === "0xb7")).toMatchObject({ recipient: DEMO_ROOT, basis: "sender" });
  expect([...deposits.values()].find((d) => d.hash === "0xe1")).toMatchObject({ recipient: F5, basis: "calldata" });
});

test("demo draws the illustrative high bridge link; the 0xb7 deposit shows an assumed recipient and Look, 0xe1 shows the candidate", async () => {
  await knownLoaded();
  try {
    $("resetBtn").click();
    $("demoBtn").click();
    const links = () => bridgeItems().filter((e) => e.from === ID("1", DEMO_ROOT) && e.to === ID("137", F5) && e.title.includes("(high)"));
    await until(() => links().length === 1);
    expect(links().length).toBe(1);
    clickEdge(edgeByHash("0xb7").id);
    await until(() => panel().includes("assumed to be the depositor's own address"));
    expect(panel()).toContain("Recipient on the other side: " + DEMO_ROOT + " — assumed to be the depositor's own address (not decoded)");
    expect(panel()).not.toContain("Recipient unknown");
    expect($("detailsContent").querySelector("select")).not.toBeNull();
    clickEdge(edgeByHash("0xe1").id);
    await until(() => panel().includes("high · Polygon · not reviewed"));
    expect(panel()).toContain("high · Polygon · not reviewed");
    expect($("detailsContent").querySelector("select")).not.toBeNull();
  } finally {
    $("resetBtn").click();
  }
});

// ---- Tron display (renderer-level) ----
const TRON_HEX = "41d1c4bb7b2f39aba5707711719b2236b5b605af2e";
const TRON_T = "TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi";

test("Tron node and edge details show T… and Tronscan links", async () => {
  const { ui, i18n } = await qlogEnv();
  const nc = document.createElement("div");
  ui.renderNodeDetails(nc, { address: TRON_HEX, chainId: "728126428", depth: 0, isRoot: true, alias: null },
    { i18n, explorer: "tronscan.org", onRename: () => {} });
  expect(nc.textContent).toContain(TRON_T);
  expect(nc.textContent).not.toContain("41d1c4");
  expect(nc.querySelector("a").href).toBe(`https://tronscan.org/#/address/${TRON_T}`);

  const hash = "ab".repeat(32);
  const edge = (chainId) => ({
    key: "k", chainId, action: "tokentx", group: "token", from: TRON_HEX, to: "41" + "11".repeat(20), hash,
    symbol: "USDT", amountText: "5", amountIndeterminate: false, tokenContract: "", tokenId: "",
    value: "5", timeStamp: "1700000000", blockNumber: "1", hasData: false,
  });
  const ec = document.createElement("div");
  ui.renderEdgeDetails(ec, edge("728126428"), { i18n, explorer: "tronscan.org", getAlias: () => null });
  expect(ec.textContent).toContain("TRC-20");
  expect(ec.textContent).toContain(TRON_T);
  expect(ec.textContent).not.toContain("41d1c4");
  expect(ec.querySelector("a").href).toBe(`https://tronscan.org/#/transaction/${hash}`);

  const ev = document.createElement("div");
  ui.renderEdgeDetails(ev, { ...edge("1"), from: A(1), to: A(2), hash: "0x1" }, { i18n, explorer: "etherscan.io", getAlias: () => null });
  expect(ev.textContent).toContain("ERC-20");
  expect(ev.querySelector("a").href).toBe("https://etherscan.io/tx/0x1");
});

test("query log renders a TronGrid row", async () => {
  const { ui, i18n } = await qlogEnv();
  const c = document.createElement("div");
  ui.renderQueryLog(c, [qEntry(1, { chainId: "728126428", action: "txlist", params: { address: TRON_HEX, limit: 20, only_confirmed: true } })],
    { i18n, dropped: 0, unloggedData: false, limit: 5000 });
  const tds = [...c.querySelectorAll("tbody td")];
  expect(tds.some((td) => td.textContent === "TV6Mu…iuSi" && td.title === TRON_T)).toBe(true);
  expect(tds.some((td) => td.textContent === "—/20")).toBe(true);
});

test("indicator names the host", async () => {
  const { ui, i18n } = await qlogEnv();
  const el = document.createElement("div");
  const ind = ui.createRequestIndicator(el, i18n);
  ind.setActive(true, "api.trongrid.io");
  expect(el.textContent).toBe("Contacting api.trongrid.io…");
  ind.setActive(true);
  expect(el.textContent).toBe("Contacting api.trongrid.io…");
  ind.setActive(false);
  ind.setActive(true);
  expect(el.textContent).toBe("Contacting api.etherscan.io…");
});

// ---------------------------------------------------------------------------
// Tron (Task 9): selector, notice, key field, persistence, detect hint
// ---------------------------------------------------------------------------
const TRON_ID = "728126428";
const TRON_A = "41d1c4bb7b2f39aba5707711719b2236b5b605af2e", TRON_B = "41787d916c8c4fda95428184434152cec57b522df8";
const tronEdge = () => {
  const e = v3Edge({ chainId: TRON_ID, hash: "33cb58f5a86d30ca27d9107ed54a3c4a665eda7e14a3f8212a1daf21a00a296f", from: TRON_A, to: TRON_B, symbol: "TRX", value: "8", tokenDecimal: "6" });
  return { ...e, key: `${TRON_ID}|txlist|${e.hash}|${TRON_A}|${TRON_B}||`, action: "txlist" };
};

test("no TronGrid request without choosing Tron", async () => {
  try {
    expect(tronCalls).toEqual([]); // app load and every earlier test
    $("resetBtn").click();
    $("address").value = TRON_T;
    $("address").dispatchEvent(new window.Event("input"));
    expect($("addressDetect").textContent).toContain("choose Tron (TronGrid)");
    expect($("chainSelect").value).toBe("1");
    $("detectChainBtn").click();
    await until(() => /Not an EVM address/.test($("logContent").textContent || ""));
    $("demoBtn").click();
    await until(() => /Demo workspace loaded/.test($("logContent").textContent || ""));
    await dropWorkspace(JSON.stringify(v3ws([v3Node(TRON_ID, TRON_A, { depth: 0, isRoot: true }), v3Node(TRON_ID, TRON_B)], [tronEdge()])));
    expect($("chainSelect").value).toBe("1");
    expect($("tronBox").hidden).toBe(true);
    const n = priceCalls.length;
    tick(true);
    await sleep(0);
    expect(priceCalls.length).toBe(n);
    tick(false);
    await freshScan("20");
    openRoot();
    loadBtn().click();
    await waitLoaded();
    expect(tronCalls).toEqual([]);
  } finally {
    restoreForm();
    $("address").value = "";
  }
});

test("Tron selector: not persisted, shows notice and key field", async () => {
  try {
    setChain("42161");
    setChain(TRON_ID);
    expect(localStorage.getItem("etherscanChainId")).toBe("42161");
    expect($("tronBox").hidden).toBe(false);
    expect($("tronNotice").textContent).toContain("api.trongrid.io");
    expect($("tronKey").type).toBe("password");
    await dropWorkspace(JSON.stringify(v3ws([v3Node("1", ROOT, { depth: 0, isRoot: true })], [])));
    expect($("chainSelect").value).toBe("1");
    expect($("tronBox").hidden).toBe(true);
    setChain(TRON_ID);
    await dropWorkspace(JSON.stringify(v3ws([v3Node(TRON_ID, TRON_A, { depth: 0, isRoot: true }), v3Node(TRON_ID, TRON_B)], [tronEdge()])));
    expect($("chainSelect").value).toBe(TRON_ID);
    expect($("tronBox").hidden).toBe(false);
  } finally {
    restoreForm();
  }
});

test("TronGrid key storage follows Remember", () => {
  try {
    $("rememberKey").checked = false;
    $("tronKey").value = "K1";
    $("tronKey").dispatchEvent(new window.Event("change"));
    expect(sessionStorage.getItem("tronGridApiKey")).toBe("K1");
    expect(localStorage.getItem("tronGridApiKey")).toBeNull();
    $("rememberKey").checked = true;
    $("rememberKey").dispatchEvent(new window.Event("change"));
    expect(localStorage.getItem("tronGridApiKey")).toBe("K1");
    expect(sessionStorage.getItem("tronGridApiKey")).toBeNull();
  } finally {
    $("rememberKey").checked = false;
    $("rememberKey").dispatchEvent(new window.Event("change"));
    $("tronKey").value = "";
    $("tronKey").dispatchEvent(new window.Event("change"));
    $("apiKey").value = "";
    $("apiKey").dispatchEvent(new window.Event("change"));
    localStorage.removeItem("tronGridApiKey"); sessionStorage.removeItem("tronGridApiKey");
    localStorage.removeItem("etherscanApiKey"); sessionStorage.removeItem("etherscanApiKey");
  }
});

// ---------------------------------------------------------------------------
// Tron (Task 10): scan, estimate and Load older through TronGrid
// ---------------------------------------------------------------------------
const TRON_ROOT_ID = ID(TRON_ID, TRON_A);
async function tronScan({ maxTx = "20", key = "", address = TRON_T } = {}) {
  $("resetBtn").click();
  $("apiKey").value = "";
  $("tronKey").value = key;
  setChain(TRON_ID);
  $("address").value = address;
  $("depth").value = "1";
  $("maxTxPerAddress").value = maxTx;
  $("startBtn").click();
  await until(() => /Done/.test($("status").textContent || ""));
}
// Start with Tron selected on an input that must be refused before any request.
function tronStartRefused(address) {
  $("resetBtn").click();
  $("apiKey").value = "";
  setChain(TRON_ID);
  $("address").value = address;
  $("startBtn").click();
}

test("a Tron scan hits only TronGrid, with no Etherscan key", async () => {
  try {
    const n = apiUrls.length, t = tronCalls.length;
    await tronScan({ key: "K-TRON" });
    expect(apiUrls.length).toBe(n);
    const calls = tronCalls.slice(t);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      `/v1/accounts/${TRON_A}/transactions`,
      `/v1/accounts/${TRON_A}/internal-transactions`,
      `/v1/accounts/${TRON_A}/transactions/trc20`,
    ]);
    for (const c of calls) {
      expect(c.init.headers["TRON-PRO-API-KEY"]).toBe("K-TRON");
      expect(c.init.credentials).toBe("omit");
      expect(c.init.referrerPolicy).toBe("no-referrer");
    }
    await until(() => qlogTitle() === "Query log (3)");
    expect(qlogTitle()).toBe("Query log (3)");
    const entries = await withDownloads(async (dl) => JSON.parse(await (await nextBlob(dl, "exportQueryLogBtn")).text()).entries);
    expect(entries.map((e) => e.source)).toEqual(["trongrid", "trongrid", "trongrid"]);
    for (const e of entries) expect(e.url.startsWith(`https://api.trongrid.io/v1/accounts/${TRON_A}`)).toBe(true);
    const node = window.vis.Network.first.nodes.get(TRON_ROOT_ID);
    expect(node).toBeTruthy();
    expect(node.label).toContain("TV6Mu");
  } finally {
    $("tronKey").value = "";
    restoreForm();
  }
});

test("keyless Tron scan sends no key header", async () => {
  try {
    const t = tronCalls.length;
    await tronScan();
    expect(tronCalls.length).toBe(t + 3);
    for (const c of tronCalls.slice(t)) expect(c.init.headers).toEqual({});
  } finally {
    $("tronKey").value = "";
    restoreForm();
  }
});

test("Tron root input: trimmed T…, checksum-checked, any-case 41 hex (Review Focus 1)", async () => {
  try {
    await tronScan({ address: `  ${TRON_T}  ` });
    expect(window.vis.Network.first.nodes.get(TRON_ROOT_ID)).toBeTruthy();

    for (const bad of [TRON_T.toLowerCase(), ROOT]) {
      const n = apiUrls.length, t = tronCalls.length;
      tronStartRefused(bad);
      await until(() => /Invalid Tron address/.test($("logContent").textContent || ""));
      expect($("logContent").textContent).toContain("Invalid Tron address");
      await sleep(0);
      expect(tronCalls.length).toBe(t);
      expect(apiUrls.length).toBe(n);
    }

    await tronScan({ address: TRON_A.toUpperCase() }); // "41D1C4…"
    expect(window.vis.Network.first.nodes.get(TRON_ROOT_ID)?.id).toBe(TRON_ROOT_ID);
  } finally {
    $("tronKey").value = "";
    restoreForm();
  }
});

test("Tron node details: T…, Tronscan link, TRC-20 history, no other-chains actions", async () => {
  try {
    await tronScan();
    clickNode(TRON_ROOT_ID);
    const panel = $("detailsContent");
    expect(panel.textContent).toContain(TRON_T);
    expect(panel.textContent).toContain("TRC-20:");
    expect(panel.textContent).not.toContain("ERC-721");
    expect(panel.textContent).not.toContain("41d1c4");
    expect([...panel.querySelectorAll("a")].some((a) => a.href === `https://tronscan.org/#/address/${TRON_T}`)).toBe(true);
    const buttons = [...panel.querySelectorAll("button")].map((b) => b.textContent);
    expect(buttons.some((s) => s.includes("Check other chains") || s.includes("Load on"))).toBe(false);
    expect(panel.querySelector("select")).toBeNull();
  } finally {
    window.vis.Network.first.setSelection({ nodes: [] });
    $("tronKey").value = "";
    restoreForm();
  }
});

test("Load older on Tron caps at 200 and keeps the cursor open (ruling 14)", async () => {
  const C1 = TRON_TRC20.data[0];
  const boxes = ["typeNormal", "typeInternal", "typeToken"].map((id) => [id, $(id).checked]);
  const saved = TRON_CANNED["transactions/trc20"];
  const page = {
    success: true,
    meta: { page_size: 200 },
    data: Array.from({ length: 200 }, (_, i) => ({ ...C1, transaction_id: String(i + 1).padStart(64, "0"), block_timestamp: C1.block_timestamp - i * 3000 })),
  };
  const minTs = Math.min(...page.data.map((r) => r.block_timestamp));
  try {
    $("typeNormal").checked = false;
    $("typeInternal").checked = false;
    $("typeToken").checked = true;
    TRON_CANNED["transactions/trc20"] = page;
    const t = tronCalls.length;
    await tronScan({ maxTx: "500" });
    expect($("logContent").textContent).toContain("at most 200");
    expect($("samplingBanner").textContent).toContain("latest 200 ");
    $("langToggle").click();
    $("langToggle").click(); // a locale round-trip keeps the effective N, not the form's 500
    expect($("samplingBanner").textContent).toContain("latest 200 ");
    const scanCalls = tronCalls.slice(t).map((c) => new URL(c.url));
    expect(scanCalls.map((u) => u.pathname)).toEqual([`/v1/accounts/${TRON_A}/transactions/trc20`]);
    expect(scanCalls[0].searchParams.get("limit")).toBe("200");
    clickNode(TRON_ROOT_ID);
    loadBtn().click();
    await waitLoaded();
    const last = new URL(tronCalls.at(-1).url);
    expect(last.pathname).toBe(`/v1/accounts/${TRON_A}/transactions/trc20`);
    expect(last.searchParams.get("limit")).toBe("200");
    expect(last.searchParams.get("max_timestamp")).toBe(String(minTs));
    expect($("detailsContent").textContent).toContain("TRC-20: 400 rows fetched · older available");
  } finally {
    TRON_CANNED["transactions/trc20"] = saved;
    for (const [id, on] of boxes) $(id).checked = on;
    window.vis.Network.first.setSelection({ nodes: [] });
    $("tronKey").value = "";
    restoreForm();
  }
});

test("search finds a Tron node by its T… form", async () => {
  const close = () => $("paletteInput").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  try {
    await tronScan();
    $("searchBtn").click();
    $("paletteInput").value = "TV6Mu";
    $("paletteInput").dispatchEvent(new window.Event("input"));
    const first = document.querySelector("#paletteResults .palette-item");
    expect(first.querySelector(".palette-item-title").textContent).toBe("TV6Mu…iuSi");
    expect(first.querySelector(".palette-item-subtitle").textContent).toContain(TRON_T);
  } finally {
    close();
    $("tronKey").value = "";
    restoreForm();
  }
});

test("workspace root keeps the canonical hex", async () => {
  try {
    await tronScan();
    expect($("address").value).toBe(TRON_T);
    const text = await withDownloads(async (dl) => (await nextBlob(dl, "saveBtn")).text());
    expect(JSON.parse(text).root).toBe("41d1c4bb7b2f39aba5707711719b2236b5b605af2e");
  } finally {
    $("tronKey").value = "";
    restoreForm();
  }
});

test("Estimate on Tron hits only TronGrid", async () => {
  try {
    $("resetBtn").click();
    $("apiKey").value = "";
    setChain(TRON_ID);
    $("address").value = TRON_T;
    $("depth").value = "1";
    const n = apiUrls.length, t = tronCalls.length;
    $("estimateBtn").click();
    await until(() => /Estimated/.test($("logContent").textContent || ""));
    expect($("logContent").textContent).toContain("Estimated");
    expect(tronCalls.length).toBe(t + 3);
    expect(apiUrls.length).toBe(n);
  } finally {
    $("tronKey").value = "";
    restoreForm();
  }
});
