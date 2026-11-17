import { describe, test, expect } from "bun:test";
import { nextRequest, advance, hasMoreHistory, historyState, sanitizeHistory } from "../src/history.js";
import { createTronClient } from "../src/tronClient.js";
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
    expect(advance(E(), rows(900, 900, 900), 3, { endblock: 800, page: 1, offset: 3 })).toMatchObject({ oldestBlock: "800", blockPage: 1, pageSize: 3 }));
  test("in-block full -> next page", () =>
    expect(advance(E({ blockPage: 2, pageSize: 3 }), rows(800, 800, 800), 3, { startblock: 800, endblock: 800, page: 2, offset: 3 })).toMatchObject({ blockPage: 3, pageSize: 3 }));
  test("in-block restart after N change records new pageSize", () =>
    expect(advance(E({ blockPage: 4, pageSize: 3 }), rows(800, 800, 800, 800, 800), 5, { startblock: 800, endblock: 800, page: 1, offset: 5 })).toMatchObject({ blockPage: 2, pageSize: 5 }));
  test("in-block short -> block exhausted, resume below it", () =>
    expect(advance(E({ blockPage: 3, pageSize: 3 }), rows(800), 3, { startblock: 800, endblock: 800, page: 3, offset: 3 })).toMatchObject({ oldestBlock: "799", blockPage: 0, done: false }));
  test("blank/null blockNumber is ignored, never drops the cursor to 0", () =>
    expect(advance(undefined, [...rows(900, 850), { blockNumber: "" }, { blockNumber: null }], 4, { page: 1, offset: 4 })).toMatchObject({ oldestBlock: "850", done: false }));
  test("in-block short at block 0 -> done", () =>
    expect(advance(E({ oldestBlock: "0", blockPage: 2, pageSize: 3 }), [], 3, { startblock: 0, endblock: 0, page: 2, offset: 3 })).toMatchObject({ done: true }));
});

describe("walk", () => {
  test("cursor walk: first load -> older -> stuck block -> in-block pages -> exhausted -> older -> done", () => {
    const n = 3;
    let e;
    let req = nextRequest(e, n);
    expect(req).toEqual({ page: 1, offset: 3 });
    e = advance(e, rows(900, 850, 800), n, req);
    req = nextRequest(e, n);
    expect(req).toEqual({ endblock: 800, page: 1, offset: 3 });
    e = advance(e, rows(800, 800, 800), n, req);
    req = nextRequest(e, n);
    expect(req).toEqual({ startblock: 800, endblock: 800, page: 2, offset: 3 });
    e = advance(e, rows(800, 800, 800), n, req);
    req = nextRequest(e, n);
    expect(req).toEqual({ startblock: 800, endblock: 800, page: 3, offset: 3 });
    e = advance(e, rows(800), n, req);
    expect(e).toMatchObject({ oldestBlock: "799", blockPage: 0, done: false });
    req = nextRequest(e, n);
    expect(req).toEqual({ endblock: 799, page: 1, offset: 3 });
    e = advance(e, rows(700), n, req);
    expect(e).toMatchObject({ done: true, count: 11 });
    expect(nextRequest(e, n)).toBeNull();
  });
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
    expect(sanitizeHistory({ txlist: { ...E(), oldestBlock: "99999999999999999999" } })).toBeUndefined();
    expect(sanitizeHistory(null)).toBeUndefined();
    expect(sanitizeHistory({ bogus: {} })).toBeUndefined();
  });
});

describe("advance: Tron ms cursor", () => {
  test("cursor preferred over blockNumber", () =>
    expect(advance(undefined, [{ blockNumber: "88077921", cursor: "1794907755000" }, { blockNumber: "88077699", cursor: "1794907089000" }], 2, { page: 1, offset: 2 }))
      .toEqual({ oldestBlock: "1794907089000", blockPage: 0, pageSize: 0, done: false, count: 2 }));
  test("a full page of skipped rows still advances", () =>
    expect(advance(undefined, [{ from: "", to: "", cursor: "1794600000000" }, { from: "", to: "", cursor: "1794500000000" }], 2, { page: 1, offset: 2 }))
      .toEqual({ oldestBlock: "1794500000000", blockPage: 0, pageSize: 0, done: false, count: 2 }));
  // Pin: already passes before the change (cannot go RED).
  test("in-block page past the last fingerprint moves below the block", () =>
    expect(advance({ oldestBlock: "1794907752000", blockPage: 2, pageSize: 3, done: false, count: 3 }, [], 3,
      { startblock: 1794907752000, endblock: 1794907752000, page: 2, offset: 3 }))
      .toEqual({ oldestBlock: "1794907751999", blockPage: 0, pageSize: 0, done: false, count: 3 }));
});

// Ruling 32: a short TronGrid page that still carries a fingerprint is filled by the client,
// so the history entry sees a full batch and stays open.
test("a filled Tron page is a full batch, not done", async () => {
  const pages = [
    { success: true, data: [{ block_timestamp: 1794907755000 }], meta: { fingerprint: "F1" } },
    { success: true, data: [{ block_timestamp: 1794907089000 }, { block_timestamp: 1794900000000 }], meta: {} },
  ];
  let i = 0;
  const fetchImpl = async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(pages[Math.min(i++, pages.length - 1)]));
    return { status: 200, arrayBuffer: async () => bytes.buffer };
  };
  const req = nextRequest(undefined, 3);
  const got = await createTronClient({ fetchImpl, minIntervalMs: 1 })
    .fetchAction("41d1c4bb7b2f39aba5707711719b2236b5b605af2e", "txlist", { offset: req.offset });
  expect(advance(undefined, got, 3, req)).toEqual({ oldestBlock: "1794900000000", blockPage: 0, pageSize: 0, done: false, count: 3 });
});
