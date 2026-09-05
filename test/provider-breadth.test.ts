import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BoundedGridRequestSchema,
  LpRebalanceRequestSchema,
  YieldOptimizationRequestSchema,
} from "../src/contracts/index.js";
import { createBoundedGridDeliverable } from "../src/providers/bounded-grid.js";
import { createLpRebalanceDeliverable } from "../src/providers/lp-rebalance.js";
import { createYieldOptimizationDeliverable } from "../src/providers/yield-optimization.js";
import { evaluateProviderConformance } from "../src/evaluators/provider-conformance.js";
import { FIXTURE_NOW } from "./helpers.js";

function fixture(relativePath: string): unknown {
  const path = fileURLToPath(new URL(`../fixtures/${relativePath}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("main-track provider breadth", () => {
  it("declines the legacy synthetic LP candidate without claiming every alternative is impossible", () => {
    const request = LpRebalanceRequestSchema.parse(
      fixture("lp-rebalance/out-of-range-v3-position.v1.json"),
    );
    const result = createLpRebalanceDeliverable(request, FIXTURE_NOW);

    expect(result).toMatchObject({ status: "NO_ACTION", decision: "HOLD" });
    expect(result.proposedRange).toBeNull();
  });

  it("holds an LP when execution cost erases the benefit", () => {
    const request = LpRebalanceRequestSchema.parse(
      fixture("lp-rebalance/out-of-range-v3-position.v1.json"),
    );
    request.constraints.estimatedSwapCostUsd = "50";
    request.marketState.token1PriceUsd = "1";
    const result = createLpRebalanceDeliverable(request, FIXTURE_NOW);

    expect(result.status).toBe("NO_ACTION");
    expect(result.decision).toBe("HOLD");
  });

  it("treats the V3 upper tick as outside the half-open liquidity range", () => {
    const request = LpRebalanceRequestSchema.parse(
      fixture("lp-rebalance/out-of-range-v3-position.v1.json"),
    );
    request.marketState.currentTick = request.position.upperTick;
    request.marketState.token1PriceUsd = "1";
    const result = createLpRebalanceDeliverable(request, FIXTURE_NOW);

    expect(result.status).toBe("ACTIONABLE");
    expect(result.decision).toBe("SHIFT");
  });

  it("selects a bounded yield migration after costs and risk filters", () => {
    const request = YieldOptimizationRequestSchema.parse(
      fixture("yield-optimization/venus-to-beefy.v1.json"),
    );
    const result = createYieldOptimizationDeliverable(request, FIXTURE_NOW);

    expect(result.status).toBe("ACTIONABLE");
    expect(result.decision).toBe("MIGRATE");
    expect(result.selectedOpportunityId).toBe("beefy-usdt-vault");
    expect(result.currentWeightedApyBps).toBe(400);
    expect(result.grossApyBps).toBe(900);
    expect(Number(result.netBenefitUsd)).toBeGreaterThan(5);
  });

  it("holds yield when the route cannot recover its costs", () => {
    const request = YieldOptimizationRequestSchema.parse(
      fixture("yield-optimization/venus-to-beefy.v1.json"),
    );
    request.opportunities[0]!.estimatedEntryCostUsd = "20";
    const result = createYieldOptimizationDeliverable(request, FIXTURE_NOW);

    expect(result.status).toBe("NO_ACTION");
    expect(result.decision).toBe("HOLD");
  });

  it("refuses the historical grid when truthful risk sizing cannot fund its requested profit", () => {
    const request = BoundedGridRequestSchema.parse(
      fixture("bounded-grid/bnb-usdt-grid.v1.json"),
    );
    const result = createBoundedGridDeliverable(request, FIXTURE_NOW);

    expect(result.status).toBe("NO_ACTION");
    expect(result.decision).toBe("NO_GRID");
    expect(result.orders).toEqual([]);
  });

  it("rejects a grid when volatility exceeds policy", () => {
    const request = BoundedGridRequestSchema.parse(
      fixture("bounded-grid/bnb-usdt-grid.v1.json"),
    );
    request.marketState.realizedVolatilityBps = 1_001;
    const result = createBoundedGridDeliverable(request, FIXTURE_NOW);

    expect(result.status).toBe("NO_ACTION");
    expect(result.decision).toBe("NO_GRID");
    expect(result.orders).toEqual([]);
  });

  it("accepts a financially valid explanation change without equating wording with correctness", () => {
    const request = LpRebalanceRequestSchema.parse(
      fixture("lp-rebalance/out-of-range-v3-position.v1.json"),
    );
    const deliverable = createLpRebalanceDeliverable(request, FIXTURE_NOW);
    const tampered = { ...deliverable, summary: "A different result." };
    const evaluation = evaluateProviderConformance(
      request,
      tampered,
      "positioncrew:evaluator:lp_rebalance:v1",
      FIXTURE_NOW,
    );

    expect(evaluation.passed).toBe(true);
    expect(evaluation.score).toBe(100);
    expect(evaluation.checks.some((check) => check.id === "deterministic-output")).toBe(false);
  });
});
