# Multi-chain graph (follow one wallet across EVM chains) — design

Status: Approved — owner accepted every recommendation in "Decisions needed from the owner" (2026-11-16) · builder-checked (answers below)

## Intent

Real cases don't stay on one chain. An exploiter bridges loot from Ethereum to
Arbitrum, swaps it, and bridges back. A launderer moves funds onto chains with less
monitoring ("chain hopping"). A sybil farmer funds the same wallets on five L2s.
Today chainmap refuses the second chain (`error.chainMismatch`): the graph does not
record a chain per node or edge, so mixing chains would corrupt labels, links and
dedup. The investigator has to keep separate workspaces and cross-reference by hand.

This feature puts several EVM chains in **one graph** while keeping every fact tied
to its chain. It relies on one property of EVM chains and says plainly where that
property ends:

- An **EOA** address comes from a private key, and the same key produces the same
  address on every EVM chain. If an address has *signed* a transaction on one chain,
  that same key controls the address on all of them. That is cryptographic fact.
  "Same person" is still an inference: keys get shared, sold or stolen.
- A **contract** at the same address on two chains is usually unrelated in
  fund-flow terms. Shared infrastructure (Multicall3 `0xca11bde0…ca11`, Permit2
  `0x000000000022d473…8ba3`) is deployed at one address on dozens of chains.
  Counterfactual addresses can belong to different owners on different chains: in
  June 2022, 20M OP sent to Wintermute's L1 Safe address on Optimism was taken by
  an attacker who deployed his own Safe at that address there.

**Who benefits:** OSINT and compliance investigators following bridge hops and
cross-chain laundering, data analysts studying address reuse across chains, and
teachers explaining that "an address" and "an account on a chain" are different
things.

**Investigations it serves:**
1. **Bridge hops to the same address.** Canonical L1→L2 bridges and most CEX
   withdrawals deliver to the depositor's own address on the destination chain.
   The graph shows X on Ethereum calling the bridge (flagged 🌉, as it is today) and
   X on Arbitrum spending the arrival.
2. **Same-owner EOAs across chains.** See one wallet's activity on Base, BNB Chain
   and Ethereum side by side, with each chain's counterparties.
3. **Cross-chain laundering.** Peel chains, mixers (Tornado deployments on several
   chains) and hubs per chain, joined by the wallets that appear on more than one.

## Goals

1. One graph holds data from several chains. Every node, edge, label, risk flag,
   explorer link, CSV row and workspace record carries **its own** chain. Nothing is
   ever interpreted with another record's chain.
2. The same address on two chains is **two nodes**. They are connected by a
   **derived, visibly non-transactional "same address" link** that states its
   evidence ("same key" vs "same address only").
3. The investigator can add a chain to an existing graph from the scan form, or
   from a node's details panel ("load this address on another chain"), optionally
   after a probe that shows which chains the address is active on.
4. Existing v2 workspaces and the demo load unchanged.
5. A single-chain graph looks and behaves exactly as it does today. Multi-chain UI
   (chain tags, chain filter, legend lines) appears only once a graph holds ≥ 2
   chains. The one exception is the new "Other chains" row in node details, which is
   the entry point.

## Non-goals

- **Automatic chain crossing.** BFS never leaves its chain. Each chain hop is an
  explicit investigator action, so API cost stays predictable.
- **Bridge-transfer matching** (pairing a deposit on A with its release on B by
  amount, time or decoded `destinationChainId`/recipient). That is inference and
  needs its own spec (see Phasing → later).
- Entity clustering beyond "same address" (common funder, gas-funding heuristics).
- Non-EVM chains. `blockchainDetect` already warns about them.
- Fiat normalization. The amount threshold stays nominal per token. Comparing
  "1 BNB" with "1 ETH" is an existing documented caveat that becomes more visible
  here.
- Parallel scans on several chains. One Etherscan key means one rate budget, so
  `withBusy` stays the single network lane.

## Anti-goals (failure even if it "works")

