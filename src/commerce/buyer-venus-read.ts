import { createPublicClient, fallback, http, type Address, type PublicClient } from "viem";
import { annualizedYieldBps } from "../telemetry/bsc.js";
import {
  BUYER_COMPTROLLER_ABI, BUYER_ORACLE_ABI, BUYER_TOKEN_ABI, BUYER_VTOKEN_ABI,
  VENUS_BUYER_COMPTROLLER, VENUS_BUYER_MARKETS, VENUS_BUYER_VBNB,
  requireBuyer, type BuyerVenusSnapshot,
} from "./buyer-venus-policy.js";

// This module creates no wallet client and never signs or broadcasts. The URL
// is server configuration, never a caller-controlled execution destination.
export function buyerVenusPublicClient(rpcUrl?: string): PublicClient {
  const options = { timeout: 10_000, retryCount: 0 };
  return createPublicClient({ transport: rpcUrl ? http(rpcUrl, options) : fallback([
    http("https://bsc-dataseed-public.bnbchain.org", options),
    http("https://bsc-dataseed.bnbchain.org", options),
  ], { retryCount: 0 }) });
}
export type BuyerVenusPublicClient = PublicClient;

export async function readBuyerVenusSnapshot(client: BuyerVenusPublicClient, account: Address): Promise<BuyerVenusSnapshot> {
  const market = VENUS_BUYER_MARKETS[0];
  const [chainId, block] = await Promise.all([client.getChainId(), client.getBlock()]);
  requireBuyer(block.number !== null && block.hash !== null, "The latest BSC block is unavailable.");
  const blockNumber = block.number;
  const v = { address: market.market, abi: BUYER_VTOKEN_ABI, blockNumber } as const;
  const t = { address: market.token, abi: BUYER_TOKEN_ABI, blockNumber } as const;
  const c = { address: VENUS_BUYER_COMPTROLLER, abi: BUYER_COMPTROLLER_ABI, blockNumber } as const;
  const [underlying, comptroller, implementation, isVToken, tokenDecimals, vTokenDecimals,
    tokenBalance, vTokenBalance, allowance, nativeBalance, gasPrice, assetsIn, liquidity,
    treasuryPercent, listing, mintPaused, redeemPaused, supplyCap, exchangeRate, cash,
    totalSupply, supplyRate, oracle, nonce, pendingNonce, baseline] = await Promise.all([
    client.readContract({ ...v, functionName: "underlying" }),
    client.readContract({ ...v, functionName: "comptroller" }),
    client.readContract({ ...v, functionName: "implementation" }),
    client.readContract({ ...v, functionName: "isVToken" }),
    client.readContract({ ...t, functionName: "decimals" }),
    client.readContract({ ...v, functionName: "decimals" }),
    client.readContract({ ...t, functionName: "balanceOf", args: [account] }),
    client.readContract({ ...v, functionName: "balanceOf", args: [account] }),
    client.readContract({ ...t, functionName: "allowance", args: [account, market.market] }),
    client.getBalance({ address: account, blockNumber }), client.getGasPrice(),
    client.readContract({ ...c, functionName: "getAssetsIn", args: [account] }),
    client.readContract({ ...c, functionName: "getAccountLiquidity", args: [account] }),
    client.readContract({ ...c, functionName: "treasuryPercent" }),
    client.readContract({ ...c, functionName: "markets", args: [market.market] }),
    client.readContract({ ...c, functionName: "actionPaused", args: [market.market, 0] }),
    client.readContract({ ...c, functionName: "actionPaused", args: [market.market, 1] }),
    client.readContract({ ...c, functionName: "supplyCaps", args: [market.market] }),
    client.simulateContract({ ...v, functionName: "exchangeRateCurrent" }).then(result => result.result),
    client.readContract({ ...v, functionName: "getCash" }),
    client.readContract({ ...v, functionName: "totalSupply" }),
    client.readContract({ ...v, functionName: "supplyRatePerBlock" }),
    client.readContract({ ...c, functionName: "oracle" }),
    client.getTransactionCount({ address: account, blockTag: "latest" }),
    client.getTransactionCount({ address: account, blockTag: "pending" }),
    client.getBlock({ blockNumber: blockNumber - 120n }),
  ]);
  const [tokenPrice, bnbPrice] = await Promise.all([
    client.readContract({ address: oracle, abi: BUYER_ORACLE_ABI, functionName: "getUnderlyingPrice", args: [market.market], blockNumber }),
    client.readContract({ address: oracle, abi: BUYER_ORACLE_ABI, functionName: "getUnderlyingPrice", args: [VENUS_BUYER_VBNB], blockNumber }),
  ]);
  const canonical = await client.getBlock({ blockNumber });
  requireBuyer(canonical.hash === block.hash, "BSC changed the observed block; refresh before preparing a transaction.");
  const secondsPerBlock = Number(block.timestamp - baseline.timestamp) / 120;
  requireBuyer(secondsPerBlock > 0, "The observed Venus rate time basis is unavailable.");
  return { chainId, blockNumber, blockHash: block.hash, timestamp: block.timestamp,
    underlying, comptroller, implementation, isVToken, tokenDecimals, vTokenDecimals,
    tokenBalance, vTokenBalance, allowance, nativeBalance, gasPrice, assetsIn,
    liquidityError: liquidity[0], shortfall: liquidity[2], treasuryPercent, listed: listing[0],
    mintPaused, redeemPaused, supplyCap, exchangeRate, cash, totalSupply, tokenPrice, bnbPrice,
    nonce, pendingNonce, currentApyBps: annualizedYieldBps(supplyRate, secondsPerBlock) };
}

export async function simulateBuyerStep(client: BuyerVenusPublicClient, intent: {
  account: string; steps: Array<{ to: string; data: string; value: string; gas: string; gasPrice: string }>;
}, stepIndex: number): Promise<void> {
  const step = intent.steps[stepIndex];
  requireBuyer(step, "Unknown transaction step.");
  const result = await client.call({ account: intent.account as Address, to: step.to as Address,
    data: step.data as `0x${string}`, value: BigInt(step.value), gas: BigInt(step.gas), gasPrice: BigInt(step.gasPrice) });
  const isApproval = step.to.toLowerCase() === VENUS_BUYER_MARKETS[0].token.toLowerCase();
  requireBuyer(result.data !== undefined && result.data.length === 66, "The simulation returned an unexpected result.");
  requireBuyer(BigInt(result.data) === (isApproval ? 1n : 0n), "The protocol simulation refused this transaction.");
}
