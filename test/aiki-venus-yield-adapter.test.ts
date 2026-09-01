import { describe, expect, it, vi } from "vitest";

import type { YieldOptimizationDeliverable, YieldOptimizationRequest } from "../src/contracts/yield-optimization.js";
import { auditionAiKiVenusYield } from "../src/marketplace/aiki-venus-yield-adapter.js";

const markets = [
  "0xfD5840Cd36d94D7229439859C0112a4185BC0255",
  "0xC4eF4229FEc74Ccfe17B2bdeF7715fAC740BA0ba",
];
const request = {
  opportunities: markets.map((vaultOrMarket, index) => ({
    opportunityId: index === 0 ? "venus-core-usdt-supply" : "venus-core-fdusd-supply",
    vaultOrMarket,
    grossApyBps: index === 0 ? 263 : 261,
  })),
} as unknown as YieldOptimizationRequest;
const firstParty = {
  selectedOpportunityId: "venus-core-fdusd-supply",
  grossApyBps: 261,
} as YieldOptimizationDeliverable;

describe("AiKi Venus Yield adapter", () => {
  it("records agreement on the rate leader without claiming full optimisation", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("markets")).toBe(markets.join(","));
      expect(url.searchParams.get("rateOnly")).toBe("true");
      return new Response(JSON.stringify({
        assessment: {
          category: "yield_optimisation",
          assessmentVersion: "venus-yield/v1",
          routes: [
            { market: markets[0], symbol: "vUSDT", supplyRatePerBlock: "376473318", simpleAnnualRateBps: "263" },
            { market: markets[1], symbol: "vFDUSD", supplyRatePerBlock: "373214201", simpleAnnualRateBps: "261" },
          ],
          recommendedMarket: markets[0],
          recommendation: "RATE_ONLY_CANDIDATE",
          observedAt: "2026-08-30T12:55:27.556Z",
          caveats: ["Rate-only mode is not an optimisation recommendation."],
        },
        evidence: { persisted: true },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const result = await auditionAiKiVenusYield(request, firstParty, { fetchImpl: fetchImpl as typeof fetch });
    expect(result.outcome).toBe("PARTIAL_COMPATIBILITY");
    expect(result.sameRateLeader).toBe(true);
    expect(result.rateDifferenceBps).toBe(0);
    expect(result.positionCrewSelectedMarket).toBe(markets[0]);
    expect(result.eligibleForRateRankingActivation).toBe(true);
    expect(result.eligibleForLiveMatch).toBe(false);
  });

  it("rejects a lower-rate recommendation even when the market set matches", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      assessment: {
        category: "yield_optimisation",
        assessmentVersion: "venus-yield/v1",
        routes: [
          { market: markets[0], symbol: "vUSDT", supplyRatePerBlock: "376473318", simpleAnnualRateBps: "263" },
          { market: markets[1], symbol: "vFDUSD", supplyRatePerBlock: "373214201", simpleAnnualRateBps: "261" },
        ],
        recommendedMarket: markets[1],
        recommendation: "RATE_ONLY_CANDIDATE",
        observedAt: "2026-08-30T12:55:27.556Z",
        caveats: ["Rate only."],
      },
      evidence: { persisted: true },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await auditionAiKiVenusYield(request, firstParty, { fetchImpl: fetchImpl as typeof fetch });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.sameRateLeader).toBe(false);
    expect(result.eligibleForRateRankingActivation).toBe(false);
  });

  it("fails closed when the provider returns a different market set", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      assessment: {
        category: "yield_optimisation",
        assessmentVersion: "venus-yield/v1",
        routes: [{ market: markets[0], symbol: "vUSDT", supplyRatePerBlock: "1", simpleAnnualRateBps: "263" }],
        recommendedMarket: markets[0],
        recommendation: "RATE_ONLY_CANDIDATE",
        observedAt: "2026-08-30T12:55:27.556Z",
        caveats: ["Rate only."],
      },
      evidence: { persisted: true },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await auditionAiKiVenusYield(request, firstParty, { fetchImpl: fetchImpl as typeof fetch });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.eligibleForLiveMatch).toBe(false);
  });
});
