import { describe, expect, it } from "vitest";
import boundedGridFixture from "../fixtures/bounded-grid/bnb-usdt-grid.v1.json" with { type: "json" };
import { BoundedGridRequestSchema } from "../src/contracts/index.js";
import { createBoundedGridDeliverable } from "../src/providers/bounded-grid.js";
import {
  SHADOW_GRID_FILL_MODEL,
  SHADOW_GRID_PUBLIC_CLAIM_BOUNDARY,
  SHADOW_GRID_STRATEGY_VERSION,
  calculateShadowGridTerminal,
  createShadowGridEvent,
  deriveShadowGridFills,
  parseShadowGridEvent,
  summarizeShadowGridRuns,
  verifyShadowGridRun,
  type ShadowGridPriceSample,
  type ShadowGridRunBinding,
} from "../src/operations/bounded-grid-forward-shadow.js";

type StoredEvent = Parameters<typeof verifyShadowGridRun>[0][number];

const ORIGIN = "https://positioncrew.dolepee.com";
const STARTED_AT = "2026-08-24T10:02:00.000Z";
const HORIZON_ENDS_AT = "2026-08-24T10:17:00.000Z";

function binding(ordinal = 1): ShadowGridRunBinding {
  return {
    runId: `forward-shadow-${String(ordinal).padStart(3, "0")}`,
    epochStartedAt: new Date(Date.parse(STARTED_AT) + ordinal * 3_600_000).toISOString(),
    horizonEndsAt: new Date(Date.parse(HORIZON_ENDS_AT) + ordinal * 3_600_000).toISOString(),
    hireId: `${String(ordinal).padStart(8, "0")}-1111-4111-8111-111111111111`,
    receiptId: `${String(ordinal).padStart(8, "0")}-2222-4222-8222-222222222222`,
    requestHash: `sha256:${"11".repeat(32)}`,
    providerHash: `sha256:${"22".repeat(32)}`,
    evidenceHash: `sha256:${"33".repeat(32)}`,
    responseHash: `sha256:${"44".repeat(32)}`,
    deliverableHash: `sha256:${"55".repeat(32)}`,
    evaluationHash: `sha256:${"66".repeat(32)}`,
  };
}

function requestAndDeliverable(now = new Date(STARTED_AT)) {
  const observedAt = now.toISOString();
  const rebaseObservationTimes = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rebaseObservationTimes);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        key === "observedAt" ? observedAt : rebaseObservationTimes(child),
      ]),
    );
  };
  const request = BoundedGridRequestSchema.parse(
    rebaseObservationTimes(structuredClone(boundedGridFixture)),
  );
  request.requestedAt = now.toISOString();
  request.deadline = new Date(now.getTime() + 20 * 60_000).toISOString();
  const deliverable = createBoundedGridDeliverable(request, now);
  return { request, deliverable };
}

function append(
  events: StoredEvent[],
  runBinding: ShadowGridRunBinding,
  eventType: Parameters<typeof createShadowGridEvent>[0]["eventType"],
  recordedAt: string,
  payload: Record<string, unknown>,
): StoredEvent[] {
  const event = createShadowGridEvent({
    binding: runBinding,
    previous: events.at(-1) ?? null,
    eventType,
    recordedAt,
    payload,
    idempotencyKey: `${runBinding.runId}:${events.length}:${eventType}`,
  }) as unknown as StoredEvent;
  return [...events, event];
}

function precommittedRun(ordinal = 1): StoredEvent[] {
  const runBinding = binding(ordinal);
  const startedAt = new Date(runBinding.epochStartedAt);
  const { request, deliverable } = requestAndDeliverable(startedAt);
  let events: StoredEvent[] = [];
  events = append(events, runBinding, "EPOCH_STARTED", startedAt.toISOString(), {
    strategyVersion: SHADOW_GRID_STRATEGY_VERSION,
    fillModel: SHADOW_GRID_FILL_MODEL,
  });
  events = append(
    events,
    runBinding,
    "PRECOMMITTED",
    new Date(startedAt.getTime() + 5_000).toISOString(),
    {
      schedule: {
        event: "schedule",
        repository: "dolepee/positioncrew",
        workflowPath: ".github/workflows/production-smoke.yml",
        runId: String(10_000 + ordinal),
        runAttempt: "1",
        headSha: String(ordinal).padStart(40, "0"),
        workflowRef:
          "dolepee/positioncrew/.github/workflows/production-smoke.yml@refs/heads/main",
        recordedAt: startedAt.toISOString(),
      },
      sourceHireId: runBinding.hireId,
      sourceReceiptId: runBinding.receiptId,
      sourceReceiptUrl: `/api/benchmark-receipts/${runBinding.receiptId}`,
      sourceRequestHash: runBinding.requestHash,
      sourceBlockNumber: "71000001",
      sourceBlockTimestamp: startedAt.toISOString(),
      request,
      deliverable,
    },
  );
  return events;
}

