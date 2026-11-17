# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## What this is

**chainmap** — a single-page, **fully client-side** app that visualizes fund flows on
EVM chains for OSINT/blockchain investigation and teaching. It fetches transactions
from the Etherscan v2 unified API and renders a directed address→address graph,
expanded by BFS to a chosen depth. English default + French toggle. No backend, no
build step, no telemetry. The API key + all data stay in the browser.

## Running / developing

Zero build — native ES modules. Open `index.html` or serve statically:

```bash
python3 -m http.server 8000   # open http://localhost:8000/
```

Tests are **dev-only** (bun + happy-dom, NOT required to run the app):

```bash
bun test        # 1009 tests
```

`vis-network` (10.1.5) and `jsPDF` (4.2.1) are **vendored** in `vendor/` (no CDN).

## Architecture (native ES modules, no bundler)

Data flow: **BFS scan → graphStore (single source of truth) → event-driven render → interact / export**.

The core insight: **`graphStore` is the ONE source of truth.** All mutations go through
it; it emits `StoreEvent`s; the render layer *mirrors* the store into vis DataSets by
subscribing. This replaces the reference app's four hand-synced state blobs.

DOM-free, Node-testable modules (pure logic; the heart of the app):
- `config.js` — CHAINS, TX_TYPE_GROUPS, limits, resolution presets, storage keys, data paths.
- `format.js` — formatUnits (BigInt), edgeDedupKey, escapeHtml, csvEscape, isValidAddress, isFailedTx.
- `tron.js` — Tron codec (SHA-256, base58check), TronGrid URL builder, `sampleSize`, `tronRows` row mapping. `tronClient.js` — TronGrid fetch (key header-only, 429 backoff, fingerprint hops paced inside the client).
- `rateLimiter.js` — serialized req/s queue with cancellation.
- `etherscanClient.js` — request building + resilient fetch (timeout/abort, 429/Retry-After, error taxonomy).
- `graphStore.js` — **single source of truth**; NodeRecord/EdgeRecord; invariants; events; `loadSnapshot`.
- `scanner.js` — BFS orchestration (enqueue-dedup + safetyCap at enqueue, failed-tx drop, cancel).
- `display.js` — filters, amount-weighted width, edge bundling, age color (all pure).
- `history.js` — per-node "Load older" block-cursor math (`nextRequest`/`advance`/`historyState`/`sanitizeHistory`).
- `chainTwins.js` — same-address cross-chain pairs + key evidence.
- `depositDetect.js` — `findDeposits` exchange-deposit heuristic, `delayParts`.
- `roundTrips.js` — Tarjan SCC cycle detection. `sinkFaucet.js` — hub classification.
- `selectors.js` + `abiDecode.js` — 4-byte method selectors + ABI head decoder.
- `bridgeInfer.js` — `inferBridges` (inferred bridge-deposit candidates, with confidence and evidence) + `sanitizeBridgeDecisions` (investigator decisions, workspace trust boundary).
- `usdPrice.js` — opt-in USD estimates: `priceKeyFor` (the only gate on what reaches DefiLlama), exact BigInt valuation, `usdForEdge`, price service.
- `riskScore.js` — explainable per-node risk. `blockchainDetect.js` — chain-by-format detection.
- `knownAddresses.js` (`knownEntry`: chain-specific then `"*"`), `fakeToken.js` (imitation-token detection), `workspace.js` (save/load), `dryRun.js` (scan estimate).
- `queryLog.js` (request log, `sanitizeQueryLog`), `zip.js` (store-only zip + CRC-32), `evidence.js` (caveats, manifest, SHA256SUMS, footer lines, zip assembly).
- `i18n.js` + `locales/{en,fr}.js` — flat key dictionaries; `applyTo(root)` translates `[data-i18n*]`.

DOM / vis modules:
- `render/network.js` — the ONLY module owning the live `window.vis` view; mirrors store → DataViews (filters), applies overlays.
- `render/labels.js`, `render/interaction.js` (click/rotate/box-select/prune), `render/export.js` (offscreen PNG/PDF/CSV + pixel guard).
- `ui.js` — details/logger/status/indicator; owns the "no untrusted string reaches innerHTML" rule.
- `main.js` — composition root: wires DOM (`index.html`) to modules.

Frozen module contracts live in `INTERFACES.md`.

## Conventions / gotchas

