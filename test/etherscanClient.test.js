import { describe, test, expect } from "bun:test";
import {
  buildUrl,
  createEtherscanClient,
  EtherscanError,
} from "../src/etherscanClient.js";
import { API_BASE } from "../src/config.js";

// --- test helpers -----------------------------------------------------------

/** Build a fake fetch Response with case-insensitive header lookup. */
function fakeResponse(body, { status = 200, headers = {} } = {}) {
  return {
    status,
    headers: {
      get(name) {
        const key = Object.keys(headers).find(
          (k) => k.toLowerCase() === String(name).toLowerCase()
        );
        return key != null ? headers[key] : null;
      },
    },
    json: async () => body,
  };
}

/** A fetchImpl that returns queued responses (last one repeats), recording calls. */
function queuedFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const idx = Math.min(calls.length - 1, responses.length - 1);
    const r = responses[idx];
    return typeof r === "function" ? r(url, init) : r;
  };
  impl.calls = calls;
  return impl;
}

/** A fetchImpl that never resolves but rejects (AbortError) when aborted. */
function hangingFetch() {
  const calls = [];
  const impl = (url, init) =>
    new Promise((_resolve, reject) => {
      calls.push({ url, init });
      const sig = init && init.signal;
      if (sig) {
        sig.addEventListener(
          "abort",
          () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          },
          { once: true }
        );
      }
    });
  impl.calls = calls;
  return impl;
}

/** Await a promise and return the rejection (fails the test if it resolves). */
async function catchError(promise) {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("expected promise to reject, but it resolved");
}

const OK = (result) => fakeResponse({ status: "1", message: "OK", result });
const NOTOK = (msg) => fakeResponse({ status: "0", message: "NOTOK", result: msg });

function makeClient(fetchImpl, overrides = {}) {
  return createEtherscanClient({
    apiKey: "KEY",
    chainId: 1,
    fetchImpl,
    timeoutMs: 5000,
    maxRetries: 4,
    backoffBaseMs: 2,
    ...overrides,
  });
}

// --- buildUrl ---------------------------------------------------------------

describe("buildUrl", () => {
  test("produces the expected query shape with defaults", () => {
    const url = buildUrl({
      apiBase: API_BASE,
      chainId: 1,
      action: "txlist",
      address: "0xabc",
      apiKey: "KEY",
      offset: 20,
    });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe(API_BASE);
    expect(u.searchParams.get("chainid")).toBe("1");
    expect(u.searchParams.get("module")).toBe("account");
    expect(u.searchParams.get("action")).toBe("txlist");
    expect(u.searchParams.get("address")).toBe("0xabc");
    expect(u.searchParams.get("startblock")).toBe("0");
    expect(u.searchParams.get("endblock")).toBe("99999999");
    expect(u.searchParams.get("page")).toBe("1");
    expect(u.searchParams.get("offset")).toBe("20");
    expect(u.searchParams.get("sort")).toBe("desc");
    expect(u.searchParams.get("apikey")).toBe("KEY");
  });

  test("honors overrides for sort/page/startblock/endblock", () => {
    const url = buildUrl({
      apiBase: API_BASE,
      chainId: 137,
      action: "tokentx",
      address: "0xDEF",
      apiKey: "K2",
      offset: 5,
      page: 3,
      sort: "asc",
      startblock: 100,
      endblock: 200,
    });
    const u = new URL(url);
    expect(u.searchParams.get("chainid")).toBe("137");
    expect(u.searchParams.get("action")).toBe("tokentx");
    expect(u.searchParams.get("page")).toBe("3");
    expect(u.searchParams.get("sort")).toBe("asc");
    expect(u.searchParams.get("startblock")).toBe("100");
    expect(u.searchParams.get("endblock")).toBe("200");
    expect(u.searchParams.get("offset")).toBe("5");
  });
});

// --- fetchAction: success & empty -------------------------------------------

