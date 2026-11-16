import { describe, test, expect } from "bun:test";
import { GraphStore } from "../src/graphStore.js";
import { nodeId } from "../src/format.js";

// Realistic 40-hex addresses (mixed case on purpose to exercise lowercasing).
const A = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const B = "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb";
const C = "0xCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCc";
const a = A.toLowerCase();
const b = B.toLowerCase();
const c = C.toLowerCase();

/** Minimal ETH-style tx record. */
function ethTx(over = {}) {
  return {
    hash: "0xhash1",
    value: "1000000000000000000", // 1 ETH at 18 decimals
    timeStamp: "1700000000",
    blockNumber: "18000000",
    ...over,
  };
}

/** Build a normal-transfer EdgeInput between from/to. */
function edgeInput(from, to, tx, chainId = "1") {
  return { chainId, action: "txlist", group: "normal", color: "#fff", from, to, tx: tx || ethTx() };
}

const id = (addr, chain = "1") => nodeId(chain, addr);

/** Collect events for assertions. */
function recorder(store) {
  const events = [];
  const unsub = store.subscribe((e) => events.push(e));
  return { events, unsub };
}

describe("GraphStore.addNode", () => {
  test("new node emits node:add and lowercases the address", () => {
    const store = new GraphStore();
    const { events } = recorder(store);
    const node = store.addNode("1", A, { depth: 2, isRoot: false });

    expect(node.address).toBe(a);
    expect(node.depth).toBe(2);
    expect(node.isRoot).toBe(false);
    expect(node.alias).toBeNull();
    expect(store.hasNode(id(A))).toBe(true);
    expect(store.hasNode(id(a))).toBe(true);
    expect(events).toEqual([{ type: "node:add", node }]);
  });

  test("merge keeps the MINIMUM depth and emits node:update only when changed", () => {
    const store = new GraphStore();
    store.addNode("1", A, { depth: 5 });
    const { events } = recorder(store);

    // Lower depth -> update.
    store.addNode("1", A, { depth: 2 });
    expect(store.getNode(id(A)).depth).toBe(2);

    // Higher depth -> no change, no event.
    store.addNode("1", A, { depth: 9 });
    expect(store.getNode(id(A)).depth).toBe(2);

    // Equal depth -> no change, no event.
    store.addNode("1", A, { depth: 2 });
    expect(store.getNode(id(A)).depth).toBe(2);

    expect(events).toEqual([{ type: "node:update", node: store.getNode(id(A)) }]);
    expect(store.stats().nodes).toBe(1);
  });

  test("isRoot is sticky: once true it stays true and never flips back", () => {
    const store = new GraphStore();
    store.addNode("1", A, { depth: 0, isRoot: true });
    // Re-add without isRoot (and without depth change) -> no event, still root.
    const { events } = recorder(store);
    store.addNode("1", A, { isRoot: false });
    expect(store.getNode(id(A)).isRoot).toBe(true);
    expect(events).toEqual([]);
  });

  test("merge can raise isRoot from false to true and emits update", () => {
    const store = new GraphStore();
    store.addNode("1", A, { depth: 3, isRoot: false });
    const { events } = recorder(store);
    store.addNode("1", A, { isRoot: true });
    expect(store.getNode(id(A)).isRoot).toBe(true);
    expect(events).toEqual([{ type: "node:update", node: store.getNode(id(A)) }]);
  });

  test("depth defaults to 0 when omitted on a new node", () => {
    const store = new GraphStore();
    const node = store.addNode("1", A);
    expect(node.depth).toBe(0);
    expect(node.isRoot).toBe(false);
  });
});

