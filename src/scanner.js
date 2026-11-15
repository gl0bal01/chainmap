// =============================================================================
// scanner.js — BFS scan orchestration over etherscanClient + graphStore.
// DOM-free, Node-testable (inject fakes). Cancellable via AbortSignal.
//
// STAGE A: interface frozen. STAGE B: implemented here.
// Correctness contract (do NOT reproduce the reference's weak points):
//  - enqueue dedup: track an `enqueued` set; enforce safetyCap AT ENQUEUE time
//  - drop failed txs (format.isFailedTx) before drawing edges
//  - nodes at depth >= maxDepth are added but NOT expanded
//  - cooperative + real cancel: check `signal.aborted`; in-flight fetch aborts
//  - sampling is explicit: fetch "latest N" (offset N, per etherscanClient defaults)
//  - count and report skipped / failed / capped in the summary
//
// loadOlder({ client, store, limiter, address, types, maxTxPerAddress, signal?, onLog? })
//  Per-node "load older" paging by block cursor (history.js). Fetches ONE older
//  page per selected type for `address`, ingests rows through the same path as
//  runScan (failed-tx drop, endpoint validation) but never expands new
//  counterparties (they land at depth+1, unfetched). Resolves with
//  { apiCalls, newEdges, newNodes, failed, skipped, planRequired, stopped,
//    allDone }; allDone = every selected type's cursor is done. Fetch errors
//  are logged per type and leave that cursor untouched (never marked done).
//  runScan records the first-load cursor (replace, not merge) per expanded node.
// =============================================================================

import { TX_TYPE_GROUPS } from "./config.js";
import { isValidAddress, lc, isFailedTx } from "./format.js";
import { nextRequest, advance } from "./history.js";

/**
 * @typedef {object} ScanProgress
 * @property {string} current   address being processed (lowercased)
 * @property {number} depth
 * @property {number} maxDepth
 * @property {number} processed  addresses dequeued+processed
 * @property {number} queued     current queue length
 * @property {number} apiCalls
 * @property {number} nodes
 * @property {number} edges
 * @property {number} skipped    endpoints skipped (invalid address, etc.)
 * @property {number} failed     txs dropped as failed/reverted
 */

/**
 * @typedef {object} ScanSummary
 * @property {string}  root
 * @property {number}  processed
 * @property {number}  apiCalls
 * @property {number}  nodes
 * @property {number}  edges
 * @property {number}  skipped
 * @property {number}  failed
 * @property {boolean} capped     safetyCap hit
 * @property {boolean} stopped    aborted by the user
 * @property {boolean} sampled    always true — data is "latest N", not full history
 * @property {number}  perAddressLimit  the offset used (maxTxPerAddress)
 * @property {number}  maxDepth
 * @property {boolean} planRequired scan aborted: chain needs a paid Etherscan plan
 * @property {string[]} errors    human-log keys/messages surfaced during the scan
 */

/**
 * @typedef {object} RunScanOptions
 * @property {import('./etherscanClient.js').EtherscanClient} client
 * @property {import('./graphStore.js').GraphStore} store
 * @property {import('./rateLimiter.js').RateLimiter} limiter
 * @property {string}  root                  address to start from
 * @property {number}  maxDepth
 * @property {number}  maxTxPerAddress        per-address per-action sample size (offset)
 * @property {number}  safetyCap              hard ceiling on addresses processed
 * @property {import('./config.js').TxTypeInfo[]} types  flattened selected tx types
 * @property {AbortSignal} signal             Stop -> aborts in-flight fetch + limiter
 * @property {(p:ScanProgress)=>void} [onProgress]
 * @property {(entry:{level:'info'|'error', key:string, params?:object})=>void} [onLog]
 */

/**
 * Read current node/edge counts from the store (single source of truth).
 * @param {import('./graphStore.js').GraphStore} store
 * @returns {{ nodes:number, edges:number }}
 */
function readCounts(store) {
  if (typeof store.stats === "function") {
    const s = store.stats() || {};
    return { nodes: s.nodes ?? 0, edges: s.edges ?? 0 };
  }
  return { nodes: 0, edges: 0 };
}

