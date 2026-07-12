# Sanctions / known-entity data expansion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Broaden the bundled known-address dataset (sanctioned / mixer / bridge / exchange) across the main EVM chains and formalize the category vocabulary — a data + one-enum + tests increment, no new detection logic.

**Architecture:** The flag mechanism (`riskFlags.js` → node/edge/CSV/details) already ships. This plan (1) adds a `KNOWN_CATEGORIES` enum to `config.js`, (2) adds a data-validity guardrail test, (3) expands `data/known-addresses.json` with dated, sourced, verified entries, (4) updates the data README, and (5) surfaces provenance (`source`) in the details panel. Known-labels stay a display projection — no `graphStore` mutation, no node-id change.

**Tech Stack:** Native ES modules (no bundler), `bun test` + happy-dom, JSON data fetched same-origin (CSP `connect-src 'self'`).

## Global Constraints

- Addresses are **lowercased** everywhere and are the canonical node id. Copied verbatim from CLAUDE.md.
- Data is fetched from **same origin only** (`connect-src 'self'`) — never a third-party OFAC/analytics feed.
- Entry record stays backward compatible: `label` + `category` required; `source` + `added` optional. Existing consumers read only `label`/`category`.
- The dataset is a **dated, hand-curated snapshot of publicly documented addresses — NOT an authoritative OFAC feed.** Every UI/README surface naming it must say "verify against the live OFAC SDN list before acting."
- **Never commit an unverified address.** Each address is confirmed against its cited public source (correct hex, correct chain) before it enters the JSON.
- i18n: no hardcoded UI text in logic; en/fr key sets stay at parity (enforced by `test/locales.test.js`).
- Tests run with `bun test`. Commit author + committer email = `gl0bal01@proton.me`; no AI attribution in commit messages.

---

### Task 1: `KNOWN_CATEGORIES` enum in config.js

**Files:**
- Modify: `src/config.js` (append a new export after `DATA_PATHS`, ~line 199)
- Test: `test/config.test.js` (append a new `describe` block)

**Interfaces:**
- Produces: `export const KNOWN_CATEGORIES: string[]` — the canonical category vocabulary, consumed by Task 2's validity test and Task 3's data.

- [ ] **Step 1: Write the failing test**

Append to `test/config.test.js`:

```js
import { CHAINS, PROBE_CHAIN_IDS, KNOWN_CATEGORIES } from "../src/config.js";

describe("KNOWN_CATEGORIES", () => {
  test("is a non-empty array of unique lowercase strings", () => {
    expect(Array.isArray(KNOWN_CATEGORIES)).toBe(true);
    expect(KNOWN_CATEGORIES.length).toBeGreaterThan(0);
    for (const c of KNOWN_CATEGORIES) {
      expect(typeof c).toBe("string");
      expect(c).toBe(c.toLowerCase());
      expect(c.trim().length).toBeGreaterThan(0);
    }
    expect(new Set(KNOWN_CATEGORIES).size).toBe(KNOWN_CATEGORIES.length);
  });

  test("covers the categories used by the flag mechanism", () => {
    for (const c of ["exchange", "router", "bridge", "burn", "mixer", "contract", "sanctioned", "other"]) {
      expect(KNOWN_CATEGORIES).toContain(c);
    }
  });
});
```

Note: the top-of-file import line already imports `{ CHAINS, PROBE_CHAIN_IDS }` — extend that existing line to add `KNOWN_CATEGORIES` instead of adding a duplicate import.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/config.test.js`
Expected: FAIL — `KNOWN_CATEGORIES` is `undefined` (import resolves to undefined; `Array.isArray(undefined)` is false).

- [ ] **Step 3: Add the enum to config.js**

Append at the end of `src/config.js`:

```js
/** Canonical known-address category vocabulary. Every `category` in
 *  data/known-addresses.json must be one of these (enforced by
 *  test/knownAddressesData.test.js). Adding a category = one entry here. */
