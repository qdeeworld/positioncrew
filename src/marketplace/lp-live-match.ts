import type { FixtureJobResponse } from "../api/fixture-jobs.js";
import {
  runCurrentBlockPinnedProviderDeliverable,
  runCurrentBlockPinnedProviderRequest,
} from "../api/fixture-jobs.js";
import type { EvaluationReceipt } from "../commerce/types.js";
import { EvaluationReceiptSchema } from "../commerce/types.js";
import type { PositionCrewDeliverable, PositionCrewRequest } from "../contracts/index.js";
import {
  LpRebalanceDeliverableSchema,
  LpRebalanceRequestSchema,
  type LpRebalanceDeliverable,
  type LpRebalanceRequest,
} from "../contracts/lp-rebalance.js";
import { canonicalHash } from "../core/canonical.js";
import { HEYANON_V3_POOLS } from "./heyanon-v3pools-adapter.js";
import { auditionHeyAnonV3LpJob } from "./heyanon-v3pools-lp-job-adapter.js";
import {
  LpLiveMatchAuditionSchema,
  LpLiveMatchExecutionSchema,
  LpLiveMatchProviderSelectionSchema,
  LpLiveMatchRunRequestSchema,
  type LpLiveMatchAudition,
  type LpLiveMatchCandidate,
  type LpLiveMatchExecution,
  type LpLiveMatchProviderSelection,
  type LpLiveMatchRunRequest,
} from "./lp-live-match-schema.js";

const POSITIONCREW_LP = {
  providerKey: "POSITIONCREW" as const,
  providerId: "positioncrew:provider:lp-rebalance:v1",
  name: "LP Range Operator v1",
  identity: {
    protocol: "ERC-8004" as const,
    network: "BSC_TESTNET" as const,
    chainId: 97 as const,
    agentId: "1811",
    owner: "0x50da554F1bF6A86469DB201C56bfe967d2E7c43d",
  },
  endpoint: "https://positioncrew.dolepee.com/api/providers/lp-rebalance/jobs",
  adapterId: "positioncrew:native:lp-rebalance:v1",
};

const HEYANON_LP = {
  providerKey: "HEYANON" as const,
  providerId: `erc8004:56:${HEYANON_V3_POOLS.agentTokenId}`,
  name: HEYANON_V3_POOLS.name,
  identity: {
    protocol: "ERC-8004" as const,
    network: "BSC_MAINNET" as const,
    chainId: 56 as const,
    agentId: String(HEYANON_V3_POOLS.agentTokenId),
    owner: HEYANON_V3_POOLS.owner,
  },
  endpoint: HEYANON_V3_POOLS.endpoint,
  adapterId: "positioncrew:mcp:heyanon-v3pools:lp-job:v1",
};

const EXECUTION_BOUNDARY = [
  "The selected provider was invoked afresh for the exact persisted LP request; an earlier audition result was not relabelled as delivery.",
  "A changed, unavailable, timed-out, or incompatible selected provider produces an explicit refusal and never falls back to another provider.",
  "This $0 run requires no wallet, creates no payment or settlement, and does not sign, broadcast, or move liquidity.",
] as const;

export class LpLiveMatchSelectionError extends Error {
  readonly code = "LP_PROVIDER_NOT_SELECTABLE";
}

function elapsed(startedAt: number): number {
  return Math.max(1, Math.round(performance.now() - startedAt));
}

function candidateChecks(
  checks: Array<{ id: string; passed: boolean; evidence: string }>,
): Array<{ code: string; status: "PASS" | "FAIL"; detail: string }> {
  return checks.map((check) => ({
    code: check.id,
    status: check.passed ? "PASS" : "FAIL",
    detail: check.evidence,
  }));
}

