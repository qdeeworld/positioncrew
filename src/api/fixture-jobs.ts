import lendingFixture from "../../fixtures/lending-rescue/stressed-venus-position.v1.json" with { type: "json" };
import lpFixture from "../../fixtures/lp-rebalance/out-of-range-v3-position.v1.json" with { type: "json" };
import yieldFixture from "../../fixtures/yield-optimization/venus-to-beefy.v1.json" with { type: "json" };
import gridFixture from "../../fixtures/bounded-grid/bnb-usdt-grid.v1.json" with { type: "json" };
import benchmarkProtocol from "../../benchmarks/lending-rescue/protocol.v2.json" with { type: "json" };
import benchmarkRubric from "../../benchmarks/lending-rescue/rubric.v1.json" with { type: "json" };
import lpBenchmarkProtocol from "../../benchmarks/lp-rebalance/protocol.v2.json" with { type: "json" };
import lpBenchmarkRubric from "../../benchmarks/lp-rebalance/rubric.v1.json" with { type: "json" };
import gridBenchmarkProtocol from "../../benchmarks/bounded-grid/protocol.v2.json" with { type: "json" };
import gridBenchmarkRubric from "../../benchmarks/bounded-grid/rubric.v1.json" with { type: "json" };
import { runProviderJob, type ProviderJobResult } from "../application/run-provider-job.js";
import type {
  BenchmarkLock,
  TermixBenchmarkService,
  TermixBenchmarkSlug,
} from "../benchmark/lock.js";
import { MemoryCommerceAdapter } from "../commerce/memory-adapter.js";
import {
  LendingRescueRequestSchema,
  PositionCrewRequestSchema,
  type PositionCrewRequest,
} from "../contracts/index.js";
import { canonicalHash } from "../core/canonical.js";

const FIXTURE_NOW = new Date("2026-08-12T16:00:30.000Z");
const FIXTURES = [lendingFixture, lpFixture, yieldFixture, gridFixture] as const;
const TERMIX_BENCHMARKS = [
  {
    slug: "lending-rescue",
    service: "LENDING_RESCUE",
    protocol: benchmarkProtocol,
    rubric: benchmarkRubric,
    fixture: lendingFixture,
  },
  {
    slug: "lp-rebalance",
    service: "LP_REBALANCE",
    protocol: lpBenchmarkProtocol,
    rubric: lpBenchmarkRubric,
    fixture: lpFixture,
  },
  {
    slug: "bounded-grid",
    service: "BOUNDED_GRID",
    protocol: gridBenchmarkProtocol,
    rubric: gridBenchmarkRubric,
    fixture: gridFixture,
  },
] as const;

function benchmarkLockFor(service: TermixBenchmarkService): BenchmarkLock {
  const benchmark = TERMIX_BENCHMARKS.find((candidate) => candidate.service === service);
  if (!benchmark) throw new Error(`No TermiX benchmark exists for ${service}`);
  return {
    schemaVersion: "positioncrew.benchmark-lock.v1",
    taskId: benchmark.protocol.taskId,
    fixtureHash: canonicalHash(benchmark.fixture),
    rubricHash: canonicalHash(benchmark.rubric),
    protocolHash: canonicalHash(benchmark.protocol),
  };
}

export const CLAIM_BOUNDARY = [
  "Frozen BSC test fixtures are used; no live wallet or protocol state is read.",
  "The lifecycle is an in-memory conformance rail, not an AACP or mainnet settlement.",
  "A 100/100 receipt means the output satisfied deterministic contract checks, not that agent advantage has been established.",
] as const;

export interface FixtureJobResponse {
  schemaVersion: "positioncrew.fixture-job-response.v1";
  evidenceMode: "FROZEN_BSC_TEST_FIXTURE" | "CALLER_SUPPLIED_OBSERVATIONS" | "CURRENT_BLOCK_PINNED";
  commerceMode: "IN_MEMORY_CONFORMANCE";
  advantageStatus: "PENDING_INDEPENDENT_BLIND_EVALUATION";
  generatedAt: string;
  claimBoundary: readonly string[];
  benchmarkLock: BenchmarkLock | null;
  receipt: {
    mode: "PUBLIC_REPRODUCIBLE" | "SESSION_EMBEDDED";
    path: string | null;
    evaluationHash: string;
  };
  result: ProviderJobResult;
}

