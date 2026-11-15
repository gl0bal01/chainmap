// Dev-only CLI: regenerate data/known-addresses.json from the OFAC SDN list, the
// OP superchain registry and data/sources/curated.json. Glue only — all logic
// lives in ./known-addresses/pipeline.mjs. Needs network; never run in CI.
//   bun run data:build [--ofac <sdn.xml>] [--verify-sources]
import { readFileSync, writeFileSync } from "node:fs";
import { parseOfacXml, parseSuperchain, mergeSources, serializeKnownData, verifyEntry } from "./known-addresses/pipeline.mjs";

const OFAC_URL = "https://sanctionslistservice.ofac.treas.gov/api/publicationpreview/exports/sdn.xml";
const REGISTRY = "ethereum-optimism/superchain-registry";
const CURATED = new URL("../data/sources/curated.json", import.meta.url);
const OUT = new URL("../data/known-addresses.json", import.meta.url);
// No request carries user data. OFAC's WAF 403s custom user-agents, so only the
// --verify-sources fetches (third-party pages) identify as chainmap-data-build.
const VERIFY_UA = { "user-agent": "chainmap-data-build" };

function parseArgs(argv) {
  const opts = { ofac: null, verify: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--verify-sources") opts.verify = true;
    else if (argv[i] === "--ofac" && argv[i + 1]) opts.ofac = argv[++i];
    else {
      console.error("usage: bun run data:build [--ofac <sdn.xml>] [--verify-sources]");
      process.exit(2);
    }
  }
  return opts;
}

async function get(url, { headers = {}, timeout = 120_000 } = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

async function loadRegistry() {
  const headers = { accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com/repos/${REGISTRY}/commits/main`, { headers, signal: AbortSignal.timeout(30_000) });
  if (res.status !== 200) {
    throw new Error(`GitHub API HTTP ${res.status} for ${REGISTRY}@main: set GITHUB_TOKEN (e.g. \`GITHUB_TOKEN=$(gh auth token)\`) or retry later`);
  }
  const commit = await res.json();
  const ref = { sha: commit.sha, date: commit.commit.committer.date.slice(0, 10) };
  const raw = (path) => get(`https://raw.githubusercontent.com/${REGISTRY}/${ref.sha}/${path}`).then((r) => r.json());
  const [addresses, chainList] = await Promise.all([raw("superchain/extra/addresses/addresses.json"), raw("chainList.json")]);
  return { ref, ...parseSuperchain(addresses, chainList, ref) };
}

/** Keep `verified`; keep `unsourced` only for legacy rows marked "needs official source". */
async function verifyCurated(rows) {
  const cache = new Map(); // url -> Promise<string>
  const fetchText = (url) => {
    if (!cache.has(url)) cache.set(url, get(url, { headers: VERIFY_UA, timeout: 30_000 }).then((r) => r.text()));
    return cache.get(url);
  };
  const kept = [], excluded = [];
  for (const row of rows) {
    const status = await verifyEntry(row, fetchText); // sequential: polite to the cited hosts
    if (status === "verified" || (status === "unsourced" && row.note === "needs official source")) kept.push(row);
    else excluded.push(`${row.chainId}:${row.address} ${row.label} → ${status}`);
  }
  return { kept, excluded };
}

const list = (title, items) => {
  console.log(`${title} (${items.length})${items.length ? ":" : ""}`);
  for (const it of items) console.log(`  ${it}`);
};

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const curatedAll = JSON.parse(readFileSync(CURATED, "utf8"));
  const xml = opts.ofac ? readFileSync(opts.ofac, "utf8") : await (await get(OFAC_URL, { timeout: 300_000 })).text();
  const ofac = parseOfacXml(xml); // throws on truncated/HTML/drifted input -> nothing written
  const registry = await loadRegistry();
  const { kept: curated, excluded } = opts.verify ? await verifyCurated(curatedAll) : { kept: curatedAll, excluded: [] };

  const { data, report } = mergeSources({ ofac, registry: registry.rows, curated });
  writeFileSync(OUT, serializeKnownData(data));

  const tags = {};
  for (const s of ofac.skippedIds) tags[s.tag] = (tags[s.tag] ?? 0) + 1;
  console.log(`OFAC SDN: ${opts.ofac ?? OFAC_URL}, published ${report.ofacPublishDate}, ${ofac.entries.length} EVM addresses`);
  console.log(`OFAC skippedIds (${ofac.skippedIds.length}): ${JSON.stringify(tags)}`);
  // non-0x ids under an EVM tag (e.g. TRON-format USDT) are expected; a 0x-shaped skip is format drift
  list("OFAC skipped 0x-shaped ids (format drift)", ofac.skippedIds.filter((s) => /^0x/i.test(s.idNumber)).map((s) => `${s.tag}: ${s.idNumber}`));
  console.log(`superchain-registry: ${REGISTRY}@${registry.ref.sha} (${registry.ref.date}), ${registry.rows.length} rows`);
  console.log(`registry skipped chain ids (not mainnet-parented) (${registry.skipped.length}): ${registry.skipped.join(", ")}`);
  console.log(`curated: ${curatedAll.length} rows${opts.verify ? `, ${curated.length} kept after --verify-sources` : " (not verified this run)"}`);
  console.log(`counts by source: ${JSON.stringify(report.counts.bySource)}`);
  console.log(`counts by chain: ${JSON.stringify(report.counts.byChain)}`);
  console.log(`counts by category: ${JSON.stringify(report.counts.byCategory)}`);
  list("rejected", report.rejected.map((r) => `${r.row.chainId}:${r.row.address} ${r.row.label} → ${r.reason}`));
  if (opts.verify) list("excluded by --verify-sources", excluded);
  list("needsSource", report.needsSource);
  list("delisted", report.delisted);
  console.log(`wrote ${OUT.pathname}`);
}

main().catch((e) => {
  console.error(`data:build failed (nothing written): ${e.message}`);
  process.exit(1);
});