export async function createLpLiveMatchAudition(
  input: LpRebalanceRequest,
  source: { blockNumber: string; observedAt: string; explorerUrl: string },
  requestHash: string,
  now: Date,
  options: { fetchImpl?: typeof fetch; rpcUrl?: string } = {},
): Promise<{
  audition: LpLiveMatchAudition;
  externalProviderComparison: Record<string, unknown>;
}> {
  const request = LpRebalanceRequestSchema.parse(input);
  const candidates: LpLiveMatchCandidate[] = [];
  let firstPartyDecision = "NONE";
  const firstStarted = performance.now();
  try {
    const response = await runCurrentBlockPinnedProviderRequest(request, now);
    const deliverable = LpRebalanceDeliverableSchema.parse(response.result.deliverable);
    firstPartyDecision = deliverable.decision;
    const checks = candidateChecks(response.result.evaluation.checks);
    const selectable = response.result.evaluation.passed && checks.every((check) => check.status === "PASS");
    candidates.push({
      ...POSITIONCREW_LP,
      status: selectable ? "COMPATIBLE" : "INCOMPATIBLE",
      selectable,
      rawResponseHash: canonicalHash(deliverable),
      normalizedResponseHash: canonicalHash(deliverable),
      latencyMilliseconds: elapsed(firstStarted),
      checks,
    });
  } catch (error) {
    candidates.push({
      ...POSITIONCREW_LP,
      status: "UNAVAILABLE",
      selectable: false,
      rawResponseHash: null,
      normalizedResponseHash: null,
      latencyMilliseconds: elapsed(firstStarted),
      checks: [{
        code: "FRESH_PROVIDER_AUDITION",
        status: "FAIL",
        detail: error instanceof Error ? error.message : "PositionCrew provider audition failed",
      }],
    });
  }

  const positionTokenId = /^pancake-position-([1-9]\d*)-/.exec(request.requestId)?.[1];
  if (!positionTokenId) throw new Error("LP request does not bind a PancakeSwap position token ID");
  const externalStarted = performance.now();
  let externalProviderComparison: Record<string, unknown>;
  try {
    const assessment = await auditionHeyAnonV3LpJob(request, positionTokenId, {
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.rpcUrl ? { rpcUrl: options.rpcUrl } : {}),
      now,
    });
    const selectable = assessment.eligibleForLpRebalance &&
      assessment.checks.every((check) => check.status === "PASS");
    candidates.push({
      ...HEYANON_LP,
      status: selectable ? "COMPATIBLE" : "INCOMPATIBLE",
      selectable,
      rawResponseHash: assessment.invocation.rawResponseHash,
      normalizedResponseHash: assessment.invocation.normalizedResponseHash,
      latencyMilliseconds: assessment.invocation.latencyMilliseconds,
      checks: assessment.checks,
    });
    externalProviderComparison = {
      schemaVersion: "positioncrew.external-lp-comparison-summary.v1",
      provider: {
        name: HEYANON_V3_POOLS.name,
        erc8004TokenId: String(HEYANON_V3_POOLS.agentTokenId),
        endpoint: HEYANON_V3_POOLS.endpoint,
      },
      evaluatedAt: now.toISOString(),
      positionTokenId,
      outcome: selectable ? "SEMANTICALLY_COMPARABLE" : "INCOMPATIBLE",
      attributableResult: assessment.attributableResult,
      completedSamePositionAssessment: true,
      persistedByProvider: false,
      externalDecision: assessment.normalizedDeliverable.decision === "HOLD" ? "HOLD" : "REBALANCE",
      firstPartyDecision,
      exactRequestAccepted: false,
      eligibleForPositionAssessmentActivation: selectable,
      eligibleForLiveMatch: selectable,
      adapterNormalized: true,
      externalRange: {
        lowerTick: assessment.recommendation.lowerTick,
        upperTick: assessment.recommendation.upperTick,
        widthTicks: assessment.recommendation.widthTicks,
      },
      normalizedDeliverable: assessment.normalizedDeliverable,
      checks: assessment.checks,
      boundary: assessment.claimBoundary.join(" "),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "External provider unavailable";
    candidates.push({
      ...HEYANON_LP,
      status: "UNAVAILABLE",
      selectable: false,
      rawResponseHash: null,
      normalizedResponseHash: null,
      latencyMilliseconds: elapsed(externalStarted),
      checks: [{ code: "FRESH_PROVIDER_AUDITION", status: "FAIL", detail }],
    });
    externalProviderComparison = {
      schemaVersion: "positioncrew.external-lp-comparison-summary.v1",
      provider: {
        name: HEYANON_V3_POOLS.name,
        erc8004TokenId: String(HEYANON_V3_POOLS.agentTokenId),
        endpoint: HEYANON_V3_POOLS.endpoint,
      },
      evaluatedAt: now.toISOString(),
      positionTokenId,
      outcome: "UNAVAILABLE",
      attributableResult: false,
      completedSamePositionAssessment: false,
      persistedByProvider: false,
      externalDecision: "UNKNOWN",
      firstPartyDecision,
      exactRequestAccepted: false,
      eligibleForPositionAssessmentActivation: false,
      eligibleForLiveMatch: false,
      adapterNormalized: false,
      checks: [{ code: "REMOTE_PROVIDER_AVAILABLE", status: "FAIL", detail }],
      boundary: "The external outage did not select or invoke another provider. No external result or ranking is claimed.",
    };
  }

  return {
    audition: LpLiveMatchAuditionSchema.parse({
      schemaVersion: "positioncrew.lp-live-match-audition.v1",
      requestHash,
      source,
      auditionedAt: now.toISOString(),
      candidates,
      claimBoundary: [
        "Both candidates were auditioned against the same exact block-pinned LP request before any provider choice was accepted.",
        "Selectable means the candidate passed every recorded compatibility check; it is not a performance ranking or payment claim.",
        "The buyer must explicitly choose a selectable provider, which is then invoked afresh without silent fallback.",
      ],
    }),
    externalProviderComparison,
  };
}

