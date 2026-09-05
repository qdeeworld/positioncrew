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
import { evaluateFinancialInvariants } from "./financial-invariants.js";

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
      return (deliverable.decision === "EXIT" || deliverable.proposedRange !== null) && deliverable.actionSteps.length >= 3;
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
  const financialChecks = evaluateFinancialInvariants(request, deliverable);
  const sourceExpiry = Math.min(Date.parse(request.deadline), ...request.sources.map((source) => Date.parse(source.observedAt) + request.maxDataAgeSeconds * 1_000));
  const observations = request.service === "LENDING_RESCUE" ? [...request.position.collateral, ...request.position.debt]
    : request.service === "YIELD_OPTIMIZATION" ? [...request.currentPositions, ...request.opportunities] : [request.marketState];
  const sourcesById = new Map(request.sources.map((source) => [source.sourceId, source]));
  const evidenceConsistent = request.sources.every((source) => Date.parse(source.observedAt) <= now.getTime())
    && observations.every((observation) => sourcesById.get(observation.sourceId)?.observedAt === observation.observedAt
      && Date.parse(observation.observedAt) <= now.getTime());
  const evidenceFresh = request.sources.every((source) => Date.parse(source.observedAt) <= now.getTime()
    && now.getTime() - Date.parse(source.observedAt) <= request.maxDataAgeSeconds * 1_000);
  const requiredEvidenceRefusal = now.getTime() >= Date.parse(request.deadline) ? "REFUSED_EXPIRED"
    : !evidenceConsistent ? "REFUSED_INCONSISTENT_DATA" : !evidenceFresh ? "REFUSED_STALE_DATA" : null;
  const evidenceRefusals = ["REFUSED_EXPIRED", "REFUSED_INCONSISTENT_DATA", "REFUSED_STALE_DATA"];
  const usableExpiry = requiredEvidenceRefusal !== null || Date.parse(deliverable.expiresAt) > now.getTime();
  const sourcesBound = request.service !== "LENDING_RESCUE" ||
    (deliverable.service === "LENDING_RESCUE" && canonicalHash(deliverable.sources) === canonicalHash(request.sources));
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
      deliverable.service === request.service && deliverable.requestId === request.requestId && sourcesBound,
      `${deliverable.service}:${deliverable.requestId}`,
    ),
    check(
      "financial-invariants",
      "Submitted output satisfies independent financial constraints",
      60,
      true,
      financialChecks.every((item) => item.passed),
      "Final-output constraints are independent of native reproduction; future execution and performance are not proven.",
    ),
    check(
      "useful-payload",
      "Actionable results contain the category-specific machine payload",
      10,
      true,
      usefulPayload(deliverable),
      `status=${deliverable.status}`,
    ),
    check(
      "bounded-expiry",
      "Result remains within the request and is usable when its evidence is current",
      5,
      true,
      Date.parse(deliverable.expiresAt) <= Date.parse(request.deadline) && usableExpiry,
      `expiresAt=${deliverable.expiresAt}`,
    ),
    check("evidence-decision", "Evidence refusals match the actual deadline, consistency, and freshness state", 5, true,
      requiredEvidenceRefusal === null ? !evidenceRefusals.includes(deliverable.status) : deliverable.status === requiredEvidenceRefusal,
      `required=${requiredEvidenceRefusal ?? "NO_EVIDENCE_REFUSAL"}; reported=${deliverable.status}; precedence=expired,inconsistent,stale`),
    check("evidence-window", "Actionable output uses current evidence and bounded generation/expiry times", 0, true,
      deliverable.status === "ACTIONABLE"
        ? evidenceConsistent && evidenceFresh && Date.parse(deliverable.generatedAt) >= Date.parse(request.requestedAt)
          && Date.parse(deliverable.generatedAt) <= now.getTime() && Date.parse(deliverable.expiresAt) > now.getTime()
          && Date.parse(deliverable.expiresAt) <= sourceExpiry
        : Date.parse(deliverable.generatedAt) >= Date.parse(request.requestedAt)
          && Date.parse(deliverable.generatedAt) <= now.getTime() && Date.parse(deliverable.expiresAt) <= sourceExpiry && usableExpiry,
      `sourceExpiry=${new Date(sourceExpiry).toISOString()}; status=${deliverable.status}`),
    check("lending-source-binding", "Lending source references preserve the frozen request attribution", 0, true,
      sourcesBound, "Lending deliverable sources must canonically match the complete request source array."),
    ...financialChecks.map((item) => check(item.id, "Independent submitted-output invariant", 0, true, item.passed, item.detail)),
  ];
  const score = checks.reduce((total, item) => total + (item.passed ? item.weight : 0), 0);
  const passed = score >= 90 && !checks.some((item) => item.critical && !item.passed);
  const body = {
    schemaVersion: "positioncrew.evaluation.v1" as const,
    rubricVersion: `positioncrew.${request.service.toLowerCase()}.conformance.v2`,
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
