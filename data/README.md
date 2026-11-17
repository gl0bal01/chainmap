# Bundled local datasets

## 1. Runtime loading

The app loads these files at runtime with `fetch('./data/*.json')` from its own
origin (`'self'` serves them). **No third party is ever contacted for labels.** A missing or broken file leaves the
app working without labels.

## 2. `known-addresses.json` (GENERATED, never hand-edit)

Written by `bun run data:build` from the sources below. Edit
`data/sources/curated.json` instead and rebuild.

```json
{
  "*":         { "<lowercased address>": { "label": "…", "category": "sanctioned", "source": "…", "added": "YYYY-MM-DD" } },
  "<chainId>": { "<lowercased address>": { "label": "…", "category": "token", "symbol": "USDC", "decimals": 6, "source": "…", "added": "YYYY-MM-DD", "note": "…" } }
}
```

- `"*"` holds entries valid on **all EVM chains** (an EVM address is the same on
  every chain; OFAC designations follow the owner). At lookup the chain-specific
  entry wins, then `"*"`.
- Tron has its own bucket, `"728126428"`, keyed by canonical lowercase `41…` hex (never
  `"*"`, which stays off Tron). It holds OFAC `sanctioned` rows and `token` rows only.
- `category` is one of `KNOWN_CATEGORIES` (`src/config.js`). `token` entries
  always carry an uppercase `symbol` and integer `decimals` (the build rejects
  token rows without them).
- `source` and `added` are required on every entry; `note` is optional.
- Output is deterministic: `"*"` first, then chain ids ascending, addresses
  sorted, one entry per line.

## 3. Refreshing

```bash
GITHUB_TOKEN=$(gh auth token) bun run data:build                 # fetch OFAC + registry
bun run data:build --ofac ~/Downloads/sdn.xml                    # use a local sdn.xml
GITHUB_TOKEN=$(gh auth token) bun run data:build --verify-sources # after editing curated.json
```

- Needs network: the OFAC SDN file (~30 MB) and the superchain registry via
  GitHub. `GITHUB_TOKEN` avoids GitHub API rate limits; if the API refuses, the
  build stops with a message and writes nothing.
- A truncated or unexpected OFAC download aborts the build (nothing written), and
  so does a 0x address under a `Digital Currency Address` tag the parser does not
  know yet (format drift, e.g. a new chain tag): extend the allowlist in
  `parseOfacXml`, then rebuild.
- Tron ids: the id's format decides, not the tag. Any checksum-valid base58check `T…` id
  (TRX, USDT, or another tag) is a Tron row. `TRX` is a Tron-only tag: anything under it that
  is not a valid `T…` (even a `0x`) is a skipped id, not drift. A `T`-shaped id failing the
  checksum, or a `41…` hex id, is skipped under any tag. Zero Tron ids aborts the build ("no Tron addresses
  found (format drift?)"). The report prints the Tron count, "OFAC Tron ids under other
  tags" and skipped `T…`/`41…` ids.
- `--verify-sources` is **mandatory after editing `data/sources/curated.json`**:
  it fetches each cited `source` URL and drops (and lists) every row whose page
  does not contain the address. If a cited page cannot be fetched at all, the
  build aborts and lists the URLs (nothing written): retry later or fix the
  source, so a transient outage never shrinks the dataset.
- The output is written to a temporary file, then renamed into place.
- The build prints a report: OFAC publish date, skipped OFAC ids, counts per
  source / chain / category, rejected rows, rows needing a source, delistings.
- CI never runs the build; it only tests the committed output.

## 4. Curation rules (`data/sources/curated.json`)

Each row: `{ chainId: "1" | "*" | "728126428" | …, address, label, category, source, added, symbol?, decimals?, note?, ofacDesignated? }`.

- Cite **official issuer / protocol pages only**, and the address must appear in
  the cited page. For JS-rendered pages, cite a raw/static file instead (e.g. the
  docs repo's markdown on raw.githubusercontent.com).
- Never use explorer label clouds (Etherscan & co.), Arkham, Nansen, or datasets
  under GPL, BUSL or non-commercial licences for new rows.
- **Disclosure:** 9 rows inherited from v1.1.0 (8 exchange hot wallets and the old
  Ronin bridge) still cite an explorer public label. They are kept pending an
  official source and marked `note: "needs official source"`; the build lists
  them on every run.
- Tron rows (chainId `"728126428"`): `address` is the `T…` form exactly as cited
  (checksum-verified; `41…` hex also accepted), written as `41…` hex. Category must be
  `token` ("tron: token rows only"). A curated row on an address the bucket already holds
  as OFAC is rejected ("curated conflicts with OFAC"), for `"*"` and Tron alike.
  `--verify-sources` looks for the `T…` form, case-sensitive.
- Curated rows **never** say `sanctioned` (category or label text). For a
  designated entity use its base category plus `ofacDesignated: "YYYY-MM-DD"`;
  the build marks it ` (OFAC SDN)` while it is on the current SDN file and
  ` (delisted from OFAC SDN)` once it leaves.
- `note: "needs official source"` marks legacy rows not yet re-sourced; the
  build keeps and lists them.

## 5. Sources & licenses

- **OFAC Specially Designated Nationals (SDN) list** —
  `https://sanctionslistservice.ofac.treas.gov/api/publicationpreview/exports/sdn.xml`.
  A work of the U.S. Government, public domain (17 U.S.C. §105). Every
  `Digital Currency Address` with a 0x id (ETH, USDT, USDC, ARB, BSC, ETC tags)
  becomes a `"*"` `sanctioned` entry; a checksum-valid Tron `T…` id becomes a
  `"728126428"` `sanctioned` entry keyed by `41…` hex.
- **ethereum-optimism/superchain-registry** —
  `https://github.com/ethereum-optimism/superchain-registry`
  (`superchain/extra/addresses/addresses.json` + `chainList.json`, read at main
  HEAD at build time; that commit's SHA is recorded in each entry's `source`).
  L1 bridge contracts of mainnet-parented OP chains. Used under the MIT License:

  ```text
  MIT License

  Copyright (c) 2023 Optimism

  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in all
  copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  SOFTWARE.
  ```

- **Hand-curated facts** (`data/sources/curated.json`) — public addresses copied
  from official pages, cited per entry in `source`, except the 9 inherited
  explorer-label rows marked `needs official source` (see §4).

## 6. Sanctions disclaimer

`sanctioned` comes only from the OFAC SDN file, as of the publish date in the
`"*"` entries' `source` ("OFAC SDN list, published YYYY-MM-DD"); a chain-specific
entry that becomes `sanctioned` appends the same text to its own `source`. It is
a dated snapshot of the last data rebuild, not a live feed: **verify against the
live SDN list before acting.**

## 7. `spam-tokens.json`

Token contracts (`0x…`) and symbols hidden by default as airdrop/spam noise.
Either a legacy array (treated as `"*"`) or a chain-keyed object:

```json
{ "*": ["<symbol>", "0x<contract>"], "<chainId>": ["0x<contract>"] }
```

Contracts apply per chain (`"*"` = every chain); symbols match globally. It
ships without contracts: no open, redistribution-safe spam-contract source
exists.

## 8. Known limitations

- **Imitation tokens:** a token is flagged when its symbol matches a curated
  `token` on that chain but its contract is not one of the curated ones. Legit
  but uncurated same-symbol contracts (e.g. Wormhole-wrapped USDC/WETH,
  PulseChain-bridged WETH/WBTC on Ethereum) are flagged too. The flag means "not
  the official contract for this symbol on this chain": a signal, not a verdict.
