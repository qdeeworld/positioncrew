import { describe, expect, it } from "vitest";
import { YieldOptimizationRequestSchema } from "../src/contracts/yield-optimization.js";
import {
  assessHeyAnonBeefyForYieldRequest,
  fetchHeyAnonBeefyVaults,
  type HeyAnonBeefyVault,
} from "../src/marketplace/heyanon-beefy-adapter.js";

const request = YieldOptimizationRequestSchema.parse({
  schemaVersion: "positioncrew.yield-optimization.request.v1",
  service: "YIELD_OPTIMIZATION",
  requestId: "beefy-live-audition-001",
  chainId: 56,
  account: "0x1111111111111111111111111111111111111111",
  protocol: "BSC Yield Router",
  requestedAt: "2026-08-30T08:00:00.000Z",
  deadline: "2026-08-30T08:05:00.000Z",
  maxDataAgeSeconds: 300,
  maxActionUsd: "20",
  maxGasUsd: "5",
  maxSlippageBps: 30,
  sources: [{
    sourceId: "positioncrew-live-yield",
    label: "PositionCrew current BSC yield observation",
    uri: "https://bscscan.com/block/118938587",
    observedAt: "2026-08-30T08:00:00.000Z",
  }],
  capitalUsd: "1000",
  currentPositions: [],
  opportunities: [{
    opportunityId: "pancake-cow-bsc-usdt-wbnb-vault",
    protocol: "Beefy",
    vaultOrMarket: "0x39D16B4B83C43207668De708E55ecc721cC27990",
    asset: {
      symbol: "USDT",
      address: "0x55d398326f99059fF775485246999027B3197955",
      decimals: 18,
    },
    amountUsd: "1000",
    grossApyBps: 250,
    liquidityUsd: "100000",
    lockupSeconds: 0,
    estimatedEntryCostUsd: "1",
    estimatedExitCostUsd: "1",
    riskTier: "MEDIUM",
    observedAt: "2026-08-30T08:00:00.000Z",
    sourceId: "positioncrew-live-yield",
  }],
  constraints: {
    protocolAllowlist: ["Beefy"],
    maximumRiskTier: "MEDIUM",
    maximumProtocolConcentrationBps: 10_000,
    maximumLockupSeconds: 0,
    minimumLiquidityUsd: "100000",
    minimumNetBenefitUsd: "5",
    evaluationHorizonDays: 90,
  },
});

const vault: HeyAnonBeefyVault = {
  id: "pancake-cow-bsc-usdt-wbnb-vault",
  name: "WBNB-USDT",
  chain: "bsc",
  tokenProviderId: "pancakeswap",
  platform: "pancakeswap",
  token: "WBNB-USDT",
  tokenAddress: "0x39D16B4B83C43207668De708E55ecc721cC27990",
  tvl: 105123.01999695963,
  poolTvl: 10476305.458126044,
  apy: 0.02569175997279527,
};

describe("HeyAnon Beefy yield adapter", () => {
  it("binds attributable APY and liquidity without promoting missing safety evidence", () => {
    const assessment = assessHeyAnonBeefyForYieldRequest(request, [vault]);
    expect(assessment.matches).toHaveLength(1);
    expect(assessment.matches[0]?.providerGrossApyBps).toBe(257);
    expect(assessment.checks.find((check) => check.code === "OPPORTUNITY_IDENTITY_COVERAGE")?.status).toBe("PASS");
    expect(assessment.checks.find((check) => check.code === "OBSERVATION_ATTRIBUTION")?.status).toBe("FAIL");
    expect(assessment.eligibleForYieldOptimization).toBe(false);
  });

  it("rejects provider fields outside the exact external response contract", async () => {
    const response = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{
          type: "text",
          text: JSON.stringify({
            project: "beefy",
            operation: "getVaultsWithTokens",
            data: [{ chain: "bsc", token: "USDT", vaults: [{ ...vault, inventedRiskTier: "LOW" }] }],
          }),
        }],
      },
    };
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify(response), { status: 200 });
    await expect(fetchHeyAnonBeefyVaults(["USDT"], fetchImpl)).rejects.toThrow();
  });
});
