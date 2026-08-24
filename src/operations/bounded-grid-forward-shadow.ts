import type { BoundedGridDeliverable, BoundedGridRequest } from "../contracts/bounded-grid.js";
import { canonicalHash } from "../core/canonical.js";
import { canonicalJson } from "../commerce/fresh-hire-schema.js";
import type {
  AppendShadowGridEvent,
  ShadowGridEvent,
  ShadowGridEventType,
} from "./shadow-grid-store.js";

export const SHADOW_GRID_STRATEGY_VERSION = "positioncrew:bounded-grid-forward-shadow:v1";
export const SHADOW_GRID_FILL_MODEL = "CONSERVATIVE_SAMPLED_CROSSING_V1";
export const SHADOW_GRID_HORIZON_MINUTES = 15;
export const SHADOW_GRID_SAMPLE_CADENCE_MINUTES = 5;
export const SHADOW_GRID_PUBLIC_CLAIM_BOUNDARY = [
  "Forward-only, zero-fund shadow outcomes use only actual block-pinned PancakeSwap WBNB/USDT observations recorded after precommitment.",
  "Conservative sampled crossings are simulations, not transactions, executable fills, realised PnL, strategy returns, or audited financial performance.",
  "The operator-scheduled record proves no external buyer, payment, revenue, demand, or Agent Advantage.",
] as const;

export interface ShadowGridScheduleEvidence {
  event: "schedule";
  repository: "dolepee/positioncrew";
  workflowPath: ".github/workflows/production-smoke.yml";
  runId: string;
  runAttempt: string;
  headSha: string;
  workflowRef: string;
  recordedAt: string;
}

export interface ShadowGridRunBinding {
  runId: string;
  epochStartedAt: string;
  horizonEndsAt: string;
  hireId: string;
  receiptId: string;
  requestHash: string;
  providerHash: string;
  evidenceHash: string;
  responseHash: string;
  deliverableHash: string;
  evaluationHash: string;
}

export interface ShadowGridPriceSample {
  sampledAt: string;
  spotPriceUsd: string;
  source: {
    chainId: 56;
    market: "WBNB/USDT";
    protocol: "PancakeSwap V3";
    poolAddress: `0x${string}`;
    blockNumber: string;
    blockHash: `0x${string}`;
    blockTimestamp: string;
    explorerUrl: string;
    confirmationDepth: number;
    finality: "FINALIZED_OR_32_CONFIRMATIONS";
  };
}

export interface ShadowGridPrecommitPayload {
  schedule: ShadowGridScheduleEvidence;
  sourceHireId: string;
  sourceReceiptId: string;
  sourceReceiptUrl: string;
  sourceRequestHash: string;
  sourceBlockNumber: string;
  sourceBlockTimestamp: string;
  request: BoundedGridRequest;
  deliverable: BoundedGridDeliverable;
}

export interface ShadowGridPublicEvent {
  schemaVersion: "positioncrew.bounded-grid-forward-shadow-event.v1";
  runId: string;
  sequence: number;
  previousEventHash: string | null;
  eventType: ShadowGridEventType;
  recordedAt: string;
  payload: Record<string, unknown>;
  eventHash: string;
}

export interface ShadowGridFillPayload extends Record<string, unknown> {
  orderIndex: number;
  side: "BUY" | "SELL";
  limitPriceUsd: string;
  executionPriceUsd: string;
  baseAmount: string;
  grossQuoteUsd: string;
  feeUsd: string;
  slippageUsd: string;
  sourceBlockNumber: string;
}

export interface ShadowGridTerminalPayload extends Record<string, unknown> {
  initialCapitalUsd: string;
  finalEquityUsd: string;
  gasUsd: string;
  feesUsd: string;
  slippageUsd: string;
  netOutcomeUsd: string;
  outcome: "WIN" | "LOSS" | "FLAT";
  finalPriceUsd: string;
  fillCount: number;
  sampledCrossings: number;
  riskExit: boolean;
}

const TERMINAL_TYPES = new Set<ShadowGridEventType>([
  "REFUSED",
  "CLOSED",
  "VOID_SOURCE_GAP",
  "RISK_EXIT",
]);

function fixed(value: number): string {
  if (!Number.isFinite(value)) throw new Error("Shadow-grid arithmetic produced a non-finite value");
  const normalized = Math.abs(value) < 0.000000005 ? 0 : value;
  return normalized.toFixed(8);
}

