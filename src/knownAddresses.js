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

/** @typedef {{ label:string, category:string, source:string, added:string, symbol?:string, decimals?:number, note?:string }} KnownEntry */
/**
 * @typedef {Record<string, Record<string, KnownEntry>>} KnownData
 *   Top-level keys: "*" (valid on every EVM chain) or a chain-id string.
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
 * Look up the full entry for an address: chain-specific first, then the "*"
 * (all EVM chains) bucket. Own-property only, so inherited keys never match.
 * @param {string} address
 * @param {number|string} chainId
 * @param {KnownData} data
 * @returns {KnownEntry|null}
 */
export function knownEntry(address, chainId, data) {
  if (!data || !address) return null;
  const addr = String(address).toLowerCase();
  for (const key of [String(chainId), "*"]) {
    const chain = Object.hasOwn(data, key) ? data[key] : null;
    if (chain && Object.hasOwn(chain, addr)) return chain[addr];
  }
  return null;
}

/** @returns {string|null} display label (chain-specific, else "*") */
export function knownLabel(address, chainId, data) {
  return knownEntry(address, chainId, data)?.label || null;
}

/** @returns {string|null} category (mixer/bridge/exchange/token/…) */
export function knownCategory(address, chainId, data) {
  return knownEntry(address, chainId, data)?.category || null;
}

/**
 * Every chain on which `address` is a KNOWN labeled entity. Chain-specific hits
 * first (numeric ids), then at most one `{ chainId: "*" }` item last.
 * @param {string} address
 * @param {KnownData} data
 * @returns {{ chainId:number|"*", label:string, category:string }[]}
 */
export function chainsForKnownAddress(address, data) {
  const out = [];
  if (!data || !address) return out;
  const addr = String(address).toLowerCase();
  const item = (chainId, e) => ({ chainId, label: e.label || "", category: e.category || "" });
  for (const chainId of Object.keys(data)) {
    if (chainId === "*") continue;
    const chain = data[chainId];
    if (chain && Object.hasOwn(chain, addr)) out.push(item(Number(chainId), chain[addr]));
  }
  if (data["*"] && Object.hasOwn(data["*"], addr)) out.push(item("*", data["*"][addr]));
  return out;
}
