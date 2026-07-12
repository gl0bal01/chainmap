# Bridge-follow ENGINE (pure core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build the pure, Node-testable engine of the bridge-follow feature (design: `docs/superpowers/specs/2026-07-13-bridge-follow-design.md`): a bridge registry, exit detection over the graph, cross-chain release matching, and a fake-injectable dest-chain scan orchestrator — all unit-tested, zero DOM.

**Architecture:** New pure modules (`bridgeRegistry.js`, `bridgeFollow.js`) mirroring the existing `knownAddresses.js`/`riskFlags.js`/`peelChain.js` style. NO `graphStore` mutation (reads `store.listEdges()` output only). NO DOM, NO `main.js`/`index.html` changes in THIS plan — the UI panel + composition wiring are a separate follow-up that needs in-browser verification.

**Tech Stack:** Native ES modules, `bun test` + happy-dom, Etherscan v2 client (injectable), same-origin JSON data.

## Global Constraints

- Addresses **lowercased** canonical ids; every registry key lowercased. Copied from CLAUDE.md.
- **Strictly additive & pure**: these modules never mutate `graphStore` and never touch the DOM. A bridge-follow failure must never be able to break the scan/render path (the future wiring will call these defensively).
- Data fetched **same origin** (`connect-src 'self'`); dest-chain scan uses the same `api.etherscan.io` host via `chainid` (Etherscan v2). No new CSP host.
- Registry entries are **verified addresses only** — the seed reuses the 4 canonical bridge addresses already merged into `data/known-addresses.json` (chains all in `config.CHAINS`). Never invent a bridge address.
- Confidence labels are `exact | amount+time | weak` — **never** "confirmed".
- Tests run with `bun test`. Commit author+committer email = `gl0bal01@proton.me`; no AI attribution in messages. New `added` dates use `2026-07-13`.

---

### Task 1: Bridge registry (`data/bridges.json` + `bridgeRegistry.js`)

**Files:**
- Create: `data/bridges.json`
- Modify: `src/config.js` (`DATA_PATHS` — add `bridges`)
- Create: `src/bridgeRegistry.js`
- Test: `test/bridgeRegistry.test.js`

**Interfaces:**
- Produces: `loadBridges(fetchImpl?, path?): Promise<BridgeData>` (async, empty-on-failure, never throws — mirror `knownAddresses.loadKnownAddresses`); `bridgeInfo(address, chainId, data): BridgeEntry|null`.
- `BridgeData` = `Record<chainIdStr, Record<lcAddress, BridgeEntry>>`; `BridgeEntry` = `{ name:string, kind:'lock-mint'|'liquidity', destChains:number[], depositSelector?:string, recipientParam?:string }`.

- [ ] **Step 1: Write the registry data** (`data/bridges.json`) — the 4 verified canonical lock-mint bridges (addresses already in `data/known-addresses.json`, dest chains all in `CHAINS`):

```json
{
  "1": {
    "0xa0c68c638235ee32657e8f720a23cec1bfc77c77": { "name": "Polygon PoS: RootChainManager", "kind": "lock-mint", "destChains": [137] },
    "0x99c9fc46f92e8a1c0dec1b1747d010903e884be1": { "name": "Optimism: L1StandardBridge", "kind": "lock-mint", "destChains": [10] },
    "0x3154cf16ccdb4c6d922629664174b904d80f2c35": { "name": "Base: L1StandardBridge", "kind": "lock-mint", "destChains": [8453] },
    "0x72ce9c846789fdb6fc1f34ac4ad25dd9ef7031ef": { "name": "Arbitrum One: L1 Gateway Router", "kind": "lock-mint", "destChains": [42161] }
  }
}
```

- [ ] **Step 2: Add the data path** — in `src/config.js` `DATA_PATHS`, add: `bridges: "./data/bridges.json",` (next to `knownAddresses`).

- [ ] **Step 3: Write the failing test** (`test/bridgeRegistry.test.js`):

