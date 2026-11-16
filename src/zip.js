// =============================================================================
// zip.js — store-only (method 0) zip writer. DOM-free. UTF-8 names, no zip64,
// no extra fields. Sizes/offsets are guarded BEFORE any bytes are read.
// =============================================================================

const TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  TABLE[n] = c >>> 0;
}

/** @param {Uint8Array} bytes @returns {number} unsigned CRC-32 */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosStamp(d) {
  if (d.getUTCFullYear() < 1980) return [0, (0 << 9) | (1 << 5) | 1];
  return [
    (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  ];
}

/** @param {{name:string,bytes:Uint8Array}[]} files @param {Date} date @returns {Uint8Array} */
export function createZip(files, date) {
  if (files.length > 0xffff) throw new RangeError("zip: too many files");
  const names = files.map((f) => new TextEncoder().encode(f.name));
  let offset = 0, cdSize = 0;
  files.forEach((f, i) => {
    if (f.bytes.length > 0xfffffffe) throw new RangeError("zip: file too large");
    offset += 30 + names[i].length + f.bytes.length;
    cdSize += 46 + names[i].length;
  });
  if (offset > 0xffffffff || cdSize > 0xffffffff || offset + cdSize + 22 > 0xffffffff) throw new RangeError("zip: archive too large");

  const out = new Uint8Array(offset + cdSize + 22);
  const dv = new DataView(out.buffer);
  const [time, day] = dosStamp(date);
  let p = 0, cp = offset;
  files.forEach((f, i) => {
    const nl = names[i].length, size = f.bytes.length, crc = crc32(f.bytes), at = p;
    dv.setUint32(p, 0x04034b50, true); dv.setUint16(p + 4, 20, true); dv.setUint16(p + 6, 0x0800, true);
    dv.setUint16(p + 8, 0, true); dv.setUint16(p + 10, time, true); dv.setUint16(p + 12, day, true);
    dv.setUint32(p + 14, crc, true); dv.setUint32(p + 18, size, true); dv.setUint32(p + 22, size, true);
    dv.setUint16(p + 26, nl, true); dv.setUint16(p + 28, 0, true);
    out.set(names[i], p + 30); out.set(f.bytes, p + 30 + nl);
    p += 30 + nl + size;

    dv.setUint32(cp, 0x02014b50, true); dv.setUint16(cp + 4, 20, true); dv.setUint16(cp + 6, 20, true);
    dv.setUint16(cp + 8, 0x0800, true); dv.setUint16(cp + 10, 0, true); dv.setUint16(cp + 12, time, true);
    dv.setUint16(cp + 14, day, true); dv.setUint32(cp + 16, crc, true); dv.setUint32(cp + 20, size, true);
    dv.setUint32(cp + 24, size, true); dv.setUint16(cp + 28, nl, true); // extra/comment/disk/attrs stay 0
    dv.setUint32(cp + 42, at, true);
    out.set(names[i], cp + 46);
    cp += 46 + nl;
  });
  dv.setUint32(cp, 0x06054b50, true);
  dv.setUint16(cp + 8, files.length, true); dv.setUint16(cp + 10, files.length, true);
  dv.setUint32(cp + 12, cdSize, true); dv.setUint32(cp + 16, offset, true);
  return out;
}
