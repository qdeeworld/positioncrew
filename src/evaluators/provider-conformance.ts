import {
  PositionCrewDeliverableSchema,
  PositionCrewRequestSchema,
  type PositionCrewDeliverable,
  type PositionCrewRequest,
} from "../contracts/index.js";
import { canonicalHash } from "../core/canonical.js";
import {
  EvaluationReceiptSchema,
  type EvaluationCheck,
  type EvaluationReceipt,
} from "../commerce/types.js";
import { executeProvider } from "../providers/index.js";

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

function usefulPayload(deliverable: PositionCrewDeliverable): boolean {
  if (deliverable.status !== "ACTIONABLE") {
    return deliverable.summary.length > 0;
  }
  switch (deliverable.service) {
    case "LENDING_RESCUE":
      return deliverable.recommendation !== null;
    case "LP_REBALANCE":
      return deliverable.proposedRange !== null && deliverable.actionSteps.length >= 3;
    case "YIELD_OPTIMIZATION":
      return deliverable.selectedOpportunityId !== null && deliverable.actionSteps.length >= 2;
    case "BOUNDED_GRID":
      return (
        deliverable.orders.some((order) => order.side === "BUY") &&
        deliverable.orders.some((order) => order.side === "SELL")
      );
  }
}

export function evaluateProviderConformance(
  requestInput: PositionCrewRequest,
  deliverableInput: PositionCrewDeliverable,
  evaluatorId: string,
  now: Date,
  requestHashOverride?: string,
): EvaluationReceipt {
  const request = PositionCrewRequestSchema.parse(requestInput);
  const deliverable = PositionCrewDeliverableSchema.parse(deliverableInput);
  const expected = executeProvider(request, now);
  const requestHash = requestHashOverride ?? canonicalHash(request);
  const deliverableHash = canonicalHash(deliverable);
  const checks: EvaluationCheck[] = [
    check(
      "schema",
      "Strict versioned contracts parse",
      10,
      true,
      true,
      `${request.schemaVersion} -> ${deliverable.schemaVersion}`,
    ),
    check(
      "identity",
      "Result is bound to the requested service and request ID",
      10,
      true,
      deliverable.service === request.service && deliverable.requestId === request.requestId,
      `${deliverable.service}:${deliverable.requestId}`,
    ),
    check(
      "deterministic-output",
      "Output reproduces from the frozen request and provider version",
      60,
      true,
      canonicalHash(deliverable) === canonicalHash(expected),
      `expected=${canonicalHash(expected)}`,
    ),
    check(
      "useful-payload",
      "Actionable results contain the category-specific machine payload",
      15,
      true,
      usefulPayload(deliverable),
      `status=${deliverable.status}`,
    ),
    check(
      "bounded-expiry",
      "Result never outlives the buyer request",
      5,
      false,
      Date.parse(deliverable.expiresAt) <= Date.parse(request.deadline),
      `expiresAt=${deliverable.expiresAt}`,
    ),
  ];
  const score = checks.reduce((total, item) => total + (item.passed ? item.weight : 0), 0);
  const passed = score >= 90 && !checks.some((item) => item.critical && !item.passed);
  const body = {
    schemaVersion: "positioncrew.evaluation.v1" as const,
    rubricVersion: `positioncrew.${request.service.toLowerCase()}.conformance.v1`,
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
