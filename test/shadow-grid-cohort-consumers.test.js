import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { canonicalHash } from "../src/core/canonical.ts";
import { committedShadowGridCohortMember, verifyShadowGridPortfolioCohorts } from "../scripts/verify-shadow-grid-cohorts.mjs";
import { ShadowGridPortfolioCohorts, shadowPortfolioLabel } from "../web/src/components/ShadowGridPortfolioCohorts.tsx";

const LEGACY = "LEGACY_HALF_BUDGET_BASE_HALF_QUOTE_V1";
const PLAN = "PLAN_SELL_RESERVATIONS_IDLE_CASH_V2";
const GENERATED = "2026-09-11T00:00:00.000Z";
const FIRST = "2026-09-01T00:00:00.000Z";

function cohort(model, count, first = FIRST) {
  const days = count ? (Date.parse(GENERATED) - Date.parse(first)) / 86_400_000 : 0;
  const mature = count >= 30 && days >= 7;
  return {
    portfolioModel: model, openedWindowCount: count, terminalWindowCount: count,
    voidWindowCount: 0, returnBearingWindowCount: count,
    firstWindowStartedAt: count ? first : null, observedDays: Number(days.toFixed(2)),
    nonVoidRatePct: count ? 100 : null, mature,
    positiveWindowCount: 0, negativeWindowCount: count,
    simulatedNetOutcomeUsd: mature ? (-count * 0.2).toFixed(8) : null,
  };
}

function committedWindow(model, ordinal, first) {
  const runId = `${model}-${ordinal}`;
  const events = [];
  for (const [sequence, eventType] of ["EPOCH_STARTED", "PRECOMMITTED", "OBSERVED", "CLOSED"].entries()) {
    const body = {
      schemaVersion: "positioncrew.bounded-grid-forward-shadow-event.v1", runId, sequence,
      previousEventHash: events.at(-1)?.eventHash ?? null, eventType,
      recordedAt: new Date(Date.parse(first) + sequence * 1000).toISOString(),
      payload: sequence === 0 ? (model === PLAN ? { portfolioModel: PLAN } : {})
        : sequence === 3 ? { netOutcomeUsd: "-0.20000000" } : {},
    };
    events.push({ ...body, eventHash: canonicalHash(body) });
  }
  const head = events.at(-1);
  const window = { windowId: runId, portfolioModel: model, startedAt: first, state: "CLOSED",
    eventHash: head.eventHash, previousEventHash: head.previousEventHash,
    terminalAt: head.recordedAt, precommitPersisted: true, simulatedNetOutcomeUsd: "-0.20000000" };
  return { window, events };
}

function mixedLedger(planCount = 1, planFirst = FIRST) {
  const proofs = [
    ...Array.from({ length: 30 }, (_, i) => committedWindow(LEGACY, i, FIRST)),
    ...Array.from({ length: planCount }, (_, i) => committedWindow(PLAN, i, planFirst)),
  ];
  return {
    generatedAt: GENERATED,
    maturity: { hashChainValid: true, mixedPortfolios: planCount > 0 },
    model: { portfolioModel: planCount ? "MIXED_SEPARATE_COHORTS" : LEGACY, activePortfolioModel: PLAN },
    summary: { openedWindowCount: 30 + planCount, terminalWindowCount: 30 + planCount,
      precommittedWindowCount: 30 + planCount, initializationVoidWindowCount: 0,
      voidWindowCount: 0, closedWindowCount: 30 + planCount, refusedWindowCount: 0,
      riskExitWindowCount: 0, positiveWindowCount: 0, negativeWindowCount: 30 + planCount },
    portfolioCohorts: [cohort(LEGACY, 30), cohort(PLAN, planCount, planFirst)],
    cohortWindows: proofs.map((proof) => structuredClone(proof.window)),
    proofs,
  };
}

function verify(ledger) {
  const members = ledger.cohortWindows.map((window) => {
    const proof = ledger.proofs.find((candidate) => candidate.window.windowId === window.windowId);
    return committedShadowGridCohortMember(proof, window);
  });
  return verifyShadowGridPortfolioCohorts(ledger, members);
}

