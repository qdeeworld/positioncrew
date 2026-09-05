import type { LendingRescueDeliverable, LendingRescueRequest } from "../contracts/lending-rescue.js";
import type { EvaluationReceipt } from "../commerce/types.js";
import { evaluateProviderConformance } from "./provider-conformance.js";

export function evaluateLendingRescue(
  request: LendingRescueRequest,
  deliverable: LendingRescueDeliverable,
  evaluatorId: string,
  now: Date,
): EvaluationReceipt {
  return evaluateProviderConformance(request, deliverable, evaluatorId, now);
}
