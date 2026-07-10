import { describe, test, expect } from "bun:test";
import { estimateScan } from "../src/dryRun.js";

// -----------------------------------------------------------------------------
// dryRun.js is a pure, DOM-free upper-bound cost estimator (see its JSDoc for
// the exact model). These tests lock the frozen contract:
//   estimateScan({ firstHopNeighbors, maxDepth, typesCount, rps,
//                  maxTxPerAddress, safetyCap })
//     -> { addresses, apiCalls, seconds }
// -----------------------------------------------------------------------------

describe("estimateScan", () => {
  test("exact hand-computed values for a mid-size scan", () => {
    // b=5, total: 1 -(d1)-> 6 -(d2)-> 31 -(d3)-> 156; frontier at d3 = 125
    // expandedAddresses = 156 - 125 = 31; apiCalls = 31*1 = 31; seconds = 31/5 = 6.2
    const r = estimateScan({
      firstHopNeighbors: 5,
      maxDepth: 3,
      typesCount: 1,
      rps: 5,
      maxTxPerAddress: 100,
      safetyCap: 1000,
    });
    expect(r).toEqual({ addresses: 156, apiCalls: 31, seconds: 6.2 });
  });

  test("maxDepth=0: root is added but never expanded, still floors at 1 API call", () => {
    const r = estimateScan({
      firstHopNeighbors: 5,
      maxDepth: 0,
      typesCount: 3,
      rps: 2,
      maxTxPerAddress: 10,
      safetyCap: 1000,
    });
    expect(r.addresses).toBe(1);
    expect(r.apiCalls).toBe(3); // expandedAddresses(1) * typesCount(3)
    expect(r.seconds).toBe(1.5); // 3 / 2
  });

  test("linear growth (0 neighbors -> branching factor floors at 1)", () => {
    // b=max(1,0)=1: total grows by 1 each depth. total(d5)=6, frontier=1.
    // expandedAddresses = 6-1 = 5; apiCalls = 5*2 = 10; rps=0 -> divide by max(1,0)=1
    const r = estimateScan({
      firstHopNeighbors: 0,
      maxDepth: 5,
      typesCount: 2,
      rps: 0,
      maxTxPerAddress: 50,
      safetyCap: 1000,
    });
    expect(r).toEqual({ addresses: 6, apiCalls: 10, seconds: 10 });
  });

  test("monotonic: more first-hop neighbors never decreases apiCalls", () => {
    const base = { maxDepth: 3, typesCount: 1, rps: 5, maxTxPerAddress: 100, safetyCap: 1000 };
    const low = estimateScan({ ...base, firstHopNeighbors: 5 });
    const high = estimateScan({ ...base, firstHopNeighbors: 10 });
    expect(high.apiCalls).toBeGreaterThanOrEqual(low.apiCalls);
    expect(high.addresses).toBeGreaterThanOrEqual(low.addresses);
  });

  test("monotonic: more depth never decreases apiCalls", () => {
    const base = { firstHopNeighbors: 5, typesCount: 1, rps: 5, maxTxPerAddress: 100, safetyCap: 1000 };
    const shallow = estimateScan({ ...base, maxDepth: 3 });
    const deep = estimateScan({ ...base, maxDepth: 4 });
    expect(deep.apiCalls).toBeGreaterThanOrEqual(shallow.apiCalls);
    expect(deep.addresses).toBeGreaterThanOrEqual(shallow.addresses);
  });

  test("monotonic property holds across a broader sweep of neighbors/depth", () => {
    const base = { typesCount: 2, rps: 10, maxTxPerAddress: 20, safetyCap: 5000 };
    let prevByNeighbors = -Infinity;
    for (const firstHopNeighbors of [0, 1, 2, 4, 8, 16]) {
      const r = estimateScan({ ...base, firstHopNeighbors, maxDepth: 4 });
      expect(r.apiCalls).toBeGreaterThanOrEqual(prevByNeighbors);
      prevByNeighbors = r.apiCalls;
    }
    let prevByDepth = -Infinity;
    for (const maxDepth of [0, 1, 2, 3, 4, 5, 6]) {
      const r = estimateScan({ ...base, firstHopNeighbors: 3, maxDepth });
      expect(r.apiCalls).toBeGreaterThanOrEqual(prevByDepth);
      prevByDepth = r.apiCalls;
    }
  });

  test("capped: huge depth/neighbors cap addresses at exactly safetyCap", () => {
    const r = estimateScan({
      firstHopNeighbors: 1000,
      maxDepth: 1000,
      typesCount: 1,
      rps: 10,
      maxTxPerAddress: 5,
      safetyCap: 500,
    });
    expect(r.addresses).toBe(500);
    expect(Number.isFinite(r.apiCalls)).toBe(true);
    expect(Number.isFinite(r.seconds)).toBe(true);
    expect(r.apiCalls).toBeGreaterThan(0);
  });

  test("capped: addresses never exceeds safetyCap even with extreme inputs", () => {
    const r = estimateScan({
      firstHopNeighbors: 1e6,
      maxDepth: 500,
      typesCount: 3,
      rps: 20,
      maxTxPerAddress: 100,
      safetyCap: 250,
    });
    expect(r.addresses).toBe(250);
    expect(Number.isFinite(r.apiCalls)).toBe(true);
    expect(Number.isFinite(r.seconds)).toBe(true);
  });

  test("seconds == apiCalls / rps (rounded to 1 decimal) across several rps values", () => {
    const base = { firstHopNeighbors: 5, maxDepth: 3, typesCount: 1, maxTxPerAddress: 100, safetyCap: 1000 };
    for (const rps of [1, 3, 5, 7, 10, 50]) {
      const r = estimateScan({ ...base, rps });
      const expected = Math.round((r.apiCalls / Math.max(1, rps)) * 10) / 10;
      expect(r.seconds).toBe(expected);
    }
  });

  test("typesCount multiplies apiCalls (expandedAddresses is unaffected)", () => {
    const base = { firstHopNeighbors: 5, maxDepth: 3, rps: 5, maxTxPerAddress: 100, safetyCap: 1000 };
    const one = estimateScan({ ...base, typesCount: 1 });
    const three = estimateScan({ ...base, typesCount: 3 });
    expect(one.apiCalls).toBe(31);
    expect(three.apiCalls).toBe(93);
    expect(three.apiCalls).toBe(one.apiCalls * 3);
    // addresses (graph size) is independent of typesCount.
    expect(three.addresses).toBe(one.addresses);
  });

  test("degenerate inputs (0 neighbors, rps 0) never produce NaN/Infinity", () => {
    const r = estimateScan({
      firstHopNeighbors: 0,
      maxDepth: 0,
      typesCount: 0,
      rps: 0,
      maxTxPerAddress: 0,
      safetyCap: 0,
    });
    expect(Number.isFinite(r.addresses)).toBe(true);
    expect(Number.isFinite(r.apiCalls)).toBe(true);
    expect(Number.isFinite(r.seconds)).toBe(true);
    expect(r.addresses).toBeGreaterThanOrEqual(1);
    expect(r.apiCalls).toBeGreaterThanOrEqual(1);
  });

  test("non-finite and negative inputs are guarded (treated as their min), never NaN/Infinity", () => {
    const r = estimateScan({
      firstHopNeighbors: NaN,
      maxDepth: Infinity,
      typesCount: NaN,
      rps: -Infinity,
      maxTxPerAddress: -50,
      safetyCap: -5,
    });
    expect(Number.isFinite(r.addresses)).toBe(true);
    expect(Number.isFinite(r.apiCalls)).toBe(true);
    expect(Number.isFinite(r.seconds)).toBe(true);
    // maxDepth non-finite -> clamped to 0; safetyCap non-finite/negative -> clamped to 1.
    expect(r).toEqual({ addresses: 1, apiCalls: 1, seconds: 1 });
  });

  test("negative neighbors/depth/typesCount/rps are clamped rather than throwing", () => {
    const r = estimateScan({
      firstHopNeighbors: -10,
      maxDepth: -5,
      typesCount: -3,
      rps: -100,
      maxTxPerAddress: -1,
      safetyCap: -1,
    });
    expect(Number.isFinite(r.addresses)).toBe(true);
    expect(Number.isFinite(r.apiCalls)).toBe(true);
    expect(Number.isFinite(r.seconds)).toBe(true);
    expect(r).toEqual({ addresses: 1, apiCalls: 1, seconds: 1 });
  });

  test("maxTxPerAddress does not affect apiCalls (accepted for future use only)", () => {
    const base = { firstHopNeighbors: 5, maxDepth: 3, typesCount: 1, rps: 5, safetyCap: 1000 };
    const small = estimateScan({ ...base, maxTxPerAddress: 1 });
    const large = estimateScan({ ...base, maxTxPerAddress: 10000 });
    expect(small).toEqual(large);
  });

  test("output shape: exactly addresses/apiCalls/seconds, all numbers", () => {
    const r = estimateScan({
      firstHopNeighbors: 4,
      maxDepth: 2,
      typesCount: 2,
      rps: 4,
      maxTxPerAddress: 20,
      safetyCap: 100,
    });
    expect(Object.keys(r).sort()).toEqual(["addresses", "apiCalls", "seconds"]);
    expect(typeof r.addresses).toBe("number");
    expect(typeof r.apiCalls).toBe("number");
    expect(typeof r.seconds).toBe("number");
  });
});
