import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseOfacXml, parseSuperchain, mergeSources, serializeKnownData, verifyEntry } from "../scripts/known-addresses/pipeline.mjs";

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");
const AA = "0x" + "aa".repeat(20), BB = "0x" + "bb".repeat(20), CC = "0x" + "cc".repeat(20), DD = "0x" + "dd".repeat(20);
const TRON = "728126428";
const TA = "41" + "aa".repeat(20), TB = "41" + "bb".repeat(20), TC = "41" + "cc".repeat(20), TD = "41" + "dd".repeat(20);
const T_AA = "TRXcKoEvHr6Y38VMcDYGBEYKznvH3XUX4g", T_BB = "TT5rFsXYCrnzdE2q1WdR9F2SuVY59A4hoM", T_CC = "TUe6BwpA7sVTDKaJQoia7FWZpC9sK8WM2t";
const T_BAD = "TRXcKoEvHr6Y38VMcDYGBEYKznvH3XUX4h"; // T_AA with a broken checksum

describe("parseOfacXml", () => {
  test("EVM ids lowercased, Tron T… ids as 41-hex, primary name (LAST, First), entities decoded, first entry wins", () => {
    expect(parseOfacXml(fx("sdn-mini.xml"))).toEqual({
      publishDate: "2026-11-13",
      entries: [
        { address: AA, name: "LAZARUS GROUP" },
        { address: BB, name: "LAZARUS GROUP" },
        { address: CC, name: "SEMENOV, Roman" },
        { address: DD, name: "A & B TRADING" },
      ],
      tronEntries: [
        { address: TB, name: "LAZARUS GROUP", tag: "Digital Currency Address - USDT" },
        { address: TA, name: "TRON TEST CO", tag: "Digital Currency Address - TRX" },
        { address: TC, name: "TRON TEST CO", tag: "Digital Currency Address - XBT" },
        { address: TD, name: "SECOND HOLDER", tag: "Digital Currency Address - ETH" },
      ],
      skippedIds: [
        { tag: "Digital Currency Address - TRX", idNumber: "TXyz1234567890abcdefghijklmnopqrst" },
        { tag: "Digital Currency Address - TRX", idNumber: T_BAD },
        { tag: "Digital Currency Address - TRX", idNumber: "0x" + "ee".repeat(20) },
        { tag: "Digital Currency Address - TRX", idNumber: T_AA.toLowerCase() },
      ],
    });
  });
  test("throws on truncated XML (cut inside an entry)", () => {
    const x = fx("sdn-mini.xml");
    expect(() => parseOfacXml(x.slice(0, x.indexOf("SEMENOV") + 5))).toThrow(/truncated/);
  });
  const withIds = (ids) => fx("sdn-mini.xml").replace("</sdnList>",
    `<sdnEntry><lastName>Z</lastName><sdnType>Entity</sdnType><idList>${ids}</idList></sdnEntry></sdnList>`);
  const id = (t, n) => `<id><idType>Digital Currency Address - ${t}</idType><idNumber>${n}</idNumber></id>`;
  test("a valid 0x address under a non-allowlisted tag is format drift: throws naming the tag(s)", () => {
    const x = withIds(id("POL", "0x" + "e".repeat(40)) + id("BASE", "0x" + "f".repeat(40)) + id("ETH", "0xshort"));
    expect(() => parseOfacXml(x)).toThrow(/non-allowlisted tag\(s\) Digital Currency Address - POL, Digital Currency Address - BASE/);
  });
  test("skippedIds: malformed ids under allowlisted tags and 0x non-addresses elsewhere are skipped, not fatal", () => {
    const r = parseOfacXml(withIds(id("ETH", "0xshort") + id("USDT", "TXyz") + id("POL", "0x12")));
    expect(r.entries.length).toBe(4);
    expect(r.skippedIds.slice(-3)).toEqual([
      { tag: "Digital Currency Address - ETH", idNumber: "0xshort" },
      { tag: "Digital Currency Address - USDT", idNumber: "TXyz" },
      { tag: "Digital Currency Address - POL", idNumber: "0x12" },
    ]);
  });
  test("a T…-shaped id failing the checksum is skipped under any tag", () => {
    const r = parseOfacXml(withIds(id("SOL", T_BAD)));
    expect(r.skippedIds).toContainEqual({ tag: "Digital Currency Address - SOL", idNumber: T_BAD });
    expect(r.tronEntries.map((e) => e.tag)).not.toContain("Digital Currency Address - SOL");
    expect(r.tronEntries.length).toBe(4);
  });
  test("a 0x under TRX is skipped, not drift", () => {
    expect(() => parseOfacXml(fx("sdn-mini.xml"))).not.toThrow();
    expect(parseOfacXml(withIds(id("TRX", "0x" + "f".repeat(40)))).skippedIds)
      .toContainEqual({ tag: "Digital Currency Address - TRX", idNumber: "0x" + "f".repeat(40) });
  });
  test("a 41-hex id under TRX is skipped, never a Tron row", () => {
    const h = "41" + "ab".repeat(20);
    const r = parseOfacXml(withIds(id("TRX", h)));
    expect(r.skippedIds).toContainEqual({ tag: "Digital Currency Address - TRX", idNumber: h });
    expect(r.tronEntries.length).toBe(4);
  });
  test("a 41-hex id under a non-Tron tag is a skipped id listed under its tag", () => {
    const h = "41" + "ab".repeat(20);
    const r = parseOfacXml(withIds(id("XBT", h)));
    expect(r.skippedIds).toContainEqual({ tag: "Digital Currency Address - XBT", idNumber: h });
    expect(r.tronEntries.length).toBe(4);
  });
  test("zero Tron addresses throws", () => {
    const evmOnly = `<sdnList><publshInformation><Publish_Date>11/13/2026</Publish_Date></publshInformation>
      <sdnEntry><lastName>X</lastName><sdnType>Entity</sdnType><idList>${id("ETH", AA)}${id("TRX", "TXyz")}</idList></sdnEntry></sdnList>`;
    expect(() => parseOfacXml(evmOnly)).toThrow(/no Tron addresses found/);
  });
  test("throws without Publish_Date (error page) or without any EVM address (format drift)", () => {
    expect(() => parseOfacXml("<html>Service Unavailable</html>")).toThrow();
    const noEvm = `<sdnList><publshInformation><Publish_Date>11/13/2026</Publish_Date></publshInformation>
      <sdnEntry><lastName>X</lastName><sdnType>Entity</sdnType><idList>${id("TRX", T_AA)}</idList></sdnEntry></sdnList>`;
    expect(() => parseOfacXml(noEvm)).toThrow(/no EVM addresses found/);
  });
});

