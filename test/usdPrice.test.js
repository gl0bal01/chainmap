import { describe, test, expect } from "bun:test";
import {
  hourBucket, decimalsFor, priceKeyFor, priceToRational, usdCents, usdText, formatUsdDisplay,
  priceUrl, buildRequests, parseBatchResponse, usdForEdge, usdCounts, createPriceService,
} from "../src/usdPrice.js";
import { PRICE_API } from "../src/config.js";
import { RateLimiter } from "../src/rateLimiter.js";

const C = "0x" + "ab".repeat(20);
const B = 1699999200;
const ctx0 = { isFakeToken: () => false, isSpam: () => false, isRoot: () => false };
const tok = (over = {}) => ({ chainId: "1", action: "tokentx", tokenContract: C, value: "5000000", amountIndeterminate: false, tokenDecimal: "6", timeStamp: "1700000000", ...over });
const nat = (over = {}) => ({ chainId: "1", action: "txlist", tokenContract: "", value: "1000000000000000000", amountIndeterminate: false, tokenDecimal: "", timeStamp: "1700000000", ...over });
const skip = (e, reason, ctx = ctx0) => expect(priceKeyFor(e, ctx)).toEqual({ skip: reason });

describe("usdPrice pure", () => {
  test("hourBucket rounds to the nearest hour, half up", () => {
    expect(hourBucket(1700000000)).toBe(1699999200);
    expect(hourBucket(1700000999)).toBe(1699999200);
    expect(hourBucket(1700001000)).toBe(1700002800);
  });

  test("priceKeyFor: token → slug:lowercase contract, bucketed ts", () => {
    expect(priceKeyFor(tok({ tokenContract: "0x" + "AB".repeat(20) }), ctx0)).toEqual({ coin: "ethereum:" + C, ts: B });
  });
  test("priceKeyFor: chain skips", () => {
    skip(tok({ chainId: "11155111" }), "chain");
    skip(tok({ chainId: "424242" }), "chain");
    skip(tok({ chainId: "4352" }), "chain");
    skip(nat({ chainId: "252" }), "chain");
  });
  test("priceKeyFor: nft and unknown action", () => {
    skip(tok({ action: "tokennfttx" }), "nft");
    skip(tok({ action: "token1155tx" }), "nft");
    skip(tok({ action: "weird" }), "data");
  });
  test("priceKeyFor: data skips", () => {
    skip(tok({ amountIndeterminate: true }), "data");
    for (const value of ["1.5", ""]) skip(tok({ value }), "data");
    for (const timeStamp of ["0", "abc", "99999999999999999", "99999999999999999999999"]) skip(tok({ timeStamp }), "data");
    for (const tokenDecimal of ["", "78", "-1", " 6"]) skip(tok({ tokenDecimal }), "data");
    skip(tok({ tokenContract: "0x123" }), "data");
    expect(priceKeyFor(tok({ tokenDecimal: "06" }), ctx0)).toEqual({ coin: "ethereum:" + C, ts: B });
  });
  test("priceKeyFor: zero", () => {
    skip(tok({ value: "0" }), "zero");
    skip(tok({ value: "000" }), "zero");
  });
  test("priceKeyFor: imitation never carries a coin", () => {
    const r = priceKeyFor(tok({ symbol: "USDT" }), { ...ctx0, isFakeToken: () => true });
    expect(r).toEqual({ skip: "imitation" });
    expect("coin" in r).toBe(false);
  });
  test("priceKeyFor: spam and root", () => {
    skip(tok(), "spam", { ...ctx0, isSpam: () => true });
    const calls = [];
    skip(tok({ tokenContract: C.toUpperCase().replace("0X", "0x") }), "root", { ...ctx0, isRoot: (...a) => (calls.push(a), true) });
    expect(calls).toEqual([["1", C]]);
  });
  test("priceKeyFor: native", () => {
    expect(priceKeyFor(nat(), ctx0)).toEqual({ coin: "coingecko:ethereum", ts: B });
    expect(priceKeyFor(nat({ action: "txlistinternal" }), ctx0)).toEqual({ coin: "coingecko:ethereum", ts: B });
  });
  test("priceKeyFor: Polygon split compares the raw timestamp", () => {
    expect(priceKeyFor(nat({ chainId: "137", timeStamp: "1725926399" }), ctx0)).toEqual({ coin: "coingecko:matic-network", ts: 1725926400 });
    expect(priceKeyFor(nat({ chainId: "137", timeStamp: "1725926400" }), ctx0)).toEqual({ coin: "coingecko:polygon-ecosystem-token", ts: 1725926400 });
  });
  test("decimalsFor", () => {
    expect(decimalsFor(nat({ tokenDecimal: "6" }))).toBe(18);
    expect(decimalsFor(tok({ tokenDecimal: "6" }))).toBe(6);
    expect(decimalsFor(tok({ tokenDecimal: "06" }))).toBe(6);
    expect(decimalsFor(tok({ tokenDecimal: "77" }))).toBe(77);
    for (const d of ["78", "", "-1", " 6"]) expect(decimalsFor(tok({ tokenDecimal: d }))).toBeNull();
  });
  test("priceKeyFor reads only allowed fields", () => {
    const bad = new Set(["from", "to", "hash", "fromId", "toId", "symbol"]);
    const p = new Proxy(tok(), { get(t, k) { if (bad.has(k)) throw new Error("read " + String(k)); return t[k]; } });
    expect(() => priceKeyFor(p, ctx0)).not.toThrow();
  });

  test("priceToRational is exact", () => {
    expect(priceToRational(3456.78)).toEqual({ num: 345678n, den: 100n });
    expect(priceToRational(1e-7)).toEqual({ num: 1n, den: 10000000n });
    expect(priceToRational(1.2e-7)).toEqual({ num: 12n, den: 100000000n });
    expect(priceToRational(1.07e-6)).toEqual({ num: 107n, den: 100000000n });
    expect(priceToRational(1e21)).toEqual({ num: 10n ** 21n, den: 1n });
    for (const bad of [0, -1, NaN, Infinity, "3", null, undefined]) expect(priceToRational(bad)).toBeNull();
  });
  test("usdCents / usdText exact vectors", () => {
    const r = (p) => priceToRational(p);
    expect(usdText(usdCents("1000000000000000000", 18, r(3456.78)))).toBe("3456.78");
    expect(usdText(usdCents("5000000", 6, r(0.9998)))).toBe("5.00");
    expect(usdText(usdCents("7", 0, r(1.5)))).toBe("10.50");
    expect(usdCents("1", 0, r(0.005))).toBe(1n);
    expect(usdText(usdCents("1", 0, r(0.0049)))).toBe("<0.01");
    expect(usdText(usdCents("123456789012345678901234567890", 18, r(2)))).toBe("246913578024.69");
    expect(usdText(1n)).toBe("0.01");
    expect(usdText(100n)).toBe("1.00");
  });
  test("formatUsdDisplay groups per locale without Number", () => {
    expect(formatUsdDisplay("1234567.89", "en")).toBe("1,234,567.89");
    expect(formatUsdDisplay("1234567.89", "fr")).toMatch(/^1\D234\D567,89$/);
    expect(formatUsdDisplay("12345678901234567890.12", "en")).toBe("12,345,678,901,234,567,890.12");
    expect(formatUsdDisplay("<0.01", "fr")).toBe("< 0.01");
    expect(formatUsdDisplay("0.50", "en")).toBe("0.50");
  });
});

