# ChainMap Investigator Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn raw calldata into human-readable intent, surface high-signal risk (approvals / mixers / hidden recipients / peel chains) directly on the graph, add one-click reversible faucet/sink hiding + Ctrl-Arrow node navigation, and export the decoded data — all without breaking the app's existing invariants.

**Architecture:** All new decision logic lands in pure, DOM-free modules (`riskFlags.js`, `peelChain.js`, plus additions to `abiDecode.js`/`selectors.js`/`sinkFaucet.js`) with bun/happy-dom tests. The `render/*` + `ui.js` + `main.js` layers consume those pure results and mutate only vis DataSets / DataViews. The store stays the one source of truth; every new "hide"/"overlay" is a display projection over it.

**Tech Stack:** Native ES modules (no bundler), vis-network 10.1.0 (vendored), bun test + happy-dom (dev only), BigInt for amounts.

## Global Constraints

Copied verbatim from the design spec — every task's requirements implicitly include these:

- Pure DOM-free logic modules with Node (bun) tests; DOM/vis only in `render/*`, `ui.js`, `main.js`.
- `graphStore` is the ONE source of truth; view mirrors it; filters/overlays are a display projection (store keeps the full graph so CSV/detail stay complete).
- No untrusted string reaches `innerHTML` — user/API/decoded strings go via `textContent`/escaped DOM nodes only.
- Strict CSP unchanged (script-src 'self'; connect-src api.etherscan.io + same-origin data). No new network origins, no new deps, `vendor/` untouched.
- Addresses lowercased, canonical node id; display labels never change ids.
- Amounts are base-unit integer strings via `formatUnits` (BigInt); on bad decimals → `indeterminate`, never a silent "0".
- i18n: no hardcoded UI text in logic. Logic emits `{level?, key, params}`; `ui`+`i18n` render. **Every new key MUST be added to BOTH `src/locales/en.js` and `src/locales/fr.js`** — `test/locales.test.js` enforces parity and will fail otherwise.
- Run `bun test` after every task; it must stay green.
- Commit after each task. Author/committer email is the repo default (do not pass `-c`); no AI attribution in messages.

---

## Task 1: Retitle to "ChainMap — Follow the money"

**Files:**
- Modify: `index.html:26` (`<title>`), `index.html:37` (`<h1 data-i18n="app.title">`)
- Modify: `src/locales/en.js` (`app.title`)
- Modify: `src/locales/fr.js` (`app.title`)
- Test: `test/locales.test.js` (existing parity test covers it; no new test needed)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Update the HTML title tag**

In `index.html` line 26, replace:
```html
<title>Etherscan Tx Graph Explorer</title>
```
with:
```html
<title>ChainMap — Follow the money</title>
```

- [ ] **Step 2: Update the h1 fallback text**

In `index.html` line 37, replace:
```html
<h1 data-i18n="app.title">Etherscan Tx Graph Explorer</h1>
```
with:
```html
<h1 data-i18n="app.title">ChainMap — Follow the money</h1>
```

- [ ] **Step 3: Update the en locale**

In `src/locales/en.js`, change the `"app.title"` value:
```js
  "app.title": "ChainMap — Follow the money",
```

- [ ] **Step 4: Update the fr locale**

In `src/locales/fr.js`, change the `"app.title"` value (find the existing `"app.title"` key):
```js
  "app.title": "ChainMap — Suivez l'argent",
```

- [ ] **Step 5: Run the locale parity test**

Run: `bun test test/locales.test.js`
Expected: PASS (both locales still have identical key sets).

- [ ] **Step 6: Commit**

```bash
git add index.html src/locales/en.js src/locales/fr.js
git commit -m "feat(ui): rename app to ChainMap — Follow the money"
```

---

## Task 2: Named calldata args + plain-language summary

**Files:**
- Modify: `src/selectors.js` (add `SELECTOR_PARAMS` + `paramNames`)
- Modify: `src/abiDecode.js` (attach `name` to args; add `summarizeCall`)
- Test: `test/selectors.test.js`, `test/abiDecode.test.js`

**Interfaces:**
- Consumes: existing `SELECTORS`, `decodeCall`.
- Produces:
  - `paramNames(selector: string): string[] | null` — ordered param names for a known selector.
  - `decodeCall(input)` args gain optional `name`: `{ type:string, value:string, name?:string }[]`.
  - `summarizeCall(call: {methodId:string, args:{type,value,name?}[]}): {key:string, params:object} | null` — raw param values; the render layer resolves/escapes/formats them.

- [ ] **Step 1: Write failing test for `paramNames` + arity**

Add to `test/selectors.test.js`:
```js
import { SELECTORS, SELECTOR_PARAMS, paramNames } from "../src/selectors.js";

test("paramNames returns ordered names for known selector", () => {
  expect(paramNames("0xa9059cbb")).toEqual(["recipient", "amount"]);
  expect(paramNames("0xA9059CBB")).toEqual(["recipient", "amount"]); // case-insensitive
  expect(paramNames("0xdeadbeef")).toBeNull();
});

test("every SELECTOR_PARAMS key exists in SELECTORS", () => {
  for (const sel of Object.keys(SELECTOR_PARAMS)) {
    expect(SELECTORS[sel]).toBeDefined();
  }
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test test/selectors.test.js`
Expected: FAIL (`SELECTOR_PARAMS`/`paramNames` undefined).

- [ ] **Step 3: Add `SELECTOR_PARAMS` + `paramNames` to `src/selectors.js`**

Append before the final `export function methodName` (or at end of file):
```js
/** selector -> ordered parameter names (for the selectors we decode). Names are
 *  the canonical argument roles an investigator cares about, not just types. */
export const SELECTOR_PARAMS = {
  "0xa9059cbb": ["recipient", "amount"],
  "0x23b872dd": ["from", "recipient", "amount"],
  "0x095ea7b3": ["spender", "amount"],
  "0x39509351": ["spender", "addedValue"],
  "0xa457c2d7": ["spender", "subtractedValue"],
  "0x42966c68": ["amount"],
  "0xa22cb465": ["operator", "approved"],
  "0x42842e0e": ["from", "recipient", "tokenId"],
  "0x40c10f19": ["recipient", "amount"],
  "0x2e1a7d4d": ["amount"],
  "0xf2fde38b": ["newOwner"],
};

/**
 * Ordered parameter names for a known selector, or null.
 * @param {string} selector "0x" + 8 hex (case-insensitive)
 * @returns {string[]|null}
 */
export function paramNames(selector) {
  if (!selector) return null;
  return SELECTOR_PARAMS[String(selector).toLowerCase()] || null;
}
```

- [ ] **Step 4: Run the selectors test — expect PASS**

Run: `bun test test/selectors.test.js`
Expected: PASS.

- [ ] **Step 5: Write failing tests for names on decoded args + `summarizeCall`**

Add to `test/abiDecode.test.js`:
```js
import { decodeCall, summarizeCall } from "../src/abiDecode.js";

const pad = (h) => h.replace(/^0x/, "").padStart(64, "0");

test("decodeCall attaches param names for known selectors", () => {
  const addr = "0x1111111111111111111111111111111111111111";
  const d = decodeCall("0xa9059cbb" + pad(addr) + pad("64")); // transfer(0x11.., 100)
  expect(d.args[0]).toEqual({ type: "address", value: addr, name: "recipient" });
  expect(d.args[1]).toEqual({ type: "uint256", value: "100", name: "amount" });
});

test("summarizeCall builds a transfer summary key + raw params", () => {
  const addr = "0x2222222222222222222222222222222222222222";
  const d = decodeCall("0xa9059cbb" + pad(addr) + pad("64"));
  const s = summarizeCall(d);
  expect(s).toEqual({ key: "summary.transfer", params: { amount: "100", recipient: addr } });
});

test("summarizeCall handles setApprovalForAll true/false", () => {
  const op = "0x3333333333333333333333333333333333333333";
  const grant = decodeCall("0xa22cb465" + pad(op) + pad("1"));
  expect(summarizeCall(grant)).toEqual({ key: "summary.approveAll", params: { operator: op } });
  const revoke = decodeCall("0xa22cb465" + pad(op) + pad("0"));
  expect(summarizeCall(revoke)).toEqual({ key: "summary.revokeAll", params: { operator: op } });
});

test("summarizeCall returns null for unknown/undecodable calls", () => {
  expect(summarizeCall({ methodId: "0xdeadbeef", args: [] })).toBeNull();
  expect(summarizeCall(null)).toBeNull();
});
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `bun test test/abiDecode.test.js`
Expected: FAIL (`summarizeCall` undefined; args lack `name`).

- [ ] **Step 7: Attach names in `decodeCall` + add `summarizeCall` to `src/abiDecode.js`**

Update the import line at top of `src/abiDecode.js`:
```js
import { SELECTORS, paramNames } from "./selectors.js";
```

Inside `decodeCall`, after `const args = [];` and after signature is known, capture names once:
```js
  const names = paramNames(methodId) || [];
