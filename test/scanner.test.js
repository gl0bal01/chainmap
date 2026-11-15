import { describe, test, expect } from "bun:test";
import { runScan, loadOlder, selectedTypes } from "../src/scanner.js";
import { TX_TYPE_GROUPS } from "../src/config.js";

// -----------------------------------------------------------------------------
// Injected fakes. Per the Stage B contract the scanner test must NOT import the
// real etherscanClient / graphStore / rateLimiter (they build in parallel); it
// only imports the real config + format (pure contract base).
// -----------------------------------------------------------------------------

/** A valid 40-hex address from a single hex char, e.g. addr("a"). */
const addr = (c) => "0x" + c.repeat(40);
const R = addr("1");
const A = addr("a");
const B = addr("b");
const C = addr("c");
const D = addr("d");
const E = addr("e");

/** Fake limiter: run immediately, pass fn's result/rejection straight through. */
const fakeLimiter = { run: (fn) => fn() };

/**
 * Fake client. `responses` maps "address|action" -> tx[]. `throwOn` is a Set of
 * "address|action" keys whose fetch rejects (per-request failure).
 */
function makeClient(responses = {}, throwOn = new Set()) {
  const calls = [];
  return {
    calls,
    async fetchAction(address, action, o = {}) {
      const key = `${address}|${action}`;
      calls.push({ address, action, offset: o.offset, signal: o.signal, page: o.page, startblock: o.startblock, endblock: o.endblock, sort: o.sort });
      if (throwOn.has(key)) throw new Error(`boom:${key}`);
      return responses[key] ? responses[key].slice() : [];
    },
  };
}

/** Fake store: records calls, mimics dedup so stats() is realistic. */
function makeStore() {
  const nodes = new Map();
  const edgeKeys = new Set();
  const edges = [];
  const addNodeCalls = [];
  const addEdgeCalls = [];
  return {
    addNodeCalls,
    addEdgeCalls,
    _nodes: nodes,
    _edges: edges,
    addNode(address, opts = {}) {
      addNodeCalls.push({ address, ...opts });
      const existing = nodes.get(address);
      if (existing) {
        if (typeof opts.depth === "number" && opts.depth < existing.depth) existing.depth = opts.depth;
        if (opts.isRoot) existing.isRoot = true;
        return existing;
      }
      const rec = { address, depth: opts.depth ?? 0, isRoot: !!opts.isRoot, alias: null };
      nodes.set(address, rec);
      return rec;
    },
    addEdge(input) {
      addEdgeCalls.push(input);
      const key = [input.action, input.tx && input.tx.hash, input.from, input.to].join("|");
      if (edgeKeys.has(key)) return null;
      edgeKeys.add(key);
      const rec = { key, ...input };
      edges.push(rec);
      return rec;
    },
    stats() {
      return { nodes: nodes.size, edges: edges.length };
    },
    historyCalls: [],
    hasNode: (a) => nodes.has(a),
    getNode: (a) => nodes.get(a),
    removeNode: (a) => nodes.delete(a),
    setHistory(a, action, entry) {
      this.historyCalls.push({ a, action, entry });
      const n = nodes.get(a);
      if (!n) return;
      n.history = { ...(n.history || {}), [action]: entry };
    },
  };
}

function baseOpts(overrides = {}) {
  const controller = overrides.controller || new AbortController();
  const opts = {
    client: overrides.client,
    store: overrides.store,
    limiter: fakeLimiter,
    root: R,
    maxDepth: 2,
    maxTxPerAddress: 20,
    safetyCap: 100,
    types: overrides.types || selectedTypes({ normal: true }),
    signal: controller.signal,
    onProgress: overrides.onProgress,
    onLog: overrides.onLog,
  };
  delete overrides.controller;
  delete overrides.client;
  delete overrides.store;
  delete overrides.types;
  delete overrides.onProgress;
  delete overrides.onLog;
  return Object.assign(opts, overrides);
}

