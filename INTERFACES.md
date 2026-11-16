# INTERFACES.md — frozen module contracts (Stage A output)

**Status: FROZEN for Stage B.** These signatures, data shapes, and events are the
contract each parallel Stage B worker builds against. Do not change a public
signature during Stage B without updating this file first and re-checking every
caller. The JSDoc in each `src/**` file is the authoritative per-symbol spec; this
document is the cross-module map.

Convention: modules marked **DOM-free** must not touch `document`/`window`/`vis`
and must be unit-testable in Node (`bun test`). All addresses are **lowercased**;
node id = `chainId:address`; an address alone is not an identity. Chain ids are
decimal strings (`"1"`, `"42161"`) in every record. User/API strings never reach
`innerHTML` unescaped.

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
- `parseChainId(v): string|null` — a safe non-negative integer number, or a `/^\d+$/` string whose value is a safe integer → `String(Number(v))` (`"007"` → `"7"`); everything else → `null`.
- `nodeId(chainId, address): string` — `` `${chainId}:${lc(address)}` ``. Never parsed back: records carry `chainId` + `address`.
- `edgeKey(chainId, action, tx): string` — `` `${chainId}|${edgeDedupKey(action, tx)}` `` (a hash replayed on two chains is two edges).
- `isFailedTx(tx): boolean` — `isError==="1"` or `txreceipt_status==="0"`.
- `formatTimestamp(unixSeconds, locale?): string`

## rateLimiter.js — DOM-free (stub → Stage B)

- `class RateLimiter { constructor(rps); setRps(rps); run(fn):Promise<T>; clear(reason?); get size }`
- `class RateLimiterCancelled extends Error`
- Contract: one instance per scan (recreated from current RPS); serialized queue at
  `1000/rps` ms; `clear()` rejects all queued tasks (real Stop).

## etherscanClient.js — DOM-free (stub → Stage B)

- `class EtherscanError extends Error { kind:'network'|'timeout'|'aborted'|'rate_limit'|'invalid_key'|'plan_required'|'api'; meta }`
- `buildUrl(p): string` — pure URL builder (unit-tested directly).
- `createEtherscanClient(options): EtherscanClient`
  - `EtherscanClientOptions = { apiKey, chainId, apiBase?, timeoutMs?, maxRetries?, backoffBaseMs?, fetchImpl? }`
  - `EtherscanClient = { fetchAction(address, action, opts):Promise<RawTx[]>, setApiKey(k), setChainId(id) }`
  - `FetchActionOptions = { offset, page?, sort?, startblock?, endblock?, signal?, onRetry? }`
  - `RawTx = Record<string,string|undefined>` (loose Etherscan record)
  - Contract: timeout+AbortController; 429/5xx + Retry-After; broad throttle
    detection; `no transactions found` → `[]`; paid-only chain ("not supported for this chain") →
    non-retried `plan_required`; other status `0` → `EtherscanError`.
  - **P5:** `buildParams(p) → Record<string,string>` — the nine `PARAM_KEYS` (`chainid, module, action, address, startblock, endblock, page, offset, sort`) **without** the API key. `EtherscanClientOptions.onQuery?(rec)` is called once per fetch attempt with `{ at, chainId, action, params, httpStatus:number|null, rows:number|null, outcome:'ok'|'retry'|'error'|'network', body?:ArrayBuffer }`; a throwing or rejecting hook never breaks the fetch. `body` is the raw response bytes (hashed by the log, never stored).

## graphStore.js — DOM-free, single source of truth (stub → Stage B)

`class GraphStore` — the ONLY mutation path; keeps sub-structures in sync; emits events.

Data shapes (identity is chain-scoped — the same address on two chains is two independent nodes):
- `NodeRecord = { id, chainId, address, depth, isRoot, alias:string|null, history?:Record<action,HistoryEntry> }` — `id = format.nodeId(chainId, address)`; `history` is the per-action "Load older" cursor (see history.js); absent until a node has been fetched.
- `EdgeRecord = { key, chainId, action, group, color, from, to, fromId, toId, hash, symbol, tokenContract, tokenId, value, tokenDecimal, amountText, amountIndeterminate, hasData, methodId, methodArgs, rawInput, timeStamp, blockNumber }` — `from`/`to` stay lowercased **addresses**; `fromId`/`toId` = `nodeId(chainId, from|to)` are derived by the store; `key = format.edgeKey(chainId, action, tx)`.
- `EdgeInput = { chainId, action, group, color, from, to, tx }` (store computes key + amount + ids). The native ticker of a non-token edge is `CHAINS[…].native` of `input.chainId`, `""` for a chain not in `CHAINS`.