```
Then in the arg-building loop, when pushing an arg, attach the name if present. Replace the existing `args.push({ type, value });` with:
```js
      const name = names[word];
      args.push(name ? { type, value, name } : { type, value });
```
(`word` is the current static-arg index in that loop — it already exists.)

Append `summarizeCall` at end of file:
```js
/** Find a decoded arg by its role name. */
function argByName(args, name) {
  const a = (args || []).find((x) => x && x.name === name);
  return a ? a.value : null;
}

/**
 * Plain-language summary of a decoded call as an i18n message. Returns raw param
 * values (addresses / raw integers) — the RENDER layer resolves aliases + formats
 * amounts with token decimals + escapes. Null when there is nothing worth summarizing.
 * @param {{methodId:string, args:{type:string,value:string,name?:string}[]}|null} call
 * @returns {{key:string, params:object}|null}
 */
export function summarizeCall(call) {
  if (!call || !call.methodId) return null;
  const id = String(call.methodId).toLowerCase();
  const args = call.args || [];
  switch (id) {
    case "0xa9059cbb": // transfer(recipient, amount)
    case "0x40c10f19": // mint(recipient, amount)
      return { key: "summary.transfer", params: { amount: argByName(args, "amount"), recipient: argByName(args, "recipient") } };
    case "0x23b872dd": // transferFrom(from, recipient, amount)
    case "0x42842e0e": // safeTransferFrom(from, recipient, tokenId)
      return { key: "summary.transferFrom", params: { from: argByName(args, "from"), recipient: argByName(args, "recipient") } };
    case "0x095ea7b3": // approve(spender, amount)
      return { key: "summary.approve", params: { amount: argByName(args, "amount"), spender: argByName(args, "spender") } };
    case "0xa22cb465": { // setApprovalForAll(operator, approved)
      const approved = argByName(args, "approved");
      return { key: approved === "true" ? "summary.approveAll" : "summary.revokeAll", params: { operator: argByName(args, "operator") } };
    }
    case "0x2e1a7d4d": // withdraw(amount)
      return { key: "summary.withdraw", params: { amount: argByName(args, "amount") } };
    case "0xb214faa5": // Tornado deposit(bytes32)
      return { key: "summary.mixerDeposit", params: {} };
    default:
      return null;
  }
}
```

- [ ] **Step 8: Run both tests — expect PASS**

Run: `bun test test/abiDecode.test.js test/selectors.test.js`
Expected: PASS.

- [ ] **Step 9: Verify existing decode consumers still pass (backward compat)**

Run: `bun test test/graphStore.test.js`
Expected: PASS (`methodArgs` still `{type,value}`-compatible; `name` is additive).

- [ ] **Step 10: Commit**

```bash
git add src/selectors.js src/abiDecode.js test/selectors.test.js test/abiDecode.test.js
git commit -m "feat(decode): name calldata args and add plain-language call summary"
```

---

## Task 3: Risk flags (pure logic)

**Files:**
- Create: `src/riskFlags.js`
- Test: `test/riskFlags.test.js`

**Interfaces:**
- Consumes: `EdgeRecord` fields (`methodId`, `methodArgs` with names, `to`, `hasData`); `format.isValidAddress`.
- Produces:
  - `MAX_UINT256: string`
  - `flagsForEdge(edge, ctx): string[]` — ctx `{ category:(addr:string)=>string|null }`. Returns a de-duplicated list of flag keys drawn from: `flag.approvalUnlimited`, `flag.hiddenRecipient`, `flag.mixer`, `flag.bridge`, `flag.sanctioned`.
  - `resolvedRecipient(edge): string` — decoded `recipient` arg (lowercased) if present & valid, else `edge.to`.

- [ ] **Step 1: Write the failing test**

Create `test/riskFlags.test.js`:
```js
import { test, expect } from "bun:test";
import { flagsForEdge, resolvedRecipient, MAX_UINT256 } from "../src/riskFlags.js";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const noCat = { category: () => null };

test("unlimited approve to unknown spender flags approvalUnlimited", () => {
  const edge = { methodId: "0x095ea7b3", to: B, hasData: true,
    methodArgs: [{ type: "address", value: B, name: "spender" }, { type: "uint256", value: MAX_UINT256, name: "amount" }] };
  expect(flagsForEdge(edge, noCat)).toContain("flag.approvalUnlimited");
});

test("small approve does NOT flag approvalUnlimited", () => {
  const edge = { methodId: "0x095ea7b3", to: B, hasData: true,
    methodArgs: [{ type: "address", value: B, name: "spender" }, { type: "uint256", value: "1000000", name: "amount" }] };
  expect(flagsForEdge(edge, noCat)).not.toContain("flag.approvalUnlimited");
});

test("setApprovalForAll(true) flags approvalUnlimited; (false) does not", () => {
  const grant = { methodId: "0xa22cb465", to: B, hasData: true,
    methodArgs: [{ type: "address", value: B, name: "operator" }, { type: "bool", value: "true", name: "approved" }] };
  const revoke = { ...grant, methodArgs: [grant.methodArgs[0], { type: "bool", value: "false", name: "approved" }] };
  expect(flagsForEdge(grant, noCat)).toContain("flag.approvalUnlimited");
  expect(flagsForEdge(revoke, noCat)).not.toContain("flag.approvalUnlimited");
});

test("hidden recipient: decoded recipient differs from tx.to", () => {
  const edge = { methodId: "0xa9059cbb", to: A, hasData: true,
    methodArgs: [{ type: "address", value: B, name: "recipient" }, { type: "uint256", value: "5", name: "amount" }] };
  expect(flagsForEdge(edge, noCat)).toContain("flag.hiddenRecipient");
  expect(resolvedRecipient(edge)).toBe(B);
});

test("mixer flag from recipient category and from Tornado deposit selector", () => {
  const byCat = { methodId: "", to: A, hasData: false, methodArgs: [] };
  expect(flagsForEdge(byCat, { category: (a) => (a === A ? "mixer" : null) })).toContain("flag.mixer");
  const bySelector = { methodId: "0xb214faa5", to: B, hasData: true, methodArgs: [] };
  expect(flagsForEdge(bySelector, noCat)).toContain("flag.mixer");
});

test("bridge + sanctioned categories map to their flags", () => {
  const e = { methodId: "", to: A, hasData: false, methodArgs: [] };
  expect(flagsForEdge(e, { category: () => "bridge" })).toContain("flag.bridge");
  expect(flagsForEdge(e, { category: () => "sanctioned" })).toContain("flag.sanctioned");
});

