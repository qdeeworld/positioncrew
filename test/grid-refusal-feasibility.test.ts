import { describe, expect, it } from "vitest";
import fixture from "../fixtures/provider-conformance/grid-valid.v2.json" with { type: "json" };
import {
  BoundedGridDeliverableSchema,
  BoundedGridRequestSchema,
  type BoundedGridDeliverable,
  type BoundedGridRequest,
} from "../src/contracts/bounded-grid.js";
import { evaluateProviderConformance } from "../src/evaluators/provider-conformance.js";
import { gridConstraintRefusalJustified } from "../src/evaluators/grid-refusal-feasibility.js";

const now = new Date("2026-08-12T16:00:00.000Z");

function request(): BoundedGridRequest {
  return BoundedGridRequestSchema.parse(structuredClone(fixture));
}

function inactive(
  input: BoundedGridRequest,
  status: BoundedGridDeliverable["status"] = "REFUSED_CONSTRAINTS",
  evaluatedAt = now,
): BoundedGridDeliverable {
  return BoundedGridDeliverableSchema.parse({
    schemaVersion: "positioncrew.bounded-grid.deliverable.v1",
    service: "BOUNDED_GRID",
    requestId: input.requestId,
    generatedAt: evaluatedAt.toISOString(),
    expiresAt: "2026-08-12T16:04:00.000Z",
    status,
    decision: status === "NO_ACTION" ? "NO_GRID" : "NONE",
    orders: [],
    grossSpreadCaptureUsd: "0",
    estimatedFeesUsd: "0",
    estimatedSlippageUsd: "0",
    estimatedGasUsd: "0",
    expectedNetProfitUsd: "0",
    riskModel: "FINITE_GRID_ZERO_PRICE_STRESS_V1",
    worstCaseLossUsd: "0",
    maximumInventoryUsd: "0",
    summary: "No orders were proposed for this request.",
    cancellationConditions: ["Refresh the request before acting."],
    limitations: ["No payment, order placement, or execution occurred."],
  });
}

describe("independent Grid constraint-refusal proofs", () => {
  it("does not certify the audited feasible request as impossible", () => {
    expect(gridConstraintRefusalJustified(request())).toBe(false);
  });

  it.each(["8", "9", "11", "12"])("proves a midpoint of %s violates the requested range", (midPrice) => {
    const input = request();
    input.marketState.midPrice = midPrice;
    expect(gridConstraintRefusalJustified(input)).toBe(true);
  });

  it("proves insufficient observed liquidity", () => {
    const input = request();
    input.marketState.liquidityUsd = "99999.999999999999999999";
    expect(gridConstraintRefusalJustified(input)).toBe(true);
  });

  it("proves observed volatility exceeds its maximum", () => {
    const input = request();
    input.marketState.realizedVolatilityBps = input.constraints.maximumVolatilityBps + 1;
    expect(gridConstraintRefusalJustified(input)).toBe(true);
  });

  it("does not reject equality at liquidity and volatility boundaries", () => {
    const input = request();
    input.marketState.liquidityUsd = input.constraints.minimumLiquidityUsd;
    input.marketState.realizedVolatilityBps = input.constraints.maximumVolatilityBps;
    expect(gridConstraintRefusalJustified(input)).toBe(false);
  });

  it("proves the required gas exceeds maxGasUsd, but not when equal", () => {
    const input = request();
    input.constraints.estimatedGasUsd = "2.000000000000000001";
    expect(gridConstraintRefusalJustified(input)).toBe(true);
    input.constraints.estimatedGasUsd = input.maxGasUsd;
    expect(gridConstraintRefusalJustified(input)).toBe(false);
  });

  it.each(["capitalUsd", "maxActionUsd"] as const)("proves even the minimum two-sided principal exceeds %s", (field) => {
    const input = request();
    input.baseAsset.decimals = 0;
    input.quoteAsset.decimals = 0;
    // One BUY base unit at 9 plus one initial SELL base unit marked at 10.
    if (field === "capitalUsd") input.constraints.capitalUsd = "18.999999999999999999";
    else input.maxActionUsd = "18.999999999999999999";
    expect(gridConstraintRefusalJustified(input)).toBe(true);
    if (field === "capitalUsd") input.constraints.capitalUsd = "19";
    else input.maxActionUsd = "19";
    expect(gridConstraintRefusalJustified(input)).toBe(false);
  });

  it("includes initial SELL inventory and every BUY in the minimum upper-price exposure", () => {
    const input = request();
    input.baseAsset.decimals = 0;
    input.constraints.maximumInventoryUsd = "21.999999999999999999";
    expect(gridConstraintRefusalJustified(input)).toBe(true);
    input.constraints.maximumInventoryUsd = "22";
    expect(gridConstraintRefusalJustified(input)).toBe(false);
  });

  it("adds unavoidable gas to the minimum zero-price principal loss", () => {
    const input = request();
    input.baseAsset.decimals = 0;
    input.constraints.maximumLossUsd = "19.999999999999999999";
    expect(gridConstraintRefusalJustified(input)).toBe(true);
    // Equality leaves feasibility unknown; estimated fees could still block it.
    input.constraints.maximumLossUsd = "20";
    expect(gridConstraintRefusalJustified(input)).toBe(false);
  });

  it("rounds the unavoidable BUY reservation up to quote-token precision", () => {
    const input = request();
    input.baseAsset.decimals = 6;
    input.quoteAsset.decimals = 2;
    // A 0.000001 BUY needs 0.01 quote; the initial SELL costs 0.00001.
    input.constraints.capitalUsd = "0.010009999999999999";
    expect(gridConstraintRefusalJustified(input)).toBe(true);
    input.constraints.capitalUsd = "0.01001";
    expect(gridConstraintRefusalJustified(input)).toBe(false);
  });

  it("preserves sub-quote-quantum initial SELL value instead of rounding it to zero", () => {
    const input = request();
    input.quoteAsset.decimals = 0;
    input.constraints.capitalUsd = "1";
    expect(gridConstraintRefusalJustified(input)).toBe(true);
    input.constraints.capitalUsd = "1.00000000000000001";
    expect(gridConstraintRefusalJustified(input)).toBe(false);
  });

  it("permits an external strategy to downsize below the requested capital", () => {
    const input = request();
    input.constraints.capitalUsd = "2000";
    expect(gridConstraintRefusalJustified(input)).toBe(false);
  });

  it("does not certify unknown profitability by reproducing the native forecast", () => {
    const input = request();
    input.constraints.minimumExpectedNetProfitUsd = "1000000000";
    expect(gridConstraintRefusalJustified(input)).toBe(false);
  });

  it("does not mutate the frozen request", () => {
    const input = request();
    const before = structuredClone(input);
    gridConstraintRefusalJustified(input);
    expect(input).toEqual(before);
  });
});

