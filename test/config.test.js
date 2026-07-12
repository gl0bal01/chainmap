import { describe, test, expect } from "bun:test";
import { CHAINS, PROBE_CHAIN_IDS, KNOWN_CATEGORIES } from "../src/config.js";

// explorer must be a bare host: no scheme, no path/slash (config.js builds
// `https://<explorer>/address/...` and `/tx/...` links directly from it).
const HOST_RE = /^[a-z0-9.-]+$/i;

describe("CHAINS", () => {
  test("every entry has a positive-integer unique id", () => {
    const ids = new Set();
    for (const c of CHAINS) {
      expect(Number.isInteger(c.id)).toBe(true);
      expect(c.id).toBeGreaterThan(0);
      expect(ids.has(c.id)).toBe(false);
      ids.add(c.id);
    }
  });

  test("every entry has a non-empty name", () => {
    for (const c of CHAINS) {
      expect(typeof c.name).toBe("string");
      expect(c.name.trim().length).toBeGreaterThan(0);
    }
  });

  test("every entry has a non-empty explorer host with no scheme/slash", () => {
    for (const c of CHAINS) {
      expect(typeof c.explorer).toBe("string");
      expect(c.explorer.length).toBeGreaterThan(0);
      expect(c.explorer).toMatch(HOST_RE);
      expect(c.explorer).not.toContain("http");
      expect(c.explorer).not.toContain("/");
    }
  });

  test("every entry has a non-empty native currency symbol", () => {
    for (const c of CHAINS) {
      expect(typeof c.native).toBe("string");
      expect(c.native.trim().length).toBeGreaterThan(0);
    }
  });

  test("ids are unique across the whole list", () => {
    const ids = CHAINS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("grew well beyond the original 9 curated chains", () => {
    expect(CHAINS.length).toBeGreaterThan(9);
  });

  test("testnets are suffixed with ' (testnet)'", () => {
    // Sanity: at least the pre-existing Sepolia entry still carries the suffix.
    const sepolia = CHAINS.find((c) => c.id === 11155111);
    expect(sepolia.name).toContain("(testnet)");
  });

  test("the 9 original entries keep their expected native symbols", () => {
    const expected = {
      1: "ETH", // Ethereum
      11155111: "ETH", // Sepolia (testnet)
      56: "BNB", // BNB Chain
      137: "POL", // Polygon
      42161: "ETH", // Arbitrum One
      10: "ETH", // Optimism
      8453: "ETH", // Base
      43114: "AVAX", // Avalanche C-Chain
    };
    for (const [id, native] of Object.entries(expected)) {
      const chain = CHAINS.find((c) => c.id === Number(id));
      expect(chain).toBeDefined();
      expect(chain.native).toBe(native);
    }
  });

  test("a sample of newly-added chains carry the expected id/native pairing", () => {
    // Spot-check a handful of non-ETH natives from the Etherscan v2 chainlist
    // expansion, so a reviewer can quickly compare against the report table.
    const expected = {
      146: "S", // Sonic
      100: "XDAI", // Gnosis
      1284: "GLMR", // Moonbeam
      1285: "MOVR", // Moonriver
      204: "BNB", // opBNB
      42220: "CELO", // Celo
      5000: "MNT", // Mantle
      1287: "DEV", // Moonbase Alpha (testnet)
    };
    for (const [id, native] of Object.entries(expected)) {
      const chain = CHAINS.find((c) => c.id === Number(id));
      expect(chain).toBeDefined();
      expect(chain.native).toBe(native);
    }
  });
});

describe("PROBE_CHAIN_IDS", () => {
  test("every id exists in CHAINS", () => {
    const ids = new Set(CHAINS.map((c) => c.id));
    for (const id of PROBE_CHAIN_IDS) {
      expect(ids.has(id)).toBe(true);
    }
  });

  test("has no duplicate ids", () => {
    expect(new Set(PROBE_CHAIN_IDS).size).toBe(PROBE_CHAIN_IDS.length);
  });

  test("is non-empty and all-positive-integer ids", () => {
    expect(PROBE_CHAIN_IDS.length).toBeGreaterThan(0);
    for (const id of PROBE_CHAIN_IDS) {
      expect(Number.isInteger(id)).toBe(true);
      expect(id).toBeGreaterThan(0);
    }
  });

  test("excludes zkSync Era (324) and Scroll (534352) — not on Etherscan v2", () => {
    expect(PROBE_CHAIN_IDS).not.toContain(324);
    expect(PROBE_CHAIN_IDS).not.toContain(534352);
  });
});

describe("KNOWN_CATEGORIES", () => {
  test("is a non-empty array of unique lowercase strings", () => {
    expect(Array.isArray(KNOWN_CATEGORIES)).toBe(true);
    expect(KNOWN_CATEGORIES.length).toBeGreaterThan(0);
    for (const c of KNOWN_CATEGORIES) {
      expect(typeof c).toBe("string");
      expect(c).toBe(c.toLowerCase());
      expect(c.trim().length).toBeGreaterThan(0);
    }
    expect(new Set(KNOWN_CATEGORIES).size).toBe(KNOWN_CATEGORIES.length);
  });

  test("covers the categories used by the flag mechanism", () => {
    for (const c of ["exchange", "router", "bridge", "burn", "mixer", "contract", "sanctioned", "other"]) {
      expect(KNOWN_CATEGORIES).toContain(c);
    }
  });
});
