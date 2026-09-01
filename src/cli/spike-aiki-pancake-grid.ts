import { auditionAiKiPancakeGrid } from "../marketplace/aiki-pancake-grid-adapter.js";
import { createBoundedGridDeliverable } from "../providers/bounded-grid.js";
import { inspectPancakeGridMarket } from "../telemetry/bsc.js";

const probe = await inspectPancakeGridMarket();
const firstParty = createBoundedGridDeliverable(probe.gridRequest, new Date());
const external = await auditionAiKiPancakeGrid(probe.gridRequest, firstParty);

process.stdout.write(`${JSON.stringify({
  schemaVersion: "positioncrew.same-pool-grid-comparison.v1",
  generatedAt: new Date().toISOString(),
  frozenRequest: probe.gridRequest,
  positionCrew: { deliverable: firstParty },
  external,
  verdict: external.outcome === "PARTIAL_COMPATIBILITY"
    ? "Two attributable providers assessed the same live pool and bounded range; order construction remains PositionCrew-only."
    : "The external provider did not complete a comparable pool-and-range assessment.",
}, null, 2)}\n`);
