import { beforeAll, describe, expect, test } from "bun:test";

// Static hardening regressions for index.html. These guard the CSP / SRI /
// referrer decisions made after the 2026-07 security review so a future edit
// can't silently drop them.

let html;
beforeAll(async () => {
  html = await Bun.file(new URL("../index.html", import.meta.url)).text();
});

describe("Subresource Integrity (CWE-353)", () => {
  test("every vendored <script src> carries an integrity hash", () => {
    const tags = html.match(/<script\b[^>]*\bsrc="vendor\/[^"]+"[^>]*>/g) || [];
    expect(tags.length).toBeGreaterThanOrEqual(2);
    for (const tag of tags) {
      expect(tag).toMatch(/integrity="sha(256|384|512)-[A-Za-z0-9+/=]+"/);
    }
  });
});

describe("Content-Security-Policy", () => {
  test("declares frame-ancestors 'none' (clickjacking, CWE-1021)", () => {
    expect(html).toMatch(/frame-ancestors\s+'none'/);
  });
  test("keeps script-src locked to 'self'", () => {
    expect(html).toMatch(/script-src\s+'self'/);
  });
});

describe("Referrer policy", () => {
  test("sets a no-referrer meta so outbound clicks don't leak the origin", () => {
    expect(html).toMatch(/<meta\s+name="referrer"\s+content="no-referrer">/);
  });
});

describe("i18n innerHTML foot-gun (CWE-79)", () => {
  test("markup uses no data-i18n-html attribute", () => {
    expect(html).not.toMatch(/data-i18n-html/);
  });
});