function sample(
  sampledAt: string,
  spotPriceUsd: string,
  blockNumber = "71000002",
): ShadowGridPriceSample {
  return {
    sampledAt,
    spotPriceUsd,
    source: {
      chainId: 56,
      market: "WBNB/USDT",
      protocol: "PancakeSwap V3",
      poolAddress: "0x0000000000000000000000000000000000000001",
      blockNumber,
      blockHash: `0x${"ab".repeat(32)}`,
      blockTimestamp: sampledAt,
      explorerUrl: `https://bscscan.com/block/${blockNumber}`,
      confirmationDepth: 32,
      finality: "FINALIZED_OR_32_CONFIRMATIONS",
    },
  };
}

function terminalRun(ordinal: number, voided: boolean, negative = false): StoredEvent[] {
  const runBinding = binding(ordinal);
  let events = precommittedRun(ordinal);
  if (voided) {
    return append(events, runBinding, "VOID_SOURCE_GAP", runBinding.horizonEndsAt, {
      missingSampleAt: new Date(Date.parse(runBinding.epochStartedAt) + 5 * 60_000).toISOString(),
      reason: "PROTECTED_TICK_MISSING",
    });
  }
  const observed = sample(
    new Date(Date.parse(runBinding.epochStartedAt) + 5 * 60_000).toISOString(),
    "588.00000000",
    String(71_000_000 + ordinal),
  );
  events = append(events, runBinding, "OBSERVED", observed.sampledAt, { ...observed });
  return append(events, runBinding, "CLOSED", runBinding.horizonEndsAt, {
    initialCapitalUsd: "1000.00000000",
    finalEquityUsd: negative ? "998.00000000" : "1002.00000000",
    gasUsd: "0.50000000",
    feesUsd: "0.75000000",
    slippageUsd: "0.25000000",
    netOutcomeUsd: negative ? "-2.00000000" : "2.00000000",
    outcome: negative ? "LOSS" : "WIN",
    finalPriceUsd: "588.00000000",
    fillCount: 1,
    sampledCrossings: 1,
    riskExit: false,
  });
}

