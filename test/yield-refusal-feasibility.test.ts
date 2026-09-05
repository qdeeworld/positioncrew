import { describe, expect, it } from "vitest";
import fixture from "../fixtures/yield-optimization/venus-to-beefy.v1.json" with { type: "json" };
import { YieldOptimizationRequestSchema, type YieldOptimizationRequest } from "../src/contracts/yield-optimization.js";
import { FIXED_SCALE, formatFixed, parseFixed } from "../src/core/fixed.js";
import { evaluateFinancialInvariants } from "../src/evaluators/financial-invariants.js";
import { evaluateProviderConformance } from "../src/evaluators/provider-conformance.js";
import { yieldConstraintRefusalJustified } from "../src/evaluators/yield-refusal-feasibility.js";
import { createYieldOptimizationDeliverable } from "../src/providers/yield-optimization.js";
import { FIXTURE_NOW } from "./helpers.js";

const checkId = "yield-refusal-feasibility";
const evaluatorId = "positioncrew:yield-refusal-feasibility-regression";
const request = () => YieldOptimizationRequestSchema.parse(structuredClone(fixture));

function constraintRefusal(input: YieldOptimizationRequest) {
  const output = createYieldOptimizationDeliverable(input, FIXTURE_NOW);
  output.status = "REFUSED_CONSTRAINTS";
  output.decision = "NONE";
  output.selectedOpportunityId = null;
  output.allocationUsd = "0";
  output.grossApyBps = null;
  output.annualYieldUpliftUsd = "0";
  output.netBenefitUsd = "0";
  output.migrationCostUsd = "0";
  output.breakEvenDays = null;
  output.actionSteps = [];
  delete output.withdrawals;
  delete output.idleCapitalUsedUsd;
  delete output.finalProtocolAllocations;
  delete output.remainingIdleCapitalUsd;
  delete output.postMigrationCapitalUsd;
  return output;
}

function expectRefusalAdmission(input: YieldOptimizationRequest, justified: boolean) {
  const output = constraintRefusal(input);
  expect(yieldConstraintRefusalJustified(input)).toBe(justified);
  expect(evaluateFinancialInvariants(input, output).find((check) => check.id === checkId)?.passed).toBe(justified);
  const receipt = evaluateProviderConformance(input, output, evaluatorId, FIXTURE_NOW);
  expect(receipt.passed).toBe(justified);
  if (justified) expect(receipt.score).toBe(100);
  else {
    expect(receipt.score).toBeLessThan(100);
    expect(receipt.checks.find((check) => check.id === "financial-invariants")?.passed).toBe(false);
  }
}