```js
import { test, expect, describe } from "bun:test";
import { loadBridges, bridgeInfo } from "../src/bridgeRegistry.js";
import bridgesData from "../data/bridges.json";
import { CHAINS } from "../src/config.js";
import { isValidAddress } from "../src/format.js";

const fakeFetch = (ok, body) => async () => ({ ok, json: async () => body });

describe("loadBridges", () => {
  test("returns data on ok, {} on failure (never throws)", async () => {
    const d = { "1": { "0xabc0000000000000000000000000000000000001": { name: "X", kind: "lock-mint", destChains: [137] } } };
    expect(await loadBridges(fakeFetch(true, d))).toEqual(d);
    expect(await loadBridges(fakeFetch(false, d))).toEqual({});
    expect(await loadBridges(async () => { throw new Error("net"); })).toEqual({});
    expect(await loadBridges(fakeFetch(true, "nope"))).toEqual({});
  });
});

describe("bridgeInfo", () => {
  const data = { "1": { "0xabc0000000000000000000000000000000000001": { name: "X", kind: "lock-mint", destChains: [137] } } };
  test("chain-scoped, case-insensitive lookup; null on miss", () => {
    expect(bridgeInfo("0xABC0000000000000000000000000000000000001", 1, data).name).toBe("X");
    expect(bridgeInfo("0xabc0000000000000000000000000000000000001", "1", data).kind).toBe("lock-mint");
    expect(bridgeInfo("0xabc0000000000000000000000000000000000001", 137, data)).toBeNull();
    expect(bridgeInfo("0x0000000000000000000000000000000000000009", 1, data)).toBeNull();
    expect(bridgeInfo("0xabc", 1, null)).toBeNull();
  });
});

describe("data/bridges.json validity", () => {
  const chainIds = new Set(CHAINS.map((c) => c.id));
  test("keys numeric chain-id strings; addresses lowercased+valid; kind + destChains sound", () => {
    for (const chainId of Object.keys(bridgesData)) {
      expect(String(Number(chainId))).toBe(chainId);
      for (const [addr, entry] of Object.entries(bridgesData[chainId])) {
        expect(addr).toBe(addr.toLowerCase());
        expect(isValidAddress(addr)).toBe(true);
        expect(["lock-mint", "liquidity"]).toContain(entry.kind);
        expect(Array.isArray(entry.destChains)).toBe(true);
        expect(entry.destChains.length).toBeGreaterThan(0);
        for (const dc of entry.destChains) expect(chainIds.has(dc)).toBe(true); // dest chain must be supported
        expect(typeof entry.name).toBe("string");
        expect(entry.name.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
```

- [ ] **Step 4: Run test to verify it fails** — `bun test test/bridgeRegistry.test.js` → FAIL (module missing).

- [ ] **Step 5: Implement `src/bridgeRegistry.js`** (mirror `knownAddresses.js` exactly):

```js
// =============================================================================
// bridgeRegistry.js — static bridge registry from a bundled local JSON. NO
// third-party network call (same-origin fetch, CSP connect-src 'self'). Chain-
// scoped. Load is async + empty-on-failure; lookup is pure. Never throws.
// =============================================================================

import { DATA_PATHS } from "./config.js";

/**
 * @typedef {{ name:string, kind:'lock-mint'|'liquidity', destChains:number[],
 *             depositSelector?:string, recipientParam?:string }} BridgeEntry
 * @typedef {Record<string, Record<string, BridgeEntry>>} BridgeData
 */

/**
 * Load the bundled bridge registry. Empty object on any failure (never rejects).
 * @param {typeof fetch} [fetchImpl]
 * @param {string} [path]
 * @returns {Promise<BridgeData>}
 */
export async function loadBridges(fetchImpl, path) {
  const doFetch = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  const url = path || DATA_PATHS.bridges;
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
 * Look up a bridge entry for an address on a chain.
 * @param {string} address
 * @param {number|string} chainId
 * @param {BridgeData} data
 * @returns {BridgeEntry|null}
 */
export function bridgeInfo(address, chainId, data) {
  if (!data || !address) return null;
  const chain = data[String(chainId)];
  if (!chain) return null;
  const entry = chain[String(address).toLowerCase()];
  return entry || null;
}
```