export function selectLpLiveMatchProvider(
  auditionInput: LpLiveMatchAudition,
  requestInput: LpLiveMatchRunRequest,
  evidenceHash: string,
  selectedAt: Date,
): LpLiveMatchProviderSelection {
  const audition = LpLiveMatchAuditionSchema.parse(auditionInput);
  const request = LpLiveMatchRunRequestSchema.parse(requestInput);
  if (request.auditionHash !== evidenceHash) {
    throw new LpLiveMatchSelectionError("The provider choice does not bind the current persisted audition");
  }
  const candidate = audition.candidates.find(
    (item) => item.providerKey === request.selectedProvider,
  );
  if (!candidate || !candidate.selectable || candidate.status !== "COMPATIBLE") {
    throw new LpLiveMatchSelectionError("The requested LP provider did not pass the frozen audition and cannot be selected");
  }
  return LpLiveMatchProviderSelectionSchema.parse({
    schemaVersion: "positioncrew.lp-live-match-provider-selection.v1",
    selectedProvider: candidate.providerKey,
    providerId: candidate.providerId,
    providerName: candidate.name,
    identity: candidate.identity,
    endpoint: candidate.endpoint,
    adapterId: candidate.adapterId,
    auditionHash: request.auditionHash,
    selectedAt: selectedAt.toISOString(),
  });
}

function refusal(request: LpRebalanceRequest, now: Date, reason: string): LpRebalanceDeliverable {
  return LpRebalanceDeliverableSchema.parse({
    schemaVersion: "positioncrew.lp-rebalance.deliverable.v1",
    service: "LP_REBALANCE",
    requestId: request.requestId,
    generatedAt: now.toISOString(),
    expiresAt: request.deadline,
    status: now.getTime() >= Date.parse(request.deadline)
      ? "REFUSED_EXPIRED"
      : "REFUSED_INCONSISTENT_DATA",
    decision: "NONE",
    proposedRange: null,
    estimatedRebalanceCostUsd: "0",
    expectedGrossFeesUsd: "0",
    expectedNetBenefitUsd: "0",
    breakEvenHours: null,
    inventoryExposure: {
      token0Bps: request.position.token0ShareBps,
      token1Bps: request.position.token1ShareBps,
    },
    summary: "The selected LP provider could not safely complete this exact job; no fallback provider was used.",
    actionSteps: [],
    invalidationConditions: ["Create a new block-pinned audition before trying another provider."],
    limitations: [reason.slice(0, 240), "No approval, signature, payment, or liquidity transaction occurred."],
  });
}

