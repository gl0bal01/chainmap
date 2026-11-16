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

import { formatTimestamp, formatUnits, isValidAddress, shortAddress } from "./format.js";
import { TX_TYPE_GROUPS } from "./config.js";
import { methodName } from "./selectors.js";
import { summarizeCall, decodeCalldataWords, decodeInputText } from "./abiDecode.js";
import { flagsForEdge } from "./riskFlags.js";
import { delayParts } from "./depositDetect.js";

// action -> i18n labelKey (flattened from config.TX_TYPE_GROUPS), used to render
// the edge "Type" cell (e.g. "tokentx" -> "tx.type.erc20").
const ACTION_LABEL_KEY = {};
Object.values(TX_TYPE_GROUPS).forEach((infos) => {
  infos.forEach((info) => {
    ACTION_LABEL_KEY[info.action] = info.labelKey;
  });
});

// "Check other chains" result state -> details line text key.
const PROBE_STATE_KEY = { active: "details.probeActive", inactive: "details.probeNone", plan: "details.probePlan", error: "details.probeError" };

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
 * @param {{ i18n:import('./i18n.js').I18n, explorer:(string|null), onRename:(id:string)=>void,
 *           getKnownSource?:(addr:string)=>(string|null),
 *           history?:Array<{action:string,labelKey:string,state:'unloaded'|'more'|'complete',count:number}>,
 *           pageSize?:number, onLoadOlder?:()=>void, busy?:boolean,
 *           loadBlocked?:({key:string,params?:object}|null) }} deps
 *   getKnownSource is optional (graceful when absent, e.g. known-address data not yet
 *   loaded) — provenance string for a known-address entry, rendered only when truthy.
 *   history/pageSize/onLoadOlder/busy/loadBlocked are optional: a non-empty `history`
 *   (from `historyState`, plus each type's `labelKey`) adds the History row and a Load
 *   button (+`pageSize`) whose click calls `onLoadOlder`; the button is disabled when every
 *   type is complete, while `busy`, or when `loadBlocked` (a localized refusal) is set.
 *   `deposit` (DepositEvidence|null, optional) adds the Exchange deposit row after Risk.
 *   A null `explorer` (unknown chain) omits the Link row.
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
  const knownSource = deps.getKnownSource && deps.getKnownSource(node.address);
  if (knownSource) {
    table.appendChild(detailRow(i18n.t("details.source"), knownSource));
  }
  table.appendChild(detailRow(i18n.t("details.depth"), String(node.depth)));
  table.appendChild(
    detailRow(i18n.t("details.root"), node.isRoot ? i18n.t("details.yes") : i18n.t("details.no"))
  );
  if (deps.risk) {
    const reasons = deps.risk.reasons.map((k) => i18n.t(k)).join(", ");
    const txt = reasons ? `${i18n.t("risk." + deps.risk.level)} — ${reasons}` : i18n.t("risk." + deps.risk.level);
    table.appendChild(detailRow(i18n.t("details.risk"), txt));
  }
  if (deps.deposit) {
    const d = deps.deposit;
    const lines = [
      i18n.t("deposit.of", { label: d.label }),
      i18n.t("deposit.swept", { swept: d.swept, outgoing: d.outgoing }),
      ...d.assets.map((x) => i18n.t("deposit.share", { pct: x.sharePct, symbol: x.symbol })),
    ];
    if (d.maxDelaySec != null) {
      const p = delayParts(d.maxDelaySec);
      lines.push(i18n.t("deposit.delay", { delay: i18n.t(p.key, p.params), timed: d.timedSweeps, swept: d.swept }));
    } else {
      lines.push(i18n.t("deposit.noInflow"));
    }
    lines.push(i18n.t("deposit.sampled"));
    const box = document.createElement("div");
    for (const l of lines) {
      const row = document.createElement("div");
      row.textContent = l;
      box.appendChild(row);
    }
    table.appendChild(detailRow(i18n.t("details.deposit"), box));
  }
  // An empty list (no tx type selected) renders neither the row nor the button.
  if (deps.history && deps.history.length) {
    const lines = deps.history.map(
      (h) => `${i18n.t(h.labelKey)}: ${i18n.t("history." + h.state, { count: h.count })}`
    );
    const box = document.createElement("div");
    lines.forEach((l) => {
      const d = document.createElement("div");
      d.textContent = l;
      box.appendChild(d);
    });
    table.appendChild(detailRow(i18n.t("details.history"), box));
  }
  if (explorer) {
    table.appendChild(
      detailRow(
        i18n.t("details.link"),
        explorerLink(`https://${explorer}/address/${node.address}`, i18n.t("details.viewOn", { explorer }))
      )
    );
  }
  container.appendChild(table);

  const renameBtn = document.createElement("button");
  renameBtn.type = "button";
  renameBtn.style.marginTop = "8px";
  renameBtn.textContent = i18n.t("details.rename");
  renameBtn.addEventListener("click", () => onRename(node.id));
  container.appendChild(renameBtn);

  if (deps.history && deps.history.length) {
    const hs = deps.history;
    const n = deps.pageSize;
    const allComplete = hs.every((h) => h.state === "complete");
    const allUnloaded = hs.every((h) => h.state === "unloaded");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.style.marginTop = "8px";
    btn.textContent = allComplete
      ? i18n.t("details.historyComplete")
      : i18n.t(allUnloaded ? "details.loadFirst" : "details.loadOlder", { n });
    btn.disabled = allComplete || !!deps.busy || !!deps.loadBlocked;
    btn.addEventListener("click", () => {
      btn.disabled = true;
      deps.onLoadOlder();
    });
    container.appendChild(btn);
    if (deps.loadBlocked) {
      const note = document.createElement("small");
      note.id = "loadBlockedNote";
      btn.setAttribute("aria-describedby", note.id);
      note.style.marginLeft = "8px";
      note.textContent = i18n.t(deps.loadBlocked.key, deps.loadBlocked.params);
      container.appendChild(note);
    }
  }

  const oc = deps.otherChains;
  if (oc) {
    const box = document.createElement("div");
    if (!oc.twins.length) {
      const em = document.createElement("em");
      em.textContent = i18n.t("details.none");
      box.appendChild(em);
    }
    for (const tw of oc.twins) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = `${tw.chainName} — ${i18n.t(tw.basis === "key" ? "details.twinKey" : "details.twinAddress")}`;
      b.addEventListener("click", () => oc.onFocusTwin(tw.id));
      box.appendChild(b);
    }
    if (oc.canApplyAlias) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = i18n.t("details.applyAlias");
      b.disabled = !!deps.busy;
      b.addEventListener("click", () => oc.onApplyAlias());
      box.appendChild(b);
    }
    const actionBtn = (text, onClick) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.disabled = !!deps.busy;
      b.addEventListener("click", onClick);
      return b;
    };
    const loadable = oc.loadable || [];
    const loadText = (chainId) => i18n.t("details.loadOnChain", { chain: loadable.find((c) => c.chainId === chainId)?.name });
    if (oc.onCheckOtherChains) box.appendChild(actionBtn(i18n.t("details.checkOtherChains"), () => oc.onCheckOtherChains()));
    for (const r of oc.probe || []) {
      const line = document.createElement("div");
      line.textContent = `${r.name} — ${i18n.t(PROBE_STATE_KEY[r.state])}`;
      if (r.state === "active" && loadable.some((c) => c.chainId === r.chainId)) {
        line.appendChild(document.createTextNode(" "));
        line.appendChild(actionBtn(loadText(r.chainId), () => oc.onLoadOnChain(r.chainId)));
      }
      box.appendChild(line);
    }
    if (loadable.length) {
      const sel = document.createElement("select");
      sel.setAttribute("aria-label", i18n.t("details.otherChains"));
      for (const c of loadable) {
        const opt = document.createElement("option");
        opt.value = c.chainId;
        opt.textContent = c.name;
        sel.appendChild(opt);
      }
      const load = actionBtn(loadText(sel.value), () => oc.onLoadOnChain(sel.value));
      sel.addEventListener("change", () => (load.textContent = loadText(sel.value)));
      const row = document.createElement("div");
      row.append(sel, " ", load);
      box.appendChild(row);
    }
    const t2 = document.createElement("table");
    t2.style.marginTop = "8px";
    t2.appendChild(detailRow(i18n.t("details.otherChains"), box));
    container.appendChild(t2);
  }
}

