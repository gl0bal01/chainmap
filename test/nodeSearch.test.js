import { describe, test, expect } from "bun:test";
import { searchGraph } from "../src/nodeSearch.js";

function nodeRec(over) {
  return { kind: "node", id: "0x1", title: "t", subtitle: "s", text: [], hex: [], ...over };
}
function edgeRec(over) {
  return { kind: "edge", id: "e1", title: "t", subtitle: "s", text: [], hex: [], ...over };
}

describe("searchGraph", () => {
  test("empty query returns []", () => {
    expect(searchGraph("", [nodeRec()])).toEqual([]);
  });

  test("whitespace-only query returns []", () => {
    expect(searchGraph("   ", [nodeRec()])).toEqual([]);
  });

  test("exact address hex prefix hit ranks first (600-tier)", () => {
    const target = edgeRec({ id: "0xdac", title: "USDT", hex: ["0xdac17f958d2ee523a2206206994597c13d831ec7"] });
    const other = edgeRec({ id: "0xzzz", title: "Zebra", hex: ["0x" + "z".repeat(40)] });
    const results = searchGraph("0xdac17", [other, target]);
    expect(results[0].record).toBe(target);
    expect(results[0].score).toBe(600);
  });

  test("exact hex match scores 1000", () => {
    const addr = "0x" + "a1".repeat(20);
    const rec = edgeRec({ hex: [addr] });
    const results = searchGraph(addr, [rec]);
    expect(results[0].score).toBe(1000);
  });

  test("label fuzzy subsequence match scores > 0", () => {
    const rec = nodeRec({ title: "Binance 14", text: ["binance 14"] });
    const results = searchGraph("bnance", [rec]);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBeGreaterThan(0);
  });

  test("exact/prefix label beats fuzzy for its own query (500-tier prefix)", () => {
    const rec = edgeRec({ title: "Binance 14", text: ["binance 14"] });
    const results = searchGraph("binance", [rec]);
    expect(results[0].score).toBe(500);
  });

  test("ranking: an exact-label record outranks a fuzzy-only record for the same query", () => {
    const exact = nodeRec({ id: "0xexact", title: "Binance 14", text: ["binance 14"] });
    const fuzzy = nodeRec({ id: "0xfuzzy", title: "B N Ace Xtra", text: ["b n ace xtra"] });
    const results = searchGraph("binance", [fuzzy, exact]);
    expect(results[0].record).toBe(exact);
  });

  test("tx hash substring (middle slice) matches (300-tier)", () => {
    const hash = "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567";
    const rec = edgeRec({ id: "e-hash", hex: [hash] });
    const query = hash.slice(20, 30);
    const results = searchGraph(query, [rec]);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(300);
  });

  test("empty query -> [] even with matching records present", () => {
    const rec = nodeRec({ title: "anything", text: ["anything"] });
    expect(searchGraph("", [rec])).toEqual([]);
  });

  test("limit caps results (25 matches, limit 20)", () => {
    const records = Array.from({ length: 25 }, (_, i) => nodeRec({ id: `0x${i}`, title: `alpha ${i}`, text: [`alpha ${i}`] }));
    const results = searchGraph("alpha", records, { limit: 20 });
    expect(results).toHaveLength(20);
  });

  test("default limit is 20", () => {
    const records = Array.from({ length: 25 }, (_, i) => nodeRec({ id: `0x${i}`, title: `alpha ${i}`, text: [`alpha ${i}`] }));
    const results = searchGraph("alpha", records);
    expect(results).toHaveLength(20);
  });

  test("node-vs-edge tie: equal base score -> node first", () => {
    // Both records get an exact-text hit (900-tier) on "match"; title order alone
    // would put the edge ("Alpha") before the node ("Zed"), but the node kind
    // bonus must win the tie.
    const node = nodeRec({ id: "0xn", title: "Zed", text: ["match"] });
    const edge = edgeRec({ id: "e1", title: "Alpha", text: ["match"] });
    const results = searchGraph("match", [edge, node]);
    expect(results[0].record.kind).toBe("node");
  });

  test("equal-score ties (same kind) break by title ascending", () => {
    const a = nodeRec({ id: "0xa", title: "Beta", text: ["match"] });
    const b = nodeRec({ id: "0xb", title: "Alpha", text: ["match"] });
    const results = searchGraph("match", [a, b]);
    expect(results.map((r) => r.record.title)).toEqual(["Alpha", "Beta"]);
  });

  test("drops non-matching records (score 0)", () => {
    const rec = nodeRec({ title: "Nothing", text: ["nothing"] });
    const results = searchGraph("zzz-not-present-anywhere", [rec]);
    expect(results).toEqual([]);
  });

  test("matches across multiple fields, keeping the max score", () => {
    const rec = edgeRec({ title: "Weak fuzzy only", text: ["wafzy"], hex: ["0x" + "b2".repeat(20)] });
    const addr = "0x" + "b2".repeat(20);
    const results = searchGraph(addr, [rec]);
    expect(results[0].score).toBe(1000); // exact hex beats the weak text score
  });
});
