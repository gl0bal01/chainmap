# INTERFACES.md — frozen module contracts (Stage A output)

**Status: FROZEN for Stage B.** These signatures, data shapes, and events are the
contract each parallel Stage B worker builds against. Do not change a public
signature during Stage B without updating this file first and re-checking every
caller. The JSDoc in each `src/**` file is the authoritative per-symbol spec; this
document is the cross-module map.

Convention: modules marked **DOM-free** must not touch `document`/`window`/`vis`
and must be unit-testable in Node (`bun test`). All addresses are **lowercased**
and are the canonical node id. User/API strings never reach `innerHTML` unescaped.

---

## Module dependency graph

```
config ──────────────┐ (pure data; imported everywhere)
format ──────────────┤ (pure)
                     ▼
rateLimiter ─► scanner ◄─ etherscanClient
                  │
                  ▼
              graphStore  ── emits StoreEvent ──►  render/network ─► vis DataSets
                  ▲                                     │
                  │                                render/labels, render/interaction,
   i18n ◄─ locales/{en,fr}                         render/export
                  │
                  ▼
              ui  ◄───────────────  main (composition root)
```

Stage B leaf workers (independent once frozen): **format**, **rateLimiter**,
**etherscanClient**, **graphStore**, **scanner**, **render/labels**,
**render/network**, **render/interaction**, **render/export**, **ui**, **locales**.
`config` + `i18n` are already implemented in Stage A.

---

## config.js — implemented (pure data)

Exports: `API_BASE`, `CHAINS: Chain[]`, `TX_TYPE_GROUPS`, `ROOT_COLOR`,
`RESOLUTION_PRESETS`, `EXPORT_PIXELS {warn,cap}`, `DEFAULTS`, `LIMITS`, `FETCH`,
`STORAGE_KEYS`, `DATA_PATHS`.

- `Chain = { id:number, name:string, explorer:string }`
- `TxTypeInfo = { action:string, group:'normal'|'internal'|'token', kind?:string, labelKey:string, color:string }`
- `TX_TYPE_GROUPS` keys `normal`/`internal`/`token`; `token` fans out to 3 actions.

## format.js — DOM-free, pure (stub → Stage B)

- `lc(addr): string`
- `isValidAddress(addr): boolean`
- `formatUnits(rawValue, decimals): { text:string, indeterminate:boolean }`
  — BigInt only; **honest**: bad input → `{ text:<raw integer>, indeterminate:true }`, never silent `"0"`.
- `trimZero(s): string`
- `shortAddress(addr): string` — `0x123…abcd`
- `escapeHtml(s): string`
- `csvEscape(v): string`
- `edgeDedupKey(action, tx): string` — `action|hash|from|to|contractAddress|tokenID|logIndex`; symbol is NOT a discriminator.
- `isFailedTx(tx): boolean` — `isError==="1"` or `txreceipt_status==="0"`.
- `formatTimestamp(unixSeconds, locale?): string`

## rateLimiter.js — DOM-free (stub → Stage B)

- `class RateLimiter { constructor(rps); setRps(rps); run(fn):Promise<T>; clear(reason?); get size }`
- `class RateLimiterCancelled extends Error`
- Contract: one instance per scan (recreated from current RPS); serialized queue at
  `1000/rps` ms; `clear()` rejects all queued tasks (real Stop).

## etherscanClient.js — DOM-free (stub → Stage B)

- `class EtherscanError extends Error { kind:'network'|'timeout'|'aborted'|'rate_limit'|'invalid_key'|'api'; meta }`
- `buildUrl(p): string` — pure URL builder (unit-tested directly).
- `createEtherscanClient(options): EtherscanClient`
  - `EtherscanClientOptions = { apiKey, chainId, apiBase?, timeoutMs?, maxRetries?, backoffBaseMs?, fetchImpl? }`
  - `EtherscanClient = { fetchAction(address, action, opts):Promise<RawTx[]>, setApiKey(k), setChainId(id) }`
  - `FetchActionOptions = { offset, page?, sort?, startblock?, endblock?, signal?, onRetry? }`
  - `RawTx = Record<string,string|undefined>` (loose Etherscan record)
  - Contract: timeout+AbortController; 429/5xx + Retry-After; broad throttle
    detection; `no transactions found` → `[]`; other status `0` → `EtherscanError`.

## graphStore.js — DOM-free, single source of truth (stub → Stage B)