/**
 * Render the edge-details panel (escaped symbol/alias, safe explorer links).
 * @param {HTMLElement} container
 * @param {import('./graphStore.js').EdgeRecord} edge
 * @param {{ i18n:import('./i18n.js').I18n, explorer:(string|null),
 *           getAlias:(addr:string)=>(string|null),
 *           getKnownLabel?:(addr:string)=>(string|null),
 *           getCategory?:(addr:string)=>(string|null),
 *           isFakeToken?:(edge:import('./graphStore.js').EdgeRecord)=>boolean }} deps
 *   getKnownLabel/getCategory/isFakeToken are optional (graceful when absent — e.g.
 *   Feature Layer 1 known-address data not yet loaded). A null `explorer` omits the Link row.
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
    const flags = flagsForEdge(edge, { category: (a) => (deps.getCategory ? deps.getCategory(a) : null), isFakeToken: deps.isFakeToken });
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
        let interp;
        if (w.address) {
          interp = `${w.uint != null ? w.uint : w.hex}  ·  addr? ${resolveAddr(w.address, deps)}`;
        } else {
          interp = w.uint != null ? w.uint : w.hex;
        }
        line.textContent = `#${w.index}  ${interp}`;
        line.title = w.hex; // full 32-byte word on hover (textContent-safe attribute)
        box.appendChild(line);
      });
      table.appendChild(detailRow(i18n.t("details.decodedInput"), box));
    }
  }
  if (edge.hasData && edge.rawInput) {
    // Best-effort human-readable text hidden in the calldata (on-chain messages,
    // notes). Absent for pure ABI binary — the decoder gates those out. Untrusted,
    // so rendered as textContent (never HTML).
    const text = decodeInputText(edge.rawInput);
    if (text) {
      const box = document.createElement("div");
      box.textContent = text;
      box.style.cssText = "white-space:pre-wrap;word-break:break-word;max-height:8em;overflow:auto";
      table.appendChild(detailRow(i18n.t("details.inputText"), box));
    }
    // Full raw calldata hex — untrusted, so rendered as textContent in a
    // scrollable monospace block (never parsed as HTML).
    const code = document.createElement("code");
    code.textContent = edge.rawInput;
    code.style.cssText = "display:block;max-height:8em;overflow:auto;word-break:break-all";
    table.appendChild(detailRow(i18n.t("details.inputRaw"), code));
  }
  table.appendChild(detailRow(i18n.t("details.block"), edge.blockNumber));
  table.appendChild(detailRow(i18n.t("details.date"), formatTimestamp(edge.timeStamp, i18n.getLocale())));
  if (explorer) {
    table.appendChild(
      detailRow(
        i18n.t("details.link"),
        explorerLink(`https://${explorer}/tx/${edge.hash}`, i18n.t("details.viewTx"))
      )
    );
  }

  container.appendChild(table);
}

/**
 * Render the details panel for a BUNDLED edge (collapsed A->B transfers).
 * @param {HTMLElement} container
 * @param {import('./display.js').BundledEdge} bundle
 * @param {{ i18n:import('./i18n.js').I18n, explorer:(string|null),
 *           getAlias:(addr:string)=>(string|null) }} deps  null `explorer` omits the Link row
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
  if (explorer && bundle.from && bundle.to) {
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
 * Details for a same-key overlay link (not a transaction). Strings via textContent.
 * @param {HTMLElement} container
 * @param {{ address:string, chains:[string,string] }} link
 * @param {{ i18n:import('./i18n.js').I18n }} deps
 */
