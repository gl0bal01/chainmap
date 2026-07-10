// =============================================================================
// graphStore.js — SINGLE SOURCE OF TRUTH for graph state. DOM-free, Node-testable.
//
// This module fixes the reference app's core weakness: 4 hand-synced state blobs
// (nodesDS / edgesDS / nodeMeta / edgeKeys / aliasMap). Here there is ONE store.
// ALL mutations go through it; it keeps sub-structures consistent and emits events.
// The render layer (render/network.js) MIRRORS the store into vis DataSets by
// subscribing — the store itself never touches the DOM or vis.
//
// STAGE A: interface frozen. STAGE B: implement + unit tests (invariants).
// =============================================================================

import { lc, formatUnits, trimZero, edgeDedupKey } from "./format.js";
import { decodeCall } from "./abiDecode.js";

/**
 * @typedef {object} NodeRecord
 * @property {string}  address  lowercased; canonical node id
 * @property {number}  depth    minimum BFS depth seen
 * @property {boolean} isRoot    sticky once true
 * @property {string|null} alias user label (null = none)
 */

/**
 * @typedef {object} EdgeRecord
 * @property {string}  key                 precise dedup key (format.edgeDedupKey)
 * @property {string}  action              Etherscan action
 * @property {'normal'|'internal'|'token'} group
 * @property {string}  color               edge color for this type
 * @property {string}  from                lowercased
 * @property {string}  to                  lowercased
 * @property {string}  hash
 * @property {string}  symbol              display symbol ("ETH" / tokenSymbol, raw)
 * @property {string}  tokenContract       "" for native
 * @property {string}  tokenId             "" unless ERC-721/1155
 * @property {string}  value               raw base-unit integer string
 * @property {string}  amountText          formatted (trimmed) amount
 * @property {boolean} amountIndeterminate decimals/value untrusted (see formatUnits)
 * @property {boolean} hasData             tx carried non-empty input calldata (contract call)
 * @property {string}  methodId            4-byte selector (0x+8 hex) when calldata present, else ""
 * @property {{type:string,value:string}[]} methodArgs decoded leading static args (empty if none/unknown)
 * @property {string}  rawInput            raw tx `input` calldata hex ("" when none / non-string)
 * @property {string}  timeStamp
 * @property {string}  blockNumber
 */

/**
 * Input accepted by {@link GraphStore#addEdge}. The store computes key + amount.
 * @typedef {object} EdgeInput
 * @property {string} action
 * @property {'normal'|'internal'|'token'} group
 * @property {string} color
 * @property {string} from
 * @property {string} to
 * @property {object} tx    raw Etherscan record (value/hash/tokenDecimal/…)
 */

/**
 * Event emitted to subscribers. Render mirrors these into vis DataSets.
 * @typedef {(
 *  | { type:'node:add',    node:NodeRecord }
 *  | { type:'node:update', node:NodeRecord }
 *  | { type:'node:remove', address:string }
 *  | { type:'edge:add',    edge:EdgeRecord }
 *  | { type:'edge:remove', key:string }
 *  | { type:'alias:set',   address:string, alias:string|null }
 *  | { type:'reset' }
 * )} StoreEvent
 */

export class GraphStore {
  constructor() {
    /** @type {Map<string, NodeRecord>} address -> node */
    this._nodes = new Map();
    /** @type {Map<string, EdgeRecord>} key -> edge */
    this._edges = new Map();
    /** @type {Set<string>} parity set mirroring _edges keys */
    this._edgeKeys = new Set();
    /** @type {Set<(e:StoreEvent)=>void>} subscribers */
    this._subs = new Set();
  }

  /**
   * Emit an event synchronously to every subscriber.
   * @param {StoreEvent} event
   */
  _emit(event) {
    for (const handler of this._subs) handler(event);
  }

  // --- mutations (the ONLY way to change state) ----------------------------