describe("parseSuperchain", () => {
  const ref = { sha: "abc1234def", date: "2026-11-14" };
  const { rows, skipped } = parseSuperchain(JSON.parse(fx("superchain-addresses.json")), JSON.parse(fx("superchain-chainList.json")), ref);
  test("keeps the 4 bridge contracts of mainnet-parented L2s as chain-1 bridges", () => {
    expect(rows.map((r) => r.label).sort()).toEqual([
      "OP Mainnet L1CrossDomainMessengerProxy", "OP Mainnet L1ERC721BridgeProxy",
      "OP Mainnet L1StandardBridgeProxy", "OP Mainnet OptimismPortalProxy",
    ]);
    expect(rows.find((r) => r.label === "OP Mainnet OptimismPortalProxy")).toEqual({
      chainId: "1", address: "0xabcdef0000000000000000000000000000000002", label: "OP Mainnet OptimismPortalProxy",
      category: "bridge",
      source: "https://github.com/ethereum-optimism/superchain-registry/blob/abc1234def/superchain/extra/addresses/addresses.json",
      added: "2026-11-14",
    });
  });
  test("skips L2s not parented on Ethereum mainnet or absent from chainList", () => {
    expect([...skipped].sort()).toEqual(["11155420", "424242"]);
  });
});

