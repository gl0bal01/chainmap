// =============================================================================
// graphStore.js — SINGLE SOURCE OF TRUTH for graph state. DOM-free, Node-testable.
//
// This module fixes the reference app's core weakness: 4 hand-synced state blobs
// (nodesDS / edgesDS / nodeMeta / edgeKeys / aliasMap). Here there is ONE store.
// ALL mutations go through it; it keeps sub-structures consistent and emits events.
// The render layer (render/network.js) MIRRORS the store into vis DataSets by
// subscribing — the store itself never touches the DOM or vis.
//
// Identity is chain-scoped: node id = `chainId:address` (format.nodeId). An
// address alone is not an identity — the same address on two chains is two
// independent nodes, and an edge never joins nodes of different chains.
// =============================================================================

import { lc, formatUnits, trimZero, parseChainId, nodeId, edgeKey } from "./format.js";
import { CHAINS } from "./config.js";
import { decodeCall } from "./abiDecode.js";
import { sanitizeHistory } from "./history.js";

/**
 * @typedef {object} NodeRecord
 * @property {string}  id       canonical node id: format.nodeId(chainId, address)
 * @property {string}  chainId  decimal chain id ("1", "42161", …)
 * @property {string}  address  lowercased on-chain address (display/links/lookups; not an identity)
 * @property {number}  depth    minimum BFS depth seen
 * @property {boolean} isRoot    sticky once true
 * @property {string|null} alias user label (null = none)
 * @property {Object<string, import('./history.js').HistoryEntry>} [history] per-action "load older" cursor
 */

/**
 * @typedef {object} EdgeRecord
 * @property {string}  key                 chain-scoped dedup key (format.edgeKey: "<chainId>|" + edgeDedupKey)
 * @property {string}  chainId             decimal chain id; both endpoints live on this chain
 * @property {string}  action              Etherscan action
 * @property {'normal'|'internal'|'token'} group
 * @property {string}  color               edge color for this type
 * @property {string}  from                lowercased address
 * @property {string}  to                  lowercased address
 * @property {string}  fromId              nodeId(chainId, from) — derived by the store, never trusted from a file
 * @property {string}  toId                nodeId(chainId, to)
 * @property {string}  hash
 * @property {string}  symbol              display symbol (the edge chain's native ticker / tokenSymbol, raw)
 * @property {string}  tokenContract       "" for native
 * @property {string}  tokenId             "" unless ERC-721/1155
 * @property {string}  value               raw base-unit integer string
 * @property {string}  tokenDecimal        raw token decimals as given by Etherscan
 *   ("" for native/unknown — downstream formatUnits() then reports indeterminate
 *   instead of silently defaulting to 18)
 * @property {string}  amountText          formatted (trimmed) amount
 * @property {boolean} amountIndeterminate decimals/value untrusted (see formatUnits)
 * @property {boolean} hasData             tx carried non-empty input calldata (contract call)
 * @property {string}  methodId            4-byte selector (0x+8 hex) when calldata present, else ""
 * @property {{type:string,value:string,name?:string}[]} methodArgs decoded leading static args (empty if none/unknown)
 * @property {string}  rawInput            raw tx `input` calldata hex ("" when none / non-string)
 * @property {string}  timeStamp
 * @property {string}  blockNumber
 */

/**
 * Input accepted by {@link GraphStore#addEdge}. The store computes key + amount.
 * @typedef {object} EdgeInput
 * @property {string} chainId decimal chain id (required; invalid -> TypeError)
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
 *  | { type:'node:remove', id:string }
 *  | { type:'edge:add',    edge:EdgeRecord }
 *  | { type:'edge:remove', key:string }
 *  | { type:'alias:set',   id:string, alias:string|null }
 *  | { type:'reset' }
 * )} StoreEvent
 */

/** @param {string} chainId @returns {string} native ticker, "" for a chain not in CHAINS */
function nativeTicker(chainId) {
  const chain = CHAINS.find((c) => String(c.id) === chainId);
  return chain ? chain.native : "";
}

