import { describe, expect, it } from "vitest";
import { LendingRescueDeliverableSchema, type LendingRescueRequest } from "../src/contracts/lending-rescue.js";
import { evaluateFinancialInvariants } from "../src/evaluators/financial-invariants.js";
import { evaluateProviderConformance } from "../src/evaluators/provider-conformance.js";
import { createLendingRescueDeliverable } from "../src/providers/lending-rescue.js";
import { FIXTURE_NOW, lendingFixture } from "./helpers.js";

const evaluatorId = "positioncrew:independent-refusal-feasibility";

function constraintRefusal(request: LendingRescueRequest) {
  return LendingRescueDeliverableSchema.parse({
    ...createLendingRescueDeliverable(request, FIXTURE_NOW),
    status: "REFUSED_CONSTRAINTS", decision: "NONE", recommendation: null, alternatives: [],
    summary: "No permitted rescue was offered.", refusalReasons: ["The provider claims that no action fits the limits."],
  });
}

function expectRefusal(request: LendingRescueRequest, allowed: boolean) {
  const output = constraintRefusal(request);
  expect(evaluateFinancialInvariants(request, output).find((entry) => entry.id === "decision")?.passed).toBe(allowed);
  const receipt = evaluateProviderConformance(request, output, evaluatorId, FIXTURE_NOW);
  expect(receipt.passed).toBe(allowed);
  if (allowed) expect(receipt.score).toBe(100);
  else {
    expect(receipt.score).toBeLessThan(100);
    expect(receipt.checks.find((entry) => entry.id === "financial-invariants")?.passed).toBe(false);
  }
}

describe("independent single-asset Lending refusal feasibility", () => {
  it("rejects the audited false refusal of the funded canonical position", () => {
    expectRefusal(lendingFixture(), false);
  });

  it.each(["REPAY_DEBT", "ADD_COLLATERAL"] as const)("finds a feasible %s without requiring the native preferred action", (kind) => {
    const request = lendingFixture();
    request.allowedActions = [kind];
    expectRefusal(request, false);
  });

  it.each(["USDT", "WBNB"])("checks other available assets when %s has no wallet balance", (symbol) => {
    const request = lendingFixture();
    request.availableAssets.find((asset) => asset.symbol === symbol)!.availableAmount = "0";
    expectRefusal(request, false);
  });

  it("accepts a real inventory refusal", () => {
    const request = lendingFixture();
    request.availableAssets.forEach((asset) => { asset.availableAmount = "0"; });
    expectRefusal(request, true);
  });

  it("does not use a funded collateral action when only repayment is allowed", () => {
    const request = lendingFixture();
    request.allowedActions = ["REPAY_DEBT"];
    request.availableAssets.find((asset) => asset.symbol === "USDT")!.availableAmount = "0";
    expectRefusal(request, true);
  });

  it("accepts a real gas-ceiling refusal", () => {
    const request = lendingFixture();
    request.estimatedGasUsd = "0.11";
    expectRefusal(request, true);
  });

  it.each([
    ["152", false], ["151.999999999999999999", true],
  ] as const)("checks the exact repayment action budget %s", (budget, allowed) => {
    const request = lendingFixture();
    request.allowedActions = ["REPAY_DEBT"];
    request.maxActionUsd = budget;
    expectRefusal(request, allowed);
  });

  it.each([
    ["152", false], ["151.999999999999999999", true],
  ] as const)("checks the exact repayment wallet balance %s", (balance, allowed) => {
    const request = lendingFixture();
    request.allowedActions = ["REPAY_DEBT"];
    request.availableAssets.find((asset) => asset.symbol === "USDT")!.availableAmount = balance;
    expectRefusal(request, allowed);
  });

  it.each([
    ["0.395833333333333334", false], ["0.395833333333333333", true],
  ] as const)("checks collateral funding after executable token rounding: %s", (balance, allowed) => {
    const request = lendingFixture();
    request.allowedActions = ["ADD_COLLATERAL"];
    request.availableAssets.find((asset) => asset.symbol === "WBNB")!.availableAmount = balance;
    expectRefusal(request, allowed);
  });

  it.each([["161.2", true], ["161.6", false]] as const)("checks the post-rounding dollar cost at budget %s", (budget, allowed) => {
    const request = lendingFixture();
    request.allowedActions = ["REPAY_DEBT"];
    request.position.debt[0]!.decimals = 0;
    request.position.debt[0]!.priceUsd = "1.01";
    request.availableAssets.find((asset) => asset.symbol === "USDT")!.decimals = 0;
    request.maxActionUsd = budget;
    expectRefusal(request, allowed);
  });

  it("never treats disabled collateral as an available rescue route", () => {
    const request = lendingFixture();
    request.allowedActions = ["ADD_COLLATERAL"];
    request.position.collateral[0]!.collateralEnabled = false;
    expectRefusal(request, true);
  });

  it("requires one repayable debt balance and checks later assets instead of assuming split repayment", () => {
    const request = lendingFixture();
    request.allowedActions = ["REPAY_DEBT"];
    const first = request.position.debt[0]!;
    first.amount = "100";
    const second = { ...first, symbol: "USDC", address: "0x3333333333333333333333333333333333333333", amount: "820" };
    request.position.debt.push(second);
    expectRefusal(request, true);
    request.availableAssets.push({ symbol: second.symbol, address: second.address, decimals: second.decimals, availableAmount: "152" });
    expectRefusal(request, false);
  });

  it("preserves the completed empty-position refusal", () => {
    const request = lendingFixture();
    request.position = { collateral: [], debt: [] };
    expectRefusal(request, true);
  });

  it("keeps healthy no-action decisions distinct from constraint refusals", () => {
    const request = lendingFixture();
    request.position.debt[0]!.amount = "100";
    const output = createLendingRescueDeliverable(request, FIXTURE_NOW);
    expect(output.status).toBe("NO_ACTION");
    expect(evaluateProviderConformance(request, output, evaluatorId, FIXTURE_NOW).passed).toBe(true);
    expectRefusal(request, false);
  });

  it("does not override an authentic stale-data refusal because a mathematical rescue exists", () => {
    const request = lendingFixture();
    request.maxDataAgeSeconds = 15;
    const output = createLendingRescueDeliverable(request, FIXTURE_NOW);
    expect(output.status).toBe("REFUSED_STALE_DATA");
    expect(evaluateProviderConformance(request, output, evaluatorId, FIXTURE_NOW).passed).toBe(true);
  });
});
