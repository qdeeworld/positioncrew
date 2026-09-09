import { YieldOptimizationRequestSchema } from "../src/contracts/yield-optimization.js";
import { createYieldOptimizationDeliverable } from "../src/providers/yield-optimization.js";
import { parseFixed } from "../src/core/fixed.js";
import type { FreshMarketplaceChain } from "../src/commerce/fresh-hire-schema.js";
import { VENUS_BUYER_COMPTROLLER, VENUS_BUYER_IMPLEMENTATION, VENUS_BUYER_MARKETS, type BuyerVenusSnapshot } from "../src/commerce/buyer-venus-policy.js";
const now = new Date("2026-09-09T07:00:10Z");
const account = "0x1111111111111111111111111111111111111111";
const market = VENUS_BUYER_MARKETS[0];
const hash = `0x${"a".repeat(64)}` as const;
export function buyerVenusFixture() {
  const request = YieldOptimizationRequestSchema.parse({
    schemaVersion: "positioncrew.yield-optimization.request.v1", service: "YIELD_OPTIMIZATION",
    requestId: "buyer-venus-policy-test", chainId: 56, account, protocol: "Venus Core Pool stablecoin supply",
    requestedAt: "2026-09-09T07:00:00Z", deadline: "2026-09-09T07:02:00Z", maxDataAgeSeconds: 120,
    maxActionUsd: "900", maxAllocationUsd: "900", maxExecutionCostUsd: "2", maxGasUsd: "2",
    maxSlippageBps: 0, capitalUsd: "1000", currentPositions: [],
    sources: [{ sourceId: "synthetic", label: "Synthetic policy test", uri: "https://example.com/synthetic", observedAt: "2026-09-09T07:00:00Z" }],
    opportunities: [{ opportunityId: "venus-usdt", protocol: "Venus Core Pool", vaultOrMarket: market.market,
      asset: { symbol: "USDT", address: market.token, decimals: 18 }, amountUsd: "1000", grossApyBps: 500,
      liquidityUsd: "1000000", lockupSeconds: 0, estimatedEntryCostUsd: "0.02", estimatedExitCostUsd: "0.02",
      riskTier: "MEDIUM", observedAt: "2026-09-09T07:00:00Z", sourceId: "synthetic" }],
    constraints: { protocolAllowlist: ["Venus Core Pool"], maximumRiskTier: "MEDIUM", maximumProtocolConcentrationBps: 10000,
      maximumLockupSeconds: 0, minimumLiquidityUsd: "100000", minimumNetBenefitUsd: "1", evaluationHorizonDays: 90 },
  });
  const result = createYieldOptimizationDeliverable(request, now);
  const chain = { hire: { service: "YIELD_OPTIMIZATION", evidenceMode: "CURRENT_BLOCK_PINNED",
    providerId: "positioncrew:provider:yield-optimization:v1", request, requestHash: `sha256:${"b".repeat(64)}` },
  job: { state: "COMPLETED", providerSelection: null },
  receipt: { receiptId: "11111111-1111-4111-8111-111111111111", response: { result: { deliverable: result, evaluation: { passed: true } } } } } as unknown as FreshMarketplaceChain;
  const snapshot: BuyerVenusSnapshot = { chainId: 56, blockNumber: 123n, blockHash: hash,
    timestamp: BigInt(now.getTime() / 1000), underlying: market.token, comptroller: VENUS_BUYER_COMPTROLLER,
    implementation: VENUS_BUYER_IMPLEMENTATION, isVToken: true, tokenDecimals: 18, vTokenDecimals: 8,
    tokenBalance: parseFixed("1000"), vTokenBalance: 0n, allowance: 0n, nativeBalance: parseFixed("1"), gasPrice: 50_000_000n,
    tokenPrice: parseFixed("1"), bnbPrice: parseFixed("750"), assetsIn: [], liquidityError: 0n, shortfall: 0n, nonce: 7,
    listed: true, mintPaused: false, redeemPaused: false, treasuryPercent: 0n, exchangeRate: 250_000_000_000_000_000_000_000_000n,
    cash: parseFixed("1000000"), totalSupply: 1_000_000n, supplyCap: 0n, currentApyBps: 500 };
  return { chain, snapshot, request, result };
}
