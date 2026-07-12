// =============================================================================
// nodeSearch.js — pure, DOM-free ranked search over graph nodes/edges for the
// Ctrl/Cmd+K command palette. No dependency on the store, vis, or the DOM: the
// caller resolves display strings (alias/known-label/category/method) into
// SearchRecords first (see main.js#buildSearchRecords); this module only ranks.
// =============================================================================

/**
 * @typedef {{ kind:'node'|'edge', id:string, title:string, subtitle:string,
 *             text:string[], hex:string[] }} SearchRecord
 *   title/subtitle = display strings (already resolved by caller).
 *   text = human strings matched with substring+fuzzy (alias, known-label, category, method sig).
 *   hex  = lowercased hex strings matched by substring/prefix (address, tx hash).
 */

const FUZZY_GAP_CAP = 80;
const FUZZY_BASE = 120;

/**
 * Greedy earliest-match subsequence check: every char of `q` appears in `t`,
 * in order (not necessarily contiguous). Returns the "gap" cost — how much
 * wider the matched span is than `q` itself — or null when `q` is not a
 * subsequence of `t` at all.
 * @param {string} q lowercase query
 * @param {string} t lowercase candidate text
 * @returns {number|null}
 */
function subsequenceGaps(q, t) {
  let ti = 0;
  let first = -1;
  let last = -1;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    let found = -1;
    while (ti < t.length) {
      if (t[ti] === ch) {
        found = ti;
        ti++;
        break;
      }
      ti++;
    }
    if (found === -1) return null;
    if (first === -1) first = found;
    last = found;
  }
  const span = last - first + 1;
  return span - q.length;
}

/**
 * Score a single hex field (address / tx hash) against the query.
 * @param {string} q lowercase query
 * @param {string} hRaw hex field value (already lowercase per contract)
 * @returns {number}
 */
function scoreHexField(q, hRaw) {
  const h = String(hRaw || "").toLowerCase();
  if (!h) return 0;
  if (h === q) return 1000;
  if (h.startsWith(q)) return 600;
  if (h.includes(q)) return 300;
  return 0;
}

/**
 * Score a single human-text field (alias / known-label / category / method
 * signature) against the query: exact > prefix > substring > fuzzy subsequence.
 * @param {string} q lowercase query
 * @param {string} tRaw text field value
 * @returns {number}
 */
function scoreTextField(q, tRaw) {
  const t = String(tRaw || "").toLowerCase();
  if (!t) return 0;
  if (t === q) return 900;
  if (t.startsWith(q)) return 500;
  if (t.includes(q)) return 250;
  const gaps = subsequenceGaps(q, t);
  if (gaps === null) return 0;
  return FUZZY_BASE - Math.min(gaps, FUZZY_GAP_CAP);
}

/**
 * Rank records against a query.
 * @param {string} query raw user input
 * @param {SearchRecord[]} records
 * @param {{ limit?:number }} [opts] default limit 20
 * @returns {{ record:SearchRecord, score:number }[]} score desc, stable by title
 */
export function searchGraph(query, records, opts) {
  const limit = (opts && opts.limit) || 20;
  const q = String(query == null ? "" : query).trim().toLowerCase();
  if (!q) return [];

  const scored = [];
  for (const record of records || []) {
    let base = 0;
    for (const h of record.hex || []) {
      const s = scoreHexField(q, h);
      if (s > base) base = s;
    }
    for (const t of record.text || []) {
      const s = scoreTextField(q, t);
      if (s > base) base = s;
    }
    if (base === 0) continue; // no field matched at all — drop
    const score = base + (record.kind === "node" ? 8 : 0);
    scored.push({ record, score });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const at = a.record.title || "";
    const bt = b.record.title || "";
    if (at < bt) return -1;
    if (at > bt) return 1;
    return 0;
  });

  return scored.slice(0, limit);
}
