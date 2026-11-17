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
  // Bridges (signatures verified 2026-11-17 with keccak-256; recipient on the other side is destRecipient, never recipient)
  "0x9a2ac6d5": "depositETHTo(address,uint32,bytes)",
  "0x838b2520": "depositERC20To(address,address,address,uint256,uint32,bytes)",
  "0xe11013dd": "bridgeETHTo(address,uint32,bytes)",
  "0x540abf73": "bridgeERC20To(address,address,address,uint256,uint32,bytes)",
  "0xa3a79548": "withdrawTo(address,address,uint256,uint32,bytes)",
  "0xb1a1a882": "depositETH(uint32,bytes)",
  "0xd2ce7d65": "outboundTransfer(address,address,uint256,uint256,uint256,bytes)",
  "0x4fb1a07b": "outboundTransferCustomRefund(address,address,address,uint256,uint256,uint256,bytes)",
  "0x439370b1": "depositEth()",
  "0x4faa8a26": "depositEtherFor(address)",
  "0xe3dec8fb": "depositFor(address,address,bytes)",
  "0xce0b63ce": "depositETH(address,uint256,uint256)",
  "0xf219fa66": "depositERC20(address,address,uint256,uint256)",
  "0x7b939232": "depositV3(address,address,address,address,uint256,uint256,uint256,address,uint32,uint32,uint32,bytes)",
  "0xdeace8f5": "sendToL2(uint256,address,uint256,uint256,uint256,address,uint256)",
  "0xeea0d7b2": "swapAndSend(uint256,address,uint256,uint256,uint256,uint256,uint256,uint256)",
  "0x01e4f53a": "relayTokens(address,uint256)",
  "0xad58bdd1": "relayTokens(address,address,uint256)",
  "0x522ea81a": "bridgeToken(address,uint256,address)",
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

/** selector -> ordered parameter names (for the selectors we decode). Names are
 *  the canonical argument roles an investigator cares about, not just types. */
export const SELECTOR_PARAMS = {
  "0xa9059cbb": ["recipient", "amount"],
  "0x23b872dd": ["from", "recipient", "amount"],
  "0x095ea7b3": ["spender", "amount"],
  "0x39509351": ["spender", "addedValue"],
  "0xa457c2d7": ["spender", "subtractedValue"],
  "0x42966c68": ["amount"],
  "0xa22cb465": ["operator", "approved"],
  "0x42842e0e": ["from", "recipient", "tokenId"],
  "0x40c10f19": ["recipient", "amount"],
  "0x2e1a7d4d": ["amount"],
  "0xf2fde38b": ["newOwner"],
  // Bridges (signatures verified 2026-11-17 with keccak-256; recipient on the other side is destRecipient, never recipient)
  "0x9a2ac6d5": ["destRecipient", "minGasLimit"],
  "0x838b2520": ["l1Token", "l2Token", "destRecipient", "amount", "minGasLimit"],
  "0xe11013dd": ["destRecipient", "minGasLimit"],
  "0x540abf73": ["localToken", "remoteToken", "destRecipient", "amount", "minGasLimit"],
  "0xa3a79548": ["l2Token", "destRecipient", "amount", "minGasLimit"],
  "0xb1a1a882": ["minGasLimit"],
  "0xd2ce7d65": ["token", "destRecipient", "amount", "maxGas", "gasPriceBid"],
  "0x4fb1a07b": ["token", "refundTo", "destRecipient", "amount", "maxGas", "gasPriceBid"],
  "0x4faa8a26": ["destRecipient"],
  "0xe3dec8fb": ["destRecipient", "rootToken"],
  "0xce0b63ce": ["destRecipient", "amount", "gasLimit"],
  "0xf219fa66": ["token", "destRecipient", "amount", "gasLimit"],
  "0x7b939232": ["depositor", "destRecipient", "inputToken", "outputToken", "inputAmount", "outputAmount", "destChainId", "exclusiveRelayer", "quoteTimestamp", "fillDeadline", "exclusivityDeadline"],
  "0xdeace8f5": ["destChainId", "destRecipient", "amount", "amountOutMin", "deadline", "relayer", "relayerFee"],
  "0xeea0d7b2": ["destChainId", "destRecipient", "amount", "bonderFee", "amountOutMin", "deadline", "destinationAmountOutMin", "destinationDeadline"],
  "0x01e4f53a": ["destRecipient", "amount"],
  "0xad58bdd1": ["token", "destRecipient", "amount"],
  "0x522ea81a": ["token", "amount", "destRecipient"],
};

/**
 * Ordered parameter names for a known selector, or null.
 * @param {string} selector "0x" + 8 hex (case-insensitive)
 * @returns {string[]|null}
 */
export function paramNames(selector) {
  if (!selector) return null;
  return SELECTOR_PARAMS[String(selector).toLowerCase()] || null;
}
