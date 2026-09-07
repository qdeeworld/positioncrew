// Independent read-only checks for the public ledger. Do not import the simulator.
import { createHash } from "node:crypto";
const LEGACY = "LEGACY_HALF_BUDGET_BASE_HALF_QUOTE_V1";
const PLAN = "PLAN_SELL_RESERVATIONS_IDLE_CASH_V2";
const TERMINAL = new Set(["REFUSED", "CLOSED", "VOID_SOURCE_GAP", "RISK_EXIT"]);
const RETURN_BEARING = new Set(["CLOSED", "RISK_EXIT"]);

function requireCondition(condition, message) {
  if (!condition) throw new Error(`Forward-shadow cohorts: ${message}`);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

export function committedShadowGridCohortMember(envelope, window) {
  const events = envelope.events;
  requireCondition(Array.isArray(events) && events.length > 0, "missing committed window events");
  const headIndex = events.findIndex((event) => event.eventHash === window.eventHash &&
    event.previousEventHash === window.previousEventHash);
  requireCondition(headIndex >= 0, "ledger snapshot head is absent from the committed chain");
  let previousHash = null;
  let terminalSeen = false;
  for (const [index, event] of events.slice(0, headIndex + 1).entries()) {
    const { eventHash, ...body } = event;
    const hash = `sha256:${createHash("sha256").update(JSON.stringify(canonical(body))).digest("hex")}`;
    requireCondition(event.schemaVersion === "positioncrew.bounded-grid-forward-shadow-event.v1" &&
      event.runId === window.windowId && event.sequence === index &&
      event.previousEventHash === previousHash && eventHash === hash && !terminalSeen,
    "invalid committed window chain");
    requireCondition(Number.isFinite(Date.parse(event.recordedAt)), "invalid committed event time");
    previousHash = eventHash;
    terminalSeen = TERMINAL.has(event.eventType);
  }
  const opening = events[0];
  requireCondition(opening.eventType === "EPOCH_STARTED", "missing committed opening event");
  const marker = opening.payload?.portfolioModel;
  const model = marker === undefined ? LEGACY : marker;
  requireCondition([LEGACY, PLAN].includes(model), "unknown committed portfolio model");
  requireCondition(window.portfolioModel === model && envelope.window?.portfolioModel === model,
    "portfolio membership differs from the committed opening marker");
  requireCondition(window.startedAt === opening.recordedAt && envelope.window?.startedAt === opening.recordedAt,
    "cohort epoch differs from the committed opening time");
  const head = events[headIndex];
  const state = TERMINAL.has(head.eventType) ? head.eventType : "PRECOMMITTED";
  const net = RETURN_BEARING.has(state) ? head.payload.netOutcomeUsd : null;
  requireCondition(!RETURN_BEARING.has(state) || (typeof net === "string" && net.trim() !== "" &&
    Number.isFinite(Number(net))), "invalid committed terminal outcome");
  const precommitted = events.slice(0, headIndex + 1).some((event) => event.eventType === "PRECOMMITTED");
  requireCondition(window.state === state && window.simulatedNetOutcomeUsd === net &&
    window.terminalAt === (TERMINAL.has(state) ? head.recordedAt : null) &&
    window.precommitPersisted === precommitted, "window summary differs from its committed snapshot");
  return { windowId: window.windowId, portfolioModel: model, startedAt: opening.recordedAt,
    state, precommitPersisted: precommitted, simulatedNetOutcomeUsd: net };
}

export function verifyShadowGridPortfolioCohorts(ledger, committedWindows) {
  requireCondition(Array.isArray(committedWindows) && committedWindows.length === ledger.summary.openedWindowCount &&
    new Set(committedWindows.map((window) => window.windowId)).size === committedWindows.length,
  "complete unique committed window membership is required");
  const precommitted = committedWindows.filter((window) => window.precommitPersisted).length;
  requireCondition(ledger.summary.precommittedWindowCount === precommitted &&
    ledger.summary.initializationVoidWindowCount === committedWindows.filter((window) =>
      !window.precommitPersisted && window.state === "VOID_SOURCE_GAP").length,
  "initialization counts differ from committed windows");
  for (const [key, state] of [["closedWindowCount", "CLOSED"], ["refusedWindowCount", "REFUSED"],
    ["voidWindowCount", "VOID_SOURCE_GAP"], ["riskExitWindowCount", "RISK_EXIT"]]) {
    requireCondition(ledger.summary[key] === committedWindows.filter((window) => window.state === state).length,
      `${key} differs from committed windows`);
  }
  const cohorts = ledger.portfolioCohorts;
  requireCondition(Array.isArray(cohorts) && cohorts.length === 2,
    "expected separate legacy and plan-aligned cohorts");
  requireCondition(new Set(cohorts.map((cohort) => cohort.portfolioModel)).size === 2 &&
    cohorts.every((cohort) => [LEGACY, PLAN].includes(cohort.portfolioModel)), "unknown or duplicate model");
  const generatedAt = Date.parse(ledger.generatedAt);
  requireCondition(Number.isFinite(generatedAt), "invalid generation time");
  for (const cohort of cohorts) {
    const members = committedWindows.filter((window) => window.portfolioModel === cohort.portfolioModel);
    const ended = members.filter((window) => TERMINAL.has(window.state));
    const outcomes = members.filter((window) => RETURN_BEARING.has(window.state));
    const counts = {
      openedWindowCount: members.length,
      terminalWindowCount: ended.length,
      voidWindowCount: members.filter((window) => window.state === "VOID_SOURCE_GAP").length,
      returnBearingWindowCount: outcomes.length,
      positiveWindowCount: outcomes.filter((window) => Number(window.simulatedNetOutcomeUsd) > 0).length,
      negativeWindowCount: outcomes.filter((window) => Number(window.simulatedNetOutcomeUsd) < 0).length,
    };
    for (const [key, count] of Object.entries(counts)) {
      requireCondition(cohort[key] === count, `${key} differs from committed cohort membership`);
    }
    const firstCommittedTime = members.length === 0 ? null
      : new Date(Math.min(...members.map((window) => Date.parse(window.startedAt)))).toISOString();
    requireCondition(cohort.firstWindowStartedAt === firstCommittedTime,
      "cohort observation epoch differs from committed windows");
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
    if (mature) {
      const aggregate = outcomes.reduce((sum, window) => sum + Number(window.simulatedNetOutcomeUsd), 0);
      requireCondition(Math.abs(Number(cohort.simulatedNetOutcomeUsd) - aggregate) <= 0.00000001,
        "aggregate differs from committed terminal outcomes");
    }
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