- Addresses are lowercased everywhere. **Node id = `chainId:address`** (`format.nodeId`); an address alone is not an identity. Every record carries `chainId` (decimal string); look labels/categories/explorers up with the record's own chain. Display (short/full/alias/known-label/chain tag) never changes ids.
- **Amounts are base-unit integer strings**; use `formatUnits` (BigInt + tokenDecimal), NEVER `Number`. On bad decimals it returns `indeterminate`, never a silent "0".
- **Edges dedup on a precise key**: `chainId|action|hash|from|to|contract|tokenID|logIndex` (symbol is display-only) so ERC-1155 / same-symbol-different-contract stay distinct.
- **Drop failed txs** (`isError==="1"` / `txreceipt_status==="0"`) before drawing edges.
- **Filters/overlays are a display projection** over the store mirror (vis DataViews) — the store keeps the full graph so CSV/detail stay complete.
- **Sampling is explicit**: scans fetch the latest N per address (page 1, sort desc, offset N), extendable per node via **Load older** (block cursor on `NodeRecord.history`) — not full history, surfaced in UI + exports. A graph can hold several chains: a scan on another chain adds a root on that chain, and Load older uses the node's own chain. Never present sampled data as complete.
- **i18n**: no hardcoded UI text in logic. Modules emit `{level, key, params}`; `ui`+`i18n` render it. en/fr key sets must stay at parity (a test enforces it).
- **Security**: strict CSP (script-src 'self', connect-src limited to api.etherscan.io, coins.llama.fi and api.trongrid.io); user/API strings reach the DOM via `textContent`/escaped only; no inline `onclick`.
- Adding a chain / tx-type / selector = one entry in the relevant table
  (`config.js` / `selectors.js`); a known-address = one row in `data/sources/curated.json`, then rebuild (below). A new selector gets an entry in
  `SELECTORS` (signature) and, if its leading static args are worth naming, a matching
  entry in `SELECTOR_PARAMS` (param names, in `selectors.js`) — `abiDecode.summarizeCall`
  and the CSV `decoded_amount`/`real_recipient` columns depend on those names being present. A bridge selector names the other-side recipient `destRecipient` (and the destination chain `destChainId`), **never `recipient`**: `recipient` drives `flag.hiddenRecipient`, `resolvedRecipient`/`flag.bridge` and the CSV `real_recipient`, which must keep describing the same-chain call.
- **Evidence**: the query log stores request params without the key + SHA-256 of raw bodies; every export carries provenance; the bundle hashes exactly the bytes written; the API key is in no artifact.
- **Risk flags** (`riskFlags.js`), **peel-chain** detection (`peelChain.js`), the
  **exchange-deposit mark** (`depositDetect.findDeposits`), and **hide
  faucets/sinks** (`sinkFaucet.shouldHideNode`) are display projections over the store
  mirror, same as filters/bundling — they never mutate `graphStore`, so CSV/detail always
  reflect the full graph regardless of what's hidden or highlighted on screen.
- **Inferred bridge links** (`bridgeInfer.inferBridges`) are the same kind of display projection: they never mutate `graphStore`, are never drawn or exported as fact (dashed overlay, "inferred — verify", `low`/`medium`/`high` from observed factors, only from loaded/sampled data), and the investigator's confirm/reject is an assertion kept in the workspace `bridgeDecisions` that never feeds the inference or changes a computed level.
- **`data/known-addresses.json` is generated — never hand-edit it.** Edit
  `data/sources/curated.json`, then run `bun run data:build --verify-sources` (dev-only
  pipeline in `scripts/known-addresses/`; see `data/README.md`). Sanctions come only from the
  OFAC import (curated rows use `ofacDesignated`); that import also takes every checksum-valid
  Tron `T…` id (format decides, not the tag) into bucket `"728126428"` keyed by `41…` hex.
  Curated Tron rows are `token` only (`T…` as cited, written as `41…` hex), and a curated row
  on an address the bucket already holds as OFAC is rejected. `"*"` = all EVM chains; every
  lookup goes through `knownEntry`. `token` rows are the per-chain canonical set that drives imitation-token
  detection — curate all legit same-symbol variants or none.
- **USD is opt-in and derived**: the `#usdToggle` box is off at every load and never persisted; `priceKeyFor` alone decides what reaches `coins.llama.fi` (coin ids + hour-rounded times only; never imitation/spam/NFT/zero/root-contract); `usdForEdge` is the one valuation for details/CSV/manifest; box off = zero price requests; fail closed if the known-address or spam data did not load. It is a display projection like filters: it never mutates `graphStore`, and unknown/pending is blank, never `0`.
- **Tron is opt-in (TronGrid)**: id `728126428:41…` — canonical lowercase `41`+40 hex; `T…` base58check is display-only (`displayAddress`/`shortAddress`/`explorerUrl`), never lowercased, never an id, never read from a workspace. Tron is in `chainInfo` (config) but **not** in `CHAINS`, so Look/Load-on-chain/probe/twins/bridges/USD/`"*"` known rows never see it (chain-specific Tron rows apply: OFAC sanctions, official USDT TRC-20 for imitation detection; no exchange/bridge/mixer labels): use `chainInfo` for a record's own chain, `CHAINS` for EVM-only lists. Every sample size goes through `sampleSize(chainId, n)` (TronGrid caps at 200; the client rejects more). The Load-older cursor is block time in ms (`cursor`, `HistoryEntry.oldestBlock` = ms). Tron is never persisted as the selected chain (`STORAGE_KEYS.chainId`); nothing contacts TronGrid before an explicit Tron choice. The TronGrid key lives only in the `TRON-PRO-API-KEY` header: never in a URL, log, workspace, export or error message.
