import { auditionAiKiVenusYield } from "../marketplace/aiki-venus-yield-adapter.js";
import { createYieldOptimizationDeliverable } from "../providers/yield-optimization.js";
import { inspectVenusStableYields } from "../telemetry/bsc.js";

const probe = await inspectVenusStableYields();
const firstParty = createYieldOptimizationDeliverable(probe.yieldRequest, new Date());
const external = await auditionAiKiVenusYield(probe.yieldRequest, firstParty);

process.stdout.write(`${JSON.stringify({
  schemaVersion: "positioncrew.same-market-yield-comparison.v1",
  generatedAt: new Date().toISOString(),
  frozenRequest: probe.yieldRequest,
  positionCrew: { deliverable: firstParty },
  external,
  verdict: external.outcome === "PARTIAL_COMPATIBILITY"
    ? "Two attributable providers ranked the same live Venus market set; full risk-adjusted allocation remains PositionCrew-only."
    : "The external provider did not complete a comparable rate-ranking assessment.",
}, null, 2)}\n`);