function exactOutputEvaluator(expectedHash: string) {
  return (
    requestInput: PositionCrewRequest,
    deliverableInput: PositionCrewDeliverable,
    evaluatorId: string,
    now: Date,
    requestHashOverride?: string,
  ): EvaluationReceipt => {
    const request = LpRebalanceRequestSchema.parse(requestInput);
    const deliverable = LpRebalanceDeliverableSchema.parse(deliverableInput);
    const requestHash = requestHashOverride ?? canonicalHash(request);
    const deliverableHash = canonicalHash(deliverable);
    const checks = [
      { id: "schema", label: "Exact LP output contract parses", weight: 20, critical: true, passed: true, evidence: deliverable.schemaVersion },
      { id: "identity", label: "Output binds the exact LP request", weight: 20, critical: true, passed: deliverable.requestId === request.requestId, evidence: deliverable.requestId },
      { id: "selected-output", label: "Recorded output matches the selected-provider result", weight: 30, critical: true, passed: deliverableHash === expectedHash, evidence: expectedHash },
      { id: "bounded-result", label: "Result is an action, hold, or named refusal", weight: 20, critical: true, passed: deliverable.status.length > 0, evidence: `${deliverable.status}:${deliverable.decision}` },
      { id: "bounded-expiry", label: "Result never outlives the buyer request", weight: 10, critical: true, passed: Date.parse(deliverable.expiresAt) <= Date.parse(request.deadline), evidence: deliverable.expiresAt },
    ];
    const score = checks.reduce((total, check) => total + (check.passed ? check.weight : 0), 0);
    const body = {
      schemaVersion: "positioncrew.evaluation.v1" as const,
      rubricVersion: "positioncrew.lp-live-match.conformance.v1",
      requestHash,
      deliverableHash,
      evaluatorId,
      evaluatedAt: now.toISOString(),
      score,
      passed: score >= 90 && !checks.some((check) => check.critical && !check.passed),
      checks,
    };
    return EvaluationReceiptSchema.parse({ ...body, evaluationHash: canonicalHash(body) });
  };
}