describe("GraphStore.addEdge", () => {
  test("first insert builds a full EdgeRecord and emits edge:add", () => {
    const store = new GraphStore();
    store.addNode("1", A);
    store.addNode("1", B);
    const { events } = recorder(store);

    const edge = store.addEdge(edgeInput(A, B));
    expect(edge).not.toBeNull();
    expect(edge.from).toBe(a);
    expect(edge.to).toBe(b);
    expect(edge.symbol).toBe("ETH");
    expect(edge.tokenContract).toBe("");
    expect(edge.tokenId).toBe("");
    expect(edge.value).toBe("1000000000000000000");
    expect(edge.amountText).toBe("1"); // 1 ETH, trimmed
    expect(edge.amountIndeterminate).toBe(false);
    expect(edge.tokenDecimal).toBe(""); // no tx.tokenDecimal -> persisted as "" (never left undefined)
    expect(edge.hash).toBe("0xhash1");
    expect(store.hasEdgeKey(edge.key)).toBe(true);
    expect(events).toEqual([{ type: "edge:add", edge }]);
    expect(store.stats().edges).toBe(1);
  });

  test("duplicate key returns null and emits no event", () => {
    const store = new GraphStore();
    store.addNode("1", A);
    store.addNode("1", B);
    store.addEdge(edgeInput(A, B));
    const { events } = recorder(store);

    const dup = store.addEdge(edgeInput(A, B)); // identical action/hash/from/to
    expect(dup).toBeNull();
    expect(events).toEqual([]);
    expect(store.stats().edges).toBe(1);
  });

  test("token symbol / contract / tokenId and indeterminate amount flow through", () => {
    const store = new GraphStore();
    store.addNode("1", A);
    store.addNode("1", B);
    const tx = ethTx({
      hash: "0xtoken",
      value: "5000000",
      tokenSymbol: "USDC",
      contractAddress: "0xA0b86991c6218B36C1D19d4A2E9EB0CE3606EB48",
      tokenDecimal: "6",
    });
    const edge = store.addEdge({ chainId: "1", action: "tokentx", group: "token", color: "#0f0", from: A, to: B, tx });
    expect(edge.symbol).toBe("USDC");
    expect(edge.tokenContract).toBe("0xA0b86991c6218B36C1D19d4A2E9EB0CE3606EB48");
    expect(edge.amountText).toBe("5"); // 5000000 / 1e6
    expect(edge.amountIndeterminate).toBe(false);
    expect(edge.tokenDecimal).toBe("6"); // persisted raw decimals, not just baked into amountText

    // Bad decimals -> honest indeterminate with raw integer text.
    store.addNode("1", C);
    const badTx = ethTx({ hash: "0xbad", value: "123", tokenDecimal: "" });
    const badEdge = store.addEdge({ chainId: "1", action: "tokentx", group: "token", color: "#0f0", from: B, to: C, tx: badTx });
    expect(badEdge.amountIndeterminate).toBe(true);
    expect(badEdge.amountText).toBe("123");
    expect(badEdge.tokenDecimal).toBe(""); // persisted as "" too, so later re-formatting stays honest
  });

  test("same hash but different contract stays distinct (not deduped)", () => {
    const store = new GraphStore();
    store.addNode("1", A);
    store.addNode("1", B);
    const t1 = ethTx({ hash: "0xshared", contractAddress: "0x1111111111111111111111111111111111111111", tokenID: "" });
    const t2 = ethTx({ hash: "0xshared", contractAddress: "0x2222222222222222222222222222222222222222", tokenID: "" });
    const e1 = store.addEdge({ chainId: "1", action: "tokentx", group: "token", color: "#0f0", from: A, to: B, tx: t1 });
    const e2 = store.addEdge({ chainId: "1", action: "tokentx", group: "token", color: "#0f0", from: A, to: B, tx: t2 });
    expect(e1).not.toBeNull();
    expect(e2).not.toBeNull();
    expect(e1.key).not.toBe(e2.key);
    expect(store.stats().edges).toBe(2);
  });

  test("addEdge does NOT auto-create endpoint nodes", () => {
    const store = new GraphStore();
    const edge = store.addEdge(edgeInput(A, B)); // no nodes added first
    expect(edge).not.toBeNull();
    expect(store.stats().nodes).toBe(0);
    // Store now intentionally violates the endpoint invariant.
    expect(store.checkInvariants().ok).toBe(false);
  });

  // CWE-20: a non-string `input` (malformed/tampered API response) must not
  // throw inside addEdge — before the guard, [].slice().toLowerCase() crashed
  // the whole scan.
  test("non-string tx.input never throws; yields inert calldata fields", () => {
    const store = new GraphStore();
    // Array(10) is the case that actually crashed pre-fix: input.length >= 10
    // took the slice branch, and [].slice().toLowerCase is not a function.
    for (const bad of [null, 123, [], {}, ["0x", "a"], Array(10).fill("x")]) {
      const edge = store.addEdge(edgeInput(A, B, ethTx({ hash: `0x${String(bad)}`, input: bad })));
      expect(edge).not.toBeNull();
      expect(edge.hasData).toBe(false);
      expect(edge.methodId).toBe("");
      expect(edge.methodArgs).toEqual([]);
    }
  });
});