- [ ] **Step 6: Run tests to verify pass** — `bun test test/bridgeRegistry.test.js` then full `bun test` → all green.

- [ ] **Step 7: Commit**

```bash
git add data/bridges.json src/config.js src/bridgeRegistry.js test/bridgeRegistry.test.js
git commit -m "feat(bridge): bridge registry (data/bridges.json + bridgeRegistry loader/lookup)"
```

---

### Task 2: `findBridgeExits` (pure exit detection)

**Files:**
- Create: `src/bridgeFollow.js`
- Test: `test/bridgeFollow.test.js`

**Interfaces:**
- Consumes: `EdgeRecord[]` (from `store.listEdges()`), `BridgeData` (Task 1), a chainId.
- Produces: `findBridgeExits(edges, registry, chainId): BridgeExit[]` where
  `BridgeExit = { bridgeAddr, name, kind, destChains, amountText, symbol, timeStamp, depositor, recipient, hash }`.

- [ ] **Step 1: Write the failing test** (`test/bridgeFollow.test.js`):

```js
import { test, expect, describe } from "bun:test";
import { findBridgeExits } from "../src/bridgeFollow.js";

const REG = {
  "1": {
    "0xbbbb000000000000000000000000000000000001": { name: "Test Bridge", kind: "lock-mint", destChains: [137] },
    "0xbbbb000000000000000000000000000000000002": { name: "LP Bridge", kind: "liquidity", destChains: [10] },
  },
};

const edge = (o) => ({
  from: "0xdead000000000000000000000000000000000001",
  to: "0xbbbb000000000000000000000000000000000001",
  amountText: "50", symbol: "ETH", timeStamp: "1700000000", hash: "0xh1",
  methodId: "", methodArgs: [], ...o,
});

describe("findBridgeExits", () => {
  test("detects a lock-mint bridge edge; recipient defaults to depositor", () => {
    const exits = findBridgeExits([edge({})], REG, 1);
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({
      bridgeAddr: "0xbbbb000000000000000000000000000000000001",
      name: "Test Bridge", kind: "lock-mint", destChains: [137],
      amountText: "50", symbol: "ETH", timeStamp: "1700000000",
      depositor: "0xdead000000000000000000000000000000000001",
      recipient: "0xdead000000000000000000000000000000000001", // defaults to depositor
      hash: "0xh1",
    });
  });

  test("uses a decoded recipient arg (by name) when present and valid", () => {
    const exits = findBridgeExits([edge({
      methodArgs: [{ type: "address", value: "0xFEED000000000000000000000000000000000009", name: "recipient" }],
    })], REG, 1);
    expect(exits[0].recipient).toBe("0xfeed000000000000000000000000000000000009"); // lowercased
  });

  test("liquidity bridge is returned but tagged kind:liquidity", () => {
    const exits = findBridgeExits([edge({ to: "0xbbbb000000000000000000000000000000000002" })], REG, 1);
    expect(exits[0].kind).toBe("liquidity");
  });

  test("ignores edges whose 'to' is not a registered bridge, and other chains", () => {
    expect(findBridgeExits([edge({ to: "0x0000000000000000000000000000000000000009" })], REG, 1)).toEqual([]);
    expect(findBridgeExits([edge({})], REG, 137)).toEqual([]);
    expect(findBridgeExits([], REG, 1)).toEqual([]);
    expect(findBridgeExits([edge({})], null, 1)).toEqual([]);
  });

  test("does not mutate its inputs (pure over plain edge arrays)", () => {
    const edges = [edge({})];
    const snapshot = JSON.stringify(edges);
    findBridgeExits(edges, REG, 1);
    expect(JSON.stringify(edges)).toBe(snapshot);
  });
});
```

