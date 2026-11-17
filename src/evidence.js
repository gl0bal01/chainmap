// =============================================================================
// evidence.js — pure pieces of the evidence bundle: caveats, manifest,
// SHA256SUMS, query-log document, zip assembly. DOM-free.
// =============================================================================

import { APP_VERSION, PRICE_API } from "./config.js";
import { sha256Hex, windowOf } from "./queryLog.js";
import { createZip } from "./zip.js";

export const BRIDGE_CAVEAT = "Inferred bridge links are candidates computed from amount, timing and recipient in the loaded data — leads to verify on both explorers, never proof; \"confirmed by investigator\" records the investigator's assertion, not an on-chain fact.";

export const CAVEATS = [
  "Sampled data: the latest transactions per address per type (plus pages loaded with \"Load older\"), not the full on-chain history.",
  "Known labels, risk flags, imitation-token marks, likely-deposit marks and same-key links are signals, not facts.",
  "A likely-deposit mark is a heuristic (nearly all sampled outflow went to one known exchange wallet), not an attribution.",
  "Same-key links are signals that two chains share a key, not proof of common control.",
  "Known labels come from a dated bundled snapshot (see data.knownAddresses).",
  "graph.png and graph.csv describe the same full graph: on-screen filters, bundling and hidden hubs do not apply to exports.",
  "The query log records requests, not proof that it explains every record. It includes probes that added no graph data (scan estimate, chain detection, check other chains), and deleting nodes does not remove log entries.",
  "SHA-256 hashes give tamper evidence, not proof of time or authorship.",
  "retrieval.fullyLogged = true only means no log entry was dropped and no part of the graph came from an unlogged source (demo or a workspace without a query log); it does not mean the data is complete: requests may have failed, scans may have been stopped, and the data is sampled.",
];
export const USD_CAVEAT =
  "USD values are estimates: a DefiLlama price within 1 hour of each transaction multiplied by the exact token amount; blank when unknown, pending or not priced (NFT, zero-value, imitation, spam-list, root contract, unknown data, unsupported chain).";
export const PARTIAL_CAVEAT =
  "Part of this graph has no logged retrieval (demo, a workspace saved without a query log, or dropped log entries).";

const enc = (s) => new TextEncoder().encode(s);

export function knownDataSnapshot(knownData) {
  let entries = 0, ofacPublished = null;
  for (const group of Object.values(knownData || {})) {
    for (const rec of Object.values(group)) {
      entries++;
      const m = /published (\d{4}-\d\d-\d\d)/.exec(rec && rec.source || "");
      if (m && (ofacPublished === null || m[1] > ofacPublished)) ofacPublished = m[1];
    }
  }
  return { entries, ofacPublished };
}

// Price (defillama) entries carry a `source`; Etherscan entries never do.
const fromEtherscan = (es) => es.filter((e) => e.source === undefined);

export function retrievalSummary(state) {
  const es = fromEtherscan(state.entries);
  if (!es.length) return null;
  const w = windowOf(es);
  return {
    queries: es.length, dropped: state.dropped, first: w.first, last: w.last,
    fullyLogged: state.dropped === 0 && state.unloggedData === false,
  };
}

export function observedSampling(all) {
  const entries = fromEtherscan(all);
  const uniq = (xs) => [...new Set(xs.filter((x) => x !== undefined))];
  return {
    pageSizes: uniq(entries.map((e) => e.params.offset)).sort((a, b) => a - b),
    sorts: uniq(entries.map((e) => e.params.sort)).sort(),
    actions: uniq(entries.map((e) => e.action)).sort(),
  };
}

export async function buildManifest(input) {
  const files = [];
  for (const f of input.files) files.push({ name: f.name, bytes: f.bytes.length, sha256: await sha256Hex(f.bytes) });
  const p = input.prices;
  const caveats = input.retrieval && input.retrieval.fullyLogged ? [...CAVEATS] : [...CAVEATS, PARTIAL_CAVEAT];
  if (p?.shown) caveats.push(USD_CAVEAT);
  const b = input.bridges && input.bridges.candidates > 0 ? input.bridges : null;
  if (b) caveats.push(BRIDGE_CAVEAT);
  return {
    format: "chainmap-evidence/1",
    app: { name: "chainmap", version: APP_VERSION },
    exportedAt: input.exportedAt,
    chains: input.chains,
    roots: input.roots,
    graph: input.graph,
    sampling: input.sampling,
    retrieval: input.retrieval,
    data: input.data,
    prices: p && (p.shown || p.queries > 0)
      ? {
        source: "DefiLlama (" + PRICE_API + ")", estimate: true, shown: p.shown,
        note: "USD values are estimates: DefiLlama price within 1 hour of each transaction, multiplied by the exact token amount; blank when unknown.",
        queries: p.queries, priced: p.priced, priceable: p.priceable,
      }
      : null,
    bridges: b
      ? {
        note: "Candidate releases inferred from amount, timing and recipient in the loaded data; low/medium/high is a computed confidence, not proof. confirmedByInvestigator / rejectedByInvestigator count the investigator's own decisions (assertions, not on-chain facts).",
        ...b,
      }
      : null,
    caveats,
    files,
    omitted: input.omitted,
  };
}

export const sha256Sums = (files) => files.map((f) => `${f.sha256}  ${f.name}\n`).join("");

export function queryLogDocument(state, exportedAt) {
  return {
    format: "chainmap-query-log/1",
    app: { name: "chainmap", version: APP_VERSION },
    exportedAt, entries: state.entries, dropped: state.dropped, unloggedData: state.unloggedData,
  };
}

export const fileStamp = (d) => d.toISOString().slice(0, 19).replace(/[-:]/g, "") + "Z";

export async function buildEvidenceZip(input) {
  const m = await buildManifest(input);
  const mBytes = enc(JSON.stringify(m, null, 2) + "\n");
  const sums = enc(sha256Sums([...m.files, { name: "MANIFEST.json", sha256: await sha256Hex(mBytes) }]));
  const members = [...input.files, { name: "MANIFEST.json", bytes: mBytes }, { name: "SHA256SUMS", bytes: sums }];
  const zip = createZip(members, new Date(input.exportedAt));
  return { zip, sha256: await sha256Hex(zip), names: members.map((f) => f.name) };
}

const utc = (iso) => iso.slice(0, 19).replace("T", " ");

/** Provenance footer text (PNG/PDF) as translated lines. */
export function footerLines({ t, appVersion, exportedAt, retrieval, bridges }) {
  return [
    t("export.footer.app", { version: appVersion, at: utc(exportedAt) }),
    retrieval
      ? t("export.footer.retrieved", { first: utc(retrieval.first), last: utc(retrieval.last), n: retrieval.queries })
      : t("export.footer.retrievalUnknown"),
    ...(retrieval && !retrieval.fullyLogged ? [t("export.footer.partial")] : []),
    t("export.footer.sampling"),
    t("export.footer.signals"),
    ...(bridges ? [t("export.footer.bridges")] : []),
  ];
}