async function boundedExternalInvocation<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Selected external provider timed out after ${milliseconds} ms`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function executionRecord(input: {
  hireId: string;
  jobId: string;
  requestHash: string;
  evidenceHash: string;
  source: { blockNumber: string; observedAt: string; explorerUrl: string };
  selection: LpLiveMatchProviderSelection;
  startedAt: string;
  completedAt: string;
  latencyMilliseconds: number;
  rawResponseHash: string | null;
  normalizedResponseHash: string;
  checks: Array<{ code: string; status: "PASS" | "FAIL"; detail: string }>;
  deliverable: LpRebalanceDeliverable;
}): LpLiveMatchExecution {
  return LpLiveMatchExecutionSchema.parse({
    schemaVersion: "positioncrew.lp-live-match-execution.v1",
    source: {
      hireId: input.hireId,
      jobId: input.jobId,
      requestHash: input.requestHash,
      evidenceHash: input.evidenceHash,
      ...input.source,
    },
    selection: input.selection,
    invocation: {
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      latencyMilliseconds: input.latencyMilliseconds,
      endpoint: input.selection.endpoint,
      rawResponseHash: input.rawResponseHash,
      normalizedResponseHash: input.normalizedResponseHash,
      checks: input.checks,
    },
    outcome: input.deliverable.status.startsWith("REFUSED_") ? "REFUSED" : "DELIVERED",
    commerce: { directCostUsd: "0.00", walletRequired: false, payment: "NONE", settlement: "NONE" },
    claimBoundary: EXECUTION_BOUNDARY,
  });
}

export async function executeLpLiveMatchProvider(input: {
  hireId: string;
  jobId: string;
  requestHash: string;
  evidenceHash: string;
  source: { blockNumber: string; observedAt: string; explorerUrl: string };
  request: LpRebalanceRequest;
  audition: LpLiveMatchAudition;
  selection: LpLiveMatchProviderSelection;
  now: Date;
  fetchImpl?: typeof fetch;
  rpcUrl?: string;
}): Promise<FixtureJobResponse> {
  const request = LpRebalanceRequestSchema.parse(input.request);
  const audition = LpLiveMatchAuditionSchema.parse(input.audition);
  const selection = LpLiveMatchProviderSelectionSchema.parse(input.selection);
  const candidate = audition.candidates.find((item) => item.providerKey === selection.selectedProvider);
  if (!candidate || !candidate.selectable || candidate.providerId !== selection.providerId) {
    throw new LpLiveMatchSelectionError("Persisted LP provider selection no longer matches its frozen audition");
  }

  const startedAt = new Date().toISOString();
  const startedPerformance = performance.now();
  let response: FixtureJobResponse;
  let deliverable: LpRebalanceDeliverable;
  let rawResponseHash: string | null = null;
  let checks: Array<{ code: string; status: "PASS" | "FAIL"; detail: string }>;

  if (selection.selectedProvider === "POSITIONCREW") {
    try {
      response = await runCurrentBlockPinnedProviderRequest(request, input.now);
      deliverable = LpRebalanceDeliverableSchema.parse(response.result.deliverable);
      if (response.result.job.providerId !== selection.providerId || !response.result.evaluation.passed) {
        throw new Error("Fresh PositionCrew execution failed its selected-provider conformance checks");
      }
      rawResponseHash = canonicalHash(deliverable);
      checks = [
        { code: "FRESH_SELECTED_PROVIDER_RUN", status: "PASS", detail: "PositionCrew executed the exact persisted request after selection." },
        ...candidateChecks(response.result.evaluation.checks),
      ];
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Selected PositionCrew provider failed";
      deliverable = refusal(request, new Date(), reason);
      checks = [{ code: "FRESH_SELECTED_PROVIDER_RUN", status: "FAIL", detail: reason }];
      response = await runCurrentBlockPinnedProviderDeliverable(
        request,
        deliverable,
        new Date(),
        {
          persistExpiredRefusal: true,
          providerId: selection.providerId,
          evaluatorId: "positioncrew:evaluator:lp-live-match:v1",
          evaluate: exactOutputEvaluator(canonicalHash(deliverable)),
        },
      );
    }
  } else {
    const positionTokenId = /^pancake-position-([1-9]\d*)-/.exec(request.requestId)?.[1];
    if (!positionTokenId) throw new Error("Persisted LP request lost its position token binding");
    try {
      if (input.now.getTime() >= Date.parse(request.deadline)) {
        throw new Error("The selected-provider job expired before its fresh invocation");
      }
      const assessment = await boundedExternalInvocation(
        auditionHeyAnonV3LpJob(request, positionTokenId, {
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
          ...(input.rpcUrl ? { rpcUrl: input.rpcUrl } : {}),
          now: new Date(),
        }),
        10_000,
      );
      rawResponseHash = assessment.invocation.rawResponseHash;
      const stable = candidate.rawResponseHash === assessment.invocation.rawResponseHash;
      const compatible = assessment.eligibleForLpRebalance &&
        assessment.checks.every((check) => check.status === "PASS");
      checks = [
        ...assessment.checks,
        {
          code: "AUDITION_RESULT_STABLE",
          status: stable ? "PASS" : "FAIL",
          detail: stable
            ? "The fresh provider response matches the response committed by the frozen audition."
            : "The selected provider response changed after audition; PositionCrew refused instead of silently accepting it.",
        },
      ];
      deliverable = compatible && stable
        ? LpRebalanceDeliverableSchema.parse(assessment.normalizedDeliverable)
        : refusal(
            request,
            new Date(),
            compatible
              ? "The external provider response changed after the buyer selected it."
              : "The fresh external provider response no longer satisfies every LP compatibility check.",
          );
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Selected external provider failed";
      deliverable = refusal(request, new Date(), reason);
      checks = [{ code: "FRESH_SELECTED_PROVIDER_RUN", status: "FAIL", detail: reason }];
    }
    response = await runCurrentBlockPinnedProviderDeliverable(
      request,
      deliverable,
      new Date(),
      {
        persistExpiredRefusal: true,
        providerId: selection.providerId,
        evaluatorId: "positioncrew:evaluator:lp-live-match:v1",
        evaluate: exactOutputEvaluator(canonicalHash(deliverable)),
      },
    );
  }

  const completedAt = new Date().toISOString();
  const liveMatchExecution = executionRecord({
    hireId: input.hireId,
    jobId: input.jobId,
    requestHash: input.requestHash,
    evidenceHash: input.evidenceHash,
    source: input.source,
    selection,
    startedAt,
    completedAt,
    latencyMilliseconds: elapsed(startedPerformance),
    rawResponseHash,
    normalizedResponseHash: canonicalHash(deliverable),
    checks,
    deliverable,
  });
  return { ...response, liveMatchExecution };
}
