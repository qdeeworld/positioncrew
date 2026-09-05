import { describe, expect, it } from "vitest";
import lpFixture from "../fixtures/provider-conformance/lp-valid.v2.json" with { type: "json" };
import { LpRebalanceDeliverableSchema, LpRebalanceRequestSchema } from "../src/contracts/lp-rebalance.js";
import type { PositionCrewDeliverable, PositionCrewRequest } from "../src/contracts/index.js";
import { evaluateFinancialInvariants } from "../src/evaluators/financial-invariants.js";
import { evaluateProviderConformance } from "../src/evaluators/provider-conformance.js";
import { executeProvider } from "../src/providers/index.js";
import { FIXTURE_NOW } from "./helpers.js";

const evaluatorId = "positioncrew:lp-hold-uptime-admission-regression";
const checkId = "lp-inactive-fees";

function evaluate(request: PositionCrewRequest, output: PositionCrewDeliverable) {
  return evaluateProviderConformance(request, output, evaluatorId, FIXTURE_NOW);
}

function nativeHold() {
  const request = LpRebalanceRequestSchema.parse(structuredClone(lpFixture));
  // Reuse the genuine in-range HOLD from the existing LP economics regressions.
  request.marketState.currentTick = 0;
  request.marketState.token0PriceUsd = "1";
  request.position.token0ShareBps = 5_000;
  request.position.token1ShareBps = 5_000;
  const output = executeProvider(request, FIXTURE_NOW);
  if (output.service !== "LP_REBALANCE") throw new Error("Expected an LP deliverable.");
  expect(output.status).toBe("NO_ACTION");
  expect(output.decision).toBe("HOLD");
  expect(output.expectedGrossFeesUsd).toBe("18");
  expect(evaluate(request, output).passed).toBe(true);
  return { request, output };
}

function matchingProjection() {
  return {
    model: "POOL_SHARE_UPTIME_V1" as const,
    currentUptimeBps: 9_000,
    proposedUptimeBps: 9_000,
  };
}

function expectAdmitted(request: PositionCrewRequest, output: PositionCrewDeliverable) {
  expect(evaluateFinancialInvariants(request, output).find((check) => check.id === checkId)?.passed).toBe(true);
  const receipt = evaluate(request, output);
  expect(receipt.passed).toBe(true);
  expect(receipt.score).toBe(100);
}

function expectRejected(request: PositionCrewRequest, output: PositionCrewDeliverable) {
  expect(evaluateFinancialInvariants(request, output).find((check) => check.id === checkId)?.passed).toBe(false);
  const receipt = evaluate(request, output);
  expect(receipt.passed).toBe(false);
  expect(receipt.score).toBeLessThan(100);
  expect(receipt.checks.find((check) => check.id === checkId)?.passed).toBe(false);
  expect(receipt.checks.find((check) => check.id === "financial-invariants")?.passed).toBe(false);
}

describe("LP HOLD fees remain bound to request-derived current uptime", () => {
  it("admits the genuine native HOLD and its positive current-fee estimate", () => {
    const { request, output } = nativeHold();
    expectAdmitted(request, output);
  });

  it("keeps the projection field optional for archived-shaped HOLD payloads", () => {
    const { request, output } = nativeHold();
    delete output.feeProjection;
    expect(LpRebalanceDeliverableSchema.safeParse(output).success).toBe(true);
    expectAdmitted(request, output);
  });

  it("admits an explicit unchanged projection matching the request-derived uptime", () => {
    const { request, output } = nativeHold();
    output.feeProjection = matchingProjection();
    expectAdmitted(request, output);
  });

  it.each([
    { uptimeBps: 0, grossFeesUsd: "0" },
    { uptimeBps: 5_000, grossFeesUsd: "10" },
  ])("rejects a coherent but understated $grossFeesUsd USD estimate using $uptimeBps bps", ({ uptimeBps, grossFeesUsd }) => {
    const { request, output } = nativeHold();
    output.feeProjection = {
      model: "POOL_SHARE_UPTIME_V1",
      currentUptimeBps: uptimeBps,
      proposedUptimeBps: uptimeBps,
    };
    output.expectedGrossFeesUsd = grossFeesUsd;
    expect(LpRebalanceDeliverableSchema.safeParse(output).success).toBe(true);
    expectRejected(request, output);
  });

  it.each(["currentUptimeBps", "proposedUptimeBps"] as const)("rejects overriding %s even when the reported fees remain correct", (field) => {
    const { request, output } = nativeHold();
    output.feeProjection = matchingProjection();
    output.feeProjection[field] = 0;
    expectRejected(request, output);
  });

  it("rejects suppressing positive current fees when the optional projection is omitted", () => {
    const { request, output } = nativeHold();
    delete output.feeProjection;
    output.expectedGrossFeesUsd = "0";
    expect(LpRebalanceDeliverableSchema.safeParse(output).success).toBe(true);
    expectRejected(request, output);
  });
});