describe("selectedTypes", () => {
  test("empty selection -> []", () => {
    expect(selectedTypes({})).toEqual([]);
    expect(selectedTypes({ normal: false, internal: false, token: false })).toEqual([]);
  });

  test("normal only -> [txlist]", () => {
    const t = selectedTypes({ normal: true });
    expect(t.map((x) => x.action)).toEqual(["txlist"]);
  });

  test("token fans out to three actions", () => {
    const t = selectedTypes({ token: true });
    expect(t.map((x) => x.action)).toEqual(["tokentx", "tokennfttx", "token1155tx"]);
  });

  test("all selected -> flattened normal+internal+token (1+1+3)", () => {
    const t = selectedTypes({ normal: true, internal: true, token: true });
    expect(t.map((x) => x.action)).toEqual([
      "txlist",
      "txlistinternal",
      "tokentx",
      "tokennfttx",
      "token1155tx",
    ]);
    // Carries through the frozen TxTypeInfo shape (group + color).
    expect(t[0]).toMatchObject(TX_TYPE_GROUPS.normal[0]);
  });
});

describe("runScan — BFS", () => {
  test("depth >= maxDepth: node added but NOT expanded (not fetched)", async () => {
    const client = makeClient({
      [`${R}|txlist`]: [{ from: R, to: A, hash: "0xh1" }],
      [`${A}|txlist`]: [{ from: A, to: B, hash: "0xh2" }],
    });
    const store = makeStore();
    const summary = await runScan(baseOpts({ client, store, maxDepth: 1 }));

    // A is fetched only if expanded; at depth 1 == maxDepth it must not be.
    expect(client.calls.map((c) => c.address)).toEqual([R]);
    // A is still added as a node; B (A's neighbor) is never discovered.
    expect(store._nodes.has(A)).toBe(true);
    expect(store._nodes.has(B)).toBe(false);
    expect(store.stats().nodes).toBe(2);
    // Both R and A are dequeued+processed.
    expect(summary.processed).toBe(2);
    expect(summary.sampled).toBe(true);
    expect(summary.perAddressLimit).toBe(20);
    expect(summary.maxDepth).toBe(1);
    expect(summary.root).toBe(R);
  });

  test("passes maxTxPerAddress as the fetch offset (explicit sampling)", async () => {
    const client = makeClient({ [`${R}|txlist`]: [] });
    const store = makeStore();
    await runScan(baseOpts({ client, store, maxDepth: 1, maxTxPerAddress: 7 }));
    expect(client.calls[0].offset).toBe(7);
  });

  test("enqueue dedup: a neighbor reached twice is enqueued/fetched once", async () => {
    const client = makeClient({
      [`${R}|txlist`]: [
        { from: R, to: A, hash: "0xh1" },
        { from: R, to: A, hash: "0xh2" },
      ],
      [`${A}|txlist`]: [],
    });
    const store = makeStore();
    const summary = await runScan(baseOpts({ client, store, maxDepth: 2 }));

    const aFetches = client.calls.filter((c) => c.address === A).length;
    expect(aFetches).toBe(1);
    expect(summary.processed).toBe(2); // R + A once
  });

  test("safetyCap enforced AT ENQUEUE: total queued never exceeds cap; capped set", async () => {
    const client = makeClient({
      [`${R}|txlist`]: [
        { from: R, to: A, hash: "0xh1" },
        { from: R, to: B, hash: "0xh2" },
        { from: R, to: C, hash: "0xh3" },
      ],
      [`${A}|txlist`]: [
        { from: A, to: D, hash: "0xh4" },
        { from: A, to: E, hash: "0xh5" },
      ],
    });
    const store = makeStore();
    const summary = await runScan(baseOpts({ client, store, maxDepth: 3, safetyCap: 2 }));

    // Root + exactly one neighbor admitted -> only those two are ever fetched.
    const fetched = new Set(client.calls.map((c) => c.address));
    expect(fetched).toEqual(new Set([R, A]));
    expect(summary.processed).toBe(2);
    expect(summary.capped).toBe(true);
    // B/C (and A's D/E) are still added as nodes, just never expanded.
    expect(store._nodes.has(B)).toBe(true);
    expect(store._nodes.has(C)).toBe(true);
  });

  test("failed txs (isError '1' / txreceipt_status '0') dropped + counted", async () => {
    const client = makeClient({
      [`${R}|txlist`]: [
        { from: R, to: A, hash: "0xh1", isError: "1" },
        { from: R, to: B, hash: "0xh2", txreceipt_status: "0" },
        { from: R, to: C, hash: "0xh3" },
      ],
    });
    const store = makeStore();
    const summary = await runScan(baseOpts({ client, store, maxDepth: 1 }));

    expect(summary.failed).toBe(2);
    // Only the successful tx produces an edge (and its endpoints as nodes).
    expect(store.addEdgeCalls.length).toBe(1);
    expect(store.addEdgeCalls[0].to).toBe(C);
    expect(store._nodes.has(A)).toBe(false);
    expect(store._nodes.has(B)).toBe(false);
    expect(store._nodes.has(C)).toBe(true);
  });

  test("invalid endpoints skipped + counted (bad to, bad from)", async () => {
    const client = makeClient({
      [`${R}|txlist`]: [
        { from: R, to: A, hash: "0xh1" },
        { from: R, to: "0x123", hash: "0xh2" }, // to too short
        { from: "badfrom", to: A, hash: "0xh3" }, // from not an address
      ],
    });
    const store = makeStore();
    const summary = await runScan(baseOpts({ client, store, maxDepth: 1 }));

    expect(summary.skipped).toBe(2);
    expect(store.addEdgeCalls.length).toBe(1);
    expect(store.addEdgeCalls[0].to).toBe(A);
  });

  test("contract creation (to empty, contractAddress set) still draws an edge", async () => {
    const client = makeClient({
      [`${R}|txlist`]: [{ from: R, to: "", contractAddress: C, hash: "0xh1" }],
    });
    const store = makeStore();
    await runScan(baseOpts({ client, store, maxDepth: 1 }));

    expect(store.addEdgeCalls.length).toBe(1);
    expect(store.addEdgeCalls[0].to).toBe(C);
    expect(store._nodes.has(C)).toBe(true);
  });

  test("pre-aborted signal -> stopped summary, minimal work", async () => {
    const client = makeClient({ [`${R}|txlist`]: [{ from: R, to: A, hash: "0xh1" }] });
    const store = makeStore();
    const controller = new AbortController();
    controller.abort();
    const summary = await runScan(baseOpts({ client, store, controller, maxDepth: 3 }));

    expect(summary.stopped).toBe(true);
    expect(summary.processed).toBe(0);
    expect(summary.apiCalls).toBe(0);
    expect(client.calls.length).toBe(0);
    // Root was still seeded as a node.
    expect(store._nodes.has(R)).toBe(true);
    expect(store.stats().nodes).toBe(1);
  });

  test("plan_required stops the scan, logs error.planRequired, sets summary.planRequired", async () => {
    const client = makeClient();
    client.fetchAction = async () => {
      client.calls.push({});
      throw Object.assign(new Error("paid"), { kind: "plan_required" });
    };
    const logs = [];
    const summary = await runScan(
      baseOpts({ client, store: makeStore(), types: selectedTypes({ normal: true, internal: true }), onLog: (e) => logs.push(e) })
    );
    expect(client.calls.length).toBe(1);
    expect(summary.planRequired).toBe(true);
    expect(logs.map((l) => l.key)).toEqual(["error.planRequired"]);
  });

  test("per-request fetch error is logged + counted, scan continues", async () => {
    const client = makeClient(
      { [`${R}|txlistinternal`]: [{ from: R, to: A, hash: "0xh1" }] },
      new Set([`${R}|txlist`]) // txlist rejects; txlistinternal still runs
    );
    const store = makeStore();
    const logs = [];
    const summary = await runScan(
      baseOpts({
        client,
        store,
        maxDepth: 1,
        types: selectedTypes({ normal: true, internal: true }),
        onLog: (e) => logs.push(e),
      })
    );

    // Failure surfaced, but the scan did not throw and kept going.
    expect(summary.errors.length).toBe(1);
    expect(logs.some((l) => l.level === "error")).toBe(true);
    expect(summary.apiCalls).toBe(2); // both actions attempted
    expect(store.addEdgeCalls.length).toBe(1); // internal action produced the edge
    expect(store.addEdgeCalls[0].to).toBe(A);
    expect(summary.stopped).toBe(false);
  });

  test("emits onProgress at least once per dequeued address", async () => {
    const client = makeClient({
      [`${R}|txlist`]: [{ from: R, to: A, hash: "0xh1" }],
      [`${A}|txlist`]: [],
    });
    const store = makeStore();
    const progress = [];
    const summary = await runScan(
      baseOpts({ client, store, maxDepth: 2, onProgress: (p) => progress.push(p) })
    );

    expect(progress.length).toBeGreaterThanOrEqual(summary.processed);
    expect(progress[0]).toHaveProperty("current");
    expect(progress[0]).toHaveProperty("depth");
    expect(progress[0].maxDepth).toBe(2);
    expect(progress[progress.length - 1]).toHaveProperty("queued");
  });
});

