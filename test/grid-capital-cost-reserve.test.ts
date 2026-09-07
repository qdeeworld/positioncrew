import { describe, expect, it } from "vitest";
import type { BoundedGridDeliverable, BoundedGridRequest, LpRebalanceDeliverable, LpRebalanceRequest } from "../src/contracts/index.js";
import { FIXED_SCALE, ceilDivide, parseFixed } from "../src/core/fixed.js";
import { evaluateProviderConformance } from "../src/evaluators/provider-conformance.js";
import { createBoundedGridDeliverable } from "../src/providers/bounded-grid.js";

const stamp = "2026-09-07T21:00:00.000Z";
const expiry = "2026-09-07T21:05:00.000Z";
const now = new Date(stamp);
const address = "0x1111111111111111111111111111111111111111";
const venue = "0x2222222222222222222222222222222222222222";
const source = { sourceId: "local-audit", label: "Synthetic arithmetic regression, not live evidence", uri: "https://example.com/audit", observedAt: stamp };

function gridRequest(): BoundedGridRequest {
  return {
    schemaVersion: "positioncrew.bounded-grid.request.v1", service: "BOUNDED_GRID", requestId: "grid-capital-cost-reserve",
    chainId: 56, account: address, protocol: "PancakeSwap", requestedAt: stamp, deadline: expiry,
    maxDataAgeSeconds: 300, maxActionUsd: "550", maxGasUsd: "10", maxSlippageBps: 0, sources: [source], venue,
    baseAsset: { symbol: "BASE", address, decimals: 18 }, quoteAsset: { symbol: "USDT", address: venue, decimals: 18 },
    marketState: { midPrice: "10", liquidityUsd: "1000000", realizedVolatilityBps: 100, venueFeeBps: 0, observedAt: stamp, sourceId: source.sourceId },
    constraints: {
      capitalUsd: "550", lowerPrice: "1", upperPrice: "20", levelCount: 2, maximumInventoryUsd: "2000", maximumLossUsd: "560",
      minimumExpectedNetProfitUsd: "1", minimumLiquidityUsd: "100000", maximumVolatilityBps: 1000,
      expectedCompletedCycles: 1, estimatedGasUsd: "10", orderExpirySeconds: 300,
    },
  };
}

function gridOutput(request: BoundedGridRequest): BoundedGridDeliverable {
  return {
    schemaVersion: "positioncrew.bounded-grid.deliverable.v1", service: "BOUNDED_GRID", requestId: request.requestId,
    generatedAt: stamp, expiresAt: expiry, status: "ACTIONABLE", decision: "BUILD_GRID",
    orders: [
      { side: "BUY", price: "1", baseAmount: "50", maximumQuoteAmount: "50" },
      { side: "SELL", price: "20", baseAmount: "50", maximumQuoteAmount: "1000" },
    ],
    grossSpreadCaptureUsd: "950", estimatedFeesUsd: "0", estimatedSlippageUsd: "0", estimatedGasUsd: "10",
    expectedNetProfitUsd: "940", riskModel: "FINITE_GRID_ZERO_PRICE_STRESS_V1", worstCaseLossUsd: "560", maximumInventoryUsd: "2000",
    summary: "Synthetic capital-reserve regression.", cancellationConditions: ["Expires at the frozen deadline."],
    limitations: ["Synthetic arithmetic, not a live trading result."],
  };
}

function requiredFunding(request: BoundedGridRequest, output: BoundedGridDeliverable): bigint {
  const initialBase = output.orders.filter((order) => order.side === "SELL")
    .reduce((total, order) => total + parseFixed(order.baseAmount), 0n);
  const buyReservations = output.orders.filter((order) => order.side === "BUY")
    .reduce((total, order) => total + parseFixed(order.maximumQuoteAmount), 0n);
  return ceilDivide(initialBase * parseFixed(request.marketState.midPrice), FIXED_SCALE) + buyReservations
    + parseFixed(output.estimatedFeesUsd) + parseFixed(output.estimatedSlippageUsd) + parseFixed(output.estimatedGasUsd);
}