function publicEventBody(input: Omit<ShadowGridPublicEvent, "eventHash">): Omit<ShadowGridPublicEvent, "eventHash"> {
  return input;
}

export function createShadowGridEvent(input: {
  binding: ShadowGridRunBinding;
  previous: ShadowGridEvent | null;
  eventType: ShadowGridEventType;
  recordedAt: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}): AppendShadowGridEvent {
  const sequence = input.previous ? input.previous.eventSequence + 1 : 0;
  const body = publicEventBody({
    schemaVersion: "positioncrew.bounded-grid-forward-shadow-event.v1",
    runId: input.binding.runId,
    sequence,
    previousEventHash: input.previous?.eventHash ?? null,
    eventType: input.eventType,
    recordedAt: input.recordedAt,
    payload: input.payload,
  });
  const eventHash = canonicalHash(body);
  const event: ShadowGridPublicEvent = { ...body, eventHash };
  return {
    eventId: `${input.binding.runId}:${sequence}:${eventHash.slice(7, 19)}`,
    idempotencyKey: input.idempotencyKey,
    runId: input.binding.runId,
    eventSequence: sequence,
    eventType: input.eventType,
    chainId: 56,
    market: "WBNB/USDT",
    strategyVersion: SHADOW_GRID_STRATEGY_VERSION,
    fillModel: SHADOW_GRID_FILL_MODEL,
    epochStartedAt: input.binding.epochStartedAt,
    horizonEndsAt: input.binding.horizonEndsAt,
    hireId: input.binding.hireId,
    receiptId: input.binding.receiptId,
    requestHash: input.binding.requestHash,
    providerHash: input.binding.providerHash,
    evidenceHash: input.binding.evidenceHash,
    responseHash: input.binding.responseHash,
    deliverableHash: input.binding.deliverableHash,
    evaluationHash: input.binding.evaluationHash,
    eventJson: canonicalJson(event),
    previousEventHash: body.previousEventHash,
    eventHash,
    recordedAt: input.recordedAt,
  };
}

export function parseShadowGridEvent(event: ShadowGridEvent): ShadowGridPublicEvent {
  const parsed = JSON.parse(event.eventJson) as ShadowGridPublicEvent;
  if (
    parsed.schemaVersion !== "positioncrew.bounded-grid-forward-shadow-event.v1" ||
    parsed.runId !== event.runId ||
    parsed.sequence !== event.eventSequence ||
    parsed.eventType !== event.eventType ||
    parsed.previousEventHash !== event.previousEventHash ||
    parsed.eventHash !== event.eventHash ||
    canonicalJson(parsed) !== event.eventJson
  ) {
    throw new Error("Persisted shadow-grid event differs from its canonical record");
  }
  const { eventHash: _eventHash, ...body } = parsed;
  if (canonicalHash(body) !== event.eventHash) {
    throw new Error("Shadow-grid event commitment is invalid");
  }
  return parsed;
}

export function verifyShadowGridRun(events: readonly ShadowGridEvent[]): {
  valid: true;
  headHash: string | null;
} {
  if (events.length === 0) return { valid: true, headHash: null };
  let previous: ShadowGridEvent | null = null;
  let terminal = false;
  for (const [index, event] of events.entries()) {
    if (terminal) throw new Error("Shadow-grid run changed after a terminal event");
    if (event.eventSequence !== index || event.previousEventHash !== previous?.eventHash && !(index === 0 && event.previousEventHash === null)) {
      throw new Error("Shadow-grid event sequence or previous hash is invalid");
    }
    if (event.runId !== events[0]!.runId || event.epochStartedAt !== events[0]!.epochStartedAt || event.horizonEndsAt !== events[0]!.horizonEndsAt) {
      throw new Error("Shadow-grid run invariants changed");
    }
    parseShadowGridEvent(event);
    if (index === 0 && event.eventType !== "EPOCH_STARTED") {
      throw new Error("Shadow-grid run does not begin with EPOCH_STARTED");
    }
    if (previous) {
      const allowed = previous.eventType === "EPOCH_STARTED"
        ? ["PRECOMMITTED", "VOID_SOURCE_GAP"].includes(event.eventType)
        : previous.eventType === "PRECOMMITTED"
          ? ["REFUSED", "OBSERVED", "VOID_SOURCE_GAP"].includes(event.eventType)
          : ["OBSERVED", "SHADOW_FILL"].includes(previous.eventType)
            ? ["OBSERVED", "SHADOW_FILL", "CLOSED", "VOID_SOURCE_GAP", "RISK_EXIT"].includes(event.eventType)
            : false;
      if (!allowed) throw new Error("Shadow-grid lifecycle transition is invalid");
    }
    terminal = TERMINAL_TYPES.has(event.eventType);
    previous = event;
  }
  return { valid: true, headHash: previous?.eventHash ?? null };
}

