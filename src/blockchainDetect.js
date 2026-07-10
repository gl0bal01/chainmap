// =============================================================================
// blockchainDetect.js — pure, DOM-free crypto-address chain detection by format.
// Lets an investigator paste ANY address and learn which chain it belongs to,
// and whether this tool (EVM-only, via Etherscan v2) can scan it. Non-EVM
// addresses get a link to the right explorer instead of a failed scan.
//
// Address patterns adapted from gl0bal01's discord-osint-assistant
// (commands/blockchain-detect.js). EVM chains share one 0x40-hex format, so they
// are collapsed into a single "EVM-compatible" result here (the app's chain
// selector picks the actual network).
// =============================================================================

/**
 * @typedef {object} ChainMatch
 * @property {string} name
 * @property {string} symbol
 * @property {'evm'|'bitcoin'|'other'} family
 * @property {boolean} evm      scannable by this tool
 * @property {string} explorer  base explorer URL (address appended by caller/UI)
 * @property {string} [note]
 */

const PATTERNS = [
  { name: "EVM-compatible", symbol: "EVM", family: "evm", evm: true, explorer: "https://etherscan.io/address/",
    note: "Ethereum, BSC, Polygon, Arbitrum, Optimism, Base, Avalanche, Fantom…",
    regexes: [/^0x[a-fA-F0-9]{40}$/] },
  { name: "Bitcoin", symbol: "BTC", family: "bitcoin", evm: false, explorer: "https://blockstream.info/address/",
    regexes: [/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/, /^bc1[ac-hj-np-z02-9]{6,87}$/] },
  { name: "Litecoin", symbol: "LTC", family: "other", evm: false, explorer: "https://blockchair.com/litecoin/address/",
    regexes: [/^[LM][a-km-zA-HJ-NP-Z1-9]{26,33}$/, /^ltc1[ac-hj-np-z02-9]{6,87}$/] },
  { name: "Bitcoin Cash", symbol: "BCH", family: "other", evm: false, explorer: "https://blockchair.com/bitcoin-cash/address/",
    regexes: [/^(bitcoincash:)?[qp][a-z0-9]{41}$/] },
  { name: "Dogecoin", symbol: "DOGE", family: "other", evm: false, explorer: "https://dogechain.info/address/",
    regexes: [/^D[5-9A-HJ-NP-U][1-9A-HJ-NP-Za-km-z]{32}$/] },
  { name: "Ripple", symbol: "XRP", family: "other", evm: false, explorer: "https://xrpscan.com/account/",
    regexes: [/^r[0-9a-zA-Z]{24,34}$/] },
  { name: "Tron", symbol: "TRX", family: "other", evm: false, explorer: "https://tronscan.org/#/address/",
    regexes: [/^T[A-Za-z0-9]{33}$/] },
  { name: "Solana", symbol: "SOL", family: "other", evm: false, explorer: "https://explorer.solana.com/address/",
    regexes: [/^[1-9A-HJ-NP-Za-km-z]{32,44}$/] },
  { name: "Cardano", symbol: "ADA", family: "other", evm: false, explorer: "https://cardanoscan.io/address/",
    regexes: [/^addr1[a-z0-9]{58}$/, /^DdzFF[a-zA-Z0-9]{80,120}$/] },
  { name: "Cosmos", symbol: "ATOM", family: "other", evm: false, explorer: "https://www.mintscan.io/cosmos/account/",
    regexes: [/^cosmos1[a-z0-9]{38}$/] },
  { name: "Polkadot", symbol: "DOT", family: "other", evm: false, explorer: "https://polkadot.subscan.io/account/",
    regexes: [/^1[a-zA-Z0-9]{47}$/] },
  { name: "Stellar", symbol: "XLM", family: "other", evm: false, explorer: "https://stellarscan.io/account/",
    regexes: [/^G[A-Z0-9]{55}$/] },
  { name: "Monero", symbol: "XMR", family: "other", evm: false, explorer: "https://xmrchain.net/search?value=",
    regexes: [/^4[0-9AB][1-9A-HJ-NP-Za-km-z]{93}$/] },
  { name: "Dash", symbol: "DASH", family: "other", evm: false, explorer: "https://blockchair.com/dash/address/",
    regexes: [/^X[1-9A-HJ-NP-Za-km-z]{33}$/] },
];

/**
 * @typedef {object} DetectResult
 * @property {string} input          trimmed address
 * @property {ChainMatch[]} matches   all format matches (EVM first)
 * @property {ChainMatch|null} primary highest-priority match
 * @property {boolean} isEvm          scannable by this tool
 */

/**
 * Detect which chain(s) an address's format matches.
 * @param {string} address
 * @returns {DetectResult}
 */
export function detectAddress(address) {
  const input = (address || "").trim();
  const matches = [];
  if (input) {
    for (const c of PATTERNS) {
      if (c.regexes.some((r) => r.test(input))) {
        matches.push({ name: c.name, symbol: c.symbol, family: c.family, evm: c.evm, explorer: c.explorer, note: c.note });
      }
    }
  }
  return { input, matches, primary: matches[0] || null, isEvm: matches.some((m) => m.evm) };
}
