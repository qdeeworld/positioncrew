import { describe, expect, it } from "vitest";
import type { PositionCrewDeliverable, PositionCrewRequest } from "../src/contracts/index.js";
import { FIXED_SCALE, formatFixed, parseFixed } from "../src/core/fixed.js";
import { calculateGridCycleEconomics } from "../src/core/grid-cycle-economics.js";
import { createProviderConformanceExamples } from "../src/marketplace/provider-conformance-examples.js";
import { evaluateProviderConformance } from "../src/evaluators/provider-conformance.js";
import { executeProvider } from "../src/providers/index.js";
import { FIXTURE_NOW } from "./helpers.js";

function example(service: PositionCrewRequest["service"]) {
  return createProviderConformanceExamples().find((item) => item.request.service === service)!;
}
function evaluate(request: PositionCrewRequest, output: PositionCrewDeliverable) {
  return evaluateProviderConformance(request, output, "positioncrew:economics-regression", FIXTURE_NOW);
}
function rejected(request: PositionCrewRequest, output: PositionCrewDeliverable, id: string) {
  const result = evaluate(request, output);
  expect(result.passed).toBe(false);
  expect(result.score).toBeLessThan(100);
  expect(result.checks.find((item) => item.id === id)?.passed).toBe(false);
}

describe("emitted Grid cycle economics", () => {
  const orders = [
    { side: "BUY" as const, price: "9", baseAmount: "1", maximumQuoteAmount: "9" },
    { side: "SELL" as const, price: "11", baseAmount: "1", maximumQuoteAmount: "11" },
  ];
  it("matches a hand-computed cycle with quote-precision cost buffers", () => {
    const cycle = calculateGridCycleEconomics(orders, 2, 100, 50);
    expect(cycle).toEqual({ gross: parseFixed("2"), chargeNotional: parseFixed("20"),
      feeBuffer: parseFixed("0.4"), slippageBuffer: parseFixed("0.22") });
    expect(cycle.gross - cycle.feeBuffer - cycle.slippageBuffer - parseFixed("0.1")).toBe(parseFixed("1.28"));
    expect((cycle.gross - cycle.feeBuffer - cycle.slippageBuffer) * 3n - parseFixed("0.1")).toBe(parseFixed("4.04"));
  });
  it("cannot turn an inflated SELL ceiling into turnover or revenue", () => {
    expect(calculateGridCycleEconomics([{ ...orders[0]! }, { ...orders[1]!, maximumQuoteAmount: "100" }], 2, 100, 50))
      .toEqual(calculateGridCycleEconomics(orders, 2, 100, 50));
  });
  it("credits only matched base and retains legitimate reservation dust", () => {
    const cycle = calculateGridCycleEconomics([
      { side: "BUY", price: "3", baseAmount: "3" },
      { side: "SELL", price: "5", baseAmount: "1" },
    ], 2, 0, 0);
    expect(cycle.gross).toBe(parseFixed("2"));
    expect(cycle.chargeNotional).toBe(parseFixed("14"));
  });
  it("aggregates each order before rounding and never discards a negative rounding contribution", () => {
    const split = [
      { side: "BUY" as const, price: "0.4", baseAmount: "1" },
      { side: "BUY" as const, price: "0.4", baseAmount: "1" },
      { side: "SELL" as const, price: "0.5", baseAmount: "1" },
      { side: "SELL" as const, price: "3", baseAmount: "1" },
    ];
    const cycle = calculateGridCycleEconomics(split, 0, 0, 0);
    expect(cycle.gross).toBe(parseFixed("1"));
    expect(calculateGridCycleEconomics([...split].reverse(), 0, 0, 0)).toEqual(cycle);
  });
  it("caps the native two-level forecast at the emitted matched quantity", () => {
    const { request } = example("BOUNDED_GRID");
    if (request.service !== "BOUNDED_GRID") throw new Error("Expected grid");
    Object.assign(request.constraints, { capitalUsd: "20", levelCount: 2, expectedCompletedCycles: 1, estimatedGasUsd: "0.1", minimumExpectedNetProfitUsd: "0" });
    const output = executeProvider(request, FIXTURE_NOW);
    if (output.service !== "BOUNDED_GRID") throw new Error("Expected grid");
    expect(output.status).toBe("ACTIONABLE");
    expect(parseFixed(output.grossSpreadCaptureUsd)).toBe(2n * (10n * FIXED_SCALE / 11n));
    expect(evaluate(request, output).passed).toBe(true);
    output.orders.find((item) => item.side === "SELL")!.maximumQuoteAmount = "100";
    expect(evaluate(request, output).passed).toBe(true);
    output.grossSpreadCaptureUsd = "5";
    output.expectedNetProfitUsd = formatFixed(parseFixed("5") - parseFixed(output.estimatedFeesUsd)
      - parseFixed(output.estimatedSlippageUsd) - parseFixed(output.estimatedGasUsd), 18);
    rejected(request, output, "grid-profit-arithmetic");
  });
  it("rejects a zero-spread ladder even with internally consistent claimed profit", () => {
    const { request, deliverable } = example("BOUNDED_GRID");
    if (request.service !== "BOUNDED_GRID" || deliverable.service !== "BOUNDED_GRID") throw new Error("Expected grid");
    deliverable.orders = [
      { side: "BUY", price: "10", baseAmount: "1", maximumQuoteAmount: "10" },
      { side: "SELL", price: "10", baseAmount: "1", maximumQuoteAmount: "10" },
    ];
    deliverable.grossSpreadCaptureUsd = "5";
    deliverable.estimatedFeesUsd = "1.2";
    deliverable.estimatedSlippageUsd = "0.4";
    deliverable.estimatedGasUsd = "1";
    deliverable.expectedNetProfitUsd = "2.4";
    deliverable.maximumInventoryUsd = "22";
    deliverable.worstCaseLossUsd = "22.6";
    rejected(request, deliverable, "grid-profit-arithmetic");
  });
});

