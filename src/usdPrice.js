// usdPrice.js — pure, DOM-free; the ONLY place that decides what may be sent to the price provider.
// priceKeyFor reads only chainId, action, tokenContract, value, amountIndeterminate, tokenDecimal, timeStamp
// (the edge itself goes to the injected predicates). Never from / to / hash.
import { PRICE_API, PRICE_FETCH, LLAMA_CHAINS } from "./config.js";
import { parseRetryAfter } from "./etherscanClient.js";

const NATIVE = new Set(["txlist", "txlistinternal"]);
const NFT = new Set(["tokennfttx", "token1155tx"]);

/** Nearest hour, half up. */
export function hourBucket(ts) {
  return Math.round(ts / PRICE_FETCH.bucketSec) * PRICE_FETCH.bucketSec;
}

export function decimalsFor(edge) {
  if (NATIVE.has(edge.action)) return 18;
  const d = edge.tokenDecimal;
  if (typeof d !== "string" || !/^\d{1,2}$/.test(d)) return null;
  const n = Number(d);
  return n <= 77 ? n : null;
}

/** @returns {{coin:string, ts:number} | {skip:string}} */
export function priceKeyFor(edge, ctx) {
  const chain = Object.hasOwn(LLAMA_CHAINS, edge.chainId) ? LLAMA_CHAINS[edge.chainId] : null;
  if (!chain) return { skip: "chain" };
  const action = edge.action;
  if (NFT.has(action)) return { skip: "nft" };
  const native = NATIVE.has(action);
  if (!native && action !== "tokentx") return { skip: "data" };
  const { value, timeStamp } = edge;
  if (edge.amountIndeterminate || typeof value !== "string" || !/^\d+$/.test(value)) return { skip: "data" };
  if (typeof timeStamp !== "string" || !/^\d+$/.test(timeStamp) || !Number(timeStamp)) return { skip: "data" };
  if (decimalsFor(edge) === null) return { skip: "data" };
  if (BigInt(value) === 0n) return { skip: "zero" };
  const raw = Number(timeStamp);
  const ts = hourBucket(raw);
  if (!Number.isSafeInteger(raw) || !Number.isSafeInteger(ts)) return { skip: "data" };
  let coin;
  if (native) {
    if (!chain.native) return { skip: "chain" };
    const hit = chain.native.find((n) => n.before === undefined || raw < n.before);
    if (!hit) return { skip: "chain" };
    coin = hit.coin;
  } else {
    if (!chain.slug) return { skip: "chain" };
    const contract = String(edge.tokenContract ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(contract)) return { skip: "data" };
    if (ctx.isFakeToken(edge)) return { skip: "imitation" };
    if (ctx.isSpam(edge)) return { skip: "spam" };
    if (ctx.isRoot(edge.chainId, contract)) return { skip: "root" };
    coin = chain.slug + ":" + contract;
  }
  return { coin, ts };
}

/** Exact rational from the number's shortest round-trip string. */
export function priceToRational(p) {
  if (typeof p !== "number" || !Number.isFinite(p) || p <= 0) return null;
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(p));
  if (!m) return null;
  let num = BigInt(m[1] + (m[2] || ""));
  let den = 10n ** BigInt((m[2] || "").length);
  const e = Number(m[3] || 0);
  if (e > 0) num *= 10n ** BigInt(e);
  else den *= 10n ** BigInt(-e);
  return { num, den };
}

/** Half-up cents of value / 10^decimals * price. */
export function usdCents(value, decimals, r) {
  const n = BigInt(value) * r.num * 100n;
  const d = r.den * 10n ** BigInt(decimals);
  return (2n * n + d) / (2n * d);
}

export function usdText(cents) {
  if (cents === 0n) return "<0.01";
  const s = cents.toString().padStart(3, "0");
  return s.slice(0, -2) + "." + s.slice(-2);
}

/** Display only (grouping per locale); BigInt-safe, no Number on the amount. */
export function formatUsdDisplay(text, locale) {
  if (text.startsWith("<")) return "< 0.01";
  const parts = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).formatToParts(1234567.5);
  const group = parts.find((p) => p.type === "group")?.value ?? ",";
  const decimal = parts.find((p) => p.type === "decimal")?.value ?? ".";
  const [int, frac = ""] = text.split(".");
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, group) + decimal + frac;
}

export function priceUrl(coins, searchWidth) {
  return PRICE_API + "/batchHistorical?coins=" + encodeURIComponent(coins) + "&searchWidth=" + encodeURIComponent(searchWidth);
}

/** Canonical JSON {coin:[ts,...]}: sorted coins, sorted unique ts. */
function coinsJson(pairs) {
  const by = new Map();
  for (const { coin, ts } of pairs) {
    if (!by.has(coin)) by.set(coin, new Set());
    by.get(coin).add(ts);
  }
  const out = {};
  for (const coin of [...by.keys()].sort()) out[coin] = [...by.get(coin)].sort((a, b) => a - b);
  return JSON.stringify(out);
}

