import { describe, test, expect } from "bun:test";
import { rankChainActivity, probeChains } from "../src/chainProbe.js";

// -----------------------------------------------------------------------------
// rankChainActivity — pure
// -----------------------------------------------------------------------------
describe("rankChainActivity", () => {
  test("mixed actives/inactives/errored: actives first (candidate order), best = first active", () => {
    const results = [
      { chainId: 1, name: "Ethereum", hasNativeTx: false, hasTokenTx: false }, // inactive
      { chainId: 8453, name: "Base", hasNativeTx: true, hasTokenTx: false }, // active
      { chainId: 42161, name: "Arbitrum One", hasNativeTx: false, hasTokenTx: false, error: true }, // errored
      { chainId: 10, name: "Optimism", hasNativeTx: false, hasTokenTx: true }, // active
    ];
    const { ranked, best } = rankChainActivity(results);

    expect(ranked.map((r) => r.chainId)).toEqual([8453, 10, 1, 42161]);
    expect(ranked[0].active).toBe(true);
    expect(ranked[1].active).toBe(true);
    expect(ranked[2].active).toBe(false);
    expect(ranked[3].active).toBe(false);
    expect(best).toBe(8453);
  });

  test("all-inactive -> best null", () => {
    const results = [
      { chainId: 1, name: "Ethereum", hasNativeTx: false, hasTokenTx: false },
      { chainId: 137, name: "Polygon", hasNativeTx: false, hasTokenTx: false },
    ];
    const { ranked, best } = rankChainActivity(results);
    expect(best).toBeNull();
    expect(ranked.every((r) => r.active === false)).toBe(true);
  });

  test("native-only counts as active", () => {
    const results = [{ chainId: 1, name: "Ethereum", hasNativeTx: true, hasTokenTx: false }];
    const { ranked, best } = rankChainActivity(results);
    expect(ranked[0].active).toBe(true);
    expect(best).toBe(1);
  });

  test("token-only counts as active", () => {
    const results = [{ chainId: 1, name: "Ethereum", hasNativeTx: false, hasTokenTx: true }];
    const { ranked, best } = rankChainActivity(results);
    expect(ranked[0].active).toBe(true);
    expect(best).toBe(1);
  });

  test("an errored chain is never active, even if hasNativeTx/hasTokenTx were somehow true", () => {
    const results = [{ chainId: 1, name: "Ethereum", hasNativeTx: true, hasTokenTx: true, error: true }];
    const { ranked, best } = rankChainActivity(results);
    expect(ranked[0].active).toBe(false);
    expect(best).toBeNull();
  });

  test("preserves candidate order among actives (priority order)", () => {
    const results = [
      { chainId: 137, name: "Polygon", hasNativeTx: true, hasTokenTx: false },
      { chainId: 1, name: "Ethereum", hasNativeTx: true, hasTokenTx: false },
      { chainId: 56, name: "BNB Chain", hasNativeTx: true, hasTokenTx: false },
    ];
    const { ranked, best } = rankChainActivity(results);
    expect(ranked.map((r) => r.chainId)).toEqual([137, 1, 56]);
    expect(best).toBe(137);
  });

  test("empty input -> empty ranked, best null", () => {
    const { ranked, best } = rankChainActivity([]);
    expect(ranked).toEqual([]);
    expect(best).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// probeChains — async orchestration with injected fakes
// -----------------------------------------------------------------------------
const fakeLimiter = { run: (fn) => fn() };

describe("probeChains", () => {
  test("returns one result per candidate; a throwing probeOne yields error:true (never aborts the whole probe)", async () => {
    const candidates = [
      { chainId: 1, name: "Ethereum" },
      { chainId: 8453, name: "Base" },
      { chainId: 137, name: "Polygon" },
    ];
    const probeOne = async (chainId) => {
      if (chainId === 1) return { hasNativeTx: true, hasTokenTx: false };
      if (chainId === 8453) throw new Error("boom");
      return { hasNativeTx: false, hasTokenTx: false };
    };
    const results = await probeChains("0xabc", candidates, { probeOne, limiter: fakeLimiter });

    expect(results.length).toBe(3);
    expect(results[0]).toMatchObject({ chainId: 1, name: "Ethereum", hasNativeTx: true, hasTokenTx: false });
    expect(results[0].error).toBeFalsy();
    expect(results[1]).toMatchObject({ chainId: 8453, name: "Base", hasNativeTx: false, hasTokenTx: false, error: true });
    expect(results[2]).toMatchObject({ chainId: 137, name: "Polygon", hasNativeTx: false, hasTokenTx: false });
    expect(results[2].error).toBeFalsy();
  });

  test("a genuinely-empty (inactive) chain never sets error", async () => {
    const candidates = [{ chainId: 1, name: "Ethereum" }];
    const probeOne = async () => ({ hasNativeTx: false, hasTokenTx: false });
    const results = await probeChains("0xabc", candidates, { probeOne, limiter: fakeLimiter });
    expect(results[0].error).toBeFalsy();
    expect(results[0].hasNativeTx).toBe(false);
    expect(results[0].hasTokenTx).toBe(false);
  });

  test("onProgress called once per candidate with (done, total)", async () => {
    const candidates = [
      { chainId: 1, name: "Ethereum" },
      { chainId: 8453, name: "Base" },
    ];
    const probeOne = async () => ({ hasNativeTx: false, hasTokenTx: false });
    const progress = [];
    await probeChains("0xabc", candidates, {
      probeOne,
      limiter: fakeLimiter,
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  test("aborting the signal between candidates stops early", async () => {
    const candidates = [
      { chainId: 1, name: "Ethereum" },
      { chainId: 8453, name: "Base" },
      { chainId: 137, name: "Polygon" },
    ];
    const controller = new AbortController();
    let calls = 0;
    const probeOne = async (chainId) => {
      calls++;
      if (chainId === 1) controller.abort(); // abort after the first candidate completes
      return { hasNativeTx: false, hasTokenTx: false };
    };
    const results = await probeChains("0xabc", candidates, {
      probeOne,
      limiter: fakeLimiter,
      signal: controller.signal,
    });

    expect(calls).toBe(1);
    expect(results.length).toBe(1);
    expect(results[0].chainId).toBe(1);
  });

  test("pre-aborted signal -> no candidates probed, empty result", async () => {
    const candidates = [{ chainId: 1, name: "Ethereum" }];
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const probeOne = async () => {
      calls++;
      return { hasNativeTx: false, hasTokenTx: false };
    };
    const results = await probeChains("0xabc", candidates, { probeOne, limiter: fakeLimiter, signal: controller.signal });
    expect(calls).toBe(0);
    expect(results).toEqual([]);
  });

  test("passes address and signal through to probeOne via the limiter", async () => {
    const candidates = [{ chainId: 1, name: "Ethereum" }];
    const controller = new AbortController();
    const calls = [];
    const probeOne = async (chainId, address, signal) => {
      calls.push({ chainId, address, signal });
      return { hasNativeTx: false, hasTokenTx: false };
    };
    await probeChains("0xABC", candidates, { probeOne, limiter: fakeLimiter, signal: controller.signal });
    expect(calls[0]).toEqual({ chainId: 1, address: "0xABC", signal: controller.signal });
  });

  test("empty candidates -> empty result, onProgress never called", async () => {
    let called = false;
    const results = await probeChains("0xabc", [], {
      probeOne: async () => ({ hasNativeTx: false, hasTokenTx: false }),
      limiter: fakeLimiter,
      onProgress: () => (called = true),
    });
    expect(results).toEqual([]);
    expect(called).toBe(false);
  });

  test("routes each probe through the injected limiter", async () => {
    const candidates = [
      { chainId: 1, name: "Ethereum" },
      { chainId: 8453, name: "Base" },
    ];
    let runCount = 0;
    const limiter = {
      run: (fn) => {
        runCount++;
        return fn();
      },
    };
    const probeOne = async () => ({ hasNativeTx: false, hasTokenTx: false });
    await probeChains("0xabc", candidates, { probeOne, limiter });
    expect(runCount).toBe(2);
  });
});
