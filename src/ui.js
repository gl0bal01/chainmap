// =============================================================================
// ui.js — DOM view helpers: details-panel renderers, logger, status, sampling
// banner, outbound-request indicator. These OWN the "no untrusted string reaches
// innerHTML" rule: aliases + API token symbols are rendered via textContent /
// document.createElement (never innerHTML with interpolation), and the alias
// "Rename" control is wired with a programmatic listener, NOT an inline onclick
// with an interpolated value (a known reference-app XSS foot-gun).
//
// STAGE A: interface frozen. STAGE B: bodies implemented here.
// =============================================================================

import { formatTimestamp, formatUnits, isValidAddress } from "./format.js";
import { TX_TYPE_GROUPS } from "./config.js";
import { methodName } from "./selectors.js";
import { summarizeCall, decodeCalldataWords } from "./abiDecode.js";
import { flagsForEdge } from "./riskFlags.js";

// action -> i18n labelKey (flattened from config.TX_TYPE_GROUPS), used to render
// the edge "Type" cell (e.g. "tokentx" -> "tx.type.erc20").
const ACTION_LABEL_KEY = {};
Object.values(TX_TYPE_GROUPS).forEach((infos) => {
  infos.forEach((info) => {
    ACTION_LABEL_KEY[info.action] = info.labelKey;
  });
});

/**
 * Build a `<tr><td class="k">label</td><td>value</td></tr>` row. `value` may be
 * a plain string (set via textContent) or a DOM Node (e.g. an <a> or <em>) to
 * append directly — either way no HTML string is ever parsed.
 * @param {string} labelText
 * @param {string|Node} value
 * @returns {HTMLTableRowElement}
 */
function detailRow(labelText, value) {
  const tr = document.createElement("tr");
  const tdKey = document.createElement("td");
  tdKey.className = "k";
  tdKey.textContent = labelText;
  const tdVal = document.createElement("td");
  if (value instanceof Node) {
    tdVal.appendChild(value);
  } else {
    tdVal.textContent = value;
  }
  tr.appendChild(tdKey);
  tr.appendChild(tdVal);
  return tr;
}

/** Short 0x1234…abcd form for display. */
function shortAddr(a) {
  return typeof a === "string" && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : String(a || "");
}

/**
 * Resolve an address to "alias/known (0x1234…)" for display. Alias/known-label
 * are untrusted display strings (user aliases, bundled-JSON labels) — this
 * returns a plain string only, always rendered downstream via textContent
 * (detailRow / table cells), never innerHTML.
 * @param {string} addr
 * @param {{ getAlias?:(a:string)=>(string|null), getKnownLabel?:(a:string)=>(string|null) }} deps
 * @returns {string}
 */
function resolveAddr(addr, deps) {
  if (!isValidAddress(addr)) return String(addr || "");
  const label = (deps.getAlias && deps.getAlias(addr)) || (deps.getKnownLabel && deps.getKnownLabel(addr));
  return label ? `${label} (${shortAddr(addr)})` : addr;
}

/**
 * Build a safe explorer `<a>` link (rel="noopener", target="_blank").
 * @param {string} href
 * @param {string} text
 * @returns {HTMLAnchorElement}
 */
function explorerLink(href, text) {
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = text;
  return a;
}

/**
 * Render the node-details panel. Uses safe DOM nodes / escaped values only.
 * @param {HTMLElement} container  #detailsContent
 * @param {import('./graphStore.js').NodeRecord} node
 * @param {{ i18n:import('./i18n.js').I18n, explorer:string, onRename:(addr:string)=>void }} deps
 */
export function renderNodeDetails(container, node, deps) {
  const { i18n, explorer, onRename } = deps;
  container.replaceChildren();

  const table = document.createElement("table");

  let aliasValue;
  if (node.alias) {
    aliasValue = node.alias;
  } else {
    const em = document.createElement("em");
    em.textContent = i18n.t("details.none");
    aliasValue = em;
  }
  table.appendChild(detailRow(i18n.t("details.alias"), aliasValue));
  table.appendChild(detailRow(i18n.t("details.address"), node.address));
  table.appendChild(detailRow(i18n.t("details.depth"), String(node.depth)));
  table.appendChild(
    detailRow(i18n.t("details.root"), node.isRoot ? i18n.t("details.yes") : i18n.t("details.no"))
  );
  if (deps.risk) {
    const reasons = deps.risk.reasons.map((k) => i18n.t(k)).join(", ");
    const txt = reasons ? `${i18n.t("risk." + deps.risk.level)} — ${reasons}` : i18n.t("risk." + deps.risk.level);
    table.appendChild(detailRow(i18n.t("details.risk"), txt));
  }
  table.appendChild(
    detailRow(
      i18n.t("details.link"),
      explorerLink(`https://${explorer}/address/${node.address}`, i18n.t("details.viewOn", { explorer }))
    )
  );
  container.appendChild(table);

  const renameBtn = document.createElement("button");
  renameBtn.type = "button";
  renameBtn.style.marginTop = "8px";
  renameBtn.textContent = i18n.t("details.rename");
  renameBtn.addEventListener("click", () => onRename(node.address));
  container.appendChild(renameBtn);
}