describe("GraphStore.setAlias", () => {
  test("sets an alias on an existing node and emits alias:set", () => {
    const store = new GraphStore();
    store.addNode("1", A);
    const { events } = recorder(store);
    store.setAlias(id(A), "Exchange");
    expect(store.getAlias(id(A))).toBe("Exchange");
    expect(events).toEqual([{ type: "alias:set", id: id(a), alias: "Exchange" }]);
  });

  test("empty string and null both clear the alias", () => {
    const store = new GraphStore();
    store.addNode("1", A);
    store.setAlias(id(A), "Label");

    store.setAlias(id(A), "");
    expect(store.getAlias(id(A))).toBeNull();

    store.setAlias(id(A), "Label2");
    store.setAlias(id(A), null);
    expect(store.getAlias(id(A))).toBeNull();
  });

  test("no-op when node absent (no event, alias stays null)", () => {
    const store = new GraphStore();
    const { events } = recorder(store);
    store.setAlias(id(A), "ghost");
    expect(events).toEqual([]);
    expect(store.getAlias(id(A))).toBeNull();
  });
});

describe("GraphStore.removeNodes", () => {
  test("cascade removes connected edges, updates counts, drops alias", () => {
    const store = new GraphStore();
    store.addNode("1", A, { isRoot: true });
    store.addNode("1", B);
    store.addNode("1", C);
    store.setAlias(id(B), "Middle");
    // A->B, B->C, and A->C so B has two connected edges.
    store.addEdge(edgeInput(A, B, ethTx({ hash: "0xab" })));
    store.addEdge(edgeInput(B, C, ethTx({ hash: "0xbc" })));
    store.addEdge(edgeInput(A, C, ethTx({ hash: "0xac" })));
    expect(store.stats()).toEqual({ nodes: 3, edges: 3 });

    const { events } = recorder(store);
    const result = store.removeNodes([id(B)]);

    expect(result).toEqual({ removedNodes: 1, removedEdges: 2 });
    expect(store.hasNode(id(B))).toBe(false);
    expect(store.getAlias(id(B))).toBeNull();
    expect(store.stats()).toEqual({ nodes: 2, edges: 1 }); // only A->C survives

    const removeEvents = events.filter((e) => e.type === "edge:remove");
    const nodeEvents = events.filter((e) => e.type === "node:remove");
    expect(removeEvents.length).toBe(2);
    expect(nodeEvents).toEqual([{ type: "node:remove", id: id(b) }]);
    // edges removed before the node.
    expect(events[events.length - 1]).toEqual({ type: "node:remove", id: id(b) });
    // surviving edge key still present & parity intact.
    expect(store.checkInvariants().ok).toBe(true);
  });

  test("skips unknown addresses without events", () => {
    const store = new GraphStore();
    store.addNode("1", A);
    const { events } = recorder(store);
    const result = store.removeNodes([id(C)]); // not present
    expect(result).toEqual({ removedNodes: 0, removedEdges: 0 });
    expect(events).toEqual([]);
  });
});

