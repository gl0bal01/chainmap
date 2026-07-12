# Sanctions / known-entity data expansion — design

**Date:** 2026-07-12
**Status:** approved (design), pending implementation plan
**Scope:** one small implementation plan (data-heavy, code-light; additive over existing modules)

## Goal

Broaden the bundled known-address coverage for high-signal OSINT categories
(`sanctioned` / `mixer` / `bridge` / major `exchange`) across the chains an
investigator actually uses, and formalize the category vocabulary. The flagging
*mechanism* already ships (see below) — this work is **data + one enum + tests**,
not new detection logic.

## What already exists (do NOT rebuild)

- `riskFlags.js` already emits `flag.mixer` / `flag.bridge` / `flag.sanctioned`
  from an address's known `category`, plus the Tornado deposit selector.
- Node-level `sanctioned` risk (`main.js`), edge escalation + color
  (`render/network.js`), CSV `flags` column (`render/export.js`), details-panel
  explanation (`ui.js`), and en/fr i18n keys are all live.
- `knownAddresses.js` loads `data/known-addresses.json` (chain-scoped,
  same-origin fetch, empty-on-failure) and exposes `knownLabel` / `knownCategory`
  / `chainsForKnownAddress`.

So the only gaps are **coverage** (one chain, ~16 addresses, 1 sanctioned entry)
and an **unformalized category enum** (`data/README.md` says "free-form until
Stage D fixes the enum").

## Invariants preserved (non-negotiable)

- Pure, DOM-free logic; DOM/vis only in `render/*`, `ui.js`, `main.js`.
- `graphStore` is the ONE source of truth; known-labels are a display projection —
  they never mutate the store or change a node id.
- Strict CSP unchanged: data is fetched from same origin (`connect-src 'self'`),
  never a third-party OFAC feed.
- Addresses lowercased, canonical node id; labels never change ids.
- i18n parity (en/fr) stays enforced by `test/locales.test.js`.

## Design

### 1. Dataset expansion (`data/known-addresses.json`)

- Keep the existing shape `{ "<chainId>": { "<lc address>": { … } } }`.
- **Extend the entry record** (backward compatible):
  ```json
  { "label": "Tornado Cash: 100 ETH", "category": "mixer",
    "source": "OFAC SDN 2022-08-08", "added": "2026-07-12" }
  ```
  `label` + `category` stay required; `source` + `added` are **optional** metadata.
  Existing consumers (`knownLabel`, `knownCategory`) read only `label`/`category`,
  so they are unaffected.
- **Coverage target:** add curated, hand-verified entries on the mainnets an
  investigator uses — chains `1, 56, 137, 42161, 10, 8453` — across categories:
  - `sanctioned` — publicly documented OFAC-designated addresses (e.g. Tornado
    contracts, Lazarus/Ronin exploiter, Blender/Sinbad-class where on an EVM
    chain).
  - `mixer` — Tornado router/pools per chain where deployed.
  - `bridge` — canonical bridges (Polygon PoS, Arbitrum, Optimism/Base standard,
    Ronin) — these also feed Spec 2 (bridge-follow).
  - `exchange` — well-known CEX hot wallets (Binance, Coinbase, Kraken, OKX).
- Every address key **lowercased**; no duplicate address within a chain.

### 2. Honesty rails (credibility is the product)

- The dataset is a **dated, hand-curated snapshot of publicly documented
  addresses** — NOT a live or authoritative OFAC feed (CSP + no backend + the
  app's no-false-certainty ethos forbid presenting it as ground truth).
- `data/README.md` and any UI surface that names the source must state:
  *"Bundled snapshot for teaching/lead generation — verify against the live OFAC
  SDN list before acting."*
- `source` / `added` fields exist so a label can be traced to its provenance and
  age. Undated/unsourced entries are allowed but discouraged.

### 3. Category enum formalization (`config.js`)

- Add a single source of truth:
  ```js
  export const KNOWN_CATEGORIES = [
    "exchange", "router", "bridge", "burn",
    "mixer", "contract", "sanctioned", "other",
  ];
  ```
- Update `data/README.md` to reference it and drop the "free-form until Stage D"
  note.
- No consumer behavior change — `knownCategory` still returns the raw string;
  the enum exists to keep the dataset honest and testable.

### 4. UI (YAGNI — minimal)

- No new filter this round. Existing edge escalation + node risk already surface
  sanctioned/mixer/bridge touches on the graph.
- Only ensure a legend entry / details-panel line names the category and (when
  present) the `source`, escaped via `textContent` — no untrusted string to
  `innerHTML`.
- A "sanctioned/mixer only" view filter is explicitly **deferred** — add later
  if the expanded dataset makes it worthwhile.

## Tests

- `test/knownAddresses.test.js` (extend): entries with the new optional fields
  still resolve `label`/`category`; `chainsForKnownAddress` unaffected.
- **New dataset-validity test** (`test/knownAddressesData.test.js` or fold into
  `config.test.js`): parse `data/known-addresses.json` and assert —
  - every category ∈ `KNOWN_CATEGORIES`;
  - every address key is lowercased and a valid address;
  - no duplicate address within a chain;
  - when `source`/`added` present, they are non-empty strings.
- `test/locales.test.js` stays green (no new user-facing keys unless a legend
  string is added, in which case add to both en/fr).

## Out of scope

- Live OFAC/chainalysis feeds (needs a backend + loosened CSP — rejected).
- Address clustering / attribution heuristics.
- New view filters (deferred).

## Risks

- **Stale data.** Mitigated by `added` dates + the "verify against live SDN"
  disclaimer; the snapshot is a lead source, not authority.
- **Wrong attribution.** Only publicly documented addresses; each carries a
  `source`. A mislabeled address is a data bug fixable by one JSON edit.