/** Group + split under maxUrlChars. */
export function buildRequests(keys) {
  const uniq = new Map();
  for (const k of keys) uniq.set(k.coin + "@" + k.ts, { coin: k.coin, ts: k.ts });
  const sorted = [...uniq.values()].sort((a, b) => (a.coin < b.coin ? -1 : a.coin > b.coin ? 1 : a.ts - b.ts));
  const out = [];
  const enc = (str) => encodeURIComponent(str).length; // additive over concatenation
  const base = priceUrl("{}", PRICE_FETCH.searchWidth).length;
  let cur = [], len = base, last = null;
  // O(n): URL length is tracked incrementally (input is sorted, so each coin's hours are contiguous).
  for (const p of sorted) {
    const add = p.coin === last ? enc("," + p.ts) : enc((cur.length ? "," : "") + JSON.stringify(p.coin) + ":[" + p.ts + "]");
    if (cur.length && len + add > PRICE_FETCH.maxUrlChars) {
      out.push({ coins: coinsJson(cur), pairs: cur });
      cur = [];
      len = base;
      last = null;
      cur.push(p);
      len += enc(JSON.stringify(p.coin) + ":[" + p.ts + "]");
    } else {
      cur.push(p);
      len += add;
    }
    last = p.coin;
  }
  if (cur.length) out.push({ coins: coinsJson(cur), pairs: cur });
  return out;
}

/** @returns {Map<string, {price:number, at:number, confidence:number|null}|null>} */
export function parseBatchResponse(json, pairs) {
  const result = new Map(pairs.map((p) => [p.coin + "@" + p.ts, null]));
  const coins = json && typeof json === "object" && json.coins && typeof json.coins === "object" ? json.coins : {};
  for (const coin of new Set(pairs.map((p) => p.coin))) {
    const key = Object.keys(coins).find((k) => k.toLowerCase() === coin);
    const prices = key !== undefined ? coins[key]?.prices : null;
    if (!Array.isArray(prices)) continue;
    const bestDist = new Map();
    for (const pt of prices) {
      if (!pt || typeof pt.timestamp !== "number" || !Number.isFinite(pt.timestamp)) continue;
      if (typeof pt.price !== "number" || !Number.isFinite(pt.price) || pt.price <= 0) continue;
      let conf = null;
      if (pt.confidence !== undefined && pt.confidence !== null) {
        if (typeof pt.confidence !== "number" || !(pt.confidence >= PRICE_FETCH.minConfidence)) continue;
        conf = pt.confidence;
      }
      const b = hourBucket(pt.timestamp);
      const k = coin + "@" + b;
      const dist = Math.abs(pt.timestamp - b);
      if (!result.has(k) || dist > PRICE_FETCH.windowSec) continue;
      if (bestDist.has(k) && bestDist.get(k) <= dist) continue;
      bestDist.set(k, dist);
      result.set(k, { price: pt.price, at: pt.timestamp, confidence: conf });
    }
  }
  return result;
}

/** The one valuation for details, CSV and MANIFEST counts. Never mutates the edge. */
export function usdForEdge(edge, ctx, get) {
  const key = priceKeyFor(edge, ctx);
  if ("skip" in key) return { state: "skip", reason: key.skip };
  const st = get(key.coin, key.ts);
  if (!st || st.state === "pending") return { state: "pending" };
  if (st.state !== "ok") return { state: st.state };
  const r = priceToRational(st.price);
  if (!r) return { state: "none" };
  const cents = usdCents(edge.value, decimalsFor(edge), r);
  return { state: "ok", cents, text: usdText(cents), price: st.price, at: st.at, confidence: st.confidence };
}

export function usdCounts(edges, usdFn) {
  let priced = 0, priceable = 0;
  for (const e of edges) {
    const r = usdFn(e);
    if (r.state === "skip") continue;
    priceable++;
    if (r.state === "ok") priced++;
  }
  return { priced, priceable };
}

/** Real backoff timer; rejects as soon as `signal` aborts. */
function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** @typedef {{ state:'pending'|'ok'|'none'|'error', price?:number, at?:number, confidence?:number|null }} PriceState */

/**
 * Background price fetcher on its own limiter. A state is published only after its request's onQuery resolved
 * (log-before-show). cancel()/clear() bump the generation: older results are never published. Never rejects;
 * want() never throws.
 * @param {{ fetchImpl?:typeof fetch, onQuery?:(rec:object)=>(void|Promise<void>), limiter:import("./rateLimiter.js").RateLimiter,
 *   allowed?:(coin:string)=>boolean, sleep?:(ms:number, signal:AbortSignal)=>Promise<void> }} opts
 */
