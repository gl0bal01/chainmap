# Historical USD values, opt-in (P6) — design

Status: approved for build (lead ruling, within owner decisions). Branch `feat/usd-values`, base 3a2afd9.

## Intent

An investigator often needs "how much was that worth?" — 3.2 ETH in 2021 and 3.2 ETH today are different stories.
P6 adds an **opt-in**, clearly-labelled **estimate** of each transfer's USD value at the time of the transaction,
from DefiLlama's free coins API, without ever weakening the app's exact-amount, privacy and honesty guarantees.

## Goals

1. A checkbox **"Show USD values"**, **OFF by default and never persisted** (not in localStorage, not in
   workspaces). While it is off the app makes **zero** requests to the price provider.
2. When on, each priceable edge gets `≈ USD` = exact token amount × DefiLlama price at tx time, computed with BigInt.
   Shown in the **edge details panel** and in the CSV column **`usd_value`**. The label is always
   "≈ USD (estimate, DefiLlama, price at tx time)". Token amounts stay exactly as today (formatUnits, BigInt).
3. The provider (`https://coins.llama.fi`, no key) receives **only** coin identifiers (`<llama-chain>:<token
   contract>` or a native-coin id) and hour-rounded timestamps. Never an investigated address, a tx hash, the
   Etherscan key, a referrer or cookies.
4. Prices never block or slow the graph: a background queue with its own rate limiter, batched requests, an
   in-memory cache per (coin, hour), graceful degradation — unknown → blank, **never 0**.
5. **Evidence (P5):** every price request is a query-log entry (same whitelist-rebuild + body SHA-256 rules); the
   evidence bundle's MANIFEST states the price source and that USD values are estimates; CSV line 1 says so.
6. CSP `connect-src` gains exactly `https://coins.llama.fi`.

## Non-goals

- No USD on graph edge labels (live or PNG/PDF): labels already drop text over 18 characters; USD would crowd them.
  Details + CSV only. (A later project can add a label line.)
- No USD for bundled edges (A→B totals), NFTs (ERC-721/1155), zero-value transfers, testnets.
- No current-price ("today's value") mode, no other fiat, no portfolio/balance valuation, no price charts.
- No persistence of prices (workspace or localStorage); no price provider choice; no API key.

## Anti-goals (must never happen)

- Any request to coins.llama.fi while the checkbox is off (including at load, on workspace load, on demo).
- An investigated address (any `from`/`to`, any root), a tx hash, an API key or any free text in a price request.
- A USD value shown as `0` (or `0.00`) when the price is unknown, pending, failed or below confidence.
- An imitation token (fakeToken flag) or a spam-list token priced — in particular, never priced with the canonical
  token's price. Pricing is by **contract only**; symbols are never used to look up a price.
- `Number` arithmetic on token amounts (the price itself is a JSON number; it is converted exactly to a decimal
  rational and multiplied with BigInt).
- USD presented as exact, as a fact, or without the estimate label; a USD value whose request is not in the query
  log of the same epoch.
- Price state mutating `graphStore`; a price failure stopping or slowing a scan.

## Constraints (house invariants)

Buildless, client-side; DOM only in `ui.js`/`render/*`/`main.js`; pure logic DOM-free + unit-tested; `graphStore`
untouched (USD is a derived projection); untrusted strings via `textContent`; every UI string in en+fr at parity;
workspace stays **v3**; no new dependency; commits `gl0bal01 <gl0bal01@proton.me>`, no AI text.

## Approaches considered (fetch strategy)

| Option | For | Against |
|---|---|---|
| A. Fetch on demand only (when a details panel opens; await all at CSV export) | fewest requests | CSV export would wait on the network (and on a third party) — slow, failure-prone exports |
| **B. Background prefetch while ON (chosen)** | exports stay synchronous; details usually ready; one queue, batched by hour | more requests than A for big graphs (bounded by the batch size and rate limit) |
| C. `/prices/historical/{ts}/{coins}` per hour bucket | trivial mapping (one timestamp per request) | one request per distinct hour: a months-long sparse graph needs ~one request per edge |

Chosen: **B**, using `/batchHistorical` (many coins × many hours per request, mapped back by time — see
"API facts"). Ticking the box prefetches prices for every priceable edge already in the store, and every edge added
later (coalesced store subscription), through one queue. Exports write what is cached: pending/unknown → blank, and
CSV line 1 states how many priceable edges were priced.

