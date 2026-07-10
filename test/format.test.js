import { describe, expect, test } from "bun:test";
import {
  csvEscape,
  edgeDedupKey,
  escapeHtml,
  formatTimestamp,
  formatUnits,
  isFailedTx,
  isValidAddress,
  lc,
  shortAddress,
  trimZero,
} from "../src/format.js";

describe("lc", () => {
  test("lowercases a string", () => {
    expect(lc("0xABC123")).toBe("0xabc123");
  });
  test("null/undefined -> \"\"", () => {
    expect(lc(null)).toBe("");
    expect(lc(undefined)).toBe("");
  });
});

describe("isValidAddress", () => {
  test("valid address", () => {
    expect(isValidAddress("0x" + "a1".repeat(20))).toBe(true);
  });
  test("wrong length", () => {
    expect(isValidAddress("0x" + "a1".repeat(19))).toBe(false);
    expect(isValidAddress("0x" + "a1".repeat(21))).toBe(false);
  });
  test("non-hex chars", () => {
    expect(isValidAddress("0x" + "g".repeat(40))).toBe(false);
  });
  test("missing 0x prefix", () => {
    expect(isValidAddress("a1".repeat(20))).toBe(false);
  });
});

describe("formatUnits", () => {
  test("normal case (18 decimals)", () => {
    const r = formatUnits("1500000000000000000", 18);
    expect(r).toEqual({ text: "1.500000", indeterminate: false });
  });

  test("negative value", () => {
    const r = formatUnits("-1500000000000000000", 18);
    expect(r).toEqual({ text: "-1.500000", indeterminate: false });
  });

  test("huge value", () => {
    const raw = "123456789012345678901234567890123456789";
    const decimals = 18;
    const v = BigInt(raw);
    const base = 10n ** BigInt(decimals);
    const whole = v / base;
    const frac = v % base;
    const expectedFrac = frac.toString().padStart(decimals, "0").slice(0, 6);
    const r = formatUnits(raw, decimals);
    expect(r).toEqual({ text: `${whole.toString()}.${expectedFrac}`, indeterminate: false });
  });

  test("decimals = 0", () => {
    const r = formatUnits("12345", 0);
    expect(r).toEqual({ text: "12345.0", indeterminate: false });
  });

  test("decimals empty string -> indeterminate with raw text", () => {
    const r = formatUnits("12345", "");
    expect(r).toEqual({ text: "12345", indeterminate: true });
  });

  test("decimals NaN -> indeterminate with raw text", () => {
    const r = formatUnits("12345", "abc");
    expect(r).toEqual({ text: "12345", indeterminate: true });
  });

  test("decimals negative -> indeterminate with raw text", () => {
    const r = formatUnits("12345", -1);
    expect(r).toEqual({ text: "12345", indeterminate: true });
  });

  test("decimals undefined defaults to 18 (not indeterminate)", () => {
    const r = formatUnits("1000000000000000000");
    expect(r).toEqual({ text: "1.000000", indeterminate: false });
  });

  test("unparseable rawValue -> indeterminate with raw text as given", () => {
    const r = formatUnits("not-a-number", 18);
    expect(r).toEqual({ text: "not-a-number", indeterminate: true });
  });

  test("unparseable rawValue (decimal string) -> indeterminate", () => {
    const r = formatUnits("12.34", 18);
    expect(r).toEqual({ text: "12.34", indeterminate: true });
  });

  test("never returns a silent \"0\" for bad input", () => {
    const r = formatUnits("garbage", 18);
    expect(r.text).not.toBe("0");
    expect(r.indeterminate).toBe(true);
  });
});

describe("trimZero", () => {
  test("trims trailing fractional zeros", () => {
    expect(trimZero("1.2300")).toBe("1.23");
  });
  test("trims fully to whole number", () => {
    expect(trimZero("5.000")).toBe("5");
  });
  test("no-op when no trailing zeros", () => {
    expect(trimZero("1.23")).toBe("1.23");
  });
});

describe("shortAddress", () => {
  test("first 5 + … + last 4", () => {
    const addr = "0x" + "a1".repeat(20);
    expect(shortAddress(addr)).toBe(addr.slice(0, 5) + "…" + addr.slice(-4));
  });
});

describe("escapeHtml", () => {
  test("escapes <, >, &, \", '", () => {
    expect(escapeHtml(`<div class="a" data-x='y'>&fish</div>`)).toBe(
      "&lt;div class=&quot;a&quot; data-x=&#39;y&#39;&gt;&amp;fish&lt;/div&gt;"
    );
  });
  test("null/undefined -> \"\"", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });
});