`class GraphStore` — the ONLY mutation path; keeps sub-structures in sync; emits events.

Data shapes:
- `NodeRecord = { address, depth, isRoot, alias:string|null }`
- `EdgeRecord = { key, action, group, color, from, to, hash, symbol, tokenContract, tokenId, value, tokenDecimal, amountText, amountIndeterminate, hasData, methodId, methodArgs, rawInput, timeStamp, blockNumber }`
- `EdgeInput = { action, group, color, from, to, tx }` (store computes key + amount)

Mutations: `addNode(address, {depth?,isRoot?}) → NodeRecord` (merge = min depth, sticky root);
`addEdge(EdgeInput) → EdgeRecord|null` (null on dup); `setAlias(address, alias|null)`;
`removeNodes(addresses[]) → {removedNodes,removedEdges}`; `reset()`.

Reads: `getNode`, `hasNode`, `getAlias`, `hasEdgeKey`, `listNodes`, `listEdges`, `stats() → {nodes,edges}`.

Integrity: `checkInvariants() → {ok, errors[]}`.

Events (via `subscribe(handler) → unsubscribe`):
`StoreEvent = {type:'node:add'|'node:update', node} | {type:'node:remove', address} | {type:'edge:add', edge} | {type:'edge:remove', key} | {type:'alias:set', address, alias} | {type:'reset'}`.

## scanner.js — DOM-free (stub → Stage B)

- `runScan(RunScanOptions): Promise<ScanSummary>`
  - `RunScanOptions = { client, store, limiter, root, maxDepth, maxTxPerAddress, safetyCap, types:TxTypeInfo[], signal, onProgress?, onLog? }`
  - `ScanProgress = { current, depth, maxDepth, processed, queued, apiCalls, nodes, edges, skipped, failed }`
  - `ScanSummary = { root, processed, apiCalls, nodes, edges, skipped, failed, capped, stopped, sampled:true, perAddressLimit, maxDepth, errors[] }`
  - Contract: enqueue-dedup + safetyCap **at enqueue**; drop failed txs; depth ≥ maxDepth added-not-expanded; real cancel via `signal`; explicit sampling.
- `selectedTypes({normal,internal,token}): TxTypeInfo[]`
- Log entries flow as `{ level:'info'|'error', key, params? }` — localized by `ui.createLogger` via i18n.

## i18n.js — implemented (Stage A)

- `createI18n({ dictionaries, locale?, fallbackLocale? }): I18n`
- `I18n = { t(key, params?), setLocale(locale), getLocale(), locales(), has(key), subscribe(handler)→unsubscribe, applyTo(root?) }`
- Fallback chain: current locale → fallback locale → key itself (never blank).
- `applyTo` translates: `data-i18n` (textContent), `data-i18n-html` (innerHTML; trusted locale copy only), `data-i18n-placeholder`, `data-i18n-title`, `data-i18n-aria-label`.

## locales/en.js, locales/fr.js — implemented (Stage A, frozen key namespace)

Flat `{ "key.path": "text" }` default-exported dicts; placeholders `{name}`.
`en` is the default. **Both files MUST carry identical key sets** (Stage B adds a
parity test). Sections: `app`, `form`, `tx.type`, `btn`, `export`, `hint`,
`legend`, `details`, `log`, `privacy`, `sampling`, `status`, `error`, `alias`.

## render/labels.js — nearly pure (stub → Stage B)

- `depthColor(depth): string` (hsl)
- `nodeLabel(node, {addressFormat}): string`
- `nodeVisual(node): { color, title }`
- `edgeLabel(edge): string`

## render/network.js — vis + store mirror (stub → Stage B)

- `createGraphView(container, store, { i18n, getAddressFormat, getLayout? }): GraphView`
- `GraphView = { network, fit(opts?), getPositions(ids?), refreshLabels(), destroy() }`
- Owns the LIVE on-screen view via `window.vis`. Subscribes to store events → vis DataSets. (render/export.js also uses `window.vis`, but only for a throwaway offscreen export network.)

## render/interaction.js — vis + DOM (stub → Stage B)

- `attachInteractions(view, store, { container, i18n, onNodeSelect, onEdgeSelect, onAliasEdit, onLog }): { detach() }`
- `rotateGraph(network, angleDeg)` — rotate around centroid.
- `selectHighDegree(network, threshold): string[]`

## render/export.js — vis + jsPDF + DOM (stub → Stage B)

