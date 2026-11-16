// =============================================================================
// workspace.js — pure, DOM-free workspace save/load transforms.
//
// Converts between a workspace JSON document (what gets written to / read from
// a save file) and plain data. This module does NOT import graphStore and does
// NOT mutate any store — main.js is responsible for applying parsed data via a
// store bulk-load, and for reading store state (listNodes()/listEdges()) to
// build the input for serializeWorkspace().
//
// v3 (written): { version:3, root, graph:{ nodes, edges }, filters, layout,
// annotations } — every record carries its own `chainId`; no top-level chain.
// v2 and older (read only): strict migration — every record takes the file's
// top-level `chainId` (or the caller's fallback), per-record fields ignored, so
// a v2 file can never produce mixed chains. Newer than v3: refused.
// =============================================================================

import { lc, isValidAddress, parseChainId, nodeId } from "./format.js";

/** Bump when the on-disk workspace shape changes in a way older readers can't handle. */
export const WORKSPACE_VERSION = 3;

/** Keys never copied from an untrusted workspace record. JSON.parse + spread do
 *  not pollute Object.prototype on modern engines, but these keys can still
 *  linger as own properties and shadow behavior downstream — drop them at the
 *  trust boundary. */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
/** Derived ids are recomputed by the store; a file's copy could contradict
 *  `chainId`/`address`, so it never leaves the parser. */
const DERIVED_KEYS = new Set(["id", "fromId", "toId"]);

/**
 * Shallow-copy an object's own enumerable keys minus {@link DANGEROUS_KEYS} and
 * {@link DERIVED_KEYS}, onto a fresh plain object. Used before spreading
 * untrusted node/edge records.
 * @param {object} raw
 * @returns {object}
 */
function stripDangerousKeys(raw) {
  const out = {};
  for (const k of Object.keys(raw)) {
    if (!DANGEROUS_KEYS.has(k) && !DERIVED_KEYS.has(k)) out[k] = raw[k];
  }
  return out;
}

/**
 * @typedef {object} Workspace
 * @property {number} version
 * @property {*} root          informational (the first root scanned)
 * @property {{ nodes:object[], edges:object[] }} graph  plain NodeRecord/EdgeRecord-shaped objects
 * @property {WorkspaceFilters} filters
 * @property {*} layout
 * @property {object[]} annotations
 */

/**
 * @typedef {object} ParsedWorkspace
 * @property {number} version          always WORKSPACE_VERSION (v2 input is migrated)
 * @property {*} root
 * @property {object[]} nodes          each with a decimal `chainId`
 * @property {object[]} edges          each with a decimal `chainId` and a `chainId|`-prefixed key
 * @property {WorkspaceFilters} filters
 * @property {*} layout
 * @property {object[]} annotations
 * @property {string|null} assumedChainId  v2 file had no chainId and the fallback was used
 */

/**
 * Build a plain, JSON-serializable v3 workspace object from current graph/UI
 * state. `nodes`/`edges` are expected to already be plain arrays (e.g. from
 * store.listNodes()/store.listEdges()) — they are shallow-copied here so the
 * returned object shares no mutable references with the caller's arrays. Each
 * record carries its own `chainId`; an input `chainId` is ignored.
 * @param {object} input
 * @param {*} [input.root]
 * @param {object[]} [input.nodes]
 * @param {object[]} [input.edges]
 * @param {WorkspaceFilters} [input.filters]
 * @param {*} [input.layout]
 * @param {object[]} [input.annotations]
 * @returns {Workspace}
 */
export function serializeWorkspace(input) {
  const src = input || {};

  const nodes = Array.isArray(src.nodes) ? src.nodes.map((n) => ({ ...n })) : [];
  const edges = Array.isArray(src.edges) ? src.edges.map((e) => ({ ...e })) : [];
  const filters =
    src.filters && typeof src.filters === "object" && !Array.isArray(src.filters)
      ? { ...src.filters }
      : {};
  const annotations = Array.isArray(src.annotations) ? [...src.annotations] : [];

  return {
    version: WORKSPACE_VERSION,
    root: src.root ?? null,
    graph: { nodes, edges },
    filters,
    layout: src.layout ?? null,
    annotations,
  };
}

