# ChainMap investigator upgrade — design

**Date:** 2026-07-12
**Status:** approved (design), pending implementation plan
**Scope:** one implementation plan (8 features, mostly additive over existing pure modules)

## Goal

Make chainmap materially more useful for a blockchain OSINT investigator following
fund flows: turn raw calldata into human-readable intent, surface high-signal risk
directly on the graph, and give one-click noise control — without breaking any of the
app's existing invariants.

## Invariants preserved (non-negotiable)

- Pure, DOM-free logic modules with Node (bun) tests; DOM/vis only in `render/*`, `ui.js`, `main.js`.
- `graphStore` is the ONE source of truth; view mirrors it; filters/overlays are a display projection (store keeps the full graph so CSV/detail stay complete).
- No untrusted string reaches `innerHTML` — user/API/decoded strings go via `textContent`/escaped.
- Strict CSP unchanged (script-src 'self', connect-src api.etherscan.io + same-origin data).
- Addresses lowercased, canonical node id; display labels never change ids.
- Amounts are base-unit integer strings via `formatUnits` (BigInt); on bad decimals → `indeterminate`, never a silent "0".
- i18n: no hardcoded UI text in logic. Logic emits `{level?, key, params}`; `ui`+`i18n` render it. en/fr key sets stay at parity (enforced by `test/locales.test.js`).

## Features

### 1. Smart calldata decode

**Modules:** `selectors.js` (+ param-name table), `abiDecode.js` (attach names), `ui.js` (resolve values + summary render), `format.js` (reuse `formatUnits`).

- Add `SELECTOR_PARAMS` in `selectors.js`: selector → ordered param names, e.g.
  `"0xa9059cbb": ["recipient","amount"]`. Only for selectors we already know.
- `decodeCall` attaches `name` to each decoded arg when available (`{type, value, name?}`).
  Backward compatible — existing `{type,value}` consumers unaffected.
- **Value resolution happens in the render layer** (ui has alias/known-label/decimals; decoder stays pure):
  - address arg → `getAlias(a) || knownLabel(a) || short(a)`, shown with full addr.
  - uint "amount"-role arg → `formatUnits` **best-effort**: format only when token decimals are resolvable (transfer/approve target = tx `to` when it is a known token; else edge symbol/decimals). When not resolvable, show the raw integer + `(raw)`. Never fabricate a decimal or "0".
  - bool arg → `true`/`false` (localized yes/no).
- **Summary line:** pure helper `callSummary(edge)` in `abiDecode.js` returns `{key, params}` or `null` (e.g. `{key:"summary.transfer", params:{amount, token, recipient}}`); ui renders it as one line: `► Transfer 100 USDC → Binance 14`. Params are raw values; ui resolves/escapes. Unknown/dynamic → no summary (fall back to existing rows).

**Tests:** `abiDecode.test.js` — names attached; summary key/params for transfer/approve/setApprovalForAll; unknown selector → no names, no summary. `selectors.test.js` — every `SELECTOR_PARAMS` key exists in `SELECTORS` and arity matches the signature's static-arg count.

### 2. Risk flags + graph highlight

**Modules:** `riskFlags.js` (NEW pure), `riskScore.js` (fold flags), `render/network.js` (edge/node styling + badge), `ui.js` (explain in details).

- `flagsForEdge(edge, ctx)` → `string[]` of flag keys (ctx supplies `knownCategory(addr)` and `MAX_UINT` handling):
  - `flag.approvalUnlimited` — `approve`/`increaseAllowance` amount ≥ threshold (treat MAX_UINT / very large as unlimited) OR `setApprovalForAll(_, true)`, AND spender not a known "safe" category (exchange/router still flagged but lower — keep it explainable, list the spender).
  - `flag.mixer` / `flag.bridge` / `flag.sanctioned` — resolved recipient (decoded recipient if present, else `edge.to`) has that known category, or Tornado `deposit(bytes32)` selector `0xb214faa5`.
  - `flag.hiddenRecipient` — decoded recipient (a transfer/transferFrom arg) differs from `edge.to` (tx target is the token contract, real recipient hidden in calldata).
- `riskScore.js` gains inputs `approvalRisk`, `sanctioned` (or accept a `flags` array) → `approvalUnlimited`/`sanctioned` add score with new `risk.*` reason keys. Explainable, no black box.
- **Network styling:** edge with any flag → escalated style (strong color e.g. amber/red, wider, dashed) + short warning label; a node that emits any flagged edge → ⚠ marker layered on its existing visual. Non-flagged edges unchanged.
- **Details panel:** list active flags with localized one-line explanations.

**Tests:** `riskFlags.test.js` — each flag fires on a crafted edge and does NOT on a clean one; hidden-recipient needs decoded arg ≠ to; unlimited approval boundary. `riskScore.test.js` — new reasons/score deltas.

### 3. Reversible hide faucets / sinks

**Modules:** `render/network.js` (node DataView predicate + `setHubHidden`), `main.js` (two toggles), `index.html` + locales (controls).

