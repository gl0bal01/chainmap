// =============================================================================
// history.js — pure, DOM-free block-cursor math for per-node "Load older".
//
// Each node keeps one HistoryEntry per Etherscan action (txlist, tokentx, ...).
// The cursor is the oldest block seen so far; the next request asks for rows
// at or below it (inclusive, so a cut-off boundary block is re-read; edge
// dedup drops the repeats). When a single block holds >= N rows the cursor
// cannot move, so we page inside that block (startblock = endblock = cursor).
// Used by graphStore, scanner, render and ui; has no dependencies but config.
// =============================================================================

import { TX_TYPE_GROUPS } from "./config.js";

/** @typedef {{ oldestBlock:string, blockPage:number, pageSize:number, done:boolean, count:number }} HistoryEntry */
/** @typedef {{ page:number, offset:number, startblock?:number, endblock?:number }} HistoryRequest */

const KNOWN_ACTIONS = new Set(
  Object.values(TX_TYPE_GROUPS).flatMap((g) => g.map((t) => t.action)),
);
const BAD_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Fetch options for the next older page, or null when the action is done.
 * @param {HistoryEntry|undefined} entry
 * @param {number} n per-address row limit
 * @returns {HistoryRequest|null}
 */
export function nextRequest(entry, n) {
  if (!entry) return { page: 1, offset: n };
  if (entry.done) return null;
  const b = Number(entry.oldestBlock);
  if (entry.blockPage === 0) return { endblock: b, page: 1, offset: n };
  // Same page size -> continue; changed N would skip rows, so restart the block.
  const page = entry.pageSize === n ? entry.blockPage : 1;
  return { startblock: b, endblock: b, page, offset: n };
}

/**
 * New entry after fetching `rows` with `req`.
 * @param {HistoryEntry|undefined} entry
 * @param {object[]} rows
 * @param {number} n
 * @param {HistoryRequest} req
 * @returns {HistoryEntry}
 */
export function advance(entry, rows, n, req) {
  const count = (entry ? entry.count : 0) + rows.length;
  const prev = entry ? Number(entry.oldestBlock) : undefined;
  const inBlock = req.startblock !== undefined;
  // Digits only: Number("")/Number(null) are 0 and would drop the cursor to block 0.
  const blocks = rows.filter((r) => /^\d+$/.test(String(r.blockNumber))).map((r) => Number(r.blockNumber));
  const min = blocks.length ? Math.min(...blocks) : undefined;
  const mk = (oldest, blockPage, pageSize, done) => ({
    oldestBlock: String(oldest), blockPage, pageSize, done, count,
  });

  if (rows.length < n) {
    if (inBlock) {
      return prev - 1 < 0 ? mk(prev, 0, 0, true) : mk(prev - 1, 0, 0, false);
    }
    const oldest = min === undefined ? (prev ?? 0) : prev === undefined ? min : Math.min(prev, min);
    return mk(oldest, 0, 0, true);
  }
  // Full batch.
  if (inBlock) return mk(prev, req.page + 1, n, false);
  if (min === undefined) return mk(prev ?? 0, 0, 0, true);
  if (prev === undefined || min < prev) return mk(min, 0, 0, false);
  // No progress. min === prev: busy boundary block, page 1 was just read.
  // min > prev: API ignored endblock, page 1 of the cursor block is unread.
  return min === prev ? mk(prev, 2, n, false) : mk(prev, 1, n, false);
}

/** @param {{history?:object}} node */
export function hasMoreHistory(node) {
  return !!node.history && Object.values(node.history).some((e) => e && e.done === false);
}

/**
 * @param {{history?:object}} node
 * @param {string[]} actions
 * @returns {Array<{ action:string, state:'unloaded'|'more'|'complete', count:number }>}
 */
export function historyState(node, actions) {
  return actions.map((action) => {
    const e = node.history && node.history[action];
    if (!e) return { action, state: "unloaded", count: 0 };
    return { action, state: e.done ? "complete" : "more", count: e.count };
  });
}

const isUint = (v) => Number.isInteger(v) && v >= 0;

/**
 * Validate untrusted (workspace) history; drops malformed/unknown entries.
 * @param {unknown} raw
 * @returns {Record<string,HistoryEntry>|undefined}
 */
export function sanitizeHistory(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const out = {};
  let any = false;
  for (const k of Object.keys(raw)) {
    if (BAD_KEYS.has(k) || !KNOWN_ACTIONS.has(k)) continue;
    const e = raw[k];
    if (
      e && typeof e === "object" &&
      typeof e.oldestBlock === "string" && /^\d+$/.test(e.oldestBlock) &&
      Number.isSafeInteger(Number(e.oldestBlock)) &&
      isUint(e.blockPage) && isUint(e.pageSize) && isUint(e.count) &&
      typeof e.done === "boolean"
    ) {
      out[k] = {
        oldestBlock: e.oldestBlock, blockPage: e.blockPage,
        pageSize: e.pageSize, done: e.done, count: e.count,
      };
      any = true;
    }
  }
  return any ? out : undefined;
}
