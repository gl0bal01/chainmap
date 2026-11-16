// =============================================================================
// render/export.js — PNG / PDF / CSV export + the evidence bundle (zip).
// Renders a FRESH off-screen vis network at the chosen resolution (independent of
// live zoom/pan), bakes an OPAQUE dark background onto the otherwise-transparent
// canvas, then hands the composite to the PNG/PDF writers. CSV walks the store.
//
// STAGE A: interface frozen. STAGE B: implement.
// Guard: honor config.EXPORT_PIXELS (warn/cap) so a huge auto-export can't freeze
// the tab — clamp and offer CSV instead.
// =============================================================================

import { RESOLUTION_PRESETS, EXPORT_PIXELS } from "../config.js";
import { csvEscape, formatTimestamp, formatUnits } from "../format.js";
import { nodeLabel, nodeVisual, edgeLabel } from "./labels.js";
import { methodName } from "../selectors.js";
import { resolvedRecipient, flagsForEdge } from "../riskFlags.js";
import { buildEvidenceZip, fileStamp } from "../evidence.js";

/** Opaque background baked into export canvases (see renderExportCanvas). */
const DEFAULT_BACKGROUND = "#0b0d11";
const FOOTER_COLOR = "#9aa3b2";

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/**
 * @typedef {{ w:number, h:number, pixels:number, capped:boolean, warn:boolean }} ExportSize
 */

/**
 * Compute export dimensions for a preset (or "auto") + node count, applying the
 * pixel guard. `capped` => clamped to the cap; `warn` => above the warn threshold.
 * Pure; unit-tested directly.
 * @param {'hd'|'qhd'|'uhd'|'auto'} preset
 * @param {number} nodeCount
 * @returns {ExportSize}
 */
export function computeExportSize(preset, nodeCount) {
  let w, h;
  if (preset === "auto") {
    const n = Math.max(1, Number(nodeCount) || 0);
    w = clamp(n * 260, 2400, 10000);
    h = Math.round(w * 0.6);
  } else {
    const base = RESOLUTION_PRESETS[preset] || RESOLUTION_PRESETS.qhd;
    w = base.w;
    h = base.h;
  }

  let pixels = w * h;
  let capped = false;
  if (pixels > EXPORT_PIXELS.cap) {
    const scale = Math.sqrt(EXPORT_PIXELS.cap / pixels);
    w = Math.max(1, Math.floor(w * scale));
    h = Math.max(1, Math.floor(h * scale));
    pixels = w * h;
    capped = true;
  }
  const warn = pixels > EXPORT_PIXELS.warn;
  return { w, h, pixels, capped, warn };
}

/**
 * Render the whole graph off-screen to an opaque canvas at `size`.
 * @param {import('./network.js').GraphView} view  live view (for node positions)
 * @param {import('../graphStore.js').GraphStore} store
 * @param {{ size:ExportSize, background?:string, addressFormat:'short'|'full',
 *           annotations?:Array<{text:string,x:number,y:number}>,
 *           chainTag?:(chainId:string)=>(string|null),
 *           twinLinks?:Array<{a:string,b:string}>, twinLabel?:string,
 *           footer?:string[], badge?:(node:object)=>(string|null) }} opts
 *   `footer` lines are drawn (canvas fillText, never DOM) in a band carved INSIDE
 *   `size` — the graph area shrinks by the band, so the pixel guard still holds.
 *   `badge(node)` text is appended as a last label line (same string as the live view).
 * @returns {Promise<HTMLCanvasElement>}
 */
