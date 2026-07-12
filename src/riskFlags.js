// =============================================================================
// riskFlags.js — pure, DOM-free per-edge risk flagging. Turns a decoded edge +
// a known-category lookup into a small set of explainable flag keys the render
// layer escalates on the graph and the details panel explains. No vis, no DOM.
//
// Flags (i18n keys): flag.approvalUnlimited, flag.hiddenRecipient, flag.mixer,
// flag.bridge, flag.sanctioned. Each is a signal, NOT a verdict.
// =============================================================================

import { isValidAddress } from "./format.js";

/** 2^256 - 1, the canonical "unlimited" ERC-20 allowance. */
export const MAX_UINT256 = (2n ** 256n - 1n).toString();

/** Treat an allowance >= 2^255 as "unlimited" (covers MAX_UINT and near-max). */
const UNLIMITED_THRESHOLD = 2n ** 255n;

function argByName(args, name) {
  const a = (args || []).find((x) => x && x.name === name);
  return a ? a.value : null;
}

/**
 * The real recipient of an edge: the decoded `recipient` arg (lowercased) when
 * present and a valid address, else the tx `to`.
 * @param {import('./graphStore.js').EdgeRecord} edge
 * @returns {string}
 */
export function resolvedRecipient(edge) {
  const decoded = argByName(edge && edge.methodArgs, "recipient");
  if (decoded && isValidAddress(decoded)) return decoded.toLowerCase();
  return String((edge && edge.to) || "").toLowerCase();
}

function isUnlimited(rawAmount) {
  if (rawAmount == null) return false;
  try { return BigInt(rawAmount) >= UNLIMITED_THRESHOLD; } catch { return false; }
}

/**
 * Compute risk-flag keys for an edge.
 * @param {import('./graphStore.js').EdgeRecord} edge
 * @param {{ category:(addr:string)=>(string|null) }} ctx  known-category lookup
 * @returns {string[]} de-duplicated flag keys
 */
export function flagsForEdge(edge, ctx) {
  if (!edge) return [];
  const flags = new Set();
  const id = String(edge.methodId || "").toLowerCase();
  const args = edge.methodArgs || [];
  const category = (ctx && ctx.category) || (() => null);

  // Unlimited / blanket approvals.
  if (id === "0x095ea7b3" || id === "0x39509351") { // approve / increaseAllowance
    if (isUnlimited(argByName(args, "amount") ?? argByName(args, "addedValue"))) {
      flags.add("flag.approvalUnlimited");
    }
  }
  if (id === "0xa22cb465" && argByName(args, "approved") === "true") { // setApprovalForAll(_, true)
    flags.add("flag.approvalUnlimited");
  }

  // Hidden recipient: the real recipient in calldata != the tx target.
  const to = String(edge.to || "").toLowerCase();
  const decodedRecipient = argByName(args, "recipient");
  if (decodedRecipient && isValidAddress(decodedRecipient) && decodedRecipient.toLowerCase() !== to) {
    flags.add("flag.hiddenRecipient");
  }

  // Mixer / bridge / sanctioned by resolved recipient's known category.
  const cat = category(resolvedRecipient(edge));
  if (cat === "mixer") flags.add("flag.mixer");
  else if (cat === "bridge") flags.add("flag.bridge");
  else if (cat === "sanctioned") flags.add("flag.sanctioned");

  // Tornado deposit selector always reads as a mixer interaction.
  if (id === "0xb214faa5") flags.add("flag.mixer");

  return [...flags];
}
