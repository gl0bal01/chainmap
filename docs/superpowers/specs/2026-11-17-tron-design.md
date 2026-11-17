# Tron, opt-in via TronGrid (P8) — design

Status: program P8 (owner-approved program contract, 2026-11-16/17) · builder-checked (rulings below)

## Intent

A large share of stablecoin flows in investigations runs on Tron (USDT TRC-20). chainmap
today is EVM-only: a pasted `T…` address gets "this tool scans EVM chains only" and an
explorer link. This feature lets the investigator **choose Tron** and trace it in the same
graph, through a second provider, **TronGrid** (`api.trongrid.io`), that is contacted **only**
after that explicit choice. Everything else stays as it is: one graph store, the same BFS,
the same latest-N sampling with Load older, the same evidence log, the same honesty rules.

**Who benefits:** investigators following USDT/TRX flows, compliance analysts, teachers
explaining how Tron differs from EVM (address encoding, TRX in sun, TRC-10 vs TRC-20).

## Goals

1. A **Tron (TronGrid)** entry in the Chain selector. Start with it scans a Tron address by
   BFS (TRX transfers and contract calls, TRX internal transfers, TRC-20 transfers).
2. **Opt-in boundary:** no request reaches `api.trongrid.io` unless the user presses Start
   with Tron selected, Estimate with Tron selected, or Load older on a Tron node. Typing a
   `T…` address, loading a workspace or the demo, or turning USD on never contacts TronGrid.
3. An **optional TronGrid API key**, sent only to TronGrid, only in the `TRON-PRO-API-KEY`
   request header, never in a URL, the query log, a workspace or any export.
4. **Which provider sees what** is stated in the UI (when Tron is selected) and in the docs.
5. **Evidence parity (P5):** every TronGrid HTTP attempt is a query-log entry (whitelisted
   params, rebuilt URL, SHA-256 of the exact body bytes, outcome), exported and re-loaded
   strictly like Etherscan and DefiLlama entries.
6. **Sampling parity:** latest N per address per type, plus **Load older** with a Tron cursor,
   stated in the UI and every export exactly as for EVM.
7. **Identity and display:** one canonical lowercase form for node ids; the base58check
   `T…` form for every human-facing string and explorer link.

## Non-goals

- Tron known-address labels, sanctions or exchange rows (the OFAC import drops TRX today;
  a follow-up can add them through the pipeline). No `data/` change in P8.
- USD values for Tron (no `LLAMA_CHAINS` entry; see trap 3).
- TRC-721/TRC-1155 (NFT) transfers, TRC-10 decimals lookup, staking/resource/vote contracts,
  contract creation, Tron testnets (Shasta/Nile), method decoding of Tron calldata.
- Bridge inference into or out of Tron (P7 scope is EVM↔EVM), and Tron↔EVM same-key twins.
- Any other host: Tronscan's API, another Tron RPC, a Tron price source.

## Anti-goals (failure even if it "works")

- Any request to `api.trongrid.io` before the user chooses Tron (Start/Estimate with Tron
  selected, or Load older on a Tron node).
- The TronGrid key anywhere except one request header: not in a URL, log entry, workspace,
  CSV, MANIFEST, bundle, console line or error message.
- A base58 address lowercased, or used as a node id.
- A `"*"` (all-EVM-chains) known-address row, an EVM twin, a bridge link, an Etherscan
  request or a DefiLlama request derived from a Tron node.
- TRX or TRC-20 amounts computed with `Number`, or a missing/bad decimals shown as a number.
- A TRC-20 `Approval` event, a staking/vote contract or a reverted call drawn as a transfer.
- A filtered page making the history cursor think the address is exhausted.
- A Tron sample presented as complete.

## Constraints

House invariants (PROGRAM.md, CLAUDE.md) apply unchanged: buildless; DOM only in
ui.js/render/main.js; pure logic DOM-free and unit-tested; graphStore the single source of
truth; no new runtime dependency; i18n parity en/fr; workspace v3; CSP connect-src lists
exactly the allowed hosts; commits by `gl0bal01 <gl0bal01@proton.me>`, no AI text.

## API facts (verified live with curl/urllib, keyless, 2026-11-17)

