import { describe, test, expect } from "bun:test";
import { nextRequest, advance, hasMoreHistory, historyState, sanitizeHistory } from "../src/history.js";
const rows = (...b) => b.map((n, i) => ({ blockNumber: String(n), hash: "0x" + i }));
const E = (o) => ({ oldestBlock: "800", blockPage: 0, pageSize: 0, done: false, count: 3, ...o });

describe("nextRequest", () => {
  test("no entry -> newest page", () => expect(nextRequest(undefined, 20)).toEqual({ page: 1, offset: 20 }));
  test("done -> null", () => expect(nextRequest(E({ done: true }), 20)).toBeNull());
  test("normal mode -> inclusive endblock", () =>
    expect(nextRequest(E(), 20)).toEqual({ endblock: 800, page: 1, offset: 20 }));
  test("in-block, same N -> next page inside the block", () =>
    expect(nextRequest(E({ blockPage: 3, pageSize: 20 }), 20)).toEqual({ startblock: 800, endblock: 800, page: 3, offset: 20 }));
  test("in-block, N changed -> restart block at page 1", () =>
    expect(nextRequest(E({ blockPage: 3, pageSize: 20 }), 50)).toEqual({ startblock: 800, endblock: 800, page: 1, offset: 50 }));
});

describe("advance", () => {
  const first = { page: 1, offset: 3 };
  test("first load, full batch -> cursor at min block", () =>
    expect(advance(undefined, rows(900, 850, 800), 3, first)).toEqual(E({ count: 3 })));
  test("first load, short batch -> done", () =>
    expect(advance(undefined, rows(900), 3, first)).toMatchObject({ done: true, count: 1, oldestBlock: "900" }));
  test("first load, empty -> done at 0", () =>
    expect(advance(undefined, [], 20, { page: 1, offset: 20 })).toMatchObject({ done: true, count: 0, oldestBlock: "0" }));
  test("older batch makes progress", () =>
    expect(advance(E(), rows(800, 700, 650), 3, { endblock: 800, page: 1, offset: 3 })).toEqual(E({ oldestBlock: "650", count: 6 })));
  test("full batch stuck on boundary block -> in-block paging page 2", () =>
    expect(advance(E(), rows(800, 800, 800), 3, { endblock: 800, page: 1, offset: 3 })).toEqual(E({ blockPage: 2, pageSize: 3, count: 6 })));
  test("rows above cursor (API anomaly) -> treated as boundary, no backwards jump", () =>
    expect(advance(E(), rows(900, 900, 900), 3, { endblock: 800, page: 1, offset: 3 })).toMatchObject({ oldestBlock: "800", blockPage: 2 }));
  test("in-block full -> next page", () =>
    expect(advance(E({ blockPage: 2, pageSize: 3 }), rows(800, 800, 800), 3, { startblock: 800, endblock: 800, page: 2, offset: 3 })).toMatchObject({ blockPage: 3, pageSize: 3 }));
  test("in-block restart after N change records new pageSize", () =>
    expect(advance(E({ blockPage: 4, pageSize: 3 }), rows(800, 800, 800, 800, 800), 5, { startblock: 800, endblock: 800, page: 1, offset: 5 })).toMatchObject({ blockPage: 2, pageSize: 5 }));
  test("in-block short -> block exhausted, resume below it", () =>
    expect(advance(E({ blockPage: 3, pageSize: 3 }), rows(800), 3, { startblock: 800, endblock: 800, page: 3, offset: 3 })).toMatchObject({ oldestBlock: "799", blockPage: 0, done: false }));
  test("in-block short at block 0 -> done", () =>
    expect(advance(E({ oldestBlock: "0", blockPage: 2, pageSize: 3 }), [], 3, { startblock: 0, endblock: 0, page: 2, offset: 3 })).toMatchObject({ done: true }));
});

describe("queries + sanitize", () => {
  test("hasMoreHistory", () => {
    expect(hasMoreHistory({})).toBe(false);
    expect(hasMoreHistory({ history: { txlist: E({ done: true }), tokentx: E() } })).toBe(true);
    expect(hasMoreHistory({ history: { txlist: E({ done: true }) } })).toBe(false);
  });
  test("historyState per action", () =>
    expect(historyState({ history: { txlist: E({ count: 40 }), tokentx: E({ done: true, count: 7 }) } }, ["txlist", "tokentx", "txlistinternal"]))
      .toEqual([{ action: "txlist", state: "more", count: 40 }, { action: "tokentx", state: "complete", count: 7 }, { action: "txlistinternal", state: "unloaded", count: 0 }]));
  test("sanitizeHistory keeps valid, drops malformed/unknown/prototype keys", () => {
    const raw = JSON.parse('{"txlist":{"oldestBlock":"800","blockPage":0,"pageSize":0,"done":false,"count":3},"tokentx":{"oldestBlock":"abc","blockPage":0,"pageSize":0,"done":false,"count":1},"bogus":{"oldestBlock":"1","blockPage":0,"pageSize":0,"done":true,"count":0},"__proto__":{"x":1},"txlistinternal":{"oldestBlock":"5","blockPage":-1,"pageSize":0,"done":false,"count":0}}');
    expect(sanitizeHistory(raw)).toEqual({ txlist: E() });
    expect(sanitizeHistory(null)).toBeUndefined();
    expect(sanitizeHistory({ bogus: {} })).toBeUndefined();
  });
});
