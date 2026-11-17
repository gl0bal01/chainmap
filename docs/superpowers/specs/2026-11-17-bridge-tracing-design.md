# Bridge tracing, inferred + confidence (P7) — design

Status: program P7 (owner-approved program contract, 2026-11-16/17) · builder-checked (rulings below)

## Intent

Bridges are where most traces stop: funds go into a bridge contract on one chain and come out
somewhere else. chainmap already labels 271 known bridge contracts (`category: "bridge"`) and
can hold several chains in one graph. This feature reads those facts and **proposes** where a
bridge deposit may have come out: a transfer on another chain, to the expected recipient,
after the deposit, for the same asset and a matching amount. Each proposal is an **inferred
link** with a confidence level and its evidence, drawn distinctly and labelled
**"inferred — verify"**. Only the investigator can confirm or reject it, and that decision is
recorded as **the investigator's assertion**, never as an on-chain fact.

**Who benefits:** investigators following funds across chains, compliance analysts, teachers
explaining how bridges work.

## Goals

1. Detect **bridge deposits**: a fetched value transfer into a known bridge contract.
2. Name the **expected recipient** on the other side: decoded from the deposit call when the
   function is a known bridge function, else assumed to be the depositor's own address (a
   weaker basis, said so).
3. Let the investigator **look for the release** on a chosen chain with one click (one page of
   the recipient's transactions through the existing load path, logged in the query log).
4. Propose **candidate releases** found in the loaded data, each with a confidence level
   (`low` / `medium` / `high`) computed from observed factors, and the evidence behind it.
5. Draw each candidate as a distinct dashed overlay link between the depositor (chain A) and
   the recipient (chain B), labelled "inferred — verify"; never a store edge.
6. **Investigator decisions**: confirm / reject / clear per candidate, saved in the workspace,
   labelled as an investigator assertion everywhere they appear (details, CSV, PNG/PDF, evidence
   MANIFEST, workspace).
7. en + fr.

## Non-goals

- Deterministic cross-chain proof (OP Stack `messageNonce`, Arbitrum `requestId`, Polygon
  `stateId`, `getLogs` by message id). See "Lessons from a5daa41".
- Automatic destination-chain scans. Every destination request is a click.
- Following swaps across a bridge (deposit USDC, receive ETH), multi-hop bridge chains, or
  non-EVM destinations.
- A per-bridge metadata table (destination chain, bridge type, delay window per contract).
- Growing the bridge dataset (curation rules of the known-address pipeline still apply).

## Anti-goals (failure even if it "works")

- Any computed tier that reads as proof: no "confirmed", "exact", "match", "verified",
  "traced" or "followed" wording for a computed result. The top level is `high` and it is
  always shown with "inferred — verify".
- An inferred link that looks like a fetched edge (solid line, edge colour, CSV edge row, store
  record, BFS expansion through it).
- The recipient fallback (depositor's own address) raising confidence on its own.
- A unique-looking candidate when the sample cannot show it is unique.
- An investigator decision shown without saying it is the investigator's.
- A destination request the user did not click, or one that bypasses `makeClient` (unlogged).
- Value math with `Number`; mutating `graphStore`; dormant/unwired engine code.
- Breaking `flag.bridge` (the existing risk flag must keep firing on bridge-bound calls).

## Constraints

House invariants (program contract): buildless, client-side; pure logic DOM-free and
unit-tested; DOM only in ui.js/render/main.js; store is the single source of truth; display
projections never mutate it; honesty about sampling; BigInt amounts; i18n parity; node id
`chainId:address`; workspace stays **v3** (one new optional field, sanitised); no new deps;
**no new hosts** (Etherscan v2 only, through `makeClient`; CSP unchanged); textContent only
for untrusted strings.

## Lessons from a5daa41 (the reverted bridge-follow engine)

| What went wrong | How this design prevents it |
|---|---|
| Recipient fallback (depositor) + amount/time window produced coincidences labelled `exact`. | No computed tier ever says exact/confirmed. The fallback basis caps the level at `low` unless an independent observation (release sender is a known bridge or a token mint) supports it, and even then at `medium`. `high` needs a decoded recipient. |
| A heuristic was allowed a confirmed-like tier. | Only the investigator confirms, by a click, stored as `{decision, at}` and rendered as "confirmed by the investigator — an assertion, not on-chain proof". |
| Deterministic linkage rested on live-API facts never proven (free-tier gating for OP/Base, `getLogs` by id, legacy nonce after dynamic bytes). | Not built. No new endpoint, no new param key. Every fact this design cannot prove without a live key (how Etherscan shows a release, chain gating, contract aliasing) can only remove a supporting factor or a candidate, never add one (table below). |
| Polygon PoS has no client-side deterministic link. | No bridge is treated as deterministic; Polygon is handled by the same observed factors (a mint of the bridged token is an observation, not a proof). |
| Unreliable code was left unwired, inviting misuse. | Everything ships wired end to end (detect → look → infer → draw → details → decide → CSV / PNG / PDF / MANIFEST / workspace) with integration tests. No exported function without a caller. |
| `Number(amountText)` tolerance math. | Exact BigInt cross-multiplication over raw base units and decimals. |
| One shared client re-pointed to the destination chain. | A fresh client per operation via `makeClient` (existing pattern), so the query log records it. |
| Liquidity bridges either short-circuited or matched like lock-mint. | A release lower than the deposit by at most 3 % is a candidate, worded "consistent with a bridge fee — or an unrelated transfer", and capped at `medium`. Swaps are not proposed. |
| Sampling not stated. | Candidates come only from loaded data; uniqueness requires the recipient's sample to reach back to the deposit time; details and docs say so. |

**Unproven live-API facts and their only possible effect:**

| Fact we cannot verify without a key | Effect if it is not as hoped |
|---|---|
| How Etherscan lists a canonical release on the destination (internal tx from the L2 bridge, special deposit tx, token mint from `0x0`). | The "release sender" factor is absent → lower confidence, never higher. |
| Free-tier keys may be refused on some chains (`plan_required`). | The Look request fails with the existing error; no candidate. |
| Arbitrum aliases a contract depositor's address on L2. | The assumed recipient is wrong → no candidate. |
| A bridge function's recipient argument position (from the official ABI). | A wrong decode searches the wrong address → no candidate (and the decoded value must be a valid non-zero address). |

## Approaches considered

| | Approach | Verdict |
|---|---|---|
| **A** | **Pure inference over loaded store data + a user-initiated "Look for the release on {chain}" that reuses the existing one-page load path** | **Chosen**: no new fetch code, every request logged, sampling explicit, testable |
| B | Automatic windowed scan of the destination on deposit detection (the old `followBridgeExit`) | Rejected: hidden, unbounded API cost; a time window needs `module=block&action=getblocknobytime`, a new endpoint whose params are not in the P5 query-log schema |
| C | Deterministic shared-id verification | Rejected: rests on the unproven facts above; per-bridge constants forever; Polygon impossible |
| D | Per-bridge metadata table (destination, lock-mint vs liquidity, delay) | Rejected for v1: 271 rows to curate and keep current; the observed amount relation already separates fee-taking bridges, and the destination chain is decoded from the call where the function carries it |

## Design

### Bridge functions (`src/selectors.js`)

Add these entries to `SELECTORS` (signatures verified 2026-11-17 with Node's OpenSSL
`keccak-256`: `node -e 'require("crypto").createHash("keccak-256").update(SIG).digest("hex").slice(0,8)'`)
and to `SELECTOR_PARAMS`. **The destination recipient is named `destRecipient` and the
destination chain `destChainId`, never `recipient`**: `recipient` drives `flag.hiddenRecipient`,
`resolvedRecipient` (and so `flag.bridge`) and the CSV `real_recipient` column, which must keep
describing the same-chain call.

| Selector | Signature | Params (leading static) |
|---|---|---|
| 0x9a2ac6d5 | depositETHTo(address,uint32,bytes) | destRecipient, minGasLimit |
| 0x838b2520 | depositERC20To(address,address,address,uint256,uint32,bytes) | l1Token, l2Token, destRecipient, amount, minGasLimit |
| 0xe11013dd | bridgeETHTo(address,uint32,bytes) | destRecipient, minGasLimit |
| 0x540abf73 | bridgeERC20To(address,address,address,uint256,uint32,bytes) | localToken, remoteToken, destRecipient, amount, minGasLimit |
| 0xa3a79548 | withdrawTo(address,address,uint256,uint32,bytes) | l2Token, destRecipient, amount, minGasLimit |
| 0xb1a1a882 | depositETH(uint32,bytes) | minGasLimit |
| 0xd2ce7d65 | outboundTransfer(address,address,uint256,uint256,uint256,bytes) | token, destRecipient, amount, maxGas, gasPriceBid |
| 0x4fb1a07b | outboundTransferCustomRefund(address,address,address,uint256,uint256,uint256,bytes) | token, refundTo, destRecipient, amount, maxGas, gasPriceBid |
| 0x439370b1 | depositEth() | — |
| 0x4faa8a26 | depositEtherFor(address) | destRecipient |
| 0xe3dec8fb | depositFor(address,address,bytes) | destRecipient, rootToken |
| 0xce0b63ce | depositETH(address,uint256,uint256) | destRecipient, amount, gasLimit |
| 0xf219fa66 | depositERC20(address,address,uint256,uint256) | token, destRecipient, amount, gasLimit |
| 0x7b939232 | depositV3(address,address,address,address,uint256,uint256,uint256,address,uint32,uint32,uint32,bytes) | depositor, destRecipient, inputToken, outputToken, inputAmount, outputAmount, destChainId, exclusiveRelayer, quoteTimestamp, fillDeadline, exclusivityDeadline |
| 0xdeace8f5 | sendToL2(uint256,address,uint256,uint256,uint256,address,uint256) | destChainId, destRecipient, amount, amountOutMin, deadline, relayer, relayerFee |
| 0xeea0d7b2 | swapAndSend(uint256,address,uint256,uint256,uint256,uint256,uint256,uint256) | destChainId, destRecipient, amount, bonderFee, amountOutMin, deadline, destinationAmountOutMin, destinationDeadline |
| 0x01e4f53a | relayTokens(address,uint256) | destRecipient, amount |
| 0xad58bdd1 | relayTokens(address,address,uint256) | token, destRecipient, amount |
| 0x522ea81a | bridgeToken(address,uint256,address) | token, amount, destRecipient |

(OP Stack standard bridge, Arbitrum gateway router/inbox, Polygon PoS RootChainManager, Scroll
gateways, Across SpokePool v3, Hop, Gnosis xDAI bridge / Omnibridge, Linea token bridge.) A test
asserts no bridge entry names a param `recipient`, and that `flag.bridge` still fires for a
`depositETHTo` call into a known bridge.

### Pure module `src/bridgeInfer.js` (new, DOM-free)

```
inferBridges(nodes, edges, ctx) → { deposits: Map<edgeKey, BridgeDeposit>, candidates: BridgeCandidate[] }
  ctx = { known(address, chainId) → KnownEntry|null,
          ignoreEdge(edge) → boolean,              // imitation-token or spam-list edge (main: same as deposits)
          trustedToken(contract, chainId) → boolean,// known `token` category on that chain
          nativeSymbol(chainId) → string|null }     // CHAINS[…].native
BridgeDeposit = { key, chainId, from, fromId, bridge, bridgeLabel, hash, timeStamp, value, decimals,
                  asset, recipient: string|null, basis: 'calldata'|'sender'|null, destChainId: string|null }
BridgeCandidate = { id /* `${depositKey}>${releaseKey}` */, depositKey, releaseKey,
                    a /* deposit.fromId */, b /* release.toId */,
                    delaySec, amount: 'equal'|'fee', feeBps, sender: 'bridge'|'mint'|'other', senderLabel,
                    basis, trusted: boolean, forDeposit: n, forRelease: m, covered: boolean,
                    level: 'low'|'medium'|'high' }
sanitizeBridgeDecisions(raw, hasEdgeKey) → { decisions: Map<id, {decision:'confirmed'|'rejected', at}>, invalid }
```

Constants in the module: `MAX_DELAY_SEC = 14 * 86400`, `MAX_FEE_BPS = 300`,
`VALUE_ACTIONS = txlist, txlistinternal, tokentx`.

**Deposit** — a store edge E is a bridge deposit iff all hold:
1. `E.action` ∈ `VALUE_ACTIONS`, `BigInt(E.value) > 0n` (unparseable → no), not `ignoreEdge(E)`,
   decimals known (`usdPrice.decimalsFor`, reused).
2. `known(E.to, E.chainId).category === "bridge"`.
3. `E.from` is not itself a known `bridge` on `E.chainId` and is not the zero address
   (bridge plumbing and mints are not user deposits).

**Recipient** (first that applies):
- `calldata`: a `txlist` edge in the store with the same `chainId` and `hash`, `from === E.from`,
  whose `to` is a known bridge on that chain, and whose `decodeCall(rawInput)` (decoded from
  `rawInput`, never from stored `methodArgs`) has a `destRecipient` that is a valid, non-zero
  address → that address. Its `destChainId`, when present and a `CHAINS` id, is kept.
- `sender`: else, if `E.from` is not a known entity on `E.chainId` (any category) → `E.from`.
- else `recipient = null`, `basis = null` (sent via a known contract: no candidate; the details
  row says so).

**Candidate** — a store edge R is a candidate release for deposit D iff all hold:
1. `R.chainId !== D.chainId`; if `D.destChainId` is set, `R.chainId === D.destChainId`.
2. `R.to === D.recipient` (lowercased address), `R.from !== R.to`.
3. `R.action` ∈ `VALUE_ACTIONS`, value > 0, decimals known, not `ignoreEdge(R)`.
4. Timing: `0 <= R.timeStamp - D.timeStamp <= MAX_DELAY_SEC` (decimal-digit timestamps only).
5. Asset: `assetSymbol` equal, or one is `W` + the other where the other is a native symbol
   (ETH ↔ WETH). `assetSymbol` = the chain's native symbol for txlist/txlistinternal; for
   tokentx the known token's curated `symbol` when the contract is a known `token` on that
   chain, else the edge symbol; uppercased.
6. Amount (BigInt, raw values cross-multiplied by `10^decimals` of the other side):
   `equal` when `r == d`; `fee` when `r < d` and `r * 10000 >= d * (10000 - MAX_FEE_BPS)`;
   otherwise not a candidate. `feeBps = floor((d - r) * 10000 / d)`.

**Factors** (all observed):
- `sender`: `bridge` when `known(R.from, R.chainId).category === "bridge"`; `mint` when
  `R.from` is the zero address and `R.action === "tokentx"`; else `other`.
- `trusted`: both assets are native or a `trustedToken` on their chain.
- `forDeposit` = candidates of D; `forRelease` = deposits R is a candidate for.
- `covered`: node `R.toId` has `history`, and for every action the release asset can arrive by
  (native: `txlist` **and** `txlistinternal`; token: `tokentx`) the entry exists and is `done`,
  or the node has an edge of that action with `timeStamp <= D.timeStamp`. (The sample reaches
  back to the deposit, so another candidate cannot hide in unloaded history.)
- `unique` = `forDeposit === 1 && forRelease === 1 && covered`.

**Level** (first that holds):
- `high`: `unique && trusted && amount === 'equal' && basis === 'calldata' && sender !== 'other'`.
- `medium`: `unique && trusted && (basis === 'calldata' || sender !== 'other')`.
- `low`: every other candidate.

So: the depositor fallback alone is `low`; ambiguity (either side) or an uncovered window is
`low`; a fee-reduced amount is at most `medium`; an untrusted asset is `low`.

**Decisions** (`sanitizeBridgeDecisions`, the workspace trust boundary): input must be an array of
at most `LIMITS.bridgeDecisions` (5000) items; each is rebuilt from scratch from
`{deposit, release, decision, at}`: `deposit`/`release` strings ≤ 300 chars starting with
`^\d+\|`, both `hasEdgeKey`; `decision` ∈ `confirmed | rejected`; `at` a real UTC ISO-8601
instant (reuse the query-log validator), normalised to `toISOString()`. Anything else is
dropped and counted in `invalid`; first occurrence of an id wins; non-array → empty.

### Wording (en; fr natural equivalents)

- Link label: **"inferred — verify"**; a confirmed link: **"confirmed by investigator"**.
  Tooltip adds the level: "Inferred bridge link ({level}) — not proof".
- Legend rows: "Inferred bridge link — verify" and "Bridge link confirmed by the investigator".
- Link details ("Inferred bridge link — verify"):
  - "Confidence: {level} — inferred from amount, timing and recipient; not proof"
  - "Deposit: {amount} {symbol} into {bridge} on {chainA}" + tx link (chain A explorer)
  - "Possible release: {amount} {symbol} to {recipient} on {chainB}" + tx link (chain B explorer)
  - "Delay: {duration}" (reuse `delayParts`)
  - "Amount: equal" | "Amount: release is {pct}% lower — consistent with a bridge fee, or an unrelated transfer"
  - "Recipient: decoded from the deposit call" | "Recipient: assumed to be the depositor's own address (not decoded) — this alone never raises confidence"
  - "Release sender: {label} (a known bridge on {chainB})" | "Release sender: token mint (zero address)" | "Release sender: not a known bridge"
  - "Asset: not in the curated token list — confidence kept low" (only when not trusted)
  - "{n} candidate releases for this deposit" / "This release also fits {m} other deposits" (only when > 1)
  - "The loaded transactions of the recipient on {chainB} do not reach back to the deposit time — load older to look further" (when not covered) + a Load older button for that node
  - Decision line: "Not reviewed" | "Confirmed by the investigator on {at} UTC — an investigator assertion, not on-chain proof" | "Rejected by the investigator on {at} UTC"
  - Buttons: "Confirm (investigator)", "Reject", "Clear decision" (disabled states obvious)
  - Footer: "Inferred links are leads to verify on both explorers, never proof."
- Deposit edge row ("Bridge deposit") in `renderEdgeDetails` for an edge in `deposits`:
  - "Deposit into a known bridge: {label}"
  - recipient line (decoded / assumed / "unknown — sent via a known contract")
  - "Destination chain named in the call: {chain}" (when decoded)
  - one line per candidate: "{level} · {chainB} · {status}" with an "Open" button (opens the
    link details, also for rejected ones, which are not drawn)
  - or "No candidate release in the loaded data. Candidates come only from transactions already loaded on other chains."
  - "Look for the release on [chain select] [Look]" — the select lists `CHAINS` except the
    deposit's chain and chains where the recipient is already loaded; default = `destChainId`
    when decoded, else probe order. Hidden when `recipient` is null.

### Wiring (main.js / render / ui)

- `main.js` keeps `bridgeState = {deposits, candidates}` recomputed in the same coalesced store
  subscription as `recomputeDeposits` (and after known/spam data loads); nothing before the
  known-address data has loaded (no bridge is known, so nothing is detected). Never stored.
- `bridgeDecisions: Map` (session): set by Confirm/Reject (`at = new Date().toISOString()`),
  removed by Clear; cleared on reset and demo load, replaced on workspace load. Serialized
  (optional top-level `bridgeDecisions` array) for every decision whose two edges still exist.
  A decision is displayed/exported only while its pair is a current candidate; otherwise it is
  kept (no silent loss of investigator work if known data loads late).
- **Look**: `lookForRelease(depositKey, chainId)` → if the recipient node exists on `chainId`,
  `loadOlderFor(thatId)`; else add it (`depth = depositor.depth + 1`, not a root, no alias) and
  run the same body as `loadOnChain` (extract a shared helper; `loadOnChain` keeps its exact
  behaviour and tests). Same busy/refusal rules, same logs; requests via `makeClient`.
- `render/network.js`: generalize the twin overlay so the exclusions (edge view filter,
  restyle, visible-node computation, bundle building) test an `overlay` flag carried by both
  `twin:` and `bridge:` items (twin behaviour unchanged). New `GraphView.setBridgeLinks(links)`
  with `links = [{id, a, b, level, decision}]` (main passes candidates not rejected, when the
  toggle is on). Item id `bridge:${id}`, dashed, one colour distinct from every edge group and
  the twin grey (a second colour for confirmed), curved so it does not hide a twin link between
  the same nodes, `physics:false`, label/tooltip as above. `getBridgeLinks()` for exports.
  `interaction.selectHighDegree` ignores `bridge:` ids as it does `twin:`; selecting one never
  breaks prune.
- Toggle `#bridgeToggle` "Inferred bridge links" (checked by default) next to the twin toggle;
  workspace `filters.showBridges` kept only if boolean (like `showTwins`).
- `showEdgeDetails`: a `bridge:` item → `ui.renderBridgeDetails(container, data, deps)`
  (`currentDetail = {kind:"bridge", id}` so rerenders and "Open" from the deposit row work even
  for rejected candidates).
- `riskFlags.js`, `riskScore.js`: unchanged.

### Exports / evidence

- **CSV**: one column `bridge_inferred` appended **after** `usd_value` (every existing position
  unchanged). Edge rows only. Deposit row: `release=<chainId>:<hash>;to=<addr>;confidence=<level>;status=<unreviewed|confirmed-by-investigator|rejected-by-investigator>`;
  release row: `deposit=<chainId>:<hash>;from=<addr>;confidence=<level>;status=<…>`; several
  joined with ` | `. Written regardless of the toggle (like deposit marks). When any row has one,
  line 1 gains `; bridge_inferred lists inferred bridge candidates (amount/time/recipient) - not facts - and confirmed-by-investigator is the investigator's assertion - not on-chain proof`.
- **PNG/PDF**: `renderExportCanvas`/`exportPng`/`exportPdf` accept `bridgeLinks?: [{a, b, label, confirmed}]`
  (main passes `getBridgeLinks()` while the toggle is on), drawn with the live style; when any is
  drawn, the footer gains one line: "Dashed bridge links are inferred candidates — verify; 'confirmed by investigator' is the investigator's assertion."
- **MANIFEST** (`buildManifest` input `bridges`): `bridges = {note, candidates, low, medium, high, confirmedByInvestigator, rejectedByInvestigator}`
  when any candidate is displayed or any decision applies, else `null`; plus `BRIDGE_CAVEAT` in
  `caveats` in that case. The bundle's `workspace.json` carries the decisions.
- **Workspace** stays v3: optional top-level `bridgeDecisions: [{deposit, release, decision, at}]`;
  `parseWorkspace` returns `bridgeDecisions` (via `sanitizeBridgeDecisions` with the parsed
  graph's edge keys) and `bridgeDecisionsInvalid`. A file without it loads with none.

### i18n

New keys (en+fr) under `bridge.*`, `details.bridge*`, `legend.bridge*`, `filters.bridges`,
`btn.bridge*`, `log.bridge*` as needed; builder names them. Natural French (e.g. "déduit — à
vérifier", "confirmé par l'enquêteur").

### Demo

Add an illustrative, labelled-as-such cross-chain example to `data/demo-workspace.json`:
- chain 1: exploiter → Polygon PoS `RootChainManager` (`0xa0c6…7c77`, known bridge), 20 ETH,
  `depositEtherFor(address)` with `rawInput` encoding a fresh illustrative recipient
  `0xf00d…0005`;
- chain 137: `0x0000…0000` → `0xf00d…0005`, 20 WETH (known 137 WETH contract), tokentx,
  30 minutes later; node `137:0xf00d…0005` with `history` done for txlist/txlistinternal/tokentx.
This yields one `high` candidate (decoded recipient, mint sender, equal amount, unique, covered).
The existing 30 ETH deposit into `0x40ec…` keeps no candidate, so the demo also shows the
"Look for the release" row. Update the demo annotation text to say the bridge example is
illustrative.

## Tests

- `test/bridgeInfer.test.js`: deposit detection (native, token, internal; NFT/zero/ignored/
  bridge-to-bridge/zero-address excluded); recipient (calldata via same-hash txlist into a known
  bridge; never from `methodArgs`; never from a `recipient`-named arg; a non-bridge target's
  calldata ignored; known-entity depositor without calldata → null); every candidate filter and
  its boundary (same chain, `destChainId` contradiction, timing 0 and exactly 14 d, 6 vs 18
  decimals beyond 2^53, fee 3.00 % in / 3.01 % out, larger release out, ETH↔WETH, symbol
  mismatch out); each level's conditions and each cap (fallback alone, ambiguity each side,
  uncovered, fee, untrusted); level never outside `low|medium|high`; inputs not mutated;
  `sanitizeBridgeDecisions` (bad decision/at/key, unknown edge, `__proto__`, cap, duplicates).
- selectors (new entries, `destRecipient` naming guard); riskFlags (`flag.bridge` still fires,
  no `flag.hiddenRecipient` for bridge calls).
- workspace round trip with `bridgeDecisions`; v3 unchanged; old file → none.
- export: CSV column/caveat; canvas bridge links + footer; MANIFEST block + caveat.
- ui: `renderBridgeDetails` and the deposit row (textContent only, buttons call handlers).
- network: `setBridgeLinks` items, rejected not drawn, overlay exclusions, twins unchanged.
- Integration (shared harness): demo load draws the `high` link; confirm → label + CSV status +
  saved workspace carries the decision; reject → link gone, still openable from the deposit
  row; workspace reload restores it; Look with a stubbed fetch logs the query and produces the
  candidate; pruning the recipient removes the link; toggle off hides links and PNG/PDF omit them.

## Left to the builder

i18n key names; exact colours/dash pattern (distinct, legible in both themes); CSS; exact
recompute call sites (must not go stale — tested); the shared helper extracted from
`loadOnChain`; demo hashes/amounts.

## Owner decisions applied

- Bridges: YES, inferred + confidence; drawn distinctly, "inferred — verify", never as fact;
  investigator confirms/rejects (program contract, binding).
- No new hosts (Etherscan v2 through `makeClient` only); no new deps; workspace v3.
- Merge to local main only; no push/tag/release; no version bump.

## Builder-check rulings

Builder check (sonnet), answered by the lead:

1. **Look loads the full value set.** `lookForRelease` loads `txlist`, `txlistinternal` and `tokentx`
   for the recipient on the chosen chain whatever the form checkboxes say (the shared load helper takes
   an explicit `types`; `loadOnChain` keeps passing `formTypes()`). Without all three, `covered`, the
   `mint` factor and `high` are unreachable. *Cost if wrong:* up to three requests per click (the same
   as a default load, where all three boxes are ticked).
2. **Decisions never change a computed level.** `inferBridges` takes no decisions: a rejected candidate
   still counts in `forDeposit` / `forRelease`, and confirming one candidate leaves the others as they
   are. The computed level is a function of fetched data only; the investigator's assertion is a
   separate layer. The details say "{n} candidates ({r} rejected by the investigator)". *Cost if
   wrong:* a candidate stays `low` after its decoy is rejected; the investigator can still confirm it.
   Never a false strength.
3. **One candidate per release transaction.** When several edges of the same release transaction
   (`chainId` + `hash` + recipient) qualify for a deposit (e.g. listed in two actions, or two equal
   mints), they form one candidate: the edge with the smallest edge key. `forDeposit` and `forRelease`
   count distinct transactions (`chainId` + `hash`) on the other side. *Cost if wrong:* two distinct
   transfers in one transaction show as one candidate — a lead lost, never a false one.
4. **Look on a chain where the recipient is already loaded = load older there.** The chain select lists
   every `CHAINS` entry except the deposit's chain (probe order, `destChainId` first when decoded). If the
   recipient node exists on the chosen chain, Look runs `loadOlderFor` on it with the full value set
   (first page if it was never fetched, else the next older page); otherwise it adds the node and loads
   one page. The "load older" button on an uncovered candidate calls the same function. *Cost if
   wrong:* none — one function, two callers.
5. **Internal-tx deposits keep `E.from` as depositor.** A deposit made by a contract (router,
   aggregator, smart wallet) uses that contract as depositor: a known entity → no recipient; an
   unknown contract → `sender` basis (at most `low` unless the release sender is a bridge/mint, then
   `medium`). No hash walk back to the EOA: a router may pay out anywhere. *Cost if wrong:* deposits
   through routers rarely get candidates — leads missed, never invented. Stated as a limitation.

## Plan-contact rulings (lead)

Raised by the planner on contact with the code; these amend the design above.

6. **Who may be assumed to receive (`sender` basis).** `recipient = null` only when the depositor is a
   known entity that acts for others on that chain: category `exchange`, `router`, `bridge`, `mixer`
   or `token`. Any other depositor, including a known `sanctioned` actor, gets the `sender` basis. So the
   demo's existing 30 ETH deposit (Ronin exploiter → `0x40ec…`) gets a recipient and the Look row.
   Copy for null: "Recipient unknown — the depositor is a known {category} that may act for others;
   none is assumed." *Cost if wrong:* a sanctioned contract's deposit is searched at its own address
   (`low` at most, unless a bridge/mint sender supports it).
7. **`covered` uses the recipient's own sample only.** Per required action: the node's `history` entry
   exists and is `done`, or an incident edge of that action with `timeStamp <= D.timeStamp` lies inside
   the node's own fetched window (`blockNumber >= entry.oldestBlock`, compared as integers). An edge
   that only came from a counterparty's page never proves coverage. *Cost if wrong:* none — stricter.
8. **ETH ↔ WETH.** "The other is a native symbol" means the native symbol of the other edge's own
   chain. *Cost if wrong:* a wrapped native of another chain is never paired (lead missed).
9. **MANIFEST / caveat trigger.** `bridges` + `BRIDGE_CAVEAT` whenever a current candidate exists or a
   decision applies to one, whatever the toggle (the CSV lists candidates regardless). Rejected
   candidates count in `candidates`, in their level and in `rejectedByInvestigator`. *Cost if wrong:*
   none.
10. **Decision ids follow ruling 3's representative edge.** If a smaller-keyed edge of the same release
    transaction loads later, the id changes; the old decision is kept and saved but no longer shown.
    Stated as a limitation. *Cost if wrong:* a decision stops displaying in a rare reload case; never a
    false one.
11. **`decoded_amount`** fills for bridge calls whose param is named `amount` (raw base units, the
    column's existing rule). No column moves. *Cost if wrong:* none.
