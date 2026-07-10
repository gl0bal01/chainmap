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
bun test        # ~227 tests
```

`vis-network` (10.1.0) and `jsPDF` (4.2.1) are **vendored** in `vendor/` (no CDN).

## Architecture (native ES modules, no bundler)

Data flow: **BFS scan → graphStore (single source of truth) → event-driven render → interact / export**.

The core insight: **`graphStore` is the ONE source of truth.** All mutations go through
it; it emits `StoreEvent`s; the render layer *mirrors* the store into vis DataSets by
subscribing. This replaces the reference app's four hand-synced state blobs.

DOM-free, Node-testable modules (pure logic; the heart of the app):
- `config.js` — CHAINS, TX_TYPE_GROUPS, limits, resolution presets, storage keys, data paths.
- `format.js` — formatUnits (BigInt), edgeDedupKey, escapeHtml, csvEscape, isValidAddress, isFailedTx.
- `rateLimiter.js` — serialized req/s queue with cancellation.
- `etherscanClient.js` — request building + resilient fetch (timeout/abort, 429/Retry-After, error taxonomy).
- `graphStore.js` — **single source of truth**; NodeRecord/EdgeRecord; invariants; events; `loadSnapshot`.
- `scanner.js` — BFS orchestration (enqueue-dedup + safetyCap at enqueue, failed-tx drop, cancel).
- `display.js` — filters, amount-weighted width, edge bundling, age color (all pure).
- `roundTrips.js` — Tarjan SCC cycle detection. `sinkFaucet.js` — hub classification.
- `selectors.js` + `abiDecode.js` — 4-byte method selectors + ABI head decoder.
- `riskScore.js` — explainable per-node risk. `blockchainDetect.js` — chain-by-format detection.
- `knownAddresses.js`, `workspace.js` (save/load), `dryRun.js` (scan estimate).
- `i18n.js` + `locales/{en,fr}.js` — flat key dictionaries; `applyTo(root)` translates `[data-i18n*]`.

DOM / vis modules:
- `render/network.js` — the ONLY module owning the live `window.vis` view; mirrors store → DataViews (filters), applies overlays.
- `render/labels.js`, `render/interaction.js` (click/rotate/box-select/prune), `render/export.js` (offscreen PNG/PDF/CSV + pixel guard).
- `ui.js` — details/logger/status/indicator; owns the "no untrusted string reaches innerHTML" rule.
- `main.js` — composition root: wires DOM (`index.html`) to modules.

Frozen module contracts live in `INTERFACES.md`.

## Conventions / gotchas

- **Addresses are lowercased everywhere** and are the canonical node id. Display (short/full/alias/known-label) never changes ids.
- **Amounts are base-unit integer strings**; use `formatUnits` (BigInt + tokenDecimal), NEVER `Number`. On bad decimals it returns `indeterminate`, never a silent "0".
- **Edges dedup on a precise key**: `action|hash|from|to|contract|tokenID|logIndex` (symbol is display-only) so ERC-1155 / same-symbol-different-contract stay distinct.
- **Drop failed txs** (`isError==="1"` / `txreceipt_status==="0"`) before drawing edges.
- **Filters/overlays are a display projection** over the store mirror (vis DataViews) — the store keeps the full graph so CSV/detail stay complete.
- **Sampling is explicit**: scans fetch "latest N" (page 1, sort desc, offset N), not full history — surfaced in UI + exports. Never present sampled data as complete.
- **i18n**: no hardcoded UI text in logic. Modules emit `{level, key, params}`; `ui`+`i18n` render it. en/fr key sets must stay at parity (a test enforces it).
- **Security**: strict CSP (script-src 'self', connect-src limited to api.etherscan.io); user/API strings reach the DOM via `textContent`/escaped only; no inline `onclick`.
- Adding a chain / tx-type / selector / known-address = one entry in the relevant table (`config.js` / `selectors.js` / `data/*.json`).