describe("committed shadow cohort production checks", () => {
  it("accepts mature legacy history alongside an immature corrected cohort", () => {
    expect(verify(mixedLedger())).toBe(true);
  });
  it("accepts a mature corrected cohort without combining outcomes", () => {
    expect(verify(mixedLedger(30))).toBe(true);
  });
  it("rejects producer totals that reassign all legacy history to V2 despite reconciling", () => {
    const ledger = mixedLedger();
    ledger.portfolioCohorts = [cohort(LEGACY, 0), cohort(PLAN, 31)];
    ledger.model.portfolioModel = PLAN;
    ledger.maturity.mixedPortfolios = false;
    expect(() => verify(ledger)).toThrow(/committed cohort membership/);
  });
  it("rejects relabelled window membership against its unchanged opening event", () => {
    const ledger = mixedLedger();
    ledger.cohortWindows[0].portfolioModel = PLAN;
    ledger.proofs[0].window.portfolioModel = PLAN;
    expect(() => verify(ledger)).toThrow(/opening marker/);
  });
  it("rejects a changed opening marker without a matching canonical commitment", () => {
    const ledger = mixedLedger();
    ledger.proofs[0].events[0].payload.portfolioModel = PLAN;
    expect(() => verify(ledger)).toThrow(/committed window chain/);
  });
  it("rejects an invented earlier cohort epoch or window timestamp", () => {
    const ledger = mixedLedger();
    ledger.portfolioCohorts[1].firstWindowStartedAt = "2026-08-01T00:00:00.000Z";
    expect(() => verify(ledger)).toThrow(/epoch differs/);
    const window = mixedLedger();
    window.cohortWindows[0].startedAt = "2026-08-01T00:00:00.000Z";
    expect(() => verify(window)).toThrow(/opening time/);
  });
  it("rejects inherited maturity and aggregates on the corrected cohort", () => {
    const ledger = mixedLedger();
    ledger.portfolioCohorts[1].mature = true;
    ledger.portfolioCohorts[1].simulatedNetOutcomeUsd = "100";
    expect(() => verify(ledger)).toThrow(/maturity/);
  });
  it("rejects invented aggregates on an otherwise mature cohort", () => {
    const ledger = mixedLedger(30);
    ledger.portfolioCohorts[1].simulatedNetOutcomeUsd = "100";
    expect(() => verify(ledger)).toThrow(/terminal outcomes/);
  });
  it("rejects duplicate or missing committed windows and incorrect rates", () => {
    const duplicate = mixedLedger();
    duplicate.cohortWindows[0] = duplicate.cohortWindows[1];
    expect(() => verify(duplicate)).toThrow(/unique committed/);
    const missing = mixedLedger();
    missing.cohortWindows.pop();
    expect(() => verify(missing)).toThrow(/complete unique/);
    const rate = mixedLedger();
    rate.portfolioCohorts[1].nonVoidRatePct = 90;
    expect(() => verify(rate)).toThrow(/rate/);
  });
  it("uses the exact committed epoch rather than rounding 6.999 days into maturity", () => {
    expect(verify(mixedLedger(30, "2026-09-04T00:00:01.000Z"))).toBe(true);
  });
  it("supports the empty corrected cohort before its first scheduled window", () => {
    expect(verify(mixedLedger(0))).toBe(false);
  });
  it("derives counts at the ledger snapshot head even if the detailed chain advanced", () => {
    const proof = committedWindow(PLAN, 0, FIRST);
    const observed = proof.events[2];
    const earlier = { ...proof.window, eventHash: observed.eventHash,
      previousEventHash: observed.previousEventHash, state: "PRECOMMITTED",
      terminalAt: null, simulatedNetOutcomeUsd: null };
    expect(committedShadowGridCohortMember(proof, earlier)).toMatchObject({
      portfolioModel: PLAN, state: "PRECOMMITTED", simulatedNetOutcomeUsd: null,
    });
  });
});

describe("public portfolio cohort presentation", () => {
  it("labels both models and withholds only the immature aggregate", () => {
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
