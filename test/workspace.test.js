import { describe, expect, test } from "bun:test";
import { GraphStore } from "../src/graphStore.js";
import { WORKSPACE_VERSION, parseWorkspace, serializeWorkspace } from "../src/workspace.js";
import { queryUrl } from "../src/queryLog.js";

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

describe("serializeWorkspace", () => {
  test("wraps store data with version + defaults", () => {
    const nodes = [node(A, { depth: 0, isRoot: true }), node(B, { depth: 1 })];
    const edges = [edge(A, B)];

    const ws = serializeWorkspace({
      root: A,
      nodes,
      edges,
      filters: { minAmount: 0.1, hideZero: true },
      layout: "force",
      annotations: [{ id: "note1", text: "hi" }],
    });

    expect(ws.version).toBe(WORKSPACE_VERSION);
    expect(ws.root).toBe(A);
    expect(ws.graph.nodes).toEqual(nodes);
    expect(ws.graph.edges).toEqual(edges);
    expect(ws.filters).toEqual({ minAmount: 0.1, hideZero: true });
    expect(ws.layout).toBe("force");
    expect(ws.annotations).toEqual([{ id: "note1", text: "hi" }]);

    // shallow copies, not the same references
    expect(ws.graph.nodes).not.toBe(nodes);
    expect(ws.graph.nodes[0]).not.toBe(nodes[0]);
    expect(ws.graph.edges).not.toBe(edges);
  });

  test("missing optional inputs default sensibly", () => {
    const ws = serializeWorkspace({ nodes: [], edges: [] });
    expect(ws.filters).toEqual({});
    expect(ws.annotations).toEqual([]);
    expect(ws.layout).toBeNull();
    expect("chainId" in ws).toBe(false);
    expect(ws.root).toBeNull();
  });

  test("tolerates fully empty input", () => {
    const ws = serializeWorkspace({});
    expect(ws.graph).toEqual({ nodes: [], edges: [] });
    expect(ws.filters).toEqual({});
    expect(ws.annotations).toEqual([]);
  });
});