describe("GraphStore.reset", () => {
  test("clears all structures and emits a single reset", () => {
    const store = new GraphStore();
    store.addNode("1", A);
    store.addNode("1", B);
    store.addEdge(edgeInput(A, B));
    store.setAlias(id(A), "x");

    const { events } = recorder(store);
    store.reset();

    expect(store.stats()).toEqual({ nodes: 0, edges: 0 });
    expect(store.listNodes()).toEqual([]);
    expect(store.listEdges()).toEqual([]);
    expect(store.hasNode(id(A))).toBe(false);
    expect(events).toEqual([{ type: "reset" }]);
  });
});

describe("GraphStore.subscribe", () => {
  test("delivers events synchronously and unsubscribe stops delivery", () => {
    const store = new GraphStore();
    const seen = [];
    const unsub = store.subscribe((e) => seen.push(e.type));

    store.addNode("1", A);
    expect(seen).toEqual(["node:add"]); // synchronous

    unsub();
    store.addNode("1", B);
    expect(seen).toEqual(["node:add"]); // no further delivery
  });

  test("multiple subscribers each receive events", () => {
    const store = new GraphStore();
    const s1 = [];
    const s2 = [];
    store.subscribe((e) => s1.push(e.type));
    store.subscribe((e) => s2.push(e.type));
    store.addNode("1", A);
    expect(s1).toEqual(["node:add"]);
    expect(s2).toEqual(["node:add"]);
  });
});

describe("GraphStore.checkInvariants", () => {
  test("ok === true after a realistic add/alias/remove sequence", () => {
    const store = new GraphStore();
    store.addNode("1", A, { depth: 0, isRoot: true });
    store.addNode("1", B, { depth: 1 });
    store.addNode("1", C, { depth: 1 });
    store.addEdge(edgeInput(A, B, ethTx({ hash: "0x1" })));
    store.addEdge(edgeInput(A, C, ethTx({ hash: "0x2" })));
    store.addEdge(edgeInput(B, C, ethTx({ hash: "0x3" })));
    store.setAlias(id(A), "Root");
    store.removeNodes([id(C)]);

    const inv = store.checkInvariants();
    expect(inv.errors).toEqual([]);
    expect(inv.ok).toBe(true);
  });

  test("detects a dangling edge (endpoint node missing)", () => {
    const store = new GraphStore();
    store.addNode("1", A);
    store.addNode("1", B);
    store.addEdge(edgeInput(A, B));
    // Corrupt internal state directly: drop node B but leave the edge.
    store._nodes.delete(id(b));
    const inv = store.checkInvariants();
    expect(inv.ok).toBe(false);
    expect(inv.errors.some((e) => e.includes(b))).toBe(true);
  });

  test("detects edgeKeys <-> edges parity break", () => {
    const store = new GraphStore();
    store.addNode("1", A);
    store.addNode("1", B);
    store.addEdge(edgeInput(A, B));
    // Corrupt parity: remove the edge but keep the key.
    const [key] = [...store._edgeKeys];
    store._edges.delete(key);
    const inv = store.checkInvariants();
    expect(inv.ok).toBe(false);
    expect(inv.errors.some((e) => e.toLowerCase().includes("parity") || e.includes(key))).toBe(true);
  });
});

describe("GraphStore.setHistory", () => {
  const entry = { oldestBlock: "800", blockPage: 0, pageSize: 0, done: false, count: 3 };

  test("sets the entry and emits node:update", () => {
    const store = new GraphStore();
    store.addNode("1", A);
    const { events } = recorder(store);
    store.setHistory(id(A), "txlist", entry);
    expect(store.getNode(id(A)).history.txlist).toEqual(entry);
    const last = events[events.length - 1];
    expect(last.type).toBe("node:update");
    expect(last.node.address).toBe(a);
  });

  test("keeps other actions", () => {
    const store = new GraphStore();
    store.addNode("1", A);
    store.setHistory(id(A), "txlist", entry);
    store.setHistory(id(A), "tokentx", { ...entry, count: 5 });
    expect(Object.keys(store.getNode(id(A)).history).sort()).toEqual(["tokentx", "txlist"]);
  });

  test("absent node is a silent no-op", () => {
    const store = new GraphStore();
    const { events } = recorder(store);
    expect(() => store.setHistory(id(A), "txlist", entry)).not.toThrow();
    expect(events).toEqual([]);
  });
});

