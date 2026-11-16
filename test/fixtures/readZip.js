// Minimal store-only zip reader for tests. Asserts local header == central entry.
export function readZip(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const eocd = u8.length - 22;
  if (dv.getUint32(eocd, true) !== 0x06054b50) throw new Error("no EOCD");
  const count = dv.getUint16(eocd + 8, true);
  if (dv.getUint16(eocd + 10, true) !== count) throw new Error("EOCD count mismatch");
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (cdOffset + cdSize + 22 !== u8.length) throw new Error("bad cd bounds");
  const dec = new TextDecoder();
  const out = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("bad central sig");
    const c = {
      flags: dv.getUint16(p + 8, true), method: dv.getUint16(p + 10, true),
      time: dv.getUint16(p + 12, true), date: dv.getUint16(p + 14, true),
      crc: dv.getUint32(p + 16, true), size: dv.getUint32(p + 20, true),
    };
    const nameLen = dv.getUint16(p + 28, true);
    const off = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    if (dv.getUint32(off, true) !== 0x04034b50) throw new Error("bad local sig");
    const l = {
      flags: dv.getUint16(off + 6, true), method: dv.getUint16(off + 8, true),
      time: dv.getUint16(off + 10, true), date: dv.getUint16(off + 12, true),
      crc: dv.getUint32(off + 14, true), size: dv.getUint32(off + 18, true),
    };
    for (const k of Object.keys(c)) if (c[k] !== l[k]) throw new Error(`local/central mismatch: ${k}`);
    if (dv.getUint32(off + 22, true) !== c.size) throw new Error("uncompressed size mismatch");
    const lnLen = dv.getUint16(off + 26, true);
    if (lnLen !== nameLen || dv.getUint16(off + 28, true) !== 0) throw new Error("local name/extra mismatch");
    const start = off + 30 + lnLen;
    out.push({ name, bytes: u8.slice(start, start + c.size), flags: c.flags, method: c.method, crc: c.crc, time: c.time, date: c.date });
    p += 46 + nameLen;
  }
  return out;
}
