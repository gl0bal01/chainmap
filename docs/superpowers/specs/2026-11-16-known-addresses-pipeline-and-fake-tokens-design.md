# Known-address data pipeline + fake-token detection — design

Status: autonomous overnight design (owner opted out of questions, approach B chosen by owner) · 2026-11-16

## Intent

chainmap's goal is to help **all** blockchain investigators / data analysts. Its
known-address labels drive badges (🌀 mixer / 🌉 bridge / ⛔ sanctioned), per-edge
risk flags, the node risk score and CSV categories — but the dataset is 47
hand-typed entries (38 on Ethereum), some sourced from Etherscan's label cloud
(redistribution-unfriendly) and some **stale** (Tornado Cash was delisted from the
OFAC SDN list in 2025, yet the app can still call it "sanctioned"). The spam filter
exists but its list is empty, and the most damaging spam — **spoofed tokens**
(fake "USDT"/"USDC" used for address poisoning and fake airdrops) — is not
detected at all.

Two parts, one spec (part 2 depends on part 1's canonical-token data):

1. **Pipeline:** a dev-only, reproducible build script that generates
   `data/known-addresses.json` from (a) the official OFAC SDN file and (b)
   redistribution-safe structured sources, merged with (c) a hand-curated, cited
   seed file whose every entry is **mechanically verified** against its cited page.
2. **Fake tokens:** flag token transfers whose symbol imitates a canonical token on
   that chain while the contract is not the canonical one; hide them with the
   existing "Hide spam" filter; make the spam list chain-aware.

## Goals

- Grow coverage from 47 to roughly 800–1,500 entries across the main EVM chains,
  every entry with a `source` and `added` date.
- Sanctions labels always reflect the **current** OFAC SDN file (designations and
  delistings), refreshed with one command.
- No invented addresses: every hand-curated entry passes an automated
  "address appears on the cited page" check before it ships.
- Detect spoofed canonical-token transfers; surface them as a risk flag and hide
  them under "Hide spam".

## Non-goals

- CEX hot-wallet and scam/phishing **datasets**: no open, redistribution-safe
  source exists (all candidates are Etherscan-derived, GPL, BUSL or CC-BY-NC — see
  research). Only CEX addresses an exchange itself publishes on an official page
  may be hand-curated; no bulk import.
- Runtime lookups of any kind (CSP: the app talks only to api.etherscan.io).
- Fiat values, ENS, entity clustering.
- Multi-chain graphs (separate project).

## Anti-goals (failure even if it works)

- Shipping a label whose address does not appear in its cited source.
- Labelling an address "sanctioned" that is not in the current SDN file.
- Importing data whose license forbids redistribution in an MIT repo, or whose
  provenance is an Etherscan/Arkham/Nansen scrape.
- Flagging the real USDC/USDT as fake (false positive on a canonical contract).
- Any network call from the shipped app beyond Etherscan.

## Constraints

- App stays buildless, offline-data, CSP unchanged. The build script runs only
  on a developer machine (`bun run data:build`), **never in CI** (network); CI only
  validates the committed output (existing `test/knownAddressesData.test.js`,
  extended).
- Pure logic DOM-free + unit-tested; i18n en/fr parity; addresses lowercased.
- Licenses: OFAC = US public domain. ethereum-optimism/superchain-registry = MIT
  (attribution). Facts copied by hand from official pages are cited per entry.
  Attribution notices live in `data/README.md` (a "Sources & licenses" section).

## Approaches considered (owner chose B)

| | Approach | Verdict |
|---|---|---|
| A | Keep hand-editing the JSON | Rejected by owner: caps at a few hundred, can't refresh delistings |
| **B** | **Reproducible build script: automated public-domain/MIT imports + verified curated seed → generated JSON** | **Chosen** |
| C | Runtime label API | Rejected: leaks every queried address to a third party, breaks CSP promise |

## Design — Part 1: pipeline

### Data model changes

- **Chain-agnostic entries:** top-level key `"*"` in `known-addresses.json` holds
  entries valid on **every** EVM chain (OFAC designations attach to the address /
  its owner, and an EVM address is identical on every chain). Lookup order in
  `knownAddresses.js`: chain-specific entry first, then `"*"`.
  `chainsForKnownAddress` returns chain-specific matches plus, if present, one
  `{ chainId: "*", label, category }` item; the UI renders `"*"` as "all EVM chains"
  (i18n key).
- **New category** `token` (canonical token contract) added to
  `KNOWN_CATEGORIES`. Entries with category `token` **must** carry `symbol`
  (uppercase string) and may carry `decimals` (integer).
- Entry fields: `{ label, category, source, added, symbol?, decimals?, note? }`.
  `source` + `added` become **required for every entry** (test-enforced) — the
  "Source" row in the details panel already displays `source`.
- Existing UI that shows a category badge for `token`: none (no icon); it still
  counts as "known" for the risk score's `risk.known` context reason.

### Inputs (all under `data/sources/`, committed)

1. `curated.json` — array of hand-curated entries:
   `{ chainId: "1" | "*" | …, address, label, category, source (URL), added (YYYY-MM-DD), symbol?, decimals?, note? }`.
   The 47 existing entries are migrated here first (their current `source`
   strings preserved; entries whose source is "Etherscan public label…" are
   re-sourced to an official page where one exists, otherwise kept with
   `note: "needs official source"` and listed in the build report).
2. `ofac` — fetched at build time from
   `https://sanctionslistservice.ofac.treas.gov/api/publicationpreview/exports/sdn.xml`
   (or a local file via `--ofac <path>`). Parse `<id>` blocks whose `<idType>` is
   `Digital Currency Address - (ETH|USDT|USDC|ARB|BSC|ETC)` and whose `<idNumber>`
   is a 0x-address; take the owning `sdnEntry`'s name (`lastName`, `firstName`)
   for the label. Output entries under `"*"`, category `sanctioned`, label
   `"<NAME> (OFAC SDN)"`, source `"OFAC SDN list, published <Publish_Date>"`.
3. `superchain-registry` — fetched at build time:
   `https://raw.githubusercontent.com/ethereum-optimism/superchain-registry/main/superchain/extra/addresses/addresses.json`.
   Keep only bridge-relevant L1 contracts (`L1StandardBridgeProxy`,
   `OptimismPortalProxy`, `L1CrossDomainMessengerProxy`, `L1ERC721BridgeProxy`)
   → chain `"1"`, category `bridge`, label `"<Chain name> <contract>"`. Chain names
   come from the registry's chain list (builder: find the matching registry file;
   fall back to the chain id). Record the registry commit/date in `source`.

