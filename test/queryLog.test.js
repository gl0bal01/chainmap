import { describe, test, expect } from "bun:test";
import { createQueryLog, sanitizeQueryLog, windowOf, PARAM_KEYS } from "../src/queryLog.js";
import { API_BASE, PRICE_API, LLAMA_CHAINS } from "../src/config.js";
import { priceUrl } from "../src/usdPrice.js";

const P = { chainid: "1", module: "account", action: "txlist", address: "0x" + "a".repeat(40), startblock: "0", endblock: "99999999", page: "1", offset: "20", sort: "desc" };
const rec = (over) => ({ at: "2026-11-16T10:00:00.000Z", chainId: "1", action: "txlist", params: { ...P }, httpStatus: 200, rows: 2, outcome: "ok", ...over });
const at = (n) => `2026-11-16T10:00:00.00${n}Z`;
const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const bytes = () => new TextEncoder().encode("abc");
const entry = async (over) => { const l = createQueryLog(); await l.add(rec(over)); return l.entries()[0]; };

describe("queryLog", () => {
  test("add -> entry shape", async () => {
    const e = await entry();
    expect(Object.keys(e).sort()).toEqual(["action", "at", "chainId", "httpStatus", "outcome", "params", "rows", "sha256", "url"]);
    expect(e.url).toBe(API_BASE + "?chainid=1&module=account&action=txlist&address=0x" + "a".repeat(40) + "&startblock=0&endblock=99999999&page=1&offset=20&sort=desc");
  });

  test("apikey never stored", async () => {
    const l = createQueryLog();
    await l.add(rec({ params: { ...P, apikey: "SECRETKEY" } }));
    const s = JSON.stringify(l.toJSON());
    expect(s).not.toContain("SECRETKEY");
    expect(s).not.toContain("apikey");
  });

  test("hash vector", async () => {
    expect((await entry({ body: bytes() })).sha256).toBe(ABC);
    expect((await entry({ body: bytes().buffer })).sha256).toBe(ABC);
  });

  test("hash failure -> null", async () => {
    expect((await entry()).sha256).toBeNull();
    const orig = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true, writable: true });
    try {
      expect((await entry({ body: bytes() })).sha256).toBeNull();
    } finally {
      Object.defineProperty(globalThis, "crypto", orig);
    }
  });

  test("limit drops oldest", async () => {
    const l = createQueryLog({ limit: 3 });
    for (let i = 1; i <= 5; i++) await l.add(rec({ at: at(i) }));
    expect(l.entries().map((e) => e.at)).toEqual([at(3), at(4), at(5)]);
    expect(l.dropped).toBe(2);
  });

  test("clear / markUnlogged / load", async () => {
    const l = createQueryLog();
    await l.add(rec());
    l.markUnlogged();
    expect(l.unloggedData).toBe(true);
    l.clear();
    expect([l.entries(), l.dropped, l.unloggedData]).toEqual([[], 0, false]);
    const e = await entry();
    const arr = [e];
    l.load({ entries: arr, dropped: 4, unloggedData: true });
    arr.push(e);
    expect([l.entries().length, l.dropped, l.unloggedData]).toEqual([1, 4, true]);
  });

  test("add straddling clear() is discarded", async () => {
    const l = createQueryLog();
    const p = l.add(rec({ body: bytes() }));
    l.clear();
    await p;
    expect(l.entries().length).toBe(0);
  });

  test("add with a stale epoch is discarded (request issued before clear/load)", async () => {
    const l = createQueryLog();
    const e0 = l.epoch;
    l.clear();
    await l.add(rec(), e0);
    expect(l.entries().length).toBe(0);
    await l.add(rec(), l.epoch);
    expect(l.entries().length).toBe(1);
    const e1 = l.epoch;
    l.load({ entries: [], dropped: 0, unloggedData: false });
    await l.add(rec(), e1);
    expect(l.entries().length).toBe(0);
    await l.add(rec()); // no epoch given: the current one
    expect(l.entries().length).toBe(1);
  });

  test("window", async () => {
    const l = createQueryLog();
    expect(l.window()).toBeNull();
    await l.add(rec({ at: at(5) }));
    await l.add(rec({ at: at(2) }));
    expect(l.window()).toEqual({ first: at(2), last: at(5) });
    expect(Object.keys(l.toJSON())).toEqual(["entries", "dropped", "unloggedData"]);
  });

  test("sanitize: valid round-trip", async () => {
    const l = createQueryLog();
    await l.add(rec({ body: bytes() }));
    await l.add(rec({ at: at(1) }));
    await l.add(rec({ at: at(2), action: "token1155tx", params: { ...P, action: "token1155tx" } })); // digits in a real action
    const s = sanitizeQueryLog({ ...l.toJSON(), unloggedData: false });
    expect(s.entries).toEqual(l.entries());
    expect(s.invalid).toBe(0);
    expect(s.unloggedData).toBe(false);
  });

  test("sanitize: each bad field -> dropped + invalid", async () => {
    const good = await entry();
    const bad = [
      { at: "2026-11-16 10:00:00" }, { chainId: "0x1" }, { action: "TXLIST" },
      { params: { ...good.params, address: "0x<script>" } }, { httpStatus: 42 }, { httpStatus: "200" },
      { rows: -1 }, { sha256: "ABC" }, { outcome: "maybe" }, { params: [] },
    ].map((o) => ({ ...good, ...o }));
    const s = sanitizeQueryLog({ entries: bad, dropped: 0, unloggedData: false });
    expect(s.entries.length).toBe(0);
    expect(s.invalid).toBe(10);
    expect(s.unloggedData).toBe(true);
  });

  test("sanitize: impossible dates rejected; `at` normalised to millisecond ISO so windowOf sorts right", async () => {
    const good = await entry();
    const bad = ["2026-99-16T10:00:00.000Z", "2026-02-30T10:00:00Z", "2026-11-16T24:00:00Z", "2026-11-16T10:61:00Z"];
    const s = sanitizeQueryLog({ entries: bad.map((a) => ({ ...good, at: a })) });
    expect([s.entries.length, s.invalid]).toEqual([0, 4]);
    const ok = sanitizeQueryLog({ entries: [{ ...good, at: "2026-11-16T10:00:00Z" }, { ...good, at: "2026-11-16T10:00:00.5Z" }] });
    expect(ok.entries.map((e) => e.at)).toEqual(["2026-11-16T10:00:00.000Z", "2026-11-16T10:00:00.500Z"]);
    expect(windowOf(ok.entries)).toEqual({ first: "2026-11-16T10:00:00.000Z", last: "2026-11-16T10:00:00.500Z" });
  });

  test("sanitize: params.chainid / params.action must agree with chainId / action", async () => {
    const good = await entry();
    const { chainid, action, ...rest } = good.params;
    const s = sanitizeQueryLog({
      entries: [
        { ...good, params: { ...good.params, chainid: "137" } },
        { ...good, params: { ...good.params, action: "tokentx" } },
        { ...good, params: rest }, // absent keys are fine
      ],
    });
    expect([s.entries.length, s.invalid]).toEqual([1, 2]);
    expect(s.entries[0].params).toEqual(rest);
  });

  test("sanitize: url rebuilt", async () => {
    const good = await entry();
    const s = sanitizeQueryLog({ entries: [{ ...good, url: "https://evil.example/?apikey=K", params: { ...good.params, apikey: "K", extra: "x" } }] });
    const e = s.entries[0];
    expect(e.url.startsWith(API_BASE + "?")).toBe(true);
    expect(e.url).not.toContain("evil");
    expect(Object.keys(e.params)).toEqual(PARAM_KEYS);
  });

  test("sanitize: __proto__", async () => {
    const good = await entry();
    const json = JSON.stringify(good).replace(/^\{/, '{"__proto__":{"polluted":1},').replace('"params":{', '"params":{"__proto__":{"x":1},');
    const s = sanitizeQueryLog(JSON.parse(`{"entries":[${json}]}`));
    const e = s.entries[0];
    expect(Object.getPrototypeOf(e)).toBe(Object.prototype);
    expect(e.polluted).toBeUndefined();
    expect({}.polluted).toBeUndefined();
  });

  test("sanitize: non-object input", () => {
    for (const v of [null, "x", [], {}, { entries: "no" }])
      expect(sanitizeQueryLog(v)).toEqual({ entries: [], dropped: 0, unloggedData: true, invalid: 0 });
  });

  test("sanitize: unloggedData", async () => {
    const good = await entry();
    const u = (v) => sanitizeQueryLog({ entries: [good], unloggedData: v }).unloggedData;
    expect([u(true), u("false"), u(0), u(undefined)]).toEqual([true, true, true, true]);
    expect(u(false)).toBe(false);
  });

  test("sanitize: oversized", async () => {
    const good = await entry();
    const entries = Array.from({ length: 5003 }, (_, i) => ({ ...good, rows: i }));
    const s = sanitizeQueryLog({ entries, dropped: 7 });
    expect(s.entries.length).toBe(5000);
    expect(s.entries[0].rows).toBe(3);
    expect(s.dropped).toBe(10);
  });
});