- `computeExportSize(preset, nodeCount): { w, h, pixels, capped, warn }` (pure; pixel guard).
- `renderExportCanvas(view, store, { size, background?, addressFormat }): Promise<HTMLCanvasElement>`
- `exportPng(view, store, { preset, addressFormat, onLog }): Promise<void>`
- `exportPdf(view, store, { preset, addressFormat, jsPDF, onLog }): Promise<void>`
- `exportCsv(store, { onLog })`
- `triggerDownload(href, filename)`

## ui.js — DOM view helpers (stub → Stage B)

- `renderNodeDetails(container, node, { i18n, explorer, onRename })`
- `renderEdgeDetails(container, edge, { i18n, explorer, getAlias })`
- `createLogger(container, i18n): { log(entry), clear() }`
- `createStatus(element): { set(text), clear() }`
- `createRequestIndicator(element, i18n): { setActive(active) }`
- Owns the escape-before-innerHTML rule; alias rename wired via programmatic listener (no inline onclick).

## main.js — composition root

Stage A: i18n bootstrap + language toggle + chain list + persistence (implemented).
Stage C: construct store/view, attach interactions, wire Start/Stop/Reset →
`scanner.runScan`, export buttons, details panel, logger, status, request
indicator, sampling banner.

---

## Cross-cutting contracts (frozen)

- **Vendored libs** (`vendor/VENDOR.md`): vis-network 10.1.0 → `window.vis`; jsPDF 4.2.1 → `window.jspdf.jsPDF`. No CDN.
- **CSP** (`index.html`): `script-src 'self'` (no inline script); `connect-src 'self' https://api.etherscan.io`; `object-src 'none'`.
- **Persistence** (`STORAGE_KEYS`): `etherscanApiKey`, `etherscanChainId`, `addressFormat`, `locale` — localStorage only; nothing leaves the browser.
- **DOM ids** the render/ui layer binds (kept identical to the reference so Stage C wiring is mechanical): `apiKey, chainSelect, address, addressFormat, depth, maxTxPerAddress, safetyCap, rps, typeNormal, typeInternal, typeToken, startBtn, stopBtn, resetBtn, deleteNodesBtn, rotateLeftBtn, rotateRightBtn, status, degreeThreshold, selectHighDegreeBtn, fitViewBtn, exportResolution, exportPngBtn, exportPdfBtn, exportCsvBtn, graph, detailsContent, logContent` — plus new: `langToggle, samplingBanner, privacyBody, requestIndicator`.
- **Log/error transport**: modules never format prose; they emit `{ level, key, params? }` and `ui`/`i18n` render it. This is what makes every string localizable.

---

## Stage D additions (Feature Layer 1 — noise reduction, D1.1)

New DOM-free modules:
- **display.js** (pure): `edgeAmountNumber(edge)`, `isSpam(edge,{spamContracts,spamSymbols})`, `passesFilters(edge,opts)`, `filtersActive(opts)`, `edgeWidth(amount,maxAmount)→[1,8]`. Threshold is per-edge nominal magnitude, NOT fiat-normalized (documented caveat).
- **knownAddresses.js**: `loadKnownAddresses(fetchImpl?,path?)→Promise<KnownData>` (empty on any failure, never throws), `knownLabel(address,chainId,data)→string|null`. `KnownData = { "<chainId>": { "<lc address>": {label,category} } }`. Bundled at `data/known-addresses.json`.

Contract extensions (additive, backward-compatible):
- `render/labels.nodeLabel(node,{addressFormat,knownLabel?})` and `nodeVisual(node,{knownLabel?})` — name precedence: user alias > known label > address.
- `GraphView` gains `setDisplayOptions(opts:DisplayOptions)` and `refreshProjection()`. `createGraphView(container,store,deps)` deps gain optional `getKnownLabel(address)→string|null`. The view now renders vis **DataViews** (filtered edges + nodes) over the full mirror; `graphStore` stays the sole source of truth (filters never mutate it).
- Bundled data paths already in `config.DATA_PATHS`; `data/spam-tokens.json` = array of lowercased contracts/symbols hidden when "hide spam" is on.

New i18n keys: `filters.label`, `filters.minAmount.label`, `filters.hideZero`, `filters.hideSpam` (en+fr). New DOM ids: `minAmount`, `hideZeroToggle`, `hideSpamToggle`.