export function renderExportCanvas(view, store, opts) {
  const { size, addressFormat } = opts;
  const annotations = opts.annotations || [];
  const background = opts.background || DEFAULT_BACKGROUND;
  const { w, h } = size;
  const vis = window.vis;
  const footer = opts.footer || [];
  const fontPx = Math.max(12, Math.round(w / 120));
  const lineH = Math.round(fontPx * 1.5);
  const band = footer.length ? footer.length * lineH + fontPx : 0;

  return new Promise((resolve, reject) => {
    const nodes = store.listNodes();
    const ids = nodes.map((n) => n.id);
    const positions = view.getPositions(ids);

    const offscreen = document.createElement("div");
    offscreen.style.position = "fixed";
    offscreen.style.left = "-100000px";
    offscreen.style.top = "0px";
    offscreen.style.width = w + "px";
    offscreen.style.height = h - band + "px";
    offscreen.style.background = background;
    document.body.appendChild(offscreen);

    let tempNet;
    const cleanup = () => {
      try {
        if (tempNet) tempNet.destroy();
      } catch {
        // best-effort cleanup
      }
      offscreen.remove();
    };

    try {
      const exportNodes = new vis.DataSet(
        nodes.map((n) => {
          const p = positions[n.id] || { x: 0, y: 0 };
          const visual = nodeVisual(n);
          const b = opts.badge ? opts.badge(n) : null;
          return {
            id: n.id,
            x: p.x,
            y: p.y,
            fixed: { x: true, y: true },
            label: nodeLabel(n, { addressFormat, chainTag: opts.chainTag ? opts.chainTag(n.chainId) : null }) + (b ? "\n" + b : ""),
            color: visual.color,
            title: visual.title,
          };
        })
      );
      const exportEdges = new vis.DataSet(
        store.listEdges().map((e) => ({
          id: e.key,
          from: e.fromId,
          to: e.toId,
          color: { color: e.color, inherit: false },
          label: edgeLabel(e),
          title: e.title,
        }))
      );
      // Same-key overlay links (derived, display-only; same style as the live view).
      (opts.twinLinks || []).forEach((l) => {
        exportEdges.add({
          id: `twin:${l.a}|${l.b}`, from: l.a, to: l.b, label: opts.twinLabel || "",
          dashes: [2, 6], width: 1, color: { color: "#8b93a3", inherit: false },
          font: { color: "#8b93a3" }, arrows: { to: { enabled: false } }, physics: false,
        });
      });

      // Sticky-note annotations bake into the exported image too.
      annotations.forEach((a, i) => {
        exportNodes.add({
          id: `note:${i}`,
          x: a.x, y: a.y,
          fixed: { x: true, y: true },
          label: a.text,
          shape: "box",
          color: { background: "#2a2410", border: "#6b5a1a" },
          font: { color: "#e8d68a", size: 18 },
        });
      });

      tempNet = new vis.Network(
        offscreen,
        { nodes: exportNodes, edges: exportEdges },
        {
          nodes: { shape: "dot", size: 16, font: { color: "#f1f1f1", size: 20, face: "monospace" }, borderWidth: 1 },
          edges: {
            arrows: { to: { enabled: true, scaleFactor: 0.7 } },
            smooth: { type: "dynamic" },
            font: { size: 16, color: "#d7dde6", strokeWidth: 5, strokeColor: background },
            color: { inherit: false },
          },
          physics: false,
          interaction: { zoomView: false, dragView: false },
        }
      );
    } catch (err) {
      offscreen.remove();
      reject(err);
      return;
    }

    tempNet.once("afterDrawing", () => {
      requestAnimationFrame(() => {
        try {
          // vis-network's canvas itself is transparent — bake an opaque
          // background in first, otherwise light label text becomes invisible
          // once flattened onto a white page (e.g. in the PDF/most viewers).
          const raw = tempNet.canvas.frame.canvas;
          const scale = raw.width / w; // device pixel ratio of the vis canvas
          const composite = document.createElement("canvas");
          composite.width = raw.width;
          composite.height = raw.height + Math.round(band * scale);
          const ctx = composite.getContext("2d");
          ctx.fillStyle = background;
          ctx.fillRect(0, 0, composite.width, composite.height);
          ctx.drawImage(raw, 0, 0);
          // Footer: shrink each line's font until it fits (min 8 px); fillText's
          // maxWidth is the last resort so no line is ever cut off.
          const pad = fontPx * scale;
          const maxW = composite.width - 2 * pad;
          ctx.fillStyle = FOOTER_COLOR;
          ctx.textBaseline = "top";
          footer.forEach((line, i) => {
            let px = fontPx * scale;
            ctx.font = `${px}px sans-serif`;
            while (px > 8 * scale && ctx.measureText(line).width > maxW) {
              px = Math.max(8 * scale, px - 1);
              ctx.font = `${px}px sans-serif`;
            }
            ctx.fillText(line, pad, raw.height + (fontPx / 2 + i * lineH) * scale, maxW);
          });
          resolve(composite);
        } catch (err) {
          reject(err);
        } finally {
          cleanup();
        }
      });
    });
    tempNet.fit({ animation: false });
  });
}

