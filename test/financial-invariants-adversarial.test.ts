import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  BoundedGridRequestSchema, LpRebalanceDeliverableSchema, LpRebalanceRequestSchema, YieldOptimizationRequestSchema,
  type PositionCrewDeliverable, type PositionCrewRequest,
} from "../src/contracts/index.js";
import { evaluateFinancialInvariants } from "../src/evaluators/financial-invariants.js";
import { evaluateProviderConformance } from "../src/evaluators/provider-conformance.js";
import { evaluateProviderReproducibility } from "../src/evaluators/provider-reproducibility.js";
import { createBoundedGridDeliverable } from "../src/providers/bounded-grid.js";
import { createYieldOptimizationDeliverable } from "../src/providers/yield-optimization.js";
import { createLendingRescueDeliverable } from "../src/providers/lending-rescue.js";
import * as providers from "../src/providers/index.js";
import { FIXTURE_NOW, lendingFixture } from "./helpers.js";

function fixture(path: string): unknown { return JSON.parse(readFileSync(new URL(`../fixtures/${path}`, import.meta.url), "utf8")); }
function evaluate(request: PositionCrewRequest, output: PositionCrewDeliverable) {
  return evaluateProviderConformance(request, output, "independent-adversarial-evaluator", FIXTURE_NOW);
}
function rejects(request: PositionCrewRequest, output: PositionCrewDeliverable, id: string) {
  const evaluation = evaluate(request, output);
  expect(evaluation.passed).toBe(false);
  expect(evaluation.score).toBeLessThan(100);
  expect(evaluation.checks.find((item) => item.id === id)?.passed).toBe(false);
}
// A hand-authored alternative strategy, intentionally not produced by executeProvider.
function lp() {
  const request = LpRebalanceRequestSchema.parse(fixture("lp-rebalance/out-of-range-v3-position.v1.json"));
  request.marketState.currentTick = 0;
  request.marketState.token0PriceUsd = "1";
  request.marketState.token1PriceUsd = "1";
  request.marketState.fees24hUsd = "4000";
  request.position.lowerTick = -60;
  request.position.upperTick = 60;
  const output = LpRebalanceDeliverableSchema.parse({
    schemaVersion: "positioncrew.lp-rebalance.deliverable.v1", service: "LP_REBALANCE", requestId: request.requestId,
    generatedAt: FIXTURE_NOW.toISOString(), expiresAt: "2026-08-12T16:04:00.000Z", status: "ACTIONABLE", decision: "WIDEN",
    proposedRange: { lowerTick: -120, upperTick: 120 }, estimatedRebalanceCostUsd: "1", expectedGrossFeesUsd: "20",
    expectedNetBenefitUsd: "19", breakEvenHours: "1.2", inventoryExposure: { token0Bps: 5000, token1Bps: 5000 },
    feeProjection: { model: "POOL_SHARE_UPTIME_V1", currentUptimeBps: 0, proposedUptimeBps: 10000 },
    summary: "An independently supplied range with bounded cost and exposure.",
    actionSteps: ["Withdraw the previous liquidity.", "Rebalance within the supplied cost ceiling.", "Supply the proposed range."],
    invalidationConditions: ["Any frozen input changes."], limitations: ["Projected economics are estimates, not execution or performance guarantees."],
  });
  return { request, output };
}
function grid() {
  const request = BoundedGridRequestSchema.parse(fixture("bounded-grid/bnb-usdt-grid.v1.json"));
  request.constraints.minimumExpectedNetProfitUsd = "0";
  const output = createBoundedGridDeliverable(request, FIXTURE_NOW);
  expect(output.status).toBe("ACTIONABLE");
  return { request, output };
}
function yieldPlan() {
  const request = YieldOptimizationRequestSchema.parse(fixture("yield-optimization/venus-to-beefy.v1.json"));
  const output = createYieldOptimizationDeliverable(request, FIXTURE_NOW);
  expect(output.status).toBe("ACTIONABLE");
  return { request, output };
}