- **Merging distinct (chain, address) pairs into one store record**, which would
  join unrelated contracts (Permit2, Multicall3, counterfactual Safes) into one hub
  and invent cross-chain paths such as A(Ethereum) → Permit2 → B(Polygon).
- **Presenting an inferred link as an on-chain fact.** A same-address link has no
  arrow and no amount. It is never a CSV edge row, never feeds amount scaling or
  bundles, and (v1) is never traversed by cycle, peel or hub detection.
- **Calling twins "same owner".** The strongest claim available is "same key",
  backed by evidence and worded as such.
- **Chain-mixing bugs**, each of which is a bug and gets a test:
  - chain A's known label, category, Source row or ⛔/🌀/🌉 badge shown on chain B's
    node;
  - a risk flag computed with the wrong chain's category;
  - an explorer link to the wrong explorer, including today's silent `etherscan.io`
    fallback for an unknown chain id;
  - chain A's native ticker on a chain B edge;
  - a CSV row without its chain;
  - edge dedup across chains dropping a real edge;
  - a bundle merging native ETH transfers on Ethereum and on Arbitrum.
- Silently auto-expanding across chains, which multiplies API calls.
- Regressing the single-chain experience.

## Constraints (from the codebase)

- `graphStore` is the only mutation path. Overlays, filters and links are display
  projections, and the store holds on-chain facts only.
- Pure logic stays DOM-free and Node-testable. i18n en/fr parity is enforced. Logic
  emits `{key, params}`.
- Etherscan v2: one host, `chainid` per request, one key whose rate limit is shared
  across chains. `createEtherscanClient` binds `chainId` at construction.
- Addresses are lowercased. Amounts are base-unit strings. Failed txs are dropped.
  Sampling is explicit.
- CSP stays unchanged. Workspace input is untrusted, and explorer hosts come only
  from `config.CHAINS`, never from a file.

## Approaches considered

Comparison of the three options:

| Criterion | **A — node id = `chainId:address`, derived twin links** | B — node id = address, per-chain facets | C — one store per chain, one canvas |
|---|---|---|---|
| Unrelated same-address contracts | Separate nodes ✓ | **Merged into one node ✗ (anti-goal)** | Separate ✓ |
| Edge dedup | Key gains `chainId\|` prefix ✓ | Key gains prefix ✓ | Separate stores, key unchanged ✓ |
| History cursors | Per node, which is already per chain. `history.js` unchanged ✓ | `history[chain][action]`. Sanitizer and every reader change | Unchanged ✓ |
| Workspace v2 → v3 | Stamp `chainId` on records, prefix keys ✓ | Wrap each node into facet `"1"` ✓ | v3 = list of v2 graphs ✓ |
| Labels / risk / CSV | One rule: look up with the record's chain ✓ | Which chain's label does a merged node show? Badges conflict | Per-store chain ✓ |
| Explorer links | Per record ✓ | A merged node needs a list of links | Per store ✓ |
| Overlays (cycle/peel/hub) | Per chain by construction. Cross-chain only by later opt-in ✓ | Always cross-chain, including through contracts ✗ | Per store. Cross-chain impossible without merging |
| vis ids | Change (node id ≠ address) | Unchanged | Must be namespaced in the render layer anyway |
| Single source of truth | Kept ✓ | Kept ✓ | **Broken: N stores, every consumer fans out** |
| Blast radius | Store API by id, scanner, view, export, main, many tests | Every `depth`/`isRoot`/`history` reader, labels, overlays | Render, interaction, export, CSV, palette, prune, twins index |
| Guard evolution | Removed. Mixing becomes correct by construction | Removed | Removed |

**Recommendation: A.** It is the only option that keeps unrelated contracts apart
and the store as one source of truth. Its cost is the identity change (node id is
no longer the bare address), which is mechanical and caught by tests. B's one real
advantage, "one wallet looks like one thing", can come later as an honest display
projection: an opt-in "entity view" that collapses *same-key* twins using
vis-network clustering, without touching the store (Decision 3).

