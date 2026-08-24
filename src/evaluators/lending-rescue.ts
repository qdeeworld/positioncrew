import type {
  LendingRescueDeliverable,
  LendingRescueRequest,
} from "../contracts/lending-rescue.js";
import {
  LendingRescueDeliverableSchema,
  LendingRescueRequestSchema,
} from "../contracts/lending-rescue.js";
import { canonicalHash } from "../core/canonical.js";
import { FIXED_SCALE, parseFixed, ratioFromBps } from "../core/fixed.js";
import {
  buildLendingActionCandidates,
  calculateLendingPosition,
} from "../domain/lending-math.js";
import {
  EvaluationReceiptSchema,
  type EvaluationCheck,
  type EvaluationReceipt,
} from "../commerce/types.js";

const RUBRIC_VERSION = "positioncrew.lending-rescue.rubric.v1";

function closeEnough(actual: string | null, expected: bigint | null): boolean {
  if (actual === null || expected === null) {
    return actual === null && expected === null;
  }
  const difference = parseFixed(actual) - expected;
  const absolute = difference < 0n ? -difference : difference;
  return absolute <= 10_000_000_000n;
}

function check(
  id: string,
  label: string,
  weight: number,
  critical: boolean,
  passed: boolean,
  evidence: string,
): EvaluationCheck {
  return { id, label, weight, critical, passed, evidence };
}