/**
 * Draw one fetched page into the store: drop failed txs, validate endpoints,
 * add both nodes (`cur` keeps `depth`, counterparties get depth+1) and the edge.
 * @returns {{ failed:number, skipped:number, others:string[] }} others = counterparties
 */
function ingestRows(store, cur, depth, typeInfo, txs) {
  let failed = 0;
  let skipped = 0;
  const others = [];
  for (const tx of txs) {
    // Drop failed/reverted txs before they ever become edges.
    if (isFailedTx(tx)) {
      failed++;
      continue;
    }
    const from = lc(tx.from);
    const to = lc(tx.to || tx.contractAddress); // contract-creation fallback
    if (!isValidAddress(from) || !isValidAddress(to)) {
      skipped++;
      continue;
    }
    store.addNode(from, { depth: from === cur ? depth : depth + 1 });
    store.addNode(to, { depth: to === cur ? depth : depth + 1 });
    store.addEdge({
      action: typeInfo.action,
      group: typeInfo.group,
      color: typeInfo.color,
      from,
      to,
      tx,
    });
    others.push(from === cur ? to : from);
  }
  return { failed, skipped, others };
}

/**
 * Log a per-request fetch failure. Returns true when it is plan_required
 * (every request on this chain will fail identically — caller must stop).
 */
function reportFetchError(e, address, action, onLog) {
  const message = (e && e.message) || String(e);
  const planRequired = !!(e && e.kind === "plan_required");
  if (typeof onLog === "function") {
    onLog(
      planRequired
        ? { level: "error", key: "error.planRequired" }
        : { level: "error", key: "error.fetch", params: { address, action, message } }
    );
  }
  return planRequired;
}

/**
 * Run the BFS scan. Mutates `store` (the sole state path). Resolves with a
 * {@link ScanSummary}; never throws for per-request failures (those are logged
 * and counted) — only throws on programmer error / bad options.
 * @param {RunScanOptions} opts
 * @returns {Promise<ScanSummary>}
 */
export async function runScan(opts) {
  const {
    client,
    store,
    limiter,
    root,
    maxDepth,
    maxTxPerAddress,
    safetyCap,
    types,
    signal,
    onProgress,
    onLog,
  } = opts;

  const rootLc = lc(root);

  // BFS state.
  const queue = [];
  const enqueued = new Set(); // enqueue-time dedup (never cleared)
  const visited = new Set(); // dequeue-time guard
  let enqueuedCount = 0; // total admitted to the queue (safetyCap is enforced here)

  // Counters surfaced in ScanProgress / ScanSummary.
  let processed = 0;
  let apiCalls = 0;
  let skipped = 0;
  let failed = 0;
  let capped = false;
  let stopped = false;
  let planRequired = false;
  /** @type {string[]} */
  const errors = [];

  /**
   * Admit an address to the BFS frontier. HARDENED vs the reference: dedup and
   * the safetyCap are enforced HERE (at enqueue), not on dequeue, so the total
   * number of addresses ever queued can never exceed `safetyCap`.
   * @param {string} address lowercased address
   * @param {number} depth
   * @returns {boolean} true iff actually enqueued
   */
  function enqueue(address, depth) {
    if (enqueued.has(address)) return false;
    if (enqueuedCount >= safetyCap) {
      capped = true;
      return false;
    }
    enqueued.add(address);
    enqueuedCount++;
    queue.push({ address, depth });
    return true;
  }

  function emitProgress(current, depth) {
    if (typeof onProgress !== "function") return;
    const { nodes, edges } = readCounts(store);
    onProgress({
      current,
      depth,
      maxDepth,
      processed,
      queued: queue.length,
      apiCalls,
      nodes,
      edges,
      skipped,
      failed,
    });
  }

  // Seed: the root is always a node and the first frontier entry.
  store.addNode(rootLc, { depth: 0, isRoot: true });
  enqueue(rootLc, 0);

  scan: while (queue.length) {
    // Real + cooperative cancel: honor an abort before touching more work.
    if (signal && signal.aborted) {
      stopped = true;
      break;
    }

    const { address: cur, depth } = queue.shift();
    if (visited.has(cur)) continue;
    visited.add(cur);
    processed++;

    // Ensure the node exists (merge = min depth; sticky root is preserved).
    store.addNode(cur, { depth });
    emitProgress(cur, depth);

    // Depth boundary: added above, but NOT expanded (no fetching past maxDepth).
    if (depth >= maxDepth) continue;

    for (const typeInfo of types) {
      if (signal && signal.aborted) {
        stopped = true;
        break;
      }

      apiCalls++;
      let txs;
      try {
        txs = await limiter.run(() =>
          client.fetchAction(cur, typeInfo.action, {
            offset: maxTxPerAddress,
            signal,
          })
        );
      } catch (e) {
        // Per-request failure: logged + counted, NEVER aborts the whole scan.
        errors.push((e && e.message) || String(e));
        if (reportFetchError(e, cur, typeInfo.action, onLog)) {
          planRequired = true;
          break scan;
        }
        continue;
      }

      if (!Array.isArray(txs)) continue;

      // First-load cursor from ALL returned rows (replaces any prior entry).
      store.setHistory(
        cur,
        typeInfo.action,
        advance(undefined, txs, maxTxPerAddress, { page: 1, offset: maxTxPerAddress })
      );

      const r = ingestRows(store, cur, depth, typeInfo, txs);
      failed += r.failed;
      skipped += r.skipped;
      // Expand the OTHER endpoint (enqueue dedup + cap enforced inside).
      for (const other of r.others) enqueue(other, depth + 1);
    }
  }

  const { nodes, edges } = readCounts(store);
  return {
    root: rootLc,
    processed,
    apiCalls,
    nodes,
    edges,
    skipped,
    failed,
    capped,
    stopped,
    planRequired,
    sampled: true,
    perAddressLimit: maxTxPerAddress,
    maxDepth,
    errors,
  };
}

