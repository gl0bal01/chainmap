# Load older history (per-node "load more") — design

Status: draft for owner approval · 2026-11-15 · ships in v1.1.0

## Intent

Every address is fetched as a **sample**: page 1, newest-first, `maxTxPerAddress`
rows (default 20) per tx type. A busy wallet with 5,000 transfers shows 20, and its
older flows are invisible. Today nothing even tells the investigator that an
address was cut off, versus fully loaded.

This feature lets the investigator, on any node, pull the **next-older batch** of
that address's history, and marks nodes whose history is known to be incomplete.
Sampling stays explicit — this makes the sample *extendable and honest*, it does
not pretend to be full history.

## Goals

1. **Incomplete marker:** a node whose fetch returned a full batch (`rows === N`)
   for any tx type is visibly marked "more history available".
2. **Load older:** a details-panel button on a selected node fetches the next N
   older rows per selected tx type and adds the resulting edges.
3. **First load for unexpanded nodes:** nodes never fetched (e.g. at max depth)
   get the same button, which fetches their newest N (= "expand this node").
4. **Resumable:** the per-node cursor survives workspace save/load.

## Non-goals

- No automatic exploration of new counterparties. **Owner decision:** new
  addresses found in older history are added as nodes, not enqueued/expanded.
  The investigator can load on them manually.
- No "load entire history" loop, no bulk "load older on all incomplete nodes".
- No change to the initial BFS scan's sampling (still newest N).
- No CSV schema change, no fiat values.

## Anti-goals (a failure even if it "works")

- **Silent gaps.** Skipping rows between batches without saying so. This is why
  page-number paging is rejected (see Approaches).
- Presenting a node as complete when it is not, or as incomplete when it is.
- Mixing chains: loading on chain B into a graph built on chain A.
- State outside `graphStore` (violates the single-source-of-truth rule).

## Constraints (from the codebase)

- `graphStore` is the only mutation path; view mirrors it via events. Overlays
  are display projections.
