import { describe, test, expect } from "bun:test";
import { runScan, selectedTypes } from "../src/scanner.js";
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
      calls.push({ address, action, offset: o.offset, signal: o.signal });
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
