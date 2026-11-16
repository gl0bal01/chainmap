import { describe, test, expect } from "bun:test";
import {
  hourBucket, decimalsFor, priceKeyFor, priceToRational, usdCents, usdText, formatUsdDisplay,
  priceUrl, buildRequests, parseBatchResponse, usdForEdge, usdCounts,
} from "../src/usdPrice.js";
import { PRICE_API } from "../src/config.js";

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