- [ ] **Step 2: Run to verify fail** — `bun test test/bridgeFollow.test.js` → FAIL (function missing).

- [ ] **Step 3: Implement `findBridgeExits`** in `src/bridgeFollow.js`:

```js
// =============================================================================
// bridgeFollow.js — pure, DOM-free bridge-follow logic. Detects fund exits into
// known lock-mint bridges and correlates candidate releases on the destination
// chain. NO graphStore, NO vis, NO DOM. Confidence is always a candidate label,
// never "confirmed". Node-testable.
// =============================================================================

import { isValidAddress, lc } from "./format.js";
import { bridgeInfo } from "./bridgeRegistry.js";

function argByName(args, name) {
  const a = (args || []).find((x) => x && x.name === name);
  return a ? a.value : null;
}

/**
 * Find fund exits into known bridges among a set of edges.
 * @param {import('./graphStore.js').EdgeRecord[]} edges
 * @param {import('./bridgeRegistry.js').BridgeData} registry
 * @param {number|string} chainId  chain the edges belong to
 * @returns {Array<{bridgeAddr:string,name:string,kind:string,destChains:number[],
 *   amountText:string,symbol:string,timeStamp:string,depositor:string,recipient:string,hash:string}>}
 */
export function findBridgeExits(edges, registry, chainId) {
  const out = [];
  if (!registry || !Array.isArray(edges)) return out;
  for (const e of edges) {
    if (!e) continue;
    const to = lc(e.to);
    const entry = bridgeInfo(to, chainId, registry);
    if (!entry) continue;
    const depositor = lc(e.from);
    const decoded = argByName(e.methodArgs, "recipient");
    const recipient = decoded && isValidAddress(decoded) ? lc(decoded) : depositor;
    out.push({
      bridgeAddr: to,
      name: entry.name,
      kind: entry.kind,
      destChains: entry.destChains || [],
      amountText: e.amountText || "",
      symbol: e.symbol || "",
      timeStamp: e.timeStamp || "",
      depositor,
      recipient,
      hash: e.hash || "",
    });
  }
  return out;
}
```

- [ ] **Step 4: Run tests** — focused then full `bun test` → green.

- [ ] **Step 5: Commit**

```bash
git add src/bridgeFollow.js test/bridgeFollow.test.js
git commit -m "feat(bridge): findBridgeExits — detect fund exits into known bridges"
```

---

### Task 3: `matchReleases` (pure cross-chain matching)

**Files:**
- Modify: `src/bridgeFollow.js` (add `matchReleases`)
- Test: `test/bridgeFollow.test.js` (append a describe block)

**Interfaces:**
- Consumes: a `BridgeExit` (Task 2) and an array of NORMALIZED dest-chain candidates
  `{ to:string, timeStamp:string, amountText:string, hash:string, symbol:string }` (the orchestrator in Task 4 normalizes raw Etherscan txs into this shape — matchReleases stays pure and takes simple inputs).
- Produces: `matchReleases(exit, candidates, opts?): Array<{hash,to,symbol,confidence,matched}>` sorted best-first;
  `confidence ∈ 'exact'|'amount+time'|'weak'`; `matched = { recipient:boolean, amountDelta:number|null, timeDeltaSecs:number }`.

- [ ] **Step 1: Write the failing test** (append to `test/bridgeFollow.test.js`):

