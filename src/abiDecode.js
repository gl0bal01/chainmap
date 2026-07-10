// =============================================================================
// abiDecode.js — pure, DOM-free minimal ABI head decoder. Decodes the leading
// STATIC arguments of a known contract call from raw calldata so an investigator
// sees e.g. the real recipient of a `transfer(address,uint256)` that is hidden
// inside the calldata (the tx `to` is only the token contract).
//
// Decodes address / bool / uintN / intN / bytesN (32-byte head words). Stops at
// the first dynamic type (bytes, string, T[], tuple) — its head word is an
// offset, not a value — so we never mis-report a dynamic arg.
// =============================================================================

import { SELECTORS } from "./selectors.js";

/** Split a signature's top-level parameter list into types. Bails (returns [])
 *  on nested tuples "(...)" so we never mis-split them. */
function paramTypes(signature) {
  const m = /\(([\s\S]*)\)/.exec(signature || "");
  if (!m || !m[1].trim()) return [];
  if (m[1].includes("(")) return []; // tuple params — don't attempt
  return m[1].split(",").map((s) => s.trim()).filter(Boolean);
}

function isStatic(type) {
  return (
    type === "address" ||
    type === "bool" ||
    /^uint(\d+)?$/.test(type) ||
    /^int(\d+)?$/.test(type) ||
    /^bytes([1-9]|[12]\d|3[0-2])$/.test(type)
  );
}

/**
 * @typedef {{ methodId:string, signature:string|null, args:{type:string, value:string}[] }} DecodedCall
 */

/**
 * Decode leading static args of a call from raw calldata.
 * @param {string} input raw calldata ("0x" + selector + args)
 * @returns {DecodedCall|null} null when there is no calldata
 */
export function decodeCall(input) {
  if (!input || typeof input !== "string" || input.length < 10) return null;
  const methodId = input.slice(0, 10).toLowerCase();
  const signature = SELECTORS[methodId] || null;
  const args = [];
  if (signature) {
    const types = paramTypes(signature);
    let word = 0;
    for (const type of types) {
      if (!isStatic(type)) break; // dynamic/tuple head is an offset, not a value
      const start = 10 + word * 64;
      const hex = input.slice(start, start + 64);
      if (hex.length < 64) break;
      let value;
      if (type === "address") value = "0x" + hex.slice(24);
      else if (type === "bool") value = /[1-9a-f]/i.test(hex) ? "true" : "false";
      else if (/^u?int/.test(type)) {
        try { value = BigInt("0x" + hex).toString(); } catch { value = "0x" + hex; }
      } else value = "0x" + hex;
      args.push({ type, value });
      word += 1;
    }
  }
  return { methodId, signature, args };
}
