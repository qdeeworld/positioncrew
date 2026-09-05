import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LpRebalanceRequestSchema, type LpRebalanceDeliverable, type LpRebalanceRequest } from "../src/contracts/lp-rebalance.js";
import { FIXED_SCALE, formatFixed, parseFixed } from "../src/core/fixed.js";
import { evaluateFinancialInvariants } from "../src/evaluators/financial-invariants.js";
import { evaluateProviderConformance } from "../src/evaluators/provider-conformance.js";
import { createLpRebalanceDeliverable } from "../src/providers/lp-rebalance.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/provider-conformance/lp-valid.v2.json", import.meta.url), "utf8"));
const now = new Date("2026-08-12T16:00:30.000Z");
function request() { return LpRebalanceRequestSchema.parse(structuredClone(fixture)); }
function receipt(input: LpRebalanceRequest, output: LpRebalanceDeliverable) {
  return evaluateProviderConformance(input, output, "positioncrew:lp-current-uptime-regression", now);
}

// Construct the adversarial provider's internally consistent fee claims, not the expected answer.
function repriceWithClaimedUptime(input: LpRebalanceRequest, output: LpRebalanceDeliverable, uptime: number) {
  output.feeProjection!.currentUptimeBps = uptime;
  const share = parseFixed(input.position.positionValueUsd) * FIXED_SCALE / parseFixed(input.marketState.poolLiquidityUsd);
  const daily = parseFixed(input.marketState.fees24hUsd) * share / FIXED_SCALE;
  const horizon = BigInt(input.constraints.evaluationHorizonHours) * FIXED_SCALE / 24n;
  const base = daily * horizon / FIXED_SCALE;
  const claimedCurrent = base * BigInt(uptime) / 10_000n;
  const incremental = parseFixed(output.expectedGrossFeesUsd) - claimedCurrent;
  const cost = parseFixed(output.estimatedRebalanceCostUsd);
  output.expectedNetBenefitUsd = formatFixed(incremental - cost, 18);
  output.breakEvenHours = formatFixed(cost * BigInt(input.constraints.evaluationHorizonHours) * FIXED_SCALE / incremental, 18);
}

describe("independently derived actionable LP current uptime", () => {
  it("rejects the audited high-volatility 5500-to-zero benefit inflation", () => {
    const input = request();
    input.marketState.currentTick = 0;
    input.marketState.token0PriceUsd = "1";
    input.marketState.realizedVolatilityBps = 1500;
    input.constraints.minimumNetBenefitUsd = "0";
    const output = createLpRebalanceDeliverable(input, now);
    expect(output.status).toBe("ACTIONABLE");
    expect(output.feeProjection!.currentUptimeBps).toBe(5500);
    expect(receipt(input, output)).toMatchObject({ passed: true, score: 100 });
    repriceWithClaimedUptime(input, output, 0);
    const checks = evaluateFinancialInvariants(input, output);
    expect(checks.find((check) => check.id === "lp-current-uptime")?.passed).toBe(false);
    expect(checks.find((check) => check.id === "lp-fee-arithmetic")?.passed).toBe(false);
    expect(receipt(input, output).passed).toBe(false);
  });

  it("uses the edge regime before volatility and rejects erasing its current fees", () => {
    const input = request();
    // A hand-authored alternative need not match the native candidate search.
    // Spot is at the old lower boundary, but centered in the proposed range.
    input.position.lowerTick = 0;
    input.position.upperTick = 240;
    input.marketState.currentTick = 0;
    input.marketState.token0PriceUsd = "1";
    input.marketState.realizedVolatilityBps = 1500;
    input.constraints.minimumNetBenefitUsd = "0";
    const output: LpRebalanceDeliverable = {
      ...createLpRebalanceDeliverable(request(), now),
      decision: "SHIFT", proposedRange: { lowerTick: -120, upperTick: 120 },
      inventoryExposure: { token0Bps: 5000, token1Bps: 5000 },
      feeProjection: { model: "POOL_SHARE_UPTIME_V1", currentUptimeBps: 3500, proposedUptimeBps: 9500 },
      expectedGrossFeesUsd: "19", expectedNetBenefitUsd: "11", breakEvenHours: "2",
    };
    expect(receipt(input, output).passed).toBe(true);
    repriceWithClaimedUptime(input, output, 0);
    expect(receipt(input, output).passed).toBe(false);
  });

  it("permits zero current fees only when the observed position is actually out of range", () => {
    const input = request();
    const output = createLpRebalanceDeliverable(input, now);
    expect(output.status).toBe("ACTIONABLE");
    expect(output.feeProjection!.currentUptimeBps).toBe(0);
    expect(receipt(input, output)).toMatchObject({ passed: true, score: 100 });
    repriceWithClaimedUptime(input, output, 3500);
    expect(evaluateFinancialInvariants(input, output).find((check) => check.id === "lp-current-uptime")?.passed).toBe(false);
    expect(receipt(input, output).passed).toBe(false);
  });

  it("also refuses a false uptime field when the economics themselves were not changed", () => {
    const input = request();
    const output = createLpRebalanceDeliverable(input, now);
    output.feeProjection!.currentUptimeBps = 9000;
    const checks = evaluateFinancialInvariants(input, output);
    expect(checks.find((check) => check.id === "lp-fee-arithmetic")?.passed).toBe(true);
    expect(checks.find((check) => check.id === "lp-current-uptime")?.passed).toBe(false);
    expect(receipt(input, output).passed).toBe(false);
  });
});