- Pure, DOM-free logic in testable modules; DOM only in `ui.js`/`render/*`/`main.js`.
- Amounts/blocks are strings; compare block numbers with `BigInt` (or `Number`
  is fine — block heights are < 2^53; builder's call, be consistent).
- i18n: logic emits `{key, params}`; en/fr parity enforced by test.
- Edges dedup on the precise key, so re-fetching an already-loaded row is harmless.
- Etherscan: `startblock`/`endblock` are **inclusive**; `page × offset ≤ 10,000`
  per query window. `etherscanClient.fetchAction` already accepts
  `page`, `sort`, `startblock`, `endblock`.
- Free-tier/paid-plan errors (`plan_required`, added in this release) must stop
  the operation with the existing localized message.

## Approaches considered

| | Approach | Verdict |
|---|---|---|
| **A** | **Block cursor stored on the node** (oldest block loaded, per tx type), next batch = `endblock = cursor` | **Chosen (owner approved).** No gaps, no 10k ceiling, resumable. |
| B | Page-number paging (`page = 2, 3…`) | Rejected: with newest-first sort, new txs shift pages → rows silently skipped; hard 10k-row ceiling. |
| C | Derive cursor from edges already in the graph (no new state) | Rejected: an edge touching X may come from scanning neighbor Y and be far older than X's own loaded window → cursor jumps, silent gap. |

## Design

### Data: `NodeRecord.history` (optional)

```js
history?: {
  [action: string]: {          // Etherscan action: txlist, txlistinternal, tokentx, ...
    oldestBlock: string,       // decimal string; min blockNumber among ALL rows returned so far
    blockPage: number,         // 0 = normal mode; k>0 = next page to read INSIDE oldestBlock (see edge case)
    pageSize: number,          // N in force when in-block paging started (only meaningful when blockPage > 0)
    done: boolean,             // true once a fetch returned < N rows (nothing older exists)
    count: number,             // total rows Etherscan returned for this action (incl. failed/invalid)
  }
}
```

- Absent `history` or absent action entry = **never loaded** for that type.
- The cursor reflects **what Etherscan returned**, not what was drawn: failed
  txs and rows with invalid endpoints still advance it (otherwise they'd be
  re-fetched forever).
- New store mutation `setHistory(address, action, entry)` → emits `node:update`.
  `loadSnapshot` must carry `history` through (it currently rebuilds nodes from
  an explicit field list and would drop it) after validating its shape; invalid
  entries are dropped, never trusted.

### Cursor rules (pure helpers, unit-tested)

`nextRequest(entry, N)` → fetch options, or `null` if `done`:
- no entry → `{ page: 1, offset: N }` (newest N — first load).
- `blockPage === 0` → `{ endblock: oldestBlock, page: 1, offset: N }` —
  **inclusive** so rows of the boundary block that were cut off are re-fetched;
  duplicates are dropped by edge dedup.
- `blockPage > 0` → `{ startblock: oldestBlock, endblock: oldestBlock, page: blockPage, offset: N }`
  **only if `pageSize === N`**. If the per-address limit changed since in-block
  paging started (form edit, or a workspace reopened with another N), restart
  that block at `page: 1` with the current N (and `pageSize = N`). Re-reading
  rows is harmless (dedup); `page = k` with a different offset would silently
  skip rows. *(builder-check finding; my call)*

`advance(entry, rows, N, request)` → new entry:
- `count += rows.length`.
- `rows.length < N`:
  - normal mode → `done: true`.
  - in-block mode → that block is exhausted: `oldestBlock = oldestBlock - 1`,
    `blockPage = 0`, `done` stays false (next request resumes below it). If
    `oldestBlock` would go below 0 → `done: true`.
- `rows.length === N`:
  - normal mode, min block of rows **< previous oldestBlock** (or first load) →
    `oldestBlock = min block`, progress made.
  - normal mode, min block **=== previous oldestBlock** (all N rows sit in the
    boundary block — busy contract) → switch to in-block paging:
    `blockPage = 2` (page 1 of that block is what we just read).
  - in-block mode → `blockPage += 1`.

The `page × offset ≤ 10,000` limit only matters in in-block mode (one address
with > 10,000 txs in a single block) — not reachable under block gas limits;
if Etherscan errors there, treat it as a normal fetch error.

### Logic: `loadOlder()` (in `scanner.js`)

```
loadOlder({ client, store, limiter, address, types, maxTxPerAddress, signal, onLog })
  → { apiCalls, newEdges, newNodes, failed, skipped, planRequired, stopped, allDone }
```

- For each selected type: `req = nextRequest(...)`; skip if `null`; fetch via
  `limiter.run(() => client.fetchAction(address, action, { ...req, sort: "desc", signal }))`;
  ingest rows; `store.setHistory(...)` with `advance(...)`.
- **Ingestion is shared with BFS:** extract the existing per-row loop in
  `runScan` (failed-tx drop, endpoint validation, `addNode`/`addEdge`) into one
  internal helper used by both. No duplicated rules.
- New counterparties: `addNode(other, { depth: node.depth + 1 })` (min-merge),
  **not enqueued**. Depth may exceed the scan's maxDepth; that's fine.
- `runScan` also records history for every node it expands, so the incomplete
  marker works right after a normal scan. **A scan fetch is always a first
  load: it replaces the node's entry for that action (`advance(undefined, …)`),
  never merges.** A rescan cannot know whether more than N new txs arrived since
  the earlier load, so merging could hide a gap at the newer end or keep a stale
  `done`. Cost: older batches already loaded must be re-clicked (duplicates
  dropped by dedup). *(builder-check finding; my call — honesty over convenience)*
- In `loadOlder`, `endblock = oldestBlock`, so a batch's min block can never be
  above `oldestBlock`; if it is (API misbehaving), treat as no progress and log.
- Errors: per-type failures are logged (`error.fetch`) and that type's cursor is
  left unchanged; `plan_required` stops the whole operation (same as scan).
- Abort via `signal` (Stop button) — cursor of an aborted type is unchanged.

### UI

**Graph marker** (`render/network.js`, display projection): node with any
history entry `done === false` → dashed border ("more history available").
Never-loaded nodes get no marker (they are the scan frontier; the details panel
says "not loaded"). Builder adds a legend line if the app has a legend.

**Details panel** (`ui.renderNodeDetails`) — new "History" row, one line per
currently selected tx type:
- `Normal: 40 fetched · older available` / `… · complete` / `not loaded`.

Plus a button:
- any selected type has `done === false` → **"Load older (+N)"**
- no history at all → **"Load transactions (+N)"**
- all selected types done → button disabled, label "History complete".
- Disabled while a scan or another load is running.

**After a load:** same post-processing as the end of `startScan` (projection
refresh, hubs, details re-render), a log line `Loaded {edges} new transfers for
{address}` and a status line. Reuse the existing `scanning` flag/abort controller
so Stop cancels it and scans/loads can't overlap.

### Chain guard

The graph does not currently remember its chain; changing the chain selector
after a scan leaves the old graph in place. So:
- `main.js` records `graphChainId` when a scan starts on an empty graph and when
  a workspace/demo is applied; cleared on reset.
- **A scan on a different chain while the graph is non-empty is refused**
  (localized message: reset the graph first, or switch back to {chain}).
  Multiple roots on the **same** chain still accumulate as today. *(owner
  decision — the builder check found that scans pile onto the graph without
  reset, so without this a cross-chain scan would slip past the load guard
  below.)* A true multi-chain graph (chain recorded per node/edge) is a
  separate future feature.
- Load is refused (localized message, button disabled) if
  `chainSelect.value !== graphChainId`.
- `saveWorkspace` writes `graphChainId` (falls back to the selector when no
  graph) — this also fixes the existing bug where a workspace saved after
  switching the selector records the wrong chain.

### Workspace

- No version bump: `history` is an optional additive node field;
  `workspace.parseWorkspace` already passes extra node fields through
  (`stripDangerousKeys`), `graphStore.loadSnapshot` validates it.
- Old workspaces/demo (no `history`): every node is "not loaded"; a click
  fetches the newest N (all duplicates → 0 new edges) and sets the cursor; the
  next click goes older. Acceptable, no migration.

### i18n

New keys (en + fr, real French): history row labels/states, both button labels,
"History complete", load log/status lines, chain-mismatch message, legend line.

## Tests (bun)

- Cursor helpers: first load; progress; `done` on short batch; inclusive
  boundary; same-block switch to in-block paging; in-block exhaustion steps
  below the block; never below 0.
- `loadOlder`: adds edges + nodes, **does not expand** counterparties, depth =
  node.depth+1, failed rows advance cursor but draw nothing, per-type error leaves
  cursor, `plan_required` stops, abort leaves cursor, done types skipped (0 calls).
- `runScan` records history; existing scan tests stay green (shared ingestion).
- `graphStore`: `setHistory` emits `node:update`; `loadSnapshot` keeps valid
  history, drops malformed.
- Workspace round-trip preserves history.
- DOM smoke for the details History row + button states (existing happy-dom style).
- Locale parity (existing test).

## Docs

Update `INTERFACES.md` (NodeRecord.history, setHistory, loadOlder, cursor
helpers), `CLAUDE.md` sampling convention ("latest N, extendable per node via
Load older"), README/README.fr feature list + LEARN note on sampling,
`package.json` version → 1.1.0.

## Open: `FETCH.endblock = 99_999_999`

Every request sends `endblock=99999999`. Arbitrum One, OP Mainnet and BNB Chain
are past block 100M; if Etherscan applies it literally, "newest N" on those
chains is really "newest before block 1e8" — affects the existing scan and this
feature's first load. **Pending owner's one-off test with their key** (Arbitrum
USDC, `endblock=99999999` vs `latest`). If confirmed → `FETCH.endblock = "latest"`
(Etherscan's documented form) + a `buildUrl` test; cursor requests keep numeric
`endblock`. If not → leave as is.

## Left to the builder

- Exact file for the pure cursor helpers (export from `scanner.js` unless it
  gets unwieldy).
- `Number` vs `BigInt` for block comparison (be consistent).
- Exact dashed-border styling and legend wording.
- Whether the details History row hides types not selected in the scan form
  (default: show only selected types, since those are what the button loads).
