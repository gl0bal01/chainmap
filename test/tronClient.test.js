import { test, expect } from "bun:test";
import { createTronClient } from "../src/tronClient.js";
import { tronRows } from "../src/tron.js";
import T20 from "./fixtures/tron/trc20.json";

const A = "41d1c4bb7b2f39aba5707711719b2236b5b605af2e";
const BASE = `https://api.trongrid.io/v1/accounts/${A}`;
const enc = new TextEncoder();
const text = (body) => (typeof body === "string" ? body : JSON.stringify(body));
const res = (status, body = "") => ({ status, headers: { get: () => null }, arrayBuffer: async () => enc.encode(text(body)).buffer });
const OK = (data = [], meta = {}) => res(200, { data, success: true, meta });

/** Serves queued responses (the last repeats); records url, init and time of each call. */
function fakeFetch(...responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, t: Date.now() });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    return typeof r === "function" ? r() : r;
  };
  impl.calls = calls;
  return impl;
}

/** Never resolves; rejects with AbortError once its signal aborts. */
function hangingFetch() {
  const calls = [];
  const impl = (url, init) =>
    new Promise((_, reject) => {
      calls.push({ url, init });
      init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    });
  impl.calls = calls;
  return impl;
}

/** Client wired to a fake fetch, collecting every onQuery record. */
function mk(fetchImpl, opts = {}) {
  const records = [];
  const client = createTronClient({ fetchImpl, onQuery: (r) => records.push(r), ...opts });
  return { client, records };
}

