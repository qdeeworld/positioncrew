import { describe, expect, it, vi } from "vitest";

import type { YieldOptimizationRequest } from "../src/contracts/yield-optimization.js";
import { auditionAiKiVenusYield } from "../src/marketplace/aiki-venus-yield-adapter.js";
import { createYieldOptimizationDeliverable } from "../src/providers/yield-optimization.js";

const markets = [
  "0xfD5840Cd36d94D7229439859C0112a4185BC0255",
  "0xC4eF4229FEc74Ccfe17B2bdeF7715fAC740BA0ba",
];
const rates = ["2470000000", "2450000000"];
const now = new Date("2026-09-01T13:00:30.000Z");
const observedAt = "2026-09-01T13:00:00.000Z";
const sourceId = "venus-yield-mainnet-block-119000000";
const request: YieldOptimizationRequest = {
  schemaVersion: "positioncrew.yield-optimization.request.v1",
  service: "YIELD_OPTIMIZATION",
  requestId: "venus-yield-119000000",
  chainId: 56,
  account: "0x1111111111111111111111111111111111111111",
  protocol: "Venus Core Pool stablecoin supply",
  requestedAt: "2026-09-01T13:00:10.000Z",
  deadline: "2026-09-01T13:05:10.000Z",
  maxDataAgeSeconds: 300,
  maxActionUsd: "20",
  maxGasUsd: "5",
  maxSlippageBps: 30,
  sources: [{ sourceId, label: "Pinned Venus rates", uri: "https://bscscan.com/block/119000000", observedAt }],
  capitalUsd: "1000",
  currentPositions: [],
  opportunities: markets.map((vaultOrMarket, index) => ({
    opportunityId: index === 0 ? "venus-core-usdt-supply" : "venus-core-fdusd-supply",
    protocol: "Venus Core Pool",
    vaultOrMarket,
    asset: { symbol: index === 0 ? "USDT" : "FDUSD", address: index === 0 ? "0x55d398326f99059fF775485246999027B3197955" : "0xc5f0f7B66764F6EC8C8Dff7ba683102295E16409", decimals: 18 },
    amountUsd: "1000",
    grossApyBps: index === 0 ? 263 : 261,
    liquidityUsd: "10000000",
    lockupSeconds: 0,
    estimatedEntryCostUsd: "0.1",
    estimatedExitCostUsd: "0",
    riskTier: "MEDIUM" as const,
    observedAt,
    sourceId,
  })),
  constraints: {
    protocolAllowlist: ["Venus Core Pool"],
    maximumRiskTier: "MEDIUM",
    maximumProtocolConcentrationBps: 10_000,
    maximumLockupSeconds: 0,
    minimumLiquidityUsd: "1000000",
    minimumNetBenefitUsd: "1",
    evaluationHorizonDays: 365,
  },
};

function rpcResult(value: string, id: number): Response {
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: `0x${BigInt(value).toString(16).padStart(64, "0")}`,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function rpcBlock(timestamp: bigint, id: number, blockNumber: string): Response {
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: { number: blockNumber, timestamp: `0x${timestamp.toString(16)}` },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function providerResponse(recommendedMarket = markets[0], returnedMarkets = markets, responseObservedAt = observedAt) {
  return {
    assessment: {
      category: "yield_optimisation",
      assessmentVersion: "venus-yield/v1",
      routes: returnedMarkets.map((market) => {
        const index = markets.indexOf(market);
        return {
          market,
          symbol: index === 0 ? "vUSDT" : "vFDUSD",
          supplyRatePerBlock: rates[index] ?? "1",
          simpleAnnualRateBps: index === 0 ? "263" : "261",
        };
      }),
      recommendedMarket,
      recommendation: "RATE_ONLY_CANDIDATE",
      observedAt: responseObservedAt,
      caveats: ["Rate-only mode is not an optimisation recommendation."],
    },
    evidence: { persisted: true },
  };
}

function fetcher(response = providerResponse(), pinnedRates = rates) {
  return vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://rpc.test") {
      const payload = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
      if (payload.method === "eth_getBlockByNumber") {
        const blockNumber = String(payload.params[0]);
        return rpcBlock(blockNumber === "0x717cbc0" ? 1_000_000n : 999_640n, payload.id, blockNumber);
      }
      const call = payload.params[0] as { to: string };
      const marketIndex = markets.findIndex((market) => market.toLowerCase() === call.to.toLowerCase());
      return rpcResult(pinnedRates[marketIndex] ?? "1", payload.id);
    }
    const parsed = new URL(url);
    expect(parsed.searchParams.get("markets")).toBe(markets.join(","));
    expect(parsed.searchParams.get("rateOnly")).toBe("true");
    return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
  });
}

