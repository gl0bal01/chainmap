// =============================================================================
// bridgeRegistry.js — static bridge registry from a bundled local JSON. NO
// third-party network call (same-origin fetch, CSP connect-src 'self'). Chain-
// scoped. Load is async + empty-on-failure; lookup is pure. Never throws.
// =============================================================================

import { DATA_PATHS } from "./config.js";

/**
 * @typedef {{ name:string, kind:'lock-mint'|'liquidity', destChains:number[],
 *             depositSelector?:string, recipientParam?:string }} BridgeEntry
 * @typedef {Record<string, Record<string, BridgeEntry>>} BridgeData
 */

/**
 * Load the bundled bridge registry. Empty object on any failure (never rejects).
 * @param {typeof fetch} [fetchImpl]
 * @param {string} [path]
 * @returns {Promise<BridgeData>}
 */
export async function loadBridges(fetchImpl, path) {
  const doFetch = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  const url = path || DATA_PATHS.bridges;
  if (!doFetch) return {};
  try {
    const resp = await doFetch(url);
    if (!resp || !resp.ok) return {};
    const data = await resp.json();
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

/**
 * Look up a bridge entry for an address on a chain.
 * @param {string} address
 * @param {number|string} chainId
 * @param {BridgeData} data
 * @returns {BridgeEntry|null}
 */
export function bridgeInfo(address, chainId, data) {
  if (!data || !address) return null;
  const chain = data[String(chainId)];
  if (!chain) return null;
  const entry = chain[String(address).toLowerCase()];
  return entry || null;
}
