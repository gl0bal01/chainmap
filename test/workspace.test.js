import { describe, expect, test } from "bun:test";
import { WORKSPACE_VERSION, parseWorkspace, serializeWorkspace } from "../src/workspace.js";

const A = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const B = "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb";
const a = A.toLowerCase();
const b = B.toLowerCase();

/** Minimal NodeRecord-shaped object, as store.listNodes() would return. */
function node(address, over = {}) {
  return { address, depth: 0, isRoot: false, alias: null, ...over };
}

/** Minimal EdgeRecord-shaped object, as store.listEdges() would return. */
function edge(from, to, over = {}) {
  return {
    key: `txlist|0xhash1|${from}|${to}||`,
    action: "txlist",
    group: "normal",
    color: "#fff",
    from,
    to,
    hash: "0xhash1",
    symbol: "ETH",
    tokenContract: "",
    tokenId: "",
    value: "1000000000000000000",
    amountText: "1",
    amountIndeterminate: false,
    timeStamp: "1700000000",
    blockNumber: "18000000",
    ...over,
  };
}

describe("WORKSPACE_VERSION", () => {
  test("is 2", () => {
    expect(WORKSPACE_VERSION).toBe(2);
  });
});

describe("serializeWorkspace", () => {
  test("wraps store data with version + defaults", () => {
    const nodes = [node(A, { depth: 0, isRoot: true }), node(B, { depth: 1 })];
    const edges = [edge(A, B)];

    const ws = serializeWorkspace({
      chainId: 1,
      root: A,
      nodes,
      edges,
      filters: { minAmount: 0.1, hideZero: true },
      layout: "force",
      annotations: [{ id: "note1", text: "hi" }],
    });

    expect(ws.version).toBe(WORKSPACE_VERSION);
    expect(ws.chainId).toBe(1);
    expect(ws.root).toBe(A);
    expect(ws.nodes).toEqual(nodes);
    expect(ws.edges).toEqual(edges);
    expect(ws.filters).toEqual({ minAmount: 0.1, hideZero: true });
    expect(ws.layout).toBe("force");
    expect(ws.annotations).toEqual([{ id: "note1", text: "hi" }]);

    // shallow copies, not the same references
    expect(ws.nodes).not.toBe(nodes);
    expect(ws.nodes[0]).not.toBe(nodes[0]);
    expect(ws.edges).not.toBe(edges);
  });

  test("missing optional inputs default sensibly", () => {
    const ws = serializeWorkspace({ nodes: [], edges: [] });
    expect(ws.filters).toEqual({});
    expect(ws.annotations).toEqual([]);
    expect(ws.layout).toBeNull();
    expect(ws.chainId).toBeNull();
    expect(ws.root).toBeNull();
  });

  test("tolerates fully empty input", () => {
    const ws = serializeWorkspace({});
    expect(ws.nodes).toEqual([]);
    expect(ws.edges).toEqual([]);
    expect(ws.filters).toEqual({});
    expect(ws.annotations).toEqual([]);
  });
});

describe("parseWorkspace round-trip", () => {
  test("serialize then parse yields ok:true with matching sanitized data", () => {
    const nodes = [node(a, { depth: 0, isRoot: true, alias: "root" }), node(b, { depth: 1 })];
    const edges = [edge(a, b)];
    const filters = { minAmount: 1, hideZero: false, hideSpam: true, bundle: false, minTime: "100", maxTime: "200" };
    const annotations = [{ id: "n1", text: "note" }];

    const ws = serializeWorkspace({ chainId: 1, root: a, nodes, edges, filters, layout: "force", annotations });
    const result = parseWorkspace(ws);

    expect(result.ok).toBe(true);
    expect(result.data.version).toBe(WORKSPACE_VERSION);
    expect(result.data.chainId).toBe(1);
    expect(result.data.root).toBe(a);
    expect(result.data.nodes).toEqual(nodes);
    expect(result.data.edges).toEqual(edges);
    expect(result.data.filters).toEqual(filters);
    expect(result.data.layout).toBe("force");
    expect(result.data.annotations).toEqual(annotations);
  });

  test("accepts a JSON string, not just an object", () => {
    const ws = serializeWorkspace({ nodes: [node(a)], edges: [] });
    const result = parseWorkspace(JSON.stringify(ws));

    expect(result.ok).toBe(true);
    expect(result.data.nodes).toEqual([node(a)]);
  });
});

