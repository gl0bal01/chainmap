# Exchange (CEX) deposit-address detection — design

Status: program P4 (owner-approved program contract, 2026-11-16) · builder-checked (rulings below)

## Intent

The question at the end of most traces is "where did it cash out?". Centralized
exchanges give every customer a **unique deposit address**. Funds a customer sends
there are later **swept** (forwarded, usually soon and nearly in full) by the exchange
to one of its hot wallets. So an address whose sampled outflow goes nearly entirely to
**one known exchange wallet** is likely a deposit address of that exchange — and that
is the lead an investigator takes to the exchange (subpoena / compliance request).

chainmap already knows a few exchange hot wallets (`category: "exchange"`, 8 entries
today) and holds every fetched transfer per chain. This feature reads those facts and
marks likely deposit addresses, **as a heuristic with its evidence**, never as fact.

**Who benefits:** investigators tracing a cash-out, compliance analysts, teachers
explaining how custodial exchanges work on-chain.

## Goals

1. Mark a node as **"likely deposit address of <exchange wallet> (heuristic)"** when
   its sampled outflow meets conservative sweep criteria (below).
2. Explain **why**, in numbers: "forwarded N of M outgoing transfers; X% of the USDT
   outflow; latest funds swept within Δt — sampled transactions only".
3. Surfaces: node marker (label line + tooltip), details-panel row, CSV columns, a
   context reason in the risk row, a legend row. en + fr.
4. Per chain by construction: the same address on two chains is judged twice,
   independently.

## Non-goals

- Growing the exchange dataset (the heuristic generalizes as `data/` grows; curation
  rules of the known-address pipeline still apply).
- Grouping several hot wallets into one exchange entity ("Binance 14" + "Binance 20" =
  Binance). There is no entity field in `KnownEntry`; we name the wallet's label.
- Identifying the customer, USD values, cross-chain evidence, extra API calls, an
  inverse "deposits feeding this hot wallet" list, PNG/PDF baking of the marker.
- Detecting deposit addresses of exchanges whose wallets are not in `data/`.

## Anti-goals (failure even if it "works")