| Fact | Observation |
|---|---|
| CORS | Preflight `OPTIONS` with `Origin` + `Access-Control-Request-Headers: TRON-PRO-API-KEY` → `204`, `access-control-allow-origin: *`, `allow-methods: *`, `allow-headers: *`. Every GET answer, including `400`, `401` and `429`, carries `access-control-allow-origin: *`, so a browser can read the status. Wildcard ACAO works because requests use `credentials: "omit"`. |
| Chain id | `POST /jsonrpc eth_chainId` → `0x2b6653dc` = **728126428** (not an Etherscan v2 chain id). |
| TRX/TRC-10/calls | `GET /v1/accounts/{addr}/transactions` → `{data:[…], success:true, meta:{at, fingerprint, links:{next}, page_size}}`. Each item: `txID`, `blockNumber` (number), `block_timestamp` (ms), `ret:[{contractRet:"SUCCESS"\|"REVERT"\|…}]`, `raw_data.contract[0]` with `type` and `parameter.value`. Types seen: `TransferContract` (`owner_address`, `to_address`, `amount` sun, JSON number), `TransferAssetContract` (TRC-10: `asset_name` = token id string, `amount`), `TriggerSmartContract` (`owner_address`, `contract_address`, `call_value` absent when 0, `data`). Addresses are `41`+40 hex. Includes sent and received txs. |
| Internal | `GET /v1/accounts/{addr}/internal-transactions` → flat items `{internal_tx_id, tx_id, block_timestamp, from_address, to_address, data:{note, rejected, call_value:{"_": sun}}}`. `call_value` is absent for zero-value calls; keys other than `_` are TRC-10 ids. `rejected:true` is frequent (88 of 200 on a router) and means the internal call reverted. The `/transactions` endpoint does **not** return txs where the account only appears internally, with `search_internal` true or false. |
| TRC-20 | `GET /v1/accounts/{addr}/transactions/trc20` → `{transaction_id, token_info:{symbol, address (base58), decimals (number), name}, block_timestamp (ms), from, to (base58), type, value (string)}`. **No block number, no log index.** `type` includes `"Approval"` (1 of 39 rows), not only `"Transfer"`. |
| Ordering | Default `block_timestamp` descending on all three. |
| Window | `max_timestamp` and `min_timestamp` are **inclusive** (row at exactly `max_timestamp` returned; `min=max=t` returns that block's rows). |
| Paging | `limit` 1..200 (`201` → `400 {"success":false,"error":"A valid limit by parameter is required.","statusCode":400}`). Next page via opaque `fingerprint` (long base58 string) from `meta.fingerprint`; absent when no more. |
| Address in path | Both base58 `T…` and canonical hex `41…` work in the path (same data). |
| Confirmed only | `only_confirmed=true` accepted on all three. |
| Bad address | `400 {"success":false,"error":"A valid account address is required.","statusCode":400}`. |
| Keyless limit | `429 {"Error":"request rate exceeded the allowed_rps(3), and the query server is suspended for 5 s. …"}` — **no `Retry-After` header**; a burst of 8 parallel requests got 7 × 429. |
| Key | Header `TRON-PRO-API-KEY`; a non-existent key → `401 {"Error":"ApiKey not exists"}`. Keyed limits not verified (no key available). |

## Approaches considered

1. **A TronGrid client with the Etherscan client's `fetchAction(address, action, opts)`
   shape, returning rows normalised to the Etherscan RawTx fields** (chosen). `runScan`,
   `loadOlder`, history, graphStore, filters, CSV and workspace keep one code path; Tron
   differences live in one pure module and one client.
2. A separate Tron scanner and store path. Rejected: duplicates BFS, sampling and cursor
   logic, and splits the single source of truth.
3. Proxy through a backend or a Tron explorer API. Rejected: not client-side, and a new host
   (owner decision: only TronGrid).

## Design

### Trap rulings (each with its cost if wrong)

1. **Address case.** Canonical Tron address = `41` + 40 hex, **lowercased** (the 21-byte
   payload the chain itself uses). Node id = `728126428:41…`. base58check `T…` is a
   **display/derived** form only, computed from the canonical form; it is never lowercased,
   never stored as an id, never accepted from a workspace. User input accepts `T…` (checksum
   verified, case preserved) or `41…` hex (any case). Every human-facing string (labels,
   details, search, CSV, PDF, log lines, query-log table) and every Tronscan link shows `T…`;
   node ids, workspace, edge keys and query-log params keep the canonical hex. Cost if wrong:
   none for identity (hex is exact); a reader who wants the hex sees it only in JSON files.
2. **Identity.** Tron chain key = `"728126428"` (Tron's own `eth_chainId`, verified live; not
   an Etherscan v2 id, no collision with any `CHAINS` id, test-pinned). Tron is **not added
   to `CHAINS`** (which stays the Etherscan v2 EVM list): a separate `TRON_CHAIN` record
   `{ id: 728126428, name: "Tron", explorer: "tronscan.org", native: "TRX" }` in config, and a
   single `chainInfo(id)` lookup over both for name/explorer/native. Every existing consumer
   of `CHAINS` (bridgeInfer `CHAIN_IDS`, twins `known`, Look chains, Load-on-chain picker,
   probe set, LLAMA_CHAINS) therefore stays EVM-only by construction. Cost if wrong: a place
   that should show Tron's name uses `CHAINS` and shows "unknown chain" — visible, not silent.
3. **`"*"` rows and every EVM-only analysis.**
   - `knownEntry`: an explicit guard returns no `"*"` answer for the Tron chain (belt and
     braces; a `41…` key can never equal a `0x…` key anyway). No Tron rows ship, so Tron
     nodes get no label, category, sanctions or exchange mark. Cost if wrong: none (fail closed).
   - **chainTwins: exclude.** Groups are keyed by the address string, and `41…` never equals
     `0x…`, so Tron nodes are never paired with EVM nodes. The same private key *can* control
     `0xabc…` on EVM and `41abc…` on Tron; LEARN says so and tells the reader how to check by
     hand. Load-on-another-chain and Check-other-chains are hidden for Tron nodes, and Tron is
     not offered for EVM nodes. Cost if wrong: a same-key pair is not suggested.
   - **depositDetect / riskFlags / fakeToken / sinkFaucet / peelChain:** run unchanged; with
     no Tron known rows, no deposit, category or imitation flag can fire on Tron (fakeToken
     already skips `"*"` in its canonical index). Cost if wrong: none (no false flags).
   - **bridgeInfer:** ignores every edge whose chain is Tron (explicit filter at entry);
     `lookChains` stays `CHAINS`. Cost if wrong: none (P7 scope).
   - **USD:** Tron gets **no** `LLAMA_CHAINS` entry, so `priceKeyFor` returns
     `{skip:"chain"}` and nothing Tron-derived reaches DefiLlama. `coingecko:tron` would fit
     the P6 promise, but `decimalsFor` assumes 18 for native actions (TRX is 6) and TRC-20
     ids need base58 (`tron:T…`) that the P6 log validator rejects; both are out of scope.
     Cost if wrong: Tron edges show no USD estimate (blank, never 0).
   - **selectors/abiDecode:** Tron rows carry **no `input`**, so no method id, decoded args,
     `real_recipient` or `decoded_amount` (a TRC-20 `transfer` would decode a `0x…` recipient
     that is wrong on Tron and would trip `flag.hiddenRecipient`). Cost if wrong: Tron call
     methods are not shown; TRC-20 transfers are still drawn from the TRC-20 endpoint.
4. **Opt-in boundary.** `blockchainDetect` recognises `T…` and the hint says "choose Tron
   (TronGrid) in Chain to scan it — TronGrid will then see this address". It never changes the
   selector. The selector's Tron choice is **not persisted**: at load the stored chain is EVM
   (or Ethereum), so every session's first TronGrid request follows an explicit choice. Tests
   (unit + integration) assert zero `api.trongrid.io` fetches on: app load, typing a `T…`
   address, detect, demo load, workspace load (with Tron nodes), USD on, EVM scan, EVM load.
   Cost if wrong: one extra select click per session.
5. **Evidence (P5).** Query-log entry for TronGrid:
   `{ at, source:"trongrid", chainId:"728126428", action, params, url, httpStatus, rows, sha256, outcome }`
   with `action ∈ {txlist, txlistinternal, tokentx}` (the app action the request served),
   `params` from the whitelist `address, limit, only_confirmed, search_internal, min_timestamp,
   max_timestamp, fingerprint` (fixed order), and `url` **rebuilt** as
   `https://api.trongrid.io/v1/accounts/{address}/{transactions|internal-transactions|transactions/trc20}?{params minus address}`.
   `sanitizeQueryLog` accepts it only if: `source==="trongrid"`, `chainId==="728126428"`,
   action in the three, `address` `^41[0-9a-f]{40}$`, `limit` 1..200, `only_confirmed==="true"`,
   `search_internal==="false"` (txlist only), timestamps `^\d{1,16}$`, `fingerprint`
   `^[1-9A-HJ-NP-Za-km-z]{1,1024}$`, shared `validMeta`, no other key; the URL is always rebuilt.
   The request path sends the canonical hex (verified to work), so `params.address` matches
   the node id. Workspace stays **v3**. Cost if wrong: an older build drops TronGrid entries
   and Tron nodes from a v3 workspace (it validates EVM addresses only), marking the log
   `unloggedData` — the existing honest path.
6. **Sampling and cursor.** Same latest-N per address per type, newest first. The history
   cursor for Tron rows is `block_timestamp` in **ms** (TRC-20 and internal rows have no block
   number): normalised rows carry `cursor`, and `history.advance` reads `r.cursor ?? r.blockNumber`.
   `HistoryEntry.oldestBlock` then holds a ms timestamp for Tron nodes (documented in
   INTERFACES). The client maps `nextRequest` output: `endblock` → `max_timestamp`,
   `startblock` → `min_timestamp` (both inclusive, like Etherscan), `page p>1` → follow
   `meta.fingerprint` p−1 times inside that one call (each hop is a logged attempt).
   **Non-transfer rows are not dropped by the client**: an Approval, an unsupported contract
   type or an unparseable address is returned as a row with empty `from`/`to` and its
   `cursor`, so `rows.length` stays the page size (the cursor never sees a short page) and the
   scanner counts it as `skipped`. Per-address N is capped at **200** for Tron (TronGrid's
   max `limit`); the banner and log state the effective N. Cost if wrong: a Tron scan with
   N > 200 needs Load older for more rows.
7. **Amounts.** `formatUnits`/BigInt only. TRX rows: `tokenDecimal:"6"`, `tokenSymbol:""`
   (symbol = native `TRX`). TRC-20: `tokenDecimal = String(decimals)` when an integer 0..77,
   else `""` (indeterminate). TRC-10: `tokenSymbol:"TRC10:<id>"`, `tokenDecimal:""` → amount
   indeterminate (raw base units shown; precision is another request, out of scope). JSON
   number amounts (`amount`, `call_value._`) that are not safe integers → `tokenDecimal:""`
   (indeterminate) rather than a rounded value. Cost if wrong: TRC-10 amounts show raw units.

### Further rulings (design)

8. **Row mapping (pure, `src/tron.js`)**, per action:
   - `txlist` ← `/transactions?only_confirmed=true&search_internal=false`: `TransferContract`
     (TRX), `TransferAssetContract` (TRC-10), `TriggerSmartContract` (`to` = contract,
     `value` = `call_value` or `"0"`). `hash`=`txID`, `blockNumber`=String, `timeStamp` =
     seconds string, `cursor` = ms string, `isError:"1"` unless `ret[0].contractRet==="SUCCESS"`.
     Any other contract type → skipped row. Tron txs have one contract; only `contract[0]` is read.
   - `txlistinternal` ← `/internal-transactions?only_confirmed=true`: TRX value from
     `call_value._` (absent → `"0"`), `isError:"1"` when `rejected===true`, `hash`=`tx_id`,
     `logIndex`=`internal_tx_id` (edge-key discriminator), `blockNumber:""`.
     TRC-10 values inside `call_value` are not drawn (value of `_` only).
   - `tokentx` ← `/transactions/trc20?only_confirmed=true`: `type==="Transfer"` only (others →
     skipped row); base58 `from`/`to`/`token_info.address` decoded with checksum to canonical
     hex (bad → skipped row); `contractAddress` = canonical token address; `tokenSymbol`,
     `tokenName` from `token_info`; `blockNumber:""`. No log index exists, so `logIndex` =
     `"v" + value`: two transfers in one tx with the same sender, recipient, token **and
     amount** collapse into one edge (stated in caveats). Cost if wrong: such exact duplicates
     undercount by one edge.
   - `tokennfttx`/`token1155tx`: not offered on Tron; the Tron type list is
     `txlist`, `txlistinternal`, `tokentx` (Token ticked → `tokentx` only).
9. **Client (`src/tronClient.js`)**: `createTronClient({ apiKey?, fetchImpl?, onQuery?,
   timeoutMs?, maxRetries?, backoffMs? })` → `{ fetchAction }`. Every request: `fetch(url,
   { signal, headers: key ? {"TRON-PRO-API-KEY": key} : {}, credentials:"omit",
   referrerPolicy:"no-referrer" })`. Timeout/abort composed like `etherscanClient`. `429` and
   `5xx` → retry, wait `max(backoffMs, backoffMs*attempt)` with `backoffMs` ≥ 5500 (server says
   "suspended for 5 s", no Retry-After), then `rate_limit`. `401` → `invalid_key` (no retry).
   `400`/other non-2xx or `success!==true` → `api` with the body's `error`/`Error` string.
   Bytes read once and hashed; one `onQuery` per attempt (same fields as Etherscan plus
   `source:"trongrid"`). Errors reuse `EtherscanError` (its `kind` taxonomy is what scanner
   and main read). Cost if wrong: none (name only).
10. **Rate.** Each Tron operation gets its own `RateLimiter` (withBusy's per-operation limiter,
    rps chosen for Tron): **2 rps keyless** (server limit 3), **min(form rps, 10) with a key**
    (keyed limits unverified). Stop aborts and clears it like any operation. Cost if wrong:
    keyed users hit 429s that retry with a 5.5 s wait.
11. **Validation by chain.** `format.isChainAddress(chainId, addr)`: Tron → `^41[0-9a-f]{40}$`,
    else the EVM regex. Used by `scanner.ingestRows`, `workspace` node/edge checks and main's
    root parsing. `isValidAddress` stays EVM-only.
12. **Display.** `format.displayAddress(addr)`: a canonical Tron address → base58check, else
    unchanged; `shortAddress` shortens the displayed form. All explorer URLs come from one
    helper: Tron → `https://tronscan.org/#/address/<T…>` and `/#/transaction/<txid>`; EVM unchanged.
    Edge details label a Tron `tokentx` edge **TRC-20** (never ERC-20); the legend's token row
    reads "ERC-20 / TRC-20" while a Tron node is in the graph.
13. **Keys and storage.** New `#tronKey` field ("TronGrid API key (optional)"), shown with the
    provider notice only while Tron is selected. Stored like the Etherscan key: sessionStorage,
    or localStorage when "Remember" is ticked (`STORAGE_KEYS.tronKey`). The Etherscan key is
    **not required** for Tron scans/loads/estimates; it is still required for EVM.

### Pure module `src/tron.js` (new, DOM-free)

`TRON_CHAIN_ID`, a synchronous SHA-256 (base58check checksums must be computed in label
rendering, which is synchronous), `toTronBase58(hex)`, `parseTronAddress(input)` → canonical or
null, `isTronAddress(s)`, `tronPath(action)`, `tronUrl(action, params)` (used by the client
and by `queryLog` to rebuild), `tronRows(action, json)` → normalised rows. No imports beyond
`config.js`.

### Wiring (`main.js`, `ui.js`, `render/*`)

- Selector: `Tron — via TronGrid (opt-in)` option after the EVM chains; not persisted.
- Provider notice (when Tron selected), Tron key field, Etherscan key hint unchanged.
- `startScan`/`runEstimate`: root parsed by chain (`parseTronAddress` for Tron, else
  `isValidAddress`); Tron types filtered; N capped at 200 (logged when capped); the client is
  `makeTronClient()` (same query-log epoch rule as `makeClient`); limiter rps per ruling 10.
- `loadOlderFor`/`loadNewNode`: chain-aware client and refusal (`loadRefusal` requires the
  Etherscan key only for EVM chains).
- Details: Tronscan links; no Load-on-chain / Check-other-chains for Tron nodes; Tron never in
  Look or the EVM picker. Search finds a Tron node by its `T…` form.
- Address detect: `detect.tron` hint (no selector change, no request).

### Exports / evidence

- CSV `from`/`to`/token columns show `T…` for Tron rows; `chain_id` is `728126428`. A line-1
  caveat appears when Tron rows are present (`TRON_CAVEAT`).
- MANIFEST: the providers present (Etherscan v2, TronGrid, DefiLlama) with what each saw, and
  `TRON_CAVEAT` when Tron nodes exist: "Tron data comes from TronGrid (api.trongrid.io), latest
  N per address per type by block time; TRC-20 and internal rows carry no block number;
  TRC-10 amounts are raw base units; identical TRC-20 transfers within one transaction appear
  once." PNG/PDF provenance footer names TronGrid when Tron nodes are present.
- The query-log export and bundle include TronGrid entries; the key is in no artifact (test
  greps every artifact for the key string).

### i18n

New keys in en + fr (natural French): chain option label, provider notice, Tron key label,
placeholder and hint, `detect.tron`, `error.invalidTronAddress`, `log.tronLimitCapped`,
`tx.type.trc20`, legend token row with Tron, TronGrid invalid-key message if surfaced, CSV/
manifest caveat (English-only artifacts, like existing caveats).

### Docs

README + README.fr: Tron section and a "who sees what" table (Etherscan: EVM addresses +
Etherscan key; TronGrid: Tron addresses + optional TronGrid key + IP; DefiLlama: coin ids +
hour timestamps, only when USD is on). LEARN + LEARN.fr: Tron addresses (base58check vs `41`
hex; same key → same 20-byte body as EVM, not paired by chainmap), TRX in sun (6 decimals),
TRC-10 vs TRC-20, internal transactions, why amounts/blocks differ, sampling. INTERFACES:
`tron.js`, `tronClient.js`, the cursor mapping, the query-log entry, `chainInfo`. CLAUDE.md:
CSP hosts, Tron conventions, test count.

## Tests

- `tron.test.js`: SHA-256 vectors (`""`, `"abc"`); base58check vectors
  `41d1c4bb7b2f39aba5707711719b2236b5b605af2e ↔ TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi`,
  `41a614f803b6fd780986a42c78ec9c7f77e6ded13c ↔ TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`,
  `416e0617948fe030a7e4970f8389d4ad295f249b7e ↔ TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax`,
  `410000000000000000000000000000000000000000 ↔ T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb`;
  a lowercased or one-char-changed `T…` is rejected (checksum); `0x…` rejected; `41…` any
  case → lowercase; row mapping per action from fixtures trimmed from the live shapes above
  (SUCCESS/REVERT, call_value absent, rejected internal, Approval, bad decimals, unsafe
  integer, unsupported contract type → skipped row with cursor, TRC-10 indeterminate).
- `tronClient.test.js`: URL/params per action; key only in the header; `credentials`/
  `referrerPolicy`; 429 retry wait ≥ 5.5 s then `rate_limit`; 401 `invalid_key` without
  retry; 400 `api` with the server message; timeout/abort; fingerprint hops for page p
  (p−1 extra logged requests); `onQuery` record shape and body hash.
- `history.test.js`: `cursor` preferred over `blockNumber`; a full page of skipped rows still
  advances.
- `scanner.test.js`: runScan/loadOlder on `728126428` with a fake Tron client: `41…` endpoints
  ingested, skipped rows counted, ms cursor stored.
- `queryLog.test.js`: TronGrid entries recorded and sanitised strictly (each rule above;
  unknown/forged keys, chain mismatch, base58 address, forged url rebuilt).
- `workspace.test.js`: Tron nodes/edges/history round-trip in v3; base58 address, Tron
  address on an EVM chain and EVM address on Tron rejected.
- `knownAddresses`, `chainTwins`, `bridgeInfer`, `usdPrice`, `riskFlags`: Tron-guard tests
  (a `"*"` row whose body equals a Tron node's body never applies; no twin; no bridge
  candidate; `{skip:"chain"}`; no hidden-recipient flag).
- `format.test.js`: `isChainAddress`, `displayAddress`, `shortAddress`, explorer URLs.
- `integration.test.js`: zero-TronGrid-request cases (ruling 4); a Tron scan with stubbed
  fetch hits only `api.trongrid.io` with the key header and no Etherscan key; query-log
  entries; Load older sends `max_timestamp`; CSV shows `T…`; no Look/Load-on-chain for Tron;
  key absent from every artifact.
- `security.test.js`: CSP connect-src is exactly `'self' https://api.etherscan.io
  https://coins.llama.fi https://api.trongrid.io`.
- Browser smoke (headless Chrome, `page.route` stubs for all three hosts): no TronGrid request
  before Start; Tron scan; details + Tronscan link; Load older; CSV; workspace round-trip;
  query-log export; evidence bundle (`unzip -t`, `sha256sum -c`, no key); French; no errors.

## Left to the builder

Exact UI placement and copy of the notice and key field; where `chainInfo` lives (config is
fine); fixture trimming; whether `displayAddress` caches base58 results (fine if it does).

## Owner decisions applied

- Tron: YES, opt-in; TronGrid only when the user chooses Tron; CSP gains exactly
  `https://api.trongrid.io`; optional TronGrid key; UI + docs state which provider sees what.
- Any other new host (Tronscan API, another Tron API, a price source) is not approved and is
  not used. Tronscan appears only as an outbound explorer link (never fetched), like every
  EVM explorer.
- Leads merge to local main only; no push/tag/release/version bump.

## Builder-check rulings

14. **One sample-size helper.** `sampleSize(chainId, n)` (pure; `min(n, 200)` for Tron, `n`
    otherwise) is applied in `startScan`, `runEstimate` and `loadOlderFor` (so Look and
    `loadNewNode` inherit it), and the banner and `log.tronLimitCapped` show its result. The
    Tron client **rejects** a `limit` above 200 with an `api` error instead of clamping, so a
    missed call site fails visibly instead of making a 200-row page look short. Test: Load
    older on a Tron node with the form at 500 sends `limit=200` and leaves the cursor not done
    after a full page. Cost if wrong: none (stricter).
15. **Fingerprint hops are paced inside the client.** The outer `fetchAction` holds one limiter
    slot; before each hop the client waits `minIntervalMs` (abortable), given at creation as
    `1000 / rps` for the operation's rate. A nested `limiter.run` is not used (the queue is
    serialized). Any overrun still lands in the 429 retry path. Cost if wrong: a 5 s
    suspension on very busy blocks, retried.
