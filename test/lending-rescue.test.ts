import { describe, expect, it } from "vitest";
import { evaluateLendingRescue } from "../src/evaluators/lending-rescue.js";
import { createLendingRescueDeliverable } from "../src/providers/lending-rescue.js";
import { FIXTURE_NOW, lendingFixture } from "./helpers.js";

describe("lending rescue provider", () => {
  it("returns the smallest safe action with exact base units", () => {
    const request = lendingFixture();
    const result = createLendingRescueDeliverable(request, FIXTURE_NOW);

    expect(result.status).toBe("ACTIONABLE");
    expect(result.position.currentHealthFactor).toBe("1.04347826");
    expect(result.position.stressedHealthFactor).toBe("0.93913043");
    expect(result.recommendation).toMatchObject({
      kind: "REPAY_DEBT",
      amount: "152",
      amountBaseUnits: "152000000000000000000",
      amountUsd: "152",
      projectedHealthFactor: "1.25",
    });
    expect(result.alternatives[0]).toMatchObject({
      kind: "ADD_COLLATERAL",
      amountUsd: "237.5",
      projectedHealthFactor: "1.25",
    });
  });

  it("refuses stale evidence instead of returning an action", () => {
    const request = lendingFixture();
    request.maxDataAgeSeconds = 15;
    const result = createLendingRescueDeliverable(request, FIXTURE_NOW);

    expect(result.status).toBe("REFUSED_STALE_DATA");
    expect(result.recommendation).toBeNull();
    expect(result.refusalReasons[0]).toContain("freshness limit");
  });

  it("refuses when neither action fits available inventory", () => {
    const request = lendingFixture();
    request.availableAssets = request.availableAssets.map((asset) => ({
      ...asset,
      availableAmount: asset.symbol === "USDT" ? "100" : "0.1",
    }));
    const result = createLendingRescueDeliverable(request, FIXTURE_NOW);

    expect(result.status).toBe("REFUSED_CONSTRAINTS");
    expect(result.recommendation).toBeNull();
  });

  it("does not create unnecessary work for a healthy position", () => {
    const request = lendingFixture();
    request.position.debt[0]!.amount = "700";
    const result = createLendingRescueDeliverable(request, FIXTURE_NOW);

    expect(result.status).toBe("NO_ACTION");
    expect(result.recommendation).toBeNull();
  });

  it("returns an explicit refusal for an empty block-pinned position", () => {
    const request = lendingFixture();
    request.position = { collateral: [], debt: [] };
    const result = createLendingRescueDeliverable(request, FIXTURE_NOW);

    expect(result.status).toBe("REFUSED_CONSTRAINTS");
    expect(result.recommendation).toBeNull();
    expect(result.refusalReasons[0]).toContain("collateral balance");
  });
});

describe("lending rescue evaluator", () => {
  it("scores the valid fixture at 100", () => {
    const request = lendingFixture();
    const result = createLendingRescueDeliverable(request, FIXTURE_NOW);
    const evaluation = evaluateLendingRescue(
      request,
      result,
      "positioncrew:evaluator:lending-rescue:v1",
      FIXTURE_NOW,
    );

    expect(evaluation.score).toBe(100);
    expect(evaluation.passed).toBe(true);
    expect(evaluation.checks.every((check) => check.passed)).toBe(true);
  });

  it("rejects a tampered projected result", () => {
    const request = lendingFixture();
    const result = createLendingRescueDeliverable(request, FIXTURE_NOW);
    const tampered = structuredClone(result);
    tampered.recommendation!.projectedHealthFactor = "9.99";
    const evaluation = evaluateLendingRescue(
      request,
      tampered,
      "positioncrew:evaluator:lending-rescue:v1",
      FIXTURE_NOW,
    );

    expect(evaluation.passed).toBe(false);
    expect(evaluation.checks.find((check) => check.id === "decision")?.passed).toBe(false);
  });

  it("rejects the wrong non-action reason", () => {
    const request = lendingFixture();
    request.position.debt[0]!.amount = "700";
    const result = createLendingRescueDeliverable(request, FIXTURE_NOW);
    const tampered = structuredClone(result);
    tampered.status = "REFUSED_CONSTRAINTS";
    tampered.summary = "No action fits constraints.";
    tampered.refusalReasons = ["Artificial refusal."];
    const evaluation = evaluateLendingRescue(
      request,
      tampered,
      "positioncrew:evaluator:lending-rescue:v1",
      FIXTURE_NOW,
    );

    expect(evaluation.passed).toBe(false);
    expect(evaluation.checks.find((check) => check.id === "decision")?.passed).toBe(false);
  });
});