/**
 * Full PNG export flow (compute size -> guard -> render -> download).
 * @param {import('./network.js').GraphView} view
 * @param {import('../graphStore.js').GraphStore} store
 * @param {{ preset:'hd'|'qhd'|'uhd'|'auto', addressFormat:'short'|'full',
 *           chainTag?:(chainId:string)=>(string|null), footer?:string[], badge?:(node:object)=>(string|null),
 *           onLog:(e:{level:string,key:string,params?:object})=>void }} deps
 * @returns {Promise<void>}
 */
export async function exportPng(view, store, deps) {
  const { preset, addressFormat, onLog, annotations, chainTag, twinLinks, twinLabel, footer, badge } = deps;
  const nodeCount = store.listNodes().length;
  if (!nodeCount) {
    onLog({ level: "error", key: "log.exportEmpty" });
    return;
  }

  const size = computeExportSize(preset, nodeCount);
  if (size.capped) {
    onLog({ level: "error", key: "log.exportTooLarge", params: { pixels: size.pixels } });
    return;
  }

  const canvas = await renderExportCanvas(view, store, { size, addressFormat, annotations, chainTag, twinLinks, twinLabel, footer, badge });
  triggerDownload(canvas.toDataURL("image/png"), `graph-${Date.now()}.png`);
  onLog({ level: "info", key: "log.exportPng", params: { w: canvas.width, h: canvas.height } });
}

/**
 * Full PDF export flow. `jsPDF` is injected (from window.jspdf.jsPDF).
 * @param {import('./network.js').GraphView} view
 * @param {import('../graphStore.js').GraphStore} store
 * @param {{ preset:'hd'|'qhd'|'uhd'|'auto', addressFormat:'short'|'full', jsPDF:any,
 *           chainTag?:(chainId:string)=>(string|null), footer?:string[], badge?:(node:object)=>(string|null),
 *           onLog:(e:{level:string,key:string,params?:object})=>void }} deps
 * @returns {Promise<void>}
 */
export async function exportPdf(view, store, deps) {
  const { preset, addressFormat, jsPDF, onLog, annotations, chainTag, twinLinks, twinLabel, footer, badge } = deps;
  const nodeCount = store.listNodes().length;
  if (!nodeCount) {
    onLog({ level: "error", key: "log.exportEmpty" });
    return;
  }

  const size = computeExportSize(preset, nodeCount);
  if (size.capped) {
    onLog({ level: "error", key: "log.exportTooLarge", params: { pixels: size.pixels } });
    return;
  }

  const canvas = await renderExportCanvas(view, store, { size, addressFormat, annotations, chainTag, twinLinks, twinLabel, footer, badge });
  const imgData = canvas.toDataURL("image/png");
  const doc = new jsPDF({
    orientation: canvas.width >= canvas.height ? "l" : "p",
    unit: "px",
    format: [canvas.width, canvas.height],
  });
  doc.addImage(imgData, "PNG", 0, 0, canvas.width, canvas.height);
  doc.save(`graph-${Date.now()}.pdf`);
  onLog({ level: "info", key: "log.exportPdf", params: { w: canvas.width, h: canvas.height } });
}

/** Header row for the CSV export (node rows leave tx_type/from/... blank, and
 *  vice versa — one wide sparse table keeps a single header for both kinds).
 *  The decoded-calldata columns (edge rows only) are followed by chain_id and
 *  the two deposit columns (node rows only). */
const CSV_HEADER = [
  "row_type", "address", "alias", "depth", "is_root",
  "tx_type", "from", "to", "amount", "symbol", "hash", "block", "date",
  "method", "method_sig", "real_recipient", "decoded_amount", "risk_flags", "chain_id",
  "likely_deposit_of", "deposit_evidence",
];

const DEPOSIT_CAVEAT = "; likely_deposit_of is a heuristic (nearly all of the address's sampled outflow went to one known exchange wallet) - not an attribution";

const depositEvidenceText = (d) =>
  `wallet=${d.wallet};swept=${d.swept}/${d.outgoing};share=${d.assets.map((a) => `${a.symbol}:${a.sharePct}%`).join(",")};max_delay_s=${d.maxDelaySec ?? "none"}`;