/**
 * Parse + defensively sanitize an untrusted workspace payload (raw JSON
 * string, or an already-parsed object) into a safe internal shape. Never
 * throws — any failure is reported via `{ ok:false, error, errorKey? }`
 * (`errorKey` is an i18n key when the failure has a localized message).
 * Record ids (`id`/`fromId`/`toId`) are never trusted: they are dropped here and
 * the store recomputes them. A present `version` must be an integer 1..2 (migrated)
 * or 3; an integer > 3 is refused as "newer", anything else as invalid.
 * @param {string|object} json
 * @param {{ fallbackChainId?: string|number }} [opts] chain for a v2 file without one
 * @returns {{ ok:true, data:ParsedWorkspace } | { ok:false, error:string, errorKey?:string }}
 */
export function parseWorkspace(json, opts) {
  let obj = json;

  if (typeof json === "string") {
    try {
      obj = JSON.parse(json);
    } catch (e) {
      return { ok: false, error: "invalid JSON: " + (e && e.message ? e.message : String(e)) };
    }
  }

  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, error: "workspace must be a JSON object" };
  }
  if (obj.version !== undefined) {
    const v = obj.version;
    if (Number.isInteger(v) && v > WORKSPACE_VERSION) {
      return { ok: false, error: `workspace version ${v} is newer than ${WORKSPACE_VERSION}`, errorKey: "error.workspaceTooNew" };
    }
    if (!Number.isInteger(v) || v < 1) return { ok: false, error: "workspace version must be an integer from 1 to 3" };
  }
  const v3 = obj.version === 3;
  const graph = v3 ? obj.graph : obj;
  if (!graph || typeof graph !== "object" || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    return { ok: false, error: v3 ? "workspace must have graph.nodes and graph.edges arrays" : "workspace must have nodes and edges arrays" };
  }

  // v2: ONE chain for the whole file (top-level, else the caller's fallback).
  let fileChain = null;
  if (!v3) {
    fileChain = parseChainId(obj.chainId ?? (opts || {}).fallbackChainId);
    if (fileChain === null) return { ok: false, error: "workspace chainId must be a decimal chain id" };
  }
  const chainOf = (raw) => (v3 ? parseChainId(raw.chainId) : fileChain);

  const nodes = [];
  const ids = new Set();
  for (const raw of graph.nodes) {
    if (!raw || typeof raw !== "object") continue;
    const address = lc(raw.address);
    const chainId = chainOf(raw);
    if (!isValidAddress(address) || chainId === null) continue;
    const depth = Number(raw.depth);
    nodes.push({
      ...stripDangerousKeys(raw),
      chainId,
      address,
      depth: Number.isFinite(depth) ? depth : 0,
      isRoot: raw.isRoot === true,
      alias: raw.alias == null || raw.alias === "" ? null : String(raw.alias),
    });
    ids.add(nodeId(chainId, address));
  }

  const edges = [];
  for (const raw of graph.edges) {
    if (!raw || typeof raw !== "object") continue;
    const rawKey = typeof raw.key === "string" && raw.key.length > 0 ? raw.key : "";
    const from = lc(raw.from);
    const to = lc(raw.to);
    const chainId = chainOf(raw);
    if (!rawKey || !isValidAddress(from) || !isValidAddress(to) || chainId === null) continue;
    // v2 keys are prefixed, not recomputed (EdgeRecord lacks logIndex).
    const key = v3 ? rawKey : `${chainId}|${rawKey}`;
    if (v3 && (!key.startsWith(chainId + "|") || !ids.has(nodeId(chainId, from)) || !ids.has(nodeId(chainId, to)))) continue;
    edges.push({
      ...stripDangerousKeys(raw),
      chainId,
      key,
      from,
      to,
      tokenContract: raw.tokenContract == null || raw.tokenContract === "" ? "" : lc(raw.tokenContract),
    });
  }

  const filters =
    obj.filters && typeof obj.filters === "object" && !Array.isArray(obj.filters)
      ? { ...obj.filters }
      : {};
  if (Array.isArray(filters.hiddenChains)) {
    filters.hiddenChains = filters.hiddenChains.map((c) => parseChainId(c)).filter((c) => c != null);
  } else delete filters.hiddenChains;
  if (typeof filters.showTwins !== "boolean") delete filters.showTwins;
  const annotations = Array.isArray(obj.annotations) ? [...obj.annotations] : [];

  return {
    ok: true,
    data: {
      version: WORKSPACE_VERSION,
      root: obj.root ?? null,
      nodes,
      edges,
      filters,
      layout: obj.layout ?? null,
      annotations,
      assumedChainId: !v3 && obj.chainId == null ? fileChain : null,
    },
  };
}