export class GraphStore {
  constructor() {
    /** @type {Map<string, NodeRecord>} node id -> node */
    this._nodes = new Map();
    /** @type {Map<string, EdgeRecord>} key -> edge */
    this._edges = new Map();
    /** @type {Set<string>} parity set mirroring _edges keys */
    this._edgeKeys = new Set();
    /** @type {Map<string, number>} chainId -> node count (backs chains()) */
    this._chainCounts = new Map();
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

  /** @param {string} chainId @param {number} delta */
  _countChain(chainId, delta) {
    const n = (this._chainCounts.get(chainId) || 0) + delta;
    if (n > 0) this._chainCounts.set(chainId, n);
    else this._chainCounts.delete(chainId);
  }

  // --- mutations (the ONLY way to change state) ----------------------------

  /**
   * Add or merge a node. On merge: keep the MINIMUM depth; isRoot is sticky.
   * Emits 'node:add' (new) or 'node:update' (changed). Throws TypeError when
   * `chainId` is not a decimal chain id (never defaulted).
   * @param {string|number} chainId
   * @param {string} address
   * @param {{ depth?:number, isRoot?:boolean }} [meta]
   * @returns {NodeRecord}
   */
  addNode(chainId, address, meta) {
    const cid = parseChainId(chainId);
    if (cid === null) throw new TypeError(`addNode: invalid chainId ${String(chainId)}`);
    const addr = lc(address);
    const id = nodeId(cid, addr);
    const m = meta || {};
    const isRoot = m.isRoot === true;
    const hasDepth = typeof m.depth === "number" && Number.isFinite(m.depth);
    const existing = this._nodes.get(id);

    if (!existing) {
      /** @type {NodeRecord} */
      const node = {
        id,
        chainId: cid,
        address: addr,
        depth: hasDepth ? m.depth : 0,
        isRoot,
        alias: null,
      };
      this._nodes.set(id, node);
      this._countChain(cid, 1);
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
   * Add an edge unless its chain-scoped dedup key already exists. Does NOT
   * auto-add endpoints (the scanner adds nodes explicitly). Emits 'edge:add' on
   * insert. Returns the record, or null if it was a duplicate. Throws TypeError
   * when `input.chainId` is not a decimal chain id.
   * @param {EdgeInput} input
   * @returns {EdgeRecord|null}
   */
  addEdge(input) {
    const { chainId, action, group, color, from, to, tx } = input;
    const cid = parseChainId(chainId);
    if (cid === null) throw new TypeError(`addEdge: invalid chainId ${String(chainId)}`);
    const key = edgeKey(cid, action, tx);
    if (this._edgeKeys.has(key)) return null;

    const amount = formatUnits(tx.value || "0", tx.tokenDecimal);
    // Etherscan documents tx `input` as a hex string, but never trust the wire:
    // a non-string (array/number/object) would make `.slice().toLowerCase()`
    // throw and abort the whole scan. Coerce to a safe string first.
    const txInput = typeof tx.input === "string" ? tx.input : "";
    /** @type {EdgeRecord} */
    const edge = {
      key,
      chainId: cid,
      action,
      group,
      color,
      from: lc(from),
      to: lc(to),
      fromId: nodeId(cid, from),
      toId: nodeId(cid, to),
      hash: tx.hash || "",
      // Native ticker of THIS edge's chain; a chain not in CHAINS borrows none.
      symbol: tx.tokenSymbol || nativeTicker(cid),
      tokenContract: tx.contractAddress || "",
      tokenId: tx.tokenID || "",
      value: tx.value || "0",
      // Persist the raw decimals alongside the edge (not just the derived
      // amountText) so later re-formatting (details panel decoded args/summary)
      // uses the true token decimals instead of formatUnits' silent 18 default.
      tokenDecimal: tx.tokenDecimal ?? "",
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
   * @param {string} id node id (looked up exactly; not lowercased)
   * @param {string|null} alias
   */
  setAlias(id, alias) {
    const node = this._nodes.get(id);
    if (!node) return;
    const next = alias === "" || alias == null ? null : alias;
    node.alias = next;
    this._emit({ type: "alias:set", id, alias: next });
  }

  /**
   * Record a per-action "load older" cursor on a node. Emits 'node:update'. No-op if node absent.
   * @param {string} id node id
   * @param {string} action
   * @param {import('./history.js').HistoryEntry} entry
   */
  setHistory(id, action, entry) {
    const node = this._nodes.get(id);
    if (!node) return;
    node.history = { ...node.history, [action]: entry };
    this._emit({ type: "node:update", node });
  }

  /**
   * Remove nodes and every connected edge; drop their aliases + edge keys.
   * Emits 'edge:remove' per edge then 'node:remove' per node.
   * @param {string[]} ids node ids
   * @returns {{ removedNodes:number, removedEdges:number }}
   */
  removeNodes(ids) {
    let removedNodes = 0;
    let removedEdges = 0;
    for (const id of ids) {
      const node = this._nodes.get(id);
      if (!node) continue;
      for (const [key, edge] of this._edges) {
        if (edge.fromId === id || edge.toId === id) {
          this._edges.delete(key);
          this._edgeKeys.delete(key);
          removedEdges++;
          this._emit({ type: "edge:remove", key });
        }
      }
      this._nodes.delete(id);
      this._countChain(node.chainId, -1);
      removedNodes++;
      this._emit({ type: "node:remove", id });
    }
    return { removedNodes, removedEdges };
  }

  /** Clear everything. Emits a single 'reset'. */
  reset() {
    this._nodes.clear();
    this._edges.clear();
    this._edgeKeys.clear();
    this._chainCounts.clear();
    this._emit({ type: "reset" });
  }

  /**
   * Replace all state from a prebuilt snapshot (workspace / demo restore). Emits
   * 'reset' then 'node:add'/'edge:add' so the view rebuilds. `id`/`fromId`/`toId`
   * are always recomputed. Dropped (invariants preserved): nodes with an invalid
   * chainId; edges with an invalid chainId, a key not prefixed `chainId|`, or an
   * endpoint missing on that chain. Nodes carry their alias.
   * @param {NodeRecord[]} nodes
   * @param {EdgeRecord[]} edges
   */
  loadSnapshot(nodes, edges) {
    this._nodes.clear();
    this._edges.clear();
    this._edgeKeys.clear();
    this._chainCounts.clear();
    this._emit({ type: "reset" });

    for (const n of nodes || []) {
      const cid = parseChainId(n && n.chainId);
      const addr = lc(n && n.address);
      if (cid === null || !addr) continue;
      const id = nodeId(cid, addr);
      if (this._nodes.has(id)) continue;
      /** @type {NodeRecord} */
      const node = {
        id,
        chainId: cid,
        address: addr,
        depth: typeof n.depth === "number" && Number.isFinite(n.depth) ? n.depth : 0,
        isRoot: n.isRoot === true,
        alias: n.alias != null && n.alias !== "" ? String(n.alias) : null,
      };
      const history = sanitizeHistory(n.history);
      if (history !== undefined) node.history = history;
      this._nodes.set(id, node);
      this._countChain(cid, 1);
      this._emit({ type: "node:add", node });
    }

    for (const e of edges || []) {
      const cid = parseChainId(e && e.chainId);
      const key = e && e.key;
      if (cid === null || typeof key !== "string" || !key.startsWith(cid + "|") || this._edgeKeys.has(key)) continue;
      const from = lc(e.from);
      const to = lc(e.to);
      const fromId = nodeId(cid, from);
      const toId = nodeId(cid, to);
      if (!this._nodes.has(fromId) || !this._nodes.has(toId)) continue; // endpoints on THIS chain
      /** @type {EdgeRecord} */
      const edge = { ...e, key, chainId: cid, from, to, fromId, toId };
      this._edges.set(key, edge);
      this._edgeKeys.add(key);
      this._emit({ type: "edge:add", edge });
    }
  }

  // --- reads (ids are looked up exactly as given; no lowercasing) -----------

  /** @param {string} id node id @returns {NodeRecord|undefined} */
  getNode(id) { return this._nodes.get(id); }
  /** @param {string} id node id @returns {boolean} */
  hasNode(id) { return this._nodes.has(id); }
  /** @param {string} id node id @returns {string|null} */
  getAlias(id) {
    const node = this._nodes.get(id);
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
  /** Distinct chain ids present, numeric ascending. @returns {string[]} */
  chains() { return [...this._chainCounts.keys()].sort((x, y) => Number(x) - Number(y)); }

  // --- integrity ------------------------------------------------------------

  /**
   * Dev invariant check (spec Definition-of-Done): every edge endpoint exists as
   * a node ON THE EDGE'S CHAIN (fromId/toId === nodeId(chainId, from/to));
   * edgeKeys <-> edges parity; keys prefixed `chainId|`; node ids derived from
   * chainId+address; decimal chain ids; chain counts match the nodes; every node
   * has meta; aliases reference existing nodes.
   * @returns {{ ok:boolean, errors:string[] }}
   */
  checkInvariants() {
    const errors = [];
    const decimal = (v) => typeof v === "string" && /^\d+$/.test(v);

    if (this._edgeKeys.size !== this._edges.size) {
      errors.push(`edgeKeys/edges size parity broken: ${this._edgeKeys.size} keys vs ${this._edges.size} edges`);
    }
    for (const key of this._edgeKeys) {
      if (!this._edges.has(key)) errors.push(`edgeKeys has key with no edge: ${key}`);
    }
    for (const [key, edge] of this._edges) {
      if (!this._edgeKeys.has(key)) errors.push(`edge has no matching edgeKey: ${key}`);
      if (edge.key !== key) errors.push(`edge.key does not match map key: ${key}`);
      if (!decimal(edge.chainId)) errors.push(`edge ${key} has invalid chainId: ${edge.chainId}`);
      if (!key.startsWith(edge.chainId + "|")) errors.push(`edge ${key} key not prefixed by its chainId ${edge.chainId}`);
      if (edge.fromId !== nodeId(edge.chainId, edge.from)) errors.push(`edge ${key} fromId ${edge.fromId} != chainId:from`);
      if (edge.toId !== nodeId(edge.chainId, edge.to)) errors.push(`edge ${key} toId ${edge.toId} != chainId:to`);
      if (!this._nodes.has(edge.fromId)) errors.push(`edge ${key} references missing from-node: ${edge.fromId}`);
      if (!this._nodes.has(edge.toId)) errors.push(`edge ${key} references missing to-node: ${edge.toId}`);
    }
    const counts = new Map();
    for (const [id, node] of this._nodes) {
      if (node.id !== id) errors.push(`node.id does not match map key: ${id}`);
      if (node.id !== nodeId(node.chainId, node.address)) errors.push(`node ${id} id != chainId:address`);
      if (!decimal(node.chainId)) errors.push(`node ${id} has invalid chainId: ${node.chainId}`);
      counts.set(node.chainId, (counts.get(node.chainId) || 0) + 1);
      if (typeof node.depth !== "number") errors.push(`node ${id} missing numeric depth`);
      if (typeof node.isRoot !== "boolean") errors.push(`node ${id} missing boolean isRoot`);
      if (!("alias" in node)) errors.push(`node ${id} missing alias field`);
      else if (node.alias !== null && typeof node.alias !== "string") errors.push(`node ${id} has invalid alias type`);
    }
    const countsMatch = counts.size === this._chainCounts.size
      && [...counts].every(([cid, n]) => this._chainCounts.get(cid) === n);
    if (!countsMatch) errors.push("chain counts out of step with nodes");

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