async function rejection(promise) {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

test("URL and params per action", async () => {
  const f = fakeFetch(OK());
  const { client } = mk(f);
  for (const action of ["txlist", "txlistinternal", "tokentx"]) await client.fetchAction(A, action, { offset: 20 });
  await client.fetchAction(A, "tokentx", { offset: 20, startblock: 1, endblock: 1794907752000, sort: "asc" });
  expect(f.calls.map((c) => c.url)).toEqual([
    `${BASE}/transactions?limit=20&only_confirmed=true&search_internal=false`,
    `${BASE}/internal-transactions?limit=20&only_confirmed=true`,
    `${BASE}/transactions/trc20?limit=20&only_confirmed=true`,
    `${BASE}/transactions/trc20?limit=20&only_confirmed=true&min_timestamp=1&max_timestamp=1794907752000`,
  ]);
});

test("key only in the header", async () => {
  const f = fakeFetch(OK());
  const { client, records } = mk(f, { apiKey: "TRONSECRET" });
  await client.fetchAction(A, "txlist", { offset: 5 });
  const { url, init } = f.calls[0];
  expect(init.headers).toEqual({ "TRON-PRO-API-KEY": "TRONSECRET" });
  expect(url).not.toContain("TRONSECRET");
  expect(JSON.stringify(records)).not.toContain("TRONSECRET");
  expect(init.credentials).toBe("omit");
  expect(init.referrerPolicy).toBe("no-referrer");
  expect(init.signal).toBeInstanceOf(AbortSignal);

  const g = fakeFetch(OK());
  await mk(g, { apiKey: "" }).client.fetchAction(A, "txlist", { offset: 5 });
  expect(g.calls[0].init.headers).toEqual({});
});

test("bad arguments rejected without a request", async () => {
  const cases = [
    [A, "txlist", 201],
    [A, "txlist", 0],
    ["TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi", "txlist", 20],
    ["0xd1c4bb7b2f39aba5707711719b2236b5b605af2e", "txlist", 20],
    [A, "tokennfttx", 20],
  ];
  for (const [address, action, offset] of cases) {
    const f = fakeFetch(OK());
    const { client, records } = mk(f);
    const err = await rejection(client.fetchAction(address, action, { offset }));
    expect(err.kind).toBe("api");
    expect(f.calls.length).toBe(0);
    expect(records.length).toBe(0);
  }
});

test("429 waits at least 5.5 s by default", async () => {
  const f = fakeFetch(res(429, { Error: "request rate exceeded" }));
  const ctrl = new AbortController();
  const retries = [];
  const { client, records } = mk(f);
  const err = await rejection(
    client.fetchAction(A, "txlist", { offset: 20, signal: ctrl.signal, onRetry: (i) => (retries.push(i), ctrl.abort()) })
  );
  expect(err.kind).toBe("aborted");
  expect(retries[0].waitMs).toBeGreaterThanOrEqual(5500);
  expect(retries[0].reason).toBe("http_429");
  expect(records.filter((r) => r.outcome === "retry" && r.httpStatus === 429).length).toBe(1);
  expect(f.calls.length).toBe(1);
});

test("429 then rate_limit; 503 then 200 succeeds", async () => {
  const f = fakeFetch(res(429));
  const { client, records } = mk(f, { backoffMs: 1, maxRetries: 2 });
  const err = await rejection(client.fetchAction(A, "txlist", { offset: 20 }));
  expect(err.kind).toBe("rate_limit");
  expect(f.calls.length).toBe(2);
  expect(records.map((r) => r.outcome)).toEqual(["retry", "error"]);
  expect(records.every((r) => !("body" in r))).toBe(true);

  const g = fakeFetch(res(503), OK([]));
  const out = await mk(g, { backoffMs: 1 }).client.fetchAction(A, "txlist", { offset: 20 });
  expect(out).toEqual([]);
  expect(g.calls.length).toBe(2);
});

test("401 invalid_key without retry", async () => {
  const f = fakeFetch(res(401, { Error: "ApiKey not exists" }));
  const { client, records } = mk(f, { apiKey: "TRONSECRET", backoffMs: 1 });
  const err = await rejection(client.fetchAction(A, "tokentx", { offset: 20 }));
  expect(err.kind).toBe("invalid_key");
  expect(err.message).toBe("TronGrid rejected the API key (tokentx)");
  expect(err.message).not.toContain("TRONSECRET");
  expect(f.calls.length).toBe(1);
  expect(records.map((r) => r.outcome)).toEqual(["error"]);
});

test("400 api with the server message", async () => {
  const msg = "A valid limit by parameter is required.";
  const f = fakeFetch(res(400, { success: false, error: msg, statusCode: 400 }));
  const { client, records } = mk(f, { backoffMs: 1 });
  const err = await rejection(client.fetchAction(A, "txlist", { offset: 20 }));
  expect(err.kind).toBe("api");
  expect(err.message).toContain(msg);
  expect(f.calls.length).toBe(1);
  expect(records[0].outcome).toBe("error");
  expect(new TextDecoder().decode(records[0].body)).toContain(msg);

  const g = fakeFetch(res(200, { success: false, Error: "x".repeat(300) }));
  const h = mk(g);
  const e2 = await rejection(h.client.fetchAction(A, "txlist", { offset: 20 }));
  expect(e2.kind).toBe("api");
  expect(e2.message).toBe(`TronGrid error (txlist): ${"x".repeat(200)}`);
  expect(h.records[0].outcome).toBe("error");
  expect(h.records[0].body).toBeDefined();

  const bad = mk(fakeFetch(res(200, "<html>")));
  expect((await rejection(bad.client.fetchAction(A, "txlist", { offset: 20 }))).kind).toBe("api");
  expect(bad.records[0].outcome).toBe("error");
});

test("timeout and abort", async () => {
  const { client, records } = mk(hangingFetch(), { timeoutMs: 10 });
  const err = await rejection(client.fetchAction(A, "txlist", { offset: 20 }));
  expect(err.kind).toBe("timeout");
  expect(records.map((r) => r.outcome)).toEqual(["network"]);

  const f = fakeFetch(OK());
  const ctrl = new AbortController();
  ctrl.abort();
  const pre = mk(f);
  expect((await rejection(pre.client.fetchAction(A, "txlist", { offset: 20, signal: ctrl.signal }))).kind).toBe("aborted");
  expect(f.calls.length).toBe(0);
  expect(pre.records.length).toBe(0);
});

test("fingerprint hops for page 3", async () => {
  const f = fakeFetch(OK([{}], { fingerprint: "F1" }), OK([{}], { fingerprint: "F2" }), res(200, T20));
  const { client, records } = mk(f, { minIntervalMs: 30 });
  const out = await client.fetchAction(A, "tokentx", { offset: 20, page: 3 });
  expect(f.calls.length).toBe(3);
  expect(f.calls[1].url.endsWith("&fingerprint=F1")).toBe(true);
  expect(f.calls[2].url.endsWith("&fingerprint=F2")).toBe(true);
  expect(f.calls[1].t - f.calls[0].t).toBeGreaterThanOrEqual(25);
  expect(f.calls[2].t - f.calls[1].t).toBeGreaterThanOrEqual(25);
  expect(out).toEqual(tronRows("tokentx", T20));
  expect(records.length).toBe(3);
  expect(records[0].params.fingerprint).toBeUndefined();
  expect(records[1].params.fingerprint).toBe("F1");
  expect(records[2].params.fingerprint).toBe("F2");
});

test("no next fingerprint: page 2 gives [] after one request", async () => {
  const f = fakeFetch(OK([{}, {}]));
  const out = await mk(f, { minIntervalMs: 1 }).client.fetchAction(A, "txlist", { offset: 2, page: 2 });
  expect(out).toEqual([]);
  expect(f.calls.length).toBe(1);
});

test("abort during a hop wait", async () => {
  const ctrl = new AbortController();
  const f = fakeFetch(() => (setTimeout(() => ctrl.abort(), 20), OK([{}], { fingerprint: "F1" })));
  const { client } = mk(f, { minIntervalMs: 1000 });
  const t0 = Date.now();
  const err = await rejection(client.fetchAction(A, "txlist", { offset: 1, page: 2, signal: ctrl.signal }));
  expect(err.kind).toBe("aborted");
  expect(Date.now() - t0).toBeLessThan(500);
  expect(f.calls.length).toBe(1);
});

test("onQuery record", async () => {
  const served = text(T20);
  const { client, records } = mk(fakeFetch(res(200, served)));
  await client.fetchAction(A, "tokentx", { offset: 20 });
  const [r] = records;
  expect(Object.keys(r).sort()).toEqual(["action", "at", "body", "chainId", "httpStatus", "outcome", "params", "rows", "source"]);
  expect(new TextDecoder().decode(r.body)).toBe(served);
  expect(r.rows).toBe(T20.data.length);
  expect(r).toMatchObject({ source: "trongrid", chainId: "728126428", action: "tokentx", httpStatus: 200, outcome: "ok" });
  expect(r.params).toEqual({ address: A, limit: "20", only_confirmed: "true" });
});

test("a throwing onQuery never breaks the fetch", async () => {
  const client = createTronClient({ fetchImpl: fakeFetch(OK([])), onQuery: () => { throw new Error("boom"); } });
  expect(await client.fetchAction(A, "txlist", { offset: 20 })).toEqual([]);
});

// Ruling 32: a short page that still carries a fingerprint is not the end of the data.
test("a short page with a fingerprint is filled from the next pages", async () => {
  const f = fakeFetch(OK([{}], { fingerprint: "F1" }), OK([{}, {}]));
  const { client, records } = mk(f, { minIntervalMs: 30 });
  const out = await client.fetchAction(A, "txlist", { offset: 3 });
  expect(out.length).toBe(3);
  expect(f.calls.length).toBe(2);
  expect(f.calls[1].url.endsWith("&fingerprint=F1")).toBe(true);
  expect(f.calls[1].t - f.calls[0].t).toBeGreaterThanOrEqual(25);
  expect(records.map((r) => r.params.fingerprint)).toEqual([undefined, "F1"]);
  expect(records.map((r) => r.outcome)).toEqual(["ok", "ok"]);
});

test("fill hops stop at 10", async () => {
  const f = fakeFetch(OK([{}], { fingerprint: "F" }));
  const { client, records } = mk(f, { minIntervalMs: 1 });
  const out = await client.fetchAction(A, "txlist", { offset: 50 });
  expect(f.calls.length).toBe(11);
  expect(records.length).toBe(11);
  expect(out.length).toBe(11);
});

test("abort during a fill wait", async () => {
  const ctrl = new AbortController();
  const f = fakeFetch(() => (setTimeout(() => ctrl.abort(), 20), OK([{}], { fingerprint: "F1" })));
  const { client } = mk(f, { minIntervalMs: 1000 });
  const t0 = Date.now();
  const err = await rejection(client.fetchAction(A, "txlist", { offset: 5, signal: ctrl.signal }));
  expect(err.kind).toBe("aborted");
  expect(Date.now() - t0).toBeLessThan(500);
  expect(f.calls.length).toBe(1);
});
