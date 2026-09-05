import { describe, expect, it } from "vitest";
import { actionDetails, capitalDecisionPlan, gridRiskCopy, isResultExpired, metricsFor, yieldComparisonDescription } from "../web/src/presentation.js";
import type { CurrentBlockPinnedMarketplaceEvidence, ProviderDeliverable } from "../web/src/types.js";

const grid: ProviderDeliverable = {
  service: "BOUNDED_GRID",
  status: "ACTIONABLE",
  decision: "BUILD_GRID",
  summary: "Proposed orders",
  expiresAt: "2026-09-05T07:00:00.000Z",
  worstCaseLossUsd: "150",
  maximumInventoryUsd: "600",
  orders: [{ side: "BUY", price: "9", baseAmount: "1", maximumQuoteAmount: "9" }],
};
const comparison: NonNullable<CurrentBlockPinnedMarketplaceEvidence["externalYieldComparison"]> = {
  schemaVersion: "positioncrew.external-yield-comparison-summary.v1",
  provider: { name: "AiKi", erc8004TokenId: "1", endpoint: "https://example.invalid" },
  evaluatedAt: "2026-09-05T06:55:00.000Z",
  outcome: "SEMANTICALLY_COMPARABLE",
  marketCount: 3,
  positionCrewSelectedMarket: "USDT",
  externalRecommendedMarket: "USDT",
  sameRateLeader: true,
  positionCrewGrossApyBps: 500,
  externalSimpleAnnualRateBps: 500,
  rateDifferenceBps: 0,
  attributable: true,
  persisted: true,
  exactRequestAccepted: false,
  eligibleForRateRankingActivation: true,
  eligibleForYieldSelection: true,
  eligibleForLiveMatch: true,
  checks: [],
  boundary: "Unsigned rate comparison",
};

describe("financial risk presentation", () => {
  it("labels legacy grids as scenarios without claiming a maximum loss or inventory cap", () => {
    expect(metricsFor(grid).map((metric) => metric.label)).toContain("Modeled scenario loss");
    expect(metricsFor(grid).map((metric) => metric.label)).toContain("Scenario inventory estimate");
    expect(actionDetails(grid).map((detail) => detail.label)).not.toContain("Maximum loss");
    expect(gridRiskCopy(grid).assumptions).toContain("Neither is a hard maximum");
  });

  it("labels current risk estimates with their scenario and price-range assumptions", () => {
    const current = { ...grid, riskModel: "FINITE_GRID_ZERO_PRICE_STRESS_V1" as const };
    const plan = capitalDecisionPlan(current, {
      service: "BOUNDED_GRID",
      account: "0x1111111111111111111111111111111111111111",
      chainId: 56,
      maxActionUsd: "1000",
      maxGasUsd: "2",
      maxSlippageBps: 10,
      maxDataAgeSeconds: 300,
    });
    expect(metricsFor(current).map((metric) => metric.label)).toContain("Zero-price stress loss");
    expect(metricsFor(current).map((metric) => metric.label)).toContain("In-range inventory bound");
    expect(plan.details?.basis).toContain("In-range inventory bound");
    expect(plan.details?.caveat).toContain("cancellation is not guaranteed");
    expect(plan.details?.caveat).toContain("range ceiling");
    expect(plan.details?.caveat).toContain("actual costs may be higher");
  });

  it("does not claim AiKi inspected markets when unavailable", () => {
    const copy = yieldComparisonDescription({ ...comparison, outcome: "UNAVAILABLE" });
    expect(copy).toContain("AiKi was unavailable");
    expect(copy).not.toContain("Both providers");
    expect(copy).not.toContain("supplied");
  });

  it.each([
    { attributable: false },
    { persisted: false },
    { externalRecommendedMarket: null },
    { externalSimpleAnnualRateBps: null },
    { externalSimpleAnnualRateBps: Number.NaN },
  ])("does not promote an incomplete external quote: %j", (change) => {
    expect(yieldComparisonDescription({ ...comparison, ...change })).toContain("could not be verified");
  });

  it("distinguishes comparable, rate-only and rejected external evidence", () => {
    expect(yieldComparisonDescription(comparison)).toContain("attributable rate thesis");
    expect(yieldComparisonDescription({ ...comparison, outcome: "PARTIAL_COMPATIBILITY" })).toContain("rate-only candidate");
    expect(yieldComparisonDescription({ ...comparison, outcome: "INCOMPATIBLE" })).toContain("not eligible for selection");
  });

  it("expires at the exact deadline and treats invalid expiry as unusable", () => {
    const expiry = Date.parse(grid.expiresAt);
    expect(isResultExpired(grid.expiresAt, expiry - 1)).toBe(false);
    expect(isResultExpired(grid.expiresAt, expiry)).toBe(true);
    expect(isResultExpired(grid.expiresAt, expiry + 1)).toBe(true);
    expect(isResultExpired("not-a-timestamp", expiry)).toBe(true);
  });

  it("shows yield withdrawals and the capital remaining after cost reservation", () => {
    const yieldResult: ProviderDeliverable = {
      ...grid,
      service: "YIELD_OPTIMIZATION",
      decision: "MIGRATE",
      withdrawals: [{ opportunityId: "market-a", amountUsd: "350" }],
      migrationCostUsd: "5",
      remainingIdleCapitalUsd: "100",
      postMigrationCapitalUsd: "995",
    };
    expect(actionDetails(yieldResult)).toContainEqual({ label: "Reserved migration cost", value: "$5" });
    expect(actionDetails(yieldResult)).toContainEqual({ label: "Withdraw from market-a", value: "$350" });
    expect(actionDetails(yieldResult)).toContainEqual({ label: "Capital after costs", value: "$995" });
  });
});
