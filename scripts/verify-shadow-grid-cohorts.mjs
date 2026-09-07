// Independent read-only checks for the public ledger. Do not import the simulator.
const LEGACY = "LEGACY_HALF_BUDGET_BASE_HALF_QUOTE_V1";
const PLAN = "PLAN_SELL_RESERVATIONS_IDLE_CASH_V2";

function requireCondition(condition, message) {
  if (!condition) throw new Error(`Forward-shadow cohorts: ${message}`);
}

export function verifyShadowGridPortfolioCohorts(ledger) {
  const cohorts = ledger.portfolioCohorts;
  requireCondition(Array.isArray(cohorts) && cohorts.length === 2,
    "expected separate legacy and plan-aligned cohorts");
  requireCondition(new Set(cohorts.map((cohort) => cohort.portfolioModel)).size === 2 &&
    cohorts.every((cohort) => [LEGACY, PLAN].includes(cohort.portfolioModel)), "unknown or duplicate model");
  const generatedAt = Date.parse(ledger.generatedAt);
  requireCondition(Number.isFinite(generatedAt), "invalid generation time");
  for (const cohort of cohorts) {
    for (const key of ["openedWindowCount", "terminalWindowCount", "voidWindowCount",
      "returnBearingWindowCount", "positiveWindowCount", "negativeWindowCount"]) {
      requireCondition(Number.isInteger(cohort[key]) && cohort[key] >= 0, `invalid ${key}`);
    }
    requireCondition(cohort.terminalWindowCount <= cohort.openedWindowCount &&
      cohort.voidWindowCount + cohort.returnBearingWindowCount <= cohort.terminalWindowCount &&
      cohort.positiveWindowCount + cohort.negativeWindowCount <= cohort.returnBearingWindowCount,
    "outcome counts do not reconcile");
    let days = 0;
    if (cohort.openedWindowCount === 0) {
      requireCondition(cohort.firstWindowStartedAt === null, "empty cohort has an observation epoch");
    } else {
      const first = Date.parse(cohort.firstWindowStartedAt);
      requireCondition(Number.isFinite(first) && first <= generatedAt, "invalid observation epoch");
      days = (generatedAt - first) / 86_400_000;
    }
    requireCondition(cohort.observedDays === Number(days.toFixed(2)), "observed days disagree with epoch");
    const rate = cohort.terminalWindowCount === 0 ? null
      : (cohort.terminalWindowCount - cohort.voidWindowCount) / cohort.terminalWindowCount * 100;
    requireCondition(cohort.nonVoidRatePct === (rate === null ? null : Number(rate.toFixed(2))),
      "non-void rate disagrees with counts");
    const mature = ledger.maturity.hashChainValid === true && days >= 7 &&
      cohort.terminalWindowCount >= 30 && (rate ?? 0) >= 90;
    requireCondition(cohort.mature === mature, "maturity must use only that cohort's observations");
    requireCondition(mature
      ? typeof cohort.simulatedNetOutcomeUsd === "string" && cohort.simulatedNetOutcomeUsd.trim() !== "" &&
        Number.isFinite(Number(cohort.simulatedNetOutcomeUsd))
      : cohort.simulatedNetOutcomeUsd === null, "aggregate is inconsistent with cohort maturity");
  }
  for (const key of ["openedWindowCount", "terminalWindowCount", "voidWindowCount",
    "positiveWindowCount", "negativeWindowCount"]) {
    requireCondition(cohorts.reduce((sum, cohort) => sum + cohort[key], 0) === ledger.summary[key],
      `${key} does not reconcile with retained windows`);
  }
  requireCondition(cohorts.reduce((sum, cohort) => sum + cohort.returnBearingWindowCount, 0) ===
    ledger.summary.closedWindowCount + ledger.summary.riskExitWindowCount,
  "return-bearing windows do not reconcile");
  const populated = cohorts.filter((cohort) => cohort.openedWindowCount > 0);
  const mixed = populated.length > 1;
  requireCondition(ledger.maturity.mixedPortfolios === mixed, "incorrect mixed-portfolio flag");
  requireCondition(ledger.model.portfolioModel ===
    (mixed ? "MIXED_SEPARATE_COHORTS" : populated[0]?.portfolioModel ?? PLAN), "incorrect ledger model");
  requireCondition(ledger.model.activePortfolioModel === PLAN, "incorrect active portfolio model");
  return mixed;
}