```js
import { matchReleases } from "../src/bridgeFollow.js";

const EXIT = {
  recipient: "0xfeed000000000000000000000000000000000009",
  amountText: "50", timeStamp: "1700000000",
};
const cand = (o) => ({ to: "0xfeed000000000000000000000000000000000009", timeStamp: "1700000600", amountText: "50", hash: "0xr", symbol: "WETH", ...o });

describe("matchReleases", () => {
  test("recipient + forward-time + tight amount => exact, sorted first", () => {
    const r = matchReleases(EXIT, [cand({})]);
    expect(r).toHaveLength(1);
    expect(r[0].confidence).toBe("exact");
    expect(r[0].matched.recipient).toBe(true);
    expect(r[0].matched.timeDeltaSecs).toBe(600);
  });

  test("excludes wrong recipient, and releases before the exit (time must move forward)", () => {
    expect(matchReleases(EXIT, [cand({ to: "0x0000000000000000000000000000000000000001" })])).toEqual([]);
    expect(matchReleases(EXIT, [cand({ timeStamp: "1699999999" })])).toEqual([]);
  });

  test("excludes releases outside the time window", () => {
    expect(matchReleases(EXIT, [cand({ timeStamp: String(1700000000 + 90000) })], { windowSecs: 86400 })).toEqual([]);
  });

  test("loose amount => amount+time; indeterminate amount => weak", () => {
    expect(matchReleases(EXIT, [cand({ amountText: "49" })])[0].confidence).toBe("amount+time"); // ~2% off
    expect(matchReleases(EXIT, [cand({ amountText: "indeterminate" })])[0].confidence).toBe("weak");
  });

  test("orders exact before amount+time before weak", () => {
    const r = matchReleases(EXIT, [
      cand({ amountText: "indeterminate", hash: "0xw" }),
      cand({ amountText: "49", hash: "0xa" }),
      cand({ amountText: "50", hash: "0xe" }),
    ]);
    expect(r.map((x) => x.hash)).toEqual(["0xe", "0xa", "0xw"]);
  });
});
```

- [ ] **Step 2: Run to verify fail** — `bun test test/bridgeFollow.test.js` → FAIL (matchReleases missing).

- [ ] **Step 3: Implement `matchReleases`** (append to `src/bridgeFollow.js`):

```js
const RANK = { exact: 0, "amount+time": 1, weak: 2 };

/**
 * Correlate candidate dest-chain releases to a bridge exit. Pure; candidates are
 * pre-normalized (see Task 4 orchestrator). Never asserts a match — every result
 * carries a candidate confidence.
 * @param {{recipient:string,amountText:string,timeStamp:string}} exit
 * @param {Array<{to:string,timeStamp:string,amountText:string,hash:string,symbol:string}>} candidates
 * @param {{windowSecs?:number,exactTol?:number,looseTol?:number}} [opts]
 * @returns {Array<{hash:string,to:string,symbol:string,confidence:'exact'|'amount+time'|'weak',
 *   matched:{recipient:boolean,amountDelta:number|null,timeDeltaSecs:number}}>}
 */
export function matchReleases(exit, candidates, opts) {
  const o = opts || {};
  const windowSecs = typeof o.windowSecs === "number" ? o.windowSecs : 86400;
  const exactTol = typeof o.exactTol === "number" ? o.exactTol : 0.005;
  const looseTol = typeof o.looseTol === "number" ? o.looseTol : 0.05;
  if (!exit || !Array.isArray(candidates)) return [];
  const recipient = lc(exit.recipient);
  const exitTs = Number(exit.timeStamp);
  const exitAmt = Number(exit.amountText);
  const out = [];
  for (const c of candidates) {
    if (!c || lc(c.to) !== recipient) continue;
    const ts = Number(c.timeStamp);
    if (!Number.isFinite(ts) || !Number.isFinite(exitTs)) continue;
    const dt = ts - exitTs;
    if (dt < 0 || dt > windowSecs) continue; // forward time, within window
    const candAmt = Number(c.amountText);
    let confidence = "weak";
    let amountDelta = null;
    if (Number.isFinite(candAmt) && Number.isFinite(exitAmt) && exitAmt > 0) {
      amountDelta = Math.abs(candAmt - exitAmt) / exitAmt;
      confidence = amountDelta <= exactTol ? "exact" : amountDelta <= looseTol ? "amount+time" : "weak";
    }
    out.push({ hash: c.hash, to: recipient, symbol: c.symbol || "", confidence,
      matched: { recipient: true, amountDelta, timeDeltaSecs: dt } });
  }
  out.sort((a, b) => (RANK[a.confidence] - RANK[b.confidence]) || (a.matched.timeDeltaSecs - b.matched.timeDeltaSecs));
  return out;
}
```

