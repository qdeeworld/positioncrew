import { describe, expect, it } from "vitest";
import { YieldOptimizationRequestSchema, type YieldOptimizationRequest } from "../src/contracts/yield-optimization.js";
import { createYieldOptimizationDeliverable } from "../src/providers/yield-optimization.js";
import { evaluateFinancialInvariants } from "../src/evaluators/financial-invariants.js";
import { yieldConstraintRefusalJustified } from "../src/evaluators/yield-refusal-feasibility.js";

const observedAt = "2026-09-06T00:00:00.000Z";
const now = new Date("2026-09-06T00:00:10.000Z");
const address = (digit: string) => `0x${digit.repeat(40)}`;
const usd = (value: string): bigint => {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
};

// A fresh, explicit synthetic input, not a rewrite of a historical receipt or
// a caller's legacy maxActionUsd. Expected arithmetic below is independent.
function request(): YieldOptimizationRequest {
  return YieldOptimizationRequestSchema.parse({
    schemaVersion: "positioncrew.yield-optimization.request.v1", service: "YIELD_OPTIMIZATION",
    requestId: "yield-explicit-principal-cost-20260906", chainId: 56, account: address("1"),
    protocol: "Budget semantics test", requestedAt: observedAt, deadline: "2026-09-06T00:05:00.000Z",
    maxDataAgeSeconds: 300, maxActionUsd: "1000", maxAllocationUsd: "1000", maxExecutionCostUsd: "2",
    maxGasUsd: "2", maxSlippageBps: 0, capitalUsd: "1000", currentPositions: [],
    sources: [{ sourceId: "yield-budget-snapshot", label: "Synthetic budget boundary case", uri: "https://example.com/yield-budget", observedAt }],
    opportunities: [{
      opportunityId: "destination", protocol: "Destination", vaultOrMarket: address("2"),
      asset: { symbol: "USDT", address: address("a"), decimals: 18 }, amountUsd: "1000",
      grossApyBps: 1000, liquidityUsd: "100000", lockupSeconds: 0,
      estimatedEntryCostUsd: "1", estimatedExitCostUsd: "5", riskTier: "LOW", observedAt, sourceId: "yield-budget-snapshot",
    }],
    constraints: { protocolAllowlist: ["Destination", "Source"], maximumRiskTier: "LOW",
      maximumProtocolConcentrationBps: 10000, maximumLockupSeconds: 0, minimumLiquidityUsd: "0",
      minimumNetBenefitUsd: "0", evaluationHorizonDays: 365 },
  });
}

function withHolding(): YieldOptimizationRequest {
  const input = request();
  input.currentPositions = [{ ...input.opportunities[0]!, opportunityId: "source", protocol: "Source",
    vaultOrMarket: address("3"), grossApyBps: 400, estimatedExitCostUsd: "1" }];
  return input;
}

