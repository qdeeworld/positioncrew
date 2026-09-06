import { describe, expect, it } from "vitest";
import type { LpRebalanceRequest } from "../src/contracts/lp-rebalance.js";
import { createLpRebalanceDeliverable } from "../src/providers/lp-rebalance.js";

const observedAt = "2026-09-06T00:00:00.000Z";
const now = new Date("2026-09-06T00:00:10.000Z");

function requestFixture(): LpRebalanceRequest {
  return {
    schemaVersion: "positioncrew.lp-rebalance.request.v1",
    service: "LP_REBALANCE",
    requestId: "lp-forecast-assumptions-test",
    chainId: 56,
    account: "0x1111111111111111111111111111111111111111",
    protocol: "PancakeSwap V3",
    requestedAt: observedAt,
    deadline: "2026-09-06T00:05:00.000Z",
    maxDataAgeSeconds: 300,
    maxActionUsd: "10",
    maxGasUsd: "1",
    maxSlippageBps: 30,
    sources: [{
      sourceId: "lp-forecast-test-source",
      label: "Synthetic LP forecast inputs",
      uri: "https://example.com/lp-forecast-test",
      observedAt,
    }],
    pool: "0x2222222222222222222222222222222222222222",
    token0: {
      symbol: "TOKEN0",
      address: "0x3333333333333333333333333333333333333333",
      decimals: 18,
    },
    token1: {
      symbol: "TOKEN1",
      address: "0x4444444444444444444444444444444444444444",
      decimals: 18,
    },
    position: {
      lowerTick: -100,
      upperTick: 100,
      liquidity: "1000000000000000000",
      positionValueUsd: "10000",
      feesEarnedUsd: "0",
      token0ShareBps: 5000,
      token1ShareBps: 5000,
    },
    marketState: {
      currentTick: 0,
      token0PriceUsd: "1",
      token1PriceUsd: "1",
      volume24hUsd: "4800000",
      fees24hUsd: "2400",
      poolLiquidityUsd: "1000000",
      realizedVolatilityBps: 400,
      volumeMeasurementWindowSeconds: 3600,
      volumeNormalizationFactor: "24",
      swapCount: 50,
      observedAt,
      sourceId: "lp-forecast-test-source",
    },
    constraints: {
      minimumWidthTicks: 100,
      maximumWidthTicks: 1000,
      tickSpacing: 10,
      edgeBufferBps: 1000,
      highVolatilityBps: 1000,
      maximumToken0ShareBps: 10000,
      maximumToken1ShareBps: 10000,
      minimumNetBenefitUsd: "0.01",
      estimatedGasUsd: "0.1",
      estimatedSwapCostUsd: "0.2",
      evaluationHorizonHours: 24,
    },
  };
}

