import { describe, expect, it } from "vitest";
import gridFixture from "../fixtures/bounded-grid/bnb-usdt-grid.v1.json" with { type: "json" };
import yieldFixture from "../fixtures/yield-optimization/venus-to-beefy.v1.json" with { type: "json" };
import { BoundedGridRequestSchema } from "../src/contracts/bounded-grid.js";
import { ProviderStatusSchema } from "../src/contracts/common.js";
import type { PositionCrewDeliverable, PositionCrewRequest } from "../src/contracts/index.js";
import { YieldOptimizationRequestSchema } from "../src/contracts/yield-optimization.js";
import { evaluateFinancialInvariants } from "../src/evaluators/financial-invariants.js";
import { evaluateProviderConformance } from "../src/evaluators/provider-conformance.js";
import { executeProvider } from "../src/providers/index.js";
import { FIXTURE_NOW } from "./helpers.js";

const evaluatorId = "positioncrew:inactive-decision-admission-regression";
const refusalStatuses = ProviderStatusSchema.options.filter((status) => status.startsWith("REFUSED_"));
const services = [
  { service: "BOUNDED_GRID", inactiveDecision: "NO_GRID", checkId: "grid-inactive-payload" },
  { service: "YIELD_OPTIMIZATION", inactiveDecision: "HOLD", checkId: "yield-inactive-payload" },
] as const;

function evaluate(request: PositionCrewRequest, output: PositionCrewDeliverable) {
  return evaluateProviderConformance(request, output, evaluatorId, FIXTURE_NOW);
}

function nativeInactive(service: "BOUNDED_GRID" | "YIELD_OPTIMIZATION", stale: boolean) {
  const request = service === "BOUNDED_GRID"
    ? BoundedGridRequestSchema.parse(structuredClone(gridFixture))
    : YieldOptimizationRequestSchema.parse(structuredClone(yieldFixture));
  // These are the established inactive examples from the economics regressions.
  if (request.service === "YIELD_OPTIMIZATION") request.maxActionUsd = "0.000000000000000001";
  if (stale) request.maxDataAgeSeconds = 15;
  const output = executeProvider(request, FIXTURE_NOW);
  if (output.service !== "BOUNDED_GRID" && output.service !== "YIELD_OPTIMIZATION") {
    throw new Error("Expected a Grid or Yield deliverable.");
  }
  expect(output.service).toBe(service);
  expect(output.status).toBe(stale ? "REFUSED_STALE_DATA" : "NO_ACTION");
  expect(output.decision).toBe(stale ? "NONE" : service === "BOUNDED_GRID" ? "NO_GRID" : "HOLD");
  const receipt = evaluate(request, output);
  expect(receipt.passed).toBe(true);
  expect(receipt.score).toBe(100);
  return { request, output };
}

function expectDecisionRejected(request: PositionCrewRequest, output: PositionCrewDeliverable, checkId: string) {
  expect(evaluateFinancialInvariants(request, output).find((check) => check.id === checkId)?.passed).toBe(false);
  const receipt = evaluate(request, output);
  expect(receipt.passed).toBe(false);
  expect(receipt.score).toBeLessThan(100);
  expect(receipt.checks.find((check) => check.id === checkId)?.passed).toBe(false);
  expect(receipt.checks.find((check) => check.id === "financial-invariants")?.passed).toBe(false);
}

for (const { service, inactiveDecision, checkId } of services) {
  describe(`${service} inactive status and decision admission`, () => {
    it(`admits native NO_ACTION with ${inactiveDecision}`, () => {
      const { request, output } = nativeInactive(service, false);
      expect(evaluateFinancialInvariants(request, output).find((check) => check.id === checkId)?.passed).toBe(true);
    });

    it("rejects NONE on an otherwise unchanged native NO_ACTION result", () => {
      const { request, output } = nativeInactive(service, false);
      output.decision = "NONE";
      expectDecisionRejected(request, output, checkId);
    });

    it("admits the native stale-data refusal with NONE", () => {
      const { request, output } = nativeInactive(service, true);
      expect(evaluateFinancialInvariants(request, output).find((check) => check.id === checkId)?.passed).toBe(true);
    });

    it(`rejects ${inactiveDecision} on an otherwise unchanged native stale-data refusal`, () => {
      const { request, output } = nativeInactive(service, true);
      if (output.service === "BOUNDED_GRID") output.decision = "NO_GRID";
      else output.decision = "HOLD";
      expectDecisionRejected(request, output, checkId);
    });

    it.each(refusalStatuses)("requires NONE for %s in the independent inactive-payload rule", (status) => {
      const { request, output } = nativeInactive(service, true);
      // Isolate the status/decision rule without fabricating a request that triggers
      // each refusal reason. Only the unchanged stale case is a native refusal claim.
      output.status = status;
      output.decision = "NONE";
      expect(evaluateFinancialInvariants(request, output).find((check) => check.id === checkId)?.passed).toBe(true);
      if (output.service === "BOUNDED_GRID") output.decision = "NO_GRID";
      else output.decision = "HOLD";
      expectDecisionRejected(request, output, checkId);
    });
  });
}