describe("usdPrice batching", () => {
  const T1 = 1700002800, T2 = 1700006400;
  const ck = (coin, ts) => ({ coin, ts });
  const check = (input, reqs) => {
    expect(reqs.length).toBeGreaterThan(1);
    const seen = new Set();
    for (const rq of reqs) {
      expect(priceUrl(rq.coins, "30m").length).toBeLessThanOrEqual(8000);
      expect(JSON.stringify(JSON.parse(rq.coins))).toBe(rq.coins);
      for (const p of rq.pairs) { const k = p.coin + "@" + p.ts; expect(seen.has(k)).toBe(false); seen.add(k); }
    }
    expect(seen).toEqual(new Set(input.map((p) => p.coin + "@" + p.ts)));
  };
  test("priceUrl", () => {
    expect(priceUrl('{"a":[1]}', "30m")).toBe(PRICE_API + "/batchHistorical?coins=" + encodeURIComponent('{"a":[1]}') + "&searchWidth=30m");
  });
  test("groups and sorts", () => {
    const keys = [ck("ethereum:" + C, T1), ck("coingecko:ethereum", T2), ck("coingecko:ethereum", T1), ck("coingecko:ethereum", T2)];
    const reqs = buildRequests(keys);
    expect(reqs).toHaveLength(1);
    expect(reqs[0].coins).toBe('{"coingecko:ethereum":[' + T1 + "," + T2 + '],"ethereum:' + C + '":[' + T1 + "]}");
    expect(reqs[0].pairs).toHaveLength(3);
  });
  test("splits under the URL cap", () => {
    const keys = Array.from({ length: 600 }, (_, i) => ck("ethereum:0x" + i.toString(16).padStart(40, "0"), B));
    check(keys, buildRequests(keys));
  });
  test("one coin's hours may span two requests", () => {
    const keys = Array.from({ length: 900 }, (_, i) => ck("coingecko:ethereum", B + i * 3600));
    check(keys, buildRequests(keys));
  });
  test("5000 pairs stay under the cap and are covered exactly", () => {
    const keys = Array.from({ length: 5000 }, (_, i) => ck("ethereum:0x" + (i % 40).toString(16).padStart(40, "0"), B + Math.floor(i / 40) * 3600));
    const reqs = buildRequests(keys);
    const seen = new Set();
    for (const rq of reqs) {
      expect(priceUrl(rq.coins, "30m").length).toBeLessThanOrEqual(8000);
      for (const p of rq.pairs) seen.add(p.coin + "@" + p.ts);
    }
    expect(seen).toEqual(new Set(keys.map((p) => p.coin + "@" + p.ts)));
    expect(reqs.reduce((n, r) => n + r.pairs.length, 0)).toBe(5000);
  });
  test("empty input", () => expect(buildRequests([])).toEqual([]));
});