/**
 * Render the edge-details panel (escaped symbol/alias, safe explorer links).
 * @param {HTMLElement} container
 * @param {import('./graphStore.js').EdgeRecord} edge
 * @param {{ i18n:import('./i18n.js').I18n, explorer:string,
 *           getAlias:(addr:string)=>(string|null),
 *           getKnownLabel?:(addr:string)=>(string|null),
 *           getCategory?:(addr:string)=>(string|null) }} deps
 *   getKnownLabel/getCategory are optional (graceful when absent — e.g. Feature
 *   Layer 1 known-address data not yet loaded).
 */
export function renderEdgeDetails(container, edge, deps) {
  const { i18n, explorer, getAlias } = deps;
  container.replaceChildren();

  const table = document.createElement("table");

  const typeKey = ACTION_LABEL_KEY[edge.action] || `tx.type.${edge.group}`;
  table.appendChild(detailRow(i18n.t("details.type"), i18n.t(typeKey)));
  table.appendChild(detailRow(i18n.t("details.from"), getAlias(edge.from) || edge.from));
  table.appendChild(detailRow(i18n.t("details.to"), getAlias(edge.to) || edge.to));

  let amountText = `${edge.amountText} ${edge.symbol}`;
  if (edge.amountIndeterminate) {
    amountText += ` (${i18n.t("details.decimalsUnknown")})`;
  }
  table.appendChild(detailRow(i18n.t("details.amount"), amountText));
  table.appendChild(detailRow(i18n.t("details.data"), edge.hasData ? i18n.t("details.dataYes") : i18n.t("details.no")));
  if (edge.hasData && edge.methodId) {
    const name = methodName(edge.methodId); // decoded 4-byte selector, or null if unknown
    table.appendChild(detailRow(i18n.t("details.method"), `${edge.methodId} — ${name || i18n.t("details.methodUnknown")}`));
  }
  if (edge.hasData) {
    // Plain-language summary of the decoded call (e.g. "Transfer 5 USDC -> alias
    // (0x1234…abcd)"). summarizeCall returns RAW param values; resolve/format them
    // here at the render boundary (alias/known-label lookups, token formatting).
    const summary = summarizeCall({ methodId: edge.methodId, args: edge.methodArgs });
    // Skip the row entirely when summary.params has placeholders that failed to
    // resolve (e.g. a legacy edge whose methodArgs lack `name`, so argByName found
    // nothing) — better no summary than a literal "Transfer {amount} -> {recipient}".
    // An empty params object (e.g. summary.mixerDeposit -> {}) has no placeholders
    // to fail, so it still renders.
    const summaryVals = summary ? Object.values(summary.params || {}) : [];
    const summaryHasGap = summaryVals.length > 0 && summaryVals.some((v) => v == null);
    if (summary && !summaryHasGap) {
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
    // Risk flags are computed from the edge's own signals (approvals, hidden
    // recipient, mixer/bridge/sanctioned category) regardless of hasData — a
    // plain-value transfer TO a known mixer/sanctioned address still flags.
    const flags = flagsForEdge(edge, { category: (a) => (deps.getCategory ? deps.getCategory(a) : null) });
    if (flags.length) {
      const warn = document.createElement("strong");
      warn.style.color = "#e0603a";
      warn.textContent = "⚠ " + flags.map((k) => i18n.t(k)).join(" · ");
      table.appendChild(detailRow(i18n.t("details.flags"), warn));
    }
  }
  if (edge.hasData && Array.isArray(edge.methodArgs)) {
    // Decoded leading static args, resolved for humans: addresses -> alias/known
    // label, uint amounts -> token-formatted best-effort (raw when decimals unknown).
    edge.methodArgs.forEach((a, i) => {
      const key = a.name ? a.name : `#${i + 1} ${a.type}`;
      let val = a.value;
      if (a.type === "address") {
        val = resolveAddr(a.value, deps);
      } else if (/^u?int/.test(a.type) && /amount|value/i.test(a.name || "")) {
        const f = formatUnits(a.value, edge.tokenDecimal); // edge.tokenDecimal is "" for native/unknown -> indeterminate (never a silent 18)
        val = f.indeterminate ? `${a.value} (raw)` : `${f.text} ${edge.symbol || ""}`.trim();
      }
      table.appendChild(detailRow(key, val));
    });
  }
  if (edge.hasData && edge.rawInput) {
    // Structural word-by-word breakdown of the FULL calldata layout (unlike the
    // named-args rows above, which stop at the first dynamic type). Best-effort
    // per word: an address interpretation (resolved to alias/known-label) when
    // the word looks like a left-padded 20-byte address, else the raw integer.
    const decoded = decodeCalldataWords(edge.rawInput);
    if (decoded && decoded.words.length) {
      const box = document.createElement("div");
      box.style.cssText = "display:block;max-height:10em;overflow:auto;font-family:monospace;font-size:11px";
      decoded.words.forEach((w) => {
        const line = document.createElement("div");
        const interp = w.address ? resolveAddr(w.address, deps) : (w.uint != null ? w.uint : w.hex);
        line.textContent = `#${w.index}  ${interp}`;
        line.title = w.hex; // full 32-byte word on hover (textContent-safe attribute)
        box.appendChild(line);
      });
      table.appendChild(detailRow(i18n.t("details.decodedInput"), box));
    }
  }
  if (edge.hasData && edge.rawInput) {
    // Full raw calldata hex — untrusted, so rendered as textContent in a
    // scrollable monospace block (never parsed as HTML).
    const code = document.createElement("code");
    code.textContent = edge.rawInput;
    code.style.cssText = "display:block;max-height:8em;overflow:auto;word-break:break-all";
    table.appendChild(detailRow(i18n.t("details.inputRaw"), code));
  }
  table.appendChild(detailRow(i18n.t("details.block"), edge.blockNumber));
  table.appendChild(detailRow(i18n.t("details.date"), formatTimestamp(edge.timeStamp, i18n.getLocale())));
  table.appendChild(
    detailRow(
      i18n.t("details.link"),
      explorerLink(`https://${explorer}/tx/${edge.hash}`, i18n.t("details.viewTx"))
    )
  );

  container.appendChild(table);
}

/**
 * Render the details panel for a BUNDLED edge (collapsed A->B transfers).
 * @param {HTMLElement} container
 * @param {import('./display.js').BundledEdge} bundle
 * @param {{ i18n:import('./i18n.js').I18n, explorer:string,
 *           getAlias:(addr:string)=>(string|null) }} deps
 */
export function renderBundleDetails(container, bundle, deps) {
  const { i18n, explorer, getAlias } = deps;
  container.replaceChildren();
  const table = document.createElement("table");
  table.appendChild(detailRow(i18n.t("details.type"), i18n.t("details.bundleType")));
  table.appendChild(detailRow(i18n.t("details.from"), getAlias(bundle.from) || bundle.from));
  table.appendChild(detailRow(i18n.t("details.to"), getAlias(bundle.to) || bundle.to));
  table.appendChild(detailRow(i18n.t("details.count"), String(bundle.count)));
  table.appendChild(detailRow(i18n.t("details.total"), `${bundle.totalText} ${bundle.symbol}`.trim()));
  if (bundle.from && bundle.to) {
    table.appendChild(
      detailRow(
        i18n.t("details.link"),
        explorerLink(`https://${explorer}/address/${bundle.from}`, i18n.t("details.viewOn", { explorer }))
      )
    );
  }
  container.appendChild(table);
}

/**
 * Create a logger bound to the #logContent element. Messages are localized keys
 * resolved via i18n and appended as textContent lines (timestamped).
 * @param {HTMLElement} container
 * @param {import('./i18n.js').I18n} i18n
 * @returns {{ log:(e:{level:'info'|'error', key:string, params?:object})=>void, clear:()=>void }}
 */
export function createLogger(container, i18n) {
  function log(entry) {
    const line = document.createElement("div");
    if (entry.level === "error") line.className = "err";
    const time = new Date().toLocaleTimeString();
    line.textContent = `[${time}] ${i18n.t(entry.key, entry.params)}`;
    container.appendChild(line);
    container.scrollTop = container.scrollHeight;
  }
  function clear() {
    container.replaceChildren();
  }
  return { log, clear };
}

/**
 * Create a status-line setter bound to #status.
 * @param {HTMLElement} element
 * @returns {{ set:(text:string)=>void, clear:()=>void }}
 */
export function createStatus(element) {
  function set(text) {
    element.textContent = text;
  }
  function clear() {
    element.textContent = "";
  }
  return { set, clear };
}

/**
 * Live outbound-request indicator (privacy transparency): flip between idle and
 * "contacting api.etherscan.io" states.
 * @param {HTMLElement} element
 * @param {import('./i18n.js').I18n} i18n
 * @returns {{ setActive:(active:boolean)=>void }}
 */
export function createRequestIndicator(element, i18n) {
  function setActive(active) {
    element.classList.toggle("active", !!active);
    element.textContent = i18n.t(active ? "privacy.indicator.active" : "privacy.indicator.idle");
  }
  return { setActive };
}
