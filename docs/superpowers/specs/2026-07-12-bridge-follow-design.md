# Bridge-follow (cross-chain lead tracing) — design

**Date:** 2026-07-12
**Status:** approved (design), pending implementation plan
**Scope:** one implementation plan (new pure module + registry + one UI panel; additive)

## Goal

When scanned funds touch a **known lock-mint bridge**, help the investigator
follow the value onto the destination chain: run a windowed scan on that chain,
correlate the bridge release, and surface ranked **candidate** release txs as
leads. The graph stays single-chain; results are a display projection, never a
store mutation, and are always labeled by confidence — never asserted as a
confirmed trace.

## Why bridge-follow (and its honest limits)

- Bridges are the #1 chain-hopping laundering step; investigators routinely lose
  the trail at a bridge. Following across is high-value.
- It only works on **lock-mint / canonical bridges** (Polygon PoS, Arbitrum,
  Optimism/Base standard, Ronin), where the deposit→release link is
  deterministic and the destination recipient is recoverable from calldata.
- It **breaks** on **liquidity-network bridges** (Across, Stargate, Hop): the
  release comes from an LP, not a 1:1 mint — the on-chain link is genuinely
  severed, like a mixer. These are registered but short-circuited with an honest
  "trace broken (liquidity pool)" message, not a fake match.

## What already exists (reuse, do NOT rebuild)

- `etherscanClient.js`: `setChainId(id)` (chain is mutable) and `fetchAction`
  accepting `startblock`/`endblock` → a **windowed dest-chain scan** is possible
  with a second client instance.
- `rateLimiter.js`: serialized req/s queue with cancellation — reuse for the
  dest scan.
- `selectors.js` + `abiDecode.js`: 4-byte selector table + head decoder — extend
  with bridge deposit selectors to recover the destination recipient from
  calldata.
- `knownAddresses.js` + `data/known-addresses.json`: already carry `bridge`
  category labels (Spec 1 expands them).

## Invariants preserved (non-negotiable)

- Pure, DOM-free logic (`bridgeFollow.js`) with Node (bun) tests; DOM/vis only in
  `render/*`, `ui.js`, `main.js`.
- **`graphStore` is the ONE source of truth and is NOT touched** — bridge-follow
  reads edges out, produces leads, and renders them in a side panel. No new node
  ids, no cross-chain nodes in the store. The canonical `address = node id, one
  chain` invariant is fully preserved.
- Strict CSP unchanged: dest-chain scan is the same `api.etherscan.io` host via
  `chainid` (Etherscan v2 unified endpoint); bridge registry is same-origin data.
- No untrusted string reaches `innerHTML` — addresses/labels/amounts via
  `textContent`/escaped.
- Sampling stays explicit: the dest scan is "latest N in window", surfaced with
  the same caveat as the main scan.
- i18n parity (en/fr) enforced by `test/locales.test.js`; logic emits
  `{key, params}`, `ui`+`i18n` render.

## Design

### 1. Bridge registry (`data/bridges.json`, path in `config.DATA_PATHS`)

Chain-scoped, keyed by lowercased bridge address:
```json
{
  "1": {
    "0x40ec5b33f54e0e8a33a975908c5ba1c14e5bbbdf": {
      "name": "Polygon PoS: ERC20 Bridge",
      "kind": "lock-mint",
      "destChains": [137],
      "depositSelector": "0x<verified-at-impl>",
      "recipientParam": "user"
    }
  }
}
```
> Selector values are illustrative here — each is computed/verified from the real
> bridge ABI during implementation and asserted by the selector test, never
> shipped from memory.
- `kind`: `"lock-mint"` (followable) | `"liquidity"` (registered, short-circuited).
- `destChains`: candidate destination chain ids (a bridge may fan to several).
- `depositSelector` / `recipientParam`: optional — when present, the dest
  recipient is decoded from calldata; when absent, fall back to the depositor
  (`edge.from`, i.e. the msg.sender who deposited).
- Loaded like `known-addresses.json`: async same-origin fetch, empty-on-failure,
  never throws.
- Adding a bridge = one entry (mirrors the "add a chain/selector = one row" rule).

### 2. New pure module `bridgeFollow.js` (DOM-free, Node-testable)

- `findBridgeExits(edges, registry, chainId)` → for each edge whose `to` is a
  known **lock-mint** bridge on `chainId`, emit an exit:
  `{ bridgeAddr, name, destChains, amountText, tokenSymbol, timeStamp,
     depositor, recipient }`.
  - `recipient` = decoded `recipientParam` arg (lowercased, validated) when
    available, else `depositor`.
  - Edges to **liquidity** bridges are returned separately (or tagged
    `kind:"liquidity"`) so the UI can show the "trace broken" note instead of
    offering a follow.