describe("LP forecast assumptions", () => {
  it.each([6, 12, 24, 48])(
    "discloses the 90% HOLD multiplier and independently reproduces a %i-hour projection",
    (hours) => {
      const request = requestFixture();
      request.constraints.evaluationHorizonHours = hours;
      const original = structuredClone(request);
      const result = createLpRebalanceDeliverable(request, now);

      // Plain arithmetic from the synthetic request, with an independently
      // specified 90% policy assumption; no production math/evaluator helpers.
      const expectedFees = 2400 * (10000 / 1000000) * (hours / 24) * 0.9;
      expect(result.status).toBe("NO_ACTION");
      expect(result.decision).toBe("HOLD");
      expect(Number(result.expectedGrossFeesUsd)).toBeCloseTo(expectedFees, 8);
      expect(result.expectedNetBenefitUsd).toBe("0");
      expect(result.estimatedRebalanceCostUsd).toBe("0");
      expect(request).toEqual(original);

      const disclosure = result.limitations.join("\n");
      expect(disclosure).toContain("feeBase = fees24hUsd * (positionValueUsd / poolLiquidityUsd) * (evaluationHorizonHours / 24)");
      expect(disclosure).toContain("Current gross fees = feeBase * 9000/10000");
      expect(disclosure).toContain("90% fee-uptime multiplier is a policy assumption");
      expect(disclosure).toContain(`The ${hours}-hour projection`);
      expect(disclosure).toContain("linear accrual and no compounding");
      expect(disclosure).toContain("3600 seconds and 50 onchain swaps");
      expect(disclosure).toContain("volumeNormalizationFactor is provenance and is not applied a second time");
      expect(disclosure).toContain("HOLD reports modeled fees for the existing range");
      expect(disclosure).toContain("Fixed-point products and quotients truncate at 18 decimal places");
    },
  );

  it.each([
    { name: "out-of-range shift", tick: 150, volatility: 400, minimumWidth: 200, maximumWidth: 200, decision: "SHIFT", currentUptime: 0, proposedUptime: 9500 },
    { name: "near-edge shift", tick: -95, volatility: 400, minimumWidth: 200, maximumWidth: 200, decision: "SHIFT", currentUptime: 3500, proposedUptime: 9500 },
    { name: "high-volatility widening", tick: 0, volatility: 1200, minimumWidth: 100, maximumWidth: 1000, decision: "WIDEN", currentUptime: 5500, proposedUptime: 9500 },
    { name: "low-volatility narrowing", tick: 0, volatility: 100, minimumWidth: 50, maximumWidth: 1000, decision: "NARROW", currentUptime: 9000, proposedUptime: 7500 },
  ])("reproduces and discloses $name economics", (scenario) => {
    const request = requestFixture();
    request.marketState.currentTick = scenario.tick;
    request.marketState.realizedVolatilityBps = scenario.volatility;
    request.constraints.minimumWidthTicks = scenario.minimumWidth;
    request.constraints.maximumWidthTicks = scenario.maximumWidth;
    const result = createLpRebalanceDeliverable(request, now);

    expect(result.status).toBe("ACTIONABLE");
    expect(result.decision).toBe(scenario.decision);
    expect(result.proposedRange).not.toBeNull();
    if (!result.proposedRange) throw new Error("Expected an actionable range");

    // Reconstruct economics from the request and the returned range, rather
    // than asking the generator or its conformance evaluator for an answer.
    const originalWidth = 200;
    const proposedWidth = result.proposedRange.upperTick - result.proposedRange.lowerTick;
    const feeBase = 2400 * (10000 / 1000000) * (24 / 24);
    const currentFees = feeBase * (scenario.currentUptime / 10000);
    const proposedFees = feeBase * (originalWidth / proposedWidth) * (scenario.proposedUptime / 10000);
    const incrementalFees = proposedFees - currentFees;
    const cost = 0.1 + 0.2;
    const netBenefit = Math.max(0, incrementalFees - cost);
    const breakEvenHours = (cost * 24) / incrementalFees;

    expect(Number(result.expectedGrossFeesUsd)).toBeCloseTo(proposedFees, 8);
    expect(Number(result.estimatedRebalanceCostUsd)).toBeCloseTo(cost, 8);
    expect(Number(result.expectedNetBenefitUsd)).toBeCloseTo(netBenefit, 8);
    expect(Number(result.breakEvenHours)).toBeCloseTo(breakEvenHours, 8);
    expect(result.feeProjection).toEqual({
      model: "POOL_SHARE_UPTIME_V1",
      currentUptimeBps: scenario.currentUptime,
      proposedUptimeBps: scenario.proposedUptime,
    });

    const disclosure = result.limitations.join("\n");
    expect(disclosure).toContain(`Current gross fees = feeBase * ${scenario.currentUptime}/10000`);
    expect(disclosure).toContain(`Candidate gross fees = feeBase * (${originalWidth}/${proposedWidth}) * ${scenario.proposedUptime}/10000`);
    expect(disclosure).toContain("35% near an edge, 55% at high volatility, otherwise 90%");
    expect(disclosure).toContain("75% for NARROW and 95% for SHIFT or WIDEN");
    expect(disclosure).toContain("Rebalance cost = estimatedGasUsd + estimatedSwapCostUsd");
    expect(disclosure).toContain("Net benefit = max(0, incremental fees - rebalance cost)");
    expect(disclosure).toContain("Break-even hours = rebalance cost * 24 / incremental fees");
    expect(disclosure).toContain("impermanent loss and execution failures");
    expect(disclosure).toContain("Fees may not cover costs");
  });

  it("retains candidate assumptions when economics reject a rebalance", () => {
    const request = requestFixture();
    request.marketState.currentTick = 150;
    request.constraints.minimumWidthTicks = 200;
    request.constraints.maximumWidthTicks = 200;
    request.constraints.minimumNetBenefitUsd = "1000";
    const result = createLpRebalanceDeliverable(request, now);

    const candidateFees = 2400 * (10000 / 1000000) * (200 / 200) * 0.95;
    const candidateNet = candidateFees - (0.1 + 0.2);
    expect(result.decision).toBe("HOLD");
    expect(result.proposedRange).toBeNull();
    expect(result.expectedGrossFeesUsd).toBe("0");
    expect(result.expectedNetBenefitUsd).toBe("0");
    const disclosure = result.limitations.join("\n");
    const disclosedCandidateNet = disclosure.match(/Candidate modeled net benefit ([0-9.]+) USD/);
    expect(disclosedCandidateNet).not.toBeNull();
    expect(Number(disclosedCandidateNet?.[1])).toBeCloseTo(candidateNet, 8);
    expect(disclosure).toContain("Candidate gross fees = feeBase * (200/200) * 9500/10000");
    expect(disclosure).toContain("the candidate equations describe the rejected range, not a proposed action");
  });

  it("does not present a refusal's zero fields as a zero-fee forecast", () => {
    const request = requestFixture();
    const result = createLpRebalanceDeliverable(request, new Date("2026-09-06T00:10:00.000Z"));

    expect(result.decision).toBe("NONE");
    expect(result.proposedRange).toBeNull();
    expect(result.expectedGrossFeesUsd).toBe("0");
    expect(result.limitations).toContain("No economic forecast is made for this refusal; zero-valued result fields are placeholders, not a prediction of zero pool fees.");
  });
});
