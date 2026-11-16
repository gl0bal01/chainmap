import { describe, test, expect } from "bun:test";
import {
  CAVEATS, PARTIAL_CAVEAT, knownDataSnapshot, retrievalSummary, observedSampling,
  buildManifest, sha256Sums, queryLogDocument, fileStamp, buildEvidenceZip,
} from "../src/evidence.js";
import { sha256Hex } from "../src/queryLog.js";
import { APP_VERSION } from "../src/config.js";
import { readZip } from "./fixtures/readZip.js";

const enc = (s) => new TextEncoder().encode(s);
const EXPORTED = "2026-11-16T10:15:30.000Z";
const logged = { queries: 1, dropped: 0, first: "a", last: "b", fullyLogged: true };
const mkInput = (over = {}) => ({
  exportedAt: EXPORTED,
  chains: [{ chainId: "1", name: "Ethereum" }],
  roots: ["0xabc"],
  graph: { nodes: 2, edges: 1 },
  sampling: { formAtExport: { maxDepth: 2, maxTxPerAddress: 100, safetyCap: 500, types: ["txlist"] }, observed: { pageSizes: [], sorts: [], actions: [] } },
  retrieval: logged,
  data: { knownAddresses: { entries: 0, ofacPublished: null } },
  files: [{ name: "graph.csv", bytes: enc("a,b\n") }, { name: "workspace.json", bytes: enc("{}") }],
  omitted: [],
  ...over,
});
const E = (at, offset = "20") => ({ at, action: "txlist", params: { offset, sort: "desc" } });

describe("evidence", () => {
  test("buildManifest hashes", async () => {
    const inp = mkInput();
    const m = await buildManifest(inp);
    for (let i = 0; i < 2; i++) {
      expect(m.files[i].sha256).toBe(await sha256Hex(inp.files[i].bytes));
      expect(m.files[i].bytes).toBe(inp.files[i].bytes.length);
    }
    expect(Object.keys(m)).toEqual(["format", "app", "exportedAt", "chains", "roots", "graph", "sampling", "retrieval", "data", "caveats", "files", "omitted"]);
    expect(m.format).toBe("chainmap-evidence/1");
    expect(m.app.version).toBe(APP_VERSION);
  });
  test("omitted honoured", async () => {
    const m = await buildManifest(mkInput({ omitted: [{ name: "graph.png", reason: "too-large" }] }));
    expect(m.omitted).toEqual([{ name: "graph.png", reason: "too-large" }]);
    expect(m.files.some((f) => f.name === "graph.png")).toBe(false);
  });
  test("partial caveat", async () => {
    expect((await buildManifest(mkInput({ retrieval: null }))).caveats).toContain(PARTIAL_CAVEAT);
    expect((await buildManifest(mkInput({ retrieval: { ...logged, fullyLogged: false } }))).caveats).toContain(PARTIAL_CAVEAT);
    expect((await buildManifest(mkInput())).caveats).toEqual(CAVEATS);
  });
  test("knownDataSnapshot", () => {
    expect(knownDataSnapshot({
      "*": { a: { source: "x" } },
      "1": { b: { source: "OFAC SDN list, published 2026-11-13" }, c: { source: "OFAC SDN list, published 2025-01-02" } },
    })).toEqual({ entries: 3, ofacPublished: "2026-11-13" });
    expect(knownDataSnapshot({})).toEqual({ entries: 0, ofacPublished: null });
  });
  test("sha256Sums", () => {
    expect(sha256Sums([{ name: "a", sha256: "0".repeat(64) }])).toBe("0".repeat(64) + "  a\n");
  });
  test("retrievalSummary / observedSampling", () => {
    expect(retrievalSummary({ entries: [], dropped: 0, unloggedData: false })).toBeNull();
    const es = [E("2026-11-16T10:00:05Z"), E("2026-11-16T10:00:02Z")];
    expect(retrievalSummary({ entries: es, dropped: 0, unloggedData: false }))
      .toEqual({ queries: 2, dropped: 0, first: "2026-11-16T10:00:02Z", last: "2026-11-16T10:00:05Z", fullyLogged: true });
    expect(retrievalSummary({ entries: es, dropped: 0, unloggedData: true }).fullyLogged).toBe(false);
    expect(retrievalSummary({ entries: es, dropped: 1, unloggedData: false }).fullyLogged).toBe(false);
    expect(observedSampling([E("a", "100"), E("b", "20"), E("c", "20")]))
      .toEqual({ pageSizes: ["20", "100"], sorts: ["desc"], actions: ["txlist"] });
  });
  test("fileStamp", () => {
    expect(fileStamp(new Date("2026-11-16T10:15:30.123Z"))).toBe("20261116T101530Z");
  });
  test("queryLogDocument", () => {
    const d = queryLogDocument({ entries: [], dropped: 0, unloggedData: false }, EXPORTED);
    expect(Object.keys(d)).toEqual(["format", "app", "exportedAt", "entries", "dropped", "unloggedData"]);
    expect(d.format).toBe("chainmap-query-log/1");
    expect(d.app).toEqual({ name: "chainmap", version: APP_VERSION });
  });
  test("buildEvidenceZip", async () => {
    const files = ["graph.csv", "workspace.json", "graph.png", "query-log.json"].map((name) => ({ name, bytes: enc("data:" + name) }));
    const { zip, sha256, names } = await buildEvidenceZip(mkInput({ files }));
    const r = readZip(zip);
    expect(r.map((f) => f.name)).toEqual([...files.map((f) => f.name), "MANIFEST.json", "SHA256SUMS"]);
    expect(names).toEqual(r.map((f) => f.name));
    const by = Object.fromEntries(r.map((f) => [f.name, f.bytes]));
    const lines = new TextDecoder().decode(by["SHA256SUMS"]).trim().split("\n");
    expect(lines.length).toBe(5);
    for (const l of lines) {
      const [hex, name] = l.split("  ");
      expect(hex).toBe(await sha256Hex(by[name]));
    }
    const m = JSON.parse(new TextDecoder().decode(by["MANIFEST.json"]));
    for (const f of m.files) expect(f.sha256).toBe(await sha256Hex(by[f.name]));
    expect(sha256).toBe(await sha256Hex(zip));
  });
  test("caveats content", () => {
    const t = CAVEATS.join(" ").toLowerCase();
    for (const re of [/sampl/, /signals, not facts/, /heuristic/, /same-key/, /snapshot/, /graph\.png and graph\.csv/, /estimate/, /tamper/]) expect(t).toMatch(re);
  });
});

