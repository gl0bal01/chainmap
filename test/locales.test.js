import { describe, it, expect } from "bun:test";
import { createI18n } from "../src/i18n.js";
import en from "../src/locales/en.js";
import fr from "../src/locales/fr.js";

describe("Locale parity (en.js ↔ fr.js)", () => {
  it("should have identical key sets", () => {
    const enKeys = Object.keys(en).sort();
    const frKeys = Object.keys(fr).sort();

    const enSet = new Set(enKeys);
    const frSet = new Set(frKeys);

    const missingInFr = enKeys.filter((k) => !frSet.has(k));
    const missingInEn = frKeys.filter((k) => !enSet.has(k));

    const gaps = [];
    if (missingInFr.length > 0) {
      gaps.push(`Missing in fr.js: ${missingInFr.join(", ")}`);
    }
    if (missingInEn.length > 0) {
      gaps.push(`Missing in en.js: ${missingInEn.join(", ")}`);
    }

    expect(gaps, gaps.join("\n")).toEqual([]);
  });

  it("should have the same key count", () => {
    const enCount = Object.keys(en).length;
    const frCount = Object.keys(fr).length;
    expect(frCount).toBe(enCount);
  });

  it("should have non-empty string values in both locales", () => {
    const enErrors = [];
    const frErrors = [];

    Object.entries(en).forEach(([key, value]) => {
      if (typeof value !== "string" || value.trim() === "") {
        enErrors.push(`en.js[${key}]: ${typeof value} / empty=${value.trim() === ""}`);
      }
    });

    Object.entries(fr).forEach(([key, value]) => {
      if (typeof value !== "string" || value.trim() === "") {
        frErrors.push(`fr.js[${key}]: ${typeof value} / empty=${value.trim() === ""}`);
      }
    });

    const allErrors = [...enErrors, ...frErrors];
    expect(allErrors, allErrors.join("\n")).toEqual([]);
  });

  it("should have matching placeholders across locales", () => {
    /**
     * Extract {name} placeholders from a string.
     * @param {string} text
     * @returns {Set<string>}
     */
    function extractPlaceholders(text) {
      const matches = text.match(/\{(\w+)\}/g) || [];
      return new Set(matches.map((m) => m.slice(1, -1)));
    }

    const placeholderMismatches = [];

    Object.keys(en).forEach((key) => {
      const enValue = en[key];
      const frValue = fr[key];

      const enPlaceholders = extractPlaceholders(enValue);
      const frPlaceholders = extractPlaceholders(frValue);

      // Compare sets
      const enStr = Array.from(enPlaceholders).sort().join(",");
      const frStr = Array.from(frPlaceholders).sort().join(",");

      if (enStr !== frStr) {
        placeholderMismatches.push(
          `${key}: en has {${enStr || "none"}} but fr has {${frStr || "none"}}`
        );
      }
    });

    expect(placeholderMismatches, placeholderMismatches.join("\n")).toEqual([]);
  });

  it("should work correctly with createI18n (sanity check)", () => {
    const i18n = createI18n({
      dictionaries: { en, fr },
      locale: "en",
    });

    // Check that t() works and returns a value
    const enBtnStart = i18n.t("btn.start");
    expect(enBtnStart).toBeTruthy();
    expect(typeof enBtnStart).toBe("string");

    // Check that switching locale works
    i18n.setLocale("fr");
    const frBtnStart = i18n.t("btn.start");
    expect(frBtnStart).toBeTruthy();
    expect(typeof frBtnStart).toBe("string");

    // Check that values differ between locales
    expect(frBtnStart).not.toBe(enBtnStart);
  });

  it("should interpolate placeholders correctly across locales", () => {
    const i18n = createI18n({
      dictionaries: { en, fr },
      locale: "en",
    });

    // Test a key with placeholders
    const enResult = i18n.t("details.viewOn", { explorer: "Etherscan" });
    expect(enResult).toContain("Etherscan");
    expect(enResult).not.toContain("{explorer}");

    i18n.setLocale("fr");
    const frResult = i18n.t("details.viewOn", { explorer: "Etherscan" });
    expect(frResult).toContain("Etherscan");
    expect(frResult).not.toContain("{explorer}");

    // Both should have successfully interpolated the same param
    expect(enResult).not.toBe(frResult);
  });
});