export function bindingFromShadowGridRun(events: readonly ShadowGridEvent[]): ShadowGridRunBinding {
  if (events.length === 0) throw new Error("Shadow-grid run is empty");
  const first = events[0]!;
  return {
    runId: first.runId,
    epochStartedAt: first.epochStartedAt,
    horizonEndsAt: first.horizonEndsAt,
    hireId: first.hireId,
    receiptId: first.receiptId,
    requestHash: first.requestHash,
    providerHash: first.providerHash,
    evidenceHash: first.evidenceHash,
    responseHash: first.responseHash,
    deliverableHash: first.deliverableHash,
    evaluationHash: first.evaluationHash,
  };
}

export function precommitFromShadowGridRun(events: readonly ShadowGridEvent[]): ShadowGridPrecommitPayload {
  const event = events.find((candidate) => candidate.eventType === "PRECOMMITTED");
  if (!event) throw new Error("Shadow-grid run has no precommitment");
  return parseShadowGridEvent(event).payload as unknown as ShadowGridPrecommitPayload;
}

function samplesFrom(events: readonly ShadowGridEvent[]): ShadowGridPriceSample[] {
  return events.filter((event) => event.eventType === "OBSERVED")
    .map((event) => parseShadowGridEvent(event).payload as unknown as ShadowGridPriceSample);
}

function fillsFrom(events: readonly ShadowGridEvent[]): ShadowGridFillPayload[] {
  return events.filter((event) => event.eventType === "SHADOW_FILL")
    .map((event) => parseShadowGridEvent(event).payload as ShadowGridFillPayload);
}

function portfolio(events: readonly ShadowGridEvent[]): {
  quoteUsd: number;
  baseAmount: number;
  feesUsd: number;
  slippageUsd: number;
  initialCapitalUsd: number;
  gasUsd: number;
} {
  const precommit = precommitFromShadowGridRun(events);
  const capital = Number(precommit.request.constraints.capitalUsd);
  const initialPrice = Number(precommit.request.marketState.midPrice);
  const gasUsd = Number(precommit.request.constraints.estimatedGasUsd);
  let quoteUsd = capital / 2 - gasUsd;
  let baseAmount = capital / 2 / initialPrice;
  let feesUsd = 0;
  let slippageUsd = 0;
  for (const fill of fillsFrom(events)) {
    const quantity = Number(fill.baseAmount);
    const gross = Number(fill.grossQuoteUsd);
    const fee = Number(fill.feeUsd);
    if (fill.side === "BUY") {
      quoteUsd -= gross + fee;
      baseAmount += quantity;
    } else {
      quoteUsd += gross - fee;
      baseAmount -= quantity;
    }
    feesUsd += fee;
    slippageUsd += Number(fill.slippageUsd);
  }
  return { quoteUsd, baseAmount, feesUsd, slippageUsd, initialCapitalUsd: capital, gasUsd };
}

