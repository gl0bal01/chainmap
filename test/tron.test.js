import { test, expect } from "bun:test";
import { sha256, toTronBase58, parseTronAddress, isTronAddress, tronPath, tronUrl, tronTypes, sampleSize } from "../src/tron.js";
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