  /**
   * Add or merge a node. On merge: keep the MINIMUM depth; isRoot is sticky.
   * Emits 'node:add' (new) or 'node:update' (changed).
   * @param {string} address
   * @param {{ depth?:number, isRoot?:boolean }} [meta]
   * @returns {NodeRecord}
   */
  addNode(address, meta) {
    const addr = lc(address);
    const m = meta || {};
    const isRoot = m.isRoot === true;
    const hasDepth = typeof m.depth === "number" && Number.isFinite(m.depth);
    const existing = this._nodes.get(addr);

    if (!existing) {
      /** @type {NodeRecord} */
      const node = {
        address: addr,
        depth: hasDepth ? m.depth : 0,
        isRoot,
        alias: null,
      };
      this._nodes.set(addr, node);
      this._emit({ type: "node:add", node });
      return node;
    }

    let changed = false;
    if (hasDepth && m.depth < existing.depth) {
      existing.depth = m.depth;
      changed = true;
    }
    if (isRoot && !existing.isRoot) {
      existing.isRoot = true;
      changed = true;
    }
    if (changed) this._emit({ type: "node:update", node: existing });
    return existing;
  }

  /**
   * Add an edge unless its precise dedup key already exists. Auto-adds endpoints
   * only if the caller has already (scanner adds nodes explicitly). Emits
   * 'edge:add' on insert. Returns the record, or null if it was a duplicate.
   * @param {EdgeInput} input
   * @returns {EdgeRecord|null}
   */
  addEdge(input) {
    const { action, group, color, from, to, tx } = input;
    const key = edgeDedupKey(action, tx);
    if (this._edgeKeys.has(key)) return null;

    const amount = formatUnits(tx.value || "0", tx.tokenDecimal);
    // Etherscan documents tx `input` as a hex string, but never trust the wire:
    // a non-string (array/number/object) would make `.slice().toLowerCase()`
    // throw and abort the whole scan. Coerce to a safe string first.
    const txInput = typeof tx.input === "string" ? tx.input : "";
    /** @type {EdgeRecord} */
    const edge = {
      key,
      action,
      group,
      color,
      from: lc(from),
      to: lc(to),
      hash: tx.hash || "",
      symbol: tx.tokenSymbol || "ETH",
      tokenContract: tx.contractAddress || "",
      tokenId: tx.tokenID || "",
      value: tx.value || "0",
      amountText: trimZero(amount.text),
      amountIndeterminate: amount.indeterminate,
      // Non-empty input calldata => this transfer also invoked a contract. Only
      // normal (txlist) txs carry `input`; "0x" / empty means a plain transfer.
      hasData: !!(txInput && txInput !== "0x" && txInput.length > 2),
      methodId: txInput.length >= 10 ? txInput.slice(0, 10).toLowerCase() : "",
      methodArgs: (decodeCall(txInput) || {}).args || [],
      // Full calldata kept verbatim so the investigator can inspect / copy the
      // raw bytes (details panel shows it as textContent — never as HTML).
      rawInput: txInput,
      timeStamp: tx.timeStamp || "",
      blockNumber: tx.blockNumber || "",
    };
    this._edges.set(key, edge);
    this._edgeKeys.add(key);
    this._emit({ type: "edge:add", edge });
    return edge;
  }

  /**
   * Set (or clear with null/"") a node alias. Emits 'alias:set'. No-op if node absent.
   * @param {string} address
   * @param {string|null} alias
   */
  setAlias(address, alias) {
    const addr = lc(address);
    const node = this._nodes.get(addr);
    if (!node) return;
    const next = alias === "" || alias == null ? null : alias;
    node.alias = next;
    this._emit({ type: "alias:set", address: addr, alias: next });
  }

  /**
   * Remove nodes and every connected edge; drop their aliases + edge keys.
   * Emits 'edge:remove' per edge then 'node:remove' per node.
   * @param {string[]} addresses
   * @returns {{ removedNodes:number, removedEdges:number }}
   */
  removeNodes(addresses) {
    let removedNodes = 0;
    let removedEdges = 0;
    for (const raw of addresses) {
      const addr = lc(raw);
      if (!this._nodes.has(addr)) continue;
      for (const [key, edge] of this._edges) {
        if (edge.from === addr || edge.to === addr) {
          this._edges.delete(key);
          this._edgeKeys.delete(key);
          removedEdges++;
          this._emit({ type: "edge:remove", key });
        }
      }
      this._nodes.delete(addr);
      removedNodes++;
      this._emit({ type: "node:remove", address: addr });
    }
    return { removedNodes, removedEdges };
  }

  /** Clear everything. Emits a single 'reset'. */
  reset() {
    this._nodes.clear();
    this._edges.clear();
    this._edgeKeys.clear();
    this._emit({ type: "reset" });
  }