export interface BenchmarkRepeatabilityResponse {
  schemaVersion: "positioncrew.benchmark-repeatability.v1";
  generatedAt: string;
  benchmarkSlug: TermixBenchmarkSlug;
  service: TermixBenchmarkService;
  taskId: string;
  status: "REPRODUCIBLE_AGENT_REPEATS_MANUAL_PENDING";
  benchmarkLock: BenchmarkLock;
  runs: Array<{
    runId: string;
    elapsedMilliseconds: number;
    directCostUsd: "0.00";
    qualityScore: number;
    criticalFailureCount: number;
    outputHash: string;
  }>;
  medianElapsedMilliseconds: number;
  pending: readonly ["MANUAL_BASELINE", "INDEPENDENT_BLIND_SCORECARD"];
  boundary: string;
}

export interface BenchmarkRepeatabilityMatrixResponse {
  schemaVersion: "positioncrew.benchmark-repeatability-matrix.v1";
  generatedAt: string;
  records: BenchmarkRepeatabilityResponse[];
  pending: readonly ["MANUAL_BASELINES", "INDEPENDENT_BLIND_SCORECARDS"];
  boundary: string;
}

export type LendingRepeatabilityResponse = BenchmarkRepeatabilityResponse;

export async function runFrozenFixture(
  service: PositionCrewRequest["service"],
): Promise<FixtureJobResponse> {
  const fixture = FIXTURES.find((candidate) => candidate.service === service);
  if (!fixture) {
    throw new Error(`No frozen fixture exists for ${service}`);
  }
  return runFixtureRequest(fixture);
}

export async function runFixtureRequest(input: unknown): Promise<FixtureJobResponse> {
  const request = PositionCrewRequestSchema.parse(input);
  const result = await runProviderJob(new MemoryCommerceAdapter(), request, FIXTURE_NOW);
  const isPublicFixture = FIXTURES.some(
    (fixture) => canonicalHash(request) === canonicalHash(PositionCrewRequestSchema.parse(fixture)),
  );
  const benchmark = TERMIX_BENCHMARKS.find((candidate) => candidate.service === request.service);
  const benchmarkLock = benchmark ? benchmarkLockFor(benchmark.service) : null;
  const isLockedBenchmark =
    benchmarkLock !== null && canonicalHash(request) === benchmarkLock.fixtureHash;
  return {
    schemaVersion: "positioncrew.fixture-job-response.v1",
    evidenceMode: "FROZEN_BSC_TEST_FIXTURE",
    commerceMode: "IN_MEMORY_CONFORMANCE",
    advantageStatus: "PENDING_INDEPENDENT_BLIND_EVALUATION",
    generatedAt: FIXTURE_NOW.toISOString(),
    claimBoundary: CLAIM_BOUNDARY,
    benchmarkLock: isLockedBenchmark ? benchmarkLock : null,
    receipt: {
      mode: isPublicFixture ? "PUBLIC_REPRODUCIBLE" : "SESSION_EMBEDDED",
      path: isPublicFixture
        ? `/api/receipts/${result.evaluation.evaluationHash}`
        : null,
      evaluationHash: result.evaluation.evaluationHash,
    },
    result,
  };
}

export async function runFrozenMatrix(): Promise<FixtureJobResponse[]> {
  return Promise.all(
    FIXTURES.map((fixture) =>
      runFrozenFixture(PositionCrewRequestSchema.parse(fixture).service),
    ),
  );
}

export async function runBenchmarkRepeatability(
  service: TermixBenchmarkService,
): Promise<BenchmarkRepeatabilityResponse> {
  const benchmark = TERMIX_BENCHMARKS.find((candidate) => candidate.service === service);
  if (!benchmark) throw new Error(`No TermiX benchmark exists for ${service}`);
  const lock = benchmarkLockFor(service);
  const runs: BenchmarkRepeatabilityResponse["runs"] = [];
  for (let index = 0; index < 2; index += 1) {
    const startedAt = performance.now();
    const response = await runFrozenFixture(service);
    const manifest = response.result.job.deliverable;
    if (!manifest) throw new Error(`Completed ${service} repeat is missing its deliverable manifest`);
    const elapsedMilliseconds = Math.max(1, Math.round(performance.now() - startedAt));
    runs.push({
      runId: `positioncrew-provider-repeat-${index + 1}`,
      elapsedMilliseconds,
      directCostUsd: "0.00",
      qualityScore: response.result.evaluation.score,
      criticalFailureCount: response.result.evaluation.checks.filter(
        (check) => check.critical && !check.passed,
      ).length,
      outputHash: manifest.deliverableHash,
    });
  }
  const sortedTimes = runs.map((run) => run.elapsedMilliseconds).sort((a, b) => a - b);
  const medianElapsedMilliseconds = (sortedTimes[0]! + sortedTimes[1]!) / 2;
  return {
    schemaVersion: "positioncrew.benchmark-repeatability.v1",
    generatedAt: new Date().toISOString(),
    benchmarkSlug: benchmark.slug,
    service,
    taskId: benchmark.protocol.taskId,
    status: "REPRODUCIBLE_AGENT_REPEATS_MANUAL_PENDING",
    benchmarkLock: lock,
    runs,
    medianElapsedMilliseconds,
    pending: ["MANUAL_BASELINE", "INDEPENDENT_BLIND_SCORECARD"],
    boundary:
      "These reproducible conformance runs are not immutable benchmark candidates. Agent advantage is not claimed until the manual baseline, immutable candidate capture, and independent blind scorecard are complete.",
  };
}

