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

import { SELECTORS, paramNames } from "./selectors.js";

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
 * @typedef {{ methodId:string, signature:string|null, args:{type:string, value:string, name?:string}[] }} DecodedCall
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
    const names = paramNames(methodId) || [];
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
      const name = names[word];
      args.push(name ? { type, value, name } : { type, value });
      word += 1;
    }
  }
  return { methodId, signature, args };
}

/**
 * Structurally decode raw calldata into its 4-byte selector + 32-byte (256-bit) words.
 * Unlike decodeCall (which stops at the first dynamic ABI type), this ALWAYS decodes
 * the full calldata layout — so an investigator sees every word even for unknown or
 * dynamic-arg calls. Each word carries best-effort interpretations (uint, address).
 * @param {string} input raw calldata ("0x" + selector + args)
 * @returns {{ selector:string, words:{index:number, hex:string, uint:string|null, address:string|null}[] }|null}
 *   null when there is no calldata.
 */
export function decodeCalldataWords(input) {
  if (!input || typeof input !== "string" || input.length < 10) return null;
  const selector = input.slice(0, 10).toLowerCase();
  const body = input.slice(10);
  const words = [];
  for (let i = 0; i * 64 < body.length; i++) {
    const chunk = body.slice(i * 64, i * 64 + 64);
    const hex = "0x" + chunk;
    let uint = null;
    try { uint = BigInt("0x" + chunk).toString(); } catch { uint = null; }
    // A word is a left-padded address iff the top 12 bytes (24 hex) are zero and the
    // rest is 40 hex chars (i.e. a full 32-byte word holding a 20-byte address).
    const address = /^0{24}[0-9a-fA-F]{40}$/.test(chunk) ? "0x" + chunk.slice(24).toLowerCase() : null;
    words.push({ index: i, hex, uint, address });
  }
  return { selector, words };
}

/** Find a decoded arg by its role name. */
function argByName(args, name) {
  const a = (args || []).find((x) => x && x.name === name);
  return a ? a.value : null;
}

/**
 * Plain-language summary of a decoded call as an i18n message. Returns raw param
 * values (addresses / raw integers) — the RENDER layer resolves aliases + formats
 * amounts with token decimals + escapes. Null when there is nothing worth summarizing.
 * @param {{methodId:string, args:{type:string,value:string,name?:string}[]}|null} call
 * @returns {{key:string, params:object}|null}
 */
export function summarizeCall(call) {
  if (!call || !call.methodId) return null;
  const id = String(call.methodId).toLowerCase();
  const args = call.args || [];
  switch (id) {
    case "0xa9059cbb": // transfer(recipient, amount)
    case "0x40c10f19": // mint(recipient, amount)
      return { key: "summary.transfer", params: { amount: argByName(args, "amount"), recipient: argByName(args, "recipient") } };
    case "0x23b872dd": // transferFrom(from, recipient, amount)
    case "0x42842e0e": // safeTransferFrom(from, recipient, tokenId)
      return { key: "summary.transferFrom", params: { from: argByName(args, "from"), recipient: argByName(args, "recipient") } };
    case "0x095ea7b3": // approve(spender, amount)
      return { key: "summary.approve", params: { amount: argByName(args, "amount"), spender: argByName(args, "spender") } };
    case "0xa22cb465": { // setApprovalForAll(operator, approved)
      const approved = argByName(args, "approved");
      return { key: approved === "true" ? "summary.approveAll" : "summary.revokeAll", params: { operator: argByName(args, "operator") } };
    }
    case "0x2e1a7d4d": // withdraw(amount)
      return { key: "summary.withdraw", params: { amount: argByName(args, "amount") } };
    case "0xb214faa5": // Tornado deposit(bytes32)
      return { key: "summary.mixerDeposit", params: {} };
    default:
      return null;
  }
}
