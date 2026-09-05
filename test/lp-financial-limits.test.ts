import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LpRebalanceRequestSchema } from "../src/contracts/lp-rebalance.js";
import { boundedLpRange, lpInventoryExposure } from "../src/core/lp-range.js";
import { createLpRebalanceDeliverable } from "../src/providers/lp-rebalance.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/lp-rebalance/out-of-range-v3-position.v1.json", import.meta.url), "utf8"));
const now = new Date("2026-08-12T16:00:30Z");
function input() { return LpRebalanceRequestSchema.parse(structuredClone(fixture)); }

describe("LP final financial limits", () => {
  it("fits an odd number of tick spacings without outward half rounding", () => {
    const request = input();
    Object.assign(request.constraints, { minimumWidthTicks: 100, maximumWidthTicks: 250, tickSpacing: 50 });
    request.marketState.currentTick = 0;
    const range = boundedLpRange(request, 300)!;
    expect(range.upperTick - range.lowerTick).toBe(250);
    expect(range.lowerTick % 50).toBe(-0);
    expect(range.upperTick % 50).toBe(0);
  });
  it("never exceeds the reproduced 180-tick buyer cap", () => {
    const request = input();
    request.constraints.maximumWidthTicks = 180;
    const range = boundedLpRange(request, 240)!;
    expect(range.upperTick - range.lowerTick).toBe(180);
    const result = createLpRebalanceDeliverable(request, now);
    if (result.status === "ACTIONABLE") {
      expect(result.proposedRange!.upperTick - result.proposedRange!.lowerTick).toBeLessThanOrEqual(180);
    } else expect(result.status).toBe("REFUSED_CONSTRAINTS");
  });
  it("refuses when no aligned width exists", () => {
    const request = input();
    Object.assign(request.constraints, { minimumWidthTicks: 61, maximumWidthTicks: 119, tickSpacing: 60 });
    expect(boundedLpRange(request, 100)).toBeNull();
    expect(createLpRebalanceDeliverable(request, now).status).toBe("REFUSED_CONSTRAINTS");
  });
  it("keeps feasible ranges in the V3 domain and rejects an unrepresentable spot", () => {
    const request = input();
    request.marketState.currentTick = 887219;
    const range = boundedLpRange(request, 180)!;
    expect(range.upperTick).toBeLessThanOrEqual(887272);
    expect(range.lowerTick).toBeLessThanOrEqual(request.marketState.currentTick);
    request.marketState.currentTick = 887272;
    expect(boundedLpRange(request, 180)).toBeNull();
  });
  it("values V3 inventory rather than reporting a fictitious 50/50 split", () => {
    const request = input();
    const range = boundedLpRange(request, 240)!;
    const shares = lpInventoryExposure(request, range)!;
    expect(shares.token1Bps).toBeGreaterThan(9900);
    expect(shares.token0Bps + shares.token1Bps).toBe(10000);
    expect(createLpRebalanceDeliverable(request, now).status).toBe("REFUSED_CONSTRAINTS");
  });
  it("still permits a useful action with coherent token values and affordable costs", () => {
    const request = input();
    request.marketState.token1PriceUsd = String(1 / 1.0001 ** request.marketState.currentTick);
    const result = createLpRebalanceDeliverable(request, now);
    expect(result.status).toBe("ACTIONABLE");
    expect(result.inventoryExposure.token0Bps).not.toBe(5000);
    expect(result.inventoryExposure.token0Bps).toBeLessThanOrEqual(7000);
    expect(result.inventoryExposure.token1Bps).toBeLessThanOrEqual(7000);
    expect(result.summary).toContain("assuming");
  });
  it("does not invent a widening or fee improvement when aligned bounds preserve the existing range", () => {
    const request = input();
    Object.assign(request.position, { lowerTick: -200, upperTick: 100 });
    Object.assign(request.marketState, { currentTick: 0, token1PriceUsd: "1", realizedVolatilityBps: 1500 });
    Object.assign(request.constraints, { minimumWidthTicks: 100, maximumWidthTicks: 350, tickSpacing: 100 });
    const result = createLpRebalanceDeliverable(request, now);
    expect(result.decision).toBe("HOLD");
    expect(result.expectedNetBenefitUsd).toBe("0");
    expect(result.actionSteps).toEqual([]);
  });
  it("computes break-even without dividing by a prematurely rounded hourly improvement", () => {
    const request = input();
    Object.assign(request.position, { lowerTick: 0, upperTick: 100, positionValueUsd: "0.000000000000000001" });
    Object.assign(request.marketState, { currentTick: 250, token1PriceUsd: String(1 / 1.0001 ** 250), poolLiquidityUsd: "1", fees24hUsd: "1" });
    Object.assign(request.constraints, { tickSpacing: 100, minimumWidthTicks: 100, maximumWidthTicks: 350,
      evaluationHorizonHours: 720, estimatedGasUsd: "0", estimatedSwapCostUsd: "0", minimumNetBenefitUsd: "0" });
    const result = createLpRebalanceDeliverable(request, now);
    expect(result.status).toBe("ACTIONABLE");
    expect(result.breakEvenHours).toBe("0");
    expect(result.expectedGrossFeesUsd).not.toBe("0");
  });
});