- Wording a likely deposit address as a fact ("Binance account", "owned by Binance").
- Judging an address whose own transactions were **never fetched** (its outflows in
  the store are only what other nodes' fetches happened to show — a sampling artifact).
- Merging evidence across chains (twins), or using another chain's category.
- Value math with `Number` (shares are BigInt over raw base units, per asset).
- Mutating `graphStore`, or adding anything to workspace files.
- Marking a known entity (router, bridge, exchange wallet, token…) as a deposit.
- Marking an address that splits its exchange-bound outflow across two different
  exchange wallets (could be two exchanges; we cannot tell — stay silent).

## Constraints

House invariants (program contract): buildless, client-side; pure logic DOM-free and
unit-tested; DOM only in ui.js/render/main.js; store is the single source of truth;
display projections never mutate it; honesty about sampling; BigInt amounts; i18n
parity; node id `chainId:address`; workspace stays v3 (untouched); no new deps; no new
hosts (CSP unchanged); textContent only for untrusted strings.

## Approaches considered

| | Approach | Verdict |
|---|---|---|
| **A** | **Pure post-hoc detector over store nodes+edges + known lookup → `Map<nodeId, DepositEvidence>`; view/details/CSV read it** | **Chosen**: same pattern as hubs/peel/cycles; no API cost; testable |
| B | Edge flag `flag.exchange` via `flagsForEdge` | Rejected: "sent to an exchange" ≠ "is a deposit address"; would escalate every exchange edge. Could be added later as an info flag |
| C | Active probe: fetch each candidate's full outflow | Rejected: unbounded API cost; breaks predictable sampling. The investigator can already "Load older" on a node |

## Design

### Pure module `src/depositDetect.js`

```
findDeposits(nodes, edges, ctx) → Map<nodeId, DepositEvidence>
  ctx = { known(address, chainId) → KnownEntry|null, ignoreEdge?(edge) → boolean }
DepositEvidence = {
  walletId, wallet, label,          // the one exchange wallet (node id, address, known label)
  swept, outgoing,                  // N of M outgoing value transfers
  assets: [{ symbol, contract, sharePct }],  // per swept asset; contract "" = native
  maxDelaySec: number|null,         // see delay; null = no prior inflow seen
  timedSweeps: number,              // sweeps that had a prior same-asset inflow in the store
}
delayParts(sec) → { key:'duration.m'|'duration.h'|'duration.d', params:{n} }
```

Criteria for node `N` (all must hold; constants in the module, conservative):

1. **Fetched:** `N.history` has entries for **both** `txlist` and `tokentx` (its own
   native and token transactions were fetched by a scan or a load). Otherwise N is never
   judged. Evidence uses only actions N itself fetched (see 3).
2. **Not a known entity:** `ctx.known(N.address, N.chainId)` is null.
3. **Outgoing value transfers** `O` = edges with `fromId === N.id`, `toId !== N.id`,
   action in `txlist` / `txlistinternal` / `tokentx` **and present in `N.history`**
   (NFT edges ignored; an internal edge counts only if N fetched `txlistinternal`),
   `BigInt(value) > 0n` (unparseable → skipped), and not `ctx.ignoreEdge(edge)`
   (main passes imitation-token + spam-list edges: fake `Transfer(from=N)` events used
   for address poisoning must not dilute the evidence).
4. **Exchange-bound** `S` = edges of `O` whose `to` has category `exchange` on
   `edge.chainId` (`ctx.known(edge.to, edge.chainId)`). `S` non-empty.
5. **One wallet:** every edge of `S` goes to the same address `W`.
6. **Count share:** `|S| * 100 >= |O| * 90` (with fewer than 10 outflows, that means
   all of them).
7. **Value share, per swept asset** (asset = `tokenContract` for `tokentx`, native
   otherwise): `sum(S_a) * 100n >= sum(O_a) * 90n` in BigInt over raw `value`.
   `sharePct = Number(sum(S_a) * 100n / sum(O_a))` (floor; integer percent, so 99.9 %
   never shows as 100 %).
8. Twins: nothing special — every lookup uses the record's chain and every edge joins
   two nodes of one chain, so evidence never crosses chains.

**Delay (evidence, not a criterion):** for each edge in `S`, delay = its `timeStamp`
minus the latest inflow (`toId === N.id`, same asset, `timeStamp <=` the sweep)
seen in the store. `maxDelaySec` = max over sweeps that have one; `null` when none
(the inflow fell outside the sample). Delay is shown, not gated (sweep policies range
from minutes to weeks; a gate would mostly reject on missing sample data).

### Wording (en; fr natural equivalents)

- Node label line + tooltip: `🏦 likely deposit → {label}` (tooltip adds "(heuristic)").
- Details row **"Exchange deposit"**: "Likely deposit address of {label} (heuristic)",
  then "Forwarded {swept} of {outgoing} outgoing transfers to it", one line per asset
  "{pct}% of the {symbol} outflow", then "Swept within {delay} of the latest inflow
  ({timed} of {swept} sweeps timed)" or
  "No inflow seen before the sweep in the sampled data", then "Based only on the
  sampled transactions; verify with the exchange." Wallet label/symbol via textContent.
- Risk row: context reason `risk.deposit` "likely exchange deposit address" (score +0,
  like `risk.known`).
- Legend row: "🏦 Likely exchange deposit (heuristic)".

### Wiring (main.js / render / ui)

- `main.js` keeps `depositMap`, recomputed by one function at every point where the
  graph settles (scan end, load older / load on chain end, workspace + demo load,
  prune, reset, known-address data load), then refreshes node visuals. Details and CSV
  use the current map. Never stored; never in workspace.
- `render/network.js`: `createGraphView` dep `getDeposit?(id) → DepositEvidence|null`;
  `applyNode` appends the label line and tooltip text. No ring color (rings are taken
  by peel / round-trip / more-history).
- `ui.renderNodeDetails` dep `deposit?: DepositEvidence|null` → the row above.
- `riskScore.scoreNode` input gains `deposit:boolean` → `risk.deposit` (no score).
- CSV (`buildCsvRows` ctx `deposits?: Map`): two columns **appended after `chain_id`**:
  `likely_deposit_of` (wallet label) and `deposit_evidence`
  (`wallet=<addr>;swept=<N>/<M>;share=<SYM>:<pct>%[,…];max_delay_s=<n>|none`). Node
  rows only; edge rows blank. When any row has one, line 1 (caveat) gains
  `; likely_deposit_of is a heuristic (nearly all of the address's sampled outflow went to one known exchange wallet), not an attribution`.
  Header stays on line 2; existing column positions unchanged.

### i18n

New keys (en+fr): `details.deposit`, `deposit.badge`, `deposit.tooltip`,
`deposit.of`, `deposit.swept`, `deposit.share`, `deposit.delay`, `deposit.noInflow`,
`deposit.sampled`, `duration.m`, `duration.h`, `duration.d`, `risk.deposit`,
`legend.deposit`.

### Demo

Add one illustrative deposit address to `data/demo-workspace.json` (v3, with a
`history` entry so it is "fetched"): an inflow from a demo node, then a sweep of
nearly the full amount to Binance 14 (`0x28c6…1d60`) within minutes. Illustrative data,
like the existing demo hop. Keeps the demo a teaching tool and the smoke path testable.

## Tests

- `test/depositDetect.test.js`: positive (native, token, internal), each criterion's
  negative (unfetched, known node, two exchange wallets, 9/10 ok vs 8/10 fails, value
  share 89 % fails, NFT ignored, zero-value ignored, ignoreEdge ignored), floor percent,
  BigInt beyond 2^53, delay (with/without prior inflow, same-asset only), chain
  isolation (same address on two chains, exchange known only on chain 1).
- riskScore `risk.deposit` context-only; CSV columns/caveat; `renderNodeDetails` row
  (textContent, no innerHTML); network label/tooltip; locales parity (existing test).
- Integration (shared harness): demo load marks the illustrative deposit node; a
  prune of the hot wallet removes the mark; workspace JSON gains no field.

## Left to the builder

Exact recompute call sites in `main.js` (must not go stale — tested); CSS for the
legend glyph; exact fr phrasing (natural French); demo addresses/amounts.

## Owner decisions (binding, from the program contract)

No new hosts; no new deps; merge to local main only, no push/tag/release. (Tron, USD,
bridges belong to later projects.)

## Builder-check rulings

Builder check (sonnet, fresh) raised 8 questions; rulings (spec text above updated):

1. **"Fetched" per action.** N is judged only if `history` has `txlist` AND `tokentx`;
   `O` uses only actions N fetched (internal edges only if `txlistinternal` fetched).
   Why: a node with only native txs fetched could hide its token outflows. Cost if
   wrong: scans with "Token transfers" unchecked never detect (false negatives only).
2. **Partial pages and 1-of-1.** A `done:false` (latest-N) fetch is accepted; the
   wording says "sampled". One outflow of one (1/1) qualifies, deliberately: deposit
   addresses are often used once, and customers do not send to hot wallets directly.
   The count "1 of 1" is shown so the reader weighs it. Cost if wrong: a rare one-off
   direct transfer to a hot wallet gets a "likely" mark with visible 1/1 evidence.
3. **`ignoreEdge`** = existing predicates, no new code: `isFakeTokenEdge(e)` (main.js,
   `fakeToken.isFakeToken`) `|| display.isSpam(e, { spamContractsFor: spam.contractsFor,
   spamSymbols: spam.symbols })`. Cost if wrong: none beyond fewer dilutions.
4. **Chain scope.** `S` membership is `ctx.known(edge.to, edge.chainId)?.category ===
   "exchange"`; the label is W's own entry on that chain. Twins never share evidence.
5. **Delay.** Equal timestamps count as "prior" (`<=`); only same-asset inflows (a gas
   top-up never times a token sweep); `maxDelaySec` over timed sweeps only; the mixed
   case is shown as "({timed} of {swept} sweeps timed)" (`timedSweeps` added).
6. **Recompute.** Builder may use one coalesced store subscription (at most one
   recompute per macrotask) plus an explicit recompute after known-address data loads;
   only nodes whose deposit status changed are re-applied in the view. Must be proven
   non-stale after scan end, prune, workspace/demo load and reset (integration test).
7. **Demo.** Node/edge counts may change; update the tests that count them. Chain 1,
   Binance 14 (`0x28c6c06298d514db089934071355e5743bf21d60`, chain-1 entry) is correct.
   The demo nodes gain `history` only where needed (the deposit node).
8. **CSV.** One node row per `chainId:address` (store nodes); the map is keyed by node
   id, so twins get independent cells.