Mutations: `addNode(chainId, address, {depth?,isRoot?}) → NodeRecord` (merge = min depth, sticky root);
`addEdge(EdgeInput) → EdgeRecord|null` (null on dup); both throw `TypeError` when `parseChainId(chainId)` is null (never defaulted).
`setAlias(id, alias|null)`; `setHistory(id, action, entry:HistoryEntry)` (replaces that action's cursor; emits `node:update`; no-op if node absent);
`removeNodes(ids[]) → {removedNodes,removedEdges}`; `reset()`; `loadSnapshot(nodes, edges)` (see Stage D below). `setNativeSymbol` is removed.

Reads (ids looked up exactly as given, no lowercasing): `getNode(id)`, `hasNode(id)`, `getAlias(id)`, `hasEdgeKey`, `listNodes`, `listEdges`, `stats() → {nodes,edges}`, `chains() → string[]` (distinct chain ids, numeric ascending; backed by a per-chain node count kept by add/remove/reset/loadSnapshot).

Integrity: `checkInvariants() → {ok, errors[]}` — edgeKeys↔edges parity; `node.id === nodeId(node.chainId, node.address)`; `edge.fromId === nodeId(edge.chainId, edge.from)` and that node exists (same for `toId`), so an edge never joins two chains; `edge.key` starts with `edge.chainId + "|"`; every `chainId` matches `/^\d+$/`; chain counts equal the counts recomputed from nodes.

Events (via `subscribe(handler) → unsubscribe`):
`StoreEvent = {type:'node:add'|'node:update', node} | {type:'node:remove', id} | {type:'edge:add', edge} | {type:'edge:remove', key} | {type:'alias:set', id, alias} | {type:'reset'}`.

## scanner.js — DOM-free (stub → Stage B)

- `runScan(RunScanOptions): Promise<ScanSummary>`
  - `RunScanOptions = { client, store, limiter, chainId, root, maxDepth, maxTxPerAddress, safetyCap, types:TxTypeInfo[], signal, onProgress?, onLog? }` — `chainId` (required, decimal; invalid → rejects before any fetch) is the chain the client fetches from; every ingested node/edge is tagged with it. BFS sets stay keyed by address (a run never leaves its chain).
  - `ScanProgress = { current, depth, maxDepth, processed, queued, apiCalls, nodes, edges, skipped, failed }`
  - `ScanSummary = { root, processed, apiCalls, nodes, edges, skipped, failed, capped, stopped, sampled:true, perAddressLimit, maxDepth, errors[] }`
  - Contract: enqueue-dedup + safetyCap **at enqueue**; drop failed txs; depth ≥ maxDepth added-not-expanded; real cancel via `signal`; explicit sampling.
- `selectedTypes({normal,internal,token}): TxTypeInfo[]`
- `loadOlder(LoadOlderOptions): Promise<LoadOlderResult>` — one older page per selected type for one node, by block cursor.
  - `LoadOlderOptions = { client, store, limiter, chainId, address, types:TxTypeInfo[], maxTxPerAddress, signal?, onLog? }` — operates on node `nodeId(chainId, lc(address))`; the caller builds `client` for that node's chain.
  - `LoadOlderResult = { apiCalls, newEdges, newNodes, failed, skipped, errors, planRequired, stopped, allDone }`; `errors` = per-type fetch errors (aborts excluded); `allDone` = every selected type's cursor is done.
  - Contract: same ingest path as `runScan` (failed-tx drop, endpoint validation); new counterparties land at depth+1 and are **not** expanded; a fetch error leaves that type's cursor untouched (never marked done); `runScan` records the first-load cursor (replace, not merge) per expanded node.
- Log entries flow as `{ level:'info'|'error', key, params? }` — localized by `ui.createLogger` via i18n.

## history.js — DOM-free, pure (per-node "Load older")

Block-cursor math. One `HistoryEntry` per Etherscan action; the cursor is the oldest block seen, re-read inclusively on the next page (edge dedup drops repeats); a block holding >= N rows is paged in place (`startblock = endblock = cursor`).

- `HistoryEntry = { oldestBlock:string, blockPage:number, pageSize:number, done:boolean, count:number }`
- `HistoryRequest = { page, offset, startblock?, endblock? }`
- `nextRequest(entry|undefined, n) → HistoryRequest|null` (null when `done`)
- `advance(entry|undefined, rows, n, req) → HistoryEntry`
- `hasMoreHistory(node) → boolean` (any action with `done === false`)
- `historyState(node, actions[]) → Array<{action, state:'unloaded'|'more'|'complete', count}>`
- `sanitizeHistory(raw) → Record<action,HistoryEntry>|undefined` — validates untrusted (workspace) input; drops unknown actions, `__proto__`-style keys and malformed entries. `graphStore.loadSnapshot` applies it.

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
- `nodeLabel(node, {addressFormat, knownLabel?, chainTag?}): string` (a truthy `chainTag` is appended as a last `\n` line; `nodeVisual` title gets ` · {chainTag}`)
- `nodeVisual(node): { color, title }`
- `edgeLabel(edge): string`

## render/network.js — vis + store mirror (stub → Stage B)

- `createGraphView(container, store, { i18n, getAddressFormat, getLayout? }): GraphView`
- `GraphView = { network, fit(opts?), getPositions(ids?), refreshLabels(), destroy() }`
- Owns the LIVE on-screen view via `window.vis`. Subscribes to store events → vis DataSets. (render/export.js also uses `window.vis`, but only for a throwaway offscreen export network.)

## render/interaction.js — vis + DOM (stub → Stage B)

- `attachInteractions(view, store, { container, i18n, onNodeSelect, onEdgeSelect, onAliasEdit, onDelete, onLog }): { detach() }` — Delete/Backspace calls `onDelete()` (the caller owns the prune: busy guard, selection check, store call).
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

- `explorer: string|null` in all three renderers — the record's chain host (`main.explorerFor(chainId)`, from `config.CHAINS` only); `null` (unknown chain) omits the Link row. There is no fallback host.
- `renderNodeDetails(container, node, { i18n, explorer, onRename, risk?, getKnownSource?, history?, pageSize?, onLoadOlder?, busy?, loadBlocked? })` — `history` (`historyState` items + `labelKey`) adds the History row and a Load button that calls `onLoadOlder()`; the button is disabled while `busy`, when `loadBlocked` (`{key, params?}`, shown as a note) is set, or when every selected type is complete. main.js sets `loadBlocked` only for a node whose chain is not in `config.CHAINS` (`error.unknownChain`); the chain selector never blocks a load (each node loads on its own chain).
- `renderNodeDetails` dep `otherChains?: { twins:[{id,chainName,basis:'key'|'address'}], canApplyAlias, onFocusTwin(id), onApplyAlias() }` appends an "Other chains" row after the Load button: one button per twin (click focuses it); `canApplyAlias` adds an apply-alias button (disabled while `busy`). main.js lists twins from `sameAddressLinks`; apply copies the alias to same-key twins with no alias and never overwrites. Address-only twins are listed, never drawn, and worded as likely unrelated.
- `otherChains` also takes `probe: null|[{chainId,name,state:'active'|'inactive'|'plan'|'error'}]`, `loadable: [{chainId,name}]`, `onCheckOtherChains()`, `onLoadOnChain(chainId)`: a "Check other chains" button, one `${name} — ${state text}` line per probe result (an `active` one whose chain is `loadable` gets a "Load on {chain}" button), and a `<select>` of `loadable` chains with a "Load on {chain}" button that follows the selection. Every action button is disabled while `busy`. main.js: `loadable` = every `CHAINS` entry not already holding the address, `PROBE_CHAIN_IDS` order first (mainnets before the rest); `checkOtherChains(id)` probes `PROBE_CHAIN_IDS` minus those chains via `withBusy` (Stop cancels and discards the partial result) and keeps the states in a session `probeCache` keyed by address, cleared on every store `reset` (incl. workspace/demo load); `loadOnChain(id, chainId)` refuses via `loadRefusal`/busy before creating anything, adds the node with the source's `depth`/`isRoot` (no alias), runs `loadOlderFor` on it (same status/log strings), then logs `log.chainAdded` — or removes the node again and logs `log.loadOnChainEmpty` when nothing was fetched (no `history`; info level when stopped, error otherwise).
- `renderEdgeDetails(container, edge, { i18n, explorer, getAlias, getKnownLabel?, getCategory?, isFakeToken? })` — the optional deps are absent-safe; `getCategory` and `isFakeToken` feed `flagsForEdge` for the risk-flags row.
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

- **Vendored libs** (`vendor/VENDOR.md`): vis-network 10.1.5 → `window.vis`; jsPDF 4.2.1 → `window.jspdf.jsPDF`. No CDN.
- **CSP** (`index.html`): `script-src 'self'` (no inline script); `connect-src 'self' https://api.etherscan.io`; `object-src 'none'`.
- **Persistence** (`STORAGE_KEYS`): `etherscanApiKey`, `etherscanChainId`, `addressFormat`, `locale` — localStorage only; nothing leaves the browser.
- **DOM ids** the render/ui layer binds (kept identical to the reference so Stage C wiring is mechanical): `apiKey, chainSelect, address, addressFormat, depth, maxTxPerAddress, safetyCap, rps, typeNormal, typeInternal, typeToken, startBtn, stopBtn, resetBtn, deleteNodesBtn, rotateLeftBtn, rotateRightBtn, status, degreeThreshold, selectHighDegreeBtn, fitViewBtn, exportResolution, exportPngBtn, exportPdfBtn, exportCsvBtn, graph, detailsContent, logContent` — plus new: `langToggle, samplingBanner, privacyBody, requestIndicator`.
- **Log/error transport**: modules never format prose; they emit `{ level, key, params? }` and `ui`/`i18n` render it. This is what makes every string localizable.

---

## Stage D additions (Feature Layer 1 — noise reduction, D1.1)

New DOM-free modules:
- **display.js** (pure): `edgeAmountNumber(edge)`, `isSpam(edge,{spamContractsFor?:(chainId)=>Set<string>,spamSymbols?})` (contracts looked up on `edge.chainId`), `passesFilters(edge,opts)`, `filtersActive(opts)`, `edgeWidth(amount,maxAmount)→[1,8]`. Threshold is per-edge nominal magnitude, NOT fiat-normalized (documented caveat).
- **knownAddresses.js**: `loadKnownAddresses(fetchImpl?,path?)→Promise<KnownData>` (empty on any failure, never throws), `knownLabel(address,chainId,data)→string|null`. `KnownData = { "<chainId>": { "<lc address>": {label,category} } }`. Bundled at `data/known-addresses.json`.

Contract extensions (additive, backward-compatible):
- `render/labels.nodeLabel(node,{addressFormat,knownLabel?})` and `nodeVisual(node,{knownLabel?})` — name precedence: user alias > known label > address.
- `GraphView` gains `setDisplayOptions(opts:DisplayOptions)` and `refreshProjection()`. `createGraphView(container,store,deps)` deps gain optional `getKnownLabel(address, chainId)→string|null` (called with the node's own chain). The view now renders vis **DataViews** (filtered edges + nodes) over the full mirror; `graphStore` stays the sole source of truth (filters never mutate it).
- Bundled data paths already in `config.DATA_PATHS`; `data/spam-tokens.json` = array of lowercased contracts/symbols hidden when "hide spam" is on.

New i18n keys: `filters.label`, `filters.minAmount.label`, `filters.hideZero`, `filters.hideSpam` (en+fr). New DOM ids: `minAmount`, `hideZeroToggle`, `hideSpamToggle`.

D1.2 (edge bundling) shipped: `display.bundleEdges(edges)→BundledEdge[]`, view `setBundling(on)`/`getEdgeData(id)`, `ui.renderBundleDetails`. Bundles key on `` `${fromId}|${toId}|${contract}|${symbol}` `` (never span chains); `BundledEdge` carries `chainId, fromId, toId` and `from`/`to` stay addresses.

## Stage D additions (Feature Layer 2)

New DOM-free modules:
- **workspace.js**: `WORKSPACE_VERSION=3`.
  - `serializeWorkspace({root,nodes,edges,filters,layout,annotations}) → { version:3, root, graph:{nodes,edges}, filters, layout, annotations }` — no top-level `chainId` (an input `chainId` is ignored); every record carries its own `chainId`.
  - `parseWorkspace(json|string, {fallbackChainId?}) → { ok:true, data:{ version:3, root, nodes, edges, filters, layout, annotations, assumedChainId:string|null } } | { ok:false, error, errorKey? }` (sanitizes untrusted file input; never throws).
    - version gate: absent → v2 migration; a present `version` must be an integer `1`/`2` (migrated) or `3`. An integer `> 3` → refused, `errorKey:"error.workspaceTooNew"`; anything else (`"3"`, `2.5`, `0`, `-1`, `null`, …) → refused as invalid (no `errorKey`).
    - `version === 3` → reads `graph.nodes`/`graph.edges` (both arrays required); drops a node whose `chainId` fails `parseChainId`; drops an edge with a bad `chainId`, a key not prefixed `chainId|`, or an endpoint `nodeId(chainId, from|to)` not among the parsed nodes.
    - anything else → strict v2 migration: one chain `parseChainId(obj.chainId ?? fallbackChainId)` (null → refused, `"workspace chainId must be a decimal chain id"`) is stamped on EVERY record (per-record `chainId` ignored, so a v2 file can never produce mixed chains); each edge key becomes `chainId + "|" + key` (prefixed, not recomputed). `assumedChainId` = that chain only when the file had no `chainId`.
    - `id`/`fromId`/`toId` in a file are never trusted — they are deleted from every returned record (v2 and v3) and `graphStore.loadSnapshot` recomputes them.
- **dryRun.js**: `estimateScan({firstHopNeighbors,maxDepth,typesCount,rps,maxTxPerAddress,safetyCap})→{addresses,apiCalls,seconds}` (rough upper bound, capped by safetyCap).
- **sinkFaucet.js**: `classifyHubs(nodes,edges,{minDegree=6,ratio=4})→Map<nodeId,'sink'|'faucet'>` (reads `n.id`, `e.fromId`/`e.toId`; distinct-counterparty degree, self-loops ignored; hubs are per chain), `hubDim(kind)→number`.
- **roundTrips.js**: `findCycleNodes(nodes, edges) → Set<nodeId>` (Tarjan SCC over `n.id`, `e.fromId`/`e.toId`; a cycle never crosses chains).

Contract extensions:
- `graphStore.loadSnapshot(nodes, edges)` — replace all state from a snapshot; emits reset→node:add→edge:add; recomputes `id`/`fromId`/`toId`; drops nodes with an invalid `chainId`, and edges with an invalid `chainId`, a key not prefixed `chainId|`, or an endpoint missing on that chain (invariants hold).
- `display.passesFilters` gains `minTime`/`maxTime` (UNIX secs; unknown-timestamp edges not excluded); `filtersActive` accounts for them.
- `createGraphView` deps: `getCategory?(address, chainId)` (🌀/🌉/⛔ badge) and `getKnownNote?(address, chainId)→string|null` (appended to the node hover title as ` · {note}`) both take the node's own chain; `DisplayOptions.spamContractsFor?(chainId)→Set<string>` replaces `spamContracts`.
- `GraphView` gains `setLayout(mode)`, `refreshHubs()`, `addAnnotation(text)`, `clearAnnotations()`, `getAnnotations()`, `setAnnotations(list)`. `createGraphView` deps gain optional `getHubKind(id)→('sink'|'faucet'|null)` (by node id). vis node ids are store node ids; vis edge endpoints are `fromId`/`toId`; `hasRenderedNode(id)` / `focusNode(id)` take node ids. Annotations are `note:*` overlay nodes (not graph nodes; not in store/CSV).
- `render/export.renderExportCanvas`/`exportPng`/`exportPdf` accept `annotations` (baked into the image) and `chainTag?(chainId)→string|null` (chain label line per node).
- `createGraphView` deps `getChainTag?(chainId)→string|null`: node label/title, edge title and bundle title get the tag (main shows it only at 2+ chains, always for an unknown chain). DOM id `legendChainTag` (legend row, hidden below 2 chains).

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
  - `flagsForEdge(edge: EdgeRecord, ctx: {category:(addr:string, chainId:string)=>(string|null), isFakeToken?:(edge)=>boolean}): string[]`
    — de-duplicated i18n flag keys for an edge: `flag.approvalUnlimited` (allowance/approval
    ≥ 2^255, or `setApprovalForAll(_, true)`), `flag.hiddenRecipient` (decoded recipient ≠
    tx `to`), `flag.mixer`/`flag.bridge`/`flag.sanctioned` (resolved recipient's known
    category, via the injected `category` lookup, called as `category(resolvedRecipient(edge), edge.chainId)`
    — typically `knownAddresses.knownCategory` on the edge's own chain), plus `flag.mixer` unconditionally for the Tornado Cash
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
  - `buildCsvRows(store: GraphStore, ctx: {category:(addr:string, chainId:string)=>(string|null), isFakeToken?:(edge)=>boolean, formatTimestamp?:(t:string)=>string}): string[][]`
    — pure row builder (no DOM) factored out of `exportCsv`, directly unit-testable. Returns
    the sampling-caveat line, header, then one row per node/edge. `CSV_HEADER` gained five
    trailing edge-only columns: `method`, `method_sig`, `real_recipient`, `decoded_amount`,
    `risk_flags` (semicolon-joined `flagsForEdge` keys); node rows leave them blank.
    `chain_id` (`n.chainId` / `e.chainId`) is on every row; the two deposit columns follow it (see "Exchange deposit detection"). Line 1 is the
    sampling caveat; when node rows span >= 2 distinct `chainId`s it is extended with
    `; multi-chain: each row belongs to its chain_id — the same address on two chains is two rows; a shared address implies no transfer`. Header stays on line 2.
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
    `[0.9, 1.1]`), with time never running backward. Reads `e.fromId`/`e.toId`, so a chain never hops chains. Returns ordered node-id paths of at
    least `minLen` nodes (default 3). Amount basis: `edge.amountText` (nominal per-token
    magnitude, same basis as `display.edgeAmountNumber` — NOT fiat-normalized).

`EdgeRecord.tokenDecimal` (raw token decimals persisted on the edge, `""` for
native/unknown) is documented in the `graphStore.js` section above (Stage D fix); the decode
summary and CSV `decoded_amount` column both re-format `methodArgs` amounts with it via
`formatUnits` rather than trusting a default.

## Known-address pipeline + imitation tokens

Dev-only generator, DOM-free runtime lookups, and an imitation-token flag. Sources and
licenses are documented in `data/README.md` (not repeated here).

- **`KnownData`** (`data/known-addresses.json`) — `{ "*" | "<chainId>": { "<lc address>": KnownEntry } }`.
  `"*"` = valid on every EVM chain (OFAC SDN entries). `KnownEntry = { label, category, source,
  added, symbol?, decimals?, note? }`.
- **`KNOWN_CATEGORIES`** (`config.js`) gains `token` — a canonical per-chain token contract; such
  rows carry `symbol` and optionally `decimals`.
- **knownAddresses.js**
  - `knownEntry(address, chainId, data) → KnownEntry|null` — chain-specific bucket first, then
    `"*"`; own-property lookups only. `knownLabel` and `knownCategory` are thin wrappers over it,
    so they inherit the `"*"` fallback.
  - `chainsForKnownAddress(address, data)` — chain-specific hits first, then at most one
    `{ chainId: "*" }` item last.
  - `isAllChainEntry(address, chainId, data) → boolean` — true iff `knownEntry` would answer from
    the `"*"` bucket. main.js uses it to say "listed for all EVM chains (address-level designation)"
    (`details.allChainsListing`) after the Source row and in the node tooltip (Decision 10c).
  - **One lookup rule:** labels, categories, sources, risk flags, fake tokens, spam and explorer
    links always use the record's own `chainId` (`node.chainId`, `edge.chainId`); there is no
    graph-wide data chain.
- **fakeToken.js** (pure, DOM-free, never throws on untrusted input)
  - `normalizeSymbol(s) → string` — NFKD, strips combining marks, NFKC, uppercases, maps
    Cyrillic/Greek look-alikes (and U+20AE) to Latin, drops whitespace/punctuation/invisible chars.
  - `buildCanonicalIndex(knownData) → Map<chainId, Map<normSymbol, Set<contract>>>` — built from
    `token` rows of chain-specific buckets (`"*"` is skipped).
  - `isFakeToken(edge, chainId, index) → boolean` — true only for a `tokentx` edge whose
    normalized symbol is canonical on that chain but whose `tokenContract` is not one of the
    curated contracts. Chains with no canonical tokens never flag.
- **riskFlags.js** — `flagsForEdge` ctx gains optional `isFakeToken(edge)` (main.js: `isFakeToken(e, e.chainId, canonicalIndex)`); when true it adds
  `flag.fakeToken` (informational tier, amber ⓘ).
- **display.js** — `parseSpamList(raw) → { symbols:Set, contractsFor(chainId):Set }`; `raw` is
  `{ "*": [...], "<chainId>": [...] }` (a legacy flat array = `"*"`); `0x…` items are contracts
  scoped to their key, other strings are global symbols. `passesFilters` opts gain optional
  `isFakeToken(edge)`; `hideSpam` hides spam-list hits **and** imitation tokens.
- **render/network.js** — `setDisplayOptions` accepts `isFakeToken`.
- **ui.js** — `renderEdgeDetails` deps gain optional `isFakeToken(edge)` (absent-safe: no fake-token
  flag when missing); it is passed to `flagsForEdge` and drives the risk-flags row.
- **render/export.js** — `buildCsvRows`/`exportCsv` accept `isFakeToken`; `risk_flags` is now
  computed for every edge row.
- `loadOlder` / node history are unaffected.
- **scripts/known-addresses/pipeline.mjs** (dev-only, never run in CI or by the app) exports
  `parseOfacXml`, `parseSuperchain`, `mergeSources`, `serializeKnownData`, `verifyEntry`.
  Driven by `bun run data:build [--ofac <sdn.xml>] [--verify-sources]`, which merges OFAC SDN +
  superchain registry (main HEAD at build time; SHA recorded in each `source`) +
  `data/sources/curated.json` into `data/known-addresses.json`.

### Chain filter (multi-chain Task 6)
- `display.passesFilters(edge, { hiddenChains?: Set<string> })` is false when `hiddenChains.has(edge.chainId)`; `filtersActive` is true when `hiddenChains.size > 0`. `DisplayOptions.hiddenChains` also hides node items by `chainId` (roots included); node DataSet items carry `chainId`.
- `ui.renderChainFilter(container, { chains:[{chainId,name}], hidden:Set, onToggle(chainId, visible) })` renders `<label class="field check"><input type="checkbox" data-chain>` per chain (checked = visible; names via `textContent`).
- Workspace `filters.hiddenChains`: array of `parseChainId`-valid strings; other items dropped, a non-array removed. main restores only chains present at 2+ chains.
- DOM ids: `chainFilter` (hidden below 2 chains), `chainFilterList`. i18n `filters.chains` (en+fr). `revealNode` re-shows a hidden chain first.

### chainTwins.js (multi-chain Task 7, pure)
- `addressEvidence(edges, chainsConfig) → Map<nodeId,'eoa'|'contract'>`: `txlist` from = eoa; `txlistinternal` from / `tokenContract` = contract; eoa wins; edges on `nativeAA` chains skipped.
- `sameAddressLinks(nodes, evidence) → [{address,a,b,basis:'key'|'address'}]`: all pairs per address, chain-numeric order; `key` iff any twin has eoa evidence.
- config: `Chain.nativeAA?: boolean` (true for Abstract 2741/11124).

### Same-key overlay (multi-chain Task 8)
- `GraphView.setTwins(on)`, `getTwinLinks() → [{address,a,b,basis:'key'}]` (the drawn ones). Drawn only when `on && store.chains().length >= 2` and `basis==='key'`; address-only pairs are never drawn. Derived in `refreshProjection`/`node:remove`, never stored, cleared on `reset`.
- Twin vis item id `twin:${a}|${b}`, `twin:true`, dotted grey, `physics:false`, in `edgesDS` and `bundledDS`. The edge view filter lets `twin` items through; restyle, visible-node computation and bundle building skip them; `selectHighDegree` ignores `twin:` ids; never CSV rows.
- `renderExportCanvas` opts `twinLinks?:[{a,b}]`, `twinLabel?`; `exportPng`/`exportPdf` forward them.
- `ui.renderTwinDetails(container, {address, chains:[A,B]}, {i18n})`. Workspace `filters.showTwins` kept only if boolean.

## Multi-chain graph (Phase 2 summary)
- **Ids/records:** node id `chainId:address`; every NodeRecord/EdgeRecord carries `chainId`; edge keys are `chainId|…`. Workspace v3 = `{version:3, graph:{nodes,edges}, …}` with no top-level chain (v1/v2 migrate on load). CSV gains `chain_id`; the deposit columns follow it (see "Exchange deposit detection").
- **chainTwins.js** (pure): `addressEvidence(edges, CHAINS)`, `sameAddressLinks(nodes, evidence)`; `basis:'key'` only with txlist-signer evidence on a known non-`nativeAA` chain.
- **View twins:** `GraphView.setTwins(on)` / `getTwinLinks()`; dotted `twin:` vis edges (never stored, never CSV); `filters.showTwins`; legend `legendTwinKey`; chain filter `filters.hiddenChains`.
- **ui:** `otherChains` row (same key / "same address only") with twin focus and conservative alias apply; `renderTwinDetails(container, {address, chains}, {i18n})`.
- **export:** `renderExportCanvas`/`exportPng`/`exportPdf` accept `twinLinks`, `twinLabel`.
- **Details actions:** "Check other chains" probe (Stop discards partial results) and "Load on {chain}" (one page, mainnet-first picker, no alias copy).
- **Known limitation:** OP-stack/Arbitrum `txlist` may include aliased L1→L2 deposit senders, so "same key" is a signal, not proof. Not in this version: color-by-chain, drawing address-only links.

## Exchange deposit detection (P4)

Heuristic: an address whose sampled outflow went nearly entirely to one known exchange wallet
is a likely deposit address. A display projection, never stored, never in workspaces.

- **depositDetect.js** — new, pure, DOM-free:
  - `findDeposits(nodes, edges, ctx:{known(address, chainId)→KnownEntry|null, ignoreEdge?(edge)→boolean, trustedToken?(contract, chainId)→boolean}): Map<nodeId, DepositEvidence>`
  - `DepositEvidence = { walletId, wallet, label, swept, outgoing, assets:[{symbol, contract, sharePct}], maxDelaySec:number|null, timedSweeps }` (`contract ""` = native; `maxDelaySec` null = no prior inflow in the sample).
  - `delayParts(sec) → { key:'duration.m'|'duration.h'|'duration.d', params:{n} }`
  - Criteria (all must hold), constants in the module:
    1. Node's `history` has both `txlist` and `tokentx` (own transactions fetched).
    2. Node is not a known entity on its chain.
    3. Outgoing value transfers: from the node, action txlist/txlistinternal/tokentx present in its `history`, `BigInt(value) > 0n`, not `ignoreEdge`; NFTs ignored.
    4. At least one outgoing edge goes to an address with category `exchange` on the edge's chain.
    5. All such exchange-bound edges go to the same wallet.
    6. Count share: `|S| * 100 >= |O| * 90`.
    7. Value share per swept asset (BigInt, raw units): `sum(S_a) * 100n >= sum(O_a) * 90n`; `sharePct` is the floored integer percent.
    8. Trusted asset (spec criterion 9): at least one exchange-bound edge is native (txlist/txlistinternal) or a tokentx whose contract passes `trustedToken(contract, edge.chainId)` (absent → native only). main passes the known `token` category. Spoofed sweeps still count in the shares.
  - Delay (evidence only): sweep `timeStamp` minus the latest same-asset inflow (`<=`) in the store, same filter as outflows (fetched action, value > 0, not imitation/spam); decimal-digit timestamps only. Chains never mix.
- **riskScore.js** — `RiskInput.deposit:boolean` adds the context reason `risk.deposit` (no score).
- **render/network.js** — `createGraphView` dep `getDeposit?(id)→DepositEvidence|null` (label line + tooltip); `GraphView.refreshNodes(ids)` re-applies only the given nodes.
- **ui.js** — `renderNodeDetails` dep `deposit?: DepositEvidence|null` renders the "Exchange deposit" row (textContent only).
- **render/export.js** — `buildCsvRows` ctx / `exportCsv` deps `deposits?: Map<nodeId, DepositEvidence>`. Columns now end `…, chain_id, likely_deposit_of, deposit_evidence`; node rows only, edge rows blank. Evidence format: `wallet=<addr>;swept=<N>/<M>;share=<SYM>:<pct>%[,…];max_delay_s=<n>|none`. When any row has one, line 1 gains `; likely_deposit_of is a heuristic (nearly all of the address's sampled outflow went to one known exchange wallet) - not an attribution`.
- **main.js** — `depositMap` is recomputed by one coalesced store subscription (at most once per macrotask) and after known/spam data loads; only nodes whose status changed are refreshed. Never stored, never in workspace files (workspace stays v3).

## Evidence exports (P5)

A query log of Etherscan requests plus an evidence bundle (one store-only zip). The log and bundle
are tamper **evidence** only: no signature, no proof of time or authorship. The API key is in no
artifact. Workspace stays **v3** (new fields are optional).

- **queryLog.js** — DOM-free:
  - `QueryEntry = { at:string /* ISO-8601 UTC, Z */, chainId:string, action:string /* ^[a-z0-9]{1,32}$ */, params:Record<PARAM_KEYS,string> /* present keys only, no apikey */, url:string, httpStatus:number|null, rows:number|null, sha256:string|null /* hex of the raw body */, outcome:'ok'|'retry'|'error'|'network' }`
  - `QueryLogState = { entries:QueryEntry[], dropped:number, unloggedData:boolean }`
  - consts `PARAM_KEYS`, `OUTCOMES`; `sha256Hex(bytes) → Promise<string>` (Web Crypto); `queryUrl(params) → string` (canonical URL, known keys only, fixed order); `windowOf(entries) → {first,last}|null`.
  - `createQueryLog({limit=LIMITS.queryLog}) → { add(rec, epoch?):Promise<void> /* never rejects; rebuilds params from PARAM_KEYS, hashes rec.body */, entries(), epoch, dropped, unloggedData, markUnlogged(), clear(), load(state), toJSON():QueryLogState, window() }`. Oldest entries are shifted out past `limit` and counted in `dropped`; `clear()`/`load()` bump `epoch` and invalidate in-flight `add`s; `add(rec, epoch)` with an epoch older than the current one is discarded (main reads `epoch` when it creates a client, so a request issued before a reset/load never lands in the new log).
  - `sanitizeQueryLog(raw, limit?) → QueryLogState & { invalid:number }` — the workspace trust boundary: every entry is rebuilt from scratch (no spread), unknown param keys (incl. `apikey`) dropped, `url` rebuilt, `at` must be a real UTC instant (no rollover: month 99, Feb 30, 24:00 rejected) and is normalised to `Date#toISOString()` millisecond form, `params.chainid`/`params.action` (when present) must equal `chainId`/`action`, invalid entries dropped and counted; non-object input → empty state with `unloggedData:true`.
- **zip.js** — DOM-free: `crc32(bytes) → number`; `createZip(files:{name,bytes}[], date:Date) → Uint8Array` (method 0, UTF-8 names, no zip64; throws `RangeError` on size/count limits).
- **evidence.js** — DOM-free:
  - `CAVEATS: string[]`, `PARTIAL_CAVEAT: string`; `knownDataSnapshot(knownData) → {entries, ofacPublished:string|null}`; `retrievalSummary(state) → Retrieval|null` with `Retrieval = { queries, dropped, first, last, fullyLogged:boolean }` (`fullyLogged` = nothing dropped and `unloggedData === false` — not "the data is complete": requests may have failed, scans may have been stopped, data is sampled; a `CAVEATS` line says so; `null` when the log is empty); `observedSampling(entries) → {pageSizes, sorts, actions}`.
  - `buildManifest(input) → Promise<Manifest>`; `sha256Sums(files) → string` (`<hex>␣␣<name>\n` lines); `queryLogDocument(state, exportedAt)` → `{ format:"chainmap-query-log/1", app, exportedAt, entries, dropped, unloggedData }`; `fileStamp(date) → "YYYYMMDDTHHMMSSZ"`; `buildEvidenceZip(input) → Promise<{ zip:Uint8Array, sha256:string, names:string[] }>`; `footerLines({t, appVersion, exportedAt, retrieval}) → string[]` (translated PNG/PDF footer, adds the "partial" line when `retrieval.fullyLogged` is false).
  - `Manifest = { format:"chainmap-evidence/1", app:{name,version}, exportedAt, chains:[{chainId,name}], roots:string[], graph:{nodes,edges}, sampling:{ formAtExport:{maxDepth,maxTxPerAddress,safetyCap,types}, observed }, retrieval:Retrieval|null, data:{ knownAddresses:{entries,ofacPublished} }, caveats:string[] /* + PARTIAL_CAVEAT unless retrieval.fullyLogged */, files:[{name,bytes,sha256}], omitted:[{name,reason}] }`.
  - **Zip layout:** `graph.csv`, `workspace.json`, `graph.png` (absent, with `omitted:[{name:"graph.png",reason:"too-large"}]`, when over the pixel cap), `query-log.json`, `MANIFEST.json`, `SHA256SUMS`. `SHA256SUMS` covers every member except itself (`MANIFEST.json` included), so `sha256sum -c SHA256SUMS` checks the lot. `graph.csv` is byte-identical to a normal CSV export.
- **render/export.js**:
  - `csvText(store, ctx)` — the exact CSV text `exportCsv` downloads (BOM included). `buildCsvRows`/`csvText`/`exportCsv` take `provenance?:{exportedAt, retrieval}`; line 1 (still one comma-free `#` comment) gains `; exported <exportedAt> UTC`, then `; retrieved <first> to <last> UTC (see query log)` or `; retrieval time unknown (no query log)`, then (when the retrieval is partial) `; part of this graph has no logged retrieval (...)`, then `; labels/risk flags/imitation-token/likely-deposit/same-key marks are signals - not facts`.
  - `renderExportCanvas`/`exportPng`/`exportPdf` accept `footer?:string[]` (lines drawn with `fillText` in a band carved inside the export size, so the pixel guard still holds) and `badge?(node)→string|null` (text appended as a last label line, same string as the live view; this draws the likely-deposit mark in PNG/PDF).
  - `exportEvidenceBundle(view, store, deps) → Promise<void>` — `deps` = the PNG deps plus `{ onLog, preset, exportedAt, retrieval, workspaceText, queryLogText, manifest:{chains, roots, sampling, data} }`. Needs Web Crypto (`log.bundleNoCrypto` otherwise). Never rejects: any failure (render, null `toBlob`, zip) logs `log.bundleFailed` and downloads nothing. On success it downloads `chainmap-evidence-<fileStamp>.zip` and logs `log.bundleExported {sha256, files}`.
- **workspace.js** (still `WORKSPACE_VERSION=3`): `serializeWorkspace` input takes optional `queryLog:QueryLogState` (written as top-level `queryLog`) and `provenance:{savedAt, appVersion, caveats}` (written as top-level `savedAt`/`appVersion`/`caveats`). `parseWorkspace` result adds `queryLog:{entries,dropped,unloggedData}|null` (always through `sanitizeQueryLog`; provenance fields are never copied into data) and `queryLogInvalid:number`. A file without `queryLog` loads as "unlogged" (the log is cleared and `markUnlogged()`).
- **ui.js** — `renderQueryLog(container, entries, { i18n, dropped, unloggedData, limit })` (textContent only; shows the latest entries, a dropped-count line and an "unlogged" line). Columns: time (UTC), chain, action, address, page/size, HTTP, rows, SHA-256, outcome.
- **config.js** — `LIMITS.queryLog = 5000` (entries kept in memory and in workspaces).
- **main.js** — one `createQueryLog()` per session wired through the client `onQuery` (`makeClient` captures `queryLog.epoch` at creation and passes it to `add`); cleared on reset, replaced on workspace load, marked unlogged on demo load and on a workspace without a log. Buttons `btn.evidenceBundle`, `btn.exportQueryLog`; a collapsible query-log panel.
