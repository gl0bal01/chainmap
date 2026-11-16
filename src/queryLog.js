// =============================================================================
// queryLog.js — in-memory log of Etherscan queries (evidence exports).
// DOM-free, Node-testable. Never stores the API key: params are rebuilt from
// PARAM_KEYS only. Bodies are hashed (SHA-256), not kept.
// `sanitizeQueryLog` is the workspace trust boundary: every entry is rebuilt
// from scratch, nothing from the input object is spread or copied through.
// =============================================================================

import { API_BASE, LIMITS } from "./config.js";
import { parseChainId } from "./format.js";
import { priceUrl } from "./usdPrice.js";

export const PARAM_KEYS = ["chainid", "module", "action", "address", "startblock", "endblock", "page", "offset", "sort"];
export const PRICE_PARAM_KEYS = ["coins", "searchWidth"];
export const OUTCOMES = ["ok", "retry", "error", "network"];

const AT_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/;
const ACTION_RE = /^[a-z0-9]{1,32}$/; // token1155tx has digits
const PARAM_RE = /^[0-9A-Za-z]{0,66}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const WIDTH_RE = /^\d{1,4}[mhdw]?$/;
const COIN_RE = /^(?:[a-z0-9_-]{1,40}:0x[0-9a-f]{40}|coingecko:[a-z0-9-]{1,64})$/;
const MAX_COINS_CHARS = 8000;
const MAX_COIN_KEYS = 400;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** @param {ArrayBuffer|Uint8Array} bytes @returns {Promise<string>} lowercase hex */
export async function sha256Hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Canonical request URL from the known params only (present keys, fixed order). */
export function queryUrl(params) {
  const q = new URLSearchParams();
  for (const k of PARAM_KEYS) if (has(params, k)) q.append(k, String(params[k]));
  return API_BASE + "?" + q;
}

/** @returns {{first:string,last:string}|null} min/max `at` (ISO-Z strings sort lexically). */
export function windowOf(entries) {
  if (!entries.length) return null;
  let first = entries[0].at, last = first;
  for (const e of entries) {
    if (e.at < first) first = e.at;
    if (e.at > last) last = e.at;
  }
  return { first, last };
}

export function createQueryLog({ limit = LIMITS.queryLog } = {}) {
  let list = [];
  let dropped = 0;
  let unlogged = false;
  let gen = 0;

  const api = {
    // `epoch` = the log's generation when the request was issued (main reads it at
    // client creation): a request in flight across clear()/load() never lands in the new log.
    async add(rec, epoch = gen) {
      try {
        const my = epoch;
        const price = rec.source === "defillama";
        const params = {};
        for (const k of price ? PRICE_PARAM_KEYS : PARAM_KEYS) if (rec.params && has(rec.params, k)) params[k] = String(rec.params[k]);
        let sha256 = null;
        if (rec.body) {
          try { sha256 = await sha256Hex(rec.body); } catch { sha256 = null; }
        }
        if (my !== gen) return; // clear()/load() ran since the request was issued or while hashing
        if (price) {
          list.push({
            at: rec.at, source: "defillama", chainId: null, action: "batchHistorical", params,
            url: priceUrl(params.coins, params.searchWidth), httpStatus: rec.httpStatus, rows: rec.rows, sha256, outcome: rec.outcome,
          });
        } else list.push({
          at: rec.at, chainId: String(rec.chainId), action: rec.action, params,
          url: queryUrl(params), httpStatus: rec.httpStatus, rows: rec.rows, sha256, outcome: rec.outcome,
        });
        if (list.length > limit) { list.shift(); dropped++; }
      } catch { /* add never rejects */ }
    },
    entries: () => list.slice(),
    get epoch() { return gen; },
    get dropped() { return dropped; },
    get unloggedData() { return unlogged; },
    markUnlogged() { unlogged = true; },
    clear() { gen++; list = []; dropped = 0; unlogged = false; },
    load(s) { gen++; list = s.entries.slice(); dropped = s.dropped; unlogged = s.unloggedData === true; },
    toJSON: () => ({ entries: list.slice(), dropped, unloggedData: unlogged }),
    window: () => windowOf(list),
  };
  return api;
}