test("clean plain transfer has no flags", () => {
  const edge = { methodId: "", to: A, hasData: false, methodArgs: [] };
  expect(flagsForEdge(edge, noCat)).toEqual([]);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test test/riskFlags.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/riskFlags.js`**

```js
// =============================================================================
// riskFlags.js — pure, DOM-free per-edge risk flagging. Turns a decoded edge +
// a known-category lookup into a small set of explainable flag keys the render
// layer escalates on the graph and the details panel explains. No vis, no DOM.
//
// Flags (i18n keys): flag.approvalUnlimited, flag.hiddenRecipient, flag.mixer,
// flag.bridge, flag.sanctioned. Each is a signal, NOT a verdict.
// =============================================================================

import { isValidAddress } from "./format.js";

/** 2^256 - 1, the canonical "unlimited" ERC-20 allowance. */
export const MAX_UINT256 = (2n ** 256n - 1n).toString();

/** Treat an allowance >= 2^255 as "unlimited" (covers MAX_UINT and near-max). */
const UNLIMITED_THRESHOLD = 2n ** 255n;

function argByName(args, name) {
  const a = (args || []).find((x) => x && x.name === name);
  return a ? a.value : null;
}

/**
 * The real recipient of an edge: the decoded `recipient` arg (lowercased) when
 * present and a valid address, else the tx `to`.
 * @param {import('./graphStore.js').EdgeRecord} edge
 * @returns {string}
 */
export function resolvedRecipient(edge) {
  const decoded = argByName(edge && edge.methodArgs, "recipient");
  if (decoded && isValidAddress(decoded)) return decoded.toLowerCase();
  return String((edge && edge.to) || "").toLowerCase();
}

function isUnlimited(rawAmount) {
  if (rawAmount == null) return false;
  try { return BigInt(rawAmount) >= UNLIMITED_THRESHOLD; } catch { return false; }
}

/**
 * Compute risk-flag keys for an edge.
 * @param {import('./graphStore.js').EdgeRecord} edge
 * @param {{ category:(addr:string)=>(string|null) }} ctx  known-category lookup
 * @returns {string[]} de-duplicated flag keys
 */
export function flagsForEdge(edge, ctx) {
  if (!edge) return [];
  const flags = new Set();
  const id = String(edge.methodId || "").toLowerCase();
  const args = edge.methodArgs || [];
  const category = (ctx && ctx.category) || (() => null);

  // Unlimited / blanket approvals.
  if (id === "0x095ea7b3" || id === "0x39509351") { // approve / increaseAllowance
    if (isUnlimited(argByName(args, "amount") ?? argByName(args, "addedValue"))) {
      flags.add("flag.approvalUnlimited");
    }
  }
  if (id === "0xa22cb465" && argByName(args, "approved") === "true") { // setApprovalForAll(_, true)
    flags.add("flag.approvalUnlimited");
  }

  // Hidden recipient: the real recipient in calldata != the tx target.
  const to = String(edge.to || "").toLowerCase();
  const decodedRecipient = argByName(args, "recipient");
  if (decodedRecipient && isValidAddress(decodedRecipient) && decodedRecipient.toLowerCase() !== to) {
    flags.add("flag.hiddenRecipient");
  }

  // Mixer / bridge / sanctioned by resolved recipient's known category.
  const cat = category(resolvedRecipient(edge));
  if (cat === "mixer") flags.add("flag.mixer");
  else if (cat === "bridge") flags.add("flag.bridge");
  else if (cat === "sanctioned") flags.add("flag.sanctioned");

  // Tornado deposit selector always reads as a mixer interaction.
  if (id === "0xb214faa5") flags.add("flag.mixer");

  return [...flags];
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `bun test test/riskFlags.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/riskFlags.js test/riskFlags.test.js
git commit -m "feat(risk): pure per-edge risk flags (approvals, mixer, hidden recipient)"
```

---

## Task 4: Fold flags into risk score

**Files:**
- Modify: `src/riskScore.js`
- Test: `test/riskScore.test.js` (create if absent)

**Interfaces:**
- Consumes: existing `scoreNode(input)`.
- Produces: `scoreNode` accepts two new boolean inputs — `approvalRisk`, `sanctioned` — adding reasons `risk.approval` (+2) and `risk.sanctioned` (+3). Existing behavior unchanged when both are false/absent.

- [ ] **Step 1: Write the failing test**

Create/append `test/riskScore.test.js`:
```js
import { test, expect } from "bun:test";
import { scoreNode } from "../src/riskScore.js";

test("approvalRisk adds risk.approval and +2", () => {
  const base = scoreNode({ inDeg: 0, outDeg: 0 });
  const withApproval = scoreNode({ inDeg: 0, outDeg: 0, approvalRisk: true });
  expect(withApproval.reasons).toContain("risk.approval");
  expect(withApproval.score).toBe(base.score + 2);
});

test("sanctioned adds risk.sanctioned and +3 and pushes to high", () => {
  const r = scoreNode({ inDeg: 0, outDeg: 0, sanctioned: true });
  expect(r.reasons).toContain("risk.sanctioned");
  expect(r.score).toBe(3);
  expect(r.level).toBe("med"); // 3 -> med per existing thresholds
});

test("no new flags -> unchanged", () => {
  const r = scoreNode({ inDeg: 1, outDeg: 1, onCycle: true });
  expect(r.reasons).toContain("risk.cycle");
  expect(r.reasons).not.toContain("risk.approval");
  expect(r.reasons).not.toContain("risk.sanctioned");
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test test/riskScore.test.js`
Expected: FAIL (`risk.approval`/`risk.sanctioned` not present).

- [ ] **Step 3: Extend `scoreNode` in `src/riskScore.js`**

Add to the `@typedef RiskInput` block two lines:
```js
 * @property {boolean} approvalRisk       emits an unlimited/blanket approval
 * @property {boolean} sanctioned         labeled or interacts with a sanctioned entity
```
Inside `scoreNode`, after the existing `if (i.hasContractCalls) { ... }` line and before the `known` line, add:
```js
  if (i.approvalRisk) { score += 2; reasons.push("risk.approval"); }
  if (i.sanctioned) { score += 3; reasons.push("risk.sanctioned"); }
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `bun test test/riskScore.test.js`
Expected: PASS.

- [ ] **Step 5: Add the i18n keys (both locales)**

In `src/locales/en.js` add (near the other `risk.*` keys):
```js
  "risk.approval": "unlimited token approval",
  "risk.sanctioned": "sanctioned entity",
```
In `src/locales/fr.js` add the matching keys:
```js
  "risk.approval": "approbation de jeton illimitée",
  "risk.sanctioned": "entité sanctionnée",
```

- [ ] **Step 6: Run locale parity + risk tests**

Run: `bun test test/locales.test.js test/riskScore.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/riskScore.js test/riskScore.test.js src/locales/en.js src/locales/fr.js
git commit -m "feat(risk): fold approval + sanctioned flags into node risk score"
```

---

## Task 5: Wire decode summary + flags into the details panel

**Files:**
- Modify: `src/ui.js` (`renderEdgeDetails`)
- Modify: `src/locales/en.js`, `src/locales/fr.js` (summary + flag + label keys)
- Test: manual DOM check via existing ui test harness if present; otherwise covered by locale parity + browser smoke. (Add assertions to `test/ui.test.js` if that file exists.)

**Interfaces:**
- Consumes: `summarizeCall` (Task 2), `flagsForEdge` (Task 3), `paramNames` implicitly via named args, `format.formatUnits`.
- Produces: richer edge-details DOM. `renderEdgeDetails` deps gain `getCategory:(addr)=>string|null` and `getKnownLabel:(addr)=>string|null` (both may be absent → graceful).

- [ ] **Step 1: Add imports to `src/ui.js`**

At the top of `src/ui.js`, extend imports:
```js
import { formatTimestamp, formatUnits, isValidAddress } from "./format.js";
import { methodName, paramNames } from "./selectors.js";
import { summarizeCall } from "./abiDecode.js";
import { flagsForEdge } from "./riskFlags.js";
```
(Keep the existing `TX_TYPE_GROUPS` import.)

- [ ] **Step 2: Add a value-resolver helper in `src/ui.js`**

Add near `detailRow` (module-scope, DOM-free string helpers):
```js
/** Short 0x1234…abcd form for display. */
function shortAddr(a) {
  return typeof a === "string" && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : String(a || "");
}

/** Resolve an address to "alias/known (0x1234…)" for display. */
function resolveAddr(addr, deps) {
  if (!isValidAddress(addr)) return String(addr || "");
  const label = (deps.getAlias && deps.getAlias(addr)) || (deps.getKnownLabel && deps.getKnownLabel(addr));
  return label ? `${label} (${shortAddr(addr)})` : addr;
}
```

- [ ] **Step 3: Render decoded arg names + smart values in `renderEdgeDetails`**

In `src/ui.js`, replace the existing decoded-args block:
```js
  if (edge.hasData && Array.isArray(edge.methodArgs)) {
    // Decoded leading static args (e.g. the real recipient of a transfer()).
    edge.methodArgs.forEach((a, i) => table.appendChild(detailRow(`#${i + 1} ${a.type}`, a.value)));
  }
```
with:
```js
  if (edge.hasData && Array.isArray(edge.methodArgs)) {
    // Decoded leading static args, resolved for humans: addresses -> alias/known
    // label, uint amounts -> token-formatted best-effort (raw when decimals unknown).
    edge.methodArgs.forEach((a, i) => {
      const key = a.name ? a.name : `#${i + 1} ${a.type}`;
      let val = a.value;
      if (a.type === "address") {
        val = resolveAddr(a.value, deps);
      } else if (/^u?int/.test(a.type) && /amount|value/i.test(a.name || "")) {
        const f = formatUnits(a.value, edge.tokenDecimal); // edge.tokenDecimal may be undefined -> 18
        val = f.indeterminate ? `${a.value} (raw)` : `${f.text} ${edge.symbol || ""}`.trim();
      }
      table.appendChild(detailRow(key, val));
    });
  }
```

- [ ] **Step 4: Render the summary line + risk flags**

In `renderEdgeDetails`, immediately after the method row block (`if (edge.hasData && edge.methodId) { ... }`), add:
```js
  if (edge.hasData) {
    const summary = summarizeCall({ methodId: edge.methodId, args: edge.methodArgs });
    if (summary) {
      const p = summary.params || {};
      const params = {};
      if (p.recipient != null) params.recipient = resolveAddr(p.recipient, deps);
      if (p.spender != null) params.spender = resolveAddr(p.spender, deps);
      if (p.operator != null) params.operator = resolveAddr(p.operator, deps);
      if (p.from != null) params.from = resolveAddr(p.from, deps);
      if (p.amount != null) {
        const f = formatUnits(p.amount, edge.tokenDecimal);
        params.amount = f.indeterminate ? `${p.amount}` : `${f.text} ${edge.symbol || ""}`.trim();
      }
      const em = document.createElement("strong");
      em.textContent = "► " + i18n.t(summary.key, params);
      table.appendChild(detailRow(i18n.t("details.summary"), em));
    }
  }
  {
    const flags = flagsForEdge(edge, { category: (a) => (deps.getCategory ? deps.getCategory(a) : null) });
    if (flags.length) {
      const warn = document.createElement("strong");
      warn.style.color = "#e0603a";
      warn.textContent = "⚠ " + flags.map((k) => i18n.t(k)).join(" · ");
      table.appendChild(detailRow(i18n.t("details.flags"), warn));
    }
  }
```

- [ ] **Step 5: Add all new i18n keys to BOTH locales**

In `src/locales/en.js`:
```js
  "details.summary": "Summary",
  "details.flags": "Risk flags",
  "summary.transfer": "Transfer {amount} → {recipient}",
  "summary.transferFrom": "Transfer from {from} → {recipient}",
  "summary.approve": "Approve {spender} to spend {amount}",
  "summary.approveAll": "Approve ALL tokens to {operator}",
  "summary.revokeAll": "Revoke all-token approval for {operator}",
  "summary.withdraw": "Withdraw {amount}",
  "summary.mixerDeposit": "Deposit into mixer",
  "flag.approvalUnlimited": "unlimited approval",
  "flag.hiddenRecipient": "hidden recipient (differs from tx target)",
  "flag.mixer": "mixer interaction",
  "flag.bridge": "bridge interaction",
  "flag.sanctioned": "sanctioned entity",
```
In `src/locales/fr.js` (same keys, French values):
```js
  "details.summary": "Résumé",
  "details.flags": "Signaux de risque",
  "summary.transfer": "Transfert {amount} → {recipient}",
  "summary.transferFrom": "Transfert de {from} → {recipient}",
  "summary.approve": "Autorise {spender} à dépenser {amount}",
  "summary.approveAll": "Autorise TOUS les jetons à {operator}",
  "summary.revokeAll": "Révoque l'autorisation totale pour {operator}",
  "summary.withdraw": "Retrait {amount}",
  "summary.mixerDeposit": "Dépôt dans un mixeur",
  "flag.approvalUnlimited": "autorisation illimitée",
  "flag.hiddenRecipient": "destinataire caché (diffère de la cible de la tx)",
  "flag.mixer": "interaction avec un mixeur",
  "flag.bridge": "interaction avec un pont",
  "flag.sanctioned": "entité sanctionnée",
```

- [ ] **Step 6: Verify `i18n.t` supports `{param}` interpolation**

Run: `grep -n "replace\|{.*}\|params" src/i18n.js`
Expected: confirms `i18n.t(key, params)` interpolates `{name}` tokens. If it does NOT, add interpolation to `i18n.t` (replace `{k}` with `params[k]`) as part of this step and add a test in `test/i18n.test.js` (or `test/locales.test.js`). Do not leave summary params unrendered.

- [ ] **Step 7: Wire the new deps from `main.js` into `renderEdgeDetails`**

Find where `main.js` calls `renderEdgeDetails(...)` (grep `renderEdgeDetails`). Extend its deps object with:
```js
      getAlias: (a) => store.getAlias(a),         // if not already passed
      getKnownLabel: (a) => knownLabel(a, chainId, knownData),
      getCategory: (a) => knownCategory(a, chainId, knownData),
```
`knownCategory` may not exist yet — add it in Task 6 Step 3 (it lives in `knownAddresses.js`). If Task 6 is not yet done, define a temporary inline `getCategory: () => null` and replace it in Task 6. Prefer doing Task 6 first if implementing out of order.

- [ ] **Step 8: Run locale parity + full suite**

Run: `bun test`
Expected: PASS (parity holds; no pure-module regressions).

- [ ] **Step 9: Browser smoke — decoded panel**

Run: `python3 -m http.server 8000` and open `http://localhost:8000/`. Load Demo Mode, click an edge that carries calldata (e.g. an approve/transfer). Confirm: named arg rows, a `► Summary` line, and (for an unlimited approve or mixer edge) a `⚠ Risk flags` row. No console CSP errors.

- [ ] **Step 10: Commit**

```bash
git add src/ui.js src/locales/en.js src/locales/fr.js src/main.js
git commit -m "feat(details): human-readable calldata summary + risk flags in edge panel"
```

---

## Task 6: Mixer/bridge/sanctioned category — lookup, node badge, main wiring

**Files:**
- Modify: `src/knownAddresses.js` (add `knownCategory`)
- Modify: `data/known-addresses.json` (add a few curated mixer/bridge entries)
- Modify: `src/render/network.js` (`applyNode` badge) + `src/main.js` (pass category + flag providers)
- Test: `test/knownAddresses.test.js` (create)

**Interfaces:**
- Consumes: `KnownData` shape `{ [chainId]: { [addr]: { label, category } } }`.
- Produces: `knownCategory(address, chainId, data): string|null`.

- [ ] **Step 1: Write failing test for `knownCategory`**

Create `test/knownAddresses.test.js`:
```js
import { test, expect } from "bun:test";
import { knownLabel, knownCategory } from "../src/knownAddresses.js";

const data = { "1": { "0xabc0000000000000000000000000000000000001": { label: "Tornado", category: "mixer" } } };

test("knownCategory returns category for known addr, null otherwise", () => {
  expect(knownCategory("0xABC0000000000000000000000000000000000001", 1, data)).toBe("mixer");
  expect(knownCategory("0x0000000000000000000000000000000000000009", 1, data)).toBeNull();
  expect(knownCategory("0xabc0000000000000000000000000000000000001", 137, data)).toBeNull();
  expect(knownLabel("0xabc0000000000000000000000000000000000001", 1, data)).toBe("Tornado");
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test test/knownAddresses.test.js`
Expected: FAIL (`knownCategory` undefined).

- [ ] **Step 3: Add `knownCategory` to `src/knownAddresses.js`**

Append:
```js
/**
 * Look up the known CATEGORY for an address on a chain (mixer/bridge/exchange/…).
 * @param {string} address
 * @param {number|string} chainId
 * @param {KnownData} data
 * @returns {string|null}
 */
export function knownCategory(address, chainId, data) {
  if (!data || !address) return null;
  const chain = data[String(chainId)];
  if (!chain) return null;
  const entry = chain[address.toLowerCase()];
  return entry && entry.category ? entry.category : null;
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `bun test test/knownAddresses.test.js`
Expected: PASS.

- [ ] **Step 5: Expand `data/known-addresses.json` with curated entries**

Add these verified mainnet (chain "1") entries inside the `"1"` object (append; keep JSON valid, no trailing comma on the last key):
```json
    "0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc": { "label": "Tornado Cash: 1 ETH", "category": "mixer" },
    "0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936": { "label": "Tornado Cash: 1 ETH (router)", "category": "mixer" },
    "0x722122df12d4e14e13ac3b6895a86e84145b6967": { "label": "Tornado Cash: Router", "category": "mixer" },
    "0x40ec5b33f54e0e8a33a975908c5ba1c14e5bbbdf": { "label": "Polygon (Matic): Bridge", "category": "bridge" },
    "0x8484ef722627bf18ca5ae6bcf031c23e6e922b30": { "label": "Arbitrum: Bridge", "category": "bridge" }
```
(These are well-documented public addresses; do not invent labels. If any address cannot be verified at implementation time, omit it rather than guess.)

- [ ] **Step 6: Add a node category badge in `src/render/network.js`**

In `applyNode`, after `const hub = hubFor(node.address);`, add a category-badge prefix on the title. First add a provider at the `createNetwork`/view boundary (where `getKnownLabel`/`getHubKind` are destructured from options): add `getCategory` alongside them, and:
```js
  const catFor = (address) => (getCategory ? getCategory(address) : null);
  const CAT_ICON = { mixer: "🌀", bridge: "🌉", sanctioned: "⛔" };
```
Then inside `applyNode`, extend the `title`:
```js
    const cat = catFor(node.address);
    const icon = CAT_ICON[cat] || "";
    const baseTitle = hub ? `${visual.title} · ${hub}` : visual.title;
    nodesDS.update({
      id: node.address,
      label: labels.nodeLabel(node, { addressFormat: getAddressFormat(), knownLabel }),
      color: rt ? { background: bg, border: "#e8b84f" } : bg,
      borderWidth: rt ? 3 : 1,
      title: icon ? `${icon} ${baseTitle}` : baseTitle,
    });
```
(Replace the existing `nodesDS.update({...})` call in `applyNode` with the block above; remove the now-duplicated `title:` computation.)

- [ ] **Step 7: Provide `getCategory` from `main.js`**

In `src/main.js`, where the network view options are built (grep for `getKnownLabel:` in main.js), add:
```js
    getCategory: (address) => knownCategory(address, chainId, knownData),
```
Ensure `knownCategory` is imported: update the `knownAddresses.js` import line in `main.js` to include it:
```js
import { loadKnownAddresses, knownLabel, knownCategory } from "./knownAddresses.js";
```

- [ ] **Step 8: Compute node `approvalRisk`/`sanctioned` for the risk score**

In `main.js` where `scoreNode({...})` is called (grep `scoreNode`), pass the two new inputs derived from the node's edges + category:
```js
    const outEdges = store.listEdges().filter((e) => e.from === address);
    const flags = outEdges.flatMap((e) => flagsForEdge(e, { category: (a) => knownCategory(a, chainId, knownData) }));
    // ...
    approvalRisk: flags.includes("flag.approvalUnlimited"),
    sanctioned: knownCategory(address, chainId, knownData) === "sanctioned" || flags.includes("flag.sanctioned"),
```
Import `flagsForEdge`:
```js
import { flagsForEdge } from "./riskFlags.js";
```
(If per-node edge scanning is hot, precompute a `Map<address, string[]>` of flags once per render instead of filtering inside the score loop.)

- [ ] **Step 9: Run full suite + browser smoke**

Run: `bun test`
Expected: PASS.
Then `python3 -m http.server 8000`, Demo Mode: a Tornado/bridge node shows its 🌀/🌉 icon in the hover title; a node emitting an unlimited approval reads higher risk in its details.

- [ ] **Step 10: Commit**

```bash
git add src/knownAddresses.js data/known-addresses.json src/render/network.js src/main.js test/knownAddresses.test.js
git commit -m "feat(known): mixer/bridge/sanctioned category lookup, node badge, risk wiring"
```

---

## Task 7: Risk-based edge highlight on the graph

**Files:**
- Modify: `src/render/network.js` (`applyEdge` + a flag provider) + `src/main.js`
- Test: browser smoke (edge styling is vis/DOM); pure logic already tested in Task 3.

**Interfaces:**
- Consumes: `flagsForEdge` results via an injected `getEdgeFlags(edge): string[]`.
- Produces: flagged edges render in an escalated style.

- [ ] **Step 1: Add an edge-flag provider to the network view**

In `src/render/network.js`, destructure `getEdgeFlags` from the createNetwork options (next to `getCategory`). Add near the other `*For` helpers:
```js
  const flagsForEdgeView = (edge) => (getEdgeFlags ? getEdgeFlags(edge) : []);
  const RISK_COLOR = "#e0603a"; // amber-red for flagged edges
```

- [ ] **Step 2: Escalate flagged edges in `applyEdge`**

In `applyEdge`, after `const base = labels.edgeLabel(edge);`, compute flags and adjust style. Replace the existing `edgesDS.add({...})` block with:
```js
    const flags = flagsForEdgeView(edge);
    const risky = flags.length > 0;
    const label = risky ? `${base ? base + " " : ""}⚠` : (edge.hasData ? (base ? `${base} ✱` : "✱") : base);
    const title = risky
      ? `${edgeTitle(edge, i18n)} · ⚠ ${flags.map((k) => i18n.t(k)).join(", ")}`
      : (edge.hasData ? `${edgeTitle(edge, i18n)} · ${i18n.t("legend.data")}` : edgeTitle(edge, i18n));
    edgesDS.add({
      id: edge.key,
      from: edge.from,
      to: edge.to,
      label,
      color: { color: risky ? RISK_COLOR : edgeColorFor(edge) },
      title,
      width: risky ? edgeWidth(amount, maxAmount) + 2 : edgeWidth(amount, maxAmount),
      dashes: risky ? [6, 4] : !!edge.hasData,
      data: edge,
    });
```

- [ ] **Step 3: Keep risk color through `restyleEdges`**

`restyleEdges` recomputes `color` for every edge and would overwrite the risk color. In `restyleEdges`, change the per-edge color to respect flags:
```js
    edgesDS.update(items.map((it) => {
      const risky = flagsForEdgeView(it.data).length > 0;
      return {
        id: it.id,
        width: risky ? edgeWidth(edgeAmountNumber(it.data), maxAmount) + 2 : edgeWidth(edgeAmountNumber(it.data), maxAmount),
        color: { color: risky ? RISK_COLOR : edgeColorFor(it.data) },
      };
    }));
```

- [ ] **Step 4: Provide `getEdgeFlags` from `main.js`**

In `main.js` network-view options, add:
```js
    getEdgeFlags: (edge) => flagsForEdge(edge, { category: (a) => knownCategory(a, chainId, knownData) }),
```
(`flagsForEdge` + `knownCategory` already imported in Task 6.)

- [ ] **Step 5: Run suite + browser smoke**

Run: `bun test`
Expected: PASS.
Browser: an unlimited-approval or mixer-deposit edge renders amber-red, thicker, dashed, with a ⚠ label and a flag list on hover. Plain transfers unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/render/network.js src/main.js
git commit -m "feat(graph): escalate risk-flagged edges with color, width, dashes, badge"
```

---

## Task 8: Reversible Hide faucets / Hide sinks

**Files:**
- Modify: `src/sinkFaucet.js` (add `shouldHideNode`)
- Modify: `src/render/network.js` (node DataView predicate + `setHubHidden`)
- Modify: `index.html` (two toggle controls) + `src/locales/en.js`/`fr.js`
- Modify: `src/main.js` (wire toggles)
- Test: `test/sinkFaucet.test.js`

**Interfaces:**
- Consumes: `hubMap` (address→'sink'|'faucet') already in `main.js`; `classifyHubs`.
- Produces: `shouldHideNode(hubKind, hide): boolean` where `hide = { faucet:boolean, sink:boolean }`; network `setHubHidden(hide, hubKind)` re-filters the node view.

- [ ] **Step 1: Write the failing test**

Append to `test/sinkFaucet.test.js`:
```js
import { shouldHideNode } from "../src/sinkFaucet.js";

test("shouldHideNode respects the per-kind toggle", () => {
  expect(shouldHideNode("faucet", { faucet: true, sink: false })).toBe(true);
  expect(shouldHideNode("faucet", { faucet: false, sink: false })).toBe(false);
  expect(shouldHideNode("sink", { faucet: false, sink: true })).toBe(true);
  expect(shouldHideNode(null, { faucet: true, sink: true })).toBe(false);
  expect(shouldHideNode("faucet", undefined)).toBe(false);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test test/sinkFaucet.test.js`
Expected: FAIL (`shouldHideNode` undefined).

- [ ] **Step 3: Implement `shouldHideNode` in `src/sinkFaucet.js`**

Append:
```js
/**
 * Whether a node should be hidden given the active hide toggles.
 * @param {HubKind|string|null|undefined} hubKind
 * @param {{ faucet?:boolean, sink?:boolean }} [hide]
 * @returns {boolean}
 */
export function shouldHideNode(hubKind, hide) {
  if (!hide) return false;
  if (hubKind === "faucet") return !!hide.faucet;
  if (hubKind === "sink") return !!hide.sink;
  return false;
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `bun test test/sinkFaucet.test.js`
Expected: PASS.

- [ ] **Step 5: Add the node-view hide predicate in `src/render/network.js`**

Near the top of `createNetwork` state, add:
```js
  let hubHidden = { faucet: false, sink: false }; // reversible faucet/sink hide
```
Extend the existing `nodesView` filter (line ~107-109) to also drop hidden hubs:
```js
  const nodesView = new vis.DataView(nodesDS, {
    filter: (n) => {
      if (n.group === "annotation") return true;
      if (!(visibleNodes === null || visibleNodes.has(n.id))) return false;
      const kind = getHubKind ? getHubKind(n.address) : null;
      return !shouldHideNode(kind, hubHidden);
    },
  });
```
Add `shouldHideNode` to the imports from `../sinkFaucet.js` at the top of `network.js` (add the import if `network.js` does not already import from it):
```js
import { shouldHideNode } from "../sinkFaucet.js";
```
Note: nodes carry `address` on the DataSet item (the store node record). If the DataSet item lacks `.address`, use `n.id` (ids ARE the lowercased address) — confirm and use `n.id` for `getHubKind` if needed.

Add a method on the returned view object:
```js
  function setHubHidden(next) {
    hubHidden = { faucet: !!(next && next.faucet), sink: !!(next && next.sink) };
    nodesView.refresh();
  }
```
Expose `setHubHidden` in the object `createNetwork` returns (alongside `refreshHubs`, `setRoundTrip`, etc.).

- [ ] **Step 6: Add the two toggles to `index.html`**

In the controls area near the existing hub toggle (grep `hubToggle` in `index.html`), add:
```html
<label class="ctl"><input type="checkbox" id="hideFaucetsChk"> <span data-i18n="btn.hideFaucets">Hide faucets</span></label>
<label class="ctl"><input type="checkbox" id="hideSinksChk"> <span data-i18n="btn.hideSinks">Hide sinks</span></label>
```
(Match the surrounding control markup/classes; use `data-i18n` for the label text.)

- [ ] **Step 7: Add the i18n keys (both locales)**

`src/locales/en.js`:
```js
  "btn.hideFaucets": "Hide faucets",
  "btn.hideSinks": "Hide sinks",
```
`src/locales/fr.js`:
```js
  "btn.hideFaucets": "Masquer les robinets",
  "btn.hideSinks": "Masquer les puits",
```

- [ ] **Step 8: Wire the toggles in `src/main.js`**

Near the existing `$("hubToggle")` handler, add:
```js
  function applyHubHidden() {
    if ($("hideFaucetsChk").checked || $("hideSinksChk").checked) recomputeHubs();
    view.setHubHidden({ faucet: $("hideFaucetsChk").checked, sink: $("hideSinksChk").checked });
  }
  $("hideFaucetsChk").addEventListener("change", applyHubHidden);
  $("hideSinksChk").addEventListener("change", applyHubHidden);
```
(`recomputeHubs()` already exists in `main.js` and refreshes `hubMap`; `getHubKind` used by the view must return the classification even when the dim-only `hubToggle` is off — adjust the existing `getHubKind` closure so hide works independently, e.g. `getHubKind: (a) => hubMap.get(a) || null` and compute `hubMap` whenever any hub feature is engaged.)

- [ ] **Step 9: Run suite + browser smoke**

Run: `bun test`
Expected: PASS (`shouldHideNode` unit-tested; parity holds).
Browser: check "Hide faucets" → faucet nodes + their dangling edges vanish; uncheck → they return. CSV export still includes hidden nodes (store untouched) — verify by exporting while hidden.

- [ ] **Step 10: Commit**

```bash
git add src/sinkFaucet.js src/render/network.js index.html src/locales/en.js src/locales/fr.js src/main.js test/sinkFaucet.test.js
git commit -m "feat(view): reversible Hide faucets / Hide sinks toggles (display projection)"
```

---

## Task 9: Decoded columns in CSV export

**Files:**
- Modify: `src/render/export.js` (extract `buildCsvRows`, extend header + edge rows)
- Test: `test/export.test.js` (create)

**Interfaces:**
- Consumes: `store.listNodes()`, `store.listEdges()`, `summarizeCall`/`resolvedRecipient`/`flagsForEdge`.
- Produces: `buildCsvRows(store, ctx): string[][]` — pure row builder (caveat line + header + node/edge rows). `ctx = { category:(a)=>string|null, formatTimestamp?:fn }`. `exportCsv` calls it then handles the Blob/download.

- [ ] **Step 1: Write the failing test**

Create `test/export.test.js`:
```js
import { test, expect } from "bun:test";
import { buildCsvRows } from "../src/render/export.js";

function fakeStore(nodes, edges) {
  return { listNodes: () => nodes, listEdges: () => edges };
}

test("CSV header includes decoded columns", () => {
  const rows = buildCsvRows(fakeStore([{ address: "0xa", depth: 0, isRoot: true }], []), { category: () => null });
  const header = rows[1];
  expect(header).toEqual([
    "row_type", "address", "alias", "depth", "is_root",
    "tx_type", "from", "to", "amount", "symbol", "hash", "block", "date",
    "method", "method_sig", "real_recipient", "decoded_amount", "risk_flags",
  ]);
});

test("edge row carries decoded method + real recipient + flags", () => {
  const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const edge = {
    group: "normal", from: "0xa", to: "0xtoken", amountText: "0", symbol: "", hash: "0xh", blockNumber: "1", timeStamp: "0",
    hasData: true, methodId: "0xa9059cbb",
    methodArgs: [{ type: "address", value: B, name: "recipient" }, { type: "uint256", value: "100", name: "amount" }],
  };
  const rows = buildCsvRows(fakeStore([], [edge]), { category: () => null });
  const row = rows.find((r) => r[0] === "edge");
  expect(row).toContain("transfer(address,uint256)"); // method_sig
  expect(row).toContain(B);                            // real_recipient
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test test/export.test.js`
Expected: FAIL (`buildCsvRows` not exported).

- [ ] **Step 3: Refactor `exportCsv` to use a pure `buildCsvRows` in `src/render/export.js`**

Add imports at the top of `export.js`:
```js
import { methodName } from "../selectors.js";
import { summarizeCall, decodeCall } from "../abiDecode.js";
import { resolvedRecipient, flagsForEdge } from "../riskFlags.js";
import { formatUnits } from "../format.js";
```
Replace the `CSV_HEADER` const with the extended header:
```js
const CSV_HEADER = [
  "row_type", "address", "alias", "depth", "is_root",
  "tx_type", "from", "to", "amount", "symbol", "hash", "block", "date",
  "method", "method_sig", "real_recipient", "decoded_amount", "risk_flags",
];
```
Add the pure builder (export it):
```js
/**
 * Build all CSV rows (caveat + header + node/edge rows). Pure — no DOM.
 * @param {import('../graphStore.js').GraphStore} store
 * @param {{ category:(addr:string)=>(string|null), formatTimestamp?:(t:string)=>string }} ctx
 * @returns {string[][]}
 */
export function buildCsvRows(store, ctx) {
  const fmtTs = (ctx && ctx.formatTimestamp) || formatTimestamp;
  const category = (ctx && ctx.category) || (() => null);
  const rows = [
    ["# sampling caveat: partial/sampled data (latest transactions per address per type) - not full on-chain history; not forensic-complete"],
    CSV_HEADER,
  ];
  for (const n of store.listNodes()) {
    rows.push([
      "node", n.address, n.alias || "", n.depth ?? "", n.isRoot ? "1" : "0",
      "", "", "", "", "", "", "", "",
      "", "", "", "", "",
    ]);
  }
  for (const e of store.listEdges()) {
    let method = "", sig = "", realRecipient = "", decodedAmount = "", flags = "";
    if (e.hasData) {
      sig = methodName(e.methodId) || "";
      method = e.methodId || "";
      const rr = resolvedRecipient(e);
      if (rr && rr !== (e.to || "").toLowerCase()) realRecipient = rr;
      else realRecipient = rr || "";
      const amtArg = (e.methodArgs || []).find((a) => a && /amount|value/i.test(a.name || ""));
      if (amtArg) {
        const f = formatUnits(amtArg.value, e.tokenDecimal);
        decodedAmount = f.indeterminate ? amtArg.value : f.text;
      }
      flags = flagsForEdge(e, { category }).join(";");
    }
    rows.push([
      "edge", "", "", "", "",
      e.group || "", e.from || "", e.to || "", e.amountText || "", e.symbol || "",
      e.hash || "", e.blockNumber || "", fmtTs(e.timeStamp),
      method, sig, realRecipient, decodedAmount, flags,
    ]);
  }
  return rows;
}
```
Then in `exportCsv`, replace the inline `rows` construction (the `const rows = [...]` block and the two `for` loops) with:
```js
  const rows = buildCsvRows(store, { category: (deps && deps.category) || (() => null) });
  if (rows.length <= 2) { onLog({ level: "error", key: "log.exportEmpty" }); return; }
```
Keep the existing Blob/URL/`triggerDownload`/`onLog` tail unchanged. (Remove the now-dead `nodes`/`edges` locals + empty check that referenced them.)

- [ ] **Step 4: Run the test — expect PASS**

Run: `bun test test/export.test.js`
Expected: PASS.

- [ ] **Step 5: Pass `category` into `exportCsv` from `main.js`**

Where `main.js` calls `exportCsv(store, {...})` (grep `exportCsv`), add to deps:
```js
      category: (a) => knownCategory(a, chainId, knownData),
```

- [ ] **Step 6: Run full suite + browser smoke**

Run: `bun test`
Expected: PASS.
Browser: export CSV from Demo Mode; open it — edge rows carry `method`, `method_sig`, `real_recipient`, `decoded_amount`, `risk_flags`; the sampling caveat is still line 1.

- [ ] **Step 7: Commit**

```bash
git add src/render/export.js src/main.js test/export.test.js
git commit -m "feat(export): decoded method, real recipient, amount, and risk flags in CSV"
```

---

## Task 10: Peeling-chain detection

**Files:**
- Create: `src/peelChain.js`
- Modify: `src/render/network.js` (overlay highlight + `setPeelChains`) + `src/main.js` (toggle) + `index.html` + locales
- Test: `test/peelChain.test.js`

**Interfaces:**
- Consumes: `EdgeRecord[]` (`from`,`to`,`amountText`,`timeStamp`); `display.edgeAmountNumber` basis.
- Produces: `findPeelChains(edges, opts): string[][]` — ordered address paths (length ≥ `minLen`, default 3) where each hop forwards ≥ `keepRatio` (default 0.9) of the received amount, mid-nodes are ~1-in/1-out, and time is non-decreasing.

- [ ] **Step 1: Write the failing test**

Create `test/peelChain.test.js`:
```js
import { test, expect } from "bun:test";
import { findPeelChains } from "../src/peelChain.js";

const e = (from, to, amt, t) => ({ from, to, amountText: String(amt), timeStamp: String(t) });

test("detects a clean 3-hop peel chain", () => {
  const edges = [e("0xa", "0xb", 100, 1), e("0xb", "0xc", 98, 2), e("0xc", "0xd", 97, 3)];
  const chains = findPeelChains(edges, {});
  expect(chains.length).toBe(1);
  expect(chains[0]).toEqual(["0xa", "0xb", "0xc", "0xd"]);
});

test("breaks the chain when the forwarded amount drops below keepRatio", () => {
  const edges = [e("0xa", "0xb", 100, 1), e("0xb", "0xc", 40, 2)];
  expect(findPeelChains(edges, {})).toEqual([]);
});

test("breaks when a mid-node fans out (not ~1-out)", () => {
  const edges = [e("0xa", "0xb", 100, 1), e("0xb", "0xc", 98, 2), e("0xb", "0xz", 98, 2)];
  expect(findPeelChains(edges, {})).toEqual([]);
});

test("breaks when time goes backward", () => {
  const edges = [e("0xa", "0xb", 100, 5), e("0xb", "0xc", 98, 1)];
  expect(findPeelChains(edges, {})).toEqual([]);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test test/peelChain.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/peelChain.js`**

```js
// =============================================================================
// peelChain.js — pure, DOM-free "peel chain" detection. A peel chain is a
// sequence A->B->C->… where each node forwards ~the same amount it just
// received, onward to a single next hop — the classic laundering pattern where
// value hops through fresh throwaway addresses. Node-testable; no vis, no DOM.
//
// Amount basis: parses edge.amountText (nominal per-token magnitude, NOT fiat-
// normalized) — same basis as display.edgeAmountNumber.
// =============================================================================

function amt(edge) {
  const n = Number(edge && edge.amountText);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Find peel/forwarding chains.
 * @param {import('./graphStore.js').EdgeRecord[]} edges
 * @param {{ minLen?:number, keepRatio?:number, slack?:number }} [opts]
 *   minLen   minimum node count in a chain (default 3)
 *   keepRatio forwarded/received must be >= this (default 0.9)
 *   slack    forwarded may exceed received by up to this factor (default 1.1)
 * @returns {string[][]} ordered address paths
 */
export function findPeelChains(edges, opts) {
  const o = opts || {};
  const minLen = typeof o.minLen === "number" ? o.minLen : 3;
  const keepRatio = typeof o.keepRatio === "number" ? o.keepRatio : 0.9;
  const slack = typeof o.slack === "number" ? o.slack : 1.1;

  // Build out-adjacency (distinct next hops) and in-degree over distinct senders.
  const outMap = new Map(); // addr -> [{to, edge}]
  const inSet = new Map();  // addr -> Set(from)
  const outSet = new Map(); // addr -> Set(to)
  for (const e of edges || []) {
    if (!e) continue;
    const from = String(e.from || "").toLowerCase();
    const to = String(e.to || "").toLowerCase();
    if (!from || !to || from === to) continue;
    if (!outMap.has(from)) outMap.set(from, []);
    outMap.get(from).push({ to, edge: e });
    if (!outSet.has(from)) outSet.set(from, new Set());
    outSet.get(from).add(to);
    if (!inSet.has(to)) inSet.set(to, new Set());
    inSet.get(to).add(from);
  }

  const inDeg = (a) => (inSet.has(a) ? inSet.get(a).size : 0);
  const outDeg = (a) => (outSet.has(a) ? outSet.get(a).size : 0);

  // A node is a "pass-through" if it has exactly one distinct sender and one
  // distinct recipient — value came in and went straight back out.
  const isPassThrough = (a) => inDeg(a) === 1 && outDeg(a) === 1;

  const forwards = (recvEdge, sendEdge) => {
    const recv = amt(recvEdge);
    const sent = amt(sendEdge);
    if (recv <= 0) return false;
    const r = sent / recv;
    if (Number(sendEdge.timeStamp) < Number(recvEdge.timeStamp)) return false; // time must not go backward
    return r >= keepRatio && r <= slack;
  };

  const chains = [];
  const usedStarts = new Set();

  // Start from edges whose source is NOT a pass-through (chain heads).
  for (const e of edges || []) {
    if (!e) continue;
    const from = String(e.from || "").toLowerCase();
    const to = String(e.to || "").toLowerCase();
    if (!from || !to || from === to) continue;
    if (isPassThrough(from)) continue;             // not a head
    const startKey = from + ">" + to;
    if (usedStarts.has(startKey)) continue;

    const path = [from, to];
    let recvEdge = e;
    let cursor = to;
    // Extend while the next node is a pass-through that forwards ~the same amount.
    while (isPassThrough(cursor)) {
      const outs = outMap.get(cursor) || [];
      if (outs.length !== 1) break;
      const next = outs[0];
      if (!forwards(recvEdge, next.edge)) break;
      if (path.includes(next.to)) break;           // no cycles
      path.push(next.to);
      recvEdge = next.edge;
      cursor = next.to;
    }
    if (path.length >= minLen) {
      usedStarts.add(startKey);
      chains.push(path);
    }
  }
  return chains;
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `bun test test/peelChain.test.js`
Expected: PASS.

- [ ] **Step 5: Add overlay + `setPeelChains` in `src/render/network.js`**

Add state near the top of `createNetwork`:
```js
  let peelNodes = new Set(); // addresses on a highlighted peel chain
  const PEEL_COLOR = "#7b61ff";
```
In `applyNode`, after computing `bg`, add a peel-ring override (peel takes precedence over the round-trip ring for border):
```js
    const onPeel = peelNodes.has(node.address);
```
and set border to `PEEL_COLOR` with `borderWidth: 3` when `onPeel` (fold into the existing `color`/`borderWidth` ternaries; peel border wins over round-trip).
Add the setter and expose it in the returned object:
```js
  function setPeelChains(chains) {
    peelNodes = new Set((chains || []).flat());
    store.listNodes().forEach(applyNode);
  }
```

- [ ] **Step 6: Add a toggle in `index.html` + locales + `main.js`**

`index.html` (near other overlay toggles):
```html
<label class="ctl"><input type="checkbox" id="peelChk"> <span data-i18n="btn.peelChains">Peel chains</span></label>
```
`src/locales/en.js`: `"btn.peelChains": "Peel chains",` — `src/locales/fr.js`: `"btn.peelChains": "Chaînes de pelage",`
`src/main.js`:
```js
import { findPeelChains } from "./peelChain.js";
// ...
  $("peelChk").addEventListener("change", () => {
    const on = $("peelChk").checked;
    const chains = on ? findPeelChains(store.listEdges(), {}) : [];
    view.setPeelChains(chains);
    logger.log({ level: "info", key: "log.peelChains", params: { n: chains.length } });
  });
```
Add `"log.peelChains": "Detected {n} peel chain(s)"` / `"log.peelChains": "{n} chaîne(s) de pelage détectée(s)"` to the locales.

- [ ] **Step 7: Run suite + browser smoke**

Run: `bun test`
Expected: PASS.
Browser: toggle "Peel chains"; a forwarding path lights up in violet, and the logger reports the count.

- [ ] **Step 8: Commit**

```bash
git add src/peelChain.js src/render/network.js index.html src/locales/en.js src/locales/fr.js src/main.js test/peelChain.test.js
git commit -m "feat(analysis): peel-chain detection with graph overlay"
```

---

## Task 11: Ctrl+Arrow node navigation

**Files:**
- Modify: `src/render/interaction.js` (add `nearestInDirection` + keydown handler)
- Test: `test/interaction.test.js`

**Interfaces:**
- Consumes: vis `network.getPositions()`, existing `onNodeSelect`.
- Produces: `nearestInDirection(fromPos, positions, dir): string|null` — pure geometry; `dir ∈ {"up","down","left","right"}`.

- [ ] **Step 1: Write the failing test**

Append to `test/interaction.test.js` (create if absent):
```js
import { test, expect } from "bun:test";
import { nearestInDirection } from "../src/render/interaction.js";

const positions = {
  a: { x: 0, y: 0 },
  right: { x: 10, y: 0 },
  farRight: { x: 40, y: 0 },
  up: { x: 0, y: -10 },
  left: { x: -10, y: 0 },
};

test("picks nearest node in the requested direction", () => {
  expect(nearestInDirection(positions.a, positions, "right")).toBe("right");
  expect(nearestInDirection(positions.a, positions, "up")).toBe("up");
  expect(nearestInDirection(positions.a, positions, "left")).toBe("left");
});

test("ignores nodes not in the direction cone", () => {
  const only = { a: { x: 0, y: 0 }, behind: { x: -50, y: 0 } };
  expect(nearestInDirection(only.a, only, "right")).toBeNull();
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test test/interaction.test.js`
Expected: FAIL (`nearestInDirection` not exported).

- [ ] **Step 3: Add `nearestInDirection` to `src/render/interaction.js`**

Append (exported, pure — note vis canvas y grows downward, so "up" = smaller y):
```js
/**
 * Nearest node id in a cardinal direction from a point. Pure geometry.
 * @param {{x:number,y:number}} fromPos
 * @param {Record<string,{x:number,y:number}>} positions
 * @param {"up"|"down"|"left"|"right"} dir
 * @returns {string|null}
 */
export function nearestInDirection(fromPos, positions, dir) {
  if (!fromPos) return null;
  let best = null;
  let bestScore = Infinity;
  for (const id of Object.keys(positions)) {
    const p = positions[id];
    const dx = p.x - fromPos.x;
    const dy = p.y - fromPos.y;
    if (dx === 0 && dy === 0) continue; // itself
    // Directional gate: primary axis must dominate and point the right way.
    let primary, ok;
    if (dir === "right") { primary = dx; ok = dx > 0 && Math.abs(dx) >= Math.abs(dy); }
    else if (dir === "left") { primary = -dx; ok = dx < 0 && Math.abs(dx) >= Math.abs(dy); }
    else if (dir === "up") { primary = -dy; ok = dy < 0 && Math.abs(dy) >= Math.abs(dx); }
    else { primary = dy; ok = dy > 0 && Math.abs(dy) >= Math.abs(dx); } // down
    if (!ok) continue;
    const score = primary + Math.abs(dir === "left" || dir === "right" ? dy : dx) * 0.5;
    if (score < bestScore) { bestScore = score; best = id; }
  }
  return best;
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `bun test test/interaction.test.js`
Expected: PASS.

- [ ] **Step 5: Wire the Ctrl+Arrow keydown in `attachInteractions`**

Inside `attachInteractions`, add a handler and register/detach it alongside the existing `handleKeydown`:
```js
  const ARROW_DIR = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
  function handleArrowNav(e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    const dir = ARROW_DIR[e.key];
    if (!dir) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    const { positions } = allPositions(network);
    const sel = network.getSelectedNodes();
    let fromId = sel[0];
    if (!fromId) { // seed from viewport center
      const ids = Object.keys(positions);
      if (!ids.length) return;
      const c = network.DOMtoCanvas({ x: container.clientWidth / 2, y: container.clientHeight / 2 });
      fromId = nearestInDirection(c, positions, dir) || ids[0];
    }
    const nextId = nearestInDirection(positions[fromId], positions, dir);
    if (!nextId) return;
    e.preventDefault();
    network.setSelection({ nodes: [nextId], edges: [] });
    network.focus(nextId, { scale: network.getScale(), animation: true });
    onNodeSelect(nextId);
  }
  document.addEventListener("keydown", handleArrowNav);
```
In the returned `detach()`, add:
```js
      document.removeEventListener("keydown", handleArrowNav);
```

- [ ] **Step 6: Run suite + browser smoke**

Run: `bun test`
Expected: PASS.
Browser: click a node, hold Ctrl and press an Arrow → selection jumps to the neighbor in that direction, view centers on it, details panel updates. Typing in the alias/scan inputs is unaffected.

- [ ] **Step 7: Commit**

```bash
git add src/render/interaction.js test/interaction.test.js
git commit -m "feat(nav): Ctrl+Arrow navigation between nodes"
```

---

## Task 12: Docs + interface contracts + final verification

**Files:**
- Modify: `INTERFACES.md` (contracts for `riskFlags`, `peelChain`, `summarizeCall`, `SELECTOR_PARAMS`, `shouldHideNode`, `knownCategory`, `buildCsvRows`, `nearestInDirection`)
- Modify: `CLAUDE.md` (note `SELECTOR_PARAMS` as an extendable table; mention new investigator features)
- Modify: `README.md` (feature list: smart decode, risk flags, hide faucets/sinks, peel chains, Ctrl+Arrow) — EN + FR sections

**Interfaces:** none (documentation only).

- [ ] **Step 1: Document the new pure-module contracts in `INTERFACES.md`**

Add a frozen-contract entry for each new/changed export listed above, with signature + one-line semantics (mirror the JSDoc already written in each module).

- [ ] **Step 2: Update `CLAUDE.md`**

In the "Conventions / gotchas" list, extend the "Adding a chain / tx-type / selector / known-address" line to include `SELECTOR_PARAMS` (param names) and note that a new selector should get an entry in BOTH `SELECTORS` and (if decodable) `SELECTOR_PARAMS`. Add a one-line mention of risk flags + peel chains as display projections over the store.

- [ ] **Step 3: Update `README.md` (EN + FR)**

Add the new investigator features to the feature list in both language sections. Note the sampling caveat still applies and that risk flags are signals, not verdicts.

- [ ] **Step 4: Full verification pass**

Run: `bun test`
Expected: PASS — all suites green, count increased from ~227 by the new tests (selectors, abiDecode, riskFlags, riskScore, knownAddresses, sinkFaucet, export, peelChain, interaction).

- [ ] **Step 5: Locale parity gate**

Run: `bun test test/locales.test.js`
Expected: PASS — en/fr key sets identical (all `summary.*`, `flag.*`, `risk.*`, `btn.*`, `log.*`, `details.*` keys present in both).

- [ ] **Step 6: Full browser smoke checklist**

Run: `python3 -m http.server 8000`, open `http://localhost:8000/`, Demo Mode. Verify in one pass:
- Title reads "ChainMap — Follow the money".
- Edge with calldata: named args, `► Summary`, `⚠ Risk flags` where applicable.
- Unlimited-approval / mixer edge renders amber-red + dashed + ⚠ label.
- Mixer/bridge/sanctioned node shows 🌀/🌉/⛔ in hover title.
- Hide faucets / Hide sinks toggle nodes in/out; CSV still complete while hidden.
- Peel chains overlay lights a forwarding path.
- Ctrl+Arrow moves between nodes.
- CSV export has the 5 new columns + caveat line 1.
- No CSP/console errors throughout.

- [ ] **Step 7: Commit**

```bash
git add INTERFACES.md CLAUDE.md README.md
git commit -m "docs: interface contracts + README/CLAUDE for investigator upgrade"
```

---

## Self-Review Notes (author checklist — completed at write time)

- **Spec coverage:** F1 decode → Task 2 + Task 5; F2 risk highlight → Tasks 3,4,7 + details in 5; F3 hide faucets/sinks → Task 8; F4 peel chains → Task 10; F5 mixer/bridge tagging → Task 6; F6 decoded CSV → Task 9; F7 Ctrl+Arrow → Task 11; F8 retitle → Task 1. Docs/contracts → Task 12. All eight features + two free-form asks covered.
- **Placeholder scan:** no TBD/TODO; every code step shows real code; every test step shows real assertions.
- **Type consistency:** arg shape `{type,value,name?}` consistent across Tasks 2/3/5/9; `flagsForEdge(edge, {category})` signature identical in Tasks 3,5,6,7,9; `getHubKind`/`shouldHideNode` consistent in Task 8; `nearestInDirection(fromPos, positions, dir)` consistent in Task 11.
- **Known verification gaps (flagged for implementer, not placeholders):** Task 5 Step 6 verifies `i18n.t` interpolation exists (add if missing); Task 8 Step 5 confirms whether DataSet node items expose `.address` vs using `n.id`; Task 6 Step 5 requires verifying each added known-address before committing (omit unverifiable ones — never guess a label).