describe("grid capital includes all modeled cost reserves", () => {
  it("rejects a schema-valid $560 funding obligation against $550 capital", () => {
    const request = gridRequest();
    const output = gridOutput(request);
    const evaluation = evaluateProviderConformance(request, output, "local-audit", now);
    expect(requiredFunding(request, output)).toBe(parseFixed("560"));
    expect(evaluation.passed).toBe(false);
    expect(evaluation.checks.find((item) => item.id === "grid-capital-cost-reserve")?.passed).toBe(false);
    expect(evaluation.checks.find((item) => item.id === "grid-funded-capital")?.passed).toBe(true);
    expect(evaluation.checks.find((item) => item.id === "grid-zero-price-loss")?.passed).toBe(true);
  });

  it("accepts the exact funded boundary without changing the principal-only action cap", () => {
    const request = gridRequest();
    request.constraints.capitalUsd = "560";
    expect(evaluateProviderConformance(request, gridOutput(request), "local-audit", now).passed).toBe(true);
  });

  it("accepts a genuinely zero-cost grid using all its capital", () => {
    const request = gridRequest();
    request.constraints.estimatedGasUsd = "0";
    const output = gridOutput(request);
    output.estimatedGasUsd = "0";
    output.worstCaseLossUsd = "550";
    output.expectedNetProfitUsd = "950";
    expect(evaluateProviderConformance(request, output, "local-audit", now).passed).toBe(true);
  });

  it.each([
    [10, 0, "2.1", "0", "562.1", "937.9"],
    [0, 10, "0", "2.1", "562.1", "937.9"],
    [10, 10, "2.1", "2.1", "564.2", "935.8"],
  ] as const)("also reserves venue fees %i bps and slippage %i bps", (feeBps, slippageBps, fees, slippage, total, profit) => {
    const request = gridRequest();
    request.constraints.capitalUsd = "560";
    request.constraints.maximumLossUsd = total;
    request.marketState.venueFeeBps = feeBps;
    request.maxSlippageBps = slippageBps;
    const output = gridOutput(request);
    Object.assign(output, { estimatedFeesUsd: fees, estimatedSlippageUsd: slippage, worstCaseLossUsd: total, expectedNetProfitUsd: profit });
    const evaluation = evaluateProviderConformance(request, output, "local-audit", now);
    expect(requiredFunding(request, output)).toBe(parseFixed(total));
    expect(evaluation.passed).toBe(false);
    expect(evaluation.checks.find((item) => item.id === "grid-capital-cost-reserve")?.passed).toBe(false);
    expect(evaluation.checks.find((item) => item.id === "grid-modeled-costs")?.passed).toBe(true);
  });

  it("sizes native orders down to reserve costs and still returns a profitable actionable grid", () => {
    const request = gridRequest();
    request.constraints.maximumInventoryUsd = "6000";
    request.constraints.maximumLossUsd = "1000";
    request.constraints.estimatedGasUsd = "150";
    request.maxGasUsd = "200";
    const output = createBoundedGridDeliverable(request, now);
    expect(output.status).toBe("ACTIONABLE");
    expect(requiredFunding(request, output)).toBeLessThanOrEqual(parseFixed(request.constraints.capitalUsd));
    expect(parseFixed(output.expectedNetProfitUsd)).toBeGreaterThan(0n);
    expect(parseFixed(output.orders.find((order) => order.side === "BUY")!.maximumQuoteAmount)).toBeLessThan(parseFixed("275"));
    expect(evaluateProviderConformance(request, output, "local-audit", now).passed).toBe(true);
  });

  it("preserves already affordable native order sizes", () => {
    const request = gridRequest();
    request.constraints.maximumInventoryUsd = "6000";
    request.constraints.maximumLossUsd = "1000";
    const output = createBoundedGridDeliverable(request, now);
    expect(output.status).toBe("ACTIONABLE");
    expect(output.orders).toEqual([
      { side: "BUY", price: "1", baseAmount: "275", maximumQuoteAmount: "275" },
      { side: "SELL", price: "20", baseAmount: "13.75", maximumQuoteAmount: "275" },
    ]);
    expect(evaluateProviderConformance(request, output, "local-audit", now).passed).toBe(true);
  });

  it("returns a valid no-grid decision when gas alone exhausts capital", () => {
    const request = gridRequest();
    request.constraints.estimatedGasUsd = "550";
    request.maxGasUsd = "550";
    const output = createBoundedGridDeliverable(request, now);
    expect(output.status).toBe("NO_ACTION");
    expect(output.orders).toEqual([]);
    expect(evaluateProviderConformance(request, output, "local-audit", now).passed).toBe(true);
  });
});