describe("AiKi Venus Yield adapter", () => {
  it("normalizes a pinned, attributable rate thesis into a complete eligible Yield result", async () => {
    const firstParty = createYieldOptimizationDeliverable(request, now);
    const result = await auditionAiKiVenusYield(request, firstParty, {
      fetchImpl: fetcher() as typeof fetch,
      now,
      rpcUrl: "https://rpc.test",
    });
    expect(result.outcome).toBe("SEMANTICALLY_COMPARABLE");
    expect(result.eligibleForYieldSelection).toBe(true);
    expect(result.eligibleForLiveMatch).toBe(true);
    expect(result.normalizedDeliverable?.schemaVersion).toBe("positioncrew.yield-optimization.deliverable.v1");
    expect(result.selection?.selectedProvider).toBe("POSITIONCREW");
    expect(result.checks.every((check) => check.status === "PASS")).toBe(true);
  });

  it("fails closed when a provider rate does not match the pinned Venus block", async () => {
    const firstParty = createYieldOptimizationDeliverable(request, now);
    const result = await auditionAiKiVenusYield(request, firstParty, {
      fetchImpl: fetcher(providerResponse(), [rates[0]!, "1"]) as typeof fetch,
      now,
      rpcUrl: "https://rpc.test",
    });
    expect(result.outcome).toBe("PARTIAL_COMPATIBILITY");
    expect(result.eligibleForLiveMatch).toBe(false);
    expect(result.checks.find((check) => check.code === "PINNED_RATE_BINDING")?.status).toBe("FAIL");
  });

  it("rejects a different rate leader even when the market set matches", async () => {
    const firstParty = createYieldOptimizationDeliverable(request, now);
    const result = await auditionAiKiVenusYield(request, firstParty, {
      fetchImpl: fetcher(providerResponse(markets[1]!)) as typeof fetch,
      now,
      rpcUrl: "https://rpc.test",
    });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.eligibleForLiveMatch).toBe(false);
  });

  it("rejects a stale request leader when the independently pinned rates rank another market first", async () => {
    const response = providerResponse();
    response.assessment.routes[0]!.supplyRatePerBlock = rates[1]!;
    response.assessment.routes[1]!.supplyRatePerBlock = rates[0]!;
    const firstParty = createYieldOptimizationDeliverable(request, now);
    const result = await auditionAiKiVenusYield(request, firstParty, {
      fetchImpl: fetcher(response, [rates[1]!, rates[0]!]) as typeof fetch,
      now,
      rpcUrl: "https://rpc.test",
    });
    expect(result.outcome).toBe("PARTIAL_COMPATIBILITY");
    expect(result.eligibleForLiveMatch).toBe(false);
    expect(result.checks.find((check) => check.code === "PINNED_RATE_BINDING")?.status).toBe("PASS");
    expect(result.checks.find((check) => check.code === "PINNED_RATE_LEADER")?.status).toBe("FAIL");
  });

  it("rejects inflated caller APY even when the provider and pinned rate leader agree", async () => {
    const inflated = structuredClone(request);
    inflated.opportunities[0]!.grossApyBps = 500;
    inflated.opportunities[1]!.grossApyBps = 400;
    const firstParty = createYieldOptimizationDeliverable(inflated, now);
    const result = await auditionAiKiVenusYield(inflated, firstParty, {
      fetchImpl: fetcher() as typeof fetch,
      now,
      rpcUrl: "https://rpc.test",
    });
    expect(result.outcome).toBe("PARTIAL_COMPATIBILITY");
    expect(result.eligibleForLiveMatch).toBe(false);
    expect(result.checks.find((check) => check.code === "PINNED_APY_BINDING")?.status).toBe("FAIL");
  });

  it("fails closed when the provider returns a different market set", async () => {
    const firstParty = createYieldOptimizationDeliverable(request, now);
    const result = await auditionAiKiVenusYield(request, firstParty, {
      fetchImpl: fetcher(providerResponse(markets[0]!, [markets[0]!])) as typeof fetch,
      now,
      rpcUrl: "https://rpc.test",
    });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.eligibleForLiveMatch).toBe(false);
  });
});
