// =============================================================================
// render/export.js — PNG / PDF / CSV export.
// Renders a FRESH off-screen vis network at the chosen resolution (independent of
// live zoom/pan), bakes an OPAQUE dark background onto the otherwise-transparent
// canvas, then hands the composite to the PNG/PDF writers. CSV walks the store.
//
// STAGE A: interface frozen. STAGE B: implement.
// Guard: honor config.EXPORT_PIXELS (warn/cap) so a huge auto-export can't freeze
// the tab — clamp and offer CSV instead.
// =============================================================================

import { RESOLUTION_PRESETS, EXPORT_PIXELS } from "../config.js";
import { csvEscape, formatTimestamp } from "../format.js";
import { nodeLabel, nodeVisual, edgeLabel } from "./labels.js";

/** Opaque background baked into export canvases (see renderExportCanvas). */
const DEFAULT_BACKGROUND = "#0b0d11";

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
 *           annotations?:Array<{text:string,x:number,y:number}> }} opts
 * @returns {Promise<HTMLCanvasElement>}
 */
export function renderExportCanvas(view, store, opts) {
  const { size, addressFormat } = opts;
  const annotations = opts.annotations || [];
  const background = opts.background || DEFAULT_BACKGROUND;
  const { w, h } = size;
  const vis = window.vis;

  return new Promise((resolve, reject) => {
    const nodes = store.listNodes();
    const ids = nodes.map((n) => n.address);
    const positions = view.getPositions(ids);

    const offscreen = document.createElement("div");
    offscreen.style.position = "fixed";
    offscreen.style.left = "-100000px";
    offscreen.style.top = "0px";
    offscreen.style.width = w + "px";
    offscreen.style.height = h + "px";
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
          const p = positions[n.address] || { x: 0, y: 0 };
          const visual = nodeVisual(n);
          return {
            id: n.address,
            x: p.x,
            y: p.y,
            fixed: { x: true, y: true },
            label: nodeLabel(n, { addressFormat }),
            color: visual.color,
            title: visual.title,
          };
        })
      );
      const exportEdges = new vis.DataSet(
        store.listEdges().map((e) => ({
          id: e.key,
          from: e.from,
          to: e.to,
          color: { color: e.color, inherit: false },
          label: edgeLabel(e),
          title: e.title,
        }))
      );

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
          const composite = document.createElement("canvas");
          composite.width = raw.width;
          composite.height = raw.height;
          const ctx = composite.getContext("2d");
          ctx.fillStyle = background;
          ctx.fillRect(0, 0, composite.width, composite.height);
          ctx.drawImage(raw, 0, 0);
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
 *           onLog:(e:{level:string,key:string,params?:object})=>void }} deps
 * @returns {Promise<void>}
 */
export async function exportPng(view, store, deps) {
  const { preset, addressFormat, onLog, annotations } = deps;
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

  const canvas = await renderExportCanvas(view, store, { size, addressFormat, annotations });
  triggerDownload(canvas.toDataURL("image/png"), `graph-${Date.now()}.png`);
  onLog({ level: "info", key: "log.exportPng", params: { w: canvas.width, h: canvas.height } });
}

/**
 * Full PDF export flow. `jsPDF` is injected (from window.jspdf.jsPDF).
 * @param {import('./network.js').GraphView} view
 * @param {import('../graphStore.js').GraphStore} store
 * @param {{ preset:'hd'|'qhd'|'uhd'|'auto', addressFormat:'short'|'full', jsPDF:any,
 *           onLog:(e:{level:string,key:string,params?:object})=>void }} deps
 * @returns {Promise<void>}
 */
export async function exportPdf(view, store, deps) {
  const { preset, addressFormat, jsPDF, onLog, annotations } = deps;
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

  const canvas = await renderExportCanvas(view, store, { size, addressFormat, annotations });
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
 *  vice versa — one wide sparse table keeps a single header for both kinds). */
const CSV_HEADER = [
  "row_type", "address", "alias", "depth", "is_root",
  "tx_type", "from", "to", "amount", "symbol", "hash", "block", "date",
];

/**
 * CSV export: node rows + edge rows (with sampling caveat header). Walks the store.
 * @param {import('../graphStore.js').GraphStore} store
 * @param {{ onLog:(e:{level:string,key:string,params?:object})=>void }} deps
 */
export function exportCsv(store, deps) {
  const { onLog } = deps;
  const nodes = store.listNodes();
  const edges = store.listEdges();

  if (!nodes.length) {
    onLog({ level: "error", key: "log.exportEmpty" });
    return;
  }

  const rows = [
    // Sampling caveat: this graph reflects only the transactions retrieved
    // during the scan (latest-first, capped per address/type) — not full
    // on-chain history. Kept as the first CSV line so it survives copy/paste.
    ["# sampling caveat: partial/sampled data (latest transactions per address per type) - not full on-chain history; not forensic-complete"],
    CSV_HEADER,
  ];

  for (const n of nodes) {
    rows.push([
      "node", n.address, n.alias || "", n.depth ?? "", n.isRoot ? "1" : "0",
      "", "", "", "", "", "", "", "",
    ]);
  }
  for (const e of edges) {
    rows.push([
      "edge", "", "", "", "",
      e.group || "", e.from || "", e.to || "", e.amountText || "", e.symbol || "",
      e.hash || "", e.blockNumber || "", formatTimestamp(e.timeStamp),
    ]);
  }

  const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, `graph-${Date.now()}.csv`);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  onLog({ level: "info", key: "log.exportCsv" });
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