### Merge rules (pure, unit-tested)

- Key = `(chainId, lowercased address)`; invalid addresses rejected (reported).
- Precedence: OFAC `sanctioned` > curated > registry for **category**; label =
  curated label when present, suffixed ` (OFAC SDN)` when also sanctioned.
- An address curated as `sanctioned` but **absent** from the current OFAC file is
  downgraded: category from its `note`-declared fallback (`mixer` for Tornado
  contracts) or `other`, label suffixed `(delisted from OFAC SDN)` only when the
  curated entry says it was designated. Never silently keep "sanctioned".
- A chain-specific entry and a `"*"` entry for the same address both survive
  (chain-specific wins at lookup).
- Output: deterministic (sorted keys) `data/known-addresses.json`, plus a build
  report on stdout: counts per source / chain / category, rejected rows,
  entries needing an official source, OFAC publish date.

### Verified curation (`--verify-sources`)

- For each curated entry (or only new/changed ones with `--changed`), fetch its
  `source` URL once (cache per URL within the run) and require the address to
  appear in the response body **case-insensitively** (checksummed or lowercase).
  JS-rendered pages that don't contain the address: the curator must cite a
  raw/static source instead (e.g. the docs repo's markdown on
  raw.githubusercontent.com, an explorer-independent official JSON).
- Entries failing verification are **excluded** from the output and listed.
- `--verify-sources` is required when curating; the plain build (no flag) trusts
  the committed curated file (already verified) so it works offline for OFAC via
  `--ofac <file>`.

### Curation targets (data work, done by subagents with web access)

Per chain (at least 1, 10, 56, 137, 8453, 42161, 43114, 59144, 324, 534352, 100,
146), from official issuer/protocol pages only:
- `token`: USDC, USDT, WETH (or wrapped native), DAI, WBTC where issued; symbol +
  decimals.
