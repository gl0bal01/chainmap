// Fake-token detection: an ERC-20 whose normalized symbol is canonical on a
// chain but whose contract is not one of that chain's curated contracts.
// Pure, DOM-free; inputs may come from untrusted workspace JSON, so never throw.
//
// Confusables table scope: uppercase Cyrillic/Greek letters that render like a
// Latin letter, plus U+20AE (tugrik sign, looks like T). Digits are NOT mapped
// (USD0 is a real, different token). Not a full Unicode confusables set.

const CONFUSABLES = {
  // Cyrillic
  "А": "A", "В": "B", "С": "C", "Е": "E", "Н": "H",
  "І": "I", "К": "K", "М": "M", "О": "O", "Р": "P",
  "Ѕ": "S", "Т": "T", "Х": "X", "У": "Y", "Ү": "Y",
  // Greek
  "Α": "A", "Β": "B", "Ϲ": "C", "Ε": "E", "Η": "H",
  "Ι": "I", "Κ": "K", "Μ": "M", "Ο": "O", "Ρ": "P",
  "Τ": "T", "Χ": "X", "Υ": "Y",
  "₮": "T",
};

export function normalizeSymbol(s) {
  if (typeof s !== "string") return "";
  return s
    .normalize("NFKC")
    .toUpperCase()
    .replace(/./gu, (c) => CONFUSABLES[c] ?? c)
    .replace(/[\s\p{P}\p{Cf}]/gu, "");
}

export function buildCanonicalIndex(data) {
  const index = new Map();
  if (!data || typeof data !== "object") return index;
  for (const [chain, entries] of Object.entries(data)) {
    if (chain === "*" || !entries || typeof entries !== "object") continue;
    const bySymbol = new Map();
    for (const [addr, e] of Object.entries(entries)) {
      if (!e || e.category !== "token") continue;
      const sym = normalizeSymbol(e.symbol);
      if (!sym) continue;
      if (!bySymbol.has(sym)) bySymbol.set(sym, new Set());
      bySymbol.get(sym).add(addr.toLowerCase());
    }
    if (bySymbol.size) index.set(chain, bySymbol);
  }
  return index;
}

export function isFakeToken(edge, chainId, index) {
  if (!edge || edge.action !== "tokentx" || !(index instanceof Map)) return false;
  const contract = edge.tokenContract;
  if (typeof contract !== "string" || !contract) return false;
  const contracts = index.get(String(chainId))?.get(normalizeSymbol(edge.symbol));
  return !!contracts && !contracts.has(contract.toLowerCase());
}
