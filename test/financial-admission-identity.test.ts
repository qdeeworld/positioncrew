import { describe, expect, it } from "vitest";
import gridFixture from "../fixtures/bounded-grid/bnb-usdt-grid.v1.json" with { type: "json" };
import { BoundedGridDeliverableSchema, BoundedGridRequestSchema } from "../src/contracts/bounded-grid.js";
import { evaluateFinancialInvariants } from "../src/evaluators/financial-invariants.js";
import { evaluateProviderConformance } from "../src/evaluators/provider-conformance.js";
import { createBoundedGridDeliverable } from "../src/providers/bounded-grid.js";
import { createLendingRescueDeliverable } from "../src/providers/lending-rescue.js";
import { FIXTURE_NOW, lendingFixture } from "./helpers.js";

const evaluatorId = "positioncrew:admission-identity-regression";

function lending() {
  const request = lendingFixture();
  const output = createLendingRescueDeliverable(request, FIXTURE_NOW);
  expect(output.status).toBe("ACTIONABLE");
  expect(output.recommendation).not.toBeNull();
  expect(output.alternatives.length).toBeGreaterThan(0);
  return { request, output };
}

describe("Lending admission binds the full requested asset identity", () => {
  it("accepts unchanged native recommendation and alternative identities", () => {
    const { request, output } = lending();
    const receipt = evaluateProviderConformance(request, output, evaluatorId, FIXTURE_NOW);
    expect(receipt.passed).toBe(true);
    expect(receipt.score).toBe(100);
  });

  it.each(["recommendation", "alternative"] as const)("rejects a relabeled %s with the correct address and decimals", (field) => {
    const { request, output } = lending();
    const action = field === "recommendation" ? output.recommendation! : output.alternatives[0]!;
    action.asset.symbol = "UNRELATED";
    expect(evaluateFinancialInvariants(request, output).find((entry) => entry.id === "decision")?.passed).toBe(false);
    const receipt = evaluateProviderConformance(request, output, evaluatorId, FIXTURE_NOW);
    expect(receipt.passed).toBe(false);
    expect(receipt.score).toBeLessThan(100);
  });

  it.each(["position", "available"] as const)("rejects conflicting %s metadata even when the action matches the other source", (source) => {
    const { request, output } = lending();
    const action = output.recommendation!;
    const entries = source === "available" ? request.availableAssets
      : action.kind === "REPAY_DEBT" ? request.position.debt : request.position.collateral;
    const asset = entries.find((entry) => entry.address.toLowerCase() === action.asset.address.toLowerCase())!;
    asset.symbol = "UNRELATED";
    const receipt = evaluateProviderConformance(request, output, evaluatorId, FIXTURE_NOW);
    expect(receipt.passed).toBe(false);
    expect(receipt.checks.find((entry) => entry.id === "decision")?.passed).toBe(false);
  });

  it("uses the request identity rather than a hardcoded token-symbol allowlist", () => {
    const request = lendingFixture();
    for (const asset of [...request.position.collateral, ...request.position.debt, ...request.availableAssets]) {
      asset.symbol = `T${asset.address.slice(-6)}`;
    }
    const output = createLendingRescueDeliverable(request, FIXTURE_NOW);
    expect(output.status).toBe("ACTIONABLE");
    expect(evaluateProviderConformance(request, output, evaluatorId, FIXTURE_NOW).passed).toBe(true);
  });
});

describe("current Grid admission requires an explicit risk model", () => {
  function grid() {
    const request = BoundedGridRequestSchema.parse(structuredClone(gridFixture));
    request.constraints.minimumExpectedNetProfitUsd = "0";
    const output = createBoundedGridDeliverable(request, FIXTURE_NOW);
    expect(output.status).toBe("ACTIONABLE");
    return { request, output };
  }

  it("admits the current model with valid finite-grid economics", () => {
    const { request, output } = grid();
    expect(output.riskModel).toBe("FINITE_GRID_ZERO_PRICE_STRESS_V1");
    const receipt = evaluateProviderConformance(request, output, evaluatorId, FIXTURE_NOW);
    expect(receipt.passed).toBe(true);
    expect(receipt.score).toBe(100);
    expect(receipt.checks.find((entry) => entry.id === "grid-risk-model")?.passed).toBe(true);
  });

  it("keeps archived parsing permissive but refuses a newly admitted action without its model", () => {
    const { request, output } = grid();
    delete output.riskModel;
    expect(BoundedGridDeliverableSchema.safeParse(output).success).toBe(true);
    expect(evaluateFinancialInvariants(request, output).find((entry) => entry.id === "grid-risk-model")?.passed).toBe(false);
    const receipt = evaluateProviderConformance(request, output, evaluatorId, FIXTURE_NOW);
    expect(receipt.passed).toBe(false);
    expect(receipt.score).toBeLessThan(100);
    expect(receipt.checks.find((entry) => entry.id === "financial-invariants")?.passed).toBe(false);
  });

  it("does not require risk-model claims on an inactive result with no financial projection", () => {
    const request = BoundedGridRequestSchema.parse(structuredClone(gridFixture));
    const output = createBoundedGridDeliverable(request, FIXTURE_NOW);
    expect(output.status).toBe("NO_ACTION");
    delete output.riskModel;
    expect(BoundedGridDeliverableSchema.safeParse(output).success).toBe(true);
    expect(evaluateProviderConformance(request, output, evaluatorId, FIXTURE_NOW).passed).toBe(true);
  });
});
