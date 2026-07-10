import { describe, test, expect } from "bun:test";
import { GraphStore } from "../src/graphStore.js";

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
function edgeInput(from, to, tx) {
  return { action: "txlist", group: "normal", color: "#fff", from, to, tx: tx || ethTx() };
}

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
    const node = store.addNode(A, { depth: 2, isRoot: false });

    expect(node.address).toBe(a);
    expect(node.depth).toBe(2);
    expect(node.isRoot).toBe(false);
    expect(node.alias).toBeNull();
    expect(store.hasNode(A)).toBe(true);
    expect(store.hasNode(a)).toBe(true);
    expect(events).toEqual([{ type: "node:add", node }]);
  });

  test("merge keeps the MINIMUM depth and emits node:update only when changed", () => {
    const store = new GraphStore();
    store.addNode(A, { depth: 5 });
    const { events } = recorder(store);

    // Lower depth -> update.
    store.addNode(A, { depth: 2 });
    expect(store.getNode(A).depth).toBe(2);

    // Higher depth -> no change, no event.
    store.addNode(A, { depth: 9 });
    expect(store.getNode(A).depth).toBe(2);

    // Equal depth -> no change, no event.
    store.addNode(A, { depth: 2 });
    expect(store.getNode(A).depth).toBe(2);

    expect(events).toEqual([{ type: "node:update", node: store.getNode(A) }]);
    expect(store.stats().nodes).toBe(1);
  });

  test("isRoot is sticky: once true it stays true and never flips back", () => {
    const store = new GraphStore();
    store.addNode(A, { depth: 0, isRoot: true });
    // Re-add without isRoot (and without depth change) -> no event, still root.
    const { events } = recorder(store);
    store.addNode(A, { isRoot: false });
    expect(store.getNode(A).isRoot).toBe(true);
    expect(events).toEqual([]);
  });

  test("merge can raise isRoot from false to true and emits update", () => {
    const store = new GraphStore();
    store.addNode(A, { depth: 3, isRoot: false });
    const { events } = recorder(store);
    store.addNode(A, { isRoot: true });
    expect(store.getNode(A).isRoot).toBe(true);
    expect(events).toEqual([{ type: "node:update", node: store.getNode(A) }]);
  });

  test("depth defaults to 0 when omitted on a new node", () => {
    const store = new GraphStore();
    const node = store.addNode(A);
    expect(node.depth).toBe(0);
    expect(node.isRoot).toBe(false);
  });
});

