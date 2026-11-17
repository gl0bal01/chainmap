# Tron sanctions data (P9) — design

Status: program P9 (owner-approved 2026-11-17) · builder-checked (rulings below)

## Intent

P8 made Tron scannable but left it unlabelled: the dev-only OFAC import keeps only `0x`
ids, so the 352 Tron addresses on the OFAC SDN list (TRX and USDT tags) never reach the
app, and imitation-token detection has no canonical USDT contract on Tron. P9 widens the
**dev-only** data pipeline so those addresses become `sanctioned` rows under Tron's own
chain key, adds the **official USDT TRC-20 contract** as a curated `token` row, and pins the
runtime path end to end. The runtime already reads chain-specific Tron rows (P8 kept only
the `"*"` bucket off Tron), so P9 is a data change with tests, not a new feature surface.

**Who benefits:** investigators following USDT on Tron (the most common sanctioned flow on
the SDN list), and anyone hit by fake "USDT" TRC-20 airdrops (address poisoning).

## Goals

1. Every checksum-valid base58check `T…` id in an OFAC SDN `Digital Currency Address - *`
   entry becomes a `sanctioned` row under chain `728126428`, keyed by canonical lowercase
   `41…` hex, with the same label/source/added shape as the `"*"` OFAC rows.
2. The official USDT TRC-20 contract `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`
   (= `41a614f803b6fd780986a42c78ec9c7f77e6ded13c`), cited from Tether's own page, is a
   curated Tron `token` row, so a TRC-20 edge whose symbol normalises to USDT but whose
   contract is not that one is flagged imitation (`flag.fakeToken`).
3. A sanctioned Tron counterparty gets what an EVM one gets: known label, ⛔ badge,
   `flag.sanctioned`, the `risk.sanctioned` reason, details Source, CSV flags, PNG/PDF
   labels, and the MANIFEST known-address snapshot (entry count, OFAC publish date).
4. The EVM sanctions data is refreshed from the current OFAC list as a side effect, and the
   exact diff (rows added/removed with names, publish date before/after) is reported.

## Non-goals

- Any other Tron label: exchanges, bridges, mixers, routers. (Exchange rows would switch on
  exchange-deposit detection on Tron; that is a separate owner decision.)
- Exchange-deposit detection, bridge inference, twins, USD, selector decoding on Tron
  (P8 rulings unchanged).
- Any runtime change of host, CSP, privacy promise or workspace format.
- Sanctioned addresses of other non-EVM chains on the SDN list (XBT, LTC, SOL, XMR, …).

## Anti-goals (failure even if it "works")

- A `"*"` row applying to a Tron node, or a Tron row applying to an EVM node.
- A base58 `T…` string lowercased, or used as a data key (keys are canonical `41…` hex).
- A `T…` accepted without its checksum (regex alone), or a bad-checksum id imported.
- `sanctioned` from anything but the OFAC import (no curated sanctions on Tron either).
- A curated row silently replacing an OFAC row and its provenance.
- The EVM dataset changing in any way not explained by the OFAC refresh (registry or curated
  drift slipping in unreported).
- `data/known-addresses.json` hand-edited.

## Constraints

House invariants (PROGRAM.md, CLAUDE.md) unchanged: buildless runtime; pure logic
DOM-free and unit-tested; graphStore single source of truth; no new dependency; i18n parity;
workspace v3; CSP unchanged; commits by `gl0bal01 <gl0bal01@proton.me>`, signed, no AI text.
The pipeline is dev-only (`scripts/`), never runs in CI; CI tests the committed output.

## Facts (verified 2026-11-17)

- OFAC SDN XML (`sdn.xml`, Publish_Date 11/13/2026, sha256
  `55badef6928044db9fd5e798e6279802c1fa2019fa82a580a2e0d29a741ec9ae`): Digital Currency
  Address ids by tag and form: TRX 272 `T…`; USDT 79 `T…`, 8 `0x`, 7 Bitcoin-form (Omni);
  XBT 533 Bitcoin-form + **1 `T…`** (WANG, uid 45404: a checksum-valid Tron address under a
  Bitcoin tag); ETH 124, USDC 2, ARB 1, BSC 1, ETC 1 `0x`. No `41…` hex ids. All 352 `T…`
  ids pass the base58check checksum (`parseTronAddress`); 352 unique; none repeated; none
  under two SDN entries.
