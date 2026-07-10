// =============================================================================
// knownAddresses.js — static known-address labeling from a bundled local JSON
// (Feature Layer 1). NO network call to a third party — the JSON ships in /data
// and is fetched from same origin (CSP connect-src 'self'). Chain-scoped, since
// the same address means different things on different chains.
//
// Load is async (one same-origin fetch); lookup is pure. Never throws — on any
// failure the map is empty so the app (and Demo Mode) still runs.
// =============================================================================

import { DATA_PATHS } from "./config.js";

/**
 * @typedef {Record<string, Record<string, { label:string, category:string }>>} KnownData
 *   Shape: { "<chainId>": { "<lowercased address>": { label, category } } }
 */

/**
 * Load the bundled known-address dataset.
 * @param {typeof fetch} [fetchImpl] injectable for tests (default global fetch)
 * @param {string} [path] default config.DATA_PATHS.knownAddresses
 * @returns {Promise<KnownData>} empty object on any failure (never rejects)
 */
export async function loadKnownAddresses(fetchImpl, path) {
  const doFetch = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  const url = path || DATA_PATHS.knownAddresses;
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
 * Look up a display label for an address on a given chain.
 * @param {string} address
 * @param {number|string} chainId
 * @param {KnownData} data
 * @returns {string|null}
 */
export function knownLabel(address, chainId, data) {
  if (!data || !address) return null;
  const chain = data[String(chainId)];
  if (!chain) return null;
  const entry = chain[address.toLowerCase()];
  return entry && entry.label ? entry.label : null;
}