describe("mergeSources", () => {
  const ofac = { publishDate: "2026-11-13", entries: [{ address: AA, name: "LAZARUS GROUP" }] };
  const row = (o) => ({ chainId: "1", label: "L", category: "other", source: "https://example.org/x", added: "2026-11-16", ...o });
  const merge = (curated, registry = []) => mergeSources({ ofac, registry, curated });

  test("OFAC entries land under '*' as sanctioned", () => {
    expect(merge([]).data["*"][AA]).toEqual({
      label: "LAZARUS GROUP (OFAC SDN)", category: "sanctioned",
      source: "OFAC SDN list, published 2026-11-13", added: "2026-11-13",
    });
  });
  test("curated row of a listed address -> sanctioned + ' (OFAC SDN)'; '*' entry coexists; ofacDesignated not emitted", () => {
    const { data } = merge([row({ address: AA.toUpperCase().replace("0X", "0x"), label: "Ronin Exploiter", ofacDesignated: "2022-04-14" })]);
    expect(data["1"][AA]).toEqual({
      label: "Ronin Exploiter (OFAC SDN)", category: "sanctioned",
      source: "https://example.org/x; OFAC SDN list, published 2026-11-13", added: "2026-11-16", // snapshot date visible in Source
    });
    expect(data["*"][AA].category).toBe("sanctioned");
  });
  test("a curated '*' row for a listed address is rejected; the OFAC entry keeps its provenance", () => {
    const { data, report } = merge([row({ chainId: "*", address: AA, label: "Ronin Exploiter", category: "other" })]);
    expect(report.rejected.map((r) => r.reason)).toEqual(["curated conflicts with OFAC"]);
    expect(data["*"][AA]).toEqual({
      label: "LAZARUS GROUP (OFAC SDN)", category: "sanctioned",
      source: "OFAC SDN list, published 2026-11-13", added: "2026-11-13",
    });
  });
  test("designated but absent from the SDN -> base category kept, '(delisted from OFAC SDN)', reported", () => {
    const { data, report } = merge([row({ address: BB, label: "Tornado Cash: 100 ETH", category: "mixer", ofacDesignated: "2022-08-08" })]);
    expect(data["1"][BB]).toMatchObject({ label: "Tornado Cash: 100 ETH (delisted from OFAC SDN)", category: "mixer" });
    expect(report.delisted).toEqual([`1:${BB}`]);
  });
  test("absent and never designated -> untouched", () => {
    expect(merge([row({ address: BB, label: "Uniswap", category: "router" })]).data["1"][BB]).toMatchObject({ label: "Uniswap", category: "router" });
  });
  test("curated beats registry at the same key; token fields kept", () => {
    const reg = [row({ address: CC, label: "OP Mainnet L1StandardBridgeProxy", category: "bridge", source: "https://github.com/x" })];
    const { data } = merge([row({ address: CC, label: "Optimism: L1StandardBridge", category: "bridge" }), row({ address: DD, category: "token", symbol: "USDC", decimals: 6 })], reg);
    expect(data["1"][CC].label).toBe("Optimism: L1StandardBridge");
    expect(data["1"][DD]).toMatchObject({ category: "token", symbol: "USDC", decimals: 6 });
  });
  test("rejects invalid rows with a reason", () => {
    const { data, report } = merge([
      row({ address: "0x123" }),
      row({ address: BB, chainId: "999999999" }),
      row({ address: BB, category: "sanctioned" }),
      row({ address: BB, category: "token" }),
      row({ address: BB, category: "nope" }),
      row({ address: BB, source: "" }),
      row({ address: CC }), row({ address: CC }),
    ]);
    expect(report.rejected.map((r) => r.reason)).toEqual([
      "invalid address", "invalid chainId", "curated sanctioned", "bad token fields", "unknown category", "missing field", "duplicate",
    ]);
    expect(Object.keys(data["1"])).toEqual([CC]);
  });
  test("curated labels asserting sanctions, and bad ofacDesignated, are rejected", () => {
    const { report } = merge([
      row({ address: BB, label: "Roman Semenov (OFAC)" }),
      row({ address: BB, label: "X on the SDN list" }),
      row({ address: BB, ofacDesignated: "April 2022" }),
    ]);
    expect(report.rejected.map((r) => r.reason)).toEqual(["curated sanctioned", "curated sanctioned", "bad ofacDesignated"]);
  });
  test("needs-official-source rows are kept and listed; counts reported", () => {
    const { data, report } = merge([row({ address: BB, label: "Binance 14", category: "exchange", source: "Etherscan public label", note: "needs official source" })]);
    expect(data["1"][BB].note).toBe("needs official source");
    expect(report.needsSource).toEqual([`1:${BB} Binance 14`]);
    expect(report.counts.bySource).toEqual({ ofac: 1, registry: 0, curated: 1 });
    expect(report.counts.byChain).toEqual({ "*": 1, "1": 1 });
    expect(report.counts.byCategory).toEqual({ sanctioned: 1, exchange: 1 });
    expect(report.ofacPublishDate).toBe("2026-11-13");
  });

  const ofacT = { ...ofac, tronEntries: [{ address: TA, name: "GARANTEX", tag: "Digital Currency Address - USDT" }] };
  const mergeT = (curated) => mergeSources({ ofac: ofacT, registry: [], curated });
  const tron = (o) => row({ chainId: TRON, category: "token", symbol: "USDT", decimals: 6, ...o });
  test("Tron OFAC entries land under 728126428 as sanctioned", () => {
    const { data, report } = mergeT([]);
    expect(data[TRON][TA]).toEqual({
      label: "GARANTEX (OFAC SDN)", category: "sanctioned",
      source: "OFAC SDN list, published 2026-11-13", added: "2026-11-13",
    });
    expect(data["*"][TA]).toBeUndefined();
    expect(report.counts.bySource.ofac).toBe(2);
    expect(report.counts.byChain[TRON]).toBe(1);
  });
  test("a curated Tron token row given as T… is written as canonical 41-hex", () => {
    const { data, report } = mergeT([tron({ address: T_BB })]);
    expect(report.rejected).toEqual([]);
    expect(data[TRON][TB]).toMatchObject({ category: "token", symbol: "USDT", decimals: 6 });
    expect(Object.keys(data[TRON]).some((k) => k.startsWith("T"))).toBe(false);
  });
  test("curated Tron rows: non-token, bad checksum, lowercased T…, T…/hex duplicate, OFAC conflict are rejected", () => {
    const { data, report } = mergeT([
      tron({ address: T_CC, category: "exchange" }),
      tron({ address: T_BAD }),
      tron({ address: T_BB.toLowerCase() }),
      tron({ address: T_BB }),
      tron({ address: TB }),
      tron({ address: T_AA }),
    ]);
    expect(report.rejected.map((r) => r.reason)).toEqual([
      "tron: token rows only", "invalid address", "invalid address", "duplicate", "curated conflicts with OFAC",
    ]);
    expect(Object.keys(data[TRON]).sort()).toEqual([TA, TB]);
    expect(data[TRON][TA].category).toBe("sanctioned");
  });
  test("a 41-hex curated row on an EVM chain is rejected", () => {
    expect(mergeT([row({ chainId: "1", address: TB })]).report.rejected.map((r) => r.reason)).toEqual(["invalid address"]);
  });
});

