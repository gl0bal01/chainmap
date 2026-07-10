import { test, expect } from "bun:test";
import { detectAddress } from "../src/blockchainDetect.js";

test("EVM address -> isEvm, primary EVM", () => {
  const r = detectAddress("0x742d35Cc6634C0532925a3b8D3Ac0C4ad5d0B78a");
  expect(r.isEvm).toBe(true);
  expect(r.primary.name).toBe("EVM-compatible");
});

test("Bitcoin bech32 + legacy -> not EVM, Bitcoin match", () => {
  const bech = detectAddress("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq");
  expect(bech.isEvm).toBe(false);
  expect(bech.matches.some((m) => m.symbol === "BTC")).toBe(true);
  const legacy = detectAddress("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa");
  expect(legacy.matches.some((m) => m.symbol === "BTC")).toBe(true);
  expect(legacy.isEvm).toBe(false);
});

test("Tron and Ripple detected, not EVM", () => {
  expect(detectAddress("TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE").matches.some((m) => m.symbol === "TRX")).toBe(true);
  expect(detectAddress("rGWrZyQqhTp9Xu7G5Pkayo7bXjH4k4QYpf").matches.some((m) => m.symbol === "XRP")).toBe(true);
});

test("empty / junk -> no matches", () => {
  expect(detectAddress("").matches).toEqual([]);
  expect(detectAddress("   ").primary).toBeNull();
  expect(detectAddress("hello world !!").matches).toEqual([]);
});
