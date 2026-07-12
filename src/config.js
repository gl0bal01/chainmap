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
 * translated. `native` is the chain's native currency ticker (shown on edges
 * for value transfers that aren't a token, via graphStore.setNativeSymbol).
 *
 * Sourced from the Etherscan v2 unified chainlist (https://api.etherscan.io/v2/chainlist,
 * fetched 2026-07-12; totalcount 64, all status:1). Etherscan v2 serves every
 * listed chain from the SAME host (api.etherscan.io, `?chainid=`), so every
 * entry here stays CSP-compatible (connect-src is api.etherscan.io only) —
 * never add a chain that isn't on that list. See
 * .superpowers/sdd/more-evm-report.md for full sourcing notes. Fantom (chainid
 * 250) is NOT on this list — it rebranded to Sonic (chainid 146, native "S"),
 * which is the live entry below — so it is intentionally absent here.
 * @typedef {{ id:number, name:string, explorer:string, native:string }} Chain
 * @type {Chain[]}
 */
export const CHAINS = [
  // --- curated originals (pre-dating this expansion) ------------------------
  { id: 1,        name: "Ethereum",           explorer: "etherscan.io",              native: "ETH" },
  { id: 11155111, name: "Sepolia (testnet)",  explorer: "sepolia.etherscan.io",      native: "ETH" },
  { id: 56,       name: "BNB Chain",          explorer: "bscscan.com",               native: "BNB" },
  { id: 137,      name: "Polygon",            explorer: "polygonscan.com",           native: "POL" },
  { id: 42161,    name: "Arbitrum One",       explorer: "arbiscan.io",               native: "ETH" },
  { id: 10,       name: "Optimism",           explorer: "optimistic.etherscan.io",   native: "ETH" },
  { id: 8453,     name: "Base",               explorer: "basescan.org",              native: "ETH" },
  { id: 43114,    name: "Avalanche C-Chain",  explorer: "snowscan.xyz",              native: "AVAX" },

  // --- Etherscan v2 chainlist: additional mainnets --------------------------
  { id: 59144,    name: "Linea",              explorer: "lineascan.build",           native: "ETH" },
  { id: 81457,    name: "Blast",              explorer: "blastscan.io",              native: "ETH" },
  { id: 199,      name: "BitTorrent Chain",   explorer: "bttcscan.com",              native: "BTT" },
  { id: 42220,    name: "Celo",               explorer: "celoscan.io",               native: "CELO" },
  // Fraxtal's gas token changed from frxETH to FRAX in the "North Star"
  // upgrade (2026-04-29); FRAX is current as of this fetch.
  { id: 252,      name: "Fraxtal",            explorer: "fraxscan.com",              native: "FRAX" },
  { id: 100,      name: "Gnosis",             explorer: "gnosisscan.io",             native: "XDAI" },
  { id: 5000,     name: "Mantle",             explorer: "mantlescan.xyz",            native: "MNT" },
  { id: 4352,     name: "MemeCore",           explorer: "memecorescan.io",           native: "M" },
  { id: 1284,     name: "Moonbeam",           explorer: "moonbeam.moonscan.io",      native: "GLMR" },
  { id: 1285,     name: "Moonriver",          explorer: "moonriver.moonscan.io",     native: "MOVR" },
  { id: 204,      name: "opBNB",              explorer: "opbnb.bscscan.com",         native: "BNB" },
  { id: 167000,   name: "Taiko",              explorer: "taikoscan.io",              native: "ETH" },
  { id: 50,       name: "XDC Network",        explorer: "xdcscan.com",               native: "XDC" },
  { id: 33139,    name: "ApeChain",           explorer: "apescan.io",                native: "APE" },
  { id: 480,      name: "World Chain",        explorer: "worldscan.org",             native: "ETH" },
  { id: 146,      name: "Sonic",              explorer: "sonicscan.org",             native: "S" },
  { id: 130,      name: "Unichain",           explorer: "uniscan.xyz",               native: "ETH" },
  { id: 2741,     name: "Abstract",           explorer: "abscan.org",                native: "ETH" },
  { id: 80094,    name: "Berachain",          explorer: "berascan.com",              native: "BERA" },
  { id: 143,      name: "Monad",              explorer: "monadscan.com",             native: "MON" },
  { id: 999,      name: "HyperEVM",           explorer: "hyperevmscan.io",           native: "HYPE" },
  // Katana has a separate governance token (KAT) but gas is paid in ETH.
  { id: 747474,   name: "Katana",             explorer: "katanascan.com",            native: "ETH" },
  { id: 1329,     name: "Sei",                explorer: "seiscan.io",                native: "SEI" },
  // Chainlist marks this "Coming soon" as of fetch date; USDT-native L1 by
  // design (Tether/Bitfinex-backed "Stablechain").
  { id: 988,      name: "Stable",             explorer: "stablescan.xyz",            native: "USDT" },
  { id: 9745,     name: "Plasma",             explorer: "plasmascan.to",             native: "XPL" },
  // Lower-confidence: MegaETH is an Ethereum L2; its MEGA token (TGE'd
  // 2026-04-30) funds staking/governance, but public sources didn't confirm
  // gas was switched off ETH by fetch date. Testnet is confirmed ETH-gas
  // (see below), so ETH is used here as the documented L2 default.
  { id: 4326,     name: "MegaETH",            explorer: "mega.etherscan.io",         native: "ETH" },

  // --- Etherscan v2 chainlist: additional testnets ---------------------------
  { id: 560048,   name: "Hoodi (testnet)",              explorer: "hoodi.etherscan.io",             native: "ETH" },
  { id: 97,       name: "BNB Chain (testnet)",          explorer: "testnet.bscscan.com",            native: "BNB" },
  { id: 80002,    name: "Polygon Amoy (testnet)",       explorer: "amoy.polygonscan.com",           native: "POL" },
  { id: 84532,    name: "Base Sepolia (testnet)",       explorer: "sepolia.basescan.org",           native: "ETH" },
  { id: 421614,   name: "Arbitrum Sepolia (testnet)",   explorer: "sepolia.arbiscan.io",            native: "ETH" },
  { id: 59141,    name: "Linea Sepolia (testnet)",      explorer: "sepolia.lineascan.build",        native: "ETH" },
  { id: 168587773, name: "Blast Sepolia (testnet)",     explorer: "sepolia.blastscan.io",           native: "ETH" },
  { id: 11155420, name: "Optimism Sepolia (testnet)",   explorer: "sepolia-optimism.etherscan.io",  native: "ETH" },
  { id: 43113,    name: "Avalanche Fuji (testnet)",     explorer: "testnet.snowscan.xyz",           native: "AVAX" },
  { id: 1029,     name: "BitTorrent Chain (testnet)",   explorer: "testnet.bttcscan.com",           native: "BTT" },
  { id: 11142220, name: "Celo Sepolia (testnet)",       explorer: "sepolia.celoscan.io",            native: "CELO" },
  { id: 2523,     name: "Fraxtal Hoodi (testnet)",      explorer: "hoodi.fraxscan.com",             native: "FRAX" },
  { id: 5003,     name: "Mantle Sepolia (testnet)",     explorer: "sepolia.mantlescan.xyz",         native: "MNT" },
  { id: 43522,    name: "MemeCore Insectarium (testnet)", explorer: "testnet.memecorescan.io",      native: "M" },
  // Moonbeam's testnet has its own faucet-issued token (DEV), NOT GLMR.
  { id: 1287,     name: "Moonbase Alpha (testnet)",     explorer: "moonbase.moonscan.io",           native: "DEV" },
  { id: 5611,     name: "opBNB (testnet)",              explorer: "opbnb-testnet.bscscan.com",      native: "BNB" },
  { id: 167013,   name: "Taiko Hoodi (testnet)",        explorer: "hoodi.taikoscan.io",             native: "ETH" },
  { id: 51,       name: "XDC Apothem (testnet)",        explorer: "testnet.xdcscan.com",            native: "XDC" },
  { id: 33111,    name: "ApeChain Curtis (testnet)",    explorer: "curtis.apescan.io",              native: "APE" },
  { id: 4801,     name: "World Sepolia (testnet)",      explorer: "sepolia.worldscan.org",          native: "ETH" },
  { id: 14601,    name: "Sonic (testnet)",              explorer: "testnet.sonicscan.org",          native: "S" },
  { id: 1301,     name: "Unichain Sepolia (testnet)",   explorer: "sepolia.uniscan.xyz",            native: "ETH" },
  { id: 11124,    name: "Abstract Sepolia (testnet)",   explorer: "sepolia.abscan.org",             native: "ETH" },
  { id: 80069,    name: "Berachain Bepolia (testnet)",  explorer: "testnet.berascan.com",           native: "BERA" },
  { id: 10143,    name: "Monad (testnet)",              explorer: "testnet.monadscan.com",          native: "MON" },
  { id: 737373,   name: "Katana Bokuto (testnet)",      explorer: "bokuto.katanascan.com",          native: "ETH" },
  { id: 1328,     name: "Sei (testnet)",                explorer: "testnet.seiscan.io",             native: "SEI" },
  { id: 2201,     name: "Stable (testnet)",             explorer: "testnet.stablescan.xyz",         native: "USDT" },
  { id: 9746,     name: "Plasma (testnet)",             explorer: "testnet.plasmascan.to",          native: "XPL" },
  { id: 6343,     name: "MegaETH (testnet)",            explorer: "testnet-mega.etherscan.io",      native: "ETH" },
];

/** Chains probed by "Detect chain", in priority order. All are in CHAINS.
 *  Ethereum, Base, Arbitrum One, Optimism, Polygon, BNB, Avalanche, Linea,
 *  Blast, Gnosis, Mantle, Celo. zkSync Era (324) / Scroll (534352) are NOT on
 *  Etherscan v2 -> intentionally excluded (see CHAINS' sourcing note). */
export const PROBE_CHAIN_IDS = [1, 8453, 42161, 10, 137, 56, 43114, 59144, 81457, 100, 5000, 42220];

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