/** Validate untrusted workspace input; returns a freshly built state. */
export function sanitizeQueryLog(raw, limit = LIMITS.queryLog) {
  if (!isObj(raw) || !Array.isArray(raw.entries)) return { entries: [], dropped: 0, unloggedData: true, invalid: 0 };
  let dropped = Number.isSafeInteger(raw.dropped) && raw.dropped >= 0 ? raw.dropped : 0;
  dropped += Math.max(0, raw.entries.length - limit);
  const entries = [];
  let invalid = 0;
  for (const e of raw.entries.slice(-limit)) {
    const v = rebuild(e);
    if (v) entries.push(v); else invalid++;
  }
  return { entries, dropped, unloggedData: raw.unloggedData !== false || invalid > 0, invalid };
}

// A real UTC instant, normalised to Date#toISOString's millisecond form (one precision,
// so ISO strings sort lexically in windowOf). Rejects month 99, Feb 30, 24:00 (no rollover).
function normAt(at) {
  if (typeof at !== "string" || !AT_RE.test(at)) return null;
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  const iso = d.toISOString();
  return iso.slice(0, 19) === at.slice(0, 19) ? iso : null;
}

// coins: canonical compact JSON {coinId:[ts,...]} exactly as the price service builds it.
function validCoins(coins) {
  if (typeof coins !== "string" || coins.length > MAX_COINS_CHARS) return false;
  let o;
  try { o = JSON.parse(coins); } catch { return false; }
  if (!isObj(o)) return false;
  const keys = Object.keys(o);
  if (keys.length < 1 || keys.length > MAX_COIN_KEYS) return false;
  for (const k of keys) {
    if (!COIN_RE.test(k) || !Array.isArray(o[k]) || !o[k].length) return false;
    if (!o[k].every((v) => Number.isSafeInteger(v) && v >= 0)) return false;
  }
  return JSON.stringify(o) === coins;
}

// Shared response metadata checks (Etherscan and price entries).
function validMeta(e) {
  return (e.httpStatus === null || (Number.isInteger(e.httpStatus) && e.httpStatus >= 100 && e.httpStatus <= 599)) &&
    (e.rows === null || (Number.isInteger(e.rows) && e.rows >= 0)) &&
    (e.sha256 === null || (typeof e.sha256 === "string" && SHA_RE.test(e.sha256))) &&
    OUTCOMES.includes(e.outcome);
}

function rebuildPrice(e) {
  const at = normAt(e.at);
  const ok =
    at !== null && e.chainId === null && e.action === "batchHistorical" &&
    validMeta(e) &&
    typeof e.params.searchWidth === "string" && WIDTH_RE.test(e.params.searchWidth) &&
    validCoins(e.params.coins);
  if (!ok) return null;
  const params = { coins: e.params.coins, searchWidth: e.params.searchWidth };
  return {
    at, source: "defillama", chainId: null, action: "batchHistorical", params,
    url: priceUrl(params.coins, params.searchWidth), httpStatus: e.httpStatus, rows: e.rows, sha256: e.sha256, outcome: e.outcome,
  };
}

function rebuild(e) {
  if (!isObj(e) || !isObj(e.params)) return null;
  if (has(e, "source")) return e.source === "defillama" ? rebuildPrice(e) : null;
  const chainId = parseChainId(e.chainId);
  const at = normAt(e.at);
  const ok =
    at !== null &&
    chainId !== null &&
    typeof e.action === "string" && ACTION_RE.test(e.action) &&
    validMeta(e);
  if (!ok) return null;
  const params = {};
  for (const k of PARAM_KEYS) {
    if (!has(e.params, k)) continue;
    const p = e.params[k];
    if (typeof p !== "string" || !PARAM_RE.test(p)) return null;
    params[k] = p;
  }
  // The url is rebuilt from params: they must describe the same request as the entry.
  if ((has(params, "chainid") && params.chainid !== chainId) || (has(params, "action") && params.action !== e.action)) return null;
  return {
    at, chainId, action: e.action, params, url: queryUrl(params),
    httpStatus: e.httpStatus, rows: e.rows, sha256: e.sha256, outcome: e.outcome,
  };
}