describe("parseWorkspace round-trip", () => {
  test("serialize then parse yields ok:true with matching sanitized data", () => {
    const nodes = [node(a, { chainId: "1", depth: 0, isRoot: true, alias: "root" }), node(b, { chainId: "1", depth: 1 })];
    const edges = [edge(a, b, { chainId: "1", key: `1|${edge(a, b).key}` })];
    const filters = { minAmount: 1, hideZero: false, hideSpam: true, bundle: false, minTime: "100", maxTime: "200" };
    const annotations = [{ id: "n1", text: "note" }];

    const ws = serializeWorkspace({ root: a, nodes, edges, filters, layout: "force", annotations });
    const result = parseWorkspace(ws);

    expect(result.ok).toBe(true);
    expect(result.data.version).toBe(WORKSPACE_VERSION);
    expect(result.data.assumedChainId).toBeNull();
    expect(result.data.root).toBe(a);
    expect(result.data.nodes).toEqual(nodes);
    expect(result.data.edges).toEqual(edges);
    expect(result.data.filters).toEqual(filters);
    expect(result.data.layout).toBe("force");
    expect(result.data.annotations).toEqual(annotations);
  });

  test("accepts a JSON string, not just an object", () => {
    const ws = serializeWorkspace({ nodes: [node(a, { chainId: "1" })], edges: [] });
    const result = parseWorkspace(JSON.stringify(ws));

    expect(result.ok).toBe(true);
    expect(result.data.nodes).toEqual([node(a, { chainId: "1" })]);
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
      chainId: "1",
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
      chainId: "1",
      nodes: [node("not-an-address"), node(a)],
      edges: [],
    });

    expect(result.ok).toBe(true);
    expect(result.data.nodes).toHaveLength(1);
    expect(result.data.nodes[0].address).toBe(a);
  });

  test("node missing address entirely is dropped", () => {
    const result = parseWorkspace({ chainId: "1", nodes: [{ depth: 1 }], edges: [] });
    expect(result.ok).toBe(true);
    expect(result.data.nodes).toEqual([]);
  });

  test("edge missing from/to/key is dropped", () => {
    const result = parseWorkspace({
      chainId: "1",
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
    expect(result.data.edges[0].key).toBe("1|k1"); // v2 key prefixed with the file chain
  });

  test("depth is coerced to a number, non-finite falls back to 0", () => {
    const result = parseWorkspace({
      chainId: "1",
      nodes: [node(a, { depth: "3" }), node(b, { depth: "not-a-number" })],
      edges: [],
    });

    expect(result.ok).toBe(true);
    const byAddr = Object.fromEntries(result.data.nodes.map((n) => [n.address, n]));
    expect(byAddr[a].depth).toBe(3);
    expect(byAddr[b].depth).toBe(0);
  });

  test("filters/annotations default to {}/[] when absent or malformed", () => {
    const result = parseWorkspace({ chainId: "1", nodes: [], edges: [], filters: null, annotations: "nope" });
    expect(result.ok).toBe(true);
    expect(result.data.filters).toEqual({});
    expect(result.data.annotations).toEqual([]);
  });

  test("empty alias string is normalized to null", () => {
    const result = parseWorkspace({ chainId: "1", nodes: [node(a, { alias: "" })], edges: [] });
    expect(result.ok).toBe(true);
    expect(result.data.nodes[0].alias).toBeNull();
  });

  // CWE-1321: a crafted workspace must not smuggle __proto__/constructor/prototype
  // keys onto sanitized records, and must never mutate Object.prototype.
  test("strips prototype-polluting keys from nodes and edges", () => {
    const raw = JSON.parse(
      `{"chainId":"1","nodes":[{"address":"${a}","depth":0,"__proto__":{"polluted":1},"constructor":"x"}],` +
        `"edges":[{"key":"k1","from":"${a}","to":"${b}","__proto__":{"polluted":1},"prototype":"y"}]}`
    );
    // second node so the edge endpoints both exist
    raw.nodes.push({ address: b, depth: 1 });

    const result = parseWorkspace(raw);
    expect(result.ok).toBe(true);
    expect({}.polluted).toBeUndefined(); // Object.prototype untouched

    const n0 = result.data.nodes[0];
    const e0 = result.data.edges[0];
    expect(Object.prototype.hasOwnProperty.call(n0, "constructor")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(n0, "__proto__")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(e0, "prototype")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(e0, "__proto__")).toBe(false);
    // legitimate fields still round-trip
    expect(n0.address).toBe(a);
    expect(e0.key).toBe("1|k1");
  });
});

describe("history persistence", () => {
  test("history survives serialize -> parse -> loadSnapshot", () => {
    const entry = { oldestBlock: "800", blockPage: 0, pageSize: 0, done: false, count: 3 };
    const s = new GraphStore();
    s.addNode("1", a, { depth: 0, isRoot: true });
    s.addNode("1", b, { depth: 1 });
    s.setHistory(`1:${b}`, "txlist", entry);
    const ws = serializeWorkspace({ root: a, nodes: s.listNodes(), edges: s.listEdges() });
    const res = parseWorkspace(JSON.stringify(ws));
    expect(res.ok).toBe(true);
    const r = new GraphStore();
    r.loadSnapshot(res.data.nodes, res.data.edges);
    expect(r.getNode(`1:${b}`).history.txlist).toEqual(entry);
  });
});

import V2 from "./fixtures/workspace-v2.json";
const v3node = (chainId, address, over = {}) => ({ chainId, ...node(address, over) });
const v3edge = (chainId, from, to, over = {}) => { const e = edge(from, to, over); return { ...e, chainId, key: `${chainId}|${e.key}` }; };
const entry = { oldestBlock: "800", blockPage: 0, pageSize: 0, done: false, count: 3 };