describe("inactive LP and Yield economics", () => {
  function inactive(service: "LP_REBALANCE" | "YIELD_OPTIMIZATION", refusal: boolean) {
    const { request } = example(service);
    if (request.service === "LP_REBALANCE") {
      request.marketState.currentTick = 0;
      request.marketState.token0PriceUsd = "1";
      request.position.token0ShareBps = 5_000;
      request.position.token1ShareBps = 5_000;
    } else request.maxActionUsd = "0.000000000000000001";
    if (refusal) request.maxDataAgeSeconds = 15;
    const output = executeProvider(request, FIXTURE_NOW);
    expect(output.status).not.toBe("ACTIONABLE");
    expect(evaluate(request, output).passed).toBe(true);
    return { request, output };
  }
  it.each(["estimatedRebalanceCostUsd", "expectedNetBenefitUsd", "breakEvenHours"] as const)("rejects inactive LP %s", (field) => {
    for (const refusal of [false, true]) {
      const { request, output } = inactive("LP_REBALANCE", refusal);
      if (output.service !== "LP_REBALANCE") throw new Error("Expected LP");
      output[field] = "999999";
      rejected(request, output, "lp-inactive-economics");
    }
  });
  it("binds HOLD and refusal fee figures without erasing a legitimate current-fee estimate", () => {
    for (const refusal of [false, true]) {
      const { request, output } = inactive("LP_REBALANCE", refusal);
      if (output.service !== "LP_REBALANCE") throw new Error("Expected LP");
      expect(output.expectedGrossFeesUsd).toBe(refusal ? "0" : "18");
      output.expectedGrossFeesUsd = "999999";
      rejected(request, output, "lp-inactive-fees");
    }
  });
  it("accepts an explicit unchanged HOLD projection only with its correct arithmetic", () => {
    const { request, output } = inactive("LP_REBALANCE", false);
    if (output.service !== "LP_REBALANCE") throw new Error("Expected LP");
    output.feeProjection = { model: "POOL_SHARE_UPTIME_V1", currentUptimeBps: 5_000, proposedUptimeBps: 5_000 };
    output.expectedGrossFeesUsd = "10";
    expect(evaluate(request, output).passed).toBe(true);
    output.feeProjection.proposedUptimeBps = 9_500;
    rejected(request, output, "lp-inactive-fees");
  });
  it.each(["currentWeightedApyBps", "grossApyBps", "annualYieldUpliftUsd", "netBenefitUsd", "migrationCostUsd", "breakEvenDays"] as const)(
    "rejects unsupported inactive Yield %s", (field) => {
      for (const refusal of [false, true]) {
        const { request, output } = inactive("YIELD_OPTIMIZATION", refusal);
        if (output.service !== "YIELD_OPTIMIZATION") throw new Error("Expected yield");
        if (field === "currentWeightedApyBps") output.currentWeightedApyBps += 1;
        else if (field === "grossApyBps") output.grossApyBps = 1;
        else output[field] = "999999";
        rejected(request, output, "yield-inactive-economics");
      }
    },
  );
  it("does not accept an unperformed idle-capital migration on a Yield HOLD", () => {
    const { request, output } = inactive("YIELD_OPTIMIZATION", false);
    if (output.service !== "YIELD_OPTIMIZATION") throw new Error("Expected yield");
    output.idleCapitalUsedUsd = "1";
    rejected(request, output, "yield-inactive-funding");
  });
});
