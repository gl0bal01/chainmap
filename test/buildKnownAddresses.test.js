import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { parseOfacXml, parseSuperchain, mergeSources, serializeKnownData, verifyEntry } from "../scripts/known-addresses/pipeline.mjs";

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");
const AA = "0x" + "aa".repeat(20), BB = "0x" + "bb".repeat(20), CC = "0x" + "cc".repeat(20), DD = "0x" + "dd".repeat(20);

describe("parseOfacXml", () => {
  test("EVM ids only, lowercased, primary name (LAST, First), entities decoded, first entry wins", () => {
    expect(parseOfacXml(fx("sdn-mini.xml"))).toEqual({
      publishDate: "2026-11-13",
      entries: [
        { address: AA, name: "LAZARUS GROUP" },
        { address: BB, name: "LAZARUS GROUP" },
        { address: CC, name: "SEMENOV, Roman" },
        { address: DD, name: "A & B TRADING" },
      ],
      skippedIds: [],
    });
  });
  test("throws on truncated XML (cut inside an entry)", () => {
    const x = fx("sdn-mini.xml");
    expect(() => parseOfacXml(x.slice(0, x.indexOf("SEMENOV") + 5))).toThrow(/truncated/);
  });
  test("skippedIds: 0x ids under non-allowlisted tags and malformed ids under allowlisted ones", () => {
    const x = fx("sdn-mini.xml").replace("</sdnList>",
      `<sdnEntry><lastName>Z</lastName><sdnType>Entity</sdnType><idList>
      <id><idType>Digital Currency Address - POL</idType><idNumber>0x${"e".repeat(40)}</idNumber></id>
      <id><idType>Digital Currency Address - ETH</idType><idNumber>0xshort</idNumber></id>
      </idList></sdnEntry></sdnList>`);
    const r = parseOfacXml(x);
    expect(r.entries.length).toBe(4);
    expect(r.skippedIds).toEqual([
      { tag: "Digital Currency Address - POL", idNumber: "0x" + "e".repeat(40) },
      { tag: "Digital Currency Address - ETH", idNumber: "0xshort" },
    ]);
  });
  test("throws without Publish_Date (error page) or without any EVM address (format drift)", () => {
    expect(() => parseOfacXml("<html>Service Unavailable</html>")).toThrow();
    expect(() => parseOfacXml("<sdnList><publshInformation><Publish_Date>11/13/2026</Publish_Date></publshInformation></sdnList>")).toThrow();
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
    expect(data["1"][AA]).toEqual({ label: "Ronin Exploiter (OFAC SDN)", category: "sanctioned", source: "https://example.org/x", added: "2026-11-16" });
    expect(data["*"][AA].category).toBe("sanctioned");
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
});