describe("fetchAction success paths", () => {
  test("status '1' returns the result array", async () => {
    const result = [{ hash: "0x1" }, { hash: "0x2" }];
    const fetchImpl = queuedFetch([OK(result)]);
    const client = makeClient(fetchImpl);
    const out = await client.fetchAction("0xabc", "txlist", { offset: 10 });
    expect(out).toEqual(result);
    expect(fetchImpl.calls.length).toBe(1);
    // URL built from client's bound apiKey + chainId.
    const u = new URL(fetchImpl.calls[0].url);
    expect(u.searchParams.get("apikey")).toBe("KEY");
    expect(u.searchParams.get("chainid")).toBe("1");
  });

  test("status '1' with missing result yields []", async () => {
    const fetchImpl = queuedFetch([fakeResponse({ status: "1", message: "OK" })]);
    const client = makeClient(fetchImpl);
    const out = await client.fetchAction("0xabc", "txlist", { offset: 10 });
    expect(out).toEqual([]);
  });

  test("'No transactions found' returns [] (not an error)", async () => {
    const fetchImpl = queuedFetch([NOTOK("No transactions found")]);
    const client = makeClient(fetchImpl);
    const out = await client.fetchAction("0xabc", "txlist", { offset: 10 });
    expect(out).toEqual([]);
    expect(fetchImpl.calls.length).toBe(1);
  });
});

// --- fetchAction: throttling / retries --------------------------------------

describe("fetchAction throttling & retries", () => {
  test("HTTP 429 with Retry-After then success: onRetry fired and waited", async () => {
    const result = [{ hash: "0xok" }];
    const throttled = fakeResponse({ status: "0", message: "NOTOK" }, {
      status: 429,
      headers: { "Retry-After": "0.03" }, // 30ms
    });
    const fetchImpl = queuedFetch([throttled, OK(result)]);
    const retries = [];
    const client = makeClient(fetchImpl, { maxRetries: 3 });

    const started = Date.now();
    const out = await client.fetchAction("0xabc", "txlist", {
      offset: 10,
      onRetry: (info) => retries.push(info),
    });
    const elapsed = Date.now() - started;

    expect(out).toEqual(result);
    expect(fetchImpl.calls.length).toBe(2);
    expect(retries.length).toBe(1);
    expect(retries[0]).toMatchObject({
      action: "txlist",
      attempt: 1,
      waitMs: 30,
      reason: "http_429",
    });
    // Honored Retry-After: waited ~30ms before the retry succeeded.
    expect(elapsed).toBeGreaterThanOrEqual(20);
  });

  test("throttle body ('Max rate limit reached') then success", async () => {
    const result = [{ hash: "0xok" }];
    const fetchImpl = queuedFetch([
      NOTOK("Max rate limit reached, please use API Key for higher rate limit"),
      OK(result),
    ]);
    const retries = [];
    const client = makeClient(fetchImpl, { backoffBaseMs: 3, maxRetries: 3 });
    const out = await client.fetchAction("0xabc", "txlist", {
      offset: 10,
      onRetry: (info) => retries.push(info),
    });
    expect(out).toEqual(result);
    expect(fetchImpl.calls.length).toBe(2);
    expect(retries.length).toBe(1);
    expect(retries[0]).toMatchObject({ attempt: 1, waitMs: 3, reason: "throttled" });
  });

  test("maxRetries exhausted → kind 'rate_limit'", async () => {
    const fetchImpl = queuedFetch([NOTOK("Max rate limit reached")]);
    const retries = [];
    const client = makeClient(fetchImpl, { backoffBaseMs: 1, maxRetries: 2 });
    const err = await catchError(
      client.fetchAction("0xabc", "txlist", {
        offset: 10,
        onRetry: (info) => retries.push(info),
      })
    );
    expect(err).toBeInstanceOf(EtherscanError);
    expect(err.kind).toBe("rate_limit");
    // 2 attempts total, 1 retry between them.
    expect(fetchImpl.calls.length).toBe(2);
    expect(retries.length).toBe(1);
  });

  test("'too many requests' body is treated as throttle", async () => {
    const result = [{ hash: "0xok" }];
    const fetchImpl = queuedFetch([NOTOK("Too Many Requests"), OK(result)]);
    const client = makeClient(fetchImpl, { backoffBaseMs: 1, maxRetries: 3 });
    const out = await client.fetchAction("0xabc", "txlist", { offset: 10 });
    expect(out).toEqual(result);
    expect(fetchImpl.calls.length).toBe(2);
  });
});