export function renderTwinDetails(container, link, { i18n }) {
  container.replaceChildren();
  const table = document.createElement("table");
  table.appendChild(detailRow(i18n.t("details.type"), i18n.t("details.twinType")));
  table.appendChild(detailRow(i18n.t("details.address"), link.address));
  table.appendChild(detailRow(i18n.t("filters.chains"), `${link.chains[0]} ↔ ${link.chains[1]}`));
  container.appendChild(table);
  const note = document.createElement("p");
  note.className = "hint";
  note.textContent = i18n.t("details.twinKeyNote");
  container.appendChild(note);
}

/**
 * Chain visibility checkboxes (checked = visible); names via textContent.
 * @param {HTMLElement} container
 * @param {{ chains:Array<{chainId:string,name:string}>, hidden:Set<string>,
 *           onToggle:(chainId:string, visible:boolean)=>void }} deps
 */
export function renderChainFilter(container, { chains, hidden, onToggle }) {
  container.replaceChildren(
    ...chains.map(({ chainId, name }) => {
      const label = document.createElement("label");
      label.className = "field check";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.chain = chainId;
      input.checked = !hidden.has(chainId);
      input.addEventListener("change", () => onToggle(chainId, input.checked));
      const span = document.createElement("span");
      span.textContent = name;
      label.append(input, " ", span);
      return label;
    }),
  );
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

const QUERY_LOG_ROWS = 200;
const QUERY_LOG_COLS = ["time", "chain", "action", "address", "page", "http", "rows", "sha256", "outcome"];

/** Query-log table, newest first. Every value (all untrusted) goes in via textContent. */
export function renderQueryLog(container, entries, { i18n, dropped, unloggedData, limit }) {
  container.textContent = "";
  const note = (text) => {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = text;
    container.appendChild(p);
  };
  const n = entries.length;
  if (n > QUERY_LOG_ROWS) note(i18n.t("queryLog.showing", { shown: QUERY_LOG_ROWS, n }));
  if (dropped > 0) note(i18n.t("queryLog.dropped", { n: dropped, limit }));
  if (unloggedData) note(i18n.t("queryLog.unlogged"));
  if (!n) { note(i18n.t("queryLog.empty")); return; }

  const wrap = document.createElement("div");
  wrap.className = "qlog";
  const table = document.createElement("table");
  const headRow = table.createTHead().insertRow();
  for (const c of QUERY_LOG_COLS) {
    const th = document.createElement("th");
    th.textContent = i18n.t("queryLog.col." + c);
    headRow.appendChild(th);
  }
  const body = table.createTBody();
  for (const e of entries.slice(-QUERY_LOG_ROWS).reverse()) {
    const tr = body.insertRow();
    const cell = (text, title) => {
      const td = tr.insertCell();
      td.textContent = text;
      if (title) td.title = title;
    };
    cell(e.at.slice(0, 19).replace("T", " "));
    cell(e.chainId);
    cell(e.action);
    cell(shortAddress(e.params.address), e.params.address);
    cell(`${e.params.page}/${e.params.offset}`);
    cell(e.httpStatus ?? "—");
    cell(e.rows ?? "—");
    cell(e.sha256 ? e.sha256.slice(0, 12) : "—", e.sha256 || "");
    cell(i18n.t("queryLog.outcome." + e.outcome));
  }
  wrap.appendChild(table);
  container.appendChild(wrap);
}