- Two toggles: **Hide faucets**, **Hide sinks**. State lives in the view; a node DataView predicate excludes nodes whose `hubKind` is currently hidden. Edges to/from hidden nodes drop via the endpoint (verify vis drops dangling edges; if not, extend edge predicate).
- Display projection ONLY — store untouched, so CSV/detail/risk stay computed over the full graph; toggling off restores instantly.
- Engaging a toggle auto-runs `classifyHubs` (independent of the existing dim-only hub toggle).

**Tests:** network is DOM/vis (covered by smoke); add a small pure helper `shouldHideNode(hubKind, {faucet,sink})` in `sinkFaucet.js` with unit tests so the predicate logic itself is Node-tested.

### 4. Peeling-chain detection

**Modules:** `peelChain.js` (NEW pure), `render/network.js` (overlay), `main.js` (toggle), `ui.js` (list).

- `findPeelChains(edges, opts)` → array of chains (ordered address lists) where each hop
  forwards ~the same amount onward (ratio ≥ `keepRatio`, default 0.9, ≤ 1.0 + small slack),
  intermediate nodes are ~1-in/1-out, hop time is forward-in-time, min length `minLen` (default 3).
  Amount comparison uses the same magnitude basis as `display.edgeAmountNumber` (documented as nominal per-token, not fiat-normalized).
- Overlay highlights chain edges+nodes in a distinct color; ui lists detected chains. Toggle on/off. Store untouched.

**Tests:** `peelChain.test.js` — detects a clean 3-hop peel; rejects when amount drops below ratio, when a mid-node fans out, and when time goes backward; tolerance boundary.

### 5. Mixer / bridge tagging

**Modules:** `data/known-addresses.json` (add entries), `render/network.js` (category badge), `riskScore.js`/`riskFlags.js` (already consume category).

- Surface existing `category` as a node badge/icon: 🌀 mixer, 🌉 bridge, ⛔ sanctioned (others optional). Icon is decorative + reflected in title/details (localized).
- Expand dataset with a handful more well-known Tornado router/pool + major bridge addresses (chain 1 at least). Data-only; keep entries curated and labeled (no guessing).

**Tests:** data is static; badge is view. Add/confirm a `knownAddresses` lookup test if not present. No fabricated labels.

### 6. Decoded args in CSV

**Module:** `render/export.js`.

- Extend `CSV_HEADER` + edge rows with: `method` (name or ""), `method_sig`, `real_recipient` (decoded recipient when present, else ""), `decoded_amount` (best-effort formatted, else raw, else ""), `risk_flags` (`;`-joined flag keys). Node rows leave them blank. Keep the sampling-caveat first line and `csvEscape`.

**Tests:** `export.js` CSV assembly is partly DOM (download) — extract the row-building into a pure `buildCsvRows(store, ctx)` and unit-test header + decoded columns; keep the download wrapper thin.

### 7. Ctrl+Arrow node navigation

**Module:** `render/interaction.js` (+ `main.js` wiring already present via `onNodeSelect`).

- On `keydown` with Ctrl(or Meta)+Arrow and a current selection: pick the nearest node in the arrow's direction (angular gate + distance) from the selected node's position, `setSelection` + center it + fire `onNodeSelect` (opens details). Ignore when focus is in an input/textarea/select. Geometry only — no store change.
- No selection yet → select the node nearest viewport center as a seed.

**Tests:** extract direction pick into a pure helper `nearestInDirection(fromPos, positions, dir)` and unit-test (picks correct neighbor, ignores wrong-direction/behind nodes, empty → null).

### 8. Retitle

**Modules:** `index.html`, `src/locales/en.js`, `src/locales/fr.js`.

- `app.title` → **"ChainMap — Follow the money"** (en). fr: **"ChainMap — Suivez l'argent"**.
- Update `<title>` tag and the `<h1 data-i18n="app.title">` fallback text in `index.html` to match (fallback text is replaced by i18n on load, but keep it consistent).

## Build order

8 (trivial warmup) → 1 → 2 & 5 (share the flag/category path) → 3 → 6 → 4 → 7.

## Cross-cutting

- Every new/changed logic module: bun tests added; `bun test` stays green (~227 → more).
- Every new user-facing string: added to BOTH `en.js` and `fr.js` (parity test enforces).
- New controls in `index.html` with `data-i18n` + `aria-label`; wired in `main.js`.
- No new network origins → CSP unchanged. No new deps → `vendor/` unchanged.
- Update `CLAUDE.md` "one entry in the relevant table" note if new tables (`SELECTOR_PARAMS`) are added; update `INTERFACES.md` for new pure module contracts (`riskFlags`, `peelChain`, `callSummary`).

## Out of scope (YAGNI)

- Full recursive ABI / dynamic-type decoding (arrays, bytes, multicall recursion) — static-arg + summary only.
- 4byte.directory or any third-party network lookup — curated selectors only.
- Fiat normalization of amounts — magnitude stays nominal per-token.
- Address clustering / common-input heuristics — not in this pass.