describe("scan cursors", () => {
  const tx = (from, to, block, extra = {}) => ({ from, to, hash: `0xh${from}${to}${block}`, blockNumber: String(block), ...extra });

  test("runScan records a first-load cursor per expanded node; frontier nodes get none", async () => {
    const client = makeClient({ [`${R}|txlist`]: [tx(R, A, 10), tx(R, A, 9, { hash: "0xz" })] });
    const store = makeStore();
    await runScan(baseOpts({ client, store, maxDepth: 1, maxTxPerAddress: 2 }));
    expect(store.getNode(R).history.txlist).toEqual({ oldestBlock: "9", blockPage: 0, pageSize: 0, done: false, count: 2 });
    expect(store.getNode(A).history).toBeUndefined();
  });

  test("runScan replaces an existing entry instead of merging", async () => {
    const client = makeClient({ [`${R}|txlist`]: [tx(R, A, 10)] });
    const store = makeStore();
    store.addNode(R, { depth: 0, isRoot: true });
    store.getNode(R).history = { txlist: { oldestBlock: "5", blockPage: 0, pageSize: 0, done: true, count: 40 } };
    await runScan(baseOpts({ client, store, maxDepth: 1, maxTxPerAddress: 2 }));
    expect(store.getNode(R).history.txlist).toEqual({ oldestBlock: "10", blockPage: 0, pageSize: 0, done: true, count: 1 });
  });
});

