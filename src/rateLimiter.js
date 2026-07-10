// =============================================================================
// rateLimiter.js — single serialized queue that paces API calls at a fixed
// req/s, with cancellation. DOM-free, Node-testable.
//
// STAGE A: interface frozen. STAGE B: implement + unit tests.
// Contract: ALL Etherscan calls go through ONE limiter instance; the limiter is
// recreated per scan from the current RPS. `clear()` supports real cancellation
// (Stop): queued-but-not-started tasks reject immediately.
// =============================================================================

/** Error used to reject queued tasks when the limiter is cleared/cancelled. */
export class RateLimiterCancelled extends Error {
  constructor(message = "rate-limiter cancelled") {
    super(message);
    this.name = "RateLimiterCancelled";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RateLimiter {
  /** @param {number} rps requests per second (>= 1) */
  constructor(rps) {
    this.setRps(rps);
    this.queue = [];
    this.running = false;
  }

  /** @param {number} rps update pacing (>= 1). */
  setRps(rps) {
    this.interval = 1000 / Math.max(1, rps);
  }

  /**
   * Enqueue `fn`; resolves/rejects with its result. Tasks run one at a time,
   * spaced by 1000/rps ms.
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  run(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this._drain();
    });
  }

  /**
   * Cancel: reject every queued (not-yet-started) task with
   * {@link RateLimiterCancelled} and empty the queue. The in-flight task (if any)
   * is not force-killed here — the caller aborts it via AbortController.
   * @param {string} [reason]
   */
  clear(reason) {
    const pending = this.queue;
    this.queue = [];
    for (const { reject } of pending) {
      reject(new RateLimiterCancelled(reason));
    }
  }

  /** @returns {number} queued (not-yet-started) task count. */
  get size() {
    return this.queue.length;
  }

  async _drain() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length) {
      const { fn, resolve, reject } = this.queue.shift();
      try {
        resolve(await fn());
      } catch (e) {
        reject(e);
      }
      if (this.queue.length) await sleep(this.interval);
    }
    this.running = false;
  }
}
