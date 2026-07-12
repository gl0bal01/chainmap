// =============================================================================
// render/palette.js — Ctrl/Cmd+K command palette: search the graph by node
// address/alias/known-label/category and by tx-hash/decoded method, jump to the
// match. DOM/vis layer (owns #palette/#paletteInput/#paletteResults); ranking
// itself lives in the DOM-free ../nodeSearch.js.
//
// CSP/XSS: every untrusted string (title/subtitle/alias/known-label/symbol) is
// rendered via textContent or `<mark>` element segments built with
// createElement+textContent — NEVER innerHTML string concatenation. Rows store
// their SearchRecord via a closure (addEventListener), not via dataset/innerHTML.
// =============================================================================

import { searchGraph } from "../nodeSearch.js";

/**
 * Build a DocumentFragment of textNodes + a single `<mark>` around the first
 * case-insensitive occurrence of `q` in `text`. Falls back to a single
 * textNode when `q` is empty or not found — never HTML string building.
 * @param {string} text
 * @param {string} q
 * @returns {DocumentFragment}
 */
function highlight(text, q) {
  const frag = document.createDocumentFragment();
  const str = String(text == null ? "" : text);
  const needle = String(q == null ? "" : q);
  if (!needle) {
    frag.appendChild(document.createTextNode(str));
    return frag;
  }
  const idx = str.toLowerCase().indexOf(needle.toLowerCase());
  if (idx === -1) {
    frag.appendChild(document.createTextNode(str));
    return frag;
  }
  if (idx > 0) frag.appendChild(document.createTextNode(str.slice(0, idx)));
  const mark = document.createElement("mark");
  mark.textContent = str.slice(idx, idx + needle.length);
  frag.appendChild(mark);
  const rest = str.slice(idx + needle.length);
  if (rest) frag.appendChild(document.createTextNode(rest));
  return frag;
}

/**
 * Build one result row. All untrusted strings (title/subtitle) reach the DOM
 * via textContent / the `highlight()` fragment above.
 * @param {import('../nodeSearch.js').SearchRecord} record
 * @param {string} query
 * @param {import('../i18n.js').I18n} i18n
 * @returns {HTMLLIElement}
 */
function buildRow(record, query, i18n) {
  const li = document.createElement("li");
  li.className = "palette-item";
  li.setAttribute("role", "option");

  const main = document.createElement("div");
  main.className = "palette-item-main";

  const titleEl = document.createElement("div");
  titleEl.className = "palette-item-title";
  titleEl.appendChild(highlight(record.title, query));

  const subEl = document.createElement("div");
  subEl.className = "palette-item-subtitle";
  subEl.textContent = record.subtitle;

  main.appendChild(titleEl);
  main.appendChild(subEl);

  const chip = document.createElement("span");
  chip.className = "palette-item-chip";
  chip.textContent = record.kind === "node" ? i18n.t("palette.kindNode") : i18n.t("palette.kindEdge");

  li.appendChild(main);
  li.appendChild(chip);
  return li;
}

/**
 * Create the command palette. Wires a global Ctrl/Cmd+K listener + the DOM
 * skeleton already present in index.html (#palette/#paletteInput/#paletteResults).
 * @param {{ i18n:import('../i18n.js').I18n,
 *           getRecords:()=>import('../nodeSearch.js').SearchRecord[],
 *           onPick:(record:import('../nodeSearch.js').SearchRecord)=>void }} deps
 * @returns {{ open:()=>void, close:()=>void, destroy:()=>void }}
 */
export function createPalette(deps) {
  const { i18n, getRecords, onPick } = deps;
  const backdrop = document.getElementById("palette");
  const input = document.getElementById("paletteInput");
  const list = document.getElementById("paletteResults");

  if (!backdrop || !input || !list) {
    // Skeleton missing (e.g. a stripped-down host page) — degrade to a no-op
    // rather than throw, matching the rest of the app's "never crash the shell"
    // stance (see knownAddresses/loadLocalData for the same posture).
    return { open() {}, close() {}, destroy() {} };
  }

  let isOpen = false;
  let results = []; // current SearchRecord[] in rank order
  let rowEls = []; // parallel <li> elements
  let activeIndex = -1;

  function setActive(idx) {
    if (!rowEls.length) return;
    const next = Math.max(0, Math.min(idx, rowEls.length - 1));
    if (rowEls[activeIndex]) rowEls[activeIndex].classList.remove("active");
    activeIndex = next;
    rowEls[activeIndex].classList.add("active");
    rowEls[activeIndex].scrollIntoView({ block: "nearest" });
  }

  function pick(record) {
    close();
    onPick(record);
  }

  function render() {
    list.replaceChildren();
    rowEls = [];
    const raw = input.value;
    const trimmed = raw.trim();
    if (!trimmed) {
      results = [];
      activeIndex = -1;
      return;
    }
    const scored = searchGraph(raw, getRecords(), { limit: 20 });
    results = scored.map((s) => s.record);
    if (!results.length) {
      activeIndex = -1;
      const li = document.createElement("li");
      li.className = "palette-item palette-empty";
      li.textContent = i18n.t("palette.noResults");
      list.appendChild(li);
      return;
    }
    results.forEach((record) => {
      const row = buildRow(record, trimmed, i18n);
      row.addEventListener("click", () => pick(record));
      rowEls.push(row);
      list.appendChild(row);
    });
    activeIndex = -1;
    setActive(0);
  }

  function open() {
    isOpen = true;
    backdrop.hidden = false;
    input.value = "";
    list.replaceChildren();
    results = [];
    rowEls = [];
    activeIndex = -1;
    input.focus();
  }

  function close() {
    isOpen = false;
    backdrop.hidden = true;
    input.value = "";
    list.replaceChildren();
    results = [];
    rowEls = [];
    activeIndex = -1;
  }

  function handleGlobalKeydown(e) {
    const key = (e.key || "").toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === "k") {
      e.preventDefault();
      if (isOpen) close();
      else open();
    }
  }
  document.addEventListener("keydown", handleGlobalKeydown);

  function handleInput() {
    render();
  }
  input.addEventListener("input", handleInput);

  function handleInputKeydown(e) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(activeIndex + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(activeIndex - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const record = results[activeIndex] || results[0];
      if (record) pick(record);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }
  input.addEventListener("keydown", handleInputKeydown);

  function handleBackdropClick(e) {
    if (e.target === backdrop) close();
  }
  backdrop.addEventListener("click", handleBackdropClick);

  return {
    open,
    close,
    destroy: () => {
      document.removeEventListener("keydown", handleGlobalKeydown);
      input.removeEventListener("input", handleInput);
      input.removeEventListener("keydown", handleInputKeydown);
      backdrop.removeEventListener("click", handleBackdropClick);
    },
  };
}
