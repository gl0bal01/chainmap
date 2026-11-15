// Pure helpers for the known-addresses data pipeline (dev-only; no network, no DOM).
import { CHAINS, KNOWN_CATEGORIES } from "../../src/config.js";
import { isValidAddress } from "../../src/format.js";

/** @typedef {{ chainId:string, address:string, label:string, category:string, source:string, added:string, symbol?:string, decimals?:number, note?:string, ofacDesignated?:string }} SourceRow */
/** @typedef {{ publishDate:string, entries:Array<{address:string, name:string}> }} OfacData */
/** @typedef {{ ofacPublishDate:string, rejected:Array<{row:object, reason:string}>, needsSource:string[], delisted:string[], counts:{ bySource:{ofac:number, registry:number, curated:number}, byChain:Record<string,number>, byCategory:Record<string,number> } }} MergeReport */

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m]);
const tag = (s, name) => {
  const m = s.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1].trim()) : "";
};

/** @param {string} xml @returns {OfacData} */
export function parseOfacXml(xml) {
  const d = /<Publish_Date>\s*(\d{2})\/(\d{2})\/(\d{4})\s*<\/Publish_Date>/.exec(xml);
  if (!d) throw new Error("OFAC SDN: Publish_Date missing (not an SDN XML?)");
  if (!/<\/(?:\w+:)?sdnList>\s*$/.test(xml)) throw new Error("OFAC SDN: truncated download (no closing </sdnList>)");
  const publishDate = `${d[3]}-${d[1]}-${d[2]}`;
  const entries = [];
  const skippedIds = []; // 0x-shaped crypto ids we did not take, or malformed ids under allowlisted tags (format drift)
  const seen = new Set();
  for (const chunk of xml.split("<sdnEntry>").slice(1)) {
    const head = chunk.split("<sdnType>")[0]; // aka blocks (after sdnType) also carry lastName
    const last = tag(head, "lastName"), first = tag(head, "firstName");
    const name = first ? `${last}, ${first}` : last;
    for (const m of chunk.matchAll(/<id>([\s\S]*?)<\/id>/g)) {
      const idType = tag(m[1], "idType");
      if (!idType.startsWith("Digital Currency Address - ")) continue;
      const addr = tag(m[1], "idNumber");
      const allowed = /^Digital Currency Address - (ETH|USDT|USDC|ARB|BSC|ETC)$/.test(idType);
      const valid = /^0x[0-9a-fA-F]{40}$/.test(addr);
      if (allowed ? !valid : /^0x/i.test(addr)) skippedIds.push({ tag: idType, idNumber: addr });
      if (!allowed || !valid) continue;
      const address = addr.toLowerCase();
      if (seen.has(address)) continue;
      seen.add(address);
      entries.push({ address, name });
    }
  }
  if (!entries.length) throw new Error("OFAC SDN: no EVM addresses found (format drift?)");
  return { publishDate, entries, skippedIds };
}

const BRIDGE_KEYS = ["L1StandardBridgeProxy", "OptimismPortalProxy", "L1CrossDomainMessengerProxy", "L1ERC721BridgeProxy"];

/** @returns {{ rows: SourceRow[], skipped: string[] }} */
export function parseSuperchain(addresses, chainList, ref) {
  const byId = new Map(chainList.map((c) => [String(c.chainId), c]));
  const source = `https://github.com/ethereum-optimism/superchain-registry/blob/${ref.sha}/superchain/extra/addresses/addresses.json`;
  const rows = [], skipped = [];
  for (const [id, addrs] of Object.entries(addresses)) {
    const chain = byId.get(id);
    if (chain?.parent?.chain !== "mainnet") { skipped.push(id); continue; }
    for (const key of BRIDGE_KEYS) {
      if (!addrs[key]) continue;
      rows.push({ chainId: "1", address: addrs[key].toLowerCase(), label: `${chain.name} ${key}`, category: "bridge", source, added: ref.date });
    }
  }
  return { rows, skipped };
}

