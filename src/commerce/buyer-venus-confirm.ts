import { parseEventLogs, type Address, type Hex, type Transaction, type TransactionReceipt } from "viem";
import { FIXED_SCALE } from "../core/fixed.js";
import { BUYER_TOKEN_ABI, BUYER_VTOKEN_ABI, requireBuyer, sameAddress, type BuyerVenusIntent } from "./buyer-venus-policy.js";

export interface BuyerVenusPositionRead {
  blockNumber: bigint; blockHash: Hex; exchangeRate: bigint;
  vTokenBalance: bigint; tokenBalance: bigint;
}

export function verifyBuyerSupply(intent: BuyerVenusIntent, transaction: Transaction, receipt: TransactionReceipt, position: BuyerVenusPositionRead) {
  requireBuyer(intent.operation === "SUPPLY", "This is not a supply intent.");
  const step = intent.steps.at(-1)!;
  requireBuyer(step.kind === "SUPPLY" && sameAddress(transaction.from, intent.account) &&
    transaction.to !== null && sameAddress(transaction.to, intent.market) && transaction.input === step.data &&
    transaction.value === 0n && transaction.nonce === step.nonce && transaction.chainId === 56,
  "The mined transaction does not match the approved recommendation.");
  requireBuyer(receipt.status === "success" && receipt.transactionHash === transaction.hash &&
    receipt.blockHash === transaction.blockHash && receipt.blockNumber === transaction.blockNumber,
  "The supply transaction has not succeeded in the expected block.");
  requireBuyer(position.blockNumber === receipt.blockNumber && position.blockHash === receipt.blockHash && position.exchangeRate > 0n,
    "Position verification is not pinned to the transaction block.");
  const mintLogs = parseEventLogs({ abi: BUYER_VTOKEN_ABI, eventName: "Mint", logs: receipt.logs, strict: true })
    .filter(log => sameAddress(log.address, intent.market) && sameAddress(log.args.minter, intent.account));
  requireBuyer(mintLogs.length === 1, "A successful EVM receipt alone does not prove a Venus supply.");
  const mint = mintLogs[0]!.args;
  requireBuyer(mint.mintAmount === BigInt(intent.amountRaw) && mint.mintTokens > 0n,
    "Venus did not receive the exact approved amount or mint a positive position.");
  const transfers = parseEventLogs({ abi: BUYER_TOKEN_ABI, eventName: "Transfer", logs: receipt.logs, strict: true });
  requireBuyer(transfers.some(log => sameAddress(log.address, intent.token) && sameAddress(log.args.from, intent.account) && sameAddress(log.args.to, intent.market) && log.args.value === mint.mintAmount),
    "The underlying transfer does not match the approved deposit.");
  requireBuyer(transfers.some(log => sameAddress(log.address, intent.market) && sameAddress(log.args.from, intent.market) && sameAddress(log.args.to, intent.account) && log.args.value === mint.mintTokens),
    "The minted vTokens were not transferred to the approved buyer.");
  requireBuyer(position.vTokenBalance >= mint.mintTokens && mint.accountBalance >= mint.mintTokens,
    "The received vToken position cannot be confirmed at the transaction block.");
  const underlyingValue = mint.mintTokens * position.exchangeRate / FIXED_SCALE;
  // A mint truncates less than one raw vToken. Do not incorrectly compare
  // human 8-decimal shares with 18-decimal underlying amounts.
  const maximumRounding = (position.exchangeRate + FIXED_SCALE - 1n) / FIXED_SCALE;
  requireBuyer(underlyingValue > 0n && underlyingValue + maximumRounding >= mint.mintAmount,
    "The minted shares do not account for the deposited underlying.");
  const actualGasWei = receipt.gasUsed * receipt.effectiveGasPrice;
  return {
    schemaVersion: "positioncrew.buyer-venus-supply-proof.v1" as const,
    chainId: 56 as const, account: intent.account as Address, token: intent.token as Address,
    market: intent.market as Address, sourceReceiptId: intent.sourceReceiptId,
    sourceRequestHash: intent.sourceRequestHash, transactionHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash,
    suppliedRaw: mint.mintAmount.toString(), mintedSharesRaw: mint.mintTokens.toString(),
    exchangeRateRaw: position.exchangeRate.toString(), underlyingValueRaw: underlyingValue.toString(),
    walletVTokenBalanceRaw: position.vTokenBalance.toString(), actualSupplyGasWei: actualGasWei.toString(),
    withinSupplyGasLimit: actualGasWei <= BigInt(step.gas) * BigInt(step.gasPrice),
    boundary: "Confirms this deposit and received position. Future yield, redemption liquidity and an onchain transaction expiry are not guaranteed.",
  };
}
export type BuyerVenusSupplyProof = ReturnType<typeof verifyBuyerSupply>;

export function verifyBuyerRedemption(proof: BuyerVenusSupplyProof, transaction: Transaction, receipt: TransactionReceipt, shares: bigint, data: Hex) {
  requireBuyer(shares > 0n && shares <= BigInt(proof.mintedSharesRaw), "The withdrawal exceeds this deposit's minted shares.");
  requireBuyer(transaction.chainId === 56 && sameAddress(transaction.from, proof.account) && transaction.to !== null && sameAddress(transaction.to, proof.market) && transaction.value === 0n && transaction.input === data,
    "The withdrawal transaction differs from the approved operation.");
  requireBuyer(receipt.status === "success" && receipt.transactionHash === transaction.hash && receipt.blockHash === transaction.blockHash,
    "The withdrawal has not succeeded in the expected block.");
  const redemptions = parseEventLogs({ abi: BUYER_VTOKEN_ABI, eventName: "Redeem", logs: receipt.logs, strict: true })
    .filter(log => sameAddress(log.address, proof.market) && sameAddress(log.args.redeemer, proof.account));
  requireBuyer(redemptions.length === 1 && redemptions[0]!.args.redeemTokens === shares && redemptions[0]!.args.redeemAmount > 0n,
    "A successful EVM receipt alone does not prove a withdrawal.");
  const amount = redemptions[0]!.args.redeemAmount;
  const transfers = parseEventLogs({ abi: BUYER_TOKEN_ABI, eventName: "Transfer", logs: receipt.logs, strict: true });
  requireBuyer(transfers.some(log => sameAddress(log.address, proof.token) && sameAddress(log.args.from, proof.market) && sameAddress(log.args.to, proof.account) && log.args.value === amount),
    "The redeemed underlying was not delivered to the buyer.");
  requireBuyer(transfers.some(log => sameAddress(log.address, proof.market) && sameAddress(log.args.from, proof.account) && sameAddress(log.args.to, proof.market) && log.args.value === shares),
    "The redeemed shares do not match the withdrawal.");
  return { transactionHash: receipt.transactionHash, blockHash: receipt.blockHash,
    redeemedSharesRaw: shares.toString(), receivedUnderlyingRaw: amount.toString(),
    actualGasWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString() };
}
