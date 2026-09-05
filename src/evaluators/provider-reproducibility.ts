import type { PositionCrewDeliverable, PositionCrewRequest } from "../contracts/index.js";
import { canonicalHash } from "../core/canonical.js";
import { executeProvider } from "../providers/index.js";

/** Optional native regression check. Exact reproduction is not financial correctness. */
export function evaluateProviderReproducibility(request: PositionCrewRequest, deliverable: PositionCrewDeliverable, now: Date) {
  const expectedDeliverableHash = canonicalHash(executeProvider(request, now));
  const deliverableHash = canonicalHash(deliverable);
  return { passed: expectedDeliverableHash === deliverableHash, expectedDeliverableHash, deliverableHash };
}