16. **Tron is never written to or restored from `STORAGE_KEYS.chainId`.** The change handler
    skips the write when the value is Tron (the previous EVM value stays stored); at load a
    stored value that is not an EVM `CHAINS` id falls back to `"1"`. A workspace or demo
    load only ever moves the selector to an EVM chain (the single-chain auto-select uses
    `CHAINS`), and Detect only selects probed EVM chains. Test: select Tron, reload → the
    selector shows the last EVM chain; load a Tron-only workspace → selector unchanged.
    Cost if wrong: one extra click.
17. **Which lookups move to `chainInfo`.** `chainInfo` (EVM + Tron) for: main's
    `chainById`/`explorerFor`/`chainLabel`/`getChainTag`/`unsupportedChain`, graphStore's
    native ticker, and the selector option list. `CHAINS` (EVM only) stays for: Look chains,
    the Load-on-chain picker, the probe set and Detect, bridgeInfer `CHAIN_IDS`,
    `addressEvidence(…, CHAINS)` (Tron gets no `eoa` evidence), the workspace single-chain
    selector move, `LLAMA_CHAINS`. Cost if wrong: see ruling 2.
18. **Every human-facing address and explorer link is in scope.** The builder greps every
    place that shows `node.address`, `edge.from`/`to`, `tokenContract`, a query-log
    `params.address` or builds an explorer URL (labels, details, bundle rows, search, palette,
    status/log params, CSV, PDF/PNG, query-log table, bridge/twin rows) and routes it through
    `displayAddress`/`shortAddress`/the explorer helper. Tests pin labels, node and edge
    details, CSV, search and both explorer URLs for a Tron node. Provider-specific wording
    ("Etherscan calls") becomes provider-neutral where Tron can reach it. Cost if wrong: a
    hex `41…` string shown somewhere (correct, but unfamiliar).