export const KNOWN_CATEGORIES = [
  "exchange",
  "router",
  "bridge",
  "burn",
  "mixer",
  "contract",
  "sanctioned",
  "other",
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/config.test.js`
Expected: PASS (all `KNOWN_CATEGORIES` tests green; existing CHAINS/PROBE tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/config.js test/config.test.js
git commit -m "feat(config): add KNOWN_CATEGORIES enum for known-address categories"
```

---

### Task 2: Data-validity guardrail test

**Files:**
- Create: `test/knownAddressesData.test.js`

**Interfaces:**
- Consumes: `KNOWN_CATEGORIES` from `src/config.js` (Task 1); `isValidAddress`, `lc` from `src/format.js`; the JSON at `data/known-addresses.json` (imported directly).

This test encodes the dataset rules and runs against the **current** data (which is already valid), so it passes immediately and then guards the Task 3 expansion.

- [ ] **Step 1: Write the test**

Create `test/knownAddressesData.test.js`:

```js
import { test, expect, describe } from "bun:test";
import knownData from "../data/known-addresses.json";
import { KNOWN_CATEGORIES } from "../src/config.js";
import { isValidAddress, lc } from "../src/format.js";

describe("data/known-addresses.json validity", () => {
  test("top level is an object keyed by numeric chain-id strings", () => {
    expect(knownData && typeof knownData).toBe("object");
    for (const chainId of Object.keys(knownData)) {
      expect(String(Number(chainId))).toBe(chainId); // "1" ok, "0x1"/"eth" not
      expect(typeof knownData[chainId]).toBe("object");
    }
  });

  test("every address key is lowercased and a valid address", () => {
    for (const chainId of Object.keys(knownData)) {
      for (const addr of Object.keys(knownData[chainId])) {
        expect(addr).toBe(lc(addr));
        expect(isValidAddress(addr)).toBe(true);
      }
    }
  });

  test("every entry has a non-empty label and a category in KNOWN_CATEGORIES", () => {
    for (const chainId of Object.keys(knownData)) {
      for (const [addr, entry] of Object.entries(knownData[chainId])) {
        expect(typeof entry.label).toBe("string");
        expect(entry.label.trim().length).toBeGreaterThan(0);
        expect(KNOWN_CATEGORIES).toContain(entry.category); // fails loudly on a typo/new category
      }
    }
  });

  test("optional source/added, when present, are non-empty strings", () => {
    for (const chainId of Object.keys(knownData)) {
      for (const entry of Object.values(knownData[chainId])) {
        if ("source" in entry) {
          expect(typeof entry.source).toBe("string");
          expect(entry.source.trim().length).toBeGreaterThan(0);
        }
        if ("added" in entry) {
          expect(typeof entry.added).toBe("string");
          expect(entry.added.trim().length).toBeGreaterThan(0);
        }
      }
    }
  });

  test("no duplicate address within a chain (after lowercasing)", () => {
    for (const chainId of Object.keys(knownData)) {
      const keys = Object.keys(knownData[chainId]);
      const lcSet = new Set(keys.map(lc));
      expect(lcSet.size).toBe(keys.length);
    }
  });
});
```

- [ ] **Step 2: Run the test against current data**

Run: `bun test test/knownAddressesData.test.js`
Expected: PASS — the shipped dataset (chain "1", categories burn/contract/router/exchange/bridge/sanctioned/mixer) already satisfies every rule.

If it FAILS, the current data has a latent bug (e.g. a category not in the enum). Fix the data (not the test) so it passes, then continue.

- [ ] **Step 3: Commit**

```bash
git add test/knownAddressesData.test.js
git commit -m "test(data): guardrail for known-addresses.json shape, enum, provenance"
```

---

### Task 3: Expand the dataset (verified, sourced, dated)

**Files:**
- Modify: `data/known-addresses.json`

**Interfaces:**
- Consumes: the guardrail test from Task 2 (must stay green after every edit).

**Sourcing rule (non-negotiable):** for each entity below, look up the address from its cited public source, confirm `isValidAddress` + that it is the address on the stated chain, then add it **lowercased**. Do not commit any address you could not verify against its source. This is a provenance requirement, not an optional nicety.

Entry template (add `source` + `added` to new AND existing entries):

```json
"0x<lowercased-verified-address>": {
  "label": "<entity>",
  "category": "<one of KNOWN_CATEGORIES>",
  "source": "<authoritative reference, e.g. 'OFAC SDN 2022-08-08' or 'Etherscan public label'>",
  "added": "2026-07-12"
}
```

- [ ] **Step 1: Backfill provenance on the existing chain-1 entries**

For each address already in `data/known-addresses.json` under `"1"`, add `source` + `"added": "2026-07-12"`. Suggested sources:
- Tornado Cash pools/proxy (`category: "mixer"`), and the Ronin exploiter (`category: "sanctioned"`) → `"source": "OFAC SDN 2022"`.
- Bridges (Ronin, Polygon ERC20) → `"source": "Etherscan public label"`.
- WETH / USDC / USDT / Uniswap router / Binance 14 → `"source": "Etherscan public label"`.

Run: `bun test test/knownAddressesData.test.js` → expect PASS (source/added now present and valid).

- [ ] **Step 2: Add curated entries for the main chains**

**DEFERRED (by decision 2026-07-12):** Step 2 is not implemented this pass — new multi-chain addresses await a user-verified address list (fabricating/misattributing a sanctioned address is the exact risk avoided). Step 1 (provenance backfill on the existing 15 chain-1 entries) WAS done.

Add entries per chain, each verified per the sourcing rule. Target set (fill verified addresses; keep the list modest and high-signal — YAGNI, not an exhaustive dump):

| Chain | id | Entities to add (category) | Source |
|-------|----|----|----|
| Ethereum | 1 | Tornado router/relayer if missing (mixer); Lazarus-linked addresses from the OFAC action (sanctioned); Coinbase / Kraken / OKX hot wallets (exchange) | OFAC SDN; Etherscan public labels |
| BNB Chain | 56 | Binance hot wallet(s) (exchange); Tornado BSC pools if deployed (mixer) | Etherscan/BscScan public labels |
| Polygon | 137 | Polygon PoS bridge (bridge); major CEX deposit wallet (exchange) | PolygonScan public labels |
| Arbitrum One | 42161 | Arbitrum bridge/gateway (bridge) | Arbiscan public labels |
| Optimism | 10 | Optimism standard bridge (bridge) | Optimistic Etherscan labels |
| Base | 8453 | Base standard bridge (bridge) | BaseScan public labels |

For each entity: verify the address on that chain, add the lowercased entry with `source` + `added`. After each chain's batch:

Run: `bun test test/knownAddressesData.test.js` → expect PASS.

Note: the `bridge` entries here are the same addresses the bridge-follow feature (separate plan) will register — adding them now is intentional shared groundwork.

- [ ] **Step 3: Full test run**

Run: `bun test`
Expected: PASS — all suites green (data validity, config, knownAddresses, locales, everything).

- [ ] **Step 4: Commit**

```bash
git add data/known-addresses.json
git commit -m "data(known-addresses): expand sanctioned/mixer/bridge/exchange coverage, add provenance"
```

---

### Task 4: Update the data README

**Files:**
- Modify: `data/README.md`

- [ ] **Step 1: Rewrite the `known-addresses.json` section**

Replace the field-contract paragraph so it:
- documents the extended record `{ label, category, source?, added? }`;
- references `KNOWN_CATEGORIES` in `src/config.js` as the source of truth for `category`;
- **drops** the "free-form until Stage D fixes the enum" sentence;
- adds the disclaimer verbatim:

> **This is a dated, hand-curated snapshot of publicly documented addresses — not an authoritative or live OFAC feed. Verify against the live OFAC SDN list before acting on any `sanctioned` label.**

- [ ] **Step 2: Verify no test references the old wording**

Run: `bun test`
Expected: PASS (README is docs-only; no test asserts its text).

- [ ] **Step 3: Commit**

```bash
git add data/README.md
git commit -m "docs(data): document known-addresses provenance fields + OFAC-snapshot disclaimer"
```

---

### Task 5: Backward-compat test for extended records

**Files:**
- Modify: `test/knownAddresses.test.js` (append one test)

**Interfaces:**
- Consumes: `knownLabel`, `knownCategory`, `chainsForKnownAddress` from `src/knownAddresses.js` (unchanged).

Proves the loader/lookups ignore the new `source`/`added` fields and still resolve `label`/`category`.

- [ ] **Step 1: Write the failing-then-passing test**

Append to `test/knownAddresses.test.js`:

```js
const EXT_DATA = {
  "1": {
    "0xabc0000000000000000000000000000000000001": {
      label: "Tornado Cash: 100 ETH",
      category: "mixer",
      source: "OFAC SDN 2022-08-08",
      added: "2026-07-12",
    },
  },
};

test("extended records (source/added) still resolve label/category and chains", () => {
  expect(knownLabel("0xABC0000000000000000000000000000000000001", 1, EXT_DATA)).toBe("Tornado Cash: 100 ETH");
  expect(knownCategory("0xabc0000000000000000000000000000000000001", 1, EXT_DATA)).toBe("mixer");
  expect(chainsForKnownAddress("0xabc0000000000000000000000000000000000001", EXT_DATA)).toEqual([
    { chainId: 1, label: "Tornado Cash: 100 ETH", category: "mixer" },
  ]);
});
```

- [ ] **Step 2: Run the test**

Run: `bun test test/knownAddresses.test.js`
Expected: PASS immediately — the lookups only read `label`/`category`, so the extra fields are transparently ignored. (This is a regression guard, so a green run on first try is the correct outcome.)

- [ ] **Step 3: Commit**

```bash
git add test/knownAddresses.test.js
git commit -m "test(known-addresses): lookups ignore extra provenance fields (backward compat)"
```

---

### Task 6: Surface `source` in the node-details panel (optional, low-risk)

**Files:**
- Modify: `src/ui.js` (`renderNodeDetails`, ~line 92-120), `src/main.js` (wire a `getKnownSource` dep), `src/locales/en.js` + `src/locales/fr.js` (one key each)

**Interfaces:**
- Consumes: the details-panel `deps` object already passed to `renderNodeDetails`. Adds an optional `deps.getKnownSource?:(addr:string)=>(string|null)`.
- Produces: a new i18n key `details.source` (en + fr).

Implements spec §4 (name the `source` in the details panel). Skippable — the flag escalation already surfaces the category on the graph; do this only if the details panel should show provenance.

- [ ] **Step 1: Add the i18n key to both locales**

In `src/locales/en.js` (near the other `details.*` keys):
```js
"details.source": "Source",
```
In `src/locales/fr.js`:
```js
"details.source": "Source",
```

- [ ] **Step 2: Run the locale-parity test**

Run: `bun test test/locales.test.js`
Expected: PASS (both locales gained the same key — parity holds).

- [ ] **Step 3: Render the source row when present**

In `src/ui.js`, inside `renderNodeDetails`, after the `details.address` row (line ~107), add:

```js
const knownSource = deps.getKnownSource && deps.getKnownSource(node.address);
if (knownSource) {
  table.appendChild(detailRow(i18n.t("details.source"), knownSource));
}
```

`knownSource` is a bundled-JSON string; `detailRow` renders it via `textContent` (no innerHTML), so it stays XSS-safe by construction.

- [ ] **Step 4: Wire the dependency in main.js**

Where `renderNodeDetails(...)` is called in `src/main.js`, add to its `deps` object (alongside the existing `getKnownLabel`):

```js
getKnownSource: (a) => {
  const chain = knownData[String($("chainSelect").value)];
  const entry = chain && chain[String(a).toLowerCase()];
  return entry && entry.source ? entry.source : null;
},
```

(Match the exact `knownData` / `$("chainSelect")` access pattern already used for `getKnownLabel` in `main.js` — grep `getKnownLabel` to find the call site and mirror it.)

- [ ] **Step 5: Manual smoke + full test run**

Run: `bun test`
Expected: PASS.

Manual: serve (`python3 -m http.server 8000`), scan an address that includes a known entity with a `source`, click that node → the details panel shows a **Source** row with the provenance string. A node without a source shows no such row.

- [ ] **Step 6: Commit**

```bash
git add src/ui.js src/main.js src/locales/en.js src/locales/fr.js
git commit -m "feat(details): show known-address provenance (source) in the node panel"
```

---

## Self-Review

**Spec coverage:**
- §1 dataset expansion → Task 3. §2 honesty rails (`source`/`added`, disclaimer) → Task 3 (fields) + Task 4 (disclaimer). §3 enum formalization → Task 1 + Task 4 (README ref) + Task 2 (enforced). §4 UI (name category/source, escaped) → Task 6 (source row; category already surfaced by existing flag escalation). Tests §→ Tasks 1, 2, 5. Out-of-scope items (live feeds, clustering, new filters) → not implemented, as specified.
- No gap: every spec section maps to a task.

**Placeholder scan:** No "TBD/TODO". Task 3 addresses are a **provenance requirement** (verify-then-add), not a lazy placeholder — fabricating hex would be the failure; the schema, entity list, sources, and verification command are all concrete.

**Type consistency:** `KNOWN_CATEGORIES` (array) used identically in Tasks 1/2. `getKnownSource` signature `(addr)=>string|null` consistent between ui.js consumption (Task 6 Step 3) and main.js production (Task 6 Step 4). Entry record `{label, category, source?, added?}` consistent across Tasks 2/3/5/6. Test import style (`bun:test`) matches existing suites.