function lpRequest(): LpRebalanceRequest {
  return {
    schemaVersion: "positioncrew.lp-rebalance.request.v1", service: "LP_REBALANCE", requestId: "lp-observed-tick-domain",
    chainId: 56, account: address, protocol: "PancakeSwap V3", requestedAt: stamp, deadline: expiry,
    maxDataAgeSeconds: 300, maxActionUsd: "100", maxGasUsd: "10", maxSlippageBps: 30, sources: [source], pool: venue,
    token0: { symbol: "A", address, decimals: 18 }, token1: { symbol: "B", address: venue, decimals: 18 },
    position: { lowerTick: -1000, upperTick: 1000, liquidity: "1", positionValueUsd: "1000", feesEarnedUsd: "0", token0ShareBps: 5000, token1ShareBps: 5000 },
    marketState: { currentTick: 0, token0PriceUsd: "1", token1PriceUsd: "1", volume24hUsd: "0", fees24hUsd: "0", poolLiquidityUsd: "1000000", realizedVolatilityBps: 1, observedAt: stamp, sourceId: source.sourceId },
    constraints: { minimumWidthTicks: 100, maximumWidthTicks: 5000, tickSpacing: 10, edgeBufferBps: 1000, highVolatilityBps: 1000, maximumToken0ShareBps: 10000, maximumToken1ShareBps: 10000, minimumNetBenefitUsd: "1", estimatedGasUsd: "1", estimatedSwapCostUsd: "1", evaluationHorizonHours: 24 },
  };
}

function lpHold(request: LpRebalanceRequest): LpRebalanceDeliverable {
  return {
    schemaVersion: "positioncrew.lp-rebalance.deliverable.v1", service: "LP_REBALANCE", requestId: request.requestId,
    generatedAt: stamp, expiresAt: expiry, status: "NO_ACTION", decision: "HOLD", proposedRange: null,
    estimatedRebalanceCostUsd: "0", expectedGrossFeesUsd: "0", expectedNetBenefitUsd: "0", breakEvenHours: null,
    inventoryExposure: { token0Bps: 5000, token1Bps: 5000 }, summary: "Synthetic tick-domain regression.", actionSteps: [],
    invalidationConditions: ["Expire at the frozen deadline."], limitations: ["Synthetic arithmetic, not public evidence."],
  };
}

describe("LP observed ticks must be possible V3 input even for HOLD", () => {
  it.each([
    [-1000000000, 1000000000, 0],
    [-887273, 1000, 0],
    [-1000, 887273, 0],
    [-1000, 1000, -887273],
    [-1000, 1000, 887273],
  ])("rejects position [%i, %i] and current tick %i outside the protocol domain", (lower, upper, tick) => {
    const request = lpRequest();
    request.position.lowerTick = lower;
    request.position.upperTick = upper;
    request.marketState.currentTick = tick;
    const evaluation = evaluateProviderConformance(request, lpHold(request), "local-audit", now);
    expect(evaluation.passed).toBe(false);
    expect(evaluation.checks.find((item) => item.id === "lp-input-tick-domain")?.passed).toBe(false);
  });

  it("preserves a valid ordinary HOLD", () => {
    const request = lpRequest();
    expect(evaluateProviderConformance(request, lpHold(request), "local-audit", now).passed).toBe(true);
  });

  it.each([-887272, 887272])("accepts the exact protocol boundary tick %i", (tick) => {
    const request = lpRequest();
    request.position.lowerTick = -887272;
    request.position.upperTick = 887272;
    request.marketState.currentTick = tick;
    expect(evaluateProviderConformance(request, lpHold(request), "local-audit", now).passed).toBe(true);
  });
});
