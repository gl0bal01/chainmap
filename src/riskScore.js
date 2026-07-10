// =============================================================================
// riskScore.js — pure, DOM-free per-node risk heuristic for the details panel.
// Combines the graph's own signals into a quick, EXPLAINABLE score so an
// investigator can triage which addresses to look at. Not a verdict — every
// contributing reason is surfaced (as i18n keys) so nothing is a black box.
// =============================================================================

/**
 * @typedef {object} RiskInput
 * @property {number}  inDeg              distinct senders
 * @property {number}  outDeg             distinct recipients
 * @property {('sink'|'faucet'|null)} hubKind
 * @property {boolean} onCycle            lies on a round-trip
 * @property {boolean} hasContractCalls   any connected edge carried calldata
 * @property {boolean} known              labeled known address (exchange/router/…)
 */

/**
 * @param {RiskInput} input
 * @returns {{ score:number, level:'low'|'med'|'high', reasons:string[] }}
 *   `reasons` are i18n keys ("risk.cycle", …).
 */
export function scoreNode(input) {
  const i = input || {};
  const reasons = [];
  let score = 0;

  if (i.onCycle) { score += 3; reasons.push("risk.cycle"); }
  if (i.hubKind === "sink") { score += 2; reasons.push("risk.sink"); }
  else if (i.hubKind === "faucet") { score += 2; reasons.push("risk.faucet"); }
  if ((Number(i.inDeg) || 0) + (Number(i.outDeg) || 0) >= 20) { score += 1; reasons.push("risk.highDegree"); }
  if (i.hasContractCalls) { score += 1; reasons.push("risk.contract"); }
  if (i.known) { reasons.push("risk.known"); } // context only — no score

  const level = score >= 4 ? "high" : score >= 2 ? "med" : "low";
  return { score, level, reasons };
}