describe("serializeKnownData", () => {
  const rows = [
    { chainId: "56", address: DD, label: "d", category: "router", source: "https://e/d", added: "2026-11-16" },
    { chainId: "1", address: CC, label: "c", category: "router", source: "https://e/c", added: "2026-11-16" },
    { chainId: "1", address: BB, label: "b", category: "router", source: "https://e/b", added: "2026-11-16" },
  ];
  const ofac = { publishDate: "2026-11-13", entries: [{ address: AA, name: "X" }] };
  const out = (r) => serializeKnownData(mergeSources({ ofac, registry: [], curated: r }).data);
  test("deterministic regardless of input order; one line per entry; '*' first; round-trips", () => {
    const a = out(rows);
    expect(out([...rows].reverse())).toBe(a);
    expect(a.endsWith("}\n")).toBe(true);
    expect(a.split("\n").filter((l) => /^\s+"0x[0-9a-f]{40}": \{.*\},?$/.test(l)).length).toBe(4);
    expect(JSON.parse(a)).toEqual(mergeSources({ ofac, registry: [], curated: rows }).data); // round-trip
    expect(a.indexOf('"*"')).toBeLessThan(a.indexOf('"1"')); // text order: '*' first, then numeric
    expect(a.indexOf('"1"')).toBeLessThan(a.indexOf('"56"'));
    expect(a.indexOf(BB)).toBeLessThan(a.indexOf(CC));
  });
});

