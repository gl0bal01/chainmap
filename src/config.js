// =============================================================================
// config.js — static configuration & constants (pure data, DOM-free).
//
// This module is the shared contract every other module imports. It contains NO
// logic and NO user-facing prose (labels are i18n keys resolved by i18n.js).
// Adding a chain / tx-type / resolution = edit one entry here.
// =============================================================================

/** Etherscan v2 unified multichain endpoint. The chain is chosen via `chainid`,
 *  not a different host — one host for every supported chain. */
export const API_BASE = "https://api.etherscan.io/v2/api";

/**
 * Supported chains. `explorer` is used ONLY to build outbound address/tx links
 * (block-explorer navigation, never fetched). `name` is a proper noun — not
 * translated.
 * @typedef {{ id:number, name:string, explorer:string }} Chain
 * @type {Chain[]}
 */
export const CHAINS = [
  { id: 1,        name: "Ethereum",           explorer: "etherscan.io" },
  { id: 11155111, name: "Sepolia (testnet)",  explorer: "sepolia.etherscan.io" },
  { id: 56,       name: "BNB Chain",          explorer: "bscscan.com" },
  { id: 137,      name: "Polygon",            explorer: "polygonscan.com" },
  { id: 42161,    name: "Arbitrum One",       explorer: "arbiscan.io" },
  { id: 10,       name: "Optimism",           explorer: "optimistic.etherscan.io" },
  { id: 8453,     name: "Base",               explorer: "basescan.org" },
  { id: 43114,    name: "Avalanche C-Chain",  explorer: "snowtrace.io" },
  { id: 250,      name: "Fantom",             explorer: "ftmscan.com" },
];

/**
 * UI tx-type checkboxes -> underlying Etherscan `action`s. "token" fans out to
 * three actions, each with its own edge color and i18n label key.
 * @typedef {{ action:string, group:'normal'|'internal'|'token', kind?:string,
 *             labelKey:string, color:string }} TxTypeInfo
 * @type {Record<'normal'|'internal'|'token', TxTypeInfo[]>}
 */
export const TX_TYPE_GROUPS = {
  normal:   [{ action: "txlist",         group: "normal",   labelKey: "tx.type.normal",   color: "#4f8ef7" }],
  internal: [{ action: "txlistinternal", group: "internal", labelKey: "tx.type.internal", color: "#f7a24f" }],
  token: [
    { action: "tokentx",     group: "token", kind: "erc20",   labelKey: "tx.type.erc20",   color: "#4fd67a" },
    { action: "tokennfttx",  group: "token", kind: "erc721",  labelKey: "tx.type.erc721",  color: "#c14fd6" },
    { action: "token1155tx", group: "token", kind: "erc1155", labelKey: "tx.type.erc1155", color: "#d64f6b" },
  ],
};

/** Root (searched) node color. Discovered nodes are colored by BFS depth
 *  (see render/labels.depthColor). */
export const ROOT_COLOR = "#e63946";

/** Fixed export resolutions. `auto` is computed from node count then clamped by
 *  the pixel guard (see render/export.computeExportSize). */
export const RESOLUTION_PRESETS = {
  hd:  { w: 1920, h: 1080 },
  qhd: { w: 2560, h: 1440 },
  uhd: { w: 3840, h: 2160 },
};

/** Export pixel budget. `warn` -> confirm before proceeding; `cap` -> hard
 *  ceiling (clamp + fall back to CSV) so a huge auto-export can't freeze the tab.
 *  Old app could allocate ~10000x6000 = 60M px RGBA (~240MB) then duplicate it. */
export const EXPORT_PIXELS = { warn: 24_000_000, cap: 48_000_000 };

/** Default form values (English default locale, short address display). */
export const DEFAULTS = {
  depth: 2,
  maxTxPerAddress: 20,
  safetyCap: 300,
  rps: 3,
  amountThreshold: 0,
  addressFormat: "short", // "short" | "full"
  locale: "en",           // "en" | "fr"
  layout: "force",        // "force" | "hierarchical"
};

/** Inclusive input bounds (mirror index.html min/max attrs). */
export const LIMITS = {
  depth:           { min: 1, max: 6 },
  maxTxPerAddress: { min: 1, max: 1000 },
  safetyCap:       { min: 1, max: 5000 },
  rps:             { min: 1, max: 30 },
  degreeThreshold: { min: 1, max: 1000 },
};

/** Etherscan fetch tuning (etherscanClient). */
export const FETCH = {
  timeoutMs: 15_000,
  maxRetries: 4,
  backoffBaseMs: 1200, // linear-ish backoff: base * attempt, or Retry-After if larger
  startblock: 0,
  endblock: 99_999_999,
  sort: "desc", // sampling: newest-first
  page: 1,
};

/** localStorage keys (the only persistence; never leaves the browser). */
export const STORAGE_KEYS = {
  apiKey: "etherscanApiKey",
  chainId: "etherscanChainId",
  addressFormat: "addressFormat",
  locale: "locale",
  panels: "panelsOpen", // which control accordions are expanded
};

/** Bundled local datasets (loaded via fetch from same origin — connect-src 'self').
 *  Populated in Stage D; empty placeholders ship now. */
export const DATA_PATHS = {
  knownAddresses: "./data/known-addresses.json",
  spamTokens: "./data/spam-tokens.json",
  demo: "./data/demo-workspace.json",
};