- [ ] **Step 4: Run tests** — focused then full `bun test` → green.

- [ ] **Step 5: Commit**

```bash
git add src/bridgeFollow.js test/bridgeFollow.test.js
git commit -m "feat(bridge): matchReleases — rank candidate cross-chain releases by confidence"
```

---

### Task 4: `followBridgeExit` (dest-chain scan orchestrator, fake-injectable)

**Files:**
- Modify: `src/bridgeFollow.js` (add `followBridgeExit`)
- Test: `test/bridgeFollow.test.js` (append)

**Interfaces:**
- Consumes: an Etherscan client (`fetchAction(address, action, opts)` — same shape as `etherscanClient.js`, has `setChainId`), a `RateLimiter` (`.run(fn)`), a `BridgeExit`, a dest chainId, and `formatUnits` for normalization.
- Produces: `followBridgeExit({ client, limiter, exit, destChainId, offset?, windowSecs?, signal? }): Promise<Candidate[]>` (the `matchReleases` output). Fetches the recipient's inbound native + ERC-20 txs on the dest chain, normalizes them, and matches. Never throws for fetch errors — resolves `[]` and is safe to call defensively.

- [ ] **Step 1: Write the failing test** (append to `test/bridgeFollow.test.js`):

```js
import { followBridgeExit } from "../src/bridgeFollow.js";

// Minimal fake limiter (runs fn immediately) + fake client.
const limiter = { run: (fn) => fn() };
function fakeClient(byAction) {
  return { chainId: null, setChainId(id) { this.chainId = id; },
    async fetchAction(address, action) { return (byAction[action] || []); } };
}

const EXIT4 = { recipient: "0xfeed000000000000000000000000000000000009", amountText: "50", timeStamp: "1700000000" };

describe("followBridgeExit", () => {
  test("sets dest chain, fetches recipient inbound, returns ranked candidates", async () => {
    const client = fakeClient({
      txlist: [{ to: "0xFEED000000000000000000000000000000000009", value: "50000000000000000000", tokenDecimal: "", timeStamp: "1700000600", hash: "0xr1" }],
      tokentx: [],
    });
    const r = await followBridgeExit({ client, limiter, exit: EXIT4, destChainId: 137, offset: 20 });
    expect(client.chainId).toBe(137);
    expect(r).toHaveLength(1);
    expect(r[0].hash).toBe("0xr1");
    expect(r[0].confidence).toBe("exact"); // 50e18 / 18 decimals == 50
  });

  test("resolves [] (never throws) when a fetch errors", async () => {
    const client = { setChainId() {}, async fetchAction() { throw new Error("boom"); } };
    await expect(followBridgeExit({ client, limiter, exit: EXIT4, destChainId: 137 })).resolves.toEqual([]);
  });

  test("filters non-recipient inbound out via matchReleases", async () => {
    const client = fakeClient({ txlist: [{ to: "0x0000000000000000000000000000000000000001", value: "50000000000000000000", timeStamp: "1700000600", hash: "0xx" }], tokentx: [] });
    expect(await followBridgeExit({ client, limiter, exit: EXIT4, destChainId: 137 })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify fail** — `bun test test/bridgeFollow.test.js` → FAIL.

- [ ] **Step 3: Implement `followBridgeExit`** (append to `src/bridgeFollow.js`; import `formatUnits`):

Update the import line at the top of `bridgeFollow.js` to also import `formatUnits`:
`import { isValidAddress, lc, formatUnits } from "./format.js";`

```js
/**
 * Normalize a raw Etherscan tx into a matchReleases candidate. Native txs
 * (no tokenDecimal) use 18 decimals; token txs use the tx's tokenDecimal.
 * @param {Record<string,string>} tx
 * @returns {{to:string,timeStamp:string,amountText:string,hash:string,symbol:string}}
 */