describe("usdPrice parseBatchResponse", () => {
  const ETH = "coingecko:ethereum", TOK = "ethereum:" + C;
  const pairs = [{ coin: ETH, ts: B }, { coin: ETH, ts: B + 3600 }, { coin: TOK, ts: B }];
  const resp = (coin, prices) => ({ coins: { [coin]: { symbol: "X", prices } } });
  const pt = (timestamp, price = 2000, extra = {}) => ({ timestamp, price, ...extra });
  const parse = (j) => parseBatchResponse(j, pairs);

  test("maps by time, not position", () => {
    const m = parse(resp(ETH, [pt(B + 3600 - 60, 2001), pt(B + 90, 2000)]));
    expect(m.get(ETH + "@" + B)).toEqual({ price: 2000, at: B + 90, confidence: null });
    expect(m.get(ETH + "@" + (B + 3600))).toEqual({ price: 2001, at: B + 3540, confidence: null });
    expect(m.get(TOK + "@" + B)).toBeNull();
  });
  test("closer point wins", () => {
    expect(parse(resp(ETH, [pt(B - 600, 1), pt(B + 120, 2)])).get(ETH + "@" + B).at).toBe(B + 120);
  });
  test("unusable points dropped before closest-wins", () => {
    const m = parse(resp(ETH, [pt(B + 10, 5, { confidence: 0.5 }), pt(B + 900, 6, { confidence: 0.99 })]));
    expect(m.get(ETH + "@" + B)).toEqual({ price: 6, at: B + 900, confidence: 0.99 });
  });
  test("window edge", () => {
    const j = { coins: { [ETH]: { prices: [pt(B + 1800)] }, [TOK]: { prices: [pt(B + 1800)] } } };
    const m = parse(j);
    expect(m.get(ETH + "@" + (B + 3600)).at).toBe(B + 1800);
    expect(m.get(TOK + "@" + B)).toBeNull();
  });
  test("unrequested bucket ignored", () => {
    const m = parse(resp(ETH, [pt(B + 7200)]));
    for (const v of m.values()) expect(v).toBeNull();
  });
  test("case-insensitive key", () => {
    const m = parse(resp("ethereum:0x" + "AB".repeat(20), [pt(B)]));
    expect(m.get(TOK + "@" + B).price).toBe(2000);
  });
  test("absent / empty / malformed", () => {
    for (const j of [null, undefined, [], {}, { coins: 5 }, { coins: {} }, { coins: { [ETH]: 5 } }, { coins: { [ETH]: { prices: 5 } } }]) {
      const m = parse(j);
      expect(m.size).toBe(3);
      for (const v of m.values()) expect(v).toBeNull();
    }
  });
  test("rejects bad prices and confidence, accepts boundary", () => {
    for (const price of [0, -1, "3", NaN, 1e400]) expect(parse(resp(ETH, [pt(B, price)])).get(ETH + "@" + B)).toBeNull();
    expect(parse(resp(ETH, [pt(B, 2, { confidence: "0.99" })])).get(ETH + "@" + B)).toBeNull();
    expect(parse(resp(ETH, [pt("x")])).get(ETH + "@" + B)).toBeNull();
    expect(parse(resp(ETH, [pt(B, 2)])).get(ETH + "@" + B).confidence).toBeNull();
    expect(parse(resp(ETH, [pt(B, 2, { confidence: 0.9 })])).get(ETH + "@" + B).confidence).toBe(0.9);
  });
});

