import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LpRebalanceRequestSchema, type LendingActionPlan, type LendingRescueDeliverable, type LendingRescueRequest } from "../src/contracts/index.js";
import { FIXED_SCALE, formatFixed, parseFixed } from "../src/core/fixed.js";
import { evaluateFinancialInvariants } from "../src/evaluators/financial-invariants.js";
import { evaluateLendingRescue } from "../src/evaluators/lending-rescue.js";
import { createLendingRescueDeliverable } from "../src/providers/lending-rescue.js";
import { createLpRebalanceDeliverable } from "../src/providers/lp-rebalance.js";
import { FIXTURE_NOW, lendingFixture } from "./helpers.js";

function resizeAction(request: LendingRescueRequest, output: LendingRescueDeliverable, action: LendingActionPlan, units: bigint): LendingActionPlan {
  const asset = (action.kind === "REPAY_DEBT" ? request.position.debt : request.position.collateral)
    .find((entry) => entry.address.toLowerCase() === action.asset.address.toLowerCase())!;
  const amount = units * FIXED_SCALE / (10n ** BigInt(action.asset.decimals));
  const value = amount * parseFixed(asset.priceUsd) / FIXED_SCALE;
  let weighted = parseFixed(output.position.liquidationWeightedCollateralUsd);
  let debt = parseFixed(output.position.debtValueUsd);
  if (action.kind === "REPAY_DEBT") debt -= value;
  else weighted += value * BigInt((asset as LendingRescueRequest["position"]["collateral"][number]).liquidationThresholdBps) / 10_000n;
  return { ...action, amountBaseUnits: units.toString(), amount: formatFixed(amount, 18),
    amountUsd: formatFixed(value, 18), projectedHealthFactor: formatFixed(weighted * FIXED_SCALE / debt, 18) };
}

function singleActionRequest(kind: LendingActionPlan["kind"], decimals: number, price?: string): LendingRescueRequest {
  const request = lendingFixture();
  request.allowedActions = [kind];
  request.maxActionUsd = "100000";
  request.availableAssets.forEach((asset) => { asset.availableAmount = "100000"; });
  const asset = kind === "REPAY_DEBT" ? request.position.debt[0]! : request.position.collateral[0]!;
  asset.decimals = decimals;
  if (price !== undefined) asset.priceUsd = price;
  request.availableAssets.find((entry) => entry.address.toLowerCase() === asset.address.toLowerCase())!.decimals = decimals;
  return request;
}

describe("independent minimum executable Lending actions", () => {
  for (const kind of ["REPAY_DEBT", "ADD_COLLATERAL"] as const) {
    it.each([0, 2, 6, 18])(`${kind} accepts token rounding but rejects both adjacent non-minimal quantities at %i decimals`, (decimals) => {
      const request = singleActionRequest(kind, decimals);
      const output = createLendingRescueDeliverable(request, FIXTURE_NOW);
      expect(output.status).toBe("ACTIONABLE");
      expect(output.recommendation?.kind).toBe(kind);
      expect(evaluateFinancialInvariants(request, output).every((entry) => entry.passed)).toBe(true);
      const action = output.recommendation!;
      const units = BigInt(action.amountBaseUnits);
      const oversized = { ...output, recommendation: resizeAction(request, output, action, units + 1n) };
      expect(Number(oversized.recommendation.projectedHealthFactor)).toBeGreaterThanOrEqual(Number(request.targetHealthFactor));
      expect(evaluateFinancialInvariants(request, oversized).find((entry) => entry.id === "decision")?.passed).toBe(false);
      const undersized = { ...output, recommendation: resizeAction(request, output, action, units - 1n) };
      expect(evaluateFinancialInvariants(request, undersized).find((entry) => entry.id === "decision")?.passed).toBe(false);
    });
  }

  it.each([
    ["REPAY_DEBT", "1.0037"], ["ADD_COLLATERAL", "2.675"],
  ] as const)("checks %s minimum with a non-unit USD price %s", (kind, price) => {
    const request = singleActionRequest(kind, 2, price);
    const output = createLendingRescueDeliverable(request, FIXTURE_NOW);
    expect(output.status).toBe("ACTIONABLE");
    expect(evaluateFinancialInvariants(request, output).every((entry) => entry.passed)).toBe(true);
    const action = output.recommendation!;
    const tampered = { ...output, recommendation: resizeAction(request, output, action, BigInt(action.amountBaseUnits) + 1n) };
    expect(evaluateFinancialInvariants(request, tampered).find((entry) => entry.id === "decision")?.passed).toBe(false);
  });

  it("rejects the reported 200-USDT overpayment even with a correctly recalculated health factor", () => {
    const request = singleActionRequest("REPAY_DEBT", 18);
    const output = createLendingRescueDeliverable(request, FIXTURE_NOW);
    expect(output.recommendation?.amount).toBe("152");
    output.recommendation = resizeAction(request, output, output.recommendation!, 200n * FIXED_SCALE);
    const evaluation = evaluateLendingRescue(request, output, "positioncrew:evaluator:lending-rescue:v1", FIXTURE_NOW);
    expect(evaluation.passed).toBe(false);
    expect(evaluation.checks.find((entry) => entry.id === "decision")?.passed).toBe(false);
  });

  it("applies minimum sizing to alternatives without forcing the native action choice", () => {
    const request = lendingFixture();
    const output = createLendingRescueDeliverable(request, FIXTURE_NOW);
    const repayment = output.recommendation!;
    const collateral = output.alternatives[0]!;
    output.recommendation = collateral;
    output.decision = collateral.kind;
    output.alternatives = [repayment];
    expect(evaluateFinancialInvariants(request, output).every((entry) => entry.passed)).toBe(true);
    output.alternatives = [resizeAction(request, output, repayment, 200n * FIXED_SCALE)];
    expect(evaluateFinancialInvariants(request, output).find((entry) => entry.id === "decision")?.passed).toBe(false);
  });
});