describe("GraphStore.addEdge", () => {
  test("first insert builds a full EdgeRecord and emits edge:add", () => {
    const store = new GraphStore();
    store.addNode(A);
    store.addNode(B);
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
    expect(edge.hash).toBe("0xhash1");
    expect(store.hasEdgeKey(edge.key)).toBe(true);
    expect(events).toEqual([{ type: "edge:add", edge }]);
    expect(store.stats().edges).toBe(1);
  });

  test("duplicate key returns null and emits no event", () => {
    const store = new GraphStore();
    store.addNode(A);
    store.addNode(B);
    store.addEdge(edgeInput(A, B));
    const { events } = recorder(store);

    const dup = store.addEdge(edgeInput(A, B)); // identical action/hash/from/to
    expect(dup).toBeNull();
    expect(events).toEqual([]);
    expect(store.stats().edges).toBe(1);
  });

  test("token symbol / contract / tokenId and indeterminate amount flow through", () => {
    const store = new GraphStore();
    store.addNode(A);
    store.addNode(B);
    const tx = ethTx({
      hash: "0xtoken",
      value: "5000000",
      tokenSymbol: "USDC",
      contractAddress: "0xA0b86991c6218B36C1D19d4A2E9EB0CE3606EB48",
      tokenDecimal: "6",
    });
    const edge = store.addEdge({ action: "tokentx", group: "token", color: "#0f0", from: A, to: B, tx });
    expect(edge.symbol).toBe("USDC");
    expect(edge.tokenContract).toBe("0xA0b86991c6218B36C1D19d4A2E9EB0CE3606EB48");
    expect(edge.amountText).toBe("5"); // 5000000 / 1e6
    expect(edge.amountIndeterminate).toBe(false);

    // Bad decimals -> honest indeterminate with raw integer text.
    store.addNode(C);
    const badTx = ethTx({ hash: "0xbad", value: "123", tokenDecimal: "" });
    const badEdge = store.addEdge({ action: "tokentx", group: "token", color: "#0f0", from: B, to: C, tx: badTx });
    expect(badEdge.amountIndeterminate).toBe(true);
    expect(badEdge.amountText).toBe("123");
  });

  test("same hash but different contract stays distinct (not deduped)", () => {
    const store = new GraphStore();
    store.addNode(A);
    store.addNode(B);
    const t1 = ethTx({ hash: "0xshared", contractAddress: "0x1111111111111111111111111111111111111111", tokenID: "" });
    const t2 = ethTx({ hash: "0xshared", contractAddress: "0x2222222222222222222222222222222222222222", tokenID: "" });
    const e1 = store.addEdge({ action: "tokentx", group: "token", color: "#0f0", from: A, to: B, tx: t1 });
    const e2 = store.addEdge({ action: "tokentx", group: "token", color: "#0f0", from: A, to: B, tx: t2 });
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
});

describe("GraphStore.setAlias", () => {
  test("sets an alias on an existing node and emits alias:set", () => {
    const store = new GraphStore();
    store.addNode(A);
    const { events } = recorder(store);
    store.setAlias(A, "Exchange");
    expect(store.getAlias(A)).toBe("Exchange");
    expect(events).toEqual([{ type: "alias:set", address: a, alias: "Exchange" }]);
  });

  test("empty string and null both clear the alias", () => {
    const store = new GraphStore();
    store.addNode(A);
    store.setAlias(A, "Label");

    store.setAlias(A, "");
    expect(store.getAlias(A)).toBeNull();

    store.setAlias(A, "Label2");
    store.setAlias(A, null);
    expect(store.getAlias(A)).toBeNull();
  });

  test("no-op when node absent (no event, alias stays null)", () => {
    const store = new GraphStore();
    const { events } = recorder(store);
    store.setAlias(A, "ghost");
    expect(events).toEqual([]);
    expect(store.getAlias(A)).toBeNull();
  });
});

describe("GraphStore.removeNodes", () => {
  test("cascade removes connected edges, updates counts, drops alias", () => {
    const store = new GraphStore();
    store.addNode(A, { isRoot: true });
    store.addNode(B);
    store.addNode(C);
    store.setAlias(B, "Middle");
    // A->B, B->C, and A->C so B has two connected edges.
    store.addEdge(edgeInput(A, B, ethTx({ hash: "0xab" })));
    store.addEdge(edgeInput(B, C, ethTx({ hash: "0xbc" })));
    store.addEdge(edgeInput(A, C, ethTx({ hash: "0xac" })));
    expect(store.stats()).toEqual({ nodes: 3, edges: 3 });

    const { events } = recorder(store);
    const result = store.removeNodes([B]);

    expect(result).toEqual({ removedNodes: 1, removedEdges: 2 });
    expect(store.hasNode(B)).toBe(false);
    expect(store.getAlias(B)).toBeNull();
    expect(store.stats()).toEqual({ nodes: 2, edges: 1 }); // only A->C survives

    const removeEvents = events.filter((e) => e.type === "edge:remove");
    const nodeEvents = events.filter((e) => e.type === "node:remove");
    expect(removeEvents.length).toBe(2);
    expect(nodeEvents).toEqual([{ type: "node:remove", address: b }]);
    // edges removed before the node.
    expect(events[events.length - 1]).toEqual({ type: "node:remove", address: b });
    // surviving edge key still present & parity intact.
    expect(store.checkInvariants().ok).toBe(true);
  });

  test("skips unknown addresses without events", () => {
    const store = new GraphStore();
    store.addNode(A);
    const { events } = recorder(store);
    const result = store.removeNodes([C]); // not present
    expect(result).toEqual({ removedNodes: 0, removedEdges: 0 });
    expect(events).toEqual([]);
  });
});

describe("GraphStore.reset", () => {
  test("clears all structures and emits a single reset", () => {
    const store = new GraphStore();
    store.addNode(A);
    store.addNode(B);
    store.addEdge(edgeInput(A, B));
    store.setAlias(A, "x");

    const { events } = recorder(store);
    store.reset();

    expect(store.stats()).toEqual({ nodes: 0, edges: 0 });
    expect(store.listNodes()).toEqual([]);
    expect(store.listEdges()).toEqual([]);
    expect(store.hasNode(A)).toBe(false);
    expect(events).toEqual([{ type: "reset" }]);
  });
});

describe("GraphStore.subscribe", () => {
  test("delivers events synchronously and unsubscribe stops delivery", () => {
    const store = new GraphStore();
    const seen = [];
    const unsub = store.subscribe((e) => seen.push(e.type));

    store.addNode(A);
    expect(seen).toEqual(["node:add"]); // synchronous

    unsub();
    store.addNode(B);
    expect(seen).toEqual(["node:add"]); // no further delivery
  });

  test("multiple subscribers each receive events", () => {
    const store = new GraphStore();
    const s1 = [];
    const s2 = [];
    store.subscribe((e) => s1.push(e.type));
    store.subscribe((e) => s2.push(e.type));
    store.addNode(A);
    expect(s1).toEqual(["node:add"]);
    expect(s2).toEqual(["node:add"]);
  });
});

describe("GraphStore.checkInvariants", () => {
  test("ok === true after a realistic add/alias/remove sequence", () => {
    const store = new GraphStore();
    store.addNode(A, { depth: 0, isRoot: true });
    store.addNode(B, { depth: 1 });
    store.addNode(C, { depth: 1 });
    store.addEdge(edgeInput(A, B, ethTx({ hash: "0x1" })));
    store.addEdge(edgeInput(A, C, ethTx({ hash: "0x2" })));
    store.addEdge(edgeInput(B, C, ethTx({ hash: "0x3" })));
    store.setAlias(A, "Root");
    store.removeNodes([C]);

    const inv = store.checkInvariants();
    expect(inv.errors).toEqual([]);
    expect(inv.ok).toBe(true);
  });

  test("detects a dangling edge (endpoint node missing)", () => {
    const store = new GraphStore();
    store.addNode(A);
    store.addNode(B);
    store.addEdge(edgeInput(A, B));
    // Corrupt internal state directly: drop node B but leave the edge.
    store._nodes.delete(b);
    const inv = store.checkInvariants();
    expect(inv.ok).toBe(false);
    expect(inv.errors.some((e) => e.includes(b))).toBe(true);
  });

  test("detects edgeKeys <-> edges parity break", () => {
    const store = new GraphStore();
    store.addNode(A);
    store.addNode(B);
    store.addEdge(edgeInput(A, B));
    // Corrupt parity: remove the edge but keep the key.
    const [key] = [...store._edgeKeys];
    store._edges.delete(key);
    const inv = store.checkInvariants();
    expect(inv.ok).toBe(false);
    expect(inv.errors.some((e) => e.toLowerCase().includes("parity") || e.includes(key))).toBe(true);
  });
});