describe("Grid refusal admission", () => {
  it("rejects the audited NONE/empty-orders/zero-economics forgery below 100", () => {
    const input = request();
    const evaluated = evaluateProviderConformance(input, inactive(input), "grid-refusal-test-evaluator", now);
    expect(evaluated.passed).toBe(false);
    expect(evaluated.score).toBeLessThan(100);
    expect(evaluated.checks.find((item) => item.id === "grid-refusal-feasibility")?.passed).toBe(false);
  });

  it("accepts a genuine hard-policy refusal without a native generator comparison", () => {
    const input = request();
    input.marketState.liquidityUsd = "0";
    const evaluated = evaluateProviderConformance(input, inactive(input), "grid-refusal-test-evaluator", now);
    expect(evaluated.passed).toBe(true);
    expect(evaluated.score).toBe(100);
    expect(evaluated.checks.find((item) => item.id === "grid-refusal-feasibility")?.passed).toBe(true);
  });

  it("admits an independently specified two-order alternative on the same feasible request", () => {
    const input = request();
    const output = BoundedGridDeliverableSchema.parse({
      ...inactive(input),
      status: "ACTIONABLE",
      decision: "BUILD_GRID",
      orders: [
        { side: "BUY", price: "9", baseAmount: "1", maximumQuoteAmount: "9" },
        { side: "SELL", price: "11", baseAmount: "1", maximumQuoteAmount: "11" },
      ],
      grossSpreadCaptureUsd: "20",
      estimatedFeesUsd: "1.2",
      estimatedSlippageUsd: "0.4",
      estimatedGasUsd: "1",
      expectedNetProfitUsd: "17.4",
      worstCaseLossUsd: "21.6",
      maximumInventoryUsd: "22",
    });
    expect(evaluateProviderConformance(input, output, "grid-refusal-test-evaluator", now).passed).toBe(true);
  });

  it("preserves NO_ACTION rather than claiming a strategy must trade whenever no impossibility is proven", () => {
    const input = request();
    const evaluated = evaluateProviderConformance(input, inactive(input, "NO_ACTION"), "grid-refusal-test-evaluator", now);
    expect(evaluated.passed).toBe(true);
  });

  it("keeps stale evidence refusal independent of financial feasibility", () => {
    const input = request();
    const staleNow = new Date("2026-08-12T16:04:01.000Z");
    const output = inactive(input, "REFUSED_STALE_DATA", staleNow);
    expect(evaluateProviderConformance(input, output, "grid-refusal-test-evaluator", staleNow).passed).toBe(true);
  });

  it("keeps expired-request refusal independent of financial feasibility", () => {
    const input = request();
    const expiredNow = new Date(input.deadline);
    const output = inactive(input, "REFUSED_EXPIRED", expiredNow);
    expect(evaluateProviderConformance(input, output, "grid-refusal-test-evaluator", expiredNow).passed).toBe(true);
  });

  it("keeps inconsistent-observation refusal independent of financial feasibility", () => {
    const input = request();
    input.marketState.sourceId = "unbound-observation-source";
    const output = inactive(input, "REFUSED_INCONSISTENT_DATA");
    expect(evaluateProviderConformance(input, output, "grid-refusal-test-evaluator", now).passed).toBe(true);
  });

  it("does not weaken inactive zero-economics requirements for a justified refusal", () => {
    const input = request();
    input.marketState.liquidityUsd = "0";
    const output = { ...inactive(input), expectedNetProfitUsd: "1" };
    expect(evaluateProviderConformance(input, output, "grid-refusal-test-evaluator", now).passed).toBe(false);
  });

  it("preserves schema parsing of archived inactive outputs without the current risk-model field", () => {
    const input = request();
    const output = inactive(input, "NO_ACTION");
    delete output.riskModel;
    expect(BoundedGridDeliverableSchema.safeParse(output).success).toBe(true);
    expect(evaluateProviderConformance(input, output, "grid-refusal-test-evaluator", now).passed).toBe(true);
  });
});