function provenanceText({ exportedAt, retrieval }) {
  return `; exported ${exportedAt} UTC` +
    (retrieval ? `; retrieved ${retrieval.first} to ${retrieval.last} UTC (see query log)` : "; retrieval time unknown (no query log)") +
    (retrieval && !retrieval.complete ? "; part of this graph has no logged retrieval (demo/older workspace or dropped log entries)" : "") +
    "; labels/risk flags/imitation-token/likely-deposit/same-key marks are signals - not facts";
}

/**
 * Build all CSV rows (caveat + header + node/edge rows). Pure — no DOM.
 * @param {import('../graphStore.js').GraphStore} store
 * @param {{ category:(addr:string, chainId:string)=>(string|null), isFakeToken?:(edge:object)=>boolean,
 *           formatTimestamp?:(t:string)=>string,
 *           deposits?:Map<string, import('../depositDetect.js').DepositEvidence>,
 *           provenance?:{ exportedAt:string, retrieval:object|null } }} ctx
 *   `provenance` (when given) extends line 1 — still one comma-free `#` comment.
 * @returns {string[][]}
 */
export function buildCsvRows(store, ctx) {
  const fmtTs = (ctx && ctx.formatTimestamp) || formatTimestamp;
  const category = (ctx && ctx.category) || (() => null);
  const isFakeToken = ctx && ctx.isFakeToken;
  const deposits = (ctx && ctx.deposits) || new Map();
  const nodes = store.listNodes();
  const multiChain = new Set(nodes.map((n) => n.chainId)).size >= 2;
  const prov = ctx && ctx.provenance;
  const rows = [
    // Sampling caveat: this graph reflects only the transactions retrieved
    // during the scan (latest-first, capped per address/type) — not full
    // on-chain history. Kept as the first CSV line so it survives copy/paste.
    ["# sampling caveat: partial/sampled data (latest transactions per address per type) - not full on-chain history; not forensic-complete" +
      (multiChain ? "; multi-chain: each row belongs to its chain_id — the same address on two chains is two rows; a shared address implies no transfer" : "") +
      (nodes.some((n) => deposits.has(n.id)) ? DEPOSIT_CAVEAT : "") +
      (prov ? provenanceText(prov) : "")],
    CSV_HEADER,
  ];

  for (const n of nodes) {
    const d = deposits.get(n.id);
    rows.push([
      "node", n.address, n.alias || "", n.depth ?? "", n.isRoot ? "1" : "0",
      "", "", "", "", "", "", "", "",
      "", "", "", "", "", n.chainId,
      d ? d.label : "", d ? depositEvidenceText(d) : "",
    ]);
  }
  for (const e of store.listEdges()) {
    let method = "", sig = "", realRecipient = "", decodedAmount = "";
    // Flags for EVERY edge (a plain transfer to a mixer / an imitation token still flags).
    const flags = flagsForEdge(e, { category, isFakeToken }).join(";");
    if (e.hasData) {
      method = e.methodId || "";
      sig = methodName(e.methodId) || "";
      const rr = resolvedRecipient(e);
      realRecipient = rr || "";
      const amtArg = (e.methodArgs || []).find((a) => a && /amount|value/i.test(a.name || ""));
      if (amtArg) {
        const f = formatUnits(amtArg.value, e.tokenDecimal);
        decodedAmount = f.indeterminate ? amtArg.value : f.text;
      }
    }
    rows.push([
      "edge", "", "", "", "",
      e.group || "", e.from || "", e.to || "", e.amountText || "", e.symbol || "",
      e.hash || "", e.blockNumber || "", fmtTs(e.timeStamp),
      method, sig, realRecipient, decodedAmount, flags, e.chainId, "", "",
    ]);
  }
  return rows;
}

/**
 * The exact CSV file text (UTF-8 BOM + rows). Shared by exportCsv and the
 * evidence bundle so the bundled bytes equal a normal CSV export's bytes.
 * @param {import('../graphStore.js').GraphStore} store
 * @param {Parameters<typeof buildCsvRows>[1]} ctx
 * @returns {string}
 */
export function csvText(store, ctx) {
  return "\uFEFF" + buildCsvRows(store, ctx).map((r) => r.map(csvEscape).join(",")).join("\n");
}

