# Court-grade evidence exports (P5) — design

Status: approved for build (lead ruling, within owner decisions). Branch `feat/evidence-exports`, base e847a87.

## Intent

An investigator must be able to show *how* a finding was obtained and that the exported files were not altered
afterwards. Today CSV/PNG/PDF/workspace are bare snapshots: no record of which Etherscan requests produced the data,
when, with which sampling, nor a way to check a file was not edited. P5 adds a **query log** (what was asked, when,
what came back — fingerprinted) and a one-click **evidence bundle** (all exports + log + a hashed MANIFEST in one
file), and makes every export state retrieval time, sampling and "signals, not facts".

## Goals

1. **Query log.** Every Etherscan HTTP attempt the app makes (scan, load older, load on chain, check other chains,
   detect chain, estimate) is recorded in memory: UTC time, chain id, action, request params, the request URL **with
   the API key removed**, HTTP status, row count, SHA-256 of the raw response body, outcome. Viewable in the UI,
   saved in the workspace (bounded, strictly validated on load), exportable as JSON.
2. **Evidence bundle.** One button produces one `.zip` (store-only, no compression) holding `graph.csv`,
   `workspace.json`, `graph.png`, `query-log.json`, `MANIFEST.json` and `SHA256SUMS`. MANIFEST lists every other
   file with its byte size and SHA-256; `SHA256SUMS` (`sha256sum -c` format) covers every file including
   MANIFEST.json. After export, the app logs the SHA-256 of the zip itself so the investigator can write it into
   their case notes (the tamper-evidence anchor).
3. **Every export carries provenance + honesty text**: export time (UTC), retrieval window (first/last logged query,
   or "unknown — no query log"), the sampling caveat, and that labels/heuristics (known labels, risk flags, imitation
   tokens, likely-deposit marks, same-key links) are signals, not facts. CSV: on line 1. PNG/PDF: a footer band baked
   into the image. Workspace: top-level informational fields. Bundle: MANIFEST `caveats`.
4. **Close the P4 limitation:** the likely-deposit badge line (`🏦 likely deposit → <wallet>`) is drawn on nodes in
   PNG/PDF (and so the bundle PNG), exactly as on screen.
5. **The API key appears nowhere** — not in the log, workspace, CSV, MANIFEST, SHA256SUMS, PNG footer, zip or any
   filename. Tested end to end with a distinctive key.

## Non-goals

- No digital signatures / timestamping authority / blockchain anchoring (needs keys or a third-party host). The zip
  hash in the log + SHA256SUMS give tamper *evidence*, not proof of time or authorship — the docs say so.
- No storing of raw response bodies (size, and they would duplicate the graph). Only their hash.
- No re-verification UI ("re-run the log and compare hashes") — a later project; MANIFEST makes it possible.
- No PDF inside the bundle (the PDF is the same image; PNG is the lossless original). The separate PDF export gains
  the same footer.
- No compression in the zip (store-only keeps the writer tiny and auditable; PNG is already compressed).

## Anti-goals (must never happen)

- The API key (or any substring of a configured key) in any artifact, log entry, file or filename.
- Presenting the bundle as complete history, or a label/heuristic as an established fact.
- A workspace file able to inject arbitrary fields, URLs, hosts, HTML or oversized data through `queryLog`.
- A new runtime dependency, a new host, a CSP change, or a workspace version bump.
- The log mutating `graphStore`, or logging changing what the scanner fetches.
- A hash computed over something other than the bytes actually written (e.g. hashing a string, then writing it with
  a BOM).

## Constraints (house invariants)

