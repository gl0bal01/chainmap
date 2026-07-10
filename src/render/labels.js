// =============================================================================
// render/labels.js — derive vis-network visuals from store records. Nearly pure
// (no vis, no DOM): given a record + display settings, return label/color specs.
//
// STAGE A: interface frozen. STAGE B: implement + unit tests.
// Identity vs display: node id is ALWAYS the raw lowercased address; labels are
// derived here and never change ids.
// =============================================================================

import { ROOT_COLOR } from "../config.js";
import { shortAddress } from "../format.js";

/**
 * Discovered-node color from BFS depth (root uses config.ROOT_COLOR instead).
 * @param {number} depth
 * @returns {string} an hsl(...) string
 */
export function depthColor(depth) {
  const hue = (200 + depth * 45) % 360;
  return `hsl(${hue}, 65%, 55%)`;
}

/**
 * Node label text: display name + short/full address per `addressFormat`.
 * Name precedence: user alias > known-address label > (none). Identity (id) is
 * always the raw address; this only affects the drawn label.
 * @param {import('../graphStore.js').NodeRecord} node
 * @param {{ addressFormat:'short'|'full', knownLabel?:string|null }} opts
 * @returns {string}
 */
export function nodeLabel(node, opts) {
  const { address, alias } = node;
  const { addressFormat } = opts;
  const name = alias || (opts && opts.knownLabel) || null;
  const displayAddress = addressFormat === "full" ? address : shortAddress(address);
  return name ? `${name}\n(${displayAddress})` : displayAddress;
}

/**
 * vis node visual props (color/title). Title (hover) shows name + full address.
 * @param {import('../graphStore.js').NodeRecord} node
 * @param {{ knownLabel?:string|null }} [opts]
 * @returns {{ color:string, title:string }}
 */
export function nodeVisual(node, opts) {
  const { address, alias, depth, isRoot } = node;
  const color = isRoot ? ROOT_COLOR : depthColor(depth);
  const name = alias || (opts && opts.knownLabel) || null;
  const title = name ? `${name} — ${address}` : address;
  return { color, title };
}

/**
 * Edge label ("<amount> <symbol>"), or "" when too long / indeterminate-and-noisy.
 * Symbol is display-only; NEVER used for identity.
 * @param {import('../graphStore.js').EdgeRecord} edge
 * @returns {string}
 */
export function edgeLabel(edge) {
  const label = `${edge.amountText} ${edge.symbol}`;
  return label.length > 18 ? "" : label;
}
