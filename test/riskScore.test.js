import { test, expect } from "bun:test";
import { scoreNode } from "../src/riskScore.js";

test("plain node -> low, no reasons", () => {
  const r = scoreNode({ inDeg: 1, outDeg: 1, hubKind: null, onCycle: false, hasContractCalls: false, known: false });
  expect(r.level).toBe("low");
  expect(r.reasons).toEqual([]);
});

test("cycle + sink -> high with both reasons", () => {
  const r = scoreNode({ inDeg: 2, outDeg: 0, hubKind: "sink", onCycle: true, hasContractCalls: false, known: false });
  expect(r.score).toBe(5);
  expect(r.level).toBe("high");
  expect(r.reasons).toContain("risk.cycle");
  expect(r.reasons).toContain("risk.sink");
});

test("high degree + contract calls -> med", () => {
  const r = scoreNode({ inDeg: 15, outDeg: 15, hubKind: null, onCycle: false, hasContractCalls: true, known: false });
  expect(r.level).toBe("med");
  expect(r.reasons).toEqual(["risk.highDegree", "risk.contract"]);
});

test("known address adds a reason but not score", () => {
  const r = scoreNode({ inDeg: 1, outDeg: 1, hubKind: null, onCycle: false, hasContractCalls: false, known: true });
  expect(r.score).toBe(0);
  expect(r.reasons).toEqual(["risk.known"]);
});
