import { auditionBnbLpRangeRebalancer } from "../marketplace/bnb-lp-range-rebalancer-adapter.js";
import { createLpRebalanceDeliverable } from "../providers/lp-rebalance.js";
import { inspectPancakePosition } from "../telemetry/bsc.js";

const positionTokenId = process.argv[2] ?? "7204780";
const probe = await inspectPancakePosition(positionTokenId);
const firstParty = createLpRebalanceDeliverable(probe.lpRequest, new Date());
const external = await auditionBnbLpRangeRebalancer(
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
      positionCrew: {
        provider: "PositionCrew LP Rebalance",
        decision: firstParty.decision,
        summary: firstParty.summary,
        deliverable: firstParty,
      },
      external,
      verdict:
        external.outcome === "SEMANTIC_MATCH_ONLY"
          ? "Two attributable providers agree on the same live position, but exact-request Live Match remains unproven."
          : "The external provider did not produce an exact comparable PositionCrew result.",
    },
    null,
    2,
  ),
);