/**
 * CSV export: node rows + edge rows (with sampling caveat header). Walks the store.
 * @param {import('../graphStore.js').GraphStore} store
 * @param {{ onLog:(e:{level:string,key:string,params?:object})=>void,
 *           category?:(addr:string, chainId:string)=>(string|null),
 *           isFakeToken?:(edge:object)=>boolean,
 *           deposits?:Map<string, import('../depositDetect.js').DepositEvidence>,
 *           provenance?:{ exportedAt:string, retrieval:object|null } }} deps
 */
export function exportCsv(store, deps) {
  const { onLog } = deps;

  if (!store.listNodes().length) {
    onLog({ level: "error", key: "log.exportEmpty" });
    return;
  }

  const text = csvText(store, { category: deps.category, isFakeToken: deps.isFakeToken, deposits: deps.deposits, provenance: deps.provenance });
  const blob = new Blob([text], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, `graph-${Date.now()}.csv`);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  onLog({ level: "info", key: "log.exportCsv" });
}

/**
 * Evidence bundle: graph.csv (exact exportCsv bytes, BOM included), workspace.json,
 * graph.png (omitted when over the pixel cap), query-log.json, MANIFEST.json and
 * SHA256SUMS in one store-only zip; logs the zip's SHA-256. Needs Web Crypto.
 * Never rejects: any failure logs log.bundleFailed and downloads nothing.
 * @param {import('./network.js').GraphView} view
 * @param {import('../graphStore.js').GraphStore} store
 * @param {Parameters<typeof exportPng>[2] & Parameters<typeof buildCsvRows>[1] & {
 *           exportedAt:string, retrieval:object|null, workspaceText:string, queryLogText:string,
 *           manifest:{ chains:object[], roots:string[], sampling:object, data:object } }} deps
 * @returns {Promise<void>}
 */
export async function exportEvidenceBundle(view, store, deps) {
  const { onLog, exportedAt, retrieval } = deps;
  const nodeCount = store.listNodes().length;
  if (!nodeCount) {
    onLog({ level: "error", key: "log.exportEmpty" });
    return;
  }
  if (!globalThis.crypto?.subtle) {
    onLog({ level: "error", key: "log.bundleNoCrypto" });
    return;
  }

  // The bundle owns its failure path: any error (render, a null toBlob, zip)
  // logs log.bundleFailed, downloads nothing and never rejects.
  let url = null, sha256, names;
  try {
    const enc = (s) => new TextEncoder().encode(s);
    const csv = csvText(store, { category: deps.category, isFakeToken: deps.isFakeToken, deposits: deps.deposits, provenance: { exportedAt, retrieval } });
    const files = [{ name: "graph.csv", bytes: enc(csv) }, { name: "workspace.json", bytes: enc(deps.workspaceText) }];
    const omitted = [];
    const size = computeExportSize(deps.preset, nodeCount);
    if (size.capped) {
      omitted.push({ name: "graph.png", reason: "too-large" });
      onLog({ level: "error", key: "log.bundlePngOmitted", params: { pixels: size.pixels } });
    } else {
      const { addressFormat, annotations, chainTag, twinLinks, twinLabel, footer, badge } = deps;
      const canvas = await renderExportCanvas(view, store, { size, addressFormat, annotations, chainTag, twinLinks, twinLabel, footer, badge });
      const png = await new Promise((r) => canvas.toBlob(r, "image/png"));
      if (!png) throw new Error("canvas.toBlob returned null");
      files.push({ name: "graph.png", bytes: new Uint8Array(await png.arrayBuffer()) });
    }
    files.push({ name: "query-log.json", bytes: enc(deps.queryLogText) });

    let zip;
    ({ zip, sha256, names } = await buildEvidenceZip({ exportedAt, ...deps.manifest, graph: store.stats(), retrieval, files, omitted }));
    url = URL.createObjectURL(new Blob([zip], { type: "application/zip" }));
    triggerDownload(url, `chainmap-evidence-${fileStamp(new Date(exportedAt))}.zip`);
  } catch {
    if (url) URL.revokeObjectURL(url);
    onLog({ level: "error", key: "log.bundleFailed" });
    return;
  }
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  onLog({ level: "info", key: "log.bundleExported", params: { sha256, files: names.length } });
}

/**
 * Trigger a browser download for a href/blob-url.
 * @param {string} href @param {string} filename
 */
export function triggerDownload(href, filename) {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