- `bridge`: native/canonical bridges (Arbitrum, Polygon PoS, zkSync, Linea,
  Scroll, Base/OP via registry) + major third-party bridges (Across, Stargate,
  Wormhole, Hop) where the protocol publishes addresses.
- `router`: Uniswap (v2 router, v3 SwapRouter/SwapRouter02, Universal Router),
  1inch, 0x Exchange Proxy, CoW settlement, Paraswap — per chain where published.
- `mixer`: Tornado Cash pools/router (category mixer; note designation history).
- `exchange`: only addresses an exchange publishes officially (e.g. proof-of-
  reserves pages); none otherwise.
- `burn`: 0x0, 0x…dEaD.

### Files

- New: `scripts/build-known-addresses.mjs` (CLI), `scripts/known-addresses/*.mjs`
  pure helpers (`parseOfacXml`, `parseSuperchain`, `mergeSources`,
  `verifyEntry`), `data/sources/curated.json`, tests
  `test/buildKnownAddresses.test.js` with small XML/JSON fixtures in
  `test/fixtures/`.
- Changed: `src/config.js` (`KNOWN_CATEGORIES` + `token`), `src/knownAddresses.js`
  (`"*"` fallback), `test/knownAddressesData.test.js` (allow `"*"`, require
  source/added, `token` ⇒ `symbol`), `data/known-addresses.json` (generated),
  `data/README.md` (pipeline, refresh command, sources & licenses / attribution),
  `package.json` (`"data:build"`), README/README.fr (one line), INTERFACES.md,
  CLAUDE.md (data-pipeline convention).
- Demo workspace: must keep showing every overlay. If a demo label changes
  meaning (e.g. a delisted address), update the demo data or its test explicitly
  — never weaken the honesty of a label to keep a test green.

## Design — Part 2: fake tokens + chain-aware spam list

- New pure module `src/fakeToken.js`:
  - `normalizeSymbol(s)`: NFKC, strip whitespace/zero-width/punctuation, map a
    small confusables table (Cyrillic/Greek look-alikes of A B C E H I K M O P S T
    X Y, plus `ＵＳＤＴ`-style full-width via NFKC) to Latin, uppercase.
  - `buildCanonicalIndex(knownData)` → `Map<chainId, Map<SYMBOL, Set<contract>>>`
    from `token` entries (chain-specific only; `"*"` tokens are not canonical
    anywhere).
  - `isFakeToken(edge, chainId, index)` → true iff the edge is an ERC-20 token
    transfer (`group === "token"`, has `tokenContract`), its normalized symbol is
    a canonical symbol on that chain, and its contract is **not** in that
    symbol's canonical set. False when the chain has no canonical data (never
    guess).
- `riskFlags.flagsForEdge(edge, ctx)`: new optional `ctx.isFakeToken(edge)` →
  adds `flag.fakeToken`. Severity tier: **info** (amber ⓘ) — a fake-token transfer
  is a strong scam/poisoning signal about the sender, but usually noise for the
  recipient's flow.
- Display: "Hide spam" also hides fake-token edges (`display.passesFilters` gains
  an optional `isFakeToken` predicate in opts).
- Spam list becomes chain-aware: `data/spam-tokens.json` accepts
  `{ "*": [...], "<chainId>": [...] }` (contracts or symbols); the legacy array
  form still loads as `"*"`. Contracts are matched per graph chain (`dataChain()`),
  symbols globally. The file stays empty of contracts (no open source); ruling
  recorded.
