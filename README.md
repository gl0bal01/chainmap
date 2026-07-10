# chainmap

**Map the blockchain.** A single-page, **fully client-side** tool that turns raw
on-chain transactions into an interactive fund-flow graph — for OSINT investigators,
journalists, and **students learning how blockchains actually work**.

Paste an address → chainmap fetches its transactions from the Etherscan v2 API and
draws a directed **address → address** graph, expanded recursively (breadth-first) to
a depth you choose. Then it layers investigator tooling on top: filters, edge
bundling, contract-call detection, method/ABI decoding, cycle (round-trip) detection,
sink/faucet hubs, per-node risk scoring, and a paste-any-address chain detector.

- **No backend. No build step. No telemetry.** Three-ish static files + native ES modules.
- **Your API key and all data stay in your browser** (localStorage / memory). The only
  site ever contacted is `api.etherscan.io`. A strict Content-Security-Policy enforces it.
- **English + French**, fully localized.
- **~227 unit/integration tests** on the DOM-free core.

![chainmap graph view](docs/img/graph.png)

---

## Quick start

Zero install — it's native ES modules.

```bash
git clone https://github.com/gl0bal01/chainmap.git && cd chainmap
python3 -m http.server 8000
# open http://localhost:8000/
```

**Try it with no API key:** click **Demo mode** — it loads a bundled sample
investigation so you can explore every feature immediately.

For live scans, get a free key at <https://etherscan.io> → *API Keys*, paste it in the
UI, pick a chain, paste an address, **Start**. One key works across all supported chains
(Etherscan v2 is a unified multichain endpoint).

---

## Learn: how a blockchain works — using chainmap

This is a **hands-on curriculum**. Each concept below maps to something you can *see and
do* in the tool. Load **Demo mode** and follow along.

### 1. Accounts & addresses
An account on an EVM chain is identified by a 20-byte **address**, written as `0x` + 40
hexadecimal characters (e.g. `0x742d…B78a`). Two kinds:
- **EOA** (externally-owned account) — controlled by a private key (a person/wallet).
- **Contract account** — code that runs when called.

> **In chainmap:** every node is an address. Paste an address into *Address to analyze* —
> the **chain detector** under the field tells you instantly whether it's an EVM address
> (scannable here) or something else (Bitcoin, Solana, Tron…) and links you to the right
> explorer. Addresses are **lowercased** internally as their canonical id; the *label*
> you see (short form, your alias, or a known-address name) never changes that id.