describe("parseWorkspace rejects bad input", () => {
  test("null", () => {
    const result = parseWorkspace(null);
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
  });

  test("non-object (number)", () => {
    expect(parseWorkspace(42).ok).toBe(false);
  });

  test("non-object (array)", () => {
    expect(parseWorkspace([1, 2, 3]).ok).toBe(false);
  });

  test("malformed JSON string", () => {
    const result = parseWorkspace("{not valid json");
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
  });

  test("missing nodes array", () => {
    expect(parseWorkspace({ edges: [] }).ok).toBe(false);
  });

  test("missing edges array", () => {
    expect(parseWorkspace({ nodes: [] }).ok).toBe(false);
  });

  test("nodes/edges present but not arrays", () => {
    expect(parseWorkspace({ nodes: {}, edges: {} }).ok).toBe(false);
  });

  test("never throws on garbage input", () => {
    expect(() => parseWorkspace(undefined)).not.toThrow();
    expect(() => parseWorkspace(Symbol("x"))).not.toThrow();
    expect(parseWorkspace(undefined).ok).toBe(false);
  });
});

describe("parseWorkspace sanitization", () => {
  test("uppercase addresses are lowercased on nodes and edges", () => {
    const result = parseWorkspace({
      nodes: [node(A, { depth: 0, isRoot: true })],
      edges: [edge(A, B, { tokenContract: A })],
    });

    expect(result.ok).toBe(true);
    expect(result.data.nodes[0].address).toBe(a);
    expect(result.data.edges[0].from).toBe(a);
    expect(result.data.edges[0].to).toBe(b);
    expect(result.data.edges[0].tokenContract).toBe(a);
  });

  test("malformed node (invalid address) is dropped", () => {
    const result = parseWorkspace({
      nodes: [node("not-an-address"), node(a)],
      edges: [],
    });

    expect(result.ok).toBe(true);
    expect(result.data.nodes).toHaveLength(1);
    expect(result.data.nodes[0].address).toBe(a);
  });

  test("node missing address entirely is dropped", () => {
    const result = parseWorkspace({ nodes: [{ depth: 1 }], edges: [] });
    expect(result.ok).toBe(true);
    expect(result.data.nodes).toEqual([]);
  });

  test("edge missing from/to/key is dropped", () => {
    const result = parseWorkspace({
      nodes: [node(a), node(b)],
      edges: [
        { key: "k1", from: a, to: b }, // valid
        { key: "", from: a, to: b }, // missing key
        { key: "k2", from: "bad", to: b }, // invalid from
        { key: "k3", from: a }, // missing to
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.data.edges).toHaveLength(1);
    expect(result.data.edges[0].key).toBe("k1");
  });

  test("depth is coerced to a number, non-finite falls back to 0", () => {
    const result = parseWorkspace({
      nodes: [node(a, { depth: "3" }), node(b, { depth: "not-a-number" })],
      edges: [],
    });

    expect(result.ok).toBe(true);
    const byAddr = Object.fromEntries(result.data.nodes.map((n) => [n.address, n]));
    expect(byAddr[a].depth).toBe(3);
    expect(byAddr[b].depth).toBe(0);
  });

  test("filters/annotations default to {}/[] when absent or malformed", () => {
    const result = parseWorkspace({ nodes: [], edges: [], filters: null, annotations: "nope" });
    expect(result.ok).toBe(true);
    expect(result.data.filters).toEqual({});
    expect(result.data.annotations).toEqual([]);
  });

  test("empty alias string is normalized to null", () => {
    const result = parseWorkspace({ nodes: [node(a, { alias: "" })], edges: [] });
    expect(result.ok).toBe(true);
    expect(result.data.nodes[0].alias).toBeNull();
  });
});
