# Bundled local datasets (Feature Layer 1 / 2 — populated in Stage D)

Loaded at runtime via `fetch('./data/*.json')` from the same origin (CSP
`connect-src 'self'`). **No network call to a third party.** Empty placeholders
ship now so the app loads; content is added in Stage D.

## `known-addresses.json`

Object keyed by **lowercased** address → label metadata. Used for static
known-address labeling (exchanges / routers / bridges) with no network lookup.

```json
{
  "0x0000000000000000000000000000000000000000": { "label": "Null address", "category": "burn" }
}
```

Field contract: `{ label: string, category: string, source?: string, added?: string }`.
`category` is one of the enumerated values in `KNOWN_CATEGORIES` (see `src/config.js`).
`source` and `added` are optional provenance fields.

**This is a dated, hand-curated snapshot of publicly documented addresses — not an authoritative or live OFAC feed. Verify against the live OFAC SDN list before acting on any `sanctioned` label.**

## `spam-tokens.json`

Array of **lowercased** token contract addresses (and/or symbols) hidden by
default as airdrop/spam noise.

```json
["0x<contract>", "0x<contract>"]
```