export function deriveShadowGridFills(
  eventsBeforeObservation: readonly ShadowGridEvent[],
  sample: ShadowGridPriceSample,
): ShadowGridFillPayload[] {
  const precommit = precommitFromShadowGridRun(eventsBeforeObservation);
  if (precommit.deliverable.decision !== "BUILD_GRID") return [];
  const previousSamples = samplesFrom(eventsBeforeObservation);
  const previousPrice = Number(previousSamples.at(-1)?.spotPriceUsd ?? precommit.request.marketState.midPrice);
  const nextPrice = Number(sample.spotPriceUsd);
  const alreadyFilled = new Set(fillsFrom(eventsBeforeObservation).map((fill) => fill.orderIndex));
  const state = portfolio(eventsBeforeObservation);
  const feeRate = precommit.request.marketState.venueFeeBps / 10_000;
  const slippageRate = precommit.request.maxSlippageBps / 10_000;
  const output: ShadowGridFillPayload[] = [];
  for (const [orderIndex, order] of precommit.deliverable.orders.entries()) {
    if (alreadyFilled.has(orderIndex)) continue;
    const limit = Number(order.price);
    const crossed = order.side === "BUY"
      ? previousPrice > limit && nextPrice <= limit
      : previousPrice < limit && nextPrice >= limit;
    if (!crossed) continue;
    const executionPrice = order.side === "BUY"
      ? limit * (1 + slippageRate)
      : limit * (1 - slippageRate);
    const requestedBase = Number(order.baseAmount);
    const availableBase = Math.max(0, state.baseAmount);
    const availableQuote = Math.max(0, state.quoteUsd);
    const executableBase = order.side === "BUY"
      ? Math.min(requestedBase, availableQuote / (executionPrice * (1 + feeRate)))
      : Math.min(requestedBase, availableBase);
    if (!Number.isFinite(executableBase) || executableBase <= 0) continue;
    const grossQuote = executableBase * executionPrice;
    const feeUsd = grossQuote * feeRate;
    const slippageUsd = Math.abs(executionPrice - limit) * executableBase;
    const fill: ShadowGridFillPayload = {
      orderIndex,
      side: order.side,
      limitPriceUsd: fixed(limit),
      executionPriceUsd: fixed(executionPrice),
      baseAmount: fixed(executableBase),
      grossQuoteUsd: fixed(grossQuote),
      feeUsd: fixed(feeUsd),
      slippageUsd: fixed(slippageUsd),
      sourceBlockNumber: sample.source.blockNumber,
    };
    output.push(fill);
    if (order.side === "BUY") {
      state.quoteUsd -= grossQuote + feeUsd;
      state.baseAmount += executableBase;
    } else {
      state.quoteUsd += grossQuote - feeUsd;
      state.baseAmount -= executableBase;
    }
  }
  return output;
}

export function calculateShadowGridTerminal(
  events: readonly ShadowGridEvent[],
  finalSample: ShadowGridPriceSample,
): ShadowGridTerminalPayload {
  const precommit = precommitFromShadowGridRun(events);
  const state = portfolio(events);
  const finalPrice = Number(finalSample.spotPriceUsd);
  const finalEquity = state.quoteUsd + state.baseAmount * finalPrice;
  const net = finalEquity - state.initialCapitalUsd;
  const lower = Number(precommit.request.constraints.lowerPrice);
  const upper = Number(precommit.request.constraints.upperPrice);
  const maximumLoss = Number(precommit.request.constraints.maximumLossUsd);
  const riskExit = finalPrice <= lower || finalPrice >= upper || net <= -maximumLoss;
  return {
    initialCapitalUsd: fixed(state.initialCapitalUsd),
    finalEquityUsd: fixed(finalEquity),
    gasUsd: fixed(state.gasUsd),
    feesUsd: fixed(state.feesUsd),
    slippageUsd: fixed(state.slippageUsd),
    netOutcomeUsd: fixed(net),
    outcome: net > 0.000000005 ? "WIN" : net < -0.000000005 ? "LOSS" : "FLAT",
    finalPriceUsd: fixed(finalPrice),
    fillCount: fillsFrom(events).length,
    sampledCrossings: fillsFrom(events).length,
    riskExit,
  };
}

export function shadowGridRunState(events: readonly ShadowGridEvent[]): "PRECOMMITTED" | "REFUSED" | "CLOSED" | "VOID_SOURCE_GAP" | "RISK_EXIT" {
  const latest = events.at(-1)?.eventType;
  return latest === "REFUSED" || latest === "CLOSED" || latest === "VOID_SOURCE_GAP" || latest === "RISK_EXIT"
    ? latest
    : "PRECOMMITTED";
}

export function shadowGridRunIsTerminal(events: readonly ShadowGridEvent[]): boolean {
  const latest = events.at(-1);
  return latest ? TERMINAL_TYPES.has(latest.eventType) : false;
}

