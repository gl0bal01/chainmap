import { describe, test, expect } from "bun:test";
import { RateLimiter, RateLimiterCancelled } from "../src/rateLimiter.js";

describe("RateLimiter", () => {
  test("runs tasks in FIFO order", async () => {
    const limiter = new RateLimiter(100); // 10ms spacing
    const order = [];
    const p1 = limiter.run(async () => {
      order.push(1);
      return 1;
    });
    const p2 = limiter.run(async () => {
      order.push(2);
      return 2;
    });
    const p3 = limiter.run(async () => {
      order.push(3);
      return 3;
    });
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  test("serializes pacing: tasks do not overlap and are spaced by ~1000/rps ms", async () => {
    const rps = 50; // 20ms spacing
    const limiter = new RateLimiter(rps);
    const starts = [];
    const ends = [];

    const makeTask = () =>
      limiter.run(async () => {
        starts.push(performance.now());
        // simulate small amount of work
        await new Promise((r) => setTimeout(r, 1));
        ends.push(performance.now());
      });

    await Promise.all([makeTask(), makeTask(), makeTask()]);

    expect(starts.length).toBe(3);
    // No overlap: each task's end must be <= the following task's start.
    for (let i = 0; i < ends.length - 1; i++) {
      expect(ends[i]).toBeLessThanOrEqual(starts[i + 1] + 1); // small epsilon for timer jitter
    }
    // Spacing between successive starts should be roughly >= interval (allow jitter).
    const interval = 1000 / rps;
    for (let i = 0; i < starts.length - 1; i++) {
      expect(starts[i + 1] - starts[i]).toBeGreaterThanOrEqual(interval - 5);
    }
  });

  test("run() resolves with fn's return value", async () => {
    const limiter = new RateLimiter(100);
    const result = await limiter.run(async () => 42);
    expect(result).toBe(42);
  });

  test("run() rejects when fn throws", async () => {
    const limiter = new RateLimiter(100);
    const err = new Error("boom");
    await expect(
      limiter.run(async () => {
        throw err;
      })
    ).rejects.toThrow("boom");
  });

  test("clear() rejects queued tasks with RateLimiterCancelled and size drops to 0", async () => {
    const limiter = new RateLimiter(50); // 20ms spacing so tasks stay queued long enough
    const settled = [];

    const p1 = limiter.run(async () => {
      settled.push("p1");
      return "p1";
    });
    const p2 = limiter.run(async () => {
      settled.push("p2");
      return "p2";
    });
    const p3 = limiter.run(async () => {
      settled.push("p3");
      return "p3";
    });

    // Attach handlers immediately (synchronously) so neither promise is ever
    // observed as unhandled, regardless of when clear() rejects them.
    const p2Result = p2.then(
      (v) => ({ status: "resolved", value: v }),
      (e) => ({ status: "rejected", error: e })
    );
    const p3Result = p3.then(
      (v) => ({ status: "resolved", value: v }),
      (e) => ({ status: "rejected", error: e })
    );

    // p1 starts running immediately (synchronously drained); p2 and p3 remain queued.
    expect(limiter.size).toBe(2);

    limiter.clear("stop requested");

    expect(limiter.size).toBe(0);

    const [r2, r3] = await Promise.all([p2Result, p3Result]);
    expect(r2.status).toBe("rejected");
    expect(r2.error).toBeInstanceOf(RateLimiterCancelled);
    expect(r3.status).toBe("rejected");
    expect(r3.error).toBeInstanceOf(RateLimiterCancelled);

    // p1 was already running (in-flight) and is not force-killed by clear().
    await expect(p1).resolves.toBe("p1");
  });

  test("in-flight task still settles even after clear()", async () => {
    const limiter = new RateLimiter(50);
    let inFlightResolved = false;

    const p1 = limiter.run(async () => {
      await new Promise((r) => setTimeout(r, 15));
      inFlightResolved = true;
      return "done";
    });
    const p2 = limiter.run(async () => "should-not-run");

    limiter.clear();

    await expect(p2).rejects.toBeInstanceOf(RateLimiterCancelled);
    const result = await p1;
    expect(result).toBe("done");
    expect(inFlightResolved).toBe(true);
  });

  test("setRps updates pacing for subsequent tasks", async () => {
    const limiter = new RateLimiter(1000); // 1ms spacing initially
    limiter.setRps(50); // 20ms spacing
    const starts = [];

    const makeTask = () =>
      limiter.run(async () => {
        starts.push(performance.now());
      });

    await Promise.all([makeTask(), makeTask()]);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(15);
  });
});
