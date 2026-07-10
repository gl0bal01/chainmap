// =============================================================================
// workspace.js — pure, DOM-free workspace save/load transforms.
//
// Converts between a workspace JSON document (what gets written to / read from
// a save file) and plain data. This module does NOT import graphStore and does
// NOT mutate any store — main.js is responsible for applying parsed data via a
// store bulk-load, and for reading store state (listNodes()/listEdges()) to
// build the input for serializeWorkspace().
// =============================================================================

import { lc, isValidAddress } from "./format.js";

/** Bump when the on-disk workspace shape changes in a way older readers can't handle. */
export const WORKSPACE_VERSION = 2;

/**
 * @typedef {object} WorkspaceFilters
 * @property {number} [minAmount]
 * @property {boolean} [hideZero]
 * @property {boolean} [hideSpam]
 * @property {boolean} [bundle]
 * @property {string} [minTime]
 * @property {string} [maxTime]
 */

/**
 * @typedef {object} Workspace
 * @property {number} version
 * @property {*} chainId
 * @property {*} root
 * @property {object[]} nodes  plain NodeRecord-shaped objects
 * @property {object[]} edges  plain EdgeRecord-shaped objects
 * @property {WorkspaceFilters} filters
 * @property {*} layout
 * @property {object[]} annotations
 */

/**
 * Build a plain, JSON-serializable workspace object from current graph/UI
 * state. `nodes`/`edges` are expected to already be plain arrays (e.g. from
 * store.listNodes()/store.listEdges()) — they are shallow-copied here so the
 * returned object shares no mutable references with the caller's arrays.
 * @param {object} input
 * @param {*} [input.chainId]
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
    chainId: src.chainId ?? null,
    root: src.root ?? null,
    nodes,
    edges,
    filters,
    layout: src.layout ?? null,
    annotations,
  };
}

/**
 * Parse + defensively sanitize an untrusted workspace payload (raw JSON
 * string, or an already-parsed object) into a safe internal shape. Never
 * throws — any failure is reported via `{ ok:false, error }`.
 * @param {string|object} json
 * @returns {{ ok:true, data:Workspace } | { ok:false, error:string }}
 */
export function parseWorkspace(json) {
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
  if (!Array.isArray(obj.nodes) || !Array.isArray(obj.edges)) {
    return { ok: false, error: "workspace must have nodes and edges arrays" };
  }

  const nodes = [];
  for (const raw of obj.nodes) {
    if (!raw || typeof raw !== "object") continue;
    const address = lc(raw.address);
    if (!isValidAddress(address)) continue;
    const depth = Number(raw.depth);
    nodes.push({
      ...raw,
      address,
      depth: Number.isFinite(depth) ? depth : 0,
      isRoot: raw.isRoot === true,
      alias: raw.alias == null || raw.alias === "" ? null : String(raw.alias),
    });
  }

  const edges = [];
  for (const raw of obj.edges) {
    if (!raw || typeof raw !== "object") continue;
    const key = typeof raw.key === "string" && raw.key.length > 0 ? raw.key : "";
    const from = lc(raw.from);
    const to = lc(raw.to);
    if (!key || !isValidAddress(from) || !isValidAddress(to)) continue;
    edges.push({
      ...raw,
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
  const annotations = Array.isArray(obj.annotations) ? [...obj.annotations] : [];

  return {
    ok: true,
    data: {
      version: typeof obj.version === "number" ? obj.version : WORKSPACE_VERSION,
      chainId: obj.chainId ?? null,
      root: obj.root ?? null,
      nodes,
      edges,
      filters,
      layout: obj.layout ?? null,
      annotations,
    },
  };
}