export function publicShadowGridWindow(events: readonly ShadowGridEvent[], origin: string) {
  verifyShadowGridRun(events);
  const hasPrecommit = events.some((event) => event.eventType === "PRECOMMITTED");
  const precommit = hasPrecommit ? precommitFromShadowGridRun(events) : null;
  const latest = parseShadowGridEvent(events.at(-1)!);
  if (!precommit && latest.eventType !== "VOID_SOURCE_GAP") {
    throw new Error("A public shadow-grid window requires a precommitment unless initialization was terminally voided");
  }
  const terminalPayload = TERMINAL_TYPES.has(events.at(-1)!.eventType)
    ? latest.payload as Record<string, unknown>
    : null;
  return {
    windowId: events[0]!.runId,
    state: shadowGridRunState(events),
    pair: "WBNB/USDT" as const,
    sourceHireId: precommit?.sourceHireId ?? events[0]!.hireId,
    sourceRequestHash: precommit?.sourceRequestHash ?? events[0]!.requestHash,
    sourceReceiptUrl: precommit ? new URL(precommit.sourceReceiptUrl, origin).toString() : null,
    sourceBlockNumber: precommit?.sourceBlockNumber ?? null,
    startedAt: events[0]!.epochStartedAt,
    terminalAt: shadowGridRunIsTerminal(events) ? events.at(-1)!.recordedAt : null,
    horizonMinutes: 15 as const,
    sampledCrossings: fillsFrom(events).length,
    simulatedNetOutcomeUsd: typeof terminalPayload?.netOutcomeUsd === "string"
      ? terminalPayload.netOutcomeUsd
      : null,
    receiptUrl: new URL(`/api/evidence/bounded-grid-forward-shadow/windows/${events[0]!.runId}`, origin).toString(),
    eventHash: events.at(-1)!.eventHash,
    previousEventHash: events.at(-1)!.previousEventHash,
  };
}

export function summarizeShadowGridRuns(
  runs: readonly (readonly ShadowGridEvent[])[],
  origin: string,
  now = new Date(),
) {
  const valid = runs.every((run) => {
    try {
      return verifyShadowGridRun(run).valid;
    } catch {
      return false;
    }
  });
  const windows = runs.map((run) => publicShadowGridWindow(run, origin));
  const terminal = windows.filter((window) => window.terminalAt !== null);
  const closed = windows.filter((window) => window.state === "CLOSED");
  const refused = windows.filter((window) => window.state === "REFUSED");
  const voided = windows.filter((window) => window.state === "VOID_SOURCE_GAP");
  const risk = windows.filter((window) => window.state === "RISK_EXIT");
  const returnBearing = [...closed, ...risk];
  const positive = returnBearing.filter((window) => Number(window.simulatedNetOutcomeUsd) > 0);
  const negative = returnBearing.filter((window) => Number(window.simulatedNetOutcomeUsd) < 0);
  const oldest = runs.length > 0
    ? Math.min(...runs.map((run) => Date.parse(run[0]!.epochStartedAt)))
    : now.getTime();
  const observedDays = Math.max(0, (now.getTime() - oldest) / 86_400_000);
  const nonVoidRatePct = terminal.length === 0
    ? null
    : Number((((terminal.length - voided.length) / terminal.length) * 100).toFixed(2));
  const mature = valid && observedDays >= 7 && terminal.length >= 30 && (nonVoidRatePct ?? 0) >= 90;
  const aggregate = returnBearing.reduce(
    (sum, window) => sum + Number(window.simulatedNetOutcomeUsd ?? 0),
    0,
  );
  const degraded = !valid || (terminal.length >= 30 && (nonVoidRatePct ?? 0) < 90);
  return {
    schemaVersion: "positioncrew.bounded-grid-forward-shadow-ledger.v1" as const,
    generatedAt: now.toISOString(),
    status: degraded ? "DEGRADED" as const : mature ? "MATURE" as const : "COLLECTING" as const,
    publicUrl: new URL("/api/evidence/bounded-grid-forward-shadow", origin).toString(),
    model: {
      name: SHADOW_GRID_FILL_MODEL,
      strategyVersion: SHADOW_GRID_STRATEGY_VERSION,
      pair: "WBNB/USDT" as const,
      capitalMode: "ZERO_FUND_SHADOW" as const,
      cadenceMinutes: 60 as const,
      sampleCadenceMinutes: 5 as const,
      horizonMinutes: 15 as const,
    },
    maturity: {
      observedDays: Number(observedDays.toFixed(2)),
      terminalWindowCount: terminal.length,
      minimumObservedDays: 7 as const,
      minimumTerminalWindows: 30 as const,
      nonVoidRatePct,
      minimumNonVoidRatePct: 90 as const,
      hashChainValid: valid,
      mature,
    },
    summary: {
      precommittedWindowCount: windows.length,
      terminalWindowCount: terminal.length,
      closedWindowCount: closed.length,
      refusedWindowCount: refused.length,
      voidWindowCount: voided.length,
      riskExitWindowCount: risk.length,
      positiveWindowCount: positive.length,
      negativeWindowCount: negative.length,
      simulatedNetOutcomeUsd: mature ? fixed(aggregate) : null,
    },
    recentWindows: windows.sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt)).slice(0, 10),
    claimBoundary: [...SHADOW_GRID_PUBLIC_CLAIM_BOUNDARY],
  };
}