## API facts (verified live with curl, 2026-11-16)

- `GET /batchHistorical?coins=<JSON {coinId:[unixTs,…]}>&searchWidth=<w>` → `{"coins":{"<coinId as sent>":{"symbol",
  "prices":[{"timestamp","price","confidence"?},…]}}}`. Each returned `timestamp` is the **data point's** time.
  Points with no match inside ±searchWidth are silently dropped (order kept, no echo of the requested time);
  unknown coins are omitted; a malformed coin id also returns 200 `{}` — "absent" is the only "no price" signal.
  So results are mapped back by time, not position (see the 30-minute window below).
- `searchWidth` is symmetric; accepted forms `600`, `30m`, `1h`, `4h`, `1d`…; `0`, `1s`, `1y` → 400.
- URL cap on the free tier: **9000 characters** (`414` beyond). Keep each request ≤ 8000.
- Coin ids: `<slug>:<0xcontract>` (contract case-insensitive; the response key echoes the request's case, so
  normalise to lowercase before sending); natives via `coingecko:<id>` (preferred: stable across time).
- `confidence` is optional (absent on 2021 points); every sampled value was 0.99/0.999; DefiLlama documents no
  meaning or threshold.
- Granularity: ETH ~hourly or denser (jitter ~1.5 min) from 2021 to 2025; long-tail coins can be much sparser;
  before listing → nothing.
- Rate limit: undocumented; 100 requests at 50 parallel all returned 200; no `Retry-After` seen. CORS echoes the
  Origin (works from the browser). `cache-control: max-age=3600`.

**Chosen request shape.** Timestamps are rounded to the **nearest hour** (`bucket = round(ts/3600)*3600`, so the tx
is within ±30 min of its bucket) and sent with `searchWidth=30m`. Buckets are 3600 s apart and windows are ±1800 s,
so every returned point lies in exactly one requested bucket's window: a point `p` is assigned to
`round(p/3600)*3600` when that bucket was requested for that coin and `|p − bucket| ≤ 1800`; if two points land on
one bucket the closer one wins. The used price is therefore within ±1 h of the transaction (shown in details).
One request carries many coins × many buckets, split so the encoded URL stays ≤ 8000 characters.

**Chain table (`LLAMA_CHAINS`, mainnets only, all verified live):**

