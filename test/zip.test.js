import { describe, test, expect } from "bun:test";
import { crc32, createZip } from "../src/zip.js";
import { readZip } from "./fixtures/readZip.js";

const enc = (s) => new TextEncoder().encode(s);
const D = new Date("2026-11-16T10:15:30Z");

describe("zip", () => {
  test("crc32 known vectors", () => {
    expect(crc32(enc("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });
  test("round-trip", () => {
    const files = [{ name: "a.txt", bytes: enc("hello") }, { name: "b.bin", bytes: Uint8Array.of(0, 255, 1) }];
    const r = readZip(createZip(files, D));
    expect(r.map((f) => f.name)).toEqual(["a.txt", "b.bin"]);
    r.forEach((f, i) => {
      expect(Array.from(f.bytes)).toEqual(Array.from(files[i].bytes));
      expect(f.method).toBe(0);
      expect(f.crc).toBe(crc32(files[i].bytes));
    });
  });
  test("UTF-8 names", () => {
    const [f] = readZip(createZip([{ name: "café/é.txt", bytes: enc("x") }], D));
    expect(f.name).toBe("café/é.txt");
    expect(f.flags & 0x0800).toBe(0x0800);
  });
  test("empty file", () => {
    const [f] = readZip(createZip([{ name: "e", bytes: new Uint8Array() }], D));
    expect(f.bytes.length).toBe(0);
    expect(f.crc).toBe(0);
  });
  test("DOS time", () => {
    const [f] = readZip(createZip([{ name: "t", bytes: new Uint8Array() }], D));
    expect(f.time).toBe((10 << 11) | (15 << 5) | 15);
    expect(f.date).toBe((46 << 9) | (11 << 5) | 16);
  });
  test("guards", () => {
    const many = Array.from({ length: 65536 }, () => ({ name: "x", bytes: new Uint8Array() }));
    expect(() => createZip(many, D)).toThrow(RangeError);
    expect(() => createZip([{ name: "big", bytes: { length: 2 ** 32 } }], D)).toThrow(RangeError);
  });
});
