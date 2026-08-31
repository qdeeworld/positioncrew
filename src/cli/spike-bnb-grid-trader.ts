import { auditionBnbGridTrader } from "../marketplace/bnb-grid-trader-adapter.js";
import { createBoundedGridDeliverable } from "../providers/bounded-grid.js";
import { inspectPancakeGridMarket } from "../telemetry/bsc.js";

const capitalUsd = process.argv[2] ?? "100.00";
const probe = await inspectPancakeGridMarket();
const capital = Number(capitalUsd);
const request = {
  ...probe.gridRequest,
  maxActionUsd: capitalUsd,
  constraints: {
    ...probe.gridRequest.constraints,
    capitalUsd,
    maximumInventoryUsd: (capital * 0.6).toFixed(2),
    maximumLossUsd: (capital * 0.15).toFixed(2),
    minimumExpectedNetProfitUsd: (capital * 0.005).toFixed(2),
  },
};
const firstParty = createBoundedGridDeliverable(request, new Date());
const external = await auditionBnbGridTrader(request, firstParty);

console.log(
  JSON.stringify(
    {
      schemaVersion: "positioncrew.same-market-grid-comparison.v1",
      generatedAt: new Date().toISOString(),
      frozenRequest: request,
      positionCrew: { deliverable: firstParty },
      external,
      verdict:
        external.outcome === "PARTIAL_COMPATIBILITY"
          ? "A callable external provider returns an attributable plan for the same pair and capital, but exact-policy Live Match remains unproven."
          : "The external provider did not return a semantically compatible public plan.",
    },
    null,
    2,
  ),
);