const COINS = '{"coingecko:ethereum":[1700002800],"ethereum:0x' + "ab".repeat(20) + '":[1700002800,1700006400]}';
const prec = (over) => ({
  at: "2026-11-16T10:00:00.000Z", source: "defillama", action: "batchHistorical",
  params: { coins: COINS, searchWidth: "30m" }, httpStatus: 200, rows: 3, outcome: "ok", body: bytes(), ...over,
});
const pentry = async (over) => { const l = createQueryLog(); await l.add(prec(over)); return l.entries()[0]; };

describe("defillama entries", () => {
  test("add rebuilds a defillama entry", async () => {
    const shared = { coins: COINS, searchWidth: "30m", apikey: "K", address: "0x" + "a".repeat(40) };
    const e = await pentry({ params: shared });
    expect(e).toEqual({
      at: "2026-11-16T10:00:00.000Z", source: "defillama", chainId: null, action: "batchHistorical",
      params: { coins: COINS, searchWidth: "30m" }, url: priceUrl(COINS, "30m"),
      httpStatus: 200, rows: 3, sha256: ABC, outcome: "ok",
    });
    expect(JSON.stringify(e)).not.toContain("apikey");
    expect(e.params).not.toBe(shared);
    expect(Object.keys(shared)).toEqual(["coins", "searchWidth", "apikey", "address"]);
  });

  test("etherscan entries unchanged", async () => {
    const e = await entry();
    expect(Object.keys(e)).toEqual(["at", "chainId", "action", "params", "url", "httpStatus", "rows", "sha256", "outcome"]);
  });

  test("sanitize round-trip", async () => {
    const l = createQueryLog();
    await l.add(rec()); await l.add(prec()); await l.add(rec({ body: bytes() }));
    expect(sanitizeQueryLog(l.toJSON())).toEqual({ ...l.toJSON(), invalid: 0 });
  });

  test("url always rebuilt", async () => {
    const e = await pentry();
    const s = sanitizeQueryLog({ entries: [{ ...e, url: "https://evil.example/x" }], dropped: 0, unloggedData: false });
    expect(s.invalid).toBe(0);
    expect(s.entries[0].url).toBe(priceUrl(COINS, "30m"));
    expect(s.entries[0].url.startsWith(PRICE_API)).toBe(true);
  });

  test("every LLAMA_CHAINS coin id passes", async () => {
    const o = {};
    for (const c of Object.values(LLAMA_CHAINS)) {
      for (const n of c.native || []) o[n.coin] = [1700002800];
      if (c.slug) o[c.slug + ":0x" + "ab".repeat(20)] = [1700002800];
    }
    const coins = JSON.stringify(o);
    expect(Object.keys(o).length).toBeLessThanOrEqual(400);
    const e = await pentry({ params: { coins, searchWidth: "30m" } });
    const s = sanitizeQueryLog({ entries: [e], dropped: 0, unloggedData: false });
    expect(s.invalid).toBe(0);
    expect(s.entries[0]).toEqual(e);
  });

  const many = JSON.stringify(Object.fromEntries(Array.from({ length: 401 }, (_, i) => ["coingecko:c" + i, [1]])));
  const cases = {
    "chainId string": { chainId: "1" },
    "action txlist": { action: "txlist" },
    "source other": { source: "other" },
    "no coins": { params: { searchWidth: "30m" } },
    "uppercase address": { params: { coins: '{"ethereum:0xAB' + "ab".repeat(19) + '":[1]}', searchWidth: "30m" } },
    "space in key": { params: { coins: '{"hello world":[1]}', searchWidth: "30m" } },
    "? in key": { params: { coins: '{"a:b?c":[1]}', searchWidth: "30m" } },
    "/ in key": { params: { coins: '{"a:b/c":[1]}', searchWidth: "30m" } },
    "& in key": { params: { coins: '{"a:b&c":[1]}', searchWidth: "30m" } },
    "401 keys": { params: { coins: many, searchWidth: "30m" } },
    "__proto__": { params: { coins: '{"__proto__":[1]}', searchWidth: "30m" } },
    "ts -1": { params: { coins: '{"coingecko:a":[-1]}', searchWidth: "30m" } },
    "ts 1.5": { params: { coins: '{"coingecko:a":[1.5]}', searchWidth: "30m" } },
    "ts string": { params: { coins: '{"coingecko:a":["1700002800"]}', searchWidth: "30m" } },
    "empty ts array": { params: { coins: '{"coingecko:a":[]}', searchWidth: "30m" } },
    "array coins": { params: { coins: "[]", searchWidth: "30m" } },
    "whitespace json": { params: { coins: '{"coingecko:ethereum": [1]}', searchWidth: "30m" } },
    "non-string coins": { params: { coins: { a: 1 }, searchWidth: "30m" } },
    "8001-char coins": { params: { coins: '{"coingecko:a":[' + "1,".repeat(3991) + "1]}", searchWidth: "30m" } },
    "searchWidth 1y+space": { params: { coins: COINS, searchWidth: "1y " } },
    "searchWidth injection": { params: { coins: COINS, searchWidth: "30m&x=1" } },
    "rows -1": { rows: -1 },
  };
  test.each(Object.entries(cases))("invalid: %s", async (_n, over) => {
    const e = await pentry();
    const bad = { ...e, ...over, params: over.params ?? e.params };
    if (over.params) bad.params = { ...over.params };
    expect(sanitizeQueryLog({ entries: [bad], dropped: 0, unloggedData: false }).invalid).toBe(1);
  });
});