- The committed data was built from the same publish date (2026-11-13); rebuilding with the
  current code and this XML is byte-identical to the committed file, and the superchain
  registry HEAD (`edd89bd…`) equals the SHA in the committed data.
- Tether's official page `https://tether.to/en/supported-protocols/` (already cited by the
  Ethereum and Avalanche USDT rows) contains `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`.
- TronGrid TRC-20 rows give `token_info.address` as `T…`; `tronRows` parses it with
  `parseTronAddress` into the canonical `41…` hex `contractAddress`, which becomes
  `edge.tokenContract`. A curated Tron token row keyed by the same hex therefore matches.
- Runtime lookups already support Tron rows: `knownEntry` reads the chain-specific bucket
  first and never `"*"` for Tron; `buildCanonicalIndex` indexes every non-`"*"` bucket;
  `riskFlags`, `riskScore`, labels, badges, details, CSV, PNG/PDF and `knownDataSnapshot`
  call those lookups with the record's own chain.

## Approaches considered

1. **Widen `parseOfacXml` to return Tron entries alongside EVM ones, and teach `validate` /
   `mergeSources` / `verifyEntry` about the Tron chain key** (chosen). One pipeline, one
   output file, the same provenance rules, no runtime change.
2. Put Tron OFAC rows in the `"*"` bucket. Rejected: `"*"` means "all EVM chains", P8 keeps
   it off Tron by design, and a `41…` key in `"*"` would break every EVM invariant.
3. A separate `tron-known.json`. Rejected: a second runtime fetch, a second loader and
   snapshot, for no benefit.

## Design

### Rulings (each with its cost if wrong)

1. **The id's format decides the chain, not the tag.** Any `Digital Currency Address - *`
   id that starts with `T` and parses with `parseTronAddress` (checksum-verified,
   case-sensitive) is a Tron row, whatever its tag: TRX, USDT, and others (the owner's
   wording: "TRX tags, and USDT and others whose idNumber is a base58check `T…` address").
   A version-0x41 base58check address with a valid double-SHA-256 checksum is Tron by
   construction. A `T…` under a tag other than TRX or USDT (today: one XBT) is imported and
   **listed** in the build report ("OFAC Tron ids under other tags"), not fatal.
   *Cost if wrong:* one mis-tagged designated address shows as sanctioned on Tron; it is on
   the SDN list, the Source says so, and the build report names it.
2. **Only the base58check `T…` form is recognised as Tron.** A `41…` hex id is not (none
   exist; OFAC publishes `T…`). A `T`-prefixed id shaped like a Tron address
   (`T` + 33 base58 characters) that fails the checksum is a **skipped id** under any tag,
   like a malformed `0x` today. *Cost if wrong:* a future `41…` id lands in skipped ids
   (listed under its tag), not in the data.