describe("csvEscape", () => {
  test("comma triggers quoting", () => {
    expect(csvEscape("a,b")).toBe('"a,b"');
  });
  test("quote triggers quoting + doubling", () => {
    expect(csvEscape('he said "hi"')).toBe('"he said ""hi"""');
  });
  test("newline triggers quoting", () => {
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
  });
  test("plain value unquoted", () => {
    expect(csvEscape("plain")).toBe("plain");
  });
  test("null/undefined -> \"\"", () => {
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(undefined)).toBe("");
  });

  // CSV formula injection (CWE-1236): leading trigger chars get a ' prefix so
  // a spreadsheet treats an attacker-controlled token symbol as inert text.
  test("neutralizes leading = + - @ tab CR", () => {
    expect(csvEscape("=CMD|' /C calc'!A0")).toBe("'=CMD|' /C calc'!A0");
    expect(csvEscape("=1+1")).toBe("'=1+1");
    expect(csvEscape("+cmd")).toBe("'+cmd");
    expect(csvEscape("-2")).toBe("'-2");
    expect(csvEscape("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvEscape("\tcmd")).toBe("'\tcmd");
  });
  test("prefix composes with quoting when the cell also needs quotes", () => {
    // starts with '=' AND contains a comma -> prefix first, then RFC-4180 quote
    expect(csvEscape("=HYPERLINK(1,2)")).toBe('"\'=HYPERLINK(1,2)"');
  });
  test("does not prefix an interior trigger char", () => {
    expect(csvEscape("a=b")).toBe("a=b");
    expect(csvEscape("USDC")).toBe("USDC");
  });
});

describe("edgeDedupKey", () => {
  test("two ERC-1155 transfers, same hash, different tokenID -> different keys", () => {
    const base = {
      hash: "0xhash1",
      from: "0xFROM0000000000000000000000000000000001",
      to: "0xTO000000000000000000000000000000000001",
      contractAddress: "0xCONTRACT000000000000000000000000000001",
      logIndex: "0",
    };
    const key1 = edgeDedupKey("token1155tx", { ...base, tokenID: "1" });
    const key2 = edgeDedupKey("token1155tx", { ...base, tokenID: "2" });
    expect(key1).not.toBe(key2);
  });

  test("same symbol, different contract -> different keys", () => {
    const tx1 = {
      hash: "0xhash2",
      from: "0xFROM0000000000000000000000000000000001",
      to: "0xTO000000000000000000000000000000000001",
      contractAddress: "0xAAAA000000000000000000000000000000001",
      tokenSymbol: "USDT",
    };
    const tx2 = { ...tx1, contractAddress: "0xBBBB000000000000000000000000000000002" };
    expect(edgeDedupKey("tokentx", tx1)).not.toBe(edgeDedupKey("tokentx", tx2));
  });

  test("lowercases address-like parts", () => {
    const tx = {
      hash: "0xhash3",
      from: "0xABCDEF0000000000000000000000000000ABCD",
      to: "0x1234560000000000000000000000000000EF00",
      contractAddress: "0xFEDCBA0000000000000000000000000000FEED",
    };
    const key = edgeDedupKey("txlist", tx);
    expect(key).toBe(
      `txlist|0xhash3|${tx.from.toLowerCase()}|${tx.to.toLowerCase()}|${tx.contractAddress.toLowerCase()}||`
    );
  });

  test("missing parts default to empty string", () => {
    const key = edgeDedupKey("txlist", { hash: "0xhash4", from: "0xa", to: "0xb" });
    expect(key).toBe("txlist|0xhash4|0xa|0xb|||");
  });

  test("symbol alone is not a discriminator (identical key when only symbol differs)", () => {
    const tx1 = { hash: "0xhash5", from: "0xa", to: "0xb", tokenSymbol: "USDT" };
    const tx2 = { hash: "0xhash5", from: "0xa", to: "0xb", tokenSymbol: "USDC" };
    expect(edgeDedupKey("tokentx", tx1)).toBe(edgeDedupKey("tokentx", tx2));
  });
});

describe("isFailedTx", () => {
  test("isError === \"1\" -> true", () => {
    expect(isFailedTx({ isError: "1" })).toBe(true);
  });
  test("txreceipt_status === \"0\" -> true", () => {
    expect(isFailedTx({ txreceipt_status: "0" })).toBe(true);
  });
  test("isError === \"0\" and receipt ok -> false", () => {
    expect(isFailedTx({ isError: "0", txreceipt_status: "1" })).toBe(false);
  });
  test("fields absent -> not failed", () => {
    expect(isFailedTx({})).toBe(false);
  });
  test("null/undefined tx -> false", () => {
    expect(isFailedTx(null)).toBe(false);
    expect(isFailedTx(undefined)).toBe(false);
  });
});

describe("formatTimestamp", () => {
  test("formats a unix-seconds string", () => {
    const result = formatTimestamp("0", "en-US");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
  test("formats a numeric input", () => {
    const result = formatTimestamp(1700000000, "en-US");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
  test("absent -> \"\"", () => {
    expect(formatTimestamp(undefined)).toBe("");
    expect(formatTimestamp(null)).toBe("");
    expect(formatTimestamp("")).toBe("");
  });
});