Buildless, client-side; DOM only in `ui.js`/`render/*`/`main.js`; pure logic DOM-free + unit-tested; `graphStore`
untouched; untrusted strings via `textContent`; every UI string in en+fr at parity; workspace stays **v3**
(`queryLog` is an optional top-level field older readers ignore); hashing with Web Crypto
`crypto.subtle.digest('SHA-256', …)` (present in browsers' secure contexts and in Bun); no new deps.

## Approaches considered (bundle format)

| Option | For | Against |
|---|---|---|
| A. Several downloads + manifest | no new code | browsers prompt/block multiple downloads; files get separated or renamed (`(1)`), breaking the manifest's names; no single object to hash |
| B. One self-contained HTML/JSON report embedding everything | single file | embedded copies are not the files an analyst opens in Excel/an image viewer; hashes would cover re-encoded (base64) payloads, not verifiable with standard tools |
| **C. Store-only ZIP (chosen)** | one file; every member's bytes are exactly what was hashed; verifiable with `unzip` + `sha256sum -c SHA256SUMS` on any OS; the zip's own hash anchors the whole set | ~90 lines of new code (CRC-32 table + local headers + central directory) — small, pure, testable against fixed vectors |

Chosen: **C**. A store-only zip writer is the smallest thing that keeps the files independently verifiable with
standard tools; A is fragile and B hashes the wrong bytes. No zip library is vendored, and none is added.

## Design

### `src/queryLog.js` (new, pure, DOM-free)

- `QueryEntry = { at, chainId, action, params, url, httpStatus, rows, sha256, outcome }`
  - `at`: ISO-8601 UTC (`Date#toISOString()`), time the response (or failure) was received.
  - `chainId`: decimal string. `action`: Etherscan action (`txlist`, …).
  - `params`: `{ chainid, module, action, address, startblock, endblock, page, offset, sort }` — strings; **never**
    `apikey`.
  - `url`: `API_BASE + "?" + URLSearchParams(params)` — rebuilt from `params`, so it cannot carry the key.
  - `httpStatus`: integer or `null` (no response: network error/timeout).
  - `rows`: length of the `result` array, `0` for "no transactions found", else `null`.
  - `sha256`: lowercase hex of the raw response body bytes, or `null` when no body was read.
  - `outcome`: `'ok' | 'retry' | 'error' | 'network'` (`ok` = status 1 or the empty-result message; `retry` = a
    throttle/429/5xx the client will retry; `error` = final API/HTTP error; `network` = no response).
- `LIMITS.queryLog = 5000` entries (config). Oldest dropped first; `dropped` counts them.
- `createQueryLog({ limit }) → { add(raw):Promise<void>, entries():QueryEntry[], dropped:number, unloggedData:boolean, markUnlogged(), clear(), load({entries, dropped, unloggedData}), toJSON(), window():{first,last}|null }` (see ruling 1)
  - `add(raw)` takes the client's hook record `{ at, chainId, action, params, httpStatus, rows, outcome, body? }`
    (`body` = `ArrayBuffer|Uint8Array`), hashes `body` with `sha256Hex`, drops any `apikey` param, builds `url`, pushes.
    Never throws (a hashing failure → `sha256: null`).
- `sha256Hex(bytes) → Promise<string>` via `crypto.subtle.digest`.
- `sanitizeQueryLog(raw) → { entries, dropped, invalid }` — the trust boundary for workspace input: `raw` must be
  `{ entries: [], dropped?: int>=0 }`; each entry is rebuilt from scratch (no spread): `at` must match
  `^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$`; `chainId` via `parseChainId`; `action` `^[a-z]{1,32}$`; `params`
  only the nine known keys, each a string `^[0-9A-Za-z]{0,66}$` (unknown keys, incl. `apikey`, dropped); `url`
  ignored and rebuilt; `httpStatus` integer 100–599 or null; `rows` integer ≥ 0 or null; `sha256` `^[0-9a-f]{64}$`
  or null; `outcome` in the enum. A failing entry is dropped and counted in `invalid`. At most `limit` entries kept
  (the newest).

### `src/etherscanClient.js`

- New option `onQuery?(rec)`. Every fetch attempt calls `await onQuery(rec)` inside try/catch (a failing hook never
  breaks a fetch), with the redacted `params` (built by a shared `buildParams`, so `buildUrl` and the log cannot
  diverge) and `at = new Date().toISOString()`.
- The body is read with `resp.arrayBuffer()`, decoded with `TextDecoder` and `JSON.parse`d (same error taxonomy as
  today for invalid JSON); the same bytes go to the hook, so the hash covers exactly what was parsed. 429/5xx:
  body not read, `sha256: null`, outcome `retry` (or `error` on the last attempt). Aborted attempts are not logged.
- Test mocks gain `arrayBuffer()`.

### `src/zip.js` (new, pure)

`createZip(files:[{name, bytes:Uint8Array}], date:Date) → Uint8Array` — store-only (method 0), CRC-32, UTF-8
names (flag bit 11), DOS date/time from the UTC fields of `date`, local headers + central directory + EOCD. No
zip64 (refuse > 0xFFFF files or any size ≥ 4 GiB with a thrown `RangeError`; the pixel guard keeps PNGs far below).
`crc32(bytes) → number` exported for tests.

### `src/evidence.js` (new, pure)

- `APP_VERSION` lives in `config.js` (`"1.3.0"`, a test pins it to `package.json`).
- `knownDataSnapshot(knownData) → { entries, ofacPublished:string|null }` (`ofacPublished` = latest
  `published YYYY-MM-DD` found in a `source`).
- `CAVEATS` (English, machine-file text): sampling; signals-not-facts (names the five heuristics); likely-deposit is
  a heuristic, not an attribution; same-key links are signals; known labels come from a dated snapshot.
- `buildManifest({ exportedAt, chains:[{chainId,name}], roots:[nodeId], graph:{nodes,edges}, sampling, retrieval,
  data, files:[{name, bytes:Uint8Array}], omitted:[{name, reason}] }) → Promise<object>` — computes `sha256` + `bytes`
  per file; output `{ format:"chainmap-evidence/1", app:{name,version}, exportedAt, chains, roots, graph, sampling,
  retrieval, data, caveats, files:[{name,bytes,sha256}], omitted }`.
  - `sampling = { formAtExport:{maxDepth, maxTxPerAddress, safetyCap, types[]}, observed:{pageSizes[], sorts[], actions[]} }`
    (`observed` derived from the log — the authoritative record; `formAtExport` labelled as such).
  - `retrieval = { queries, dropped, first, last } | null` (null = no query log: demo or a file without one).
- `sha256Sums(files:[{name, sha256}]) → string` — `"<hex>  <name>\n"` lines.

### `render/export.js`

- `renderExportCanvas` opts gain `footer?: string[]` (lines drawn in a band added below the graph on the composite
  canvas, text via `fillText` — no DOM injection) and `badge?(node) → string|null` (appended as a last label line).
  main passes `badge = id → deposit ? t("deposit.badge", {label}) : null` — the same string as the live view.
- `exportPng`/`exportPdf` forward `footer` and `badge`.
- `buildCsvRows` ctx gains `provenance?: { exportedAt, retrieval }`; line 1 is extended (still comma-free) with
  `; exported <iso> UTC; retrieved <first> to <last> UTC (see query log)` (or `; retrieval time unknown (no query
  log)`) and `; labels/risk flags/imitation-token/likely-deposit/same-key marks are signals - not facts`. Header
  stays on line 2.
- `exportEvidenceBundle(view, store, deps)` (DOM): builds CSV bytes (with the BOM, exactly as `exportCsv` writes),
  workspace bytes, query-log bytes, PNG bytes (`canvas.toBlob`), then MANIFEST + SHA256SUMS, zips, downloads
  `chainmap-evidence-<YYYYMMDDTHHMMSSZ>.zip`, logs `log.bundleExported {sha256, files}`. If the PNG is over the pixel
  cap it is **omitted** and listed in `omitted` with reason `too-large` (log `log.bundlePngOmitted`) — the bundle is
  still produced. Without `crypto.subtle` (non-secure context) → `log.bundleNoCrypto`, nothing downloaded.

### Workspace (`workspace.js`, stays v3)

- `serializeWorkspace` input gains `queryLog?` (`{entries, dropped}`) and `provenance?` → written as top-level
  `queryLog`, `savedAt`, `appVersion`, `caveats` (informational; the parser ignores all but `queryLog`).
- `parseWorkspace` returns `queryLog` = `sanitizeQueryLog(obj.queryLog)` when present, else `null` (an absent log is
  "unknown", not "empty"), plus `queryLogInvalid` count.

### UI (`ui.js`, `index.html`, `main.js`)

- Export panel: `evidenceBundleBtn` ("Evidence bundle (.zip)") and a `queryLogPanel` `<details>`: summary
  "Query log (N)"; body = `ui.renderQueryLog(container, entries, {i18n, dropped})`: a table (newest first, at most
  200 rows rendered, "showing the latest 200 of N") with columns time (UTC), chain, action, address, page/offset,
  HTTP, rows, SHA-256 (first 12 hex, full value in `title`), outcome — all via `textContent`; plus
  `exportQueryLogBtn` (downloads `query-log-<stamp>.json`).
- main: one `queryLog` instance; one `makeClient(apiKey, chainId)` replaces the four `createEtherscanClient` calls
  and passes `onQuery: (r) => queryLog.add(r).then(refreshQueryLogUi)`. Reset clears the log; a workspace load
  replaces it with the file's (or empties it when the file has none); the demo empties it. Delete-nodes leaves it.
  `log.queryLogInvalid {n}` when a file had invalid entries.
- PNG/PDF exports pass `footer` (i18n `export.footer.*`, current UI language) and `badge`.

### i18n (en + fr)

`btn.evidenceBundle`, `btn.exportQueryLog`, `queryLog.title`, `queryLog.empty`, `queryLog.showing`,
`queryLog.dropped`, `queryLog.col.*`, `queryLog.outcome.*`, `log.bundleExported`, `log.bundlePngOmitted`,
`log.bundleNoCrypto`, `log.queryLogExported`, `log.queryLogInvalid`, `export.footer.app`, `export.footer.retrieved`,
`export.footer.retrievalUnknown`, `export.footer.sampling`, `export.footer.signals` (final list left to the builder;
parity test).

## Tests

- **queryLog**: add → entry shape; `apikey` never present in `params`/`url`/JSON even when given; hash equals a
  known SHA-256 vector (`"abc"` → `ba7816bf…`); limit drops oldest + counts; sanitize: valid round-trip; each bad
  field → dropped + `invalid`; unknown keys dropped; url rebuilt (a file url with another host or `apikey` never
  survives); `__proto__` keys; non-object input → empty.
- **etherscanClient**: hook called once per attempt (ok / no-tx / retry / error / network), redacted params, body
  bytes hashed equal what was parsed; a throwing hook does not break the fetch; aborted attempts not logged.
- **zip**: CRC-32 vector (`"123456789"` → `0xCBF43926`); a test-side minimal reader parses EOCD → central directory
  → local headers and gets back identical names/bytes; UTF-8 flag; empty file; size guard throws.
- **evidence**: manifest file hashes match `sha256Hex` of the bytes; `omitted` honoured; `retrieval:null` path;
  `ofacPublished` extracted; SHA256SUMS format; caveats present.
- **export**: CSV line 1 carries exported/retrieved/signals text, comma-free, header still line 2; unknown-retrieval
  wording.
- **workspace**: queryLog saved and parsed back; missing → `null`; invalid entries dropped; v3 unchanged otherwise;
  provenance fields written.
- **labels/export canvas**: badge line appended when given.
- **locales**: parity (existing test).
- **integration** (shared harness): scan with key `"SECRETKEY_P5_TEST"` → query log has entries, none contains the
  key; saved workspace, CSV, query-log export and the bundle zip bytes (latin1-decoded) contain no key; bundle
  contains the six files and MANIFEST hashes match the members; workspace load restores the log; reset clears it;
  demo empties it; query-log panel renders rows via textContent.
- **Browser smoke**: demo → bundle downloads; `unzip -t` + `sha256sum -c SHA256SUMS` pass; PNG shows the footer and
  the 🏦 badge; real fetches are not possible offline — the smoke stubs Etherscan responses via Playwright
  `route` to exercise the log.

## Left to the builder

Exact i18n wording (natural French), table styling, footer font size/wrapping, whether `renderQueryLog` paginates
beyond the 200-row cap (it need not), internal helper names, test-reader implementation.

## Owner decisions applied

No new host, no CSP change, no new dependency, local-only; workspace stays v3; nothing about USD/bridges/Tron.

## Builder-check rulings

Builder check (sonnet), answered by the lead:

1. **Log vs graph coverage.** The log is a record of *requests*, not a proof that it explains every record in
   the graph. One flag makes the gap honest: `queryLog.unloggedData:boolean`. main sets it on demo load, on a
   workspace load whose file has no `queryLog`, and copies it from a file that has one (sanitizer: anything but
   `false` → `true`, conservative). Reset clears it. When `unloggedData` is true or `dropped > 0`, MANIFEST
   `retrieval.complete = false`, and CSV line 1 / PNG footer / MANIFEST caveats say part of the graph has no logged
   retrieval. MANIFEST caveats also state that the log includes probes that added no graph data (estimate, chain
   detection, check other chains) and that deleting nodes does not remove log entries. No per-edge heuristics.
   *Cost if wrong:* a reader may still over-read the window for mixed graphs; the flag errs towards "partial".
2. **PNG vs CSV.** `renderExportCanvas` already draws the **full store** (`store.listNodes()/listEdges()`):
   filters, bundling and hidden hubs never apply to exports. So `graph.png` and `graph.csv` describe the same
   graph; MANIFEST `caveats` says so. No change. *Cost if wrong:* none.
3. **Mocks.** Update every mock to provide `arrayBuffer()`; no `json()` fallback in the client. *Cost if wrong:*
   none (test-only).
4. **Params.** `params` = exactly what `buildUrl` sends (it fills every default, so all nine keys are always
   present). A shared `buildParams` feeds both. The sanitizer accepts only those nine keys (each optional) and
   rebuilds the url from the present keys in the canonical order. *Cost if wrong:* none.
5. **Footer vs pixel cap.** The footer band is carved *inside* the computed size: the graph area is
   `h − band`, so the total never exceeds the guard and `computeExportSize` is unchanged. *Cost if wrong:* a
   slightly shorter graph area.