3. **TRX is a known (Tron-only) tag.** Under TRX, anything that is not a valid `T…` is a
   skipped id, including a valid `0x…` (ambiguous: a mis-tag or Tron's body in EVM hex);
   it goes into neither bucket and is listed. A `0x` under TRX is no longer format drift.
   *Cost if wrong:* one address missing, visible in the build report.
4. **EVM tags unchanged:** under ETH/USDT/USDC/ARB/BSC/ETC a `0x` id goes to `"*"` as today;
   a `T…` id goes to Tron (ruling 1); anything else (Omni `1…`/`3…`) stays a skipped id. A
   valid `0x` under any other non-TRX tag still throws as format drift.
5. **Dedup per bucket, first entry wins** (as for EVM). The two buckets cannot share a key.
6. **Fail closed:** zero Tron addresses throws `OFAC SDN: no Tron addresses found (format
   drift?)`, like the existing EVM guard. *Cost if wrong:* the build refuses until the guard
   is revisited; nothing is written.
7. **Tron OFAC rows** go in bucket `"728126428"` with exactly the `"*"` OFAC shape:
   `{ label: "<NAME> (OFAC SDN)", category: "sanctioned", source: "OFAC SDN list, published
   <date>", added: <date> }`, keyed by canonical lowercase `41…` hex. They count under
   `bySource.ofac`.
8. **Curated Tron rows** use chainId `"728126428"`; `address` is the `T…` form exactly as
   on the cited page (checksum-verified; a `41…` hex is accepted too); the build writes the
   canonical `41…` hex. Their **category must be `token`** (else rejected `tron: token rows
   only`). This keeps deposit detection (needs `exchange` rows), bridge/mixer flags and any
   other Tron labelling off by data construction. *Cost if wrong:* a later Tron exchange or
   bridge label needs this rule widened deliberately (an owner decision).
9. **A curated row in a bucket that already holds an OFAC entry for that address is
   rejected** (`curated conflicts with OFAC`). This generalises today's `"*"` rule
   (`prov[chain][addr] === "ofac"`), so EVM behaviour is identical and a Tron curated row can
   never replace a Tron OFAC row and its provenance. *Cost if wrong:* a curated Tron row on a
   designated address is dropped while listed (the OFAC row shows instead).
10. **`--verify-sources` for a Tron row** searches the cited page for the `T…` form,
    case-sensitive, not inside a longer base58 run; a source URL embedding the address is
    `unsourced` as today. An unparseable Tron address is `absent`.
11. **USDT TRC-20 row:** `{ chainId: "728126428", address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    label: "Tether: USDT (Tron)", category: "token", symbol: "USDT", decimals: 6, source:
    "https://tether.to/en/supported-protocols/", added: "2026-11-17" }`. It is the only Tron
    USDT contract Tether lists, so "curate all legit same-symbol variants or none" holds.
    *Cost if wrong:* a legit second USDT contract on Tron would be flagged imitation (none
    known).
12. **No runtime code change is planned.** P8 already routes every lookup through
    `knownEntry` with the record's chain. Tests pin the end-to-end path; if one finds an
    EVM-only guard that drops a Tron row, the fix is the smallest one at that site.
13. **Exchange-deposit detection stays off Tron** by ruling 8 (no Tron `exchange` rows can
    exist); no code guard. The USDT row makes Tron USDT a "trusted token" for the deposit
    heuristic, which matters only with an exchange wallet. *Cost if wrong:* none while
    ruling 8 holds; a pipeline test pins it.
14. **Detect cannot reach a Tron row:** it looks up `0x` addresses only, and Tron keys are
    `41…` hex (the data test pins this), so `chainsForKnownAddress` never moves the selector
    to Tron (P8 ruling 25 holds).
15. **MANIFEST snapshot:** `knownDataSnapshot` already counts every bucket and reads the one
    publish date; no change.
16. **EVM refresh is a full rebuild from the current OFAC file** at build time (downloaded,
    sha256 recorded), with `--verify-sources` (mandatory after editing curated). A script
    diffs old vs new data per bucket; the report lists EVM `sanctioned` rows added/removed
    with label and source, and the publish date before/after. **Any other EVM change**
    (registry, curated, labels) is not covered by the owner approval: the lead stops and
    reports it instead of committing.
17. **Build report** gains: the Tron address count on the OFAC line, the list of Tron ids
    under other tags, and the list of malformed Tron-shaped ids (next to the malformed
    `0x` list). The skipped-ids-by-tag summary stays.
18. **Data validity test:** top-level keys are `"*"`, a `CHAINS` id or Tron; every key is
    valid for its chain (`isChainAddress`; `"*"` as EVM); Tron `sanctioned` rows carry the
    exact OFAC source (like `"*"`; they need no `"*"` twin) and share its single publish
    date; Tron rows are only `sanctioned` or `token`; `tronscan.org` joins the blocked source
    hosts.

### Pipeline (`scripts/known-addresses/pipeline.mjs`)

- `parseOfacXml(xml) → { publishDate, entries, tronEntries, skippedIds }`.
  `entries` (EVM, `"*"`) keep their exact shape; `tronEntries` are
  `{ address: <41-hex>, name, tag }` (the tag lets the build list off-tag ids).
- `validate(row, curated)`: per-chain address check (Tron: `parseTronAddress`; else
  `isValidAddress`); chain id `"*"`, a `CHAINS` id or Tron; Tron curated rows `token` only.
- `mergeSources`: Tron OFAC rows into `"728126428"`; canonical address per chain before
  the duplicate check; the generalised OFAC-conflict rule (ruling 9).
- `verifyEntry`: Tron needle = `toTronBase58(parseTronAddress(address))`, case-sensitive.
- The CLI (`scripts/build-known-addresses.mjs`) prints the new report lines (ruling 17).

### Data

- `data/sources/curated.json`: one new row (ruling 11).
- `data/known-addresses.json`: regenerated with `bun run data:build --verify-sources` from
  the current OFAC file; never hand-edited.

### Docs

README + README.fr ("Not supported on Tron" list → Tron gets OFAC sanctions and the
official USDT contract, imitation USDT flagged; no other Tron labels), LEARN + LEARN.fr
(sanctions paragraph + Tron section), `data/README.md` (Tron bucket, curation of Tron rows,
OFAC source line, drift/skipped rules), INTERFACES.md (known-address data shape, the P8
"no known-address labels for Tron" line), CLAUDE.md (data bullet, Tron bullet), test count.
No i18n string changes are expected (no UI text says Tron has no labels); if one is found,
both locales change.

## Tests

- **Pipeline fixture** (`test/fixtures/sdn-mini.xml` extended): a valid TRX `T…`, a valid
  USDT `T…`, a `T…` under XBT, a bad-checksum `T…` under TRX, a duplicate `T…` (second
  entity), a `0x` under TRX, a lowercased `T…`; the existing invalid TRX id stays. Unit tests
  for `parseOfacXml` (tronEntries, skippedIds, no drift for TRX `0x`, zero-Tron throw),
  `validate`/`mergeSources` (Tron OFAC bucket shape, curated Tron token `T…`→hex, non-token
  rejected, bad checksum/lowercased rejected, `T…`/hex duplicate detected, OFAC conflict in
  the Tron bucket rejected, `"*"` conflict unchanged), `verifyEntry` (Tron found
  case-sensitively; lowercased page text absent; longer run absent; URL-embedded unsourced),
  CLI (writes the Tron bucket; stdout lists Tron count and off-tag ids).
- **Data tests** (`knownAddressesData.test.js`): ruling 18; the USDT Tron row present with
  symbol USDT, decimals 6; at least one Tron `sanctioned` row.
- **Unit (real data):** `knownEntry(<tron sanctioned hex>, "728126428")` is sanctioned;
  the same hex on chain 1 is null; a `"*"` row is still null on Tron; canonical index: the
  official Tron USDT is not imitation, another contract with `USDT` or a confusable
  (`UЅDT`) is; `flagsForEdge` gives `flag.sanctioned` for a Tron edge to a sanctioned
  address; `scoreNode` gives `risk.sanctioned`.
- **Integration (one shared main.js, stubbed TronGrid):** a Tron scan whose fixture pages
  include a transfer to a real sanctioned Tron address from the data and a fake-USDT TRC-20
  transfer: node label carries `(OFAC SDN)` and ⛔, node details show the sanctioned risk
  reason and the OFAC Source (no "all chains" note), edge details show `flag.sanctioned` /
  `flag.fakeToken`, the official-USDT edge is not flagged, CSV `flags` column carries both,
  the evidence MANIFEST snapshot names the publish date; no deposit mark on Tron; zero
  requests to any host but the TronGrid stub.
- **Browser smoke** (P8 harness extended): stubbed TronGrid scan hitting a sanctioned Tron
  address and a fake USDT; label/badge/details/flags/CSV visible; no JS errors; ≥3 clean
  runs on merged main.

## Left to the builder

Fixture names and exact test placement; whether `tronEntries` carry `tag` or the build
derives off-tag ids another way; the exact wording of new build-report lines.

## Owner decisions applied (2026-11-17, binding)

1. Widen the dev-only OFAC import to Tron `T…` ids (TRX tags, and USDT and others whose id
   is a base58check `T…`), as sanctioned rows under `728126428` in canonical `41…` hex.
2. Add the official USDT TRC-20 contract, verified from a primary source and cited, as a
   curated Tron `token` row, so imitation-token detection flags fake USDT on Tron.
3. The rebuild refreshes EVM sanctions from the current OFAC list: accepted, with the exact
   diff and publish dates in the report. No new runtime host, no CSP change, no privacy
   change; anything beyond is NEEDS_OWNER.