describe("usdPrice usdForEdge", () => {
  const deepFreeze = (o) => { Object.values(o).forEach((v) => typeof v === "object" && v && deepFreeze(v)); return Object.freeze(o); };
  const okState = { state: "ok", price: 2000, at: B + 60, confidence: 0.99 };

  test("skip passes through", () => {
    expect(usdForEdge(tok({ action: "tokennfttx" }), ctx0, () => { throw new Error("no"); })).toEqual({ state: "skip", reason: "nft" });
  });
  test("pending / none / error", () => {
    expect(usdForEdge(nat(), ctx0, () => undefined)).toEqual({ state: "pending" });
    expect(usdForEdge(nat(), ctx0, () => ({ state: "none" }))).toEqual({ state: "none" });
    expect(usdForEdge(nat(), ctx0, () => ({ state: "error" }))).toEqual({ state: "error" });
    expect(usdForEdge(nat(), ctx0, () => ({ state: "pending" }))).toEqual({ state: "pending" });
  });
  test("ok", () => {
    let asked;
    const r = usdForEdge(nat(), ctx0, (c, t) => ((asked = [c, t]), okState));
    expect(asked).toEqual(["coingecko:ethereum", B]);
    expect(r).toEqual({ state: "ok", cents: 200000n, text: "2000.00", price: 2000, at: B + 60, confidence: 0.99 });
  });
  test("root / imitation flag suppresses cached ok", () => {
    expect(usdForEdge(tok(), { ...ctx0, isRoot: () => true }, () => okState)).toEqual({ state: "skip", reason: "root" });
    expect(usdForEdge(tok(), { ...ctx0, isFakeToken: () => true }, () => okState)).toEqual({ state: "skip", reason: "imitation" });
  });
  test("never mutates the edge", () => {
    expect(usdForEdge(deepFreeze(nat()), ctx0, () => okState).state).toBe("ok");
  });
  test("usdCounts", () => {
    const rs = [{ state: "ok" }, { state: "pending" }, { state: "skip" }, { state: "none" }];
    expect(usdCounts(rs, (r) => r)).toEqual({ priced: 1, priceable: 3 });
  });
});