| chainId | slug | native coin id |
|---|---|---|
| 1 | ethereum | coingecko:ethereum |
| 56 | bsc | coingecko:binancecoin |
| 137 | polygon | coingecko:matic-network before 1725926400 (2024-09-10), coingecko:polygon-ecosystem-token after |
| 42161 | arbitrum | coingecko:ethereum |
| 10 | optimism | coingecko:ethereum |
| 8453 | base | coingecko:ethereum |
| 43114 | avax | coingecko:avalanche-2 |
| 59144 | linea | coingecko:ethereum |
| 81457 | blast | coingecko:ethereum |
| 199 | bittorrent | coingecko:bittorrent |
| 42220 | celo | coingecko:celo |
| 252 | fraxtal | **none** (gas token switched frxETH→FRAX; the switch date is disputed — the config note says 2026-04-29, DefiLlama's remap is 2025-04-29; the two prices differ ~1000×) |
| 100 | xdai | coingecko:xdai |
| 5000 | mantle | coingecko:mantle |
| 4352 | **none** (no DefiLlama slug) | coingecko:memecore |
| 1284 | moonbeam | coingecko:moonbeam |
| 1285 | moonriver | coingecko:moonriver |
| 204 | op_bnb | coingecko:binancecoin |
| 167000 | taiko | coingecko:ethereum |
| 50 | xdc | coingecko:xdce-crowd-sale |
| 33139 | apechain | coingecko:apecoin |
| 480 | wc | coingecko:ethereum |
| 146 | sonic | coingecko:sonic-3 |
| 130 | unichain | coingecko:ethereum |
| 2741 | abstract | coingecko:ethereum |
| 80094 | berachain | coingecko:berachain-bera |
| 143 | monad | coingecko:monad |
| 999 | hyperliquid | coingecko:hyperliquid |
| 747474 | katana | coingecko:ethereum |
| 1329 | sei | coingecko:sei-network |
| 988 | stable | coingecko:tether |
| 9745 | plasma | coingecko:plasma |
| 4326 | megaeth | coingecko:ethereum |

`slug: null` → no token pricing on that chain; `native: null` → no native pricing. Every testnet is absent (no USD).
Young chains return nothing before their listing date → blank, which is correct.

## Design

### `src/config.js`

- `PRICE_API = "https://coins.llama.fi"`.
- `PRICE_FETCH = { rps: 1, maxUrlChars: 8000, timeoutMs: 15000, maxRetries: 3, backoffBaseMs: 2000,
  bucketSec: 3600, searchWidth: "30m", windowSec: 1800, minConfidence: 0.9 }`.
  `minConfidence` is **chainmap's own rule** (DefiLlama defines none): a point whose `confidence` is present and
  below 0.9 is treated as unknown; an absent `confidence` is accepted (old points lack it) and shown as "—".
- `LLAMA_CHAINS`: `{ [chainId]: { slug:string|null, native:Array<{ before?:number, coin:string }>|null } }` — the
  table in "API facts". `native` is an ordered list; the first entry whose `before` is absent or greater than the
  tx time wins (Polygon's MATIC→POL split). A test pins every key to a `CHAINS` mainnet and forbids testnets.

### `src/usdPrice.js` (new, pure, DOM-free)

- `priceKeyFor(edge, ctx) → { coin, ts } | { skip: reason }` — the ONLY function that decides what may leave the
  browser. `ctx = { isFakeToken(edge), isSpam(edge), isRoot(chainId, address) }`. Rules, in order:
  - chain not in `LLAMA_CHAINS` → `skip:"chain"`;
  - action `tokennfttx`/`token1155tx` → `skip:"nft"`;
  - `amountIndeterminate`, value not a decimal integer string, or `timeStamp` not a positive integer → `skip:"data"`;
    value `0` → `skip:"zero"`;
  - `tokentx`: slug null → `skip:"chain"`; contract (lowercased) must match `^0x[0-9a-f]{40}$` else `skip:"data"`;
    `isFakeToken(edge)` → `skip:"imitation"`; `isSpam(edge)` → `skip:"spam"`; the contract is a **root** address on
    that chain → `skip:"root"`; else `coin = slug + ":" + contract`;
  - native (`txlist`/`txlistinternal`): `native` null or no entry for the time → `skip:"chain"`; else that coin;
  - `ts = round(timeStamp / 3600) * 3600` (nearest hour).
  Only `chainId`, `action`, `tokenContract`, `value`, `amountIndeterminate`, `tokenDecimal`, `timeStamp` (and the
  symbol via the injected fake/spam predicates) are read. `from`, `to`, `hash` never are.
- `decimalsFor(edge)` → `18` for native, else the integer `tokenDecimal` 0–77, else null (`priceKeyFor` → `skip:"data"`).
- `priceToRational(p) → { num:bigint, den:bigint } | null` — exact rational from `String(p)` (handles `1.07e-6`);
  null for non-number, non-finite, ≤ 0.
- `usdCents(value:string, decimals:number, rational) → bigint` — `value × num × 100 / (den × 10^decimals)`, rounded
  half-up, all BigInt.
- `usdText(cents) → string` — `"1234.56"` (dot, no grouping, machine form for CSV); `0n` → `"<0.01"` (the value is
  positive by construction).
- `buildRequests(keys:[{coin,ts}]) → Array<{ coins:string /* canonical JSON */, pairs:[{coin,ts}] }>` — groups by
  coin (sorted coins, sorted unique ts), serialises `{"coin":[ts,…],…}` with `JSON.stringify` (fixed order), splits
  so `PRICE_API + "/batchHistorical?coins=" + encodeURIComponent(coins) + "&searchWidth=30m"` ≤ `maxUrlChars`.
- `priceUrl(coins, searchWidth)` → that URL (shared with the query log).
- `parseBatchResponse(json, pairs) → Map<"coin@ts", {price, at, confidence|null}|null>` — for each requested coin,
  find its key in `json.coins` case-insensitively; assign each point to `round(p.timestamp/3600)*3600` when that
  pair was requested and `|p.timestamp − ts| ≤ windowSec` (closer point wins); reject non-finite/≤ 0 prices and
  `confidence < minConfidence`; every requested pair without a usable point → `null` ("none").
- `createPriceService({ fetchImpl, onQuery, limiter, allowed? })` → `{ want(keys[]), get(coin, ts) → PriceState|undefined,
  cancel(), clear(), onChange(fn), stats() }`:
  - `PriceState = { state:'pending'|'ok'|'none'|'error', price?, at?, confidence? }`;
  - `want` ignores pairs already `pending`/`ok`/`none` (an `error` pair is retried), marks the rest `pending`, and
    enqueues `buildRequests(...)` through the limiter (its own `RateLimiter(PRICE_FETCH.rps)`, never the scan's);
  - just before each request is sent, `allowed?(coin)` re-filters its pairs (a contract that became a root since is
    dropped and its pair reverts to "unrequested");
  - request: `GET priceUrl(...)` with `{ credentials:"omit", referrerPolicy:"no-referrer", cache:"no-store", signal }`,
    per-request timeout, 429/5xx retry honouring `Retry-After`, body read once as bytes (the hash covers what was
    parsed), decoded + `JSON.parse`d;
  - `await onQuery(rec)` once per attempt, `rec = { at, source:"defillama", action:"batchHistorical",
    params:{ coins, searchWidth }, httpStatus, rows, outcome, body? }` (`rows` = usable prices in that response,
    null when none was read); states are published **only after** `onQuery` resolved, so no value is shown before
    its request is logged;
  - final failure → its pairs become `error`; `ok`/`none` are cached until `clear()`;
  - `clear()` bumps a generation, empties the cache, `limiter.clear()`s queued requests and aborts the in-flight
    one; results of an older generation are discarded;
  - `cancel()` = the same without emptying `ok`/`none` (pending/error pairs revert to unrequested);
  - `onChange(fn)` fires once per finished request (coalesce in main); `stats()` → `{ pending, ok, none, error }`;
  - never rejects; never throws out of `want`.

### `src/queryLog.js` (extended, same file)

- Entries gain an optional `source`: absent → Etherscan (today's entries, bytes unchanged) or `"defillama"`.
- `add(rec)` with `source:"defillama"`: entry `{ at, source:"defillama", chainId:null, action:"batchHistorical",
  params:{ coins, searchWidth }, url: priceUrl(coins, searchWidth), httpStatus, rows, sha256, outcome }` — params
  rebuilt from `PRICE_PARAM_KEYS = ["coins","searchWidth"]` only.
- `sanitizeQueryLog` validates a defillama entry strictly: `chainId === null`; `action === "batchHistorical"`;
  `searchWidth` `^\d{1,4}[mhdw]?$`; `coins` a string ≤ 8000 chars that `JSON.parse`s to a plain object with 1–400
  keys each `^[a-z0-9_-]{1,40}:(0x[0-9a-f]{40}|[a-z0-9-]{1,64})$` (no `__proto__`) whose values are non-empty
  arrays of safe integers ≥ 0, and that re-serialises (`JSON.stringify`) to exactly the input string; url rebuilt;
  other fields as today; anything else → invalid (dropped, log partial). Etherscan entries are validated as today.
- `retrievalSummary` and `observedSampling` (evidence.js) consider Etherscan entries only (the graph's retrieval
  window); price entries are summarised separately (below). The query-log panel shows price rows with chain
  "DefiLlama", action "batchHistorical", address column = number of coins (full `coins` in `title`), page "—".

### Exports / evidence

- `buildCsvRows`: header gains **`usd_value`** as the LAST column (existing positions unchanged). ctx gains
  `usd?: (edge) => string|null` (absent when the box is off). Edge rows: `usdText` when the edge's key is `ok` and
  `priceKeyFor` still returns that key (a later fake/spam/root flag suppresses a cached value), else blank; node rows
  blank. When on, line 1 gains (comma-free) `; usd_value is an estimate (DefiLlama coins.llama.fi price within 1h of
  the transaction) - blank when unknown/unpriced/pending - amounts are exact in tokens; usd priced <k> of <m>
  priceable transfers (NFT/zero-value/imitation/spam-list/root-contract/unknown-data/unsupported-chain transfers are never priced)`.
  "Priceable" = `priceKeyFor` returns a key; the same definition feeds MANIFEST.
- `evidence.js`: `buildManifest` input gains `prices`; output `prices` =
  `{ source:"DefiLlama (https://coins.llama.fi)", estimate:true, shown:boolean, note:"USD values are estimates:
  DefiLlama price within 1 hour of each transaction, multiplied by the exact token amount; blank when unknown.",
  queries, priced, priceable }` whenever USD is shown **or** the log holds any defillama entry (priced/priceable are
  null when not shown); `null` otherwise. When shown, caveats gain `USD_CAVEAT` (same meaning). `retrievalSummary`,
  `observedSampling` and the footer ignore defillama entries.
- PNG/PDF: unchanged (no USD drawn).

### UI (`index.html`, `ui.js`, `main.js`, locales)

- Investigate panel: checkbox `#usdToggle` "Show USD values" (unchecked in the HTML, never restored) + a hint:
  "Off by default. When on, DefiLlama (coins.llama.fi) receives token contracts and hour-rounded transaction times —
  never the addresses you investigate."
- `renderEdgeDetails` deps gain `usd?: { state:'pending'|'ok'|'none'|'error'|'skip', text?, price?, at?,
  confidence?, reason? } | null`: one row labelled `usd.label` ("≈ USD (estimate, DefiLlama, price at tx time)")
  showing `≈ 1,234.56 USD` (grouped per locale for display only; "< 0.01"), "fetching…", "unknown", "price request
  failed", or "not priced (<reason>)"; under it a hint with the unit price, the data-point time (UTC) and the
  confidence. No row when the box is off. `renderBundleDetails` unchanged (no USD for bundles).
- Privacy card body mentions the opt-in provider; the request indicator is unchanged (Etherscan).
- main: one price service + its own limiter. Box on → `want(priceable keys of all store edges)` once local data
  (known addresses + spam list) has loaded (`dataReady` promise; fail closed before). Coalesced store subscription
  (`edge:add`) → `want(new keys)` while on. Box off → `prices.cancel()` (queued/in-flight dropped, pending pairs
  revert; `ok`/`none` kept) and details re-render without the row. Reset / workspace load / demo (query-log epoch
  changes) → `prices.clear()`, then, if the box is on, `want(...)` for the new graph (logged in the new epoch).
  `onChange` (coalesced to one macrotask) re-renders an open edge-details panel. When the queue drains:
  `log.usdDone {priced, unknown, failed}` (failures at error level).

### i18n (en + fr)

`usd.toggle`, `usd.hint`, `usd.label`, `usd.value`, `usd.pending`, `usd.unknown`, `usd.skip.{chain,nft,zero,data,
imitation,spam,root}`, `usd.unit`, `log.usdBatch`, `log.usdError`, `queryLog.priceSource`, privacy body update
(final list to the builder; parity test).

## Tests

- **usdPrice**: `priceKeyFor` for every rule (incl. imitation USDT with the canonical symbol → skip, never the
  canonical contract; spam; root-contract; NFT; zero; testnet; unsupported chain; uppercase contract lowercased;
  the returned coin never contains `from`/`to`/hash); `priceToRational` (`3456.78`, `1e-7`, `1.2e-7`, `0`, `NaN`,
  `-1`); `usdCents` exact vectors incl. 18/6/0 decimals, huge values (> 2^53), half-up rounding, `<0.01`;
  `parsePriceResponse` (missing coin, low confidence, out-of-window, non-finite price, case-insensitive key);
  service: dedup, grouping by hour, max coins per request, cache hit, `error` retried, `clear()` discards
  in-flight, 429 + `Retry-After`, onQuery once per attempt with the defillama shape, never rejects.
- **queryLog**: defillama add/rebuild; sanitize valid round-trip; bad coins (address-like free text, uppercase,
  >max ids, `?`/`/`/`&`), bad timestamp, non-null chainId → invalid; url always rebuilt on `PRICE_API`.
- **evidence**: retrieval window ignores price entries; `prices` block when on, null when off; caveat present.
- **export**: `usd_value` is the last header column; blank when off/unknown; filled when ok; line 1 caveat
  comma-free with counts.
- **config/security**: `LLAMA_CHAINS` keys ⊂ `CHAINS` mainnets; CSP connect-src is exactly
  `'self' https://api.etherscan.io https://coins.llama.fi`.
- **locales**: parity.
- **integration** (shared harness): with the box off, a scan + details + CSV make zero coins.llama.fi requests;
  ticking it requests prices (stubbed fetch) whose URLs contain no node address, no tx hash, no key; details
  shows the estimate row; CSV `usd_value` filled; an imitation-token edge and a spam edge stay blank and were never
  requested; query log holds `source:"defillama"` entries; reset clears cache + log; unticking stops requests.
- **Browser smoke**: demo + box on with `page.route` stubbing coins.llama.fi; details row, CSV column, query log,
  no page errors; with the box off no request to the host.

## Left to the builder

Exact i18n wording (natural French), display grouping helper, hint styling, log-line wording, internal helper names.

## Owner decisions applied

- Checkbox "Show USD values", OFF by default; DefiLlama `coins.llama.fi`, no key; it receives only token contracts
  / native-coin ids + timestamps; CSP gains exactly that host; amounts stay exact; USD labelled "≈ USD (estimate,
  DefiLlama, price at tx time)"; CSV `usd_value` blank when unknown/off; lazy/batched/cached/rate-limited; unknown →
  blank, never 0; imitation and spam tokens never priced.
- Local merge only; no push/tag/release.

## Builder-check rulings

Builder check (sonnet), answered by the lead:

1. **Query-log cap.** Price entries share the one 5000-entry log (one entry per HTTP attempt, as for Etherscan).
   Batching keeps them few (one request per ≤ 8000-char URL, i.e. hundreds of coin-hours). An evicted entry is
   counted in `dropped`, which already makes `fullyLogged` false and the exports say "partial". *Cost if wrong:* a
   huge session could evict early Etherscan entries sooner — visible as "partial", never silent.
2. **Request volume.** `/batchHistorical` with nearest-hour buckets and a ±30 min window (non-overlapping, so the
   mapping is unambiguous) replaces per-hour requests; no confirmation gate. Unticking cancels the queue.
   *Cost if wrong:* a very large graph sends a few dozen requests at 1 req/s.
3. **Toggle after reset/load/demo.** The box keeps whatever the user set in this session. Every epoch change clears
   the price cache; if the box is on, the new graph's prices are requested again (logged in the new epoch). With the
   box off, nothing is ever requested. *Cost if wrong:* re-fetching after a workspace load the user opted into.
4. **Off after on.** The log keeps the defillama entries (they record requests that were made). MANIFEST carries a
   `prices` block whenever USD is shown or the log holds price entries (`shown:false` then). The cache survives
   off/on within an epoch; every cached value was logged in that epoch. *Cost if wrong:* none.
5. **Bundled edges.** No USD row; `renderBundleDetails` unchanged; no new key. *Cost if wrong:* the user unbundles to
   see per-transfer USD.
6. **"Priceable".** An edge for which `priceKeyFor` returns a key. CSV line 1 and MANIFEST use the same count and
   name the never-priced classes. *Cost if wrong:* wording.
7. **Root rule.** It exists only to keep an investigated address out of a request. Checked when keys are made and
   again (`allowed`) just before each request is sent, so a contract that became a root meanwhile is never sent.
   Non-root token contracts are sent: they are sent as asset identifiers, the owner-approved payload. *Cost if
   wrong:* DefiLlama learns that someone priced a token whose contract also appears as a graph node.
8. **Log-before-show.** The service awaits `onQuery` before publishing states; the service generation and the log
   epoch are cleared together, so a value never outlives its log entry's epoch. *Cost if wrong:* none.
9. **Data readiness.** Fail closed: no key is built before the known-address and spam data have loaded. Display and
   CSV re-run `priceKeyFor`, so a flag that appears later suppresses a cached value. *Cost if wrong:* USD appears a
   moment later on a cold start.
10. **Details refresh.** `onChange`, coalesced to one macrotask, re-renders the open edge-details panel (as deposits
    do). *Cost if wrong:* none.
11. **Fraxtal native** is unpriced (disputed switch date, ~1000× price gap); Fraxtal ERC-20s are priced. **MemeCore**
    has no DefiLlama slug: native only. *Cost if wrong:* blanks, never a wrong value.
12. **`minConfidence` 0.9** is chainmap's rule, stated as such in docs; an absent confidence is accepted. *Cost if
    wrong:* a few long-tail tokens blank (all observed values are 0.99+).