export async function runTermixBenchmarkRepeatability(): Promise<BenchmarkRepeatabilityMatrixResponse> {
  const records = await Promise.all(
    TERMIX_BENCHMARKS.map((benchmark) => runBenchmarkRepeatability(benchmark.service)),
  );
  return {
    schemaVersion: "positioncrew.benchmark-repeatability-matrix.v1",
    generatedAt: new Date().toISOString(),
    records,
    pending: ["MANUAL_BASELINES", "INDEPENDENT_BLIND_SCORECARDS"],
    boundary:
      "Three tasks and rubrics are locked. The public records prove deterministic repeatability only; no agent-versus-manual advantage is claimed.",
  };
}

export async function runLendingRepeatability(): Promise<LendingRepeatabilityResponse> {
  return runBenchmarkRepeatability("LENDING_RESCUE");
}

export async function runSuppliedLendingRequest(
  input: unknown,
  now = new Date(),
): Promise<FixtureJobResponse> {
  const request = LendingRescueRequestSchema.parse(input);
  return runSuppliedProviderRequest(request, now);
}

export async function runCurrentBlockPinnedProviderRequest(
  input: unknown,
  now: Date,
): Promise<FixtureJobResponse> {
  const request = PositionCrewRequestSchema.parse(input);
  const result = await runProviderJob(new MemoryCommerceAdapter(), request, now, {
    persistExpiredRefusal: true,
  });
  return {
    schemaVersion: "positioncrew.fixture-job-response.v1",
    evidenceMode: "CURRENT_BLOCK_PINNED",
    commerceMode: "IN_MEMORY_CONFORMANCE",
    advantageStatus: "PENDING_INDEPENDENT_BLIND_EVALUATION",
    generatedAt: now.toISOString(),
    claimBoundary: [
      "The exact block-referenced BSC request was persisted before this provider run and is committed by the durable hire receipt.",
      "The provider evaluates the persisted caller-supplied observation without independently re-fetching BSC state and does not sign or broadcast a transaction.",
      "The run costs $0.00, requires no wallet, creates no payment or settlement, and must be revalidated before any financial action.",
    ],
    benchmarkLock: null,
    receipt: {
      mode: "SESSION_EMBEDDED",
      path: null,
      evaluationHash: result.evaluation.evaluationHash,
    },
    result,
  };
}

export async function runSuppliedProviderRequest(
  input: unknown,
  now = new Date(),
): Promise<FixtureJobResponse> {
  const request = PositionCrewRequestSchema.parse(input);
  const result = await runProviderJob(new MemoryCommerceAdapter(), request, now);
  return {
    schemaVersion: "positioncrew.fixture-job-response.v1",
    evidenceMode: "CALLER_SUPPLIED_OBSERVATIONS",
    commerceMode: "IN_MEMORY_CONFORMANCE",
    advantageStatus: "PENDING_INDEPENDENT_BLIND_EVALUATION",
    generatedAt: now.toISOString(),
    claimBoundary: [
      "Observation values and timestamps are supplied by the caller; the provider validates them but does not independently fetch them from BSC.",
      "The lifecycle is an in-memory conformance rail, not an AACP or mainnet settlement.",
      "The output must be revalidated against fresh protocol state before execution.",
    ],
    benchmarkLock: null,
    receipt: {
      mode: "SESSION_EMBEDDED",
      path: null,
      evaluationHash: result.evaluation.evaluationHash,
    },
    result,
  };
}