describe("bounded-grid forward shadow evidence", () => {
  it("rejects a mutated canonical event and a broken previous-hash link", () => {
    const events = precommittedRun();
    expect(verifyShadowGridRun(events)).toMatchObject({ valid: true });

    const mutated = structuredClone(events);
    mutated[1]!.eventJson = mutated[1]!.eventJson.replace(
      "PRECOMMITTED",
      "OBSERVED",
    );
    expect(() => parseShadowGridEvent(mutated[1]!)).toThrow(/canonical|commitment/u);

    const unlinked = structuredClone(events);
    unlinked[1]!.previousEventHash = `sha256:${"ff".repeat(32)}`;
    expect(() => verifyShadowGridRun(unlinked)).toThrow(/sequence|previous hash/u);
  });

  it("accepts a genesis source-gap void once and preserves its terminal head", () => {
    const runBinding = binding(91);
    const startedAt = runBinding.epochStartedAt;
    const genesis = append([], runBinding, "EPOCH_STARTED", startedAt, {
      schedule: {
        event: "schedule",
        repository: "dolepee/positioncrew",
        workflowPath: ".github/workflows/production-smoke.yml",
        runId: "10991",
        runAttempt: "1",
        headSha: "9".repeat(40),
        workflowRef:
          "dolepee/positioncrew/.github/workflows/production-smoke.yml@refs/heads/main",
        recordedAt: startedAt,
      },
      method: "FORWARD_ONLY_ACTUAL_SAMPLES",
      sampleCadenceMinutes: 5,
      horizonMinutes: 15,
      backfill: "PROHIBITED",
      capitalMode: "ZERO_FUND_SHADOW",
    });
    const voided = append(
      genesis,
      runBinding,
      "VOID_SOURCE_GAP",
      new Date(Date.parse(startedAt) + 60_000).toISOString(),
      {
        reason: "Opening deadline elapsed before immutable precommitment",
        observedSampleCount: 0,
        netOutcomeUsd: null,
        outcome: null,
        repairedLater: false,
      },
    );

    const terminalIntegrity = verifyShadowGridRun(voided);
    expect(terminalIntegrity).toMatchObject({ valid: true });
    expect(verifyShadowGridRun(voided)).toEqual(terminalIntegrity);

    for (const eventType of [
      "PRECOMMITTED",
      "OBSERVED",
      "SHADOW_FILL",
      "CLOSED",
      "VOID_SOURCE_GAP",
    ] as const) {
      const changedAfterTerminal = append(
        voided,
        runBinding,
        eventType,
        new Date(Date.parse(startedAt) + 120_000).toISOString(),
        {},
      );
      expect(() => verifyShadowGridRun(changedAfterTerminal)).toThrow(/terminal/u);
    }
  });

  it("uses actual sampled crossings and charges conservative costs", () => {
    const events = precommittedRun();
    const precommit = parseShadowGridEvent(events[1]!);
    const deliverable = precommit.payload.deliverable as ReturnType<
      typeof createBoundedGridDeliverable
    >;
    expect(deliverable.decision).toBe("BUILD_GRID");
    const order = deliverable.orders[0]!;
    const crossedPrice = order.side === "BUY"
      ? (Number(order.price) - 1).toFixed(8)
      : (Number(order.price) + 1).toFixed(8);
    const actualSample = sample(
      new Date(Date.parse(binding().epochStartedAt) + 5 * 60_000).toISOString(),
      crossedPrice,
    );
    const fills = deriveShadowGridFills(events, actualSample);

    expect(fills.length).toBeGreaterThan(0);
    const fill = fills.find((candidate) => candidate.orderIndex === 0)!;
    expect(fill.sourceBlockNumber).toBe(actualSample.source.blockNumber);
    expect(Number(fill.feeUsd)).toBeGreaterThan(0);
    expect(Number(fill.slippageUsd)).toBeGreaterThan(0);
    if (fill.side === "BUY") {
      expect(Number(fill.executionPriceUsd)).toBeGreaterThan(Number(fill.limitPriceUsd));
    } else {
      expect(Number(fill.executionPriceUsd)).toBeLessThan(Number(fill.limitPriceUsd));
    }
  });

  it("retains a negative zero-fund terminal outcome without failing integrity", () => {
    const runBinding = binding();
    let events = precommittedRun();
    const precommit = parseShadowGridEvent(events[1]!);
    const request = precommit.payload.request as { marketState: { midPrice: string } };
    const finalSample = sample(
      runBinding.horizonEndsAt,
      request.marketState.midPrice,
    );
    events = append(events, runBinding, "OBSERVED", finalSample.sampledAt, { ...finalSample });
    const terminal = calculateShadowGridTerminal(events, finalSample);
    expect(Number(terminal.netOutcomeUsd)).toBeLessThan(0);
    events = append(events, runBinding, "CLOSED", runBinding.horizonEndsAt, terminal);

    expect(verifyShadowGridRun(events)).toMatchObject({ valid: true });
    const summary = summarizeShadowGridRuns(
      [events],
      ORIGIN,
      new Date("2026-09-02T12:00:00.000Z"),
    );
    expect(summary.summary.negativeWindowCount).toBe(1);
    expect(summary.summary.positiveWindowCount).toBe(0);
    expect(summary.summary.simulatedNetOutcomeUsd).toBeNull();
    expect(summary.status).toBe("COLLECTING");
  });

  it("makes a missed actual sample terminal and forbids retrospective repair", () => {
    const runBinding = binding();
    const voided = append(
      precommittedRun(),
      runBinding,
      "VOID_SOURCE_GAP",
      new Date(Date.parse(runBinding.epochStartedAt) + 10 * 60_000).toISOString(),
      {
        missingSampleAt: new Date(Date.parse(runBinding.epochStartedAt) + 5 * 60_000).toISOString(),
        reason: "PROTECTED_TICK_MISSING",
      },
    );
    expect(verifyShadowGridRun(voided)).toMatchObject({ valid: true });
    const retrospectivelyRepaired = append(
      voided,
      runBinding,
      "OBSERVED",
      runBinding.horizonEndsAt,
      { ...sample(runBinding.horizonEndsAt, "590.00000000") },
    );
    expect(() => verifyShadowGridRun(retrospectivelyRepaired)).toThrow(/terminal/u);
  });

  it("requires seven days, thirty terminal windows, ninety-percent non-void coverage, and a valid chain", () => {
    const matureRuns = Array.from({ length: 30 }, (_, index) =>
      terminalRun(index + 1, index < 3, index === 3),
    );
    const mature = summarizeShadowGridRuns(
      matureRuns,
      ORIGIN,
      new Date("2026-10-01T00:00:00.000Z"),
    );
    expect(mature.status).toBe("MATURE");
    expect(mature.maturity).toMatchObject({
      terminalWindowCount: 30,
      nonVoidRatePct: 90,
      hashChainValid: true,
      mature: true,
    });
    expect(mature.summary.voidWindowCount).toBe(3);
    expect(mature.summary.negativeWindowCount).toBe(1);

    const degradedRuns = Array.from({ length: 30 }, (_, index) =>
      terminalRun(index + 1, index < 4),
    );
    const degraded = summarizeShadowGridRuns(
      degradedRuns,
      ORIGIN,
      new Date("2026-10-01T00:00:00.000Z"),
    );
    expect(degraded.status).toBe("DEGRADED");
    expect(degraded.maturity.nonVoidRatePct).toBeLessThan(90);
  });

  it("publishes the permanent bounded claim", () => {
    expect(SHADOW_GRID_PUBLIC_CLAIM_BOUNDARY.join(" ")).toContain(
      "not transactions, executable fills, realised PnL, strategy returns, or audited financial performance",
    );
  });
});
