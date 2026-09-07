import type { BoundedGridPortfolioCohort, ShadowGridPortfolioModel } from "../types";

export function shadowPortfolioLabel(model?: ShadowGridPortfolioModel): string {
  return model === "PLAN_SELL_RESERVATIONS_IDLE_CASH_V2" ? "Plan-aligned V2" : "Legacy 50/50";
}

export function ShadowGridPortfolioCohorts({ cohorts }: { cohorts: BoundedGridPortfolioCohort[] }) {
  return (
    <div className="forward-shadow-facts" aria-label="Separate shadow portfolio cohorts">
      {cohorts.map((cohort) => (
        <div key={cohort.portfolioModel} role="group" aria-label={`${shadowPortfolioLabel(cohort.portfolioModel)} portfolio cohort`}>
          <strong>{shadowPortfolioLabel(cohort.portfolioModel)}</strong>
          <span>{cohort.mature ? "Collection threshold met" : "Collecting observations"}</span>
          <small>{cohort.openedWindowCount} opened · {cohort.terminalWindowCount} terminal · {cohort.voidWindowCount} void</small>
          <small>{cohort.observedDays}/7 days · {cohort.terminalWindowCount}/30 terminal required</small>
          <small>Non-void: {cohort.nonVoidRatePct === null ? "Not yet measured" : `${cohort.nonVoidRatePct}%`} · 90% required</small>
          <strong>{cohort.mature && cohort.simulatedNetOutcomeUsd !== null && Number.isFinite(Number(cohort.simulatedNetOutcomeUsd))
            ? `${Number(cohort.simulatedNetOutcomeUsd) >= 0 ? "+" : "-"}$${Math.abs(Number(cohort.simulatedNetOutcomeUsd)).toFixed(2)}`
            : "WITHHELD"}</strong>
          <span>Aggregate simulated outcome · this cohort only</span>
          <small>{cohort.returnBearingWindowCount} outcome windows · {cohort.positiveWindowCount} positive · {cohort.negativeWindowCount} negative</small>
          <small>{cohort.portfolioModel === "PLAN_SELL_RESERVATIONS_IDLE_CASH_V2"
            ? "Starts from emitted sell inventory; unused capital stays cash. No inherited legacy maturity."
            : "Original half-budget inventory. Historical outcomes are not recalculated."}</small>
        </div>
      ))}
    </div>
  );
}