const CHAIN_IDS = new Set(CHAINS.map((c) => String(c.id)));
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validate(row, curated) {
  if (!isValidAddress(row.address)) return "invalid address";
  const cid = String(row.chainId);
  if (cid !== "*" && !CHAIN_IDS.has(cid)) return "invalid chainId";
  if (curated && (row.category === "sanctioned" || /\bOFAC\b|\bSDN\b|sanction/i.test(row.label ?? ""))) return "curated sanctioned";
  if (row.category === "token" &&
      !(typeof row.symbol === "string" && row.symbol && row.symbol === row.symbol.toUpperCase() && Number.isInteger(row.decimals))) return "bad token fields";
  if (!KNOWN_CATEGORIES.includes(row.category)) return "unknown category";
  if (!row.label || !row.source || !DATE.test(row.added ?? "")) return "missing field";
  if (row.ofacDesignated !== undefined && !DATE.test(row.ofacDesignated)) return "bad ofacDesignated";
  return null;
}

/** @param {{ ofac: OfacData, registry: SourceRow[], curated: SourceRow[] }} p */
export function mergeSources({ ofac, registry, curated }) {
  const data = {}, prov = {};
  const rejected = [], needsSource = [], delisted = [];
  const sdn = new Set(ofac.entries.map((e) => e.address));
  const put = (chain, addr, entry, source) => {
    (data[chain] ??= {})[addr] = entry;
    (prov[chain] ??= {})[addr] = source;
  };

  for (const e of ofac.entries) {
    put("*", e.address, { label: `${e.name} (OFAC SDN)`, category: "sanctioned", source: `OFAC SDN list, published ${ofac.publishDate}`, added: ofac.publishDate }, "ofac");
  }

  const apply = (rows, which) => {
    const seen = new Set();
    for (const r of rows) {
      const reason = validate(r, which === "curated");
      if (reason) { rejected.push({ row: r, reason }); continue; }
      const chain = String(r.chainId), address = r.address.toLowerCase();
      if (which === "curated") {
        const k = `${chain}:${address}`;
        if (seen.has(k)) { rejected.push({ row: r, reason: "duplicate" }); continue; }
        seen.add(k);
      }
      let { label, category } = r;
      if (sdn.has(address)) { category = "sanctioned"; label += " (OFAC SDN)"; }
      else if (r.ofacDesignated) { label += " (delisted from OFAC SDN)"; delisted.push(`${chain}:${address}`); }
      const entry = { label, category };
      if (r.symbol !== undefined) entry.symbol = r.symbol;
      if (r.decimals !== undefined) entry.decimals = r.decimals;
      entry.source = r.source;
      entry.added = r.added;
      if (r.note) entry.note = r.note;
      put(chain, address, entry, which);
      if (which === "curated" && r.note === "needs official source") needsSource.push(`${chain}:${address} ${r.label}`);
    }
  };
  apply(registry, "registry");
  apply(curated, "curated");

  const counts = { bySource: { ofac: 0, registry: 0, curated: 0 }, byChain: {}, byCategory: {} };
  for (const [chain, m] of Object.entries(data)) {
    for (const [addr, e] of Object.entries(m)) {
      counts.bySource[prov[chain][addr]]++;
      counts.byChain[chain] = (counts.byChain[chain] ?? 0) + 1;
      counts.byCategory[e.category] = (counts.byCategory[e.category] ?? 0) + 1;
    }
  }
  return { data, report: { ofacPublishDate: ofac.publishDate, rejected, needsSource, delisted, counts } };
}

/** Deterministic text: "*" first, then chains ascending numerically; one line per entry. */
export function serializeKnownData(data) {
  const chains = Object.keys(data).sort((a, b) => (a === "*" ? -1 : b === "*" ? 1 : Number(a) - Number(b)));
  const body = chains.map((c) => {
    const lines = Object.keys(data[c]).sort().map((a) => `    ${JSON.stringify(a)}: ${JSON.stringify(data[c][a])}`);
    return `  ${JSON.stringify(c)}: {\n${lines.join(",\n")}\n  }`;
  });
  return `{\n${body.join(",\n")}\n}\n`;
}

/** @returns {Promise<'verified'|'unsourced'|'absent'|'fetch-failed'>} */
export async function verifyEntry(entry, fetchText) {
  if (!isValidAddress(entry.address)) return "absent";
  if (!/^https?:\/\//i.test(entry.source)) return "unsourced";
  // a URL embedding the address would be echoed back by 404/SPA pages: not independent evidence
  if (entry.source.toLowerCase().includes(entry.address.toLowerCase())) return "unsourced";
  let body;
  try { body = await fetchText(entry.source); } catch { return "fetch-failed"; }
  return new RegExp(entry.address + "(?![0-9a-f])", "i").test(body) ? "verified" : "absent";
}
