// =============================================================================
// format.js — pure, DOM-free formatting / validation / key helpers.
//
// STAGE A: signatures frozen. STAGE B: bodies implemented here.
// Everything here is deterministic and side-effect-free (Node-testable).
// Ported from the reference app.js (formatUnits/trimZero/short/csvEscape/
// isValidAddress) but honors the hardened contracts documented per function.
// =============================================================================

/**
 * Result of {@link formatUnits}. `indeterminate:true` means decimals/value could
 * not be trusted; `text` then holds the RAW integer string (never a silent "0").
 * @typedef {{ text:string, indeterminate:boolean }} AmountResult
 */

/**
 * Lowercase an address safely (canonical node-id form). Null/undefined -> "".
 * @param {string|null|undefined} addr
 * @returns {string}
 */
export function lc(addr) {
  return typeof addr === "string" ? addr.toLowerCase() : "";
}

/**
 * @param {string} addr
 * @returns {boolean} true iff `0x` + 40 hex chars.
 */
export function isValidAddress(addr) {
  return typeof addr === "string" && /^0x[a-fA-F0-9]{40}$/.test(addr);
}

/**
 * Convert a base-unit integer string to a decimal string via BigInt (NEVER Number).
 * HONEST: if `rawValue` is unparseable or `decimals` is empty/NaN/negative, return
 * `{ text: <raw integer as given>, indeterminate: true }` — do NOT silently return "0".
 * On success: `{ text: "<whole>.<frac(≤6)>", indeterminate: false }` (untrimmed).
 * @param {string} rawValue integer string in base units
 * @param {number|string|undefined} decimals token decimals (default 18)
 * @returns {AmountResult}
 */
export function formatUnits(rawValue, decimals) {
  const rawText = rawValue === undefined || rawValue === null ? "" : String(rawValue);

  let dec = 18;
  if (decimals !== undefined) {
    if (decimals === null || decimals === "") {
      return { text: rawText, indeterminate: true };
    }
    const n = typeof decimals === "number" ? decimals : Number(decimals);
    if (!Number.isInteger(n) || n < 0) {
      return { text: rawText, indeterminate: true };
    }
    dec = n;
  }

  try {
    let v = BigInt(rawText);
    const neg = v < 0n;
    if (neg) v = -v;
    const base = 10n ** BigInt(dec);
    const whole = v / base;
    const frac = v % base;
    const fracStr = frac.toString().padStart(dec, "0").slice(0, 6);
    return { text: (neg ? "-" : "") + whole.toString() + "." + fracStr, indeterminate: false };
  } catch (e) {
    return { text: rawText, indeterminate: true };
  }
}

/**
 * Trim trailing fractional zeros ("1.2300" -> "1.23", "5.000" -> "5").
 * @param {string} s
 * @returns {string}
 */
export function trimZero(s) {
  return s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

/**
 * Short display form: first 5 + "…" + last 4 (e.g. "0x123…abcd").
 * @param {string} addr
 * @returns {string}
 */
export function shortAddress(addr) {
  if (typeof addr !== "string") return "";
  return addr.slice(0, 5) + "…" + addr.slice(-4);
}

const HTML_ESCAPE_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/**
 * Escape a string for safe insertion as HTML text/attribute content
 * (& < > " '). Used for aliases and API-supplied token symbols before they
 * ever touch innerHTML.
 * @param {string} s
 * @returns {string}
 */
export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch]);
}

/**
 * Escape a value for a CSV cell. Two layers:
 *  1. CSV-formula-injection defense (CWE-1236): a cell starting with a formula
 *     trigger (`= + - @`, tab, CR) is prefixed with a single quote so Excel /
 *     LibreOffice / Sheets treat it as text, never a live formula. This matters
 *     because token symbols come straight from attacker-deployable ERC-20
 *     `symbol()` values (e.g. `=CMD|'/C calc'!A0`).
 *  2. Standard RFC-4180 quoting when the (possibly prefixed) value contains
 *     comma/quote/newline. Null/undefined -> "".
 * @param {*} v
 * @returns {string}
 */
export function csvEscape(v) {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/**
 * Build a PRECISE dedup key for an edge so distinct transfers never collapse.
 * MUST distinguish: same-symbol/different-contract, and per-token ERC-1155.
 * Key parts: `action | hash | from | to | contractAddress | tokenID | logIndex`
 * (each lowercased where address-like; missing parts -> ""). Symbol is display
 * only and MUST NOT be the sole discriminator.
 * @param {string} action Etherscan action (txlist/tokentx/token1155tx/…)
 * @param {object} tx raw Etherscan tx record
 * @returns {string}
 */
export function edgeDedupKey(action, tx) {
  const rec = tx || {};
  const from = lc(rec.from);
  const to = lc(rec.to);
  const contractAddress = lc(rec.contractAddress);
  const tokenID = rec.tokenID !== undefined && rec.tokenID !== null ? String(rec.tokenID) : "";
  const logIndex = rec.logIndex !== undefined && rec.logIndex !== null ? String(rec.logIndex) : "";
  const hash = rec.hash || "";
  return [action || "", hash, from, to, contractAddress, tokenID, logIndex].join("|");
}

/**
 * True if a tx failed/reverted and must NOT render as real value movement:
 * `isError === "1"` (normal) OR `txreceipt_status === "0"` (where present).
 * Internal/token records lacking these fields are treated as not-failed.
 * @param {object} tx raw Etherscan tx record
 * @returns {boolean}
 */
export function isFailedTx(tx) {
  if (!tx) return false;
  if (tx.isError === "1") return true;
  if (tx.txreceipt_status === "0") return true;
  return false;
}

/**
 * Format a UNIX-seconds string/number to a locale date-time; "" when absent.
 * @param {string|number|undefined} unixSeconds
 * @param {string} [locale]
 * @returns {string}
 */
export function formatTimestamp(unixSeconds, locale) {
  if (unixSeconds === undefined || unixSeconds === null || unixSeconds === "") return "";
  const n = typeof unixSeconds === "number" ? unixSeconds : Number(unixSeconds);
  if (!Number.isFinite(n)) return "";
  const d = new Date(n * 1000);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(locale);
}