export function evaluateLendingRescue(
  requestInput: LendingRescueRequest,
  deliverableInput: LendingRescueDeliverable,
  evaluatorId: string,
  now: Date,
): EvaluationReceipt {
  const request = LendingRescueRequestSchema.parse(requestInput);
  const deliverable = LendingRescueDeliverableSchema.parse(deliverableInput);
  const requestHash = canonicalHash(request);
  const deliverableHash = canonicalHash(deliverable);
  const current = calculateLendingPosition(request);
  const stressed = calculateLendingPosition(
    request,
    FIXED_SCALE - ratioFromBps(request.stressPriceDropBps),
  );
  const candidates = buildLendingActionCandidates(request, current);
  const expected = candidates[0]?.plan ?? null;
  const sourceExpiry = Math.min(
    ...request.sources.map(
      (source) => Date.parse(source.observedAt) + request.maxDataAgeSeconds * 1_000,
    ),
    Date.parse(request.deadline),
  );
  const sourceIds = new Set(request.sources.map((source) => source.sourceId));
  const pricedEntries = [...request.position.collateral, ...request.position.debt];
  const sourceCoverage = pricedEntries.every((entry) => sourceIds.has(entry.sourceId));
  const inconsistentEvidence = pricedEntries.some((entry) => {
    const source = request.sources.find((candidate) => candidate.sourceId === entry.sourceId);
    return (
      !source ||
      source.observedAt !== entry.observedAt ||
      Date.parse(entry.observedAt) > now.getTime()
    );
  });
  const staleEvidence = request.sources.some(
    (source) =>
      now.getTime() - Date.parse(source.observedAt) > request.maxDataAgeSeconds * 1_000,
  );
  const expectedStatus = (() => {
    if (now.getTime() >= Date.parse(request.deadline)) {
      return "REFUSED_EXPIRED" as const;
    }
    if (inconsistentEvidence) {
      return "REFUSED_INCONSISTENT_DATA" as const;
    }
    if (staleEvidence) {
      return "REFUSED_STALE_DATA" as const;
    }
    if (request.position.collateral.length === 0 || request.position.debt.length === 0) {
      return "REFUSED_CONSTRAINTS" as const;
    }
    if (
      current.healthFactor === null ||
      current.healthFactor >= parseFixed(request.targetHealthFactor)
    ) {
      return "NO_ACTION" as const;
    }
    return expected === null ? "REFUSED_CONSTRAINTS" as const : "ACTIONABLE" as const;
  })();
  const expectedActionable = expectedStatus === "ACTIONABLE";

  const checks: EvaluationCheck[] = [
    check(
      "schema",
      "Versioned request and deliverable schemas parse strictly",
      10,
      true,
      true,
      `${request.schemaVersion} -> ${deliverable.schemaVersion}`,
    ),
    check(
      "identity",
      "Deliverable is bound to the requested service and request ID",
      5,
      true,
      deliverable.requestId === request.requestId && deliverable.service === request.service,
      `requestId=${deliverable.requestId}`,
    ),
    check(
      "current-health-factor",
      "Current health factor is recomputed correctly",
      10,
      true,
      closeEnough(deliverable.position.currentHealthFactor, current.healthFactor),
      `reported=${deliverable.position.currentHealthFactor ?? "null"}`,
    ),
    check(
      "stress-health-factor",
      "Stress health factor applies the frozen collateral shock",
      10,
      false,
      closeEnough(deliverable.position.stressedHealthFactor, stressed.healthFactor),
      `shock=${request.stressPriceDropBps}bps reported=${deliverable.position.stressedHealthFactor ?? "null"}`,
    ),
    check(
      "decision",
      "The smallest feasible safe action is selected",
      20,
      true,
      expectedActionable
        ? deliverable.status === expectedStatus &&
            deliverable.recommendation !== null &&
            expected !== null &&
            canonicalHash(deliverable.recommendation) === canonicalHash(expected)
        : deliverable.status === expectedStatus && deliverable.recommendation === null,
      expected
        ? `expected=${expectedStatus}:${expected.kind}:${expected.amountBaseUnits}`
        : `expected=${expectedStatus}`,
    ),
    check(
      "constraints",
      "Action respects budget, gas, inventory, and target health factor",
      20,
      true,
      !expectedActionable ||
        (deliverable.recommendation !== null &&
          parseFixed(deliverable.recommendation.amountUsd) <= parseFixed(request.maxActionUsd) &&
          parseFixed(deliverable.recommendation.estimatedGasUsd) <= parseFixed(request.maxGasUsd) &&
          parseFixed(deliverable.recommendation.projectedHealthFactor) >=
            parseFixed(request.targetHealthFactor)),
      `maxActionUsd=${request.maxActionUsd} maxGasUsd=${request.maxGasUsd}`,
    ),
    check(
      "freshness",
      "Result expires with its evidence and never after the request deadline",
      10,
      true,
      sourceCoverage && Date.parse(deliverable.expiresAt) <= sourceExpiry,
      `expiresAt=${deliverable.expiresAt}`,
    ),
    check(
      "machine-action",
      "Action includes exact base units and bounded execution preconditions",
      10,
      true,
      !expectedActionable ||
        (deliverable.recommendation !== null &&
          /^\d+$/.test(deliverable.recommendation.amountBaseUnits) &&
          deliverable.recommendation.preconditions.length >= 3 &&
          Date.parse(deliverable.recommendation.executeBefore) <= sourceExpiry),
      expectedActionable ? "machine-readable action present" : "no action required",
    ),
    check(
      "disclosure",
      "Limitations and invalidation conditions are explicit",
      5,
      false,
      deliverable.limitations.length >= 2 && deliverable.invalidationConditions.length >= 3,
      `${deliverable.limitations.length} limitations; ${deliverable.invalidationConditions.length} invalidation conditions`,
    ),
  ];
  const score = checks.reduce((total, item) => total + (item.passed ? item.weight : 0), 0);
  const passed = score >= 90 && !checks.some((item) => item.critical && !item.passed);
  const body = {
    schemaVersion: "positioncrew.evaluation.v1" as const,
    rubricVersion: RUBRIC_VERSION,
    requestHash,
    deliverableHash,
    evaluatorId,
    evaluatedAt: now.toISOString(),
    score,
    passed,
    checks,
  };

  return EvaluationReceiptSchema.parse({
    ...body,
    evaluationHash: canonicalHash(body),
  });
}