/**
 * Flatten the three UI checkbox states into the concrete TxTypeInfo list.
 * @param {{ normal:boolean, internal:boolean, token:boolean }} selection
 * @returns {import('./config.js').TxTypeInfo[]}
 */
export function selectedTypes(selection) {
  const sel = selection || {};
  const out = [];
  if (sel.normal) out.push(...TX_TYPE_GROUPS.normal);
  if (sel.internal) out.push(...TX_TYPE_GROUPS.internal);
  if (sel.token) out.push(...TX_TYPE_GROUPS.token);
  return out;
}

/**
 * Fetch one older page per selected type for a single node. See header.
 * @param {object} opts
 * @returns {Promise<{apiCalls:number,newEdges:number,newNodes:number,failed:number,skipped:number,planRequired:boolean,stopped:boolean,allDone:boolean}>}
 */
export async function loadOlder(opts) {
  const { client, store, limiter, types, maxTxPerAddress, signal, onLog } = opts;
  const address = lc(opts.address);
  const res = {
    apiCalls: 0, newEdges: 0, newNodes: 0, failed: 0, skipped: 0,
    planRequired: false, stopped: false, allDone: false,
  };
  if (!store.hasNode(address)) return res;

  const depth = store.getNode(address).depth;
  const before = readCounts(store);

  for (const typeInfo of types) {
    if (signal && signal.aborted) {
      res.stopped = true;
      break;
    }
    if (!store.hasNode(address)) break; // pruned mid-load
    const { action } = typeInfo;
    const entry = (store.getNode(address).history || {})[action];
    const req = nextRequest(entry, maxTxPerAddress);
    if (!req) continue; // done

    res.apiCalls++;
    let txs;
    try {
      txs = await limiter.run(() =>
        client.fetchAction(address, action, { ...req, sort: "desc", signal })
      );
    } catch (e) {
      if (reportFetchError(e, address, action, onLog)) {
        res.planRequired = true;
        break;
      }
      continue; // cursor unchanged
    }
    if (!Array.isArray(txs) || !store.hasNode(address)) continue;

    const r = ingestRows(store, address, depth, typeInfo, txs);
    res.failed += r.failed;
    res.skipped += r.skipped;
    store.setHistory(address, action, advance(entry, txs, maxTxPerAddress, req));
  }

  const after = readCounts(store);
  res.newNodes = after.nodes - before.nodes;
  res.newEdges = after.edges - before.edges;
  const node = store.hasNode(address) ? store.getNode(address) : null;
  res.allDone = !!node && types.every((t) => node.history?.[t.action]?.done);
  return res;
}