describe("verifyEntry", () => {
  const A = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const page = (body) => async () => body;
  test("verified when the cited page contains the address in any case", async () => {
    expect(await verifyEntry({ address: A.toLowerCase(), source: "https://x/y" }, page(`USDC: ${A}`))).toBe("verified");
    expect(await verifyEntry({ address: A, source: "https://x/y" }, page(A.toLowerCase()))).toBe("verified");
  });
  test("absent when missing; a longer hex run (bytes32) is not a match", async () => {
    expect(await verifyEntry({ address: A, source: "https://x" }, page("nothing here"))).toBe("absent");
    expect(await verifyEntry({ address: "0x" + "0".repeat(40), source: "https://x" }, page("0x" + "0".repeat(64)))).toBe("absent");
  });
  test("unsourced when source is not an http(s) URL; fetch never called", async () => {
    let called = false;
    expect(await verifyEntry({ address: A, source: "Etherscan public label" }, async () => { called = true; return A; })).toBe("unsourced");
    expect(called).toBe(false);
  });
  test("unsourced when the cited URL embeds the address (page would just echo it)", async () => {
    const url = `https://etherscan.io/address/${A}`;
    expect(await verifyEntry({ address: A.toLowerCase(), source: url }, page(`Not found: ${url}`))).toBe("unsourced");
  });
  test("absent for an invalid address", async () => {
    expect(await verifyEntry({ address: "", source: "https://x" }, page("anything"))).toBe("absent");
  });
  test("fetch-failed when the injected fetch throws", async () => {
    expect(await verifyEntry({ address: A, source: "https://x" }, async () => { throw new Error("HTTP 403"); })).toBe("fetch-failed");
  });
  const T = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  const tronRow = (address = T, source = "https://x/y") => ({ chainId: TRON, address, source });
  test("Tron: verified when the page contains the T… form (entry given as T… or 41-hex)", async () => {
    expect(await verifyEntry(tronRow(), page(`USDT TRC-20: ${T}.`))).toBe("verified");
    expect(await verifyEntry(tronRow("41a614f803b6fd780986a42c78ec9c7f77e6ded13c"), page(`<code>${T}</code>`))).toBe("verified");
  });
  test("Tron: absent when the page has it only lowercased or inside a longer base58 run", async () => {
    expect(await verifyEntry(tronRow(), page(T.toLowerCase()))).toBe("absent");
    expect(await verifyEntry(tronRow(), page(T + "x"))).toBe("absent");
    expect(await verifyEntry(tronRow(), page("x" + T))).toBe("absent");
  });
  test("Tron: unsourced when the cited URL embeds the address", async () => {
    expect(await verifyEntry(tronRow(T, `https://tronscan.org/#/contract/${T}`), page(T))).toBe("unsourced");
  });
  test("Tron: absent for a bad-checksum address", async () => {
    expect(await verifyEntry(tronRow(T_BAD), page(T_BAD))).toBe("absent");
  });
});