  /**
   * Replace all state from a prebuilt snapshot (workspace / demo restore). Emits
   * 'reset' then 'node:add'/'edge:add' so the view rebuilds. Edges whose endpoints
   * are absent are dropped (invariants preserved). Nodes carry their alias.
   * @param {NodeRecord[]} nodes
   * @param {EdgeRecord[]} edges
   */
  loadSnapshot(nodes, edges) {
    this._nodes.clear();
    this._edges.clear();
    this._edgeKeys.clear();
    this._emit({ type: "reset" });

    for (const n of nodes || []) {
      const addr = lc(n && n.address);
      if (!addr || this._nodes.has(addr)) continue;
      /** @type {NodeRecord} */
      const node = {
        address: addr,
        depth: typeof n.depth === "number" && Number.isFinite(n.depth) ? n.depth : 0,
        isRoot: n.isRoot === true,
        alias: n.alias != null && n.alias !== "" ? String(n.alias) : null,
      };
      this._nodes.set(addr, node);
      this._emit({ type: "node:add", node });
    }

    for (const e of edges || []) {
      const key = e && e.key;
      if (!key || this._edgeKeys.has(key)) continue;
      const from = lc(e.from);
      const to = lc(e.to);
      if (!this._nodes.has(from) || !this._nodes.has(to)) continue; // keep endpoint invariant
      /** @type {EdgeRecord} */
      const edge = { ...e, key, from, to };
      this._edges.set(key, edge);
      this._edgeKeys.add(key);
      this._emit({ type: "edge:add", edge });
    }
  }

  // --- reads ----------------------------------------------------------------

  /** @param {string} address @returns {NodeRecord|undefined} */
  getNode(address) { return this._nodes.get(lc(address)); }
  /** @param {string} address @returns {boolean} */
  hasNode(address) { return this._nodes.has(lc(address)); }
  /** @param {string} address @returns {string|null} */
  getAlias(address) {
    const node = this._nodes.get(lc(address));
    return node ? node.alias : null;
  }
  /** @param {string} key @returns {boolean} */
  hasEdgeKey(key) { return this._edgeKeys.has(key); }
  /** @returns {NodeRecord[]} */
  listNodes() { return [...this._nodes.values()]; }
  /** @returns {EdgeRecord[]} */
  listEdges() { return [...this._edges.values()]; }
  /** @returns {{ nodes:number, edges:number }} */
  stats() { return { nodes: this._nodes.size, edges: this._edges.size }; }

  // --- integrity ------------------------------------------------------------

  /**
   * Dev invariant check (spec Definition-of-Done): every edge endpoint exists as
   * a node; edgeKeys <-> edges parity; every node has meta; aliases reference
   * existing nodes.
   * @returns {{ ok:boolean, errors:string[] }}
   */
  checkInvariants() {
    const errors = [];

    if (this._edgeKeys.size !== this._edges.size) {
      errors.push(`edgeKeys/edges size parity broken: ${this._edgeKeys.size} keys vs ${this._edges.size} edges`);
    }
    for (const key of this._edgeKeys) {
      if (!this._edges.has(key)) errors.push(`edgeKeys has key with no edge: ${key}`);
    }
    for (const [key, edge] of this._edges) {
      if (!this._edgeKeys.has(key)) errors.push(`edge has no matching edgeKey: ${key}`);
      if (edge.key !== key) errors.push(`edge.key does not match map key: ${key}`);
      if (!this._nodes.has(edge.from)) errors.push(`edge ${key} references missing from-node: ${edge.from}`);
      if (!this._nodes.has(edge.to)) errors.push(`edge ${key} references missing to-node: ${edge.to}`);
    }
    for (const [addr, node] of this._nodes) {
      if (node.address !== addr) errors.push(`node.address does not match map key: ${addr}`);
      if (typeof node.depth !== "number") errors.push(`node ${addr} missing numeric depth`);
      if (typeof node.isRoot !== "boolean") errors.push(`node ${addr} missing boolean isRoot`);
      if (!("alias" in node)) errors.push(`node ${addr} missing alias field`);
      else if (node.alias !== null && typeof node.alias !== "string") errors.push(`node ${addr} has invalid alias type`);
    }

    return { ok: errors.length === 0, errors };
  }

  // --- events ---------------------------------------------------------------

  /**
   * Subscribe to {@link StoreEvent}s.
   * @param {(e:StoreEvent)=>void} handler
   * @returns {() => void} unsubscribe
   */
  subscribe(handler) {
    this._subs.add(handler);
    return () => { this._subs.delete(handler); };
  }
}
