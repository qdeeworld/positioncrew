import { describe, expect, it } from "vitest";
import fixture from "../fixtures/provider-conformance/lp-valid.v2.json" with { type: "json" };
import {
  LpRebalanceDeliverableSchema,
  LpRebalanceRequestSchema,
  type LpRebalanceDeliverable,
  type LpRebalanceRequest,
} from "../src/contracts/lp-rebalance.js";
import { lpInventoryExposure } from "../src/core/lp-range.js";
import { lpConstraintRefusalJustified } from "../src/evaluators/lp-refusal-feasibility.js";
import { evaluateProviderConformance } from "../src/evaluators/provider-conformance.js";
import { createLpRebalanceDeliverable } from "../src/providers/lp-rebalance.js";

const now = new Date("2026-08-12T16:00:00.000Z");
const evaluatorId = "positioncrew:lp-refusal-feasibility";

function request(): LpRebalanceRequest {
  return LpRebalanceRequestSchema.parse(structuredClone(fixture));
}

function refusal(
  input: LpRebalanceRequest,
  status: LpRebalanceDeliverable["status"] = "REFUSED_CONSTRAINTS",
  evaluatedAt = now,
): LpRebalanceDeliverable {
  return LpRebalanceDeliverableSchema.parse({
    schemaVersion: "positioncrew.lp-rebalance.deliverable.v1",
    service: "LP_REBALANCE",
    requestId: input.requestId,
    generatedAt: evaluatedAt.toISOString(),
    expiresAt: "2026-08-12T16:04:00.000Z",
    status,
    decision: "NONE",
    proposedRange: null,
    estimatedRebalanceCostUsd: "0",
    expectedGrossFeesUsd: "0",
    expectedNetBenefitUsd: "0",
    breakEvenHours: null,
    inventoryExposure: { token0Bps: input.position.token0ShareBps, token1Bps: input.position.token1ShareBps },
    summary: "No rebalance was proposed.",
    actionSteps: [],
    invalidationConditions: ["Refresh the position and buyer policy before retrying."],
    limitations: ["No transaction or capital movement occurred."],
  });
}

describe("independent LP constraint-refusal proofs", () => {
  it("does not certify the actionable conformance fixture as impossible", () => {
    const input = request();
    expect(createLpRebalanceDeliverable(input, now).status).toBe("ACTIONABLE");
    expect(lpConstraintRefusalJustified(input)).toBe(false);
  });

  it("proves no spacing-aligned width lies inside both buyer bounds", () => {
    const input = request();
    Object.assign(input.constraints, { minimumWidthTicks: 61, maximumWidthTicks: 119, tickSpacing: 60 });
    expect(lpConstraintRefusalJustified(input)).toBe(true);
  });

  it("allows a feasible odd number of spacings without requiring symmetric half-rounding", () => {
    const input = request();
    Object.assign(input.constraints, { minimumWidthTicks: 100, maximumWidthTicks: 250, tickSpacing: 50 });
    expect(lpConstraintRefusalJustified(input)).toBe(false);
  });

  it("proves the minimum aligned width exceeds the complete V3 domain", () => {
    const input = request();
    Object.assign(input.constraints, { minimumWidthTicks: 1_774_560, maximumWidthTicks: 2_000_000, tickSpacing: 60 });
    expect(lpConstraintRefusalJustified(input)).toBe(true);
  });

  it.each([-887_273, -887_221, 887_220, 887_272])("proves tick %i has no containing aligned half-open range", (currentTick) => {
    const input = request();
    input.marketState.currentTick = currentTick;
    expect(lpConstraintRefusalJustified(input)).toBe(true);
  });

  it.each([-887_220, 887_219])("does not refuse representable edge tick %i", (currentTick) => {
    const input = request();
    input.marketState.currentTick = currentTick;
    expect(lpConstraintRefusalJustified(input)).toBe(false);
  });

  it("proves spacing that leaves only the zero endpoint cannot form a range", () => {
    const input = request();
    Object.assign(input.constraints, { minimumWidthTicks: 1, maximumWidthTicks: 2_000_000, tickSpacing: 1_000_000 });
    input.marketState.currentTick = 0;
    expect(lpConstraintRefusalJustified(input)).toBe(true);
  });

  it("proves gas above its hard cap without rejecting equality", () => {
    const input = request();
    input.constraints.estimatedGasUsd = "0.100000000000000001";
    expect(lpConstraintRefusalJustified(input)).toBe(true);
    input.constraints.estimatedGasUsd = input.maxGasUsd;
    expect(lpConstraintRefusalJustified(input)).toBe(false);
  });

  it("includes frozen swap costs in the unavoidable action-cost floor", () => {
    const input = request();
    input.constraints.estimatedSwapCostUsd = "249.950000000000000001";
    expect(lpConstraintRefusalJustified(input)).toBe(true);
    input.constraints.estimatedSwapCostUsd = "249.95";
    expect(lpConstraintRefusalJustified(input)).toBe(false);
  });

  it("proves aggregate share caps below 10000 cannot admit any complete position", () => {
    const input = request();
    input.constraints.maximumToken0ShareBps = 4_999;
    input.constraints.maximumToken1ShareBps = 5_000;
    expect(lpConstraintRefusalJustified(input)).toBe(true);
    input.constraints.maximumToken0ShareBps = 5_000;
    expect(lpConstraintRefusalJustified(input)).toBe(false);
  });

  it("leaves profitability unknown instead of treating a failed native forecast as proof", () => {
    const input = request();
    input.constraints.minimumNetBenefitUsd = "1000000000";
    expect(lpConstraintRefusalJustified(input)).toBe(false);
  });

  it("does not mutate the frozen request", () => {
    const input = request();
    const before = structuredClone(input);
    lpConstraintRefusalJustified(input);
    expect(input).toEqual(before);
  });
});