D1.2 (edge bundling) shipped: `display.bundleEdges(edges)→BundledEdge[]`, view `setBundling(on)`/`getEdgeData(id)`, `ui.renderBundleDetails`.

## Stage D additions (Feature Layer 2)

New DOM-free modules:
- **workspace.js**: `WORKSPACE_VERSION=2`, `serializeWorkspace({chainId,root,nodes,edges,filters,layout,annotations})→object`, `parseWorkspace(json|string)→{ok,data}|{ok,error}` (sanitizes untrusted file input; never throws).
- **dryRun.js**: `estimateScan({firstHopNeighbors,maxDepth,typesCount,rps,maxTxPerAddress,safetyCap})→{addresses,apiCalls,seconds}` (rough upper bound, capped by safetyCap).
- **sinkFaucet.js**: `classifyHubs(nodes,edges,{minDegree=6,ratio=4})→Map<addr,'sink'|'faucet'>` (distinct-counterparty degree, self-loops ignored), `hubDim(kind)→number`.

Contract extensions:
- `graphStore.loadSnapshot(nodes, edges)` — replace all state from a snapshot; emits reset→node:add→edge:add; drops edges with missing endpoints (invariants hold).
- `display.passesFilters` gains `minTime`/`maxTime` (UNIX secs; unknown-timestamp edges not excluded); `filtersActive` accounts for them.
- `GraphView` gains `setLayout(mode)`, `refreshHubs()`, `addAnnotation(text)`, `clearAnnotations()`, `getAnnotations()`, `setAnnotations(list)`. `createGraphView` deps gain optional `getHubKind(address)→('sink'|'faucet'|null)`. Annotations are `note:*` overlay nodes (not graph nodes; not in store/CSV).
- `render/export.renderExportCanvas`/`exportPng`/`exportPdf` accept `annotations` (baked into the image).

New i18n keys: filters.dateFrom/dateTo/hubs, form.layout.*, investigate.label, workspace.label, btn.addNote/clearNotes/estimate/save/load/demo, help.apiKey, log.workspaceSaved/workspaceLoaded/workspaceError/demoLoaded/estimate/notesCleared, details.bundleType/count/total, alias.notePrompt (en+fr, 134/134).
Bundled data: `data/demo-workspace.json` (loads with no API key), `data/known-addresses.json`. New `config.DATA_PATHS.demo`.

Stage D COMPLETE (both layers). v2 at feature-parity + beyond; promotion to `index.html` gated on manual browser smoke.

## Investigator upgrade (post-Stage-D)

Smart calldata decode, per-edge risk flags, reversible hide faucets/sinks, peel-chain
detection, mixer/bridge/sanctioned tagging, decoded CSV columns, and Ctrl/Cmd+Arrow node
navigation. Risk flags, peel-chain highlighting, and hide-faucets/hide-sinks are all
**display projections** over the store mirror — same pattern as filters/bundling/hubDim;
the store itself is never mutated by them, so CSV/detail stay complete regardless of what's
hidden or highlighted on screen.

- **selectors.js** gains:
  - `SELECTOR_PARAMS: Record<selector, string[]>` — ordered parameter names (canonical
    argument roles, e.g. `recipient`/`amount`/`spender`) for the selectors whose args are
    worth naming. Not every entry in `SELECTORS` has a `SELECTOR_PARAMS` entry.
  - `paramNames(selector): string[]|null` — ordered parameter names for a known selector
    (case-insensitive), or `null` if absent.

- **abiDecode.js** gains:
  - `summarizeCall(call: {methodId:string, args:{type,value,name?}[]}|null): {key:string, params:object}|null`
    — plain-language i18n summary (`summary.*` keys) of a decoded call. Returns **raw**
    param values (addresses / raw integers) — the render layer resolves aliases, formats
    amounts with token decimals, and escapes. `null` when there's nothing worth summarizing
    (unknown/undecoded selector). `decodeCall` args now optionally carry `name` (from
    `selectors.paramNames`) alongside `type`/`value`.