describe("Yield separates principal permission from execution-cost budgets", () => {
  it("does not reinterpret a legacy 25-cent cap as permission to allocate $1,000", () => {
    const input = request();
    delete input.maxAllocationUsd;
    delete input.maxExecutionCostUsd;
    input.maxActionUsd = "0.25";
    input.opportunities[0]!.estimatedEntryCostUsd = "0.01";
    const result = createYieldOptimizationDeliverable(input, now);
    expect(usd(result.allocationUsd) <= usd("0.25")).toBe(true);
    expect(usd(result.migrationCostUsd) <= usd("0.25")).toBe(true);
    expect(input.maxActionUsd).toBe("0.25");
    expect(input.maxAllocationUsd).toBeUndefined();
  });

  it("an explicit allocation ceiling cannot override a smaller legacy ceiling", () => {
    const input = request();
    input.maxActionUsd = "0.25";
    input.opportunities[0]!.estimatedEntryCostUsd = "0.01";
    expect(usd(createYieldOptimizationDeliverable(input, now).allocationUsd) <= usd("0.25")).toBe(true);
  });

  it("a newly explicit request can allocate principal while keeping fees below $2", () => {
    const input = request();
    const result = createYieldOptimizationDeliverable(input, now);
    expect(result.status).toBe("ACTIONABLE");
    expect(usd(result.allocationUsd)).toBe(usd("999"));
    expect(usd(result.migrationCostUsd)).toBe(usd("1"));
    expect(usd(result.remainingIdleCapitalUsd!)).toBe(0n);
    expect(evaluateFinancialInvariants(input, result).every((check) => check.passed)).toBe(true);
  });

  it("honors an exact allocation boundary and never rounds above it", () => {
    const input = request();
    input.maxAllocationUsd = "250.000000000000000001";
    const result = createYieldOptimizationDeliverable(input, now);
    expect(result.status).toBe("ACTIONABLE");
    expect(usd(result.allocationUsd)).toBe(usd(input.maxAllocationUsd));
    expect(usd(result.remainingIdleCapitalUsd!)).toBe(usd("748.999999999999999999"));
  });

  it("bounds all source withdrawals, including capital used to fund route fees", () => {
    const input = withHolding();
    input.maxAllocationUsd = "250";
    const result = createYieldOptimizationDeliverable(input, now);
    expect(result.status).toBe("ACTIONABLE");
    expect(usd(result.allocationUsd)).toBe(usd("248"));
    expect(result.withdrawals!.reduce((sum, item) => sum + usd(item.amountUsd), 0n)).toBe(usd("250"));
    expect(evaluateFinancialInvariants(input, result).every((check) => check.passed)).toBe(true);
  });

  it("cannot split withdrawals across sources to bypass a total principal cap", () => {
    const input = withHolding();
    input.currentPositions[0]!.amountUsd = "200";
    input.currentPositions.push({ ...input.currentPositions[0]!, opportunityId: "second-source",
      vaultOrMarket: address("4"), amountUsd: "800" });
    input.maxAllocationUsd = "250";
    input.maxExecutionCostUsd = "3";
    input.maxGasUsd = "3";
    const result = createYieldOptimizationDeliverable(input, now);
    expect(result.status).toBe("ACTIONABLE");
    expect(result.withdrawals!.reduce((sum, item) => sum + usd(item.amountUsd), 0n) <= usd("250")).toBe(true);
    expect(usd(result.allocationUsd) <= usd("250")).toBe(true);
  });

  it.each(["maxExecutionCostUsd", "maxGasUsd"] as const)("enforces the exact %s boundary independently of principal", (field) => {
    const input = request();
    input[field] = "1";
    const exact = createYieldOptimizationDeliverable(input, now);
    expect(exact.status).toBe("ACTIONABLE");
    input[field] = "0.999999999999999999";
    expect(createYieldOptimizationDeliverable(input, now).status).toBe("NO_ACTION");
    expect(evaluateFinancialInvariants(input, exact).find((check) => check.id === "yield-cost-limits")?.passed).toBe(false);
  });

  it("the independent validator rejects a valid-looking allocation exceeding a stricter principal cap", () => {
    const input = request();
    const result = createYieldOptimizationDeliverable(input, now);
    input.maxAllocationUsd = "998.999999999999999999";
    expect(evaluateFinancialInvariants(input, result).find((check) => check.id === "yield-principal-limits")?.passed).toBe(false);
  });

  it("the independent validator also rejects excessive withdrawals when the destination still fits", () => {
    const input = withHolding();
    const result = createYieldOptimizationDeliverable(input, now);
    expect(usd(result.allocationUsd)).toBe(usd("998"));
    input.maxAllocationUsd = "999";
    expect(evaluateFinancialInvariants(input, result).find((check) => check.id === "yield-principal-limits")?.passed).toBe(false);
  });

  it("zero principal permission prevents a new action without changing the request", () => {
    const input = request();
    input.maxAllocationUsd = "0";
    expect(createYieldOptimizationDeliverable(input, now).status).toBe("NO_ACTION");
    expect(yieldConstraintRefusalJustified(input)).toBe(true);
    expect(input.maxAllocationUsd).toBe("0");
  });

  it.each(["-1", "NaN", "Infinity", "1e3", "0.0000000000000000001"])("rejects malformed explicit limits: %s", (value) => {
    for (const field of ["maxAllocationUsd", "maxExecutionCostUsd"] as const) {
      expect(YieldOptimizationRequestSchema.safeParse({ ...request(), [field]: value }).success).toBe(false);
    }
  });

  it("missing route-cost observations are rejected rather than assumed free", () => {
    const input = request();
    const { estimatedEntryCostUsd: _omitted, ...incomplete } = input.opportunities[0]!;
    expect(YieldOptimizationRequestSchema.safeParse({ ...input, opportunities: [incomplete] }).success).toBe(false);
  });

  it("declares the simple-rate horizon and unpriced destination exit without changing the arithmetic", () => {
    const input = request();
    const result = createYieldOptimizationDeliverable(input, now);
    expect(usd(result.annualYieldUpliftUsd)).toBe(usd("99.9"));
    expect(usd(result.netBenefitUsd)).toBe(usd("98.9"));
    expect(result.risks.join(" ")).toContain("365-day year");
    expect(result.risks.join(" ")).toContain("future destination exit");
    expect(result.risks.join(" ")).toContain("non-compounding");
  });
});