export function createPriceService({ fetchImpl, onQuery, limiter, allowed, sleep = abortableSleep }) {
  const fetchFn = fetchImpl ?? ((...a) => globalThis.fetch(...a)); // resolved per request
  const states = new Map(); // "coin@ts" -> PriceState
  const listeners = new Set();
  let gen = 0;
  let inflight = null;
  const id = (p) => p.coin + "@" + p.ts;
  const notify = () => {
    for (const fn of listeners) {
      try { fn(); } catch {}
    }
  };
  const isAllowed = (coin) => {
    try { return !allowed || !!allowed(coin); } catch { return false; } // fail closed
  };

  async function send(req, myGen) {
    if (myGen !== gen) return;
    const pairs = [];
    for (const p of req.pairs) {
      if (isAllowed(p.coin)) pairs.push(p);
      else states.delete(id(p)); // reverts to unrequested; never sent
    }
    if (!pairs.length) return notify();
    const coins = coinsJson(pairs);
    const params = { coins, searchWidth: PRICE_FETCH.searchWidth };
    const url = priceUrl(coins, PRICE_FETCH.searchWidth);
    const log = async (fields) => {
      try {
        await onQuery?.({ at: new Date().toISOString(), source: "defillama", action: "batchHistorical", params, ...fields });
      } catch {}
    };
    /** @param {Map|null} results parseBatchResponse output; null → every pair failed. Skipped for an old generation. */
    const publish = (results) => {
      if (myGen !== gen) return;
      for (const p of pairs) {
        const r = results?.get(id(p));
        states.set(id(p), !results ? { state: "error" } : r ? { state: "ok", ...r } : { state: "none" });
      }
      notify();
    };

    for (let attempt = 1; myGen === gen; attempt++) {
      // R5 before EACH request: a pair that turned root during the backoff ends this send. It reverts to
      // unrequested; the rest become error, so a later want re-requests them re-filtered, under a fresh URL.
      const ok = attempt > 1 && pairs.map((p) => isAllowed(p.coin));
      if (ok && ok.includes(false)) {
        pairs.forEach((p, i) => (ok[i] ? states.set(id(p), { state: "error" }) : states.delete(id(p))));
        return notify();
      }
      const ctrl = (inflight = new AbortController());
      const timer = setTimeout(() => ctrl.abort(), PRICE_FETCH.timeoutMs);
      let resp, bytes;
      try {
        resp = await fetchFn(url, { credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", signal: ctrl.signal });
        // Read bytes once: the logged hash covers exactly what was parsed.
        if (resp.status !== 429 && resp.status < 500) bytes = new Uint8Array(await resp.arrayBuffer());
      } catch {
        resp = null; // cancel/clear/timeout abort, network failure, unreadable body
      }
      clearTimeout(timer);
      if (!resp) {
        await log({ httpStatus: null, rows: null, outcome: "network" });
        return publish(null);
      }
      const httpStatus = resp.status;
      if (httpStatus === 429 || httpStatus >= 500) {
        const last = attempt >= PRICE_FETCH.maxRetries;
        await log({ httpStatus, rows: null, outcome: last ? "error" : "retry" });
        if (last) return publish(null);
        try {
          await sleep(Math.min(parseRetryAfter(resp.headers) ?? PRICE_FETCH.backoffBaseMs * attempt, PRICE_FETCH.maxRetryWaitMs), ctrl.signal);
        } catch {} // aborted by cancel()/clear(): the loop guard ends this send unpublished
        continue;
      }
      let json; // stays undefined for a non-2xx (400/414…: no retry) or an unparseable body
      try {
        if (httpStatus >= 200 && httpStatus <= 299) json = JSON.parse(new TextDecoder().decode(bytes));
      } catch {}
      if (json === undefined) {
        await log({ httpStatus, rows: null, outcome: "error", body: bytes });
        return publish(null);
      }
      const results = parseBatchResponse(json, pairs);
      let rows = 0;
      for (const v of results.values()) if (v) rows++;
      await log({ httpStatus, rows, outcome: "ok", body: bytes });
      return publish(results);
    }
  }

  function reset() {
    gen++;
    limiter.clear(); // queued sends reject; want() swallows that
    inflight?.abort();
  }

  return {
    /** Marks unrequested/error pairs pending and queues them. @returns {number} pairs newly marked pending */
    want(keys) {
      const fresh = [];
      for (const k of Array.isArray(keys) ? keys : []) {
        if (typeof k?.coin !== "string" || !Number.isSafeInteger(k.ts)) continue;
        const st = states.get(id(k));
        if (st && st.state !== "error") continue;
        states.set(id(k), { state: "pending" });
        fresh.push({ coin: k.coin, ts: k.ts });
      }
      const myGen = gen;
      for (const req of buildRequests(fresh)) limiter.run(() => send(req, myGen)).catch(() => {});
      return fresh.length;
    },
    get: (coin, ts) => states.get(coin + "@" + ts),
    /** Stop: keep ok/none, drop pending/error (they revert to unrequested). */
    cancel() {
      reset();
      for (const [k, st] of states) if (st.state === "pending" || st.state === "error") states.delete(k);
    },
    clear() {
      reset();
      states.clear();
    },
    onChange(fn) {
      listeners.add(fn);
    },
    stats() {
      const s = { pending: 0, ok: 0, none: 0, error: 0 };
      for (const st of states.values()) s[st.state]++;
      return s;
    },
  };
}
