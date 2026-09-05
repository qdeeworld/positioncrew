import { describe, expect, it } from "vitest";
import lpConstraintFixture from "../fixtures/lp-rebalance/out-of-range-v3-position.v1.json" with { type: "json" };
import {
  PositionCrewDeliverableSchema,
  PositionCrewRequestSchema,
  type PositionCrewDeliverable,
  type PositionCrewRequest,
} from "../src/contracts/index.js";
import { evaluateProviderConformance } from "../src/evaluators/provider-conformance.js";
import { createProviderConformanceExamples } from "../src/marketplace/provider-conformance-examples.js";
import { executeProvider } from "../src/providers/index.js";

const REQUESTED = "2026-08-12T16:00:00.000Z";
const OBSERVED = "2026-08-12T16:00:20.000Z";
const BACKDATED = "2026-08-12T16:00:01.000Z";
const BEFORE_REQUEST = "2026-08-12T15:59:59.999Z";
const FUTURE = "2026-08-12T16:00:31.000Z";
const NOW = new Date("2026-08-12T16:00:30.000Z");
const checkId = "evidence-generation-chronology";
const services = ["LENDING_RESCUE", "LP_REBALANCE", "YIELD_OPTIMIZATION", "BOUNDED_GRID"] as const;

function rebaseObservations(value: unknown, observedAt: string): unknown {
  if (Array.isArray(value)) return value.map((item) => rebaseObservations(item, observedAt));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, key === "observedAt" ? observedAt : rebaseObservations(item, observedAt)]));
  }
  return value;
}

function fromFixture(input: unknown, observedAt = OBSERVED): PositionCrewRequest {
  const request = PositionCrewRequestSchema.parse(rebaseObservations(input, observedAt));
  request.requestedAt = REQUESTED;
  request.deadline = "2026-08-12T16:05:00.000Z";
  return request;
}

function requestFor(service: PositionCrewRequest["service"], observedAt = OBSERVED) {
  const example = createProviderConformanceExamples().find((entry) => entry.request.service === service)!;
  return fromFixture(example.request, observedAt);
}

function yieldRequest(observedAt = OBSERVED) {
  const request = requestFor("YIELD_OPTIMIZATION", observedAt);
  if (request.service !== "YIELD_OPTIMIZATION") throw new Error("Expected Yield request.");
  return request;
}

function expectChronology(
  request: PositionCrewRequest,
  output: PositionCrewDeliverable,
  passed: boolean,
  now = NOW,
) {
  const receipt = evaluateProviderConformance(request, output, "positioncrew:evidence-chronology-regression", now);
  expect(receipt.checks.find((check) => check.id === checkId)).toMatchObject({ passed, critical: true });
  expect(receipt.passed).toBe(passed);
  // Chronology is critical but has zero rubric weight: rejection need not
  // change the historic numeric score, and cannot be inferred from it alone.
  if (passed) expect(receipt.score).toBe(100);
}

function noActionRequest(service: PositionCrewRequest["service"]) {
  const request = requestFor(service);
  switch (request.service) {
    case "LENDING_RESCUE":
      for (const debt of request.position.debt) debt.amount = "1";
      break;
    case "LP_REBALANCE":
      request.marketState.currentTick = 0;
      request.marketState.token0PriceUsd = "1";
      request.position.token0ShareBps = 5_000;
      request.position.token1ShareBps = 5_000;
      break;
    case "YIELD_OPTIMIZATION":
      request.maxActionUsd = "0.000000000000000001";
      break;
    case "BOUNDED_GRID":
      request.constraints.minimumExpectedNetProfitUsd = "1000000";
      break;
  }
  return request;
}

for (const service of services) {
  describe(`${service} evidence and generation chronology`, () => {
    it.each([
      { label: "the exact latest observation", generatedAt: OBSERVED, passed: true },
      { label: "a timestamp before the consumed observation", generatedAt: BACKDATED, passed: false },
      { label: "a timestamp before the request", generatedAt: BEFORE_REQUEST, passed: false },
      { label: "a future generation timestamp", generatedAt: FUTURE, passed: false },
    ])("checks $label without changing native actionable economics", ({ generatedAt, passed }) => {
      const request = requestFor(service);
      const output = executeProvider(request, NOW);
      expect(output.status).toBe("ACTIONABLE");
      expectChronology(request, { ...output, generatedAt }, passed);
    });

    it("rejects a non-finite generation timestamp at the schema boundary", () => {
      const request = requestFor(service);
      const output = { ...executeProvider(request, NOW), generatedAt: "not-a-timestamp" };
      expect(PositionCrewDeliverableSchema.safeParse(output).success).toBe(false);
      expect(() => evaluateProviderConformance(request, output, "positioncrew:evidence-chronology-regression", NOW)).toThrow();
    });

    it("applies chronology to a legitimate native NO_ACTION result", () => {
      const request = noActionRequest(service);
      const output = executeProvider(request, NOW);
      expect(output.status).toBe("NO_ACTION");
      expectChronology(request, { ...output, generatedAt: OBSERVED }, true);
      expectChronology(request, { ...output, generatedAt: BACKDATED }, false);
      expectChronology(request, { ...output, generatedAt: FUTURE }, false);
    });

    it.each(["stale", "expired"] as const)("still enforces generation bounds on a required %s refusal", (kind) => {
      const request = requestFor(service);
      if (kind === "stale") request.maxDataAgeSeconds = 15;
      const now = kind === "expired" ? new Date(request.deadline) : new Date("2026-08-12T16:00:40.000Z");
      const output = executeProvider(request, now);
      expect(output.status).toBe(kind === "expired" ? "REFUSED_EXPIRED" : "REFUSED_STALE_DATA");
      expectChronology(request, output, true, now);
      expectChronology(request, { ...output, generatedAt: BACKDATED }, false, now);
      expectChronology(request, { ...output, generatedAt: new Date(now.getTime() + 1).toISOString() }, false, now);
    });

    it("can refuse all-future evidence without claiming it was available, but cannot backdate before the request", () => {
      const request = requestFor(service, FUTURE);
      const output = executeProvider(request, NOW);
      expect(output.status).toBe("REFUSED_INCONSISTENT_DATA");
      expectChronology(request, output, true);
      expectChronology(request, { ...output, generatedAt: BACKDATED }, true);
      expectChronology(request, { ...output, generatedAt: BEFORE_REQUEST }, false);
      expectChronology(request, { ...output, generatedAt: FUTURE }, false);
      expectChronology(request, { ...output, status: "REFUSED_CONSTRAINTS" }, false);
    });
  });
}

