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

import { formatTimestamp } from "./format.js";
import { TX_TYPE_GROUPS } from "./config.js";
import { methodName } from "./selectors.js";

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
 *           getAlias:(addr:string)=>(string|null) }} deps
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
  if (edge.hasData && Array.isArray(edge.methodArgs)) {
    // Decoded leading static args (e.g. the real recipient of a transfer()).
    edge.methodArgs.forEach((a, i) => table.appendChild(detailRow(`#${i + 1} ${a.type}`, a.value)));
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