Two variants were rejected:
- **B′, merge only EOAs.** Whether an address is an EOA is only known *after*
  fetching (evidence below). Nodes would have to merge or split later, rewriting
  edges, history and alias.
- **CAIP-10 ids (`eip155:1:0x…`).** The shorter `1:0x…` is enough internally, and
  ids are never parsed. The CSV carries `chain_id` and `address` separately, which
  is what analysts join on.

## Design (approach A)

### Identity and data model

- **Chain id representation:** a decimal string everywhere in records (`"1"`,
  `"42161"`), matching `knownData` keys, workspace JSON and the `<select>` value.
  It is compared as a string.
- `nodeId(chainId, address) → "<chainId>:<lc address>"`. This is a pure helper
  (in `format.js`, next to `edgeDedupKey`). Ids are **never parsed back**: records
  carry `chainId` and `address` explicitly.
- `NodeRecord = { id, chainId, address, depth, isRoot, alias, history? }`
  - `address` keeps its meaning (lowercased on-chain address) for display,
    explorer links and known-address lookups.
  - `depth`/`isRoot`/`history`/`alias` are per node, which means per chain.
    `history.js` is unchanged.
- `EdgeRecord` gains `chainId`, `fromId`, `toId`.
  - `from`/`to` stay **addresses** (the on-chain fact). `fromId`/`toId` are derived
    by the store and never trusted from a file.
  - `key = "<chainId>|" + edgeDedupKey(action, tx)`. Same tx hash on two chains is
    real: pre-EIP-155 "keyless" deployment txs (Nick's method, e.g. the
    deterministic deployment proxy `0x4e59b448…956c`) are replayed byte-for-byte on
    many chains with an identical hash.
- `EdgeInput` gains a **required** `chainId`. The store resolves the native ticker
  from `CHAINS` by that chain. `setNativeSymbol` is removed: a store-level ticker is
  a single-chain assumption.
- **Store API** (by id):
  - `addNode(chainId, address, meta)`
  - `getNode(id)`, `hasNode(id)`
  - `setAlias(id, alias)`, `setHistory(id, action, entry)`
  - `removeNodes(ids)`
  - `chains() → string[]` (distinct, sorted)
  - Events carry `id` (`node:remove {id}`, `alias:set {id, alias}`).
  - A missing or invalid `chainId` in `addNode`/`addEdge` is a programmer error
    (throw). It is never defaulted.
- **New invariants** (`checkInvariants`):
  - `node.id === nodeId(node.chainId, node.address)`;
  - `edge.fromId === nodeId(edge.chainId, edge.from)` and that node exists (same
    for `toId`), so **an edge never connects nodes of different chains**;
  - `edge.key` starts with `edge.chainId + "|"`;
  - every `chainId` matches `/^\d+$/`.

### Scanner and history

- `runScan` gains a required `chainId`, matching the client it is given. Its
  `ingestRows` tags every node and edge with it.
- BFS sets (`enqueued`, `visited`) stay keyed by address, because a run is
  single-chain.
- `loadOlder({ …, chainId, address })` loads the node `nodeId(chainId, address)`.
  `main.js` builds its client for **the node's** chain, never the selector's.
- All load-older rules (shared ingestion, replace-on-scan, no expansion) are
  unchanged.

### Same-address links ("twins") — derived, never stored

New pure module `src/chainTwins.js`:

- `addressEvidence(edges, chainsConfig) → Map<nodeId, 'eoa'|'contract'>`, computed
  from data already fetched (no API call):
  - **eoa:** the node is `from` of a `txlist` (top-level) edge on its chain. Only a
    key holder can originate a top-level tx. This does not hold on chains with
    **native account abstraction**, where smart accounts originate txs too (Abstract
    and Abstract Sepolia in today's `CHAINS`). Those chains get a
    `nativeAA: true` flag in `config.CHAINS` and their evidence is ignored.
  - **contract:** the node is `from` of a `txlistinternal` edge, or appears as an
    edge's `tokenContract`, on its chain.
  - **eoa wins** when both hold. An EIP-7702-delegated EOA has code but is still
    key-controlled.
  - Unknown otherwise.
- `sameAddressLinks(nodes, evidence) → Array<{ address, a:nodeId, b:nodeId, basis:'key'|'address' }>`
  covers every pair of nodes sharing an address. The basis is `key` if **any** node
  of that address has `eoa` evidence (the key exists, so it controls the address on
  every chain). Otherwise the basis is `address` (contract or unknown: "likely
  unrelated").
- **Why not `eth_getCode`:** empty code does not prove a key exists. Wintermute's
  Optimism address had no code until the attacker deployed there. A signature is
  the only proof.

Rendering of the links:
- They are rendered as **overlay edges** (like annotation overlay nodes): dotted
  grey, no arrow, no amount, label "same key" or "same address".
- They are excluded from filters, amount scaling, bundling, high-degree counts, the
  visible-node computation and CSV.
- Clicking one shows its basis and wording in the details panel.
- Visibility follows Decision 2.

### Overlays, labels, risk, explorer

- `roundTrips.findCycleNodes`, `sinkFaucet.classifyHubs` and
  `peelChain.findPeelChains` read `id`/`fromId`/`toId` instead of
  `address`/`from`/`to`. They stay generic graph algorithms and return node ids.
  Because store edges never cross chains and twin links are not store edges,
  **every overlay is per chain in v1** (Decision 3).
- **One lookup rule:** known label, category and source are always looked up with
  the record's own chain:
  - `knownEntry(address, node.chainId, data)` for nodes;
  - `edge.chainId` for edge flags. `flagsForEdge` passes `edge.chainId` to
    `ctx.category(addr, chainId)`.
- `"*"` (all-chain) entries from the known-address pipeline apply on every chain
  (Decision 10).
- `computeRisk(id)` scores the node with its own chain's lookups.
- Explorer links use `explorerFor(record.chainId)`. **An unknown chain gives no
  link** (the `etherscan.io` fallback is removed). A bundle is single-chain, because
  its endpoints are ids, and uses its own chain.
- **`dataChain()` and `graphChainId` are deleted.** Every use in `main.js` (today
  10 `dataChain()` calls, 10 `graphChainId` references) moves to per-record
  chains. A grep test asserts neither identifier
  reappears in `src/`.

### Display projection

- `display.bundleEdges` keys bundles by `fromId|toId|contract|symbol`, so bundles
  are per chain by construction.
- **Chain filter:** a "Chains" checkbox list in the Filters card, shown only when
  ≥ 2 chains are present.
  - `passesFilters` gains `hiddenChains:Set<string>`, and the node view hides
    nodes of hidden chains.
  - `filtersActive` accounts for it.
  - It is saved in workspace filters.

### UI

- **Chain on nodes** (≥ 2 chains only): an extra label line with the chain name
  (Decision 7). Edge tooltips gain the chain name. Edges need no tag, since an edge
  always joins two nodes of one chain.
- **Legend** (≥ 2 chains): "Chain shown under the address", "Same key on another
  chain (dotted, not a transaction)", and "Same address only — likely unrelated" if
  drawn.
- **Scan form:** the selector becomes "chain for the next scan". Start on another
  chain adds a root on that chain (Decision 6). The log line names the chain
  ("Added Base — graph now spans 2 chains").
  - Changing the selector no longer re-labels the graph. Labels are per node.
- **Details panel**, new row **"Other chains"** on every node:
  - **In this graph:** twins as links ("Base — same key", "BNB Chain — same address
    only"). Clicking one focuses that twin.
  - **"Check other chains"** runs `chainProbe.probeChains` for this address over
    `PROBE_CHAIN_IDS`, minus chains already in the graph for it. It runs as the one
    network operation (`withBusy`), so Stop cancels it.
    - Results are listed per chain: active, inactive or paid-plan.
    - The wording is "no recent normal/token activity found", never "never used".
      The probe checks `txlist`+`tokentx` only, so internal-only arrivals can be
      missed.
    - Results are kept in a `main.js` session map until reset. They are not graph
      facts.
  - **"Load on {chain}"** for each active chain, plus a chain `<select>` for any
    supported chain (Decision 5). It creates the node `(B, address)` with the source
    node's `depth` and `isRoot` (a root's twin is the investigator's subject on B),
    then runs a **first load** (newest N per selected type). New counterparties are
    added, not expanded, the same as load-older.
- **Load older** is never blocked by the selector any more. A node knows its chain,
  so `loadBlocked`/`chainRefusal` go away.
- **Alias** handling follows Decision 4.
- **Command palette:** records use node ids, and the subtitle shows address plus
  chain name. Typing an address finds all its twins.
- **Prune / box-select / Ctrl+Arrow** work on vis ids, which are now node ids. No
  logic change. `selectHighDegree` must not count twin overlay edges.
- **Unknown chain** (a workspace from a build with a chain this one lacks):
  - nodes load with the tag "chain {id}";
  - there is no explorer link;
  - scan or load on that chain is refused with a localized message.

### Workspace v3 and migration

Format, following the recommended Decision 9:
```
{ version: 3, graph: { nodes: NodeRecord[], edges: EdgeRecord[] },
  filters: { …v2, hiddenChains?: string[], showTwins?: boolean }, layout, annotations }
```

- Per-record `chainId` is required.
- `id`/`fromId`/`toId` may be present but are **always recomputed**.
- The top-level `chainId` is dropped. `root` is kept as today (informational).

`parseWorkspace(json, { fallbackChainId })` behaves by version:
- **version absent or ≤ 2 → migrate:**
  - `chainId = String(ws.chainId ?? fallbackChainId)`. If it is not digits, refuse.
    A fallback is logged ("workspace had no chain; assumed {chain}"), as
    `applyWorkspace` does implicitly today.
  - Stamp `chainId` on every node and edge.
  - Prefix each edge key: `key = chainId + "|" + key`. Keys are **prefixed, not
    recomputed**: `EdgeRecord` lacks `logIndex`, and `edge.to` may be the
    contract-creation fallback, so recomputation would not reproduce the original.
  - `history` passes through `sanitizeHistory` as today.
- **version 3:** validate each record's `chainId` (digits, safe integer).
  - Drop edges whose key prefix doesn't match their `chainId`, or whose endpoints
    are missing on that chain.
  - Explorer hosts are never read from the file.
- **version > 3:** refuse with a localized "made by a newer chainmap" message.
  Today there is no version gate at all.

Other workspace behaviour:
- `data/demo-workspace.json` **stays v2** on purpose, so every demo load exercises
  the migration.
- The demo must keep showing every overlay. Phase 2 adds a twin to the demo
  (Left to the builder).
- `saveWorkspace` writes v3 only (one writer).

### CSV

- Append **`chain_id`** as the last column on node and edge rows (Decision 8).
- On a multi-chain graph, the **first line** (sampling caveat) gains "; multi-chain:
  each row belongs to its chain_id — the same address on two chains is two rows; a
  shared address implies no transfer". It is the same line, so the header stays on
  line 2 for existing scripts.
- `risk_flags` and `real_recipient` are computed with the edge's chain.
- Twin links are **not exported**. They can be derived from `address`+`chain_id`,
  and exporting them as rows would dress inference as data.

### PNG/PDF export

- `renderExportCanvas` uses node ids for positions and edges.
- Labels include the chain line under the same ≥ 2-chains rule.
- Twin links are drawn when shown on screen, with the same distinct style.

### i18n (en + fr, parity test)

New keys:
- `details.otherChains`, `details.checkOtherChains`, `details.loadOnChain`,
  `details.twinKey`, `details.twinAddress`, `details.probeNone`;
- `filters.chains`;
- `legend.chainTag`, `legend.twinKey`, `legend.twinAddress`;
- log/status lines for chain added and for load on a chain;
- `error.unknownChain`, `log.workspaceAssumedChain`, `error.workspaceTooNew`.

`error.chainMismatch` is removed. Chain names are proper nouns from `CHAINS` and are
not translated.

### Security

- `chainId` from a file is digits-only before use in ids, keys or lookups.
- Explorer URLs use the `CHAINS` host plus a validated address or hash.
- Twin and probe text reaches the DOM via `textContent`.
- No new network destinations.

## Phasing

1. **Chain-scoped data (shippable alone).** Covers:
   - identity, store API, invariants;
   - scanner and load by node chain;
   - workspace v3 and migration;
   - per-record labels, flags, explorer, bundles and CSV;
   - guard removed;
   - chain tags and chain filter.

   Two scans on two chains then sit side by side, honestly tagged.
2. **Twins.** Covers:
   - `chainTwins.js`;
   - overlay links and legend;
   - details "Other chains" (list, probe, load on chain);
   - alias propagation;
   - demo twin.
3. **Later, separate spec:**
   - opt-in **entity view** (vis clustering of same-key twins; overlays may then
     traverse them);
   - **suggested bridge hops** from decoded bridge calldata (`destinationChainId` +
     recipient), always styled as "suggested" with evidence and never exported as
     edges;
   - investigator-asserted links.

## Tests (bun)

- **format:** `nodeId`. The same raw tx on chains 1 and 56 gives two distinct keys.
- **graphStore:**
  - twins coexist;
  - `addNode`/`addEdge` without `chainId` throw;
  - native ticker comes from the edge's chain;
  - invariants catch cross-chain edges and key prefixes that don't match;
  - `removeNodes([id])` removes only that chain's twin;
  - `loadSnapshot` recomputes ids and drops chain-mismatched edges.
- **scanner:**
  - `runScan(chainId)` tags everything;
  - root X scanned on 1 and then 8453 gives two roots and no dedup loss with a
    replayed-hash fixture;
  - `loadOlder(chainId, address)` touches only that node's history.
- **chainTwins:**
  - eoa from `txlist`-from;
  - contract from internal-from or tokenContract;
  - eoa wins (7702);
  - native-AA chain evidence is ignored;
  - basis `key` vs `address`;
  - no self-pairs.
- **Overlays:** X→Y on chain 1 plus Y→X on chain 10 gives **no** cycle. Hubs and
  peel stay per chain.
- **Labels and risk:**
  - an address labeled on chain 1 only gives no label or badge on its chain 56
    twin;
  - a `"*"` entry badges both;
  - `flagsForEdge` uses the edge's chain.
- **display:** native ETH X→Y on Ethereum and on Arbitrum gives two bundles. The
  chain filter hides nodes and edges of that chain only.
- **Explorer:** links come per record, and an unknown chain gives no link.
- **workspace:**
  - v2 → v3 migration: chain stamped, keys prefixed, history kept, demo loads;
  - v3 multi-chain round trip;
  - bad `chainId` records dropped;
  - version 4 refused;
  - missing v2 `chainId` uses the fallback and logs it.
- **CSV:** `chain_id` column on both row kinds; multi-chain caveat stays on line 1;
  header on line 2.
- **Guard:** grep test, no `dataChain(` or `graphChainId` in `src/`.
- **DOM smoke:** "Other chains" row states (none / twins / probe results / busy).
- **Integration:**
  - the v2 demo renders with no chain tags (single-chain look unchanged);
  - a two-chain canned scan shows tags, filter and a same-key link.
- Locale parity (existing).

## Files

- **Changed:**
  - `src/format.js` (`nodeId`, keyed dedup), `src/config.js` (`nativeAA` on
    Abstract chains), `src/graphStore.js`, `src/scanner.js`, `src/workspace.js`;
  - `src/display.js`, `src/roundTrips.js`, `src/sinkFaucet.js`,
    `src/peelChain.js`, `src/riskFlags.js` (ctx chain);
  - `src/render/{network,labels,export}.js`, `src/ui.js`, `src/main.js`,
    `src/nodeSearch.js` callers;
  - locales, `index.html` (legend rows, chain filter container).
- **New:** `src/chainTwins.js` plus tests.
- **Docs:**
  - `INTERFACES.md` (ids, store API, EdgeInput, workspace v3, CSV);
  - `CLAUDE.md`: the convention "addresses … are the canonical node id" becomes
    "node id = `chainId:address`; an address alone is not an identity";
  - `README`/`README.fr`;
  - `docs/LEARN{,.fr}.md` §9: same key vs same address, with the Wintermute
    example.

## Dependencies and interactions

- **`FETCH.endblock = 99_999_999`** — resolved, no change needed: the owner
  verified on 2026-11-15 against the live API that Etherscan treats it as
  "latest" even on chains past block 1e8 (Arbitrum), and that a numeric
  `endblock` is honored and inclusive (Arbitrum and Ethereum). Multi-chain
  investigations on high-block chains are therefore safe.
- **Known-address pipeline + fake tokens (2026-11-16):** land it first. Its
  `knownEntry(address, chainId, data)` helper is what this design calls per record.
  Two of its rulings assume one graph chain and become per-edge here:
  - fake-token predicate: `isFakeToken(edge, edge.chainId, index)` instead of
    `dataChain()`;
  - spam contracts: `"*" ∪ set[edge.chainId]`, looked up per edge in
    `display.isSpam`, instead of one union per graph chain.

  Keep those helpers chain-parameterised so the conversion is mechanical.

## Left to the builder

- Chain line text: `CHAINS.name`, or a new short `tag` field if names clutter
  labels.
- How twin overlay edges coexist with the edge DataView and bundling. The
  constraints above are binding, the mechanism is free.
- Probe session-cache shape. Whether "Load on {chain}" also offers the scan form's
  depth (default: first load only).
- Demo twin: one illustrative same-key hop to Arbitrum. Placeholder addresses must
  be labelled as illustrative in the demo note, as the existing placeholders are.
- Version bump (minor vs major) at release (owner's call at release time).

## Decisions needed from the owner

1. **Node identity model.**
   - (A) id = `chainId:address`, with derived twin links.
   - (B) id = address, with per-chain facets.
   - (C) one store per chain on one canvas.

   B merges unrelated same-address contracts (Permit2, Multicall3, counterfactual
   Safes) and invents cross-chain paths. C breaks the single source of truth and
   pushes chain handling into every consumer. A costs an id migration across store,
   view and tests. **Recommend A.**

2. **Which same-address links to draw.**
   - (a) Draw every same-address pair alike.
   - (b) Evidence tiers: draw **same-key** links (an EOA signature seen on a non-AA
     chain), on by default once ≥ 2 chains are present, with a toggle. List
     "same address only" pairs in details but don't draw them by default.
   - (c) Draw no links; details only.

   (a) visually asserts relations that are usually false for contracts. (c) hides
   the main value of the feature. **Recommend (b).**

3. **Do overlays (cycles, peel, hubs, risk) traverse twin links?**
   - (a) Never in v1: overlays are on-chain facts only.
   - (b) An opt-in "entity view" later that collapses same-key twins (display-only
     clustering), where overlays may traverse them.
   - (c) Always.

   (c) turns an inference into "detected round-trips". (a) misses cross-chain round
   trips until (b) ships. **Recommend (a) now, (b) as Phase 3.**

4. **Alias scope.**
   - (a) Per node (per chain).
   - (b) Per address, shared by all twins.
   - (c) Per node, plus an "apply to other chains" action in details.

   (b) is wrong for contracts. (a) makes the investigator retype a suspect's name
   per chain. **Recommend (c).**

5. **How a chain is added from a node.**
   - (a) Manual chain picker only.
   - (b) "Check other chains" probe (2 calls per candidate chain, ≤ 12 chains),
     then "Load on {chain}".
   - (c) Automatic expansion of EOAs to all active chains.

   (c) multiplies API cost and contradicts "explicit sampling". (a) alone makes the
   user guess. **Recommend (a)+(b):** the twin inherits depth and root, and the load
   is a first load only (no BFS), consistent with load-older.

6. **Single-chain guard.**
   - (a) Remove it. Start on any chain adds to the graph, with a log line and
     visible chain tags.
   - (b) Keep refusing unless an "Allow multiple chains" mode is on.
   - (c) A one-time confirm on the first cross-chain scan of a graph.

   The guard existed because mixing corrupted data. Under A, mixing is correct by
   construction, so only the "forgot to switch the selector" risk remains, and it is
   visible and prunable. **Recommend (a).**

7. **How a node shows its chain.**
   - (a) An extra label line with the chain name (≥ 2 chains only).
   - (b) A shape per chain.
   - (c) A border colour per chain.
   - (d) An optional "Color nodes by chain" toggle that replaces depth colour, like
     the edge age toggle.

   (b) runs out of shapes and clashes with note boxes. (c) clashes with the root,
   cycle, peel and more-history borders. (a) is readable, colour-blind safe and
   survives PNG/PDF. **Recommend (a), with (d) as an optional toggle.**

8. **CSV shape.**
   - Column placement: `chain_id` appended last, or inserted after `row_type`.
   - Twin links: exported as rows, or not.

   Appending keeps column positions stable for existing scripts, as the five
   trailing decoded columns did. Exporting links would turn inference into rows.
   **Recommend: append `chain_id` last; don't export links; add the multi-chain
   caveat to line 1.**

9. **Workspace compatibility with older app versions.**
   - (a) Keep `nodes`/`edges` at top level in v3. A pre-multi-chain build (a local
     clone or a stale cache) silently mixes chains when opening a multi-chain file.
   - (b) Write v2 for single-chain graphs and v3 only when multi-chain. That means
     two writers.
   - (c) v3 moves the arrays under `graph: {nodes, edges}`. Old builds refuse every
     v3 file loudly with their existing "must have nodes and edges arrays" error.
     There is one writer. Plus a version gate (> 3 refused) from now on.

   **Recommend (c):** a loud refusal beats silent chain-mixing. The served app is
   always current, so the cost is small.

10. **All-chain (`"*"`, OFAC) labels on a node with contract evidence on its
    chain.**
    - (a) Badge it anyway: OFAC designates an address, not a chain, and on-chain
      sanctions oracles behave the same way.
    - (b) Badge only nodes with EOA evidence, or on the chain implied by the SDN
      currency tag.
    - (c) As (a), but the Source row and tooltip say "listed for all EVM chains
      (address-level designation)".

    (b) can miss a real designated EOA that was never seen signing. (a) without
    provenance can mislabel an unrelated contract twin. **Recommend (c).**

## Owner decisions (2026-11-16)

The owner chose to proceed with **every recommendation above** (decisions 1–10 as
recommended in this section). Where a recommendation above names "v1" vs
"later", v1 is the scope to build now; "later" items stay out of scope.


## Builder-check answers (owner, 2026-11-16)

1. **Demo becomes v3** in Phase 2 with a real same-key hop to Arbitrum (showcases
   the feature). A separate small **v2 fixture** (test-only) covers the v2→v3
   migration and the "single-chain graph renders with no chain tags" assertion.
   v2 parsing stays strict: every v2 record takes the file's top-level `chainId`.
2. **"Color nodes by chain" (7d) is later**, not v1. v1 shows the chain as the
   label line only.
3. **"Same address only" links are details-panel only** in v1 — never drawn; the
   legend row for them is removed. Only same-key links can be drawn (`showTwins`).
4. **Alias apply is conservative:** the manual "apply to other chains" action
   targets **same-key twins only** and **never overwrites** an alias a twin
   already has. "Load on {chain}" does **not** copy the alias (no automatic
   ownership claim). No automatic alias propagation.