// --- fetchAction: typed error classification --------------------------------

describe("fetchAction error classification", () => {
  test("invalid key → kind 'invalid_key' with no retry", async () => {
    const fetchImpl = queuedFetch([NOTOK("Invalid API Key")]);
    const retries = [];
    const client = makeClient(fetchImpl, { maxRetries: 4 });
    const err = await catchError(
      client.fetchAction("0xabc", "txlist", {
        offset: 10,
        onRetry: (info) => retries.push(info),
      })
    );
    expect(err).toBeInstanceOf(EtherscanError);
    expect(err.kind).toBe("invalid_key");
    expect(fetchImpl.calls.length).toBe(1); // no retry
    expect(retries.length).toBe(0);
  });

  test("other status '0' → kind 'api'", async () => {
    const fetchImpl = queuedFetch([NOTOK("Error! Missing or invalid Action name")]);
    const client = makeClient(fetchImpl);
    const err = await catchError(
      client.fetchAction("0xabc", "txlist", { offset: 10 })
    );
    expect(err).toBeInstanceOf(EtherscanError);
    expect(err.kind).toBe("api");
    expect(err.meta.message).toContain("Missing or invalid Action name");
    expect(fetchImpl.calls.length).toBe(1);
  });

  test("fetch network throw → kind 'network'", async () => {
    const fetchImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    const client = makeClient(fetchImpl);
    const err = await catchError(
      client.fetchAction("0xabc", "txlist", { offset: 10 })
    );
    expect(err).toBeInstanceOf(EtherscanError);
    expect(err.kind).toBe("network");
    expect(err.meta.cause).toContain("ECONNREFUSED");
  });

  test("per-request timeout → kind 'timeout'", async () => {
    const fetchImpl = hangingFetch();
    const client = makeClient(fetchImpl, { timeoutMs: 10 });
    const err = await catchError(
      client.fetchAction("0xabc", "txlist", { offset: 10 })
    );
    expect(err).toBeInstanceOf(EtherscanError);
    expect(err.kind).toBe("timeout");
    expect(err.meta.timeoutMs).toBe(10);
  });

  test("caller abort → kind 'aborted'", async () => {
    const fetchImpl = hangingFetch();
    const client = makeClient(fetchImpl, { timeoutMs: 5000 });
    const ac = new AbortController();
    const p = client.fetchAction("0xabc", "txlist", {
      offset: 10,
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 5);
    const err = await catchError(p);
    expect(err).toBeInstanceOf(EtherscanError);
    expect(err.kind).toBe("aborted");
  });

  test("pre-aborted signal → kind 'aborted' before any fetch", async () => {
    const fetchImpl = hangingFetch();
    const client = makeClient(fetchImpl);
    const ac = new AbortController();
    ac.abort();
    const err = await catchError(
      client.fetchAction("0xabc", "txlist", { offset: 10, signal: ac.signal })
    );
    expect(err).toBeInstanceOf(EtherscanError);
    expect(err.kind).toBe("aborted");
    expect(fetchImpl.calls.length).toBe(0);
  });
});

// --- setApiKey / setChainId -------------------------------------------------

describe("setApiKey / setChainId", () => {
  test("mutate the bound key & chain used in subsequent URLs", async () => {
    const fetchImpl = queuedFetch([OK([]), OK([])]);
    const client = makeClient(fetchImpl);
    client.setApiKey("NEWKEY");
    client.setChainId(137);
    await client.fetchAction("0xabc", "txlist", { offset: 10 });
    const u = new URL(fetchImpl.calls[0].url);
    expect(u.searchParams.get("apikey")).toBe("NEWKEY");
    expect(u.searchParams.get("chainid")).toBe("137");
  });
});
