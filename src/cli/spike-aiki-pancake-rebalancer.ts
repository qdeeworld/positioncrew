import { auditionAiKiPancakeRebalancer } from "../marketplace/aiki-pancake-rebalancer-adapter.js";
import { createLpRebalanceDeliverable } from "../providers/lp-rebalance.js";
import { inspectPancakePosition } from "../telemetry/bsc.js";

const positionTokenId = process.argv[2] ?? "7204780";
const probe = await inspectPancakePosition(positionTokenId);
const firstParty = createLpRebalanceDeliverable(probe.lpRequest, new Date());
const external = await auditionAiKiPancakeRebalancer(
  probe.lpRequest,
  firstParty,
  positionTokenId,
);

console.log(
  JSON.stringify(
    {
      schemaVersion: "positioncrew.same-position-provider-comparison.v1",
      generatedAt: new Date().toISOString(),
      frozenRequest: probe.lpRequest,
      positionCrew: { deliverable: firstParty },
      external,
      verdict:
        external.completedSamePositionAssessment
          ? "Two attributable providers completed semantically comparable assessments of the same live LP position; exact-request activation remains unproven."
          : "The external provider did not complete a semantically comparable assessment.",
    },
    null,
    2,
  ),
);