- i18n (en/fr): `flag.fakeToken` explanation ("Imitation token: uses the symbol of
  an official token but is not its official contract on this chain"), legend line
  if the legend lists flags, `details` "all EVM chains" label for `"*"`.
- CSV `risk_flags` column picks up `flag.fakeToken` automatically.

## Tests (bun)

- Pipeline: `parseOfacXml` on a fixture (2 entities, ETH + USDT + a TRX
  non-0x id ignored, mixed-case address lowercased, entity name extracted);
  `parseSuperchain` fixture; `mergeSources` precedence, delisted downgrade, `"*"`
  + chain-specific coexistence, invalid rows rejected, deterministic output;
  `verifyEntry` with an injected fetch (present / absent / case-insensitive).
- Data test: `"*"` allowed; every entry has source + added; `token` has `symbol`;
  no `sanctioned` entry outside what the generator produced (spot check: count
  > 0 under `"*"`).
- `knownAddresses`: chain-specific beats `"*"`; `"*"` found on any chain;
  `chainsForKnownAddress` includes `"*"`.
- fakeToken: canonical contract not fake; same symbol other contract fake;
  Cyrillic "UЅDТ" fake; unknown chain never fake; NFT never fake.
- Integration: a canned token edge with symbol USDT and a non-canonical contract
  gets the ⓘ flag and disappears with "Hide spam".

## Left to the builder

- Exact confusables table contents (keep it small, documented).
- Registry chain-name resolution details.
- Whether `--changed` is worth implementing (default: verify all curated entries
  — a few hundred fetches, acceptable).
- How many curation subagent passes; target counts per chain are guidance, not
  quotas — never pad with unverifiable entries.

## Builder-check rulings (autonomous — owner asleep; each is a controller call)

1. **Existing token entries migrate to `token`.** USDC/USDT/WETH (and any other
   canonical token) currently categorised `contract` become `token` with
   `symbol` (+ `decimals`). `contract` stays in `KNOWN_CATEGORIES` for non-token
   contracts. Tests that enumerate demo categories are updated explicitly to the
   new truth (e.g. `token` instead of `contract` where the demo's USDC is
   concerned).
2. **One lookup helper.** `knownAddresses.js` exports
   `knownEntry(address, chainId, data)` (chain-specific, then `"*"`).
   `knownLabel`, `knownCategory`, and every direct `knownData[...]` read in
   `main.js` (e.g. `getKnownSource` ~L348) go through it, so a `"*"` sanctioned
   entry gets its badge, Source row, CSV category and risk flags everywhere.
3. **All four `flagsForEdge` call sites get the fake-token predicate**
   (main.js risk score, main.js view `getEdgeFlags`, ui.js edge details,
   export.js CSV — `buildCsvRows` deps gain `isFakeToken`). Build the ctx once in
   main.js and pass it down. `flag.fakeToken` joins the existing **info** tier in
   `edgeSeverity`; the legend's info line mentions fake tokens. The **node** risk
   score is unchanged (no new score input).
4. **Chain + freshness.** The predicate is
   `(edge) => isFakeToken(edge, dataChain(), canonicalIndex)`; `canonicalIndex`
   is a main.js variable rebuilt right after `knownData` loads in
   `loadLocalData`, then the projection is refreshed. The predicate reaches the
   view through the same display-opts path as `spamContracts`.
5. **Demo.** After the pipeline runs, if the demo's labeled addresses change
   status (e.g. not in the current SDN file), the demo labels follow the data
   and the demo test expectations are updated honestly — never fake a sanction to
   keep the showcase. Tornado pools stay `mixer` via the curated file, so the
   mixer overlay is unaffected.
6. **Curated entries never assert `sanctioned`.** Sanctions come only from the
   OFAC import. A curated entry for a designated entity carries its base
   category (`other`, `exchange`, …) plus the structured optional field
   `ofacDesignated: "YYYY-MM-DD"`. Merge: present in current SDN → category
   `sanctioned`, label suffixed ` (OFAC SDN)`; absent but `ofacDesignated` set →
   base category kept, label suffixed ` (delisted from OFAC SDN)`. The 13 existing
   `sanctioned` entries migrate this way. Data test: `sanctioned` appears only
   where the OFAC import put it (curated file contains no `sanctioned`).
7. **Spam list semantics.** Contracts under `"*"` apply to every chain;
   contracts under `"<chainId>"` only to that chain; **symbols match globally**
   wherever they appear. main.js keeps per-chain contract sets and passes the
   union (`"*"` ∪ graph chain) into display opts, recomputed whenever display
   options are applied (graph chain changes only on reset/scan/workspace apply).
8. **No new dependency.** `sdn.xml` is parsed with targeted regex over the
   text (find `<sdnEntry>` blocks, then their `<id>` blocks) — bun handles the
   30 MB string; no XML library, no lockfile change.
