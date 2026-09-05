import { describe, expect, it } from "vitest";
import { LendingRescueDeliverableSchema } from "../src/contracts/lending-rescue.js";
import { evaluateFinancialInvariants } from "../src/evaluators/financial-invariants.js";
import { evaluateProviderConformance } from "../src/evaluators/provider-conformance.js";
import { createLendingRescueDeliverable } from "../src/providers/lending-rescue.js";
import { lendingThresholdPlan, metricsFor } from "../web/src/presentation.js";
import { FIXTURE_NOW, lendingFixture } from "./helpers.js";

function payoffRequest() {
  const request = lendingFixture();
  request.position.collateral.forEach((asset) => { asset.collateralEnabled = false; });
  request.allowedActions = ["REPAY_DEBT"];
  request.maxActionUsd = "920";
  request.availableAssets.find((asset) => asset.symbol === "USDT")!.availableAmount = "920";
  return request;
}

function receipt(request: ReturnType<typeof lendingFixture>, output = createLendingRescueDeliverable(request, FIXTURE_NOW)) {
  return evaluateProviderConformance(request, output, "positioncrew:full-payoff-regression", FIXTURE_NOW);
}

describe("debt-clearing Lending repayment", () => {
  it("offers and independently admits full repayment with no finite projected health factor", () => {
    const request = payoffRequest();
    const output = createLendingRescueDeliverable(request, FIXTURE_NOW);
    expect(output.status).toBe("ACTIONABLE");
    expect(output.recommendation).toMatchObject({
      kind: "REPAY_DEBT", amount: "920", amountUsd: "920",
      amountBaseUnits: "920000000000000000000", projectedHealthFactor: null,
    });
    expect(output.summary).toContain("clear all observed debt");
    expect(LendingRescueDeliverableSchema.safeParse(output).success).toBe(true);
    expect(evaluateFinancialInvariants(request, output).every((check) => check.passed)).toBe(true);
    expect(receipt(request, output)).toMatchObject({ passed: true, score: 100 });
    expect(metricsFor(output).find((metric) => metric.label === "Projected health")?.value).toBe("No debt");
    expect(JSON.stringify(lendingThresholdPlan(output, request))).toContain("clear all observed debt");
  });

  it("rejects the audited false constraint refusal when the whole debt is repayable", () => {
    const request = payoffRequest();
    const output = LendingRescueDeliverableSchema.parse({
      ...createLendingRescueDeliverable(request, FIXTURE_NOW),
      status: "REFUSED_CONSTRAINTS", decision: "NONE", recommendation: null, alternatives: [],
      summary: "No action available.", refusalReasons: ["No allowed rescue fits."],
    });
    expect(evaluateFinancialInvariants(request, output).find((check) => check.id === "decision")?.passed).toBe(false);
    expect(receipt(request, output).passed).toBe(false);
  });

  it.each(["wallet", "budget", "gas"] as const)("retains a real full-payoff refusal at the %s limit", (limit) => {
    const request = payoffRequest();
    if (limit === "wallet") request.availableAssets.find((asset) => asset.symbol === "USDT")!.availableAmount = "919.999999999999999999";
    if (limit === "budget") request.maxActionUsd = "919.999999999999999999";
    if (limit === "gas") request.estimatedGasUsd = "0.11";
    const output = createLendingRescueDeliverable(request, FIXTURE_NOW);
    expect(output.status).toBe("REFUSED_CONSTRAINTS");
    expect(receipt(request, output).passed).toBe(true);
  });

  it.each(["REPAY_DEBT", "ADD_COLLATERAL"] as const)("rejects a null projected factor while %s leaves debt outstanding", (kind) => {
    const request = lendingFixture();
    request.allowedActions = [kind];
    const output = createLendingRescueDeliverable(request, FIXTURE_NOW);
    expect(output.status).toBe("ACTIONABLE");
    output.recommendation!.projectedHealthFactor = null;
    expect(evaluateFinancialInvariants(request, output).every((check) => check.passed)).toBe(false);
    expect(receipt(request, output).passed).toBe(false);
  });

  it("rejects a finite projected factor for a debt-clearing action", () => {
    const request = payoffRequest();
    const output = createLendingRescueDeliverable(request, FIXTURE_NOW);
    output.recommendation!.projectedHealthFactor = "1.25";
    expect(receipt(request, output).passed).toBe(false);
  });

  it("does not pretend one asset repayment clears debt in a second asset", () => {
    const request = payoffRequest();
    const debt = request.position.debt[0]!;
    request.position.debt = [
      { ...debt, amount: "460" },
      { ...debt, address: "0x3333333333333333333333333333333333333333", symbol: "USDC", amount: "460" },
    ];
    request.availableAssets.push({ ...request.availableAssets.find((asset) => asset.symbol === "USDT")!,
      address: request.position.debt[1]!.address, symbol: "USDC", availableAmount: "920" });
    const output = createLendingRescueDeliverable(request, FIXTURE_NOW);
    expect(output.status).toBe("REFUSED_CONSTRAINTS");
    expect(receipt(request, output).passed).toBe(true);
  });
});