describe("independent final-output financial admission", () => {
  it("accepts a different valid strategy and separates wording integrity from financial correctness", () => {
    const { request, output } = lp();
    const first = evaluate(request, output);
    const second = evaluate(request, { ...output, summary: "Different provider explanation, same valid economics." });
    expect(first.passed).toBe(true);
    expect(second.passed).toBe(true);
    expect(first.deliverableHash).not.toBe(second.deliverableHash);
    expect(evaluateProviderReproducibility(request, output, FIXTURE_NOW).passed).toBe(false);
  });

  it("rejects the 237-tick maximum / 240-tick final output even when the generator reproduces the bug", () => {
    const { request, output } = lp();
    request.constraints.maximumWidthTicks = 237;
    const generator = vi.spyOn(providers, "executeProvider").mockReturnValue(output);
    try {
      expect(evaluateProviderReproducibility(request, output, FIXTURE_NOW).passed).toBe(true);
      generator.mockClear();
      rejects(request, output, "lp-final-width");
      expect(generator).not.toHaveBeenCalled();
    } finally { generator.mockRestore(); }
  });

  it.each([
    ["misaligned", -119, 120], ["outside domain", -887_280, 120], ["reversed", 120, -120],
  ])("rejects %s final LP ticks", (_name, lowerTick, upperTick) => {
    const { request, output } = lp();
    output.proposedRange = { lowerTick: Number(lowerTick), upperTick: Number(upperTick) };
    rejects(request, output, "lp-range-domain-alignment");
  });

  it("rejects a schema-valid invented exposure split", () => {
    const { request, output } = lp();
    output.inventoryExposure = { token0Bps: 1000, token1Bps: 1000 };
    rejects(request, output, "lp-exposure-report");
  });

  it("rejects LP exposure caps even if the output reports a compliant 50/50 split", () => {
    const { request, output } = lp();
    request.marketState.token1PriceUsd = "600";
    rejects(request, output, "lp-exposure-limits");
  });

  it("rejects a one-wei USD gas-limit breach without rounding it away", () => {
    const { request, output } = lp();
    request.maxGasUsd = "0.049999999999999999";
    rejects(request, output, "lp-cost-limits");
  });

  it("accepts a correctly sized emitted grid", () => {
    const { request, output } = grid();
    expect(evaluate(request, output).passed).toBe(true);
  });

  it("rejects inventory understated to one side of the grid", () => {
    const { request, output } = grid();
    output.maximumInventoryUsd = "1";
    rejects(request, output, "grid-accumulated-inventory");
  });

  it("rejects a mislabeled lower-boundary loss estimate as the worst-case loss", () => {
    const { request, output } = grid();
    output.worstCaseLossUsd = "1";
    rejects(request, output, "grid-zero-price-loss");
  });

  it("rejects orders with understated quote reservations", () => {
    const { request, output } = grid();
    output.orders[0]!.maximumQuoteAmount = "0.000000000000000001";
    rejects(request, output, "grid-order-semantics");
  });

  it("rejects a no-action label hiding executable orders", () => {
    const { request, output } = grid();
    output.status = "NO_ACTION";
    output.decision = "NO_GRID";
    rejects(request, output, "grid-inactive-payload");
  });

  it("accepts a funded yield route and rejects a post-action protocol cap breach", () => {
    const { request, output } = yieldPlan();
    expect(evaluate(request, output).passed).toBe(true);
    request.constraints.maximumProtocolConcentrationBps = 5000;
    rejects(request, output, "yield-final-protocol-concentration");
  });

  it("rejects yield routes that ignore the gas ceiling", () => {
    const { request, output } = yieldPlan();
    request.maxGasUsd = "1.999999999999999999";
    rejects(request, output, "yield-cost-limits");
  });

  it("rejects yield accounting that invents idle capital or omits retained holdings", () => {
    const { request, output } = yieldPlan();
    output.idleCapitalUsedUsd = "1";
    rejects(request, output, "yield-funding-conservation");
    output.idleCapitalUsedUsd = "0";
    output.finalProtocolAllocations = [];
    rejects(request, output, "yield-final-allocation-report");
  });

  it("does not certify historical actionable yield payloads lacking a funding plan", () => {
    const { request, output } = yieldPlan();
    delete output.withdrawals;
    rejects(request, output, "yield-funding-evidence");
  });

  it("accepts a different safe lending action without requiring the native minimum", () => {
    const request = lendingFixture(), output = createLendingRescueDeliverable(request, FIXTURE_NOW);
    output.recommendation = output.alternatives[0]!;
    output.decision = output.recommendation.kind;
    output.alternatives = [];
    expect(evaluate(request, output).passed).toBe(true);
  });

  it("rejects fabricated lending health factors and base units independently", () => {
    const request = lendingFixture(), output = createLendingRescueDeliverable(request, FIXTURE_NOW);
    output.recommendation!.projectedHealthFactor = "9.99";
    rejects(request, output, "decision");
    output.recommendation!.projectedHealthFactor = "1.25";
    output.recommendation!.amountBaseUnits = "1";
    rejects(request, output, "decision");
  });

  it("rejects a service mismatch before using category fields", () => {
    const { request } = lp();
    const { output } = grid();
    expect(evaluateFinancialInvariants(request, output)).toEqual([
      expect.objectContaining({ id: "financial-service-binding", passed: false }),
    ]);
  });
});