- `matchReleases(exit, destTxs, opts)` → given txs fetched on a dest chain,
  return ranked candidates:
  - **filter**: `to === exit.recipient` AND `timeStamp >= exit.timeStamp` (time
    must move forward) AND within `opts.windowSecs`.
  - **score / confidence label** (never "confirmed"):
    - `exact` — recipient match + amount within tight tolerance (e.g. ≤0.5%,
      accounting for bridge fees) + inside window.
    - `amount+time` — recipient + amount+time match but looser tolerance.
    - `weak` — recipient + window only (amount not comparable, e.g. token vs
      native).
  - Return `{ tx, confidence, matched:{recipient,amount,timeDeltaSecs} }[]`,
    sorted best-first. Pure — no fetching here.
- Amount basis reuses `display.edgeAmountNumber` / `amountText` (nominal
  per-token magnitude), consistent with `peelChain.js`.

### 3. Dest-chain scan (orchestration, `main.js`)

- On user "follow" for an exit: build a **second** `etherscanClient` bound to the
  chosen `destChain` (or `setChainId` on a throwaway client), run through the
  shared `rateLimiter`.
- **Windowed**: derive a `startblock` (or start time) from the exit `timeStamp`
  to bound the scan (e.g. exit block → +window); fetch the bridge counterpart /
  the recipient's inbound txs. Keeps API cost small and explicit.
- Feed results to `matchReleases`; render candidates. Count these as extra
  `apiCalls`, surfaced in the UI (no hidden network).

### 4. UI: "Bridge leads" panel (`ui.js` + `main.js` + `index.html`)

- After a scan, list detected bridge exits (from `findBridgeExits` over the
  store's edges). Each row: bridge name, amount, dest chain(s), timestamp.
- **Lock-mint** exit → a "Follow across bridge" action → runs the dest scan →
  shows ranked candidates with confidence + matched criteria + a
  block-explorer link (and optionally a one-click "re-root on dest chain" that
  switches `chainSelect` and starts a fresh scan there — still no store merge).
- **Liquidity** exit → shows the honest "trace broken (liquidity pool), no 1:1
  follow" note; no follow action.
- All strings via i18n keys; all addresses/amounts escaped. New keys added to
  both `locales/en.js` and `locales/fr.js`.

### 5. Selectors to add (`selectors.js`)

Bridge deposit selectors + `SELECTOR_PARAMS` recipient names, e.g.:
- Optimism/Base standard bridge `depositETHTo(address _to, uint32, bytes)` →
  `["recipient", ...]`.
- Optimism/Base `depositERC20To(address,address,address,uint256,uint32,bytes)`.
- Polygon PoS `depositEtherFor(address user)` / `depositFor(address user, …)`.
- Arbitrum `depositEth()` → recipient = msg.sender (no param; fall back to
  depositor).
Each new selector gets a `SELECTORS` signature and, where a leading static
recipient arg exists, a `SELECTOR_PARAMS` entry (so `abiDecode` and the CSV
`real_recipient` column keep working).

## Tests

- `test/bridgeFollow.test.js` (new):
  - `findBridgeExits` detects a lock-mint bridge edge, extracts decoded
    recipient, falls back to depositor when no `recipientParam`.
  - liquidity bridge edge → tagged/segregated, no follow candidate.
  - `matchReleases` — recipient filter, forward-time filter, window bound,
    amount tolerance tiers, confidence ordering, empty on no match.
  - **no store mutation** — module never imports/receives the store; assert it
    operates on plain edge arrays only.
- `test/selectors.test.js` (extend): every new `SELECTOR_PARAMS` key exists in
  `SELECTORS` with matching arity.
- `test/locales.test.js`: en/fr parity for new bridge-lead keys.
- Registry-validity test: `data/bridges.json` — lowercased keys, valid
  addresses, `kind ∈ {lock-mint, liquidity}`, `destChains` ⊂ `CHAINS` ids,
  `depositSelector` (if present) in `SELECTORS`.

## Seed data

- **Lock-mint (followable):** Polygon PoS bridge (1→137), Optimism standard
  bridge (1→10), Base standard bridge (1→8453), Arbitrum One inbox/gateway
  (1→42161), Ronin bridge (aligns with existing demo/known-address data).
- **Liquidity (registered, trace-broken):** Across, Stargate, Hop.

## Out of scope

- Merged multi-chain graph / composite node ids (rejected: rewrites the core
  invariant for marginal gain — can revisit later).
- Mixer (Tornado) deposit↔withdrawal correlation (probabilistic, weak signal —
  deliberately excluded).
- Following through liquidity-network bridges (honestly impossible 1:1).
- Automatic multi-hop bridge chaining (follow one hop; the user re-triggers).

## Risks

- **False-positive candidates.** Mitigated by confidence tiers + always showing
  the matched criteria; nothing is labeled "confirmed".
- **Bridge mechanics drift** (contract upgrades change selectors). Registry +
  selector table are one-line edits; an unknown selector degrades to
  depositor-based matching, never a wrong decode.
- **API cost** of the dest scan. Mitigated by windowing + explicit apiCall count
  + reuse of the rate limiter; the follow is user-initiated, not automatic.
