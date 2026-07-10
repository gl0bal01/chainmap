// =============================================================================
// selectors.js — pure, DOM-free 4-byte function-selector dictionary + lookup.
// Decodes the method selector (first 4 bytes of calldata) to a human signature
// for the details panel. Curated, well-known selectors only (no network call to
// 4byte.directory) — an unknown selector is shown raw, never guessed/mislabeled.
// =============================================================================

/** selector (0x + 8 lowercase hex) -> canonical function signature. */
export const SELECTORS = {
  // ERC-20 / ERC-721 / ERC-1155
  "0xa9059cbb": "transfer(address,uint256)",
  "0x23b872dd": "transferFrom(address,address,uint256)",
  "0x095ea7b3": "approve(address,uint256)",
  "0x39509351": "increaseAllowance(address,uint256)",
  "0xa457c2d7": "decreaseAllowance(address,uint256)",
  "0x42966c68": "burn(uint256)",
  "0xa22cb465": "setApprovalForAll(address,bool)",
  "0x42842e0e": "safeTransferFrom(address,address,uint256)",
  "0xb88d4fde": "safeTransferFrom(address,address,uint256,bytes)",
  "0xf242432a": "safeTransferFrom(address,address,uint256,uint256,bytes)",
  "0x2eb2c2d6": "safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)",
  "0x40c10f19": "mint(address,uint256)",
  // WETH
  "0xd0e30db0": "deposit()",
  "0x2e1a7d4d": "withdraw(uint256)",
  // Tornado Cash
  "0xb214faa5": "deposit(bytes32)",
  // Uniswap V2 router
  "0x38ed1739": "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)",
  "0x7ff36ab5": "swapExactETHForTokens(uint256,address[],address,uint256)",
  "0x18cbafe5": "swapExactTokensForETH(uint256,uint256,address[],address,uint256)",
  "0xb6f9de95": "swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256)",
  "0x791ac947": "swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)",
  "0x5c11d795": "swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)",
  "0xe8e33700": "addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256)",
  "0xf305d719": "addLiquidityETH(address,uint256,uint256,uint256,address,uint256)",
  "0x02751cec": "removeLiquidityETH(address,uint256,uint256,uint256,address,uint256)",
  "0xbaa2abde": "removeLiquidity(address,address,uint256,uint256,uint256,address,uint256)",
  // Uniswap V3 router
  "0x414bf389": "exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))",
  "0xc04b8d59": "exactInput((bytes,address,uint256,uint256,uint256))",
  // Uniswap universal router / multicall / proxy
  "0x3593564c": "execute(bytes,bytes[],uint256)",
  "0xac9650d8": "multicall(bytes[])",
  "0x5ae401dc": "multicall(uint256,bytes[])",
  "0x1cff79cd": "execute(address,bytes)",
  // ownership
  "0xf2fde38b": "transferOwnership(address)",
  "0x715018a6": "renounceOwnership()",
  "0x3ccfd60b": "withdraw()",
  // Gnosis Safe
  "0x6a761202": "execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)",
};

/**
 * Human signature for a selector, or null if not in the dictionary.
 * @param {string} selector "0x" + 8 hex (case-insensitive)
 * @returns {string|null}
 */
export function methodName(selector) {
  if (!selector) return null;
  return SELECTORS[String(selector).toLowerCase()] || null;
}