- **riskFlags.js** — new, pure, DOM-free (no vis, no DOM; Node-testable):
  - `MAX_UINT256: string` — `2^256 - 1` as a decimal string, the canonical "unlimited" ERC-20
    allowance.
  - `resolvedRecipient(edge: EdgeRecord): string` — the real recipient of an edge: the
    decoded `recipient` methodArg (lowercased) when present and a valid address, else the
    tx `to` (lowercased).
  - `flagsForEdge(edge: EdgeRecord, ctx: {category:(addr:string)=>(string|null)}): string[]`
    — de-duplicated i18n flag keys for an edge: `flag.approvalUnlimited` (allowance/approval
    ≥ 2^255, or `setApprovalForAll(_, true)`), `flag.hiddenRecipient` (decoded recipient ≠
    tx `to`), `flag.mixer`/`flag.bridge`/`flag.sanctioned` (resolved recipient's known
    category, via the injected `category` lookup — typically `knownAddresses.knownCategory`
    bound to the active chain), plus `flag.mixer` unconditionally for the Tornado Cash
    deposit selector. Each flag is a **signal, not a verdict**.

- **riskScore.js** — `RiskInput` and `scoreNode` gain `approvalRisk:boolean` (+2,
  `risk.approval`) and `sanctioned:boolean` (+3, `risk.sanctioned`), folded in alongside the
  existing cycle/hub/degree/contract/known signals. Unchanged: score bands
  (`low`<2≤`med`<4≤`high`) and that `reasons` are i18n keys.

- **sinkFaucet.js** gains:
  - `shouldHideNode(hubKind: 'sink'|'faucet'|null|undefined, hide?: {faucet?:boolean, sink?:boolean}): boolean`
    — pure predicate for the "Hide faucets" / "Hide sinks" toggles; the caller (a vis
    DataView node filter) decides what to do with the result. Never touches the store —
    hiding is purely a view-layer projection, so a hidden node's edges/rows still appear in
    CSV and its record is still reachable via `store.getNode`.

- **knownAddresses.js** gains:
  - `knownCategory(address: string, chainId: number|string, data: KnownData): string|null`
    — looks up the known **category** (`mixer`/`bridge`/`sanctioned`/`exchange`/…) for an
    address on a chain, same chain-scoped lookup shape as `knownLabel`. Backs the
    🌀/🌉/⛔ node badges and the mixer/bridge/sanctioned risk flags.

- **render/export.js** gains:
  - `buildCsvRows(store: GraphStore, ctx: {category:(addr:string)=>(string|null), formatTimestamp?:(t:string)=>string}): string[][]`
    — pure row builder (no DOM) factored out of `exportCsv`, directly unit-testable. Returns
    the sampling-caveat line, header, then one row per node/edge. `CSV_HEADER` gained five
    trailing edge-only columns: `method`, `method_sig`, `real_recipient`, `decoded_amount`,
    `risk_flags` (semicolon-joined `flagsForEdge` keys); node rows leave them blank.
    `exportCsv(store, deps)` now builds its rows via `buildCsvRows` and accepts an optional
    `deps.category` lookup (defaults to a no-op returning `null`).

- **render/interaction.js** gains:
  - `nearestInDirection(fromPos: {x:number,y:number}, positions: Record<string,{x:number,y:number}>, dir: 'up'|'down'|'left'|'right'): string|null`
    — pure geometry: nearest node id in a cardinal direction from a point. vis canvas y
    grows downward, so `up` = smaller y. Directional gate requires the primary axis to
    dominate and point the right way; ties broken by a small secondary-axis penalty.
    `attachInteractions` wires Ctrl/Cmd+Arrow to it: seeds `fromPos` from the current
    selection (or the viewport center if nothing is selected), moves selection + focuses the
    result.

- **peelChain.js** — new, pure, DOM-free (no vis, no DOM; Node-testable):
  - `findPeelChains(edges: EdgeRecord[], opts?: {minLen?:number, keepRatio?:number, slack?:number}): string[][]`
    — detects "peel chain" / forwarding patterns: `A→B→C→…` where each intermediate node has
    exactly one distinct sender and one distinct recipient (`isPassThrough`) and forwards
    ~the same amount it just received (`sent/recv` within `[keepRatio, slack]`, default
    `[0.9, 1.1]`), with time never running backward. Returns ordered address paths of at
    least `minLen` nodes (default 3). Amount basis: `edge.amountText` (nominal per-token
    magnitude, same basis as `display.edgeAmountNumber` — NOT fiat-normalized).

`EdgeRecord.tokenDecimal` (raw token decimals persisted on the edge, `""` for
native/unknown) is documented in the `graphStore.js` section above (Stage D fix); the decode
summary and CSV `decoded_amount` column both re-format `methodArgs` amounts with it via
`formatUnits` rather than trusting a default.