describe("workspace v3 + v2 migration", () => {
  test("version 3; serialize nests the graph and writes no top-level chainId/nodes/edges", () => {
    const ws = serializeWorkspace({ chainId: "1", root: a, nodes: [v3node("1", a)], edges: [], filters: {}, layout: "force", annotations: [] });
    expect(WORKSPACE_VERSION).toBe(3);
    expect(ws.version).toBe(3);
    expect(ws.graph).toEqual({ nodes: [v3node("1", a)], edges: [] });
    expect(["chainId", "nodes", "edges"].some((k) => k in ws)).toBe(false);
  });

  test("v2 migrates: the file chain is stamped on every record, keys are prefixed, history kept", () => {
    const res = parseWorkspace({ version: 2, chainId: 56, nodes: [node(a, { history: { txlist: entry } }), node(b)], edges: [edge(a, b)] });
    expect(res.ok).toBe(true);
    expect(res.data.assumedChainId).toBeNull();
    expect(res.data.nodes.map((n) => n.chainId)).toEqual(["56", "56"]);
    expect(res.data.edges[0]).toMatchObject({ chainId: "56", key: "56|" + edge(a, b).key });
    const s = new GraphStore();
    s.loadSnapshot(res.data.nodes, res.data.edges);
    expect(s.getNode(`56:${a}`).history.txlist).toEqual(entry);
    expect(s.stats()).toEqual({ nodes: 2, edges: 1 });
  });

  test("a v2 file can never produce mixed chains: per-record chainId is ignored", () => {
    const res = parseWorkspace({ chainId: "56", nodes: [node(a, { chainId: "1" }), node(b, { chainId: "137" })], edges: [edge(a, b, { chainId: "137" })] });
    const s = new GraphStore();
    s.loadSnapshot(res.data.nodes, res.data.edges);
    expect(s.chains()).toEqual(["56"]);
    expect(s.stats()).toEqual({ nodes: 2, edges: 1 });
  });

  test("v2 without chainId uses the fallback and reports it; with no fallback it is refused", () => {
    const raw = { nodes: [node(a)], edges: [] };
    expect(parseWorkspace(raw, { fallbackChainId: "137" }).data).toMatchObject({ assumedChainId: "137", nodes: [{ chainId: "137" }] });
    expect(parseWorkspace(raw).ok).toBe(false);
  });

  test("v2 with a non-decimal chainId is refused", () => {
    for (const chainId of ["eth", "1.5", "-1", "0x1"]) expect(parseWorkspace({ chainId, nodes: [], edges: [] }).ok).toBe(false);
  });

  test("the real v2 fixture (former demo) migrates with every edge kept", () => {
    const res = parseWorkspace(JSON.stringify(V2));
    const s = new GraphStore();
    s.loadSnapshot(res.data.nodes, res.data.edges);
    expect(s.stats().edges).toBe(V2.edges.length);
    expect(s.chains()).toEqual(["1"]);
    expect(s.listEdges().every((e) => e.key.startsWith("1|"))).toBe(true);
    expect(s.checkInvariants().ok).toBe(true);
  });

  test("v3 multi-chain round trip keeps twins, annotations, layout and filters", () => {
    const s = new GraphStore();
    s.addNode("1", a, { isRoot: true });
    s.addNode("8453", a, { isRoot: true });
    s.addNode("8453", b, { depth: 1 });
    s.addEdge({ chainId: "8453", action: "txlist", group: "normal", color: "#fff", from: a, to: b, tx: { hash: "0x9", value: "1" } });
    const ws = serializeWorkspace({ root: a, nodes: s.listNodes(), edges: s.listEdges(), filters: { hideZero: true }, layout: "hierarchical", annotations: [{ text: "n", x: 1, y: 2 }] });
    const res = parseWorkspace(JSON.stringify(ws));
    const r = new GraphStore();
    r.loadSnapshot(res.data.nodes, res.data.edges);
    expect(r.listNodes().map((n) => n.id).sort()).toEqual([`1:${a}`, `8453:${a}`, `8453:${b}`]);
    expect(r.stats().edges).toBe(1);
    expect(r.checkInvariants().ok).toBe(true);
    expect(res.data).toMatchObject({ layout: "hierarchical", filters: { hideZero: true }, annotations: [{ text: "n", x: 1, y: 2 }], assumedChainId: null });
  });

  test("v3 drops a bad chainId, a key prefix that disagrees, and endpoints missing on that chain", () => {
    const res = parseWorkspace({ version: 3, graph: {
      nodes: [v3node("1", a), v3node("1", b), v3node("8453", a), { ...node(b), chainId: "eth" }, node(b)],
      edges: [
        v3edge("1", a, b),
        { ...v3edge("1", a, b, { hash: "0x2" }), key: "8453|x" },
        v3edge("8453", a, b, { hash: "0x3" }),
        { ...v3edge("1", a, b, { hash: "0x4" }), chainId: "x" },
      ] } });
    expect(res.data.nodes.length).toBe(3);
    expect(res.data.edges.map((e) => e.hash)).toEqual(["0xhash1"]);
  });

  test("a newer version is refused with a localized key; v3 without graph arrays is refused", () => {
    expect(parseWorkspace({ version: 4, graph: { nodes: [], edges: [] } })).toMatchObject({ ok: false, errorKey: "error.workspaceTooNew" });
    expect(parseWorkspace({ version: 3, nodes: [], edges: [] }).ok).toBe(false);
  });

  test("version gate: a present version must be an integer 1..2 or exactly 3; absent still migrates as v2", () => {
    const g = { nodes: [], edges: [] };
    for (const version of ["4", "3", "2", 2.5, -1, 0, null, true, NaN, Infinity]) {
      const res = parseWorkspace({ version, chainId: "1", ...g, graph: g });
      expect(res.ok, `version ${String(version)}`).toBe(false);
      expect(res.errorKey).toBeUndefined(); // invalid, not "newer"
    }
    expect(parseWorkspace({ version: 7, graph: g })).toMatchObject({ ok: false, errorKey: "error.workspaceTooNew" });
    for (const version of [1, 2]) expect(parseWorkspace({ version, chainId: "1", ...g }).ok).toBe(true);
    expect(parseWorkspace({ version: 3, graph: g }).ok).toBe(true);
    expect(parseWorkspace({ chainId: "1", ...g }).ok).toBe(true);
  });

  test("untrusted id/fromId/toId never leave parseWorkspace (v2 and v3)", () => {
    const lie = { id: "56:" + b, fromId: "56:" + b, toId: "56:" + a };
    const v2 = parseWorkspace({ version: 2, chainId: "1", nodes: [node(a, lie), node(b, lie)], edges: [edge(a, b, lie)] });
    const v3 = parseWorkspace({ version: 3, graph: { nodes: [v3node("1", a, lie), v3node("1", b, lie)], edges: [v3edge("1", a, b, lie)] } });
    for (const res of [v2, v3]) {
      expect(res.data.nodes.length).toBe(2);
      expect(res.data.edges.length).toBe(1);
      for (const r of [...res.data.nodes, ...res.data.edges]) {
        expect(["id", "fromId", "toId"].filter((k) => Object.hasOwn(r, k))).toEqual([]);
      }
    }
  });
});