describe("LP refusal and strategy-decline admission", () => {
  it("rejects the audited actionable-to-zero-refusal forgery below 100", () => {
    const input = request();
    expect(createLpRebalanceDeliverable(input, now).status).toBe("ACTIONABLE");
    const evaluated = evaluateProviderConformance(input, refusal(input), evaluatorId, now);
    expect(evaluated.passed).toBe(false);
    expect(evaluated.score).toBeLessThan(100);
    expect(evaluated.checks.find((item) => item.id === "lp-refusal-feasibility")?.passed).toBe(false);
  });

  it("preserves an independently proven impossible aligned-range refusal", () => {
    const input = request();
    Object.assign(input.constraints, { minimumWidthTicks: 61, maximumWidthTicks: 119, tickSpacing: 60 });
    const output = createLpRebalanceDeliverable(input, now);
    expect(output.status).toBe("REFUSED_CONSTRAINTS");
    expect(output.expectedGrossFeesUsd).toBe("0");
    const evaluated = evaluateProviderConformance(input, output, evaluatorId, now);
    expect(evaluated.passed).toBe(true);
    expect(evaluated.score).toBe(100);
    expect(evaluated.checks.find((item) => item.id === "lp-refusal-feasibility")?.passed).toBe(true);
  });

  it("admits a genuine cost-cap refusal independently of the native HOLD choice", () => {
    const input = request();
    input.constraints.estimatedGasUsd = "1";
    expect(evaluateProviderConformance(input, refusal(input), evaluatorId, now).passed).toBe(true);
  });

  it("preserves a global inventory-policy impossibility as a native refusal", () => {
    const input = request();
    input.constraints.maximumToken0ShareBps = 4_000;
    input.constraints.maximumToken1ShareBps = 4_000;
    const output = createLpRebalanceDeliverable(input, now);
    expect(output.status).toBe("REFUSED_CONSTRAINTS");
    expect(evaluateProviderConformance(input, output, evaluatorId, now).passed).toBe(true);
  });

  it("uses HOLD for a failed centered candidate while admitting a different range on the same job", () => {
    const input = request();
    input.constraints.maximumToken1ShareBps = 6_000;
    expect(lpConstraintRefusalJustified(input)).toBe(false);
    const native = createLpRebalanceDeliverable(input, now);
    expect(native.status).toBe("NO_ACTION");
    expect(native.decision).toBe("HOLD");
    expect(native.limitations.join(" ")).toContain("does not prove every provider must refuse");
    expect(evaluateProviderConformance(input, native, evaluatorId, now).passed).toBe(true);

    const proposedRange = { lowerTick: 60, upperTick: 300 };
    const inventory = lpInventoryExposure(input, proposedRange)!;
    const alternative = LpRebalanceDeliverableSchema.parse({
      ...refusal(input),
      status: "ACTIONABLE",
      decision: "SHIFT",
      proposedRange,
      estimatedRebalanceCostUsd: "1",
      expectedGrossFeesUsd: "19",
      expectedNetBenefitUsd: "18",
      breakEvenHours: "1.263157894736842105",
      feeProjection: { model: "POOL_SHARE_UPTIME_V1", currentUptimeBps: 0, proposedUptimeBps: 9_500 },
      inventoryExposure: { token0Bps: inventory.token0Bps, token1Bps: inventory.token1Bps },
      actionSteps: ["Collect and remove liquidity.", "Rebalance within the buyer limits.", "Mint at the supplied range."],
    });
    expect(inventory.maximumToken0Bps).toBeLessThanOrEqual(input.constraints.maximumToken0ShareBps);
    expect(inventory.maximumToken1Bps).toBeLessThanOrEqual(input.constraints.maximumToken1ShareBps);
    expect(evaluateProviderConformance(input, alternative, evaluatorId, now).passed).toBe(true);
  });

  it("retains request-derived positive current fees and observed exposure when declining a candidate", () => {
    const input = request();
    Object.assign(input.marketState, { currentTick: 0, token0PriceUsd: "1", realizedVolatilityBps: 1_500 });
    Object.assign(input.position, { token0ShareBps: 5_000, token1ShareBps: 5_000 });
    input.constraints.maximumToken0ShareBps = 1_000;
    input.constraints.maximumToken1ShareBps = 10_000;
    const output = createLpRebalanceDeliverable(input, now);
    expect(lpConstraintRefusalJustified(input)).toBe(false);
    expect(output.status).toBe("NO_ACTION");
    expect(output.decision).toBe("HOLD");
    expect(output.expectedGrossFeesUsd).toBe("11");
    expect(output.expectedNetBenefitUsd).toBe("0");
    expect(output.inventoryExposure).toEqual({ token0Bps: 5_000, token1Bps: 5_000 });
    expect(output.actionSteps).toEqual([]);
    expect(output.proposedRange).toBeNull();
    expect(evaluateProviderConformance(input, output, evaluatorId, now).passed).toBe(true);
  });

  it("preserves an ordinary in-range HOLD with its current fee estimate", () => {
    const input = request();
    input.marketState.currentTick = 0;
    input.marketState.token0PriceUsd = "1";
    const output = createLpRebalanceDeliverable(input, now);
    expect(output.status).toBe("NO_ACTION");
    expect(output.expectedGrossFeesUsd).toBe("18");
    expect(evaluateProviderConformance(input, output, evaluatorId, now).passed).toBe(true);
  });

  it("preserves stale evidence refusal independently of range feasibility", () => {
    const input = request();
    const staleNow = new Date("2026-08-12T16:04:01.000Z");
    const output = refusal(input, "REFUSED_STALE_DATA", staleNow);
    expect(evaluateProviderConformance(input, output, evaluatorId, staleNow).passed).toBe(true);
  });

  it("preserves expired-request refusal independently of range feasibility", () => {
    const input = request();
    const expiredNow = new Date(input.deadline);
    const output = refusal(input, "REFUSED_EXPIRED", expiredNow);
    expect(evaluateProviderConformance(input, output, evaluatorId, expiredNow).passed).toBe(true);
  });

  it("preserves inconsistent-observation refusal independently of range feasibility", () => {
    const input = request();
    input.marketState.sourceId = "unbound-observation-source";
    expect(evaluateProviderConformance(input, refusal(input, "REFUSED_INCONSISTENT_DATA"), evaluatorId, now).passed).toBe(true);
  });

  it("does not weaken the zero-economics rule for a justified refusal", () => {
    const input = request();
    input.constraints.estimatedGasUsd = "1";
    const output = { ...refusal(input), expectedGrossFeesUsd: "1" };
    expect(evaluateProviderConformance(input, output, evaluatorId, now).passed).toBe(false);
  });

  it("retains parsing of archived refusal shapes without a fee projection", () => {
    const input = request();
    input.constraints.estimatedGasUsd = "1";
    const output = refusal(input);
    expect(output.feeProjection).toBeUndefined();
    expect(LpRebalanceDeliverableSchema.safeParse(output).success).toBe(true);
    expect(evaluateProviderConformance(input, output, evaluatorId, now).passed).toBe(true);
  });
});