describe("loadOlder", () => {
  const tx = (from, to, block, extra = {}) => ({ from, to, hash: `0xh${from}${to}${block}`, blockNumber: String(block), ...extra });
  const done = { oldestBlock: "1", blockPage: 0, pageSize: 0, done: true, count: 5 };
  const lo = (o) => loadOlder({ limiter: fakeLimiter, address: R, types: selectedTypes({ normal: true }), maxTxPerAddress: 2, ...o });
  const seeded = (history) => {
    const store = makeStore();
    store.addNode(R, { depth: 1 });
    if (history) store.getNode(R).history = history;
    return store;
  };

  test("never-loaded node fetches the newest page", async () => {
    const client = makeClient({ [`${R}|txlist`]: [tx(R, A, 5)] });
    const r = await lo({ client, store: seeded() });
    expect(client.calls[0].page).toBe(1);
    expect(client.calls[0].endblock).toBeUndefined();
    expect(client.calls[0].sort).toBe("desc");
    expect(r.newEdges).toBe(1);
  });

  test("passes inclusive endblock and advances", async () => {
    const store = seeded({ txlist: { oldestBlock: "9", blockPage: 0, pageSize: 0, done: false, count: 2 } });
    const dup = tx(R, A, 9);
    store.addEdge({ action: "txlist", from: R, to: A, tx: dup });
    const client = makeClient({ [`${R}|txlist`]: [dup, tx(R, B, 7)] });
    const r = await lo({ client, store });
    expect(client.calls[0].endblock).toBe(9);
    expect(store.getNode(R).history.txlist.oldestBlock).toBe("7");
    expect(r.newEdges).toBe(1);
  });

  test("adds counterparties at depth+1 without expanding them", async () => {
    const client = makeClient({ [`${R}|txlist`]: [tx(R, A, 5)] });
    const store = seeded();
    await lo({ client, store });
    expect(store.getNode(A).depth).toBe(2);
    expect(client.calls.every((c) => c.address === R)).toBe(true);
  });

  test("skips done types", async () => {
    const client = makeClient();
    const r = await lo({ client, store: seeded({ txlist: done }) });
    expect(client.calls.length).toBe(0);
    expect(r.allDone).toBe(true);
  });

  test("failed rows advance the cursor but draw nothing", async () => {
    const client = makeClient({ [`${R}|txlist`]: [tx(R, A, 8), tx(R, B, 7, { isError: "1" })] });
    const store = seeded();
    const r = await lo({ client, store });
    expect(store.getNode(R).history.txlist.oldestBlock).toBe("7");
    expect(r.newEdges).toBe(1);
    expect(r.failed).toBe(1);
  });

  test("per-type fetch error logs error.fetch and leaves that cursor", async () => {
    const entry = { oldestBlock: "9", blockPage: 0, pageSize: 0, done: false, count: 2 };
    const client = makeClient({ [`${R}|tokentx`]: [tx(R, A, 3)] }, new Set([`${R}|txlist`]));
    const store = seeded({ txlist: entry });
    const logs = [];
    await lo({ client, store, types: selectedTypes({ normal: true }).concat(TX_TYPE_GROUPS.token.slice(0, 1)), onLog: (e) => logs.push(e) });
    expect(store.getNode(R).history.txlist).toEqual(entry);
    expect(store.getNode(R).history.tokentx.oldestBlock).toBe("3");
    expect(logs.map((l) => l.key)).toEqual(["error.fetch"]);
  });

  test("plan_required stops the load", async () => {
    const client = makeClient();
    client.fetchAction = async () => {
      client.calls.push({});
      throw Object.assign(new Error("x"), { kind: "plan_required" });
    };
    const logs = [];
    const r = await lo({ client, store: seeded(), types: selectedTypes({ normal: true, internal: true }), onLog: (e) => logs.push(e) });
    expect(r.planRequired).toBe(true);
    expect(client.calls.length).toBe(1);
    expect(logs.map((l) => l.key)).toEqual(["error.planRequired"]);
  });

  test("abort leaves cursor and reports stopped", async () => {
    const client = makeClient();
    const store = seeded();
    const c = new AbortController();
    c.abort();
    const r = await lo({ client, store, signal: c.signal });
    expect(client.calls.length).toBe(0);
    expect(r.stopped).toBe(true);
    expect(store.getNode(R).history).toBeUndefined();
  });

  test("stops if node removed mid-load", async () => {
    const client = makeClient();
    const store = seeded();
    client.fetchAction = async (address, action) => {
      client.calls.push({ address, action });
      store.removeNode(R);
      return [tx(R, A, 5)];
    };
    const r = await lo({ client, store, types: selectedTypes({ normal: true, internal: true }) });
    expect(client.calls.length).toBe(1);
    expect(store.hasNode(R)).toBe(false);
    expect(r.newEdges).toBeGreaterThanOrEqual(0);
    expect(r.newNodes).toBeGreaterThanOrEqual(0);
  });

  test("abort mid-fetch reports stopped, no error.fetch, cursor unchanged", async () => {
    const client = makeClient();
    const store = seeded();
    const c = new AbortController();
    client.fetchAction = async () => {
      client.calls.push({});
      c.abort();
      throw Object.assign(new Error("aborted"), { kind: "aborted" });
    };
    const logs = [];
    const r = await lo({ client, store, signal: c.signal, onLog: (e) => logs.push(e) });
    expect(r.stopped).toBe(true);
    expect(logs).toEqual([]);
    expect(store.getNode(R).history).toBeUndefined();
  });

  test("empty types never reads as allDone", async () => {
    const client = makeClient();
    const r = await lo({ client, store: seeded(), types: [] });
    expect(r.allDone).toBe(false);
    expect(client.calls.length).toBe(0);
  });

  test("unknown address: no fetch, zeroed", async () => {
    const client = makeClient();
    const r = await lo({ client, store: makeStore() });
    expect(client.calls.length).toBe(0);
    expect(r).toMatchObject({ apiCalls: 0, allDone: false, stopped: false });
  });
});