describe("request-only Yield constraint refusal proofs", () => {
  it("rejects a forged refusal for the fresh feasible native fixture", () => {
    const input = request();
    expect(createYieldOptimizationDeliverable(input, FIXTURE_NOW).status).toBe("ACTIONABLE");
    expectRefusalAdmission(input, false);
  });

  const blockers: Array<{ name: string; change: (input: YieldOptimizationRequest) => void }> = [
    { name: "no allowlisted destination", change: (input) => { input.constraints.protocolAllowlist = ["Venus"]; } },
    { name: "no destination within the risk limit", change: (input) => { input.constraints.maximumRiskTier = "LOW"; } },
    { name: "no destination within the lockup limit", change: (input) => { input.opportunities[0]!.lockupSeconds = 1; } },
    { name: "no destination meeting minimum liquidity", change: (input) => { input.opportunities[0]!.liquidityUsd = "999999"; } },
    { name: "zero destination capacity", change: (input) => { input.opportunities[0]!.amountUsd = "0"; } },
    { name: "entry exceeds the gas cap", change: (input) => { input.maxGasUsd = "0.999999999999999999"; } },
    { name: "entry exceeds the separate action-cost cap", change: (input) => { input.maxActionUsd = "0.999999999999999999"; } },
    { name: "entry consumes all managed principal", change: (input) => { input.currentPositions = []; input.capitalUsd = "1"; } },
    { name: "all principal is locked with no idle funds", change: (input) => { input.currentPositions[0]!.lockupSeconds = 1; } },
    { name: "all held principal is illiquid", change: (input) => { input.currentPositions[0]!.liquidityUsd = "0"; } },
    { name: "only another asset can be withdrawn", change: (input) => { input.currentPositions[0]!.asset.address = "0x6666666666666666666666666666666666666666"; } },
    { name: "every available exit exceeds the route gas cap", change: (input) => { input.maxGasUsd = "1.999999999999999999"; } },
    { name: "mandatory exits consume every withdrawable dollar", change: (input) => {
      input.capitalUsd = "1";
      input.currentPositions[0]!.amountUsd = "1";
      input.opportunities[0]!.estimatedEntryCostUsd = "0";
    } },
  ];
  it.each(blockers)("admits a refusal proved by $name", ({ change }) => {
    const input = request();
    change(input);
    expectRefusalAdmission(input, true);
  });

  it("does not turn an exact affordable fee boundary into a refusal", () => {
    const input = request();
    input.maxGasUsd = "2";
    input.maxActionUsd = "2";
    expectRefusalAdmission(input, false);
  });

  it("preserves one unit of optimistic funding instead of rounding it to infeasibility", () => {
    const input = request();
    input.currentPositions = [];
    input.capitalUsd = "1.000000000000000001";
    expect(yieldConstraintRefusalJustified(input)).toBe(false);
  });

  it("does not charge unused expensive exits against a valid cheap route", () => {
    const input = request();
    input.constraints.minimumNetBenefitUsd = "0";
    input.currentPositions[0]!.amountUsd = "500";
    input.currentPositions.push({ ...structuredClone(input.currentPositions[0]!),
      opportunityId: "expensive-retained-position",
      vaultOrMarket: "0x7777777777777777777777777777777777777777",
      estimatedExitCostUsd: "100",
    });
    expect(yieldConstraintRefusalJustified(input)).toBe(false);
    expect(createYieldOptimizationDeliverable(input, FIXTURE_NOW).status).toBe("ACTIONABLE");
  });

  it("recognizes idle funding without requiring any unlocked current holding", () => {
    const input = request();
    input.currentPositions[0]!.amountUsd = "500";
    input.currentPositions[0]!.lockupSeconds = 3600;
    expect(yieldConstraintRefusalJustified(input)).toBe(false);
    const output = createYieldOptimizationDeliverable(input, FIXTURE_NOW);
    expect(output.status).toBe("ACTIONABLE");
    expect(output.decision).toBe("SUPPLY");
  });

  it.each(["minimumNetBenefitUsd", "maximumProtocolConcentrationBps"] as const)(
    "keeps an unproved %s decline as native HOLD rather than a constraint refusal", (constraint) => {
      const input = request();
      if (constraint === "minimumNetBenefitUsd") input.constraints.minimumNetBenefitUsd = "1000000";
      else input.constraints.maximumProtocolConcentrationBps = 1;
      expectRefusalAdmission(input, false);
      const output = createYieldOptimizationDeliverable(input, FIXTURE_NOW);
      expect(output.status).toBe("NO_ACTION");
      expect(output.decision).toBe("HOLD");
      expect(output.currentWeightedApyBps).toBe(400);
      expect(output.allocationUsd).toBe("0");
      expect(output.migrationCostUsd).toBe("0");
      expect(output.netBenefitUsd).toBe("0");
      expect(evaluateProviderConformance(input, output, evaluatorId, FIXTURE_NOW).passed).toBe(true);
    },
  );

  it("admits a hand-funded smaller migration rather than requiring the native allocation", () => {
    const input = request();
    const output = createYieldOptimizationDeliverable(input, FIXTURE_NOW);
    expect(output.status).toBe("ACTIONABLE");
    const annual = parseFixed("29.92"); // 600 * 9% minus 602 * 4%.
    Object.assign(output, {
      decision: "MIGRATE",
      allocationUsd: "600",
      annualYieldUpliftUsd: "29.92",
      netBenefitUsd: formatFixed(annual * 90n / 365n - parseFixed("2"), 18),
      migrationCostUsd: "2",
      breakEvenDays: formatFixed(parseFixed("2") * 365n * FIXED_SCALE / annual, 18),
      withdrawals: [{ opportunityId: "venus-usdt", amountUsd: "602" }],
      idleCapitalUsedUsd: "0",
      remainingIdleCapitalUsd: "0",
      postMigrationCapitalUsd: "998",
      finalProtocolAllocations: [{ protocol: "beefy", amountUsd: "600" }, { protocol: "venus", amountUsd: "398" }],
      summary: "Withdraw 602 USD from Venus, reserve 2 USD in route costs, and supply 600 USD to Beefy.",
      actionSteps: ["Withdraw 602 USD from Venus.", "Reserve 2 USD for entry and exit costs.", "Supply 600 USD to Beefy."],
    });
    expect(yieldConstraintRefusalJustified(input)).toBe(false);
    expect(evaluateFinancialInvariants(input, output).every((check) => check.passed)).toBe(true);
    const receipt = evaluateProviderConformance(input, output, evaluatorId, FIXTURE_NOW);
    expect(receipt.passed).toBe(true);
    expect(receipt.score).toBe(100);
  });

  it.each(["overcommitted", "duplicate-identifiers"] as const)("does not misclassify %s inputs as constraint infeasibility", (kind) => {
    const input = request();
    if (kind === "overcommitted") input.capitalUsd = "999";
    else input.opportunities[1]!.opportunityId = input.opportunities[0]!.opportunityId;
    expect(yieldConstraintRefusalJustified(input)).toBe(false);
    const output = createYieldOptimizationDeliverable(input, FIXTURE_NOW);
    expect(output.status).toBe("REFUSED_INCONSISTENT_DATA");
    expect(evaluateProviderConformance(input, output, evaluatorId, FIXTURE_NOW).passed).toBe(true);
  });

  it.each(["stale", "expired"] as const)("preserves the native %s evidence refusal", (kind) => {
    const input = request();
    if (kind === "stale") input.maxDataAgeSeconds = 15;
    const now = kind === "expired" ? new Date(input.deadline) : FIXTURE_NOW;
    const output = createYieldOptimizationDeliverable(input, now);
    expect(output.status).toBe(kind === "stale" ? "REFUSED_STALE_DATA" : "REFUSED_EXPIRED");
    expect(evaluateProviderConformance(input, output, evaluatorId, now).passed).toBe(true);
  });
});