### 2. Transactions — three families
chainmap fetches three kinds of activity (the three checkboxes):
- **Normal** transactions — an EOA sends a tx (value transfer and/or a contract call).
- **Internal** transactions — value moved *by contract code* during execution (not
  separate signed txs; reconstructed by the node's tracer).
- **Token transfers** — ERC-20 / ERC-721 / ERC-1155 movements (emitted as log events).

> **In chainmap:** each transfer becomes a directed **edge** from sender to receiver,
> colored by family (see the Legend). This is the core mental model: **a blockchain is a
> ledger of directed value movements**, and a graph is its natural shape.

### 3. Value, base units & decimals
Blockchains store amounts as **integers in the smallest unit** (wei for ETH: 1 ETH =
10¹⁸ wei). A token declares its own `decimals` (USDC uses 6). To show a human amount you
divide by `10^decimals` — using **big-integer math**, never floating point, or you lose
precision on large values.

> **In chainmap:** `formatUnits` does this with `BigInt`. If a token reports bad/missing
> decimals, the app flags the amount **“decimals unknown”** instead of silently showing a
> wrong number — an honesty rule that matters in forensics. Edge width is **weighted by
> amount**, so large flows are literally thicker.

### 4. Calldata & method selectors — *what* a transaction did
A transaction can carry **input data** (calldata). A plain ETH transfer has empty
calldata (`0x`). A contract call encodes: a **4-byte method selector** (first 4 bytes =
`keccak256("transfer(address,uint256)")[:4]` = `0xa9059cbb`) followed by ABI-encoded
arguments.

> **In chainmap:** edges whose tx carried calldata are drawn **dashed with a `✱`** — you
> can spot contract interactions at a glance. Click one: the details panel **decodes the
> selector** to its human signature and **decodes the leading arguments**. This is a big
> deal for investigators: a *normal* tx calling `transfer()` has its `to` set to the
> **token contract**, while the **real recipient** is hidden in the calldata — chainmap
> surfaces it.

### 5. Tokens — ERC-20 / 721 / 1155
- **ERC-20** — fungible tokens (USDC, DAI). `transfer(to, amount)`.
- **ERC-721** — NFTs; each has a unique `tokenId`.
- **ERC-1155** — multi-token; both fungible and non-fungible ids in one contract.

> **In chainmap:** token edges are deduplicated on a **precise key**
> (`action | hash | from | to | contractAddress | tokenID | logIndex`). Symbol is *not*
> part of the key — two different contracts can both call themselves “USDC”, and one
> ERC-1155 tx can move several token ids. Collapsing on symbol would merge distinct
> movements; chainmap keeps them separate.

### 6. The transaction graph & breadth-first expansion
Starting from your address (the **root**, red), chainmap looks at its counterparties,
then *their* counterparties, and so on — a **breadth-first search (BFS)** over the
address graph. *Recursion depth* controls how many hops out it goes. Node color encodes
depth.

> **In chainmap:** raise *Recursion depth* to widen the investigation. Guards keep it
> bounded and cheap: a per-address sample size, a hard **safety cap** on total addresses,
> and a **Stop** that truly aborts in-flight requests. Use **Estimate scan** first to
> predict API calls + time before a big run.

### 7. Sampling ≠ full history (the forensic caveat)
chainmap fetches the **latest N** transactions per address per type — **not** the
complete history. This keeps scans fast and cheap, but it means the graph is a **sample**.

> **In chainmap:** a persistent banner and the CSV export both state this. **Rule:** never
> present a sampled graph as complete or forensic. Increase the per-address limit if you
> need more, and always note the sampling in findings.

### 8. Failed & reverted transactions
A transaction can be *included in a block yet fail* (out of gas, a `revert`). It costs gas
but **moves no value**. Etherscan marks these (`isError = "1"`, `txreceipt_status = "0"`).

> **In chainmap:** failed txs are **dropped before drawing edges** — a reverted transfer
> must never appear as real money movement. (Try it: the demo drops a failed tx you can
> see excluded from the counts.)

### 9. The EVM & multichain
Ethereum, BSC, Polygon, Arbitrum, Optimism, Base, Avalanche, Fantom… are all
**EVM-compatible**: same address format, same tx model. They differ by **chain id**.
Etherscan v2 exposes them through **one endpoint**, selected by a `chainid` parameter.

> **In chainmap:** the *Chain* selector just changes `chainid`. Because every EVM chain
> shares the `0x`-40-hex format, an address alone **cannot** tell you which chain (or
> mainnet vs testnet) it belongs to — you need transaction context. The chain detector
> makes this limitation explicit.

### 10. Investigation heuristics (turning data into leads)
Real blockchains are noisy. chainmap encodes patterns investigators look for:
- **Amount / date / zero-value / spam filters** — cut noise to see the signal.
- **Edge bundling** — collapse many A→B transfers into one weighted arrow (“N tx, total X”).
- **Sink / faucet hubs** — addresses that mostly *receive* (sink) or mostly *send*
  (faucet), often exchanges/mixers/airdrops; de-emphasized so they don't dominate.
- **Round-trips (cycles)** — value that returns to where it came from (A→B→A, or longer
  loops) is a classic **layering / wash-trading** signal. Tarjan's SCC algorithm rings
  every address on a cycle.
- **Color by age** — old flows cool/dim → recent flows warm/bright, to read tempo.
- **Known-address labels** — a bundled local list names well-known contracts (WETH, USDC,
  routers) with **no network lookup**.
- **Per-node risk score** — an *explainable* triage number combining the above (on a
  cycle, hub, high degree, contract calls, known entity). Click a node to see the score
  **and every reason** — no black box.

![investigator overlays: cycle rings + weighted edges + legend](docs/img/overlays.png)

---

## Hands-on labs (for students)

Load **Demo mode**, then:

1. **Read the graph.** Identify the root (red). Follow the arrows — who sent to whom, and
   how much? Which edge is thickest, and why? (→ §2, §3)
2. **Find the contract call.** One edge is dashed with `✱`. Click it: what method was
   called? What were the decoded arguments? Why is a *value transfer* also a contract
   call? (→ §4)
3. **Spot the layering.** Turn on **Highlight round-trips**. Which addresses get an amber
   ring? Trace the cycle by hand. Why is a returning flow suspicious? (→ §10)
4. **Cut the noise.** Set a *Min amount*, toggle *Hide zero-value*, then **Bundle edges**.
   How does the readable signal change? (→ §10)
5. **Triage by risk.** Click each node and read its **Risk** row. Rank the addresses.
   Which would you investigate first, and what evidence drives that? (→ §10)
6. **Respect the sample.** Note the sampling banner. If this were real, what would you
   need to do before calling any conclusion complete? (→ §7)
7. **Detect the chain.** Paste a Bitcoin address (`1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa`)
   into the address field. What does chainmap tell you, and why can't it scan it? (→ §1, §9)
8. **Produce evidence.** Add a sticky note, export **PNG** and **CSV**. What does the CSV
   preserve that the picture doesn't? (→ export)

*Instructor tip:* build a small `data/demo-workspace.json` of a known incident and have
students reconstruct the story from the graph alone.

![chain detector + mobile](docs/img/detector.png)

---

## Architecture (for developers)

Native ES modules, **no bundler**. The design principle: **`graphStore` is the single
source of truth.** Every mutation goes through it; it emits events; the render layer
mirrors it into vis-network DataSets by subscribing. Filters/overlays are a *display
projection* (vis `DataView`s) over that mirror, so the store always holds the full graph
for CSV/detail even when the view is filtered.

The correctness-critical core is **DOM-free and unit-tested in Node**: `format`,
`etherscanClient`, `rateLimiter`, `graphStore`, `scanner`, `display`, `roundTrips`,
`sinkFaucet`, `selectors`, `abiDecode`, `riskScore`, `blockchainDetect`, `workspace`,
`dryRun`, `i18n`. The DOM/vis layer (`render/*`, `ui.js`) is thin. See
[`INTERFACES.md`](INTERFACES.md) for the frozen module contracts.

```
BFS scan ──► graphStore (truth) ──emits events──► render/network ──► vis DataViews ──► canvas
   ▲               │                                                       ▲
etherscanClient   ui.js / main.js (composition root)              filters · bundling · overlays
   ▲
rateLimiter
```

---

## Privacy, security & ethics

- **Nothing leaves your browser** except calls to `api.etherscan.io` — no backend, proxy,
  analytics, or third-party beacons. Verify it yourself in DevTools → Network.
- **Vendored libraries** (`vis-network`, `jsPDF`) — no CDN. A strict **CSP** limits
  `script-src` to `'self'` and `connect-src` to the Etherscan API.
- **No untrusted string reaches `innerHTML`** — aliases and API-supplied token symbols are
  escaped / rendered as DOM text nodes; the analysis is XSS-inert by construction.
- **OSINT ethics:** the graph is a **sample**, not proof. Public-chain data is
  pseudonymous, not anonymous, and not always what it seems (spoofed token names, dust
  attacks, exchange omnibus wallets). Label your limits; corroborate before you conclude.

---

## Development & tests

Tests are **dev-only** (they never run in production and aren't needed to use the app).

```bash
bun install     # dev deps only (happy-dom, playwright-core)
bun test        # ~227 unit + integration tests
```

`bun test` covers the DOM-free modules (amount math, dedup keys, BFS guards, failed-tx
filtering, cycle detection, ABI decode, risk scoring, en/fr key parity, …) plus a
happy-dom integration test that drives the real `main.js` against a stubbed vis/fetch.

## Supported chains

Ethereum · Sepolia (testnet) · BNB Chain · Polygon · Arbitrum One · Optimism · Base ·
Avalanche C-Chain · Fantom. Add one = a single entry in `src/config.js`.

## Credits

Blockchain address-format patterns for the chain detector are adapted from
**[gl0bal01](https://github.com/gl0bal01)**'s
[`discord-osint-assistant`](https://github.com/gl0bal01/discord-osint-assistant) (`blockchain-detect.js`).
Graph rendering by [vis-network](https://github.com/visjs/vis-network); PDF export by
[jsPDF](https://github.com/parallax/jsPDF).

## License

[MIT](LICENSE) © 2026 gl0bal01.