test("filters.hiddenChains keeps decimal chain ids only", () => {
  const f = (hiddenChains) => parseWorkspace({ chainId: "1", nodes: [], edges: [], filters: { hiddenChains } }).data.filters;
  expect(f(["1", 42161, "eth", null]).hiddenChains).toEqual(["1", "42161"]);
  expect("hiddenChains" in f("1")).toBe(false);
});

test("filters.showTwins is kept only as a boolean", () => {
  const f = (showTwins) => parseWorkspace({ chainId: "1", nodes: [], edges: [], filters: { showTwins } }).data.filters;
  expect(f(false).showTwins).toBe(false);
  expect("showTwins" in f("yes")).toBe(false);
});

describe("workspace query log + provenance (v3, optional fields)", () => {
  const entry = (over = {}) => {
    const params = { chainid: "1", module: "account", action: "txlist", address: a, page: "1", offset: "10", sort: "desc" };
    return {
      at: "2026-11-16T10:00:00.000Z", chainId: "1", action: "txlist", params,
      url: queryUrl(params), httpStatus: 200, rows: 3, sha256: "a".repeat(64), outcome: "ok",
      ...over,
    };
  };
  const state = { entries: [entry(), entry({ at: "2026-11-16T10:00:01.000Z", rows: 0 })], dropped: 0, unloggedData: false };

  test("serialize writes queryLog + provenance after annotations", () => {
    const ws = serializeWorkspace({
      nodes: [], edges: [], queryLog: state,
      provenance: { savedAt: "2026-11-16T10:05:00.000Z", appVersion: "1.3.0", caveats: ["sampled"] },
    });
    expect(Object.keys(ws)).toEqual(["version", "root", "graph", "filters", "layout", "annotations", "queryLog", "savedAt", "appVersion", "caveats"]);
    expect(ws.version).toBe(3);
    expect(ws.queryLog).toEqual(state);
    expect(ws.savedAt).toBe("2026-11-16T10:05:00.000Z");
    expect(ws.appVersion).toBe("1.3.0");
    expect(ws.caveats).toEqual(["sampled"]);
  });

  test("without queryLog or provenance the output keeps today's six keys", () => {
    const ws = serializeWorkspace({ nodes: [], edges: [] });
    expect(Object.keys(ws)).toEqual(["version", "root", "graph", "filters", "layout", "annotations"]);
  });

  test("queryLog round-trips through JSON", () => {
    const r = parseWorkspace(JSON.stringify(serializeWorkspace({ nodes: [], edges: [], queryLog: state })));
    expect(r.ok).toBe(true);
    expect(r.data.queryLog).toEqual(state);
    expect(r.data.queryLogInvalid).toBe(0);
  });

  test("a v3 file without queryLog parses to queryLog null", () => {
    const r = parseWorkspace({ version: 3, graph: { nodes: [], edges: [] } });
    expect(r.ok).toBe(true);
    expect(r.data.queryLog).toBeNull();
    expect(r.data.queryLogInvalid).toBe(0);
  });

  test("invalid query-log entries are dropped and counted; forged fields never survive", () => {
    const bad = entry({ url: "https://evil.example", outcome: "pwned" });
    const r = parseWorkspace({
      version: 3, graph: { nodes: [], edges: [] },
      queryLog: { entries: [entry(), bad, entry({ at: "2026-11-16T10:00:02Z" })], dropped: 0, unloggedData: false },
    });
    expect(r.ok).toBe(true);
    expect(r.data.queryLog.entries).toHaveLength(2);
    expect(r.data.queryLogInvalid).toBe(1);
    expect(r.data.queryLog.unloggedData).toBe(true);
    expect("invalid" in r.data.queryLog).toBe(false);
    expect(r.data.queryLog.entries.some((e) => e.url.includes("evil"))).toBe(false);
  });

  test("unloggedData with zero entries round-trips; savedAt/appVersion/caveats never reach data; nodes and edges unchanged", () => {
    const node1 = node(a, { chainId: "1", isRoot: true });
    const ws = serializeWorkspace({
      nodes: [node1], edges: [],
      queryLog: { entries: [], dropped: 0, unloggedData: true },
      provenance: { savedAt: "2026-11-16T10:05:00.000Z", appVersion: "1.3.0", caveats: [] },
    });
    const r = parseWorkspace(JSON.stringify(ws));
    expect(r.ok).toBe(true);
    expect(r.data.queryLog).toEqual({ entries: [], dropped: 0, unloggedData: true });
    for (const k of ["savedAt", "appVersion", "caveats"]) expect(k in r.data).toBe(false);
    const plain = parseWorkspace(JSON.stringify(serializeWorkspace({ nodes: [node1], edges: [] })));
    expect(r.data.nodes).toEqual(plain.data.nodes);
    expect(r.data.edges).toEqual(plain.data.edges);
  });
});
