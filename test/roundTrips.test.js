import { test, expect } from "bun:test";
import { findCycleNodes } from "../src/roundTrips.js";

const n = (...ids) => ids.map((id) => ({ id }));
const e = (fromId, toId) => ({ fromId, toId });

test("mutual pair A<->B flags both", () => {
  const s = findCycleNodes(n("a", "b"), [e("a", "b"), e("b", "a")]);
  expect([...s].sort()).toEqual(["a", "b"]);
});

test("longer cycle A->B->C->A flags all three", () => {
  const s = findCycleNodes(n("a", "b", "c"), [e("a", "b"), e("b", "c"), e("c", "a")]);
  expect([...s].sort()).toEqual(["a", "b", "c"]);
});

test("acyclic path A->B->C flags nothing", () => {
  const s = findCycleNodes(n("a", "b", "c"), [e("a", "b"), e("b", "c")]);
  expect(s.size).toBe(0);
});

test("self-loop A->A flags A", () => {
  const s = findCycleNodes(n("a"), [e("a", "a")]);
  expect([...s]).toEqual(["a"]);
});

test("branch off a cycle: only the cycle nodes flagged", () => {
  // a->b->a is a cycle; c hangs off b, not on the cycle
  const s = findCycleNodes(n("a", "b", "c"), [e("a", "b"), e("b", "a"), e("b", "c")]);
  expect([...s].sort()).toEqual(["a", "b"]);
});

test("cycles never cross chains: X→Y on chain 1 plus Y→X on chain 10 is no round-trip", () => {
  expect(findCycleNodes(n("1:x", "1:y", "10:x", "10:y"), [e("1:x", "1:y"), e("10:y", "10:x")]).size).toBe(0);
  expect([...findCycleNodes(n("1:x", "1:y"), [e("1:x", "1:y"), e("1:y", "1:x")])].sort()).toEqual(["1:x", "1:y"]);
});
