import { test, expect } from "bun:test";
import { findPeelChains } from "../src/peelChain.js";

const e = (from, to, amt, t) => ({ from, to, amountText: String(amt), timeStamp: String(t) });

test("detects a clean 3-hop peel chain", () => {
  const edges = [e("0xa", "0xb", 100, 1), e("0xb", "0xc", 98, 2), e("0xc", "0xd", 97, 3)];
  const chains = findPeelChains(edges, {});
  expect(chains.length).toBe(1);
  expect(chains[0]).toEqual(["0xa", "0xb", "0xc", "0xd"]);
});

test("breaks the chain when the forwarded amount drops below keepRatio", () => {
  const edges = [e("0xa", "0xb", 100, 1), e("0xb", "0xc", 40, 2)];
  expect(findPeelChains(edges, {})).toEqual([]);
});

test("breaks when a mid-node fans out (not ~1-out)", () => {
  const edges = [e("0xa", "0xb", 100, 1), e("0xb", "0xc", 98, 2), e("0xb", "0xz", 98, 2)];
  expect(findPeelChains(edges, {})).toEqual([]);
});

test("breaks when time goes backward", () => {
  const edges = [e("0xa", "0xb", 100, 5), e("0xb", "0xc", 98, 1)];
  expect(findPeelChains(edges, {})).toEqual([]);
});
