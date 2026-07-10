# chainmap

[![CI](https://github.com/gl0bal01/chainmap/actions/workflows/ci.yml/badge.svg)](https://github.com/gl0bal01/chainmap/actions/workflows/ci.yml)

**English** · [Français](README.fr.md)

> **Map the blockchain.** Turn raw on-chain transactions into an interactive fund-flow
> graph — for OSINT investigators, journalists, and students learning how blockchains work.

Paste an address → chainmap fetches its transactions from the Etherscan v2 API and draws a
directed **address → address** graph, expanded breadth-first to a depth you choose. Then it
layers investigator tooling on top: filters, edge bundling, contract-call decoding, cycle
detection, sink/faucet hubs, and per-node risk scoring.

- **Fully client-side** — no backend, no build step, no telemetry.
- **Your API key and data stay in your browser.** The only site ever contacted is
  `api.etherscan.io`, enforced by a strict Content-Security-Policy.
- **English + French**, fully localized.
- **237 unit/integration tests** on the DOM-free core.

![chainmap graph view](docs/img/graph.png)

---

## Contents

- [Quick start](#quick-start)
- [Features](#features)
- [Learn how blockchains work](#learn-how-blockchains-work)
- [Architecture](#architecture)
- [Privacy, security & ethics](#privacy-security--ethics)
- [Development & tests](#development--tests)
- [Supported chains](#supported-chains)

---

## Quick start

Zero install — it's native ES modules.

```bash
git clone https://github.com/gl0bal01/chainmap.git && cd chainmap
python3 -m http.server 8000
# open http://localhost:8000/
```

**No API key?** Click **Demo mode** — it loads a bundled sample investigation so you can
explore every feature immediately.

**Live scans:** get a free key at <https://etherscan.io> → *API Keys*, paste it in the UI,
pick a chain, paste an address, **Start**. One key works across all supported chains
(Etherscan v2 is a unified multichain endpoint).

---

## Features

- **BFS expansion** — recurse from a root address to any depth, with a per-address sample
  size, a hard safety cap, and a **Stop** that truly aborts in-flight requests.
- **Three tx families** — normal, internal, and ERC-20/721/1155 token transfers, each a
  colored edge.
- **Calldata decoding** — 4-byte selectors → human method names + decoded leading args, so
  a `transfer()`'s real recipient (hidden in calldata) is surfaced.
- **Noise reduction** — amount/date/zero-value/spam filters, and edge bundling (collapse
  many A→B transfers into one weighted arrow).
- **Investigation overlays** — round-trip (cycle) detection, sink/faucet hubs, color-by-age,
  known-address labels, and an *explainable* per-node risk score.
- **Chain detector** — paste any address; it tells you the chain family (or non-EVM) before
  you scan.
- **Exports** — PNG, PDF, and CSV (with a sampling caveat baked in). Save/load workspaces.
- **Honest by design** — big-integer amounts (never floating point), failed txs dropped,
  and sampling surfaced everywhere.

---

## Learn how blockchains work

chainmap doubles as a **hands-on course**. Every blockchain concept — accounts, the three
transaction families, base units & decimals, calldata, token standards, BFS graphs,
sampling, failed txs, multichain, and investigation heuristics — maps to something you can
*see and do* in the tool, with **8 guided labs**.

📚 **[Full curriculum + labs → docs/LEARN.md](docs/LEARN.md)** · **[en français → docs/LEARN.fr.md](docs/LEARN.fr.md)**

---

## Architecture

Native ES modules, **no bundler**. The design principle: **`graphStore` is the single
source of truth.** Every mutation goes through it; it emits events; the render layer mirrors
it into vis-network DataSets by subscribing. Filters/overlays are a *display projection*
(vis `DataView`s) over that mirror, so the store always holds the full graph for CSV/detail
even when the view is filtered.

```
BFS scan ──► graphStore (truth) ──emits events──► render/network ──► vis DataViews ──► canvas
   ▲               │                                                       ▲
etherscanClient   ui.js / main.js (composition root)              filters · bundling · overlays
   ▲
rateLimiter
```

The correctness-critical core is **DOM-free and unit-tested in Node** (`format`,
`etherscanClient`, `graphStore`, `scanner`, `display`, `roundTrips`, `riskScore`, …). The
DOM/vis layer (`render/*`, `ui.js`) is thin. See [`INTERFACES.md`](INTERFACES.md) for the
frozen module contracts.

---

## Privacy, security & ethics

- **Nothing leaves your browser** except calls to `api.etherscan.io` — no backend, proxy,
  analytics, or third-party beacons. Verify it in DevTools → Network.
- **Vendored libraries** (`vis-network`, `jsPDF`) — no CDN — pinned with **Subresource
  Integrity**. A strict **CSP** limits `script-src` to `'self'` and `connect-src` to the
  Etherscan API.
- **No untrusted string reaches `innerHTML`** — aliases and API token symbols are rendered
  as DOM text nodes; the analysis is XSS-inert by construction.
- **OSINT ethics:** the graph is a **sample**, not proof. Public-chain data is pseudonymous,
  not anonymous, and not always what it seems (spoofed token names, dust attacks, exchange
  omnibus wallets). Label your limits; corroborate before you conclude.

---

## Development & tests

Tests are **dev-only** (they never run in production and aren't needed to use the app).

```bash
bun install     # dev deps only (happy-dom, playwright-core)
bun test        # 237 unit + integration tests
```

`bun test` covers the DOM-free modules (amount math, dedup keys, BFS guards, failed-tx
filtering, cycle detection, ABI decode, risk scoring, en/fr key parity, …) plus a happy-dom
integration test that drives the real `main.js` against a stubbed vis/fetch. CI runs the
suite and a vendor-integrity check (SRI + SHA-256) on every push.

---

## Supported chains

Ethereum · Sepolia (testnet) · BNB Chain · Polygon · Arbitrum One · Optimism · Base ·
Avalanche C-Chain · Fantom. Add one = a single entry in `src/config.js`.

## Credits

- Blockchain address-format patterns for the chain detector are adapted from **[gl0bal01](https://github.com/gl0bal01)**'s [`discord-osint-assistant`](https://github.com/gl0bal01/discord-osint-assistant).
- Graph rendering by [vis-network](https://github.com/visjs/vis-network);
- PDF export by [jsPDF](https://github.com/parallax/jsPDF).
- OiY for the idea ;)

## License

[MIT](LICENSE)