function lpRequest() {
  const request = LpRebalanceRequestSchema.parse(JSON.parse(readFileSync(new URL("../fixtures/lp-rebalance/out-of-range-v3-position.v1.json", import.meta.url), "utf8")));
  request.marketState.token1PriceUsd = "1";
  request.constraints.minimumNetBenefitUsd = "0";
  request.constraints.estimatedGasUsd = "0";
  request.constraints.estimatedSwapCostUsd = "0";
  return request;
}

describe("LP decision labels bind to actual range width", () => {
  it.each(["WIDEN", "NARROW"] as const)("rejects an otherwise valid %s relabeled SHIFT", (decision) => {
    const request = lpRequest();
    request.marketState.currentTick = 0;
    if (decision === "WIDEN") request.marketState.realizedVolatilityBps = 2000;
    else {
      request.position.lowerTick = -480;
      request.position.upperTick = 480;
      request.constraints.maximumWidthTicks = 1200;
      request.marketState.realizedVolatilityBps = 100;
    }
    const output = createLpRebalanceDeliverable(request, FIXTURE_NOW);
    expect(output.status).toBe("ACTIONABLE");
    expect(output.decision).toBe(decision);
    expect(evaluateFinancialInvariants(request, output).every((entry) => entry.passed)).toBe(true);
    output.decision = "SHIFT";
    expect(evaluateFinancialInvariants(request, output).filter((entry) => !entry.passed).map((entry) => entry.id)).toEqual(["lp-range-decision"]);
  });

  it("accepts a genuine width-preserving SHIFT but not a directional relabel", () => {
    const request = lpRequest();
    const output = createLpRebalanceDeliverable(request, FIXTURE_NOW);
    expect(output.status).toBe("ACTIONABLE");
    expect(output.decision).toBe("SHIFT");
    expect(evaluateFinancialInvariants(request, output).every((entry) => entry.passed)).toBe(true);
    for (const decision of ["WIDEN", "NARROW"] as const) {
      expect(evaluateFinancialInvariants(request, { ...output, decision }).find((entry) => entry.id === "lp-range-decision")?.passed).toBe(false);
    }
  });

  it.each([
    { minimum: 300, maximum: 600, decision: "WIDEN" },
    { minimum: 120, maximum: 180, decision: "NARROW" },
  ] as const)("keeps the native label truthful when a requested shift is bounded to $decision", ({ minimum, maximum, decision }) => {
    const request = lpRequest();
    request.constraints.minimumWidthTicks = minimum;
    request.constraints.maximumWidthTicks = maximum;
    const output = createLpRebalanceDeliverable(request, FIXTURE_NOW);
    expect(output.status).toBe("ACTIONABLE");
    expect(output.decision).toBe(decision);
    expect(evaluateFinancialInvariants(request, output).every((entry) => entry.passed)).toBe(true);
  });
});
