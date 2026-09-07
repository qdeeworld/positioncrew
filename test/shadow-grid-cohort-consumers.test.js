import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { verifyShadowGridPortfolioCohorts } from "../scripts/verify-shadow-grid-cohorts.mjs";
import { ShadowGridPortfolioCohorts, shadowPortfolioLabel } from "../web/src/components/ShadowGridPortfolioCohorts.tsx";

const LEGACY = "LEGACY_HALF_BUDGET_BASE_HALF_QUOTE_V1";
const PLAN = "PLAN_SELL_RESERVATIONS_IDLE_CASH_V2";

function cohort(model, count, mature) {
  return {
    portfolioModel: model,
    openedWindowCount: count,
    terminalWindowCount: count,
    voidWindowCount: 0,
    returnBearingWindowCount: count,
    firstWindowStartedAt: count ? "2026-09-01T00:00:00.000Z" : null,
    observedDays: count ? 10 : 0,
    nonVoidRatePct: count ? 100 : null,
    mature,
    positiveWindowCount: 0,
    negativeWindowCount: count,
    simulatedNetOutcomeUsd: mature ? "-6.00000000" : null,
  };
}

function mixedLedger(planCount = 1) {
  return {
    generatedAt: "2026-09-11T00:00:00.000Z",
    maturity: { hashChainValid: true, mixedPortfolios: true },
    model: { portfolioModel: "MIXED_SEPARATE_COHORTS", activePortfolioModel: PLAN },
    summary: { openedWindowCount: 30 + planCount, terminalWindowCount: 30 + planCount,
      voidWindowCount: 0, closedWindowCount: 30 + planCount, riskExitWindowCount: 0,
      positiveWindowCount: 0, negativeWindowCount: 30 + planCount },
    portfolioCohorts: [cohort(LEGACY, 30, true), cohort(PLAN, planCount, planCount >= 30)],
  };
}

describe("independent shadow cohort production checks", () => {
  it("accepts retained mature legacy history alongside an immature corrected cohort", () => {
    expect(verifyShadowGridPortfolioCohorts(mixedLedger())).toBe(true);
  });

  it("accepts a mature corrected cohort without combining its outcomes with legacy", () => {
    expect(verifyShadowGridPortfolioCohorts(mixedLedger(30))).toBe(true);
  });

  it("rejects inherited maturity and aggregates on the new cohort", () => {
    const ledger = mixedLedger();
    ledger.portfolioCohorts[1].mature = true;
    ledger.portfolioCohorts[1].simulatedNetOutcomeUsd = "100";
    expect(() => verifyShadowGridPortfolioCohorts(ledger)).toThrow(/maturity/);
  });

  it("rejects duplicate models, mismatched counts, and incorrect rates", () => {
    const duplicate = mixedLedger();
    duplicate.portfolioCohorts[1].portfolioModel = LEGACY;
    expect(() => verifyShadowGridPortfolioCohorts(duplicate)).toThrow(/duplicate/);
    const count = mixedLedger();
    count.summary.openedWindowCount += 1;
    expect(() => verifyShadowGridPortfolioCohorts(count)).toThrow(/reconcile/);
    const rate = mixedLedger();
    rate.portfolioCohorts[1].nonVoidRatePct = 90;
    expect(() => verifyShadowGridPortfolioCohorts(rate)).toThrow(/rate/);
  });

  it("uses the exact cohort epoch instead of rounding 6.999 days into maturity", () => {
    const ledger = mixedLedger(30);
    ledger.portfolioCohorts[1].firstWindowStartedAt = "2026-09-04T00:00:01.000Z";
    ledger.portfolioCohorts[1].observedDays = 7;
    ledger.portfolioCohorts[1].mature = false;
    ledger.portfolioCohorts[1].simulatedNetOutcomeUsd = null;
    expect(verifyShadowGridPortfolioCohorts(ledger)).toBe(true);
  });

  it("supports the empty corrected cohort before the first scheduled V2 window", () => {
    const ledger = mixedLedger(0);
    ledger.model.portfolioModel = LEGACY;
    ledger.maturity.mixedPortfolios = false;
    expect(verifyShadowGridPortfolioCohorts(ledger)).toBe(false);
  });
});

describe("public portfolio cohort presentation", () => {
  it("labels both models and withholds only the immature model's aggregate", () => {
    const markup = renderToStaticMarkup(createElement(ShadowGridPortfolioCohorts,
      { cohorts: mixedLedger().portfolioCohorts }));
    expect(markup).toContain('aria-label="Legacy 50/50 portfolio cohort"');
    expect(markup).toContain('aria-label="Plan-aligned V2 portfolio cohort"');
    expect(markup).toContain("-$6.00");
    expect(markup.match(/WITHHELD/g)).toHaveLength(1);
    expect(markup).toContain("No inherited legacy maturity");
  });

  it("shows mature V2 outcomes even while legacy windows remain", () => {
    const markup = renderToStaticMarkup(createElement(ShadowGridPortfolioCohorts,
      { cohorts: mixedLedger(30).portfolioCohorts }));
    expect(markup).not.toContain("WITHHELD");
    expect(markup.match(/Collection threshold met/g)).toHaveLength(2);
    expect(shadowPortfolioLabel(PLAN)).toBe("Plan-aligned V2");
    expect(shadowPortfolioLabel(undefined)).toBe("Legacy 50/50");
  });
});