describe("createPriceService", () => {
  const ETH = "coingecko:ethereum";
  const TOK = "ethereum:" + C;
  const B2 = B + 3600;
  const ZERO = { pending: 0, ok: 0, none: 0, error: 0 };
  const raw = (text, status = 200, headers = {}) => ({
    ok: status < 300, status, headers: { get: (h) => headers[h] ?? null },
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  });
  const reply = (json, status = 200, headers = {}) => raw(JSON.stringify(json), status, headers);
  const priced = (coin, ts, price = 2000) => ({ coins: { [coin]: { symbol: "X", prices: [{ timestamp: ts + 60, price, confidence: 0.99 }] } } });
  const hang = (url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason)));
  const ticks = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
  const until = async (pred) => {
    for (let i = 0; i < 50 && !pred(); i++) await new Promise((r) => setTimeout(r, 0));
    expect(pred()).toBe(true);
  };
  const outcomes = (h) => h.recs.map((r) => r.outcome);
  const coinsOf = (obj) => JSON.stringify(obj);

  /** script: queue of responses, or (url, init) => response|promise (may throw). Empty → `{coins:{}}`. */
  function svc({ script = [], allowed, hold } = {}) {
    const calls = [], recs = [], sleeps = [];
    let changes = 0;
    const limiter = new RateLimiter(1000);
    const s = createPriceService({
      limiter,
      sleep: async (ms) => { sleeps.push(ms); },
      onQuery: (r) => { recs.push(r); return hold?.(r); },
      fetchImpl: (url, init) => {
        calls.push({ url, init });
        const next = script.length ? script.shift() : reply({ coins: {} });
        return typeof next === "function" ? next(url, init) : Promise.resolve(next);
      },
      allowed,
    });
    s.onChange(() => changes++);
    return { s, calls, recs, sleeps, script, limiter, changes: () => changes };
  }
  function trackRejections() {
    let n = 0;
    const h = () => n++;
    process.on("unhandledRejection", h);
    return { count: () => n, off: () => process.off("unhandledRejection", h) };
  }

  test("request shape", async () => {
    const h = svc();
    expect(h.s.want([{ coin: ETH, ts: B }, { coin: TOK, ts: B }])).toBe(2);
    await until(() => h.s.stats().pending === 0);
    expect(h.calls.length).toBe(1);
    expect(h.calls[0].url).toBe(priceUrl(coinsOf({ [ETH]: [B], [TOK]: [B] }), "30m"));
    const { signal, ...rest } = h.calls[0].init;
    expect(rest).toEqual({ credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  test("onQuery once per attempt, defillama shape", async () => {
    const h = svc({ script: [reply(priced(ETH, B))] });
    h.s.want([{ coin: ETH, ts: B }, { coin: TOK, ts: B }]);
    await until(() => h.s.get(ETH, B)?.state === "ok");
    await ticks();
    expect(h.recs.length).toBe(1);
    const r = h.recs[0];
    expect(Object.keys(r).sort()).toEqual(["action", "at", "body", "httpStatus", "outcome", "params", "rows", "source"]);
    expect(r).toMatchObject({
      source: "defillama", action: "batchHistorical",
      params: { coins: coinsOf({ [ETH]: [B], [TOK]: [B] }), searchWidth: "30m" },
      httpStatus: 200, rows: 1, outcome: "ok",
    });
    expect(Object.keys(r.params).sort()).toEqual(["coins", "searchWidth"]);
    expect(r.body).toBeInstanceOf(Uint8Array);
    expect(Number.isNaN(Date.parse(r.at))).toBe(false);
    expect(h.s.get(ETH, B)).toEqual({ state: "ok", price: 2000, at: B + 60, confidence: 0.99 });
    expect(h.s.get(TOK, B)).toEqual({ state: "none" });
  });

  test("log-before-show: states publish only after onQuery resolves", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const h = svc({ script: [reply(priced(ETH, B))], hold: () => gate });
    h.s.want([{ coin: ETH, ts: B }]);
    await until(() => h.recs.length === 1);
    await ticks();
    expect(h.s.get(ETH, B)).toEqual({ state: "pending" });
    expect(h.changes()).toBe(0);
    release();
    await until(() => h.s.get(ETH, B)?.state === "ok");
    expect(h.changes()).toBe(1);
  });

  test("dedup and cache", async () => {
    const h = svc({ script: [reply(priced(ETH, B))] });
    const keys = [{ coin: ETH, ts: B }, { coin: TOK, ts: B }];
    expect(h.s.want(keys)).toBe(2);
    expect(h.s.want(keys)).toBe(0);
    expect(h.s.stats()).toEqual({ ...ZERO, pending: 2 });
    await until(() => h.s.stats().pending === 0);
    expect(h.s.stats()).toEqual({ ...ZERO, ok: 1, none: 1 });
    expect(h.s.want(keys)).toBe(0);
    await ticks();
    expect(h.calls.length).toBe(1);
  });

  test("none is cached", async () => {
    const h = svc({ script: [reply({ coins: { [ETH]: { prices: [] } } })] });
    h.s.want([{ coin: TOK, ts: B }]);
    await until(() => h.s.get(TOK, B)?.state === "none");
    expect(h.s.get(TOK, B)).toEqual({ state: "none" });
    expect(h.s.want([{ coin: TOK, ts: B }])).toBe(0);
    await ticks();
    expect(h.calls.length).toBe(1);
  });

  test("429 + Retry-After then ok", async () => {
    const h = svc({ script: [reply({}, 429, { "Retry-After": "2" }), reply(priced(ETH, B))] });
    h.s.want([{ coin: ETH, ts: B }]);
    await until(() => h.s.get(ETH, B)?.state === "ok");
    expect(h.sleeps).toEqual([2000]);
    expect(outcomes(h)).toEqual(["retry", "ok"]);
    expect(h.recs[0]).toMatchObject({ httpStatus: 429, rows: null });
    expect("body" in h.recs[0]).toBe(false);
    expect(h.calls.length).toBe(2);
    expect(h.changes()).toBe(1);
  });

  test("5xx exhausts retries → error, then retried by want", async () => {
    const h = svc({ script: [reply({}, 503), reply({}, 503), reply({}, 503)] });
    h.s.want([{ coin: ETH, ts: B }]);
    await until(() => h.s.get(ETH, B)?.state === "error");
    expect(outcomes(h)).toEqual(["retry", "retry", "error"]);
    expect(h.sleeps).toEqual([2000, 4000]);
    expect(h.s.stats()).toEqual({ ...ZERO, error: 1 });
    expect(h.changes()).toBe(1);
    h.script.push(reply(priced(ETH, B)));
    expect(h.s.want([{ coin: ETH, ts: B }])).toBe(1);
    await until(() => h.s.get(ETH, B)?.state === "ok");
    expect(h.calls.length).toBe(4);
  });

  test("400/414 → error without retry, body kept", async () => {
    for (const status of [400, 414]) {
      const h = svc({ script: [raw("bad request", status)] });
      h.s.want([{ coin: ETH, ts: B }]);
      await until(() => h.s.get(ETH, B)?.state === "error");
      await ticks();
      expect(h.calls.length).toBe(1);
      expect(h.recs.length).toBe(1);
      expect(h.recs[0]).toMatchObject({ httpStatus: status, rows: null, outcome: "error" });
      expect(new TextDecoder().decode(h.recs[0].body)).toBe("bad request");
      expect(h.sleeps).toEqual([]);
    }
  });

  test("invalid JSON → error with body; failing fetch → network; never throws or rejects", async () => {
    const rej = trackRejections();
    try {
      const bad = svc({ script: [raw("<html>")] });
      bad.s.want([{ coin: ETH, ts: B }]);
      await until(() => bad.s.get(ETH, B)?.state === "error");
      expect(bad.recs[0]).toMatchObject({ httpStatus: 200, rows: null, outcome: "error" });
      expect(new TextDecoder().decode(bad.recs[0].body)).toBe("<html>");

      const thrown = { rejecting: () => Promise.reject(new TypeError("Failed to fetch")), sync: () => { throw new TypeError("boom"); } };
      for (const fn of Object.values(thrown)) {
        const h = svc({ script: [fn] });
        expect(() => h.s.want([{ coin: ETH, ts: B }])).not.toThrow();
        await until(() => h.s.get(ETH, B)?.state === "error");
        expect(h.recs.length).toBe(1);
        expect(h.recs[0]).toMatchObject({ httpStatus: null, rows: null, outcome: "network" });
        expect("body" in h.recs[0]).toBe(false);
      }

      const odd = svc();
      expect(odd.s.want(null)).toBe(0);
      expect(odd.s.want([null, {}, { coin: ETH, ts: "x" }])).toBe(0);
      await ticks();
      expect(odd.calls.length).toBe(0);
      expect(rej.count()).toBe(0);
    } finally {
      rej.off();
    }
  });

  test("cancel aborts in-flight, keeps cache, want re-requests", async () => {
    const rej = trackRejections();
    try {
      const h = svc({ script: [reply(priced(ETH, B)), hang] });
      h.s.want([{ coin: ETH, ts: B }]);
      await until(() => h.s.get(ETH, B)?.state === "ok");
      expect(h.s.want([{ coin: TOK, ts: B }])).toBe(1);
      expect(h.s.want([{ coin: TOK, ts: B2 }])).toBe(1); // queued behind the hung request
      await until(() => h.calls.length === 2);
      expect(h.limiter.size).toBe(1);
      h.s.cancel();
      expect(h.limiter.size).toBe(0);
      await until(() => h.recs.length === 2);
      expect(h.calls[1].init.signal.aborted).toBe(true);
      expect(h.recs[1]).toMatchObject({ httpStatus: null, rows: null, outcome: "network" });
      expect("body" in h.recs[1]).toBe(false);
      await ticks();
      expect(h.s.get(TOK, B)).toBeUndefined();
      expect(h.s.get(TOK, B2)).toBeUndefined();
      expect(h.s.get(ETH, B)?.state).toBe("ok");
      expect(h.changes()).toBe(1);
      expect(h.s.stats()).toEqual({ ...ZERO, ok: 1 });
      expect(h.calls.length).toBe(2); // the queued B2 request never reached fetch

      h.script.push(reply(priced(TOK, B)));
      expect(h.s.want([{ coin: TOK, ts: B }])).toBe(1);
      await until(() => h.s.get(TOK, B)?.state === "ok");
      await ticks();
      expect(h.calls.length).toBe(3);
      expect(h.calls[2].url).toBe(priceUrl(coinsOf({ [TOK]: [B] }), "30m"));
      expect(rej.count()).toBe(0);
    } finally {
      rej.off();
    }
  });

  test("cancel during backoff: the real sleep aborts, nothing published, queue freed at once", async () => {
    const calls = [], recs = [];
    const script = [reply({}, 503), reply(priced(ETH, B))];
    const s = createPriceService({
      limiter: new RateLimiter(1000),
      fetchImpl: async () => { calls.push(1); return script.shift(); },
      onQuery: (r) => { recs.push(r); },
    });
    s.want([{ coin: ETH, ts: B }]);
    await until(() => recs.length === 1);
    s.cancel(); // the default sleep is waiting the real 2000 ms backoff
    await ticks();
    expect(calls.length).toBe(1);
    expect(recs.map((r) => r.outcome)).toEqual(["retry"]);
    expect(s.get(ETH, B)).toBeUndefined();
    s.want([{ coin: ETH, ts: B }]); // would wait behind the 2 s backoff if the sleep ignored the abort
    await until(() => s.get(ETH, B)?.state === "ok");
    expect(calls.length).toBe(2);
  });

  test("cancel while the retry is being logged: the sleep starts aborted, queue freed at once", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const calls = [], recs = [];
    const script = [reply({}, 503), reply(priced(ETH, B))];
    const s = createPriceService({
      limiter: new RateLimiter(1000),
      fetchImpl: async () => { calls.push(1); return script.shift(); },
      onQuery: (r) => { recs.push(r); return recs.length === 1 ? gate : undefined; },
    });
    s.want([{ coin: ETH, ts: B }]);
    await until(() => recs.length === 1);
    s.cancel();
    release();
    await ticks();
    expect(s.get(ETH, B)).toBeUndefined();
    s.want([{ coin: ETH, ts: B }]);
    await until(() => s.get(ETH, B)?.state === "ok");
    expect(calls.length).toBe(2);
    expect(recs.map((r) => r.outcome)).toEqual(["retry", "ok"]);
  });

  test("clear discards in-flight and empties cache", async () => {
    const h = svc({ script: [reply(priced(ETH, B)), hang] });
    h.s.want([{ coin: ETH, ts: B }]);
    await until(() => h.s.get(ETH, B)?.state === "ok");
    h.s.want([{ coin: TOK, ts: B }]);
    await until(() => h.calls.length === 2);
    h.s.clear();
    await until(() => h.recs.length === 2);
    expect(h.recs[1]).toMatchObject({ httpStatus: null, rows: null, outcome: "network" });
    expect("body" in h.recs[1]).toBe(false);
    await ticks();
    expect(h.s.get(ETH, B)).toBeUndefined();
    expect(h.s.get(TOK, B)).toBeUndefined();
    expect(h.s.stats()).toEqual(ZERO);
    expect(h.changes()).toBe(1);
  });

  test("allowed re-filters just before send", async () => {
    const h = svc({ script: [reply(priced(ETH, B))], allowed: (c) => c !== "ethereum:" + C });
    expect(h.s.want([{ coin: ETH, ts: B }, { coin: TOK, ts: B }])).toBe(2);
    await until(() => h.s.get(ETH, B)?.state === "ok");
    expect(h.calls.length).toBe(1);
    expect(h.calls[0].url.includes(C)).toBe(false);
    expect(h.recs[0].params.coins).toBe(coinsOf({ [ETH]: [B] }));
    expect(h.s.get(TOK, B)).toBeUndefined();

    const none = svc({ allowed: () => false });
    none.s.want([{ coin: ETH, ts: B }, { coin: TOK, ts: B }]);
    await ticks();
    expect(none.calls.length).toBe(0);
    expect(none.recs.length).toBe(0);
    expect(none.s.stats()).toEqual(ZERO);

    const throwing = svc({ allowed: () => { throw new Error("store gone"); } }); // fail closed
    expect(() => throwing.s.want([{ coin: TOK, ts: B }])).not.toThrow();
    await ticks();
    expect(throwing.calls.length).toBe(0);
    expect(throwing.s.get(TOK, B)).toBeUndefined();

    // a contract that became a root after want() is dropped when its queued request is about to be sent
    let release, rootNow = false;
    const gate = new Promise((r) => (release = r));
    const late = svc({ script: [reply(priced(ETH, B))], hold: () => gate, allowed: (c) => !(rootNow && c === TOK) });
    late.s.want([{ coin: ETH, ts: B }]);
    expect(late.s.want([{ coin: TOK, ts: B }])).toBe(1);
    rootNow = true;
    release();
    await until(() => late.s.stats().pending === 0);
    await ticks();
    expect(late.calls.length).toBe(1);
    expect(late.calls.some((c) => c.url.includes(C))).toBe(false);
    expect(late.s.get(TOK, B)).toBeUndefined();
    expect(late.changes()).toBe(2); // ETH published + TOK reverted to unrequested
  });

  test("allowed re-checked before each retry: a pair that became a root during the backoff is never resent", async () => {
    let rootNow = false;
    const h = svc({
      script: [() => { rootNow = true; return reply({}, 503); }, reply(priced(ETH, B))],
      allowed: (c) => !(rootNow && c === TOK),
    });
    h.s.want([{ coin: ETH, ts: B }, { coin: TOK, ts: B }]);
    await until(() => h.s.stats().pending === 0);
    await ticks();
    expect(h.calls.length).toBe(1);
    expect(outcomes(h)).toEqual(["retry"]);
    expect(h.s.get(TOK, B)).toBeUndefined();
    expect(h.s.get(ETH, B)).toEqual({ state: "error" });
    expect(h.changes()).toBe(1);
    // the remaining pair is re-requested later, re-filtered, under a fresh URL
    expect(h.s.want([{ coin: ETH, ts: B }])).toBe(1);
    await until(() => h.s.get(ETH, B)?.state === "ok");
    expect(h.calls.length).toBe(2);
    expect(h.calls[1].url).toBe(priceUrl(coinsOf({ [ETH]: [B] }), "30m"));

    // stale generation: cancel during the backoff publishes nothing, even when a pair flipped
    let flip = false, c;
    c = svc({
      script: [reply({}, 503)],
      allowed: (coin) => !(flip && coin === TOK),
      hold: (r) => { if (r.outcome === "retry") { flip = true; c.s.cancel(); } },
    });
    c.s.want([{ coin: ETH, ts: B }, { coin: TOK, ts: B }]);
    await until(() => c.recs.length === 1);
    await ticks();
    expect(c.calls.length).toBe(1);
    expect(c.s.stats()).toEqual(ZERO);
    expect(c.changes()).toBe(0);
  });

  test("Retry-After is capped at maxRetryWaitMs", async () => {
    const h = svc({ script: [reply({}, 429, { "Retry-After": "86400" }), reply(priced(ETH, B))] });
    h.s.want([{ coin: ETH, ts: B }]);
    await until(() => h.s.get(ETH, B)?.state === "ok");
    expect(h.sleeps).toEqual([60_000]);
  });

  test("own limiter: one service's cancel leaves another's queue intact", async () => {
    let finishB;
    const a = svc({ script: [hang] });
    const b = svc({ script: [() => new Promise((r) => (finishB = r)), reply(priced(TOK, B))] });
    a.s.want([{ coin: ETH, ts: B }]);
    b.s.want([{ coin: ETH, ts: B }]);
    b.s.want([{ coin: TOK, ts: B }]);
    await until(() => a.calls.length === 1 && b.calls.length === 1);
    a.s.cancel();
    await until(() => a.recs.length === 1);
    finishB(reply(priced(ETH, B)));
    await until(() => b.s.get(TOK, B)?.state === "ok");
    expect(b.calls.length).toBe(2);
    expect(b.s.get(ETH, B)?.state).toBe("ok");
  });

  test("default fetch is resolved at each request, not at creation", async () => {
    const orig = globalThis.fetch;
    const s = createPriceService({ limiter: new RateLimiter(1000), sleep: async () => {} });
    const seen = [];
    globalThis.fetch = async (url) => { seen.push(url); return reply({ coins: {} }); };
    try {
      s.want([{ coin: ETH, ts: B }]);
      await until(() => s.get(ETH, B)?.state === "none");
      expect(seen).toEqual([priceUrl(coinsOf({ [ETH]: [B] }), "30m")]);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
