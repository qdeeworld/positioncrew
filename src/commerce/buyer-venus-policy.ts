import { z } from "zod";
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { YieldOptimizationDeliverableSchema, YieldOptimizationRequestSchema } from "../contracts/yield-optimization.js";
import { parseFixed, FIXED_SCALE, formatFixed } from "../core/fixed.js";
import type { FreshMarketplaceChain } from "./fresh-hire-schema.js";
import { PROVIDER_IDS } from "../providers/ids.js";

export const VENUS_BUYER_COMPTROLLER = "0xfD36E2c2a6789Db23113685031d7F16329158384" as Address;
export const VENUS_BUYER_VBNB = "0xA07c5b74C9B40447a954e1466938b865b6BBea36" as Address;
export const VENUS_BUYER_IMPLEMENTATION = "0xCDfea50f7CECCB24Fe804657DB8E6c93b689941e" as Address;
export const VENUS_BUYER_MARKETS = [
  { symbol: "USDT", token: "0x55d398326f99059fF775485246999027B3197955", market: "0xfD5840Cd36d94D7229439859C0112a4185BC0255" },
] as const;

export const BUYER_TOKEN_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "event Approval(address indexed owner,address indexed spender,uint256 value)",
]);
export const BUYER_VTOKEN_ABI = parseAbi([
  "function underlying() view returns (address)",
  "function comptroller() view returns (address)",
  "function implementation() view returns (address)",
  "function isVToken() view returns (bool)",
  "function decimals() view returns (uint8)",
  "function getCash() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function exchangeRateCurrent() returns (uint256)",
  "function exchangeRateStored() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function supplyRatePerBlock() view returns (uint256)",
  "function mint(uint256) returns (uint256)",
  "function redeem(uint256) returns (uint256)",
  "event Mint(address minter,uint256 mintAmount,uint256 mintTokens,uint256 accountBalance)",
  "event Redeem(address redeemer,uint256 redeemAmount,uint256 redeemTokens,uint256 accountBalance)",
  "event RedeemFee(address redeemer,uint256 feeAmount,uint256 redeemTokens)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
export const BUYER_COMPTROLLER_ABI = parseAbi([
  "function oracle() view returns (address)",
  "function getAssetsIn(address) view returns (address[])",
  "function getAccountLiquidity(address) view returns (uint256,uint256,uint256)",
  "function treasuryPercent() view returns (uint256)",
  "function actionPaused(address,uint8) view returns (bool)",
  "function supplyCaps(address) view returns (uint256)",
  "function markets(address) view returns (bool,uint256,bool,uint256,uint256,uint96,bool)",
]);
export const BUYER_ORACLE_ABI = parseAbi(["function getUnderlyingPrice(address) view returns (uint256)"]);
const AddressValue = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const Raw = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
export const BuyerVenusStepSchema = z.object({
  kind: z.enum(["RESET_APPROVAL", "APPROVE", "SUPPLY", "WITHDRAW"]),
  to: AddressValue, data: z.string().regex(/^0x[0-9a-fA-F]+$/), value: z.literal("0x0"),
  nonce: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), gas: Raw, gasPrice: Raw,
}).strict();
export const BuyerVenusIntentSchema = z.object({
  schemaVersion: z.literal("positioncrew.buyer-venus-intent.v1"),
  chainId: z.literal(56), operation: z.enum(["SUPPLY", "WITHDRAW"]),
  sourceReceiptId: z.string().uuid(), sourceRequestHash: z.string(),
  account: AddressValue, token: AddressValue, market: AddressValue,
  symbol: z.literal("USDT"),
  tokenDecimals: z.literal(18), vTokenDecimals: z.literal(8),
  amountRaw: Raw, amountUsd: z.string(), maxGasCostWei: Raw,
  expectedWithdrawalGasWei: Raw, expectedProtocolExitFeeUsd: z.string(),
  projectedNetBenefitUsd: z.string(), projectedGrossBenefitUsd: z.string(),
  estimatedSharesRaw: Raw, treasuryPercent: Raw,
  expiryMeaning: z.literal("PRE_SIGN_CHECK_ONLY_NOT_ONCHAIN_DEADLINE"),
  createdAt: z.string().datetime(), expiresAt: z.string().datetime(),
  blockNumber: Raw, blockHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  walletTokenBalanceRaw: Raw, walletVTokenBalanceRaw: Raw,
  sourceSupplyHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).nullable(),
  steps: z.array(BuyerVenusStepSchema).min(1).max(3),
}).strict();
export type BuyerVenusIntent = z.infer<typeof BuyerVenusIntentSchema>;
export type BuyerVenusStep = z.infer<typeof BuyerVenusStepSchema>;
export interface BuyerVenusSnapshot {
  chainId: number; blockNumber: bigint; blockHash: Hex; timestamp: bigint;
  underlying: Address; comptroller: Address; isVToken: boolean;
  tokenDecimals: number; vTokenDecimals: number; tokenBalance: bigint;
  vTokenBalance: bigint; allowance: bigint; nativeBalance: bigint; gasPrice: bigint;
  tokenPrice: bigint; bnbPrice: bigint; assetsIn: readonly Address[];
  liquidityError: bigint; shortfall: bigint; nonce: number; pendingNonce?: number;
  implementation: Address; listed: boolean; mintPaused: boolean; redeemPaused: boolean;
  treasuryPercent: bigint; exchangeRate: bigint; cash: bigint; totalSupply: bigint;
  supplyCap: bigint; currentApyBps: number;
}
export function requireBuyer(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export function sameAddress(left: string, right: string): boolean { return left.toLowerCase() === right.toLowerCase(); }
function minimum(values: bigint[]): bigint { return values.reduce((a, b) => a < b ? a : b); }

/** Visible defaults for a new assessment, never an update to accepted limits. */
export function buyerAssessmentCostDefaults(input: {
  capitalUsd: bigint; gasPrice: bigint; bnbPrice: bigint; treasuryPercent: bigint;
  grossApyBps: number; evaluationHorizonDays: number;
}) {
  requireBuyer(input.gasPrice > 0n && input.bnbPrice > 0n && input.treasuryPercent >= 0n && input.treasuryPercent < FIXED_SCALE,
    "The wallet's round-trip costs could not be verified.");
  const ceil = (value: bigint, divisor: bigint) => (value + divisor - 1n) / divisor;
  const price = ceil(input.gasPrice * 12n, 10n);
  const entryGas = ceil(price * 700_000n * input.bnbPrice, FIXED_SCALE);
  const exitGas = ceil(price * 500_000n * input.bnbPrice, FIXED_SCALE);
  const gross = input.capitalUsd * BigInt(input.grossApyBps) * BigInt(input.evaluationHorizonDays) / (10_000n * 365n);
  const exitFee = ceil((input.capitalUsd + gross) * input.treasuryPercent, FIXED_SCALE);
  const quote = (value: bigint) => formatFixed(ceil(value, 10n ** 12n) * 10n ** 12n, 6);
  const estimatedEntryCostUsd = quote(entryGas);
  const estimatedExitCostUsd = quote(exitGas + exitFee);
  // Sum the published rounded components. Rounding the unrounded sum could
  // make the displayed total one micro-dollar lower than its own components.
  const total = parseFixed(estimatedEntryCostUsd) + parseFixed(estimatedExitCostUsd);
  const maxExecutionCostUsd = quote(total > parseFixed("0.25") ? total : parseFixed("0.25"));
  return { estimatedEntryCostUsd, estimatedExitCostUsd, maxExecutionCostUsd, maxGasUsd: maxExecutionCostUsd };
}

export function supplySource(chain: FreshMarketplaceChain, account: string, now: Date) {
  requireBuyer(chain.job.state === "COMPLETED" && chain.receipt, "Complete a current Yield assessment first.");
  requireBuyer(chain.hire.service === "YIELD_OPTIMIZATION" && chain.hire.evidenceMode === "CURRENT_BLOCK_PINNED", "Only a current Yield assessment can authorize preparation.");
  const request = YieldOptimizationRequestSchema.parse(chain.hire.request);
  requireBuyer(chain.hire.providerId === PROVIDER_IDS.YIELD_OPTIMIZATION && chain.job.providerSelection === null, "Only the bound first-party Yield provider is supported by this execution policy.");
  const envelope = z.object({ result: z.object({ deliverable: YieldOptimizationDeliverableSchema, evaluation: z.object({ passed: z.literal(true) }) }) }).parse(chain.receipt.response);
  const result = envelope.result.deliverable;
  requireBuyer(request.chainId === 56 && sameAddress(request.account, account) && !/^0x0{40}$/i.test(account), "Connect the wallet used for this assessment.");
  requireBuyer(result.decision === "SUPPLY" && result.status === "ACTIONABLE" && result.requestId === request.requestId, "This assessment does not recommend an executable supply.");
  requireBuyer(now.getTime() < Math.min(Date.parse(request.deadline), Date.parse(result.expiresAt)), "The assessment expired. Refresh current markets and run a new assessment.");
  requireBuyer(request.currentPositions.length === 0 && (result.withdrawals?.length ?? 0) === 0, "This execution path supports idle assets only; it cannot withdraw or migrate existing positions.");
  const opportunity = request.opportunities.find(item => item.opportunityId === result.selectedOpportunityId);
  const market = opportunity && VENUS_BUYER_MARKETS.find(item => sameAddress(item.market, opportunity.vaultOrMarket) && sameAddress(item.token, opportunity.asset.address) && item.symbol === opportunity.asset.symbol);
  requireBuyer(opportunity && market && opportunity.asset.decimals === 18 && opportunity.protocol === "Venus Core Pool", "The selected asset or Venus market is not supported for execution.");
  const amountUsd = parseFixed(result.allocationUsd);
  requireBuyer(amountUsd > 0n && amountUsd <= minimum([parseFixed(request.capitalUsd), parseFixed(request.maxActionUsd), parseFixed(request.maxAllocationUsd ?? request.maxActionUsd)]), "The allocation exceeds the buyer's principal limit.");
  return { request, result, opportunity, market, amountUsd };
}

export function checkBuyerSnapshot(snapshot: BuyerVenusSnapshot, market: typeof VENUS_BUYER_MARKETS[number], now: Date, operation: "SUPPLY" | "WITHDRAW" = "SUPPLY"): void {
  requireBuyer(snapshot.chainId === 56, "The network is not BSC mainnet.");
  requireBuyer(snapshot.isVToken && sameAddress(snapshot.underlying, market.token) && sameAddress(snapshot.comptroller, VENUS_BUYER_COMPTROLLER) && snapshot.tokenDecimals === 18 && snapshot.vTokenDecimals === 8, "The live Venus market identity does not match the allowlist.");
  requireBuyer(sameAddress(snapshot.implementation, VENUS_BUYER_IMPLEMENTATION), "The Venus implementation changed and needs review before execution.");
  requireBuyer(snapshot.listed && (operation === "WITHDRAW" || !snapshot.mintPaused) && !snapshot.redeemPaused, "Venus supply or withdrawal is currently unavailable.");
  requireBuyer(snapshot.pendingNonce === undefined || snapshot.pendingNonce === snapshot.nonce, "The wallet has another pending transaction. Confirm its status before continuing.");
  requireBuyer(snapshot.exchangeRate > 0n && snapshot.treasuryPercent >= 0n && snapshot.treasuryPercent < FIXED_SCALE, "The exchange rate or withdrawal fee cannot be verified.");
  const age = now.getTime() / 1000 - Number(snapshot.timestamp);
  requireBuyer(age >= -10 && age <= 30, "The execution snapshot is not current.");
  requireBuyer(snapshot.assetsIn.length === 0 && snapshot.liquidityError === 0n && snapshot.shortfall === 0n, "This initial execution path requires a wallet without enrolled Venus collateral. Existing borrowing positions need a separate execution policy.");
  requireBuyer(snapshot.tokenPrice > 0n && snapshot.bnbPrice > 0n && snapshot.gasPrice > 0n, "Current price or gas evidence is unavailable.");
}

export function buildSupplyIntent(chain: FreshMarketplaceChain, account: string, snapshot: BuyerVenusSnapshot, now: Date): BuyerVenusIntent {
  const source = supplySource(chain, account, now);
  checkBuyerSnapshot(snapshot, source.market, now);
  const amount = source.amountUsd * FIXED_SCALE / snapshot.tokenPrice;
  requireBuyer(amount > 0n && amount <= snapshot.tokenBalance, `The connected wallet does not hold enough ${source.market.symbol}; this path does not swap other assets.`);
  const gasPrice = (snapshot.gasPrice * 12n + 9n) / 10n;
  const steps: BuyerVenusStep[] = [];
  const add = (kind: BuyerVenusStep["kind"], to: Address, data: Hex, gas: bigint) => steps.push({ kind, to, data, value: "0x0", nonce: snapshot.nonce + steps.length, gas: gas.toString(), gasPrice: gasPrice.toString() });
  if (snapshot.allowance !== amount) {
    if (snapshot.allowance > 0n) add("RESET_APPROVAL", source.market.token, encodeFunctionData({ abi: BUYER_TOKEN_ABI, functionName: "approve", args: [source.market.market, 0n] }), 100_000n);
    add("APPROVE", source.market.token, encodeFunctionData({ abi: BUYER_TOKEN_ABI, functionName: "approve", args: [source.market.market, amount] }), 100_000n);
  }
  add("SUPPLY", source.market.market, encodeFunctionData({ abi: BUYER_VTOKEN_ABI, functionName: "mint", args: [amount] }), 500_000n);
  const maxFee = steps.reduce((sum, step) => sum + BigInt(step.gas) * gasPrice, 0n);
  const exitGas = 500_000n * gasPrice;
  const ceil = (value: bigint, denominator: bigint) => (value + denominator - 1n) / denominator;
  const maxFeeUsd = ceil(maxFee * snapshot.bnbPrice, FIXED_SCALE);
  const exitGasUsd = ceil(exitGas * snapshot.bnbPrice, FIXED_SCALE);
  // Recalculate the actual funded principal's return independently. Use the
  // lower of the provider's observed rate and the newly observed rate.
  const actualUsd = amount * snapshot.tokenPrice / FIXED_SCALE;
  const apy = Math.min(source.opportunity.grossApyBps, snapshot.currentApyBps);
  requireBuyer(Number.isSafeInteger(apy) && apy >= 0, "Current yield evidence is unavailable.");
  const grossBenefit = actualUsd * BigInt(apy) * BigInt(source.request.constraints.evaluationHorizonDays) / (10_000n * 365n);
  const protocolExitFee = ceil((actualUsd + grossBenefit) * snapshot.treasuryPercent, FIXED_SCALE);
  const roundTripCost = maxFeeUsd + exitGasUsd + protocolExitFee;
  const netBenefit = grossBenefit - roundTripCost;
  const costLimit = minimum([parseFixed(source.request.maxGasUsd), parseFixed(source.request.maxActionUsd), parseFixed(source.request.maxExecutionCostUsd ?? source.request.maxGasUsd)]);
  requireBuyer(roundTripCost <= costLimit, "Approval, supply and estimated withdrawal costs exceed your execution-cost limit.");
  requireBuyer(netBenefit >= parseFixed(source.request.constraints.minimumNetBenefitUsd), "HOLD: the projected benefit after approval, supply and withdrawal costs is below your required minimum.");
  requireBuyer(actualUsd + roundTripCost <= parseFixed(source.request.capitalUsd), "The exact recommendation leaves insufficient managed capital for round-trip costs. Request a new allocation; the amount will not be silently reduced.");
  requireBuyer(actualUsd * 10_000n <= (parseFixed(source.request.capitalUsd) - roundTripCost) * BigInt(source.request.constraints.maximumProtocolConcentrationBps), "Round-trip costs put the recommended allocation above the protocol concentration limit.");
  requireBuyer(snapshot.nativeBalance >= maxFee + exitGas, "The connected wallet needs native BNB for approval and supply, plus a reserve for estimated withdrawal gas.");
  requireBuyer(snapshot.cash * snapshot.tokenPrice / FIXED_SCALE >= parseFixed(source.request.constraints.minimumLiquidityUsd), "Current Venus cash is below the buyer's liquidity requirement.");
  requireBuyer(snapshot.supplyCap === 0n || snapshot.totalSupply * snapshot.exchangeRate / FIXED_SCALE + amount < snapshot.supplyCap, "The Venus supply cap cannot accommodate this deposit.");
  return BuyerVenusIntentSchema.parse({
    schemaVersion: "positioncrew.buyer-venus-intent.v1", chainId: 56, operation: "SUPPLY",
    sourceReceiptId: chain.receipt!.receiptId, sourceRequestHash: chain.hire.requestHash,
    account, token: source.market.token, market: source.market.market, symbol: source.market.symbol,
    tokenDecimals: 18, vTokenDecimals: 8, amountRaw: amount.toString(), amountUsd: formatFixed(amount * snapshot.tokenPrice / FIXED_SCALE, 8),
    maxGasCostWei: maxFee.toString(), expectedWithdrawalGasWei: exitGas.toString(),
    expectedProtocolExitFeeUsd: formatFixed(protocolExitFee, 8), projectedNetBenefitUsd: formatFixed(netBenefit, 8), projectedGrossBenefitUsd: formatFixed(grossBenefit, 8),
    estimatedSharesRaw: (amount * FIXED_SCALE / snapshot.exchangeRate).toString(), treasuryPercent: snapshot.treasuryPercent.toString(),
    expiryMeaning: "PRE_SIGN_CHECK_ONLY_NOT_ONCHAIN_DEADLINE", createdAt: now.toISOString(),
    expiresAt: new Date(Math.min(Date.parse(source.request.deadline), Date.parse(source.result.expiresAt))).toISOString(),
    blockNumber: snapshot.blockNumber.toString(), blockHash: snapshot.blockHash,
    walletTokenBalanceRaw: snapshot.tokenBalance.toString(), walletVTokenBalanceRaw: snapshot.vTokenBalance.toString(), sourceSupplyHash: null, steps,
  });
}
