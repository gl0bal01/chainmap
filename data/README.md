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

Field contract: `{ label: string, category: string }`. `category` is one of
`exchange | router | bridge | burn | mixer | contract | other` (free-form until
Stage D fixes the enum).

## `spam-tokens.json`

Array of **lowercased** token contract addresses (and/or symbols) hidden by
default as airdrop/spam noise.

```json
["0x<contract>", "0x<contract>"]
```
