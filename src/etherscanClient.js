// =============================================================================
// etherscanClient.js — Etherscan v2 request building + resilient fetch.
// DOM-free, Node-testable (inject a `fetch` in tests).
//
// STAGE A: interface frozen. STAGE B: implement + unit tests.
// Hardening contract (do NOT reproduce the reference's weak points):
//  - per-request timeout via AbortController (composed with caller's signal)
//  - handle 429 / 5xx + honor `Retry-After`; backoff between retries
//  - throttle detection broader than the literal "rate limit" string
//  - "no transactions found" => empty array (not an error)
//  - any other status "0" (invalid key, bad module, …) => typed error to surface
//  - distinguish invalid-key vs rate-limit vs network/timeout vs generic API
// =============================================================================

import { API_BASE, FETCH } from "./config.js";

/** Discriminated error for the UI to localize by `kind`. */
export class EtherscanError extends Error {
  /**
   * @param {string} message developer/log message (already-known text)
   * @param {'network'|'timeout'|'aborted'|'rate_limit'|'invalid_key'|'api'} kind
   * @param {object} [meta] extra context (action, status, httpStatus, retryAfter)
   */
  constructor(message, kind, meta) {
    super(message);
    this.name = "EtherscanError";
    this.kind = kind;
    this.meta = meta || {};
  }
}

/**
 * A raw Etherscan tx record. Shape varies by action; treated as a loose bag of
 * strings. Fields the app reads: from, to, value, hash, timeStamp, blockNumber,
 * contractAddress, tokenSymbol, tokenDecimal, tokenID, logIndex, isError,
 * txreceipt_status.
 * @typedef {Record<string, string|undefined>} RawTx
 */

/**
 * @typedef {object} EtherscanClientOptions
 * @property {string}  apiKey
 * @property {number|string} chainId
 * @property {string}  [apiBase]        default config.API_BASE
 * @property {number}  [timeoutMs]      default config.FETCH.timeoutMs
 * @property {number}  [maxRetries]     default config.FETCH.maxRetries
 * @property {number}  [backoffBaseMs]  default config.FETCH.backoffBaseMs
 * @property {typeof fetch} [fetchImpl]  injectable for tests (default global fetch)
 */

/**
 * @typedef {object} FetchActionOptions
 * @property {number}  offset            page size (per-address, per-action sample)
 * @property {number}  [page]            default config.FETCH.page (1)
 * @property {'asc'|'desc'} [sort]        default config.FETCH.sort ('desc')
 * @property {number}  [startblock]
 * @property {number}  [endblock]
 * @property {AbortSignal} [signal]      caller cancellation (Stop)
 * @property {(info:{action:string, attempt:number, waitMs:number, reason:string})=>void} [onRetry]
 */

/**
 * @typedef {object} EtherscanClient
 * @property {(address:string, action:string, opts:FetchActionOptions) => Promise<RawTx[]>} fetchAction
 *   Resolves to the result array (possibly empty). Rejects with {@link EtherscanError}.
 * @property {(apiKey:string) => void} setApiKey
 * @property {(chainId:number|string) => void} setChainId
 * @property {() => (number|string)} getChainId  current chain id
 */

// --- internal helpers (module-private) --------------------------------------

/** Broad throttle detection: covers "rate limit", "max rate limit reached",
 *  "too many requests", "throttled/throttling". Deliberately wider than the
 *  reference's literal `/rate limit/i`. */
function isThrottleMessage(msg) {
  return /rate limit|too many requests|throttl/i.test(msg);
}

/** Invalid-key detection (no retry — the key won't fix itself). */
function isInvalidKeyMessage(msg) {
  return /invalid api key|invalid key/i.test(msg);
}

/**
 * Parse a `Retry-After` header into milliseconds. Accepts a delay in seconds
 * (the common form; fractional tolerated) or an HTTP-date. Returns null when
 * absent/unparseable.
 * @param {{ get?: (name:string)=>(string|null) }} [headers]
 * @returns {number|null}
 */
function parseRetryAfter(headers) {
  if (!headers || typeof headers.get !== "function") return null;
  const raw = headers.get("Retry-After");
  if (raw == null || raw === "") return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(raw);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return null;
}

/**
 * Backoff sleep that is interruptible by the caller's abort signal.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new EtherscanError("aborted during backoff", "aborted", {}));
      return;
    }
    let onAbort;
    const timer = setTimeout(() => {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    onAbort = () => {
      clearTimeout(timer);
      reject(new EtherscanError("aborted during backoff", "aborted", {}));
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Build the fully-qualified request URL (pure; unit-tested directly).
 * @param {object} p
 * @param {string} p.apiBase
 * @param {number|string} p.chainId
 * @param {string} p.action
 * @param {string} p.address
 * @param {string} p.apiKey
 * @param {number} p.offset
 * @param {number} [p.page]
 * @param {string} [p.sort]
 * @param {number} [p.startblock]
 * @param {number} [p.endblock]
 * @returns {string}
 */