test("loadSnapshot keeps valid history and drops malformed entries", () => {
  const valid = { oldestBlock: "800", blockPage: 0, pageSize: 0, done: false, count: 3 };
  const store = new GraphStore();
  store.loadSnapshot(
    [
      { chainId: "1", address: a, depth: 0, isRoot: true, history: { txlist: valid, tokentx: { ...valid, oldestBlock: "x" } } },
      { chainId: "1", address: b, depth: 1, history: "junk" },
    ],
    [],
  );
  expect(store.getNode(id(a)).history).toEqual({ txlist: valid });
  expect(store.getNode(id(b)).history).toBeUndefined();
});

describe("GraphStore — chain-scoped identity", () => {
  const entry = { oldestBlock: "9", blockPage: 0, pageSize: 0, done: false, count: 1 };

  test("addNode builds {id, chainId, address}; a numeric chainId is normalized; an address alone is not an id", () => {
    const s = new GraphStore();
    expect(s.addNode(1, A, { depth: 2 })).toEqual({ id: `1:${a}`, chainId: "1", address: a, depth: 2, isRoot: false, alias: null });
    expect(s.hasNode(`1:${a}`)).toBe(true);
    expect(s.hasNode(a)).toBe(false);
  });

  test("addNode/addEdge without a valid chainId throw and add nothing", () => {
    const s = new GraphStore();
    for (const bad of [undefined, null, "", "eth", "1.5", -1, "0x1"]) {
      expect(() => s.addNode(bad, A)).toThrow();
      expect(() => s.addEdge({ ...edgeInput(A, B), chainId: bad })).toThrow();
    }
    expect(s.stats()).toEqual({ nodes: 0, edges: 0 });
  });

  test("the same address on two chains is two independent nodes", () => {
    const s = new GraphStore();
    s.addNode("1", A, { depth: 0, isRoot: true });
    s.addNode("56", A, { depth: 3 });
    s.setAlias(id(A, "56"), "bsc twin");
    s.setHistory(id(A, "1"), "txlist", entry);
    expect(s.stats().nodes).toBe(2);
    expect(s.getNode(id(A, "1"))).toMatchObject({ isRoot: true, depth: 0, alias: null });
    expect(s.getNode(id(A, "56"))).toMatchObject({ isRoot: false, depth: 3, alias: "bsc twin" });
    expect(s.getNode(id(A, "56")).history).toBeUndefined();
  });

  test("edges carry chainId/fromId/toId and a chain-prefixed key; a replayed hash on two chains is two edges", () => {
    const s = new GraphStore();
    for (const c of ["1", "56"]) { s.addNode(c, A); s.addNode(c, B); }
    const e1 = s.addEdge(edgeInput(A, B, ethTx(), "1"));
    const e56 = s.addEdge(edgeInput(A, B, ethTx(), "56"));
    expect(e1).toMatchObject({ chainId: "1", from: a, to: b, fromId: id(A), toId: id(B) });
    expect(e1.key.startsWith("1|")).toBe(true);
    expect(e56.key).toBe("56|" + e1.key.slice(2));
    expect(s.addEdge(edgeInput(A, B, ethTx(), "56"))).toBeNull(); // dup on the same chain
    expect(s.stats().edges).toBe(2);
  });

  test("the native ticker comes from the edge's chain", () => {
    const s = new GraphStore();
    const sym = (chainId, tx = ethTx({ hash: chainId })) => { s.addNode(chainId, A); s.addNode(chainId, B); return s.addEdge(edgeInput(A, B, tx, chainId)).symbol; };
    expect(sym("1")).toBe("ETH");
    expect(sym("56")).toBe("BNB");
    expect(sym("137")).toBe("POL");
    expect(sym("999999")).toBe(""); // unknown chain: no borrowed ticker
    expect(sym("10", ethTx({ hash: "0xt", tokenSymbol: "USDC" }))).toBe("USDC");
    expect(s.setNativeSymbol).toBeUndefined();
  });

  test("removeNodes([id]) removes only that chain's twin and its edges", () => {
    const s = new GraphStore();
    for (const c of ["1", "56"]) { s.addNode(c, A); s.addNode(c, B); s.addEdge(edgeInput(A, B, ethTx(), c)); }
    const { events } = recorder(s);
    expect(s.removeNodes([id(A, "56")])).toEqual({ removedNodes: 1, removedEdges: 1 });
    expect(events.map((e) => e.type)).toEqual(["edge:remove", "node:remove"]);
    expect(events[1]).toEqual({ type: "node:remove", id: id(A, "56") });
    expect(s.hasNode(id(A, "1"))).toBe(true);
    expect(s.listEdges().map((e) => e.chainId)).toEqual(["1"]);
  });

  test("chains() is distinct, numeric-ascending, and follows add/remove/reset/loadSnapshot", () => {
    const s = new GraphStore();
    expect(s.chains()).toEqual([]);
    for (const c of ["137", "1", "42161", "10", "1"]) s.addNode(c, A);
    expect(s.chains()).toEqual(["1", "10", "137", "42161"]);
    s.removeNodes([id(A, "137")]);
    expect(s.chains()).toEqual(["1", "10", "42161"]);
    s.reset();
    expect(s.chains()).toEqual([]);
    s.loadSnapshot([{ chainId: "8453", address: a }, { chainId: "1", address: b }], []);
    expect(s.chains()).toEqual(["1", "8453"]);
  });

  test("checkInvariants catches cross-chain endpoints, key-prefix drift, id drift, bad chain ids", () => {
    const healthy = () => {
      const s = new GraphStore();
      for (const c of ["1", "56"]) { s.addNode(c, A); s.addNode(c, B); }
      s.addEdge(edgeInput(A, B, ethTx(), "1"));
      return s;
    };
    expect(healthy().checkInvariants()).toEqual({ ok: true, errors: [] });
    const corrupt = [
      (s) => { s.listEdges()[0].fromId = id(A, "56"); },  // edge joins chain 1 to a chain-56 node
      (s) => { const e = s.listEdges()[0]; s._edges.delete(e.key); s._edgeKeys.delete(e.key); e.key = "56|" + e.key.slice(2); s._edges.set(e.key, e); s._edgeKeys.add(e.key); },
      (s) => { s.getNode(id(A)).id = id(A, "56"); },
      (s) => { s.getNode(id(B, "56")).chainId = "bsc"; },
    ];
    for (const fn of corrupt) {
      const s = healthy();
      fn(s);
      expect(s.checkInvariants().ok).toBe(false);
    }
  });

  test("loadSnapshot recomputes ids and drops chain-mismatched records", () => {
    const s = new GraphStore();
    s.loadSnapshot(
      [{ chainId: "1", address: A, id: `56:${a}` }, { chainId: "1", address: B }, { chainId: "56", address: B }, { chainId: "bsc", address: C }, { address: C }],
      [
        { chainId: "1", key: "1|k1", from: A, to: B, fromId: `56:${a}` }, // kept, fromId recomputed
        { chainId: "56", key: "1|k2", from: B, to: B },                  // key prefix disagrees
        { chainId: "56", key: "56|k3", from: A, to: B },                 // A exists on chain 1 only
        { key: "1|k4", from: A, to: B },                                 // no chainId
      ],
    );
    expect(s.listNodes().map((n) => n.id).sort()).toEqual([`1:${a}`, `1:${b}`, `56:${b}`]);
    expect(s.listEdges().map((e) => [e.key, e.fromId, e.toId])).toEqual([["1|k1", `1:${a}`, `1:${b}`]]);
    expect(s.checkInvariants().ok).toBe(true);
  });
});