describe("footerLines", () => {
  const mk = async (locale) => {
    const { createI18n } = await import("../src/i18n.js");
    const en = (await import("../src/locales/en.js")).default;
    const fr = (await import("../src/locales/fr.js")).default;
    return createI18n({ dictionaries: { en, fr }, locale });
  };
  const ret = { queries: 4, dropped: 0, first: "2026-11-16T09:00:00.000Z", last: "2026-11-16T09:30:00.000Z", fullyLogged: true };
  const base = { appVersion: "1.3.0", exportedAt: "2026-11-16T10:15:30.123Z" };

  test("footerLines en", async () => {
    const { footerLines } = await import("../src/evidence.js");
    const i18n = await mk("en");
    const lines = footerLines({ ...base, t: i18n.t, retrieval: ret });
    expect(lines.length).toBe(4);
    expect(lines[0]).toBe("chainmap 1.3.0 — exported 2026-11-16 10:15:30 UTC");
    const unk = footerLines({ ...base, t: i18n.t, retrieval: null });
    expect(unk.length).toBe(4);
    expect(unk[1]).toBe("Retrieval time unknown — no query log");
    expect(footerLines({ ...base, t: i18n.t, retrieval: { ...ret, fullyLogged: false } }).length).toBe(5);
  });

  test("footerLines: retrieved line has no plural to get wrong (n = 1), en + fr", async () => {
    const { footerLines } = await import("../src/evidence.js");
    const one = { ...ret, queries: 1 };
    expect(footerLines({ ...base, t: (await mk("en")).t, retrieval: one })[1])
      .toBe("Data retrieved 2026-11-16 09:00:00 to 2026-11-16 09:30:00 UTC from api.etherscan.io — logged requests: 1 (see query log)");
    expect(footerLines({ ...base, t: (await mk("fr")).t, retrieval: one })[1])
      .toBe("Données récupérées du 2026-11-16 09:00:00 au 2026-11-16 09:30:00 UTC depuis api.etherscan.io — requêtes consignées : 1 (voir le journal des requêtes)");
  });

  test("footerLines fr", async () => {
    const { footerLines } = await import("../src/evidence.js");
    const i18n = await mk("fr");
    const lines = footerLines({ ...base, t: i18n.t, retrieval: { ...ret, fullyLogged: false } });
    expect(lines.length).toBe(5);
    for (const l of lines) { expect(l).not.toBe(""); expect(l).not.toContain("{"); }
  });
});

test("manifest caveats define retrieval.fullyLogged and say it does not mean complete data", () => {
  const def = CAVEATS.find((c) => c.includes("fullyLogged"));
  expect(def).toBeDefined();
  for (const part of ["not mean the data is complete", "failed", "stopped", "sampled"]) expect(def).toContain(part);
});