function normalizeTx(tx) {
  const dec = tx.tokenDecimal != null && tx.tokenDecimal !== "" ? tx.tokenDecimal : 18;
  const amt = formatUnits(tx.value, dec);
  return {
    to: lc(tx.to),
    timeStamp: tx.timeStamp || "",
    amountText: amt.indeterminate ? "indeterminate" : amt.text,
    hash: tx.hash || "",
    symbol: tx.tokenSymbol || "",
  };
}

/**
 * Scan the destination chain for candidate releases of a bridge exit. Sets the
 * client to the dest chain, fetches the recipient's recent inbound native +
 * ERC-20 txs (sampled "latest N", desc), normalizes, and correlates. Never
 * throws — resolves [] on any fetch failure so callers can invoke it defensively.
 * @param {{client:any, limiter:{run:(fn:()=>Promise<any>)=>Promise<any>},
 *   exit:any, destChainId:number, offset?:number, windowSecs?:number, signal?:any}} args
 * @returns {Promise<any[]>}
 */
export async function followBridgeExit(args) {
  const { client, limiter, exit, destChainId, offset = 25, windowSecs, signal } = args || {};
  if (!client || !exit || !exit.recipient) return [];
  try {
    client.setChainId(destChainId);
    const actions = ["txlist", "tokentx"];
    const raw = [];
    for (const action of actions) {
      const txs = await limiter.run(() =>
        client.fetchAction(exit.recipient, action, { offset, sort: "desc", signal })
      );
      if (Array.isArray(txs)) raw.push(...txs);
    }
    const candidates = raw.map(normalizeTx);
    return matchReleases(exit, candidates, windowSecs ? { windowSecs } : undefined);
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run tests** — focused then full `bun test` → green.

- [ ] **Step 5: Commit**

```bash
git add src/bridgeFollow.js test/bridgeFollow.test.js
git commit -m "feat(bridge): followBridgeExit — windowed dest-chain scan + release matching (defensive, fake-injectable)"
```

---

## Deferred (separate follow-up, needs in-browser verification)

NOT in this plan — build after a browser is available to click through:
- UI "Bridge leads" panel in `index.html` + `ui.js` render fn + en/fr i18n keys.
- `main.js` composition wiring: after a scan, `findBridgeExits(store.listEdges(), bridgeData, chainId)`; a "Follow" action → `followBridgeExit` with a dedicated dest client + the scan's rate limiter; render candidates with confidence. Must be strictly additive and wrapped so a bridge-follow failure can never break the scan/render path.
- Liquidity-bridge registry entries (Across/Stargate/Hop) with verified addresses → shown as "trace broken (liquidity pool)".
- Bridge deposit selectors in `selectors.js` (verified via 4byte/ABI) so `recipientParam` decoding beats the depositor fallback.

## Self-Review

**Spec coverage:** registry → Task 1; `findBridgeExits` → Task 2; `matchReleases` → Task 3; dest-scan orchestration → Task 4. UI/wiring/liquidity/selectors → explicitly Deferred (documented, not silently dropped). No `graphStore` mutation anywhere (modules take plain arrays/clients). Confidence labels per spec. **Placeholder scan:** none — every step has concrete code/tests. **Type consistency:** `BridgeExit` shape identical across Tasks 2→3→4; `matchReleases` candidate shape (`{to,timeStamp,amountText,hash,symbol}`) matches `normalizeTx` output in Task 4; `bridgeInfo`/`loadBridges` signatures consistent Task 1→2.