describe("build-known-addresses CLI (network-free: fetch stubbed, output redirected)", () => {
  const script = new URL("../scripts/build-known-addresses.mjs", import.meta.url).pathname;
  const stub = new URL("./fixtures/fetch-stub.js", import.meta.url).pathname;
  const sdn = new URL("./fixtures/sdn-mini.xml", import.meta.url).pathname;
  const run = (mode, ...args) => {
    const out = join(mkdtempSync(join(tmpdir(), "chainmap-build-")), "known-addresses.json");
    const env = { ...process.env, KNOWN_ADDRESSES_OUT: out, FETCH_STUB: mode };
    if (!mode) delete env.FETCH_STUB;
    const r = Bun.spawnSync([process.execPath, "--preload", stub, script, ...args], { stdout: "pipe", stderr: "pipe", env });
    return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString(), out, wrote: existsSync(out) || existsSync(`${out}.tmp`) };
  };
  test("unknown argument -> usage on stderr, exit 2", () => {
    const r = run("", "--bogus");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("usage: bun run data:build");
    expect(r.wrote).toBe(false);
  });
  test("a non-SDN --ofac file aborts with exit 1 before any network call and writes nothing", () => {
    const r = run("", "--ofac", new URL("./fixtures/superchain-chainList.json", import.meta.url).pathname);
    expect(r.stderr).toContain("Publish_Date missing");
    expect(r.exitCode).toBe(1);
    expect(r.wrote).toBe(false);
  });
  test("GitHub API non-200 aborts with exit 1 and writes nothing", () => {
    const r = run("github-403", "--ofac", sdn);
    expect(r.stderr).toContain("GitHub API HTTP 403");
    expect(r.exitCode).toBe(1);
    expect(r.wrote).toBe(false);
  });
  test("a registry with 0 bridge rows aborts with exit 1 and writes nothing", () => {
    const r = run("empty-registry", "--ofac", sdn);
    expect(r.stderr).toContain("superchain-registry: 0 bridge rows (format drift?)");
    expect(r.exitCode).toBe(1);
    expect(r.wrote).toBe(false);
  });
  test("--verify-sources: a cited page that cannot be fetched aborts, listing url + row count, and writes nothing", () => {
    const r = run("verify-fail", "--ofac", sdn, "--verify-sources");
    expect(r.stderr).toContain("--verify-sources could not fetch");
    expect(r.stderr).toMatch(/https:\/\/ofac\.treasury\.gov\/recent-actions\/20220808 \(\d+ rows\)/);
    expect(r.exitCode).toBe(1);
    expect(r.wrote).toBe(false);
  });
  test("--verify-sources: rows absent from their page are excluded and listed; the build still writes", () => {
    const r = run("verify-absent", "--ofac", sdn, "--verify-sources");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/excluded by --verify-sources \(\d+\):/);
    expect(r.stdout).toContain("→ absent");
    const data = JSON.parse(readFileSync(r.out, "utf8"));
    expect(Object.keys(data["*"])).toEqual([AA, BB, CC, DD]); // sdn-mini
    expect(Object.keys(data[TRON]).sort()).toEqual([TA, TB, TC, TD]);
    expect(r.stdout).toMatch(/2026-11-13, \d+ EVM addresses, 4 Tron addresses/);
    expect(r.stdout).toContain(`OFAC Tron ids under other tags (2):
  Digital Currency Address - XBT: ${T_CC}
  Digital Currency Address - ETH: TWCL826n2tBuoR7mp6oj5FzgitmfWSwCGZ`);
    const kept = Object.values(data).flatMap((c) => Object.values(c)).filter((e) => e.note === "needs official source");
    expect(kept.length).toBeGreaterThan(0); // unsourced legacy rows survive
    expect(existsSync(`${r.out}.tmp`)).toBe(false); // atomic write cleaned up
  });
});