export function buildUrl(p) {
  const params = new URLSearchParams({
    chainid: String(p.chainId),
    module: "account",
    action: String(p.action),
    address: String(p.address),
    startblock: String(p.startblock ?? FETCH.startblock),
    endblock: String(p.endblock ?? FETCH.endblock),
    page: String(p.page ?? FETCH.page),
    offset: String(p.offset),
    sort: String(p.sort ?? FETCH.sort),
    apikey: String(p.apiKey ?? ""),
  });
  return `${p.apiBase ?? API_BASE}?${params.toString()}`;
}

/**
 * Create a client bound to an apiKey + chain.
 * @param {EtherscanClientOptions} options
 * @returns {EtherscanClient}
 */
export function createEtherscanClient(options) {
  const opts = options || {};
  let apiKey = opts.apiKey;
  let chainId = opts.chainId;
  const apiBase = opts.apiBase ?? API_BASE;
  const timeoutMs = opts.timeoutMs ?? FETCH.timeoutMs;
  const maxRetries = opts.maxRetries ?? FETCH.maxRetries;
  const backoffBaseMs = opts.backoffBaseMs ?? FETCH.backoffBaseMs;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  /**
   * @param {string} address
   * @param {string} action
   * @param {FetchActionOptions} fetchOpts
   * @returns {Promise<RawTx[]>}
   */
  async function fetchAction(address, action, fetchOpts) {
    const {
      offset,
      page,
      sort,
      startblock,
      endblock,
      signal,
      onRetry,
    } = fetchOpts || {};

    const url = buildUrl({
      apiBase,
      chainId,
      action,
      address,
      apiKey,
      offset,
      page,
      sort,
      startblock,
      endblock,
    });

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (signal && signal.aborted) {
        throw new EtherscanError(`aborted (${action})`, "aborted", { action });
      }

      // Per-request timeout, composed with the caller's signal: either the
      // timer or the caller aborts the same controller passed to fetch.
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const onCallerAbort = () => controller.abort();
      if (signal) signal.addEventListener("abort", onCallerAbort);
      const cleanup = () => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onCallerAbort);
      };

      let resp;
      try {
        resp = await fetchImpl(url, { signal: controller.signal });
      } catch (e) {
        cleanup();
        if (timedOut) {
          throw new EtherscanError(
            `request timed out after ${timeoutMs}ms (${action})`,
            "timeout",
            { action, timeoutMs }
          );
        }
        if ((signal && signal.aborted) || (e && e.name === "AbortError")) {
          throw new EtherscanError(`aborted (${action})`, "aborted", { action });
        }
        throw new EtherscanError(
          `network error (${action}): ${e && e.message}`,
          "network",
          { action, cause: e && e.message }
        );
      }
      cleanup();

      // HTTP-level throttling / transient server errors → retry with backoff.
      const httpStatus = resp.status;
      if (httpStatus === 429 || httpStatus >= 500) {
        const retryAfterMs = parseRetryAfter(resp.headers);
        const waitMs = retryAfterMs != null ? retryAfterMs : backoffBaseMs * attempt;
        if (attempt < maxRetries) {
          if (onRetry) onRetry({ action, attempt, waitMs, reason: `http_${httpStatus}` });
          await sleep(waitMs, signal);
          continue;
        }
        throw new EtherscanError(
          `throttled (HTTP ${httpStatus}) after ${attempt} attempts (${action})`,
          "rate_limit",
          { action, httpStatus, retryAfter: retryAfterMs }
        );
      }

      let data;
      try {
        data = await resp.json();
      } catch (e) {
        throw new EtherscanError(
          `invalid JSON response (${action})`,
          "api",
          { action, httpStatus, cause: e && e.message }
        );
      }

      if (data && data.status === "1") {
        return data.result || [];
      }

      const message = typeof (data && data.message) === "string" ? data.message : "";
      const resultStr = typeof (data && data.result) === "string" ? data.result : "";
      const combined = `${message} ${resultStr}`.trim();

      // Not an error: no matching transactions is a valid empty result.
      if (/no transactions found/i.test(combined)) {
        return [];
      }

      // Invalid key: surface immediately, never retry.
      if (isInvalidKeyMessage(combined)) {
        throw new EtherscanError(
          `invalid API key (${action})`,
          "invalid_key",
          { action, status: data && data.status, message: combined }
        );
      }

      // Body-level throttling (Etherscan returns HTTP 200 + status "0" here).
      if (isThrottleMessage(combined)) {
        const waitMs = backoffBaseMs * attempt;
        if (attempt < maxRetries) {
          if (onRetry) onRetry({ action, attempt, waitMs, reason: "throttled" });
          await sleep(waitMs, signal);
          continue;
        }
        throw new EtherscanError(
          `throttled after ${attempt} attempts (${action}): ${combined}`,
          "rate_limit",
          { action, message: combined }
        );
      }

      // Any other status "0" (bad module/action, etc.) is a real API error.
      throw new EtherscanError(
        `API error (${action}): ${combined}`,
        "api",
        { action, status: data && data.status, message: combined }
      );
    }

    // Loop exhausted without returning (all attempts were retryable throttles).
    throw new EtherscanError(
      `throttled after ${maxRetries} attempts (${action})`,
      "rate_limit",
      { action }
    );
  }

  return {
    fetchAction,
    setApiKey(k) {
      apiKey = k;
    },
    setChainId(id) {
      chainId = id;
    },
    getChainId() {
      return chainId;
    },
  };
}
