// =============================================================================
// tronClient.js — TronGrid fetch with etherscanClient's fetchAction shape.
// DOM-free (inject `fetchImpl` in tests). Errors reuse EtherscanError kinds.
// The API key travels only in the TRON-PRO-API-KEY header: never in a URL, an
// onQuery record or an error message.
// =============================================================================

import { FETCH, TRON_FETCH } from "./config.js";
import { EtherscanError, sleep } from "./etherscanClient.js";
import { TRON_CHAIN_ID, TRON_ACTIONS, isTronAddress, tronUrl, tronRows } from "./tron.js";

const aborted = (action) => new EtherscanError(`aborted (${action})`, "aborted", { action });
const apiError = (action, httpStatus, data) =>
  new EtherscanError(`TronGrid error (${action}): ${String(data?.error ?? data?.Error ?? "").slice(0, 200)}`, "api", { action, httpStatus });

/**
 * @param {object} [options]
 * @param {string} [options.apiKey]       sent as TRON-PRO-API-KEY only when non-empty
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(rec:object)=>(void|Promise<void>)} [options.onQuery]  once per attempt; errors swallowed
 * @param {number} [options.timeoutMs]    default FETCH.timeoutMs
 * @param {number} [options.maxRetries]   total attempts, default FETCH.maxRetries
 * @param {number} [options.backoffMs]    429/5xx wait = max(backoffMs, backoffMs*attempt), default TRON_FETCH.backoffMs
 * @param {number} [options.minIntervalMs] wait before each fingerprint hop, default 1000 / TRON_FETCH.keylessRps
 * @returns {{ fetchAction: (address:string, action:string, opts:object) => Promise<object[]> }}
 */
export function createTronClient(options = {}) {
  const { apiKey, onQuery } = options;
  const fetchImpl = options.fetchImpl ?? ((...a) => globalThis.fetch(...a));
  const timeoutMs = options.timeoutMs ?? FETCH.timeoutMs;
  const maxRetries = options.maxRetries ?? FETCH.maxRetries;
  const backoffMs = options.backoffMs ?? TRON_FETCH.backoffMs;
  const minIntervalMs = options.minIntervalMs ?? 1000 / TRON_FETCH.keylessRps;

  /** One logged request with retries; resolves to the parsed JSON (success === true). */
  async function request(action, params, signal, onRetry) {
    const url = tronUrl(action, params);
    const log = async (fields) => {
      try {
        await onQuery?.({ at: new Date().toISOString(), source: "trongrid", chainId: TRON_CHAIN_ID, action, params, ...fields });
      } catch {}
    };

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) throw aborted(action);

      // Per-request timeout composed with the caller's signal (as etherscanClient).
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const onCallerAbort = () => controller.abort();
      signal?.addEventListener("abort", onCallerAbort);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onCallerAbort);
      };

      let resp;
      try {
        resp = await fetchImpl(url, {
          signal: controller.signal,
          headers: apiKey ? { "TRON-PRO-API-KEY": apiKey } : {},
          credentials: "omit",
          referrerPolicy: "no-referrer",
        });
      } catch (e) {
        cleanup();
        if (timedOut) {
          await log({ httpStatus: null, rows: null, outcome: "network" });
          throw new EtherscanError(`request timed out after ${timeoutMs}ms (${action})`, "timeout", { action, timeoutMs });
        }
        if (signal?.aborted || e?.name === "AbortError") throw aborted(action);
        await log({ httpStatus: null, rows: null, outcome: "network" });
        throw new EtherscanError(`network error (${action}): ${e?.message}`, "network", { action, cause: e?.message });
      }
      cleanup();

      // Throttled / transient: logged before the body is read, no Retry-After from TronGrid.
      const httpStatus = resp.status;
      if (httpStatus === 429 || httpStatus >= 500) {
        const waitMs = Math.max(backoffMs, backoffMs * attempt);
        await log({ httpStatus, rows: null, outcome: attempt < maxRetries ? "retry" : "error" });
        if (attempt < maxRetries) {
          onRetry?.({ action, attempt, waitMs, reason: `http_${httpStatus}` });
          await sleep(waitMs, signal);
          continue;
        }
        throw new EtherscanError(`throttled (HTTP ${httpStatus}) after ${attempt} attempts (${action})`, "rate_limit", { action, httpStatus });
      }

      // Read bytes once: the logged body is exactly what was parsed.
      let buf;
      try {
        buf = new Uint8Array(await resp.arrayBuffer());
      } catch {
        if (signal?.aborted) throw aborted(action);
        await log({ httpStatus, rows: null, outcome: "error" });
        throw apiError(action, httpStatus);
      }
      if (httpStatus === 401) {
        await log({ httpStatus, rows: null, outcome: "error", body: buf });
        throw new EtherscanError(`TronGrid rejected the API key (${action})`, "invalid_key", { action, httpStatus });
      }
      let data;
      try {
        data = JSON.parse(new TextDecoder().decode(buf));
      } catch {}
      if (httpStatus < 200 || httpStatus > 299 || data?.success !== true) {
        await log({ httpStatus, rows: null, outcome: "error", body: buf });
        throw apiError(action, httpStatus, data);
      }
      await log({ httpStatus, rows: Array.isArray(data.data) ? data.data.length : null, outcome: "ok", body: buf });
      return data;
    }
    // Unreachable with maxRetries >= 1 (the last 429/5xx attempt throws above).
    throw new EtherscanError(`throttled after ${maxRetries} attempts (${action})`, "rate_limit", { action });
  }

  /**
   * Latest `offset` rows (newest first; `sort` ignored). `page` p > 1 follows
   * meta.fingerprint p-1 times, pacing each hop by minIntervalMs; [] when the chain ends.
   */
  async function fetchAction(address, action, { offset, page = 1, startblock, endblock, signal, onRetry } = {}) {
    if (!TRON_ACTIONS.includes(action) || !isTronAddress(address) || !(Number.isInteger(offset) && offset >= 1 && offset <= TRON_FETCH.maxLimit)) {
      throw new EtherscanError(`invalid TronGrid request (${action})`, "api", { action });
    }
    const params = { address, limit: String(offset), only_confirmed: "true" };
    if (action === "txlist") params.search_internal = "false";
    if (startblock != null) params.min_timestamp = String(startblock);
    if (endblock != null) params.max_timestamp = String(endblock);

    let json = await request(action, params, signal, onRetry);
    for (let p = 2; p <= page; p++) {
      const fingerprint = json.meta?.fingerprint;
      if (typeof fingerprint !== "string" || !fingerprint) return [];
      await sleep(minIntervalMs, signal);
      json = await request(action, { ...params, fingerprint }, signal, onRetry);
    }
    return tronRows(action, json);
  }

  return { fetchAction };
}
