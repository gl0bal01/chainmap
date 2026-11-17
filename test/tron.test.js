import { test, expect } from "bun:test";
import { sha256, toTronBase58, parseTronAddress, isTronAddress, tronPath, tronUrl, tronTypes, sampleSize, tronRows } from "../src/tron.js";
import TX from "./fixtures/tron/transactions.json";
import INT from "./fixtures/tron/internal.json";
import T20 from "./fixtures/tron/trc20.json";
import { selectedTypes } from "../src/scanner.js";

const hex = (u8) => Buffer.from(u8).toString("hex");
const VEC = [
  ["41d1c4bb7b2f39aba5707711719b2236b5b605af2e", "TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi"],
  ["41a614f803b6fd780986a42c78ec9c7f77e6ded13c", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"],
  ["416e0617948fe030a7e4970f8389d4ad295f249b7e", "TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax"],
  ["410000000000000000000000000000000000000000", "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb"],
];
test("sha256 vectors", async () => {
  expect(hex(sha256(new Uint8Array()))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expect(hex(sha256(new TextEncoder().encode("abc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  for (const len of [55, 56, 64, 1000]) { // padding edges + multi-block, against Web Crypto
    const b = Uint8Array.from({ length: len }, (_, i) => i & 255);
    expect(hex(sha256(b))).toBe(hex(new Uint8Array(await crypto.subtle.digest("SHA-256", b))));
  }
});
test("base58check vectors both ways", () => {
  for (const [h, t] of VEC) { expect(toTronBase58(h)).toBe(t); expect(parseTronAddress(t)).toBe(h); }
});
test("parse rejects bad input; hex any case -> lowercase", () => {
  const [h, t] = VEC[0];
  expect(parseTronAddress(t.toLowerCase())).toBeNull();
  expect(parseTronAddress(t.slice(0, -1) + (t.at(-1) === "i" ? "j" : "i"))).toBeNull(); // checksum
  expect(parseTronAddress("0x" + h.slice(2))).toBeNull();
  expect(parseTronAddress("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")).toBeNull(); // valid base58check, version 0x00
  expect(parseTronAddress(" " + t)).toBeNull();
  expect(parseTronAddress(h.toUpperCase())).toBe(h);
  expect(isTronAddress(h)).toBe(true);
  expect(isTronAddress(h.toUpperCase())).toBe(false);
  expect(isTronAddress(t)).toBe(false);
});
test("tronUrl: path per action, fixed param order, unknown keys dropped", () => {
  const A = VEC[0][0];
  expect(tronUrl("txlist", { search_internal: "false", only_confirmed: "true", limit: "20", address: A, apikey: "K" }))
    .toBe(`https://api.trongrid.io/v1/accounts/${A}/transactions?limit=20&only_confirmed=true&search_internal=false`);
  expect(tronUrl("txlistinternal", { address: A, limit: "5", only_confirmed: "true" })).toContain("/internal-transactions?limit=5&only_confirmed=true");
  expect(tronUrl("tokentx", { address: A, limit: "5", only_confirmed: "true", max_timestamp: "1794907752000", fingerprint: "abc" }))
    .toBe(`https://api.trongrid.io/v1/accounts/${A}/transactions/trc20?limit=5&only_confirmed=true&max_timestamp=1794907752000&fingerprint=abc`);
  expect(tronPath("tokennfttx")).toBeNull();
});
test("tronTypes and sampleSize", () => {
  const all = selectedTypes({ normal: true, internal: true, token: true });
  const tt = tronTypes(all);
  expect(tt.map((x) => x.action)).toEqual(["txlist", "txlistinternal", "tokentx"]);
  expect(tt[2].labelKey).toBe("tx.type.trc20");
  expect(all[2].labelKey).toBe("tx.type.erc20"); // not mutated
  expect(sampleSize("728126428", 500)).toBe(200);
  expect(sampleSize("728126428", 20)).toBe(20);
  expect(sampleSize("1", 500)).toBe(500);
});

const skipped = (r, cursor) => {
  expect(Object.keys(r).sort()).toEqual(["blockNumber", "cursor", "from", "hash", "timeStamp", "to"]);
  expect(r.from).toBe("");
  expect(r.to).toBe("");
  if (cursor) expect(r.cursor).toBe(cursor);
};

test("txlist rows", () => {
  const rows = tronRows("txlist", TX);
  expect(rows.length).toBe(TX.data.length);
  expect(rows[0]).toEqual({ hash: TX.data[0].txID, blockNumber: "87994205", timeStamp: "1794656502", cursor: "1794656502000", from: "41787d916c8c4fda95428184434152cec57b522df8", to: "416e0617948fe030a7e4970f8389d4ad295f249b7e", value: "8", isError: "0", tokenSymbol: "", tokenDecimal: "6" });
  expect(rows[1]).toMatchObject({ tokenSymbol: "TRC10:1005190", tokenDecimal: "", value: "5870000" });
  expect(rows[2]).toMatchObject({ to: "416e0617948fe030a7e4970f8389d4ad295f249b7e", value: "334255881" });
  expect(rows[3].value).toBe("0");
  expect(rows[4].isError).toBe("1");
  expect(rows[5].isError).toBe("1");
  skipped(rows[6], "1794600000000");
  expect(rows[7].tokenDecimal).toBe("");
  expect(rows[7].value).toBe("9007199254740992");
  expect(rows[8]).toMatchObject({ tokenSymbol: "TRC10:?", tokenDecimal: "", value: "1000" }); // ruling 34: no asset_name
});

test("internal rows", () => {
  const rows = tronRows("txlistinternal", INT);
  expect(rows.length).toBe(INT.data.length);
  expect(rows[0]).toEqual({ hash: "44bfa0d9be7324574add953560d299e6d34fe0ea5a4e4207de9722ddb9ac3987", blockNumber: "", timeStamp: "1794901176", cursor: "1794901176000", from: "416e0617948fe030a7e4970f8389d4ad295f249b7e", to: "41891cdb91d149f23b1a45d9c5ca78a88d0cb44c18", value: "334255881", isError: "0", logIndex: "03e5c7d37e24a915f65e1a6d649936de9f19aed577be8696c54ae85034551807", tokenSymbol: "", tokenDecimal: "6" });
  expect(rows[1].isError).toBe("1");
  expect(rows[2].value).toBe("0");
  expect(rows[3].value).toBe("0");
});

test("trc20 rows", () => {
  const rows = tronRows("tokentx", T20);
  expect(rows.length).toBe(T20.data.length);
  expect(rows[0]).toEqual({ hash: "cbccd13069781c4bb714f81fb91e33caedd694ff0c0865de24a938cd0d22f65e", blockNumber: "", timeStamp: "1794907752", cursor: "1794907752000", from: "41a6b0facf3655f61d7d89db8171de7cf2d65ebc7c", to: "41d1c4bb7b2f39aba5707711719b2236b5b605af2e", value: "5870000", contractAddress: "41a614f803b6fd780986a42c78ec9c7f77e6ded13c", tokenSymbol: "USDT", tokenName: "Tether USD", tokenDecimal: "6", logIndex: "v5870000" });
  skipped(rows[3], "1794907752000");
  expect(rows[4].tokenDecimal).toBe("");
  skipped(rows[5], "1794907752000");
  expect(rows[6].tokenSymbol).toBe("TRC-20");
  expect(rows[7]).toMatchObject({ tokenSymbol: "USDT", tokenDecimal: "" }); // ruling 34: JSON-number value (rounded by JSON.parse)
});

// Ruling 34: only a digit string is a determinate TRC-20 value; anything else is indeterminate.
test("trc20 value: digit string only", () => {
  const row = (value) => tronRows("tokentx", { data: [{ ...T20.data[0], value }] })[0];
  expect(row("5870000").tokenDecimal).toBe("6");
  for (const bad of ["", "0x2a", "1.5", " 5", "-1", "1e3", 5870000, 1.5, null, undefined, true, {}]) {
    expect([bad, row(bad).tokenDecimal]).toEqual([bad, ""]);
  }
  expect(row(undefined).value).toBe("");
});

test("page length invariant", () => {
  expect(tronRows("tokentx", { data: "x" })).toEqual([]);
  const rows = tronRows("txlist", { data: [null, 5] });
  expect(rows.length).toBe(2);
  rows.forEach((r) => skipped(r));
  for (const [a, j] of [["txlist", TX], ["txlistinternal", INT], ["tokentx", T20]])
    for (const r of tronRows(a, j)) {
      expect(typeof r.cursor).toBe("string");
      expect("input" in r).toBe(false);
    }
});