describe("refusal exceptions retain every non-future evidence bound", () => {
  it.each(["LENDING_RESCUE", "LP_REBALANCE"] as const)("enforces chronology on a genuine %s constraint refusal", (service) => {
    const request = service === "LP_REBALANCE" ? fromFixture(lpConstraintFixture) : requestFor(service);
    if (request.service === "LENDING_RESCUE") request.availableAssets = [];
    else if (request.service === "LP_REBALANCE") {
      Object.assign(request.constraints, { minimumWidthTicks: 61, maximumWidthTicks: 119, tickSpacing: 60 });
    } else throw new Error("Expected Lending or LP request.");
    const output = executeProvider(request, NOW);
    expect(output.status).toBe("REFUSED_CONSTRAINTS");
    expectChronology(request, output, true);
    expectChronology(request, { ...output, generatedAt: BACKDATED }, false);
    expectChronology(request, { ...output, generatedAt: FUTURE }, false);
  });

  it("retains the valid 16:00:20 floor when another bound source is future-dated", () => {
    const request = yieldRequest();
    const source = { ...request.sources[0]!, sourceId: "future-yield-source", observedAt: FUTURE };
    request.sources.push(source);
    request.opportunities[0]!.sourceId = source.sourceId;
    request.opportunities[0]!.observedAt = source.observedAt;
    const output = executeProvider(request, NOW);
    if (output.service !== "YIELD_OPTIMIZATION") throw new Error("Expected a Yield output.");
    expect(output.status).toBe("REFUSED_INCONSISTENT_DATA");
    expectChronology(request, { ...output, generatedAt: OBSERVED }, true);
    expectChronology(request, { ...output, generatedAt: BACKDATED }, false);
    expectChronology(request, { ...output, generatedAt: FUTURE }, false);
    expectChronology(request, { ...output, status: "NO_ACTION", decision: "HOLD" }, false);
  });

  it.each(["missing-source-id", "mismatched-timestamp"] as const)("does not hide a later observation behind %s", (mismatch) => {
    const request = yieldRequest();
    const later = "2026-08-12T16:00:25.000Z";
    request.opportunities[0]!.observedAt = later;
    if (mismatch === "missing-source-id") request.opportunities[0]!.sourceId = "unbound-yield-observation";
    const output = executeProvider(request, NOW);
    expect(output.status).toBe("REFUSED_INCONSISTENT_DATA");
    expectChronology(request, { ...output, generatedAt: later }, true);
    expectChronology(request, { ...output, generatedAt: OBSERVED }, false);
  });

  it("does not discard the timestamp of an unmatched non-future source", () => {
    const request = yieldRequest();
    const later = "2026-08-12T16:00:25.000Z";
    request.sources.push({ ...request.sources[0]!, sourceId: "additional-non-future-source", observedAt: later });
    const output = executeProvider(request, NOW);
    expect(output.status).toBe("ACTIONABLE");
    expectChronology(request, { ...output, generatedAt: later }, true);
    expectChronology(request, { ...output, generatedAt: OBSERVED }, false);
  });

  it("preserves expired-before-inconsistent precedence when the evidence is also future-dated", () => {
    const request = yieldRequest("2026-08-12T16:05:01.000Z");
    const now = new Date(request.deadline);
    const output = executeProvider(request, now);
    expect(output.status).toBe("REFUSED_EXPIRED");
    expectChronology(request, output, true, now);
    expectChronology(request, { ...output, generatedAt: BEFORE_REQUEST }, false, now);
    expectChronology(request, { ...output, generatedAt: new Date(now.getTime() + 1).toISOString() }, false, now);
    expectChronology(request, { ...output, status: "REFUSED_INCONSISTENT_DATA" }, false, now);
  });
});
