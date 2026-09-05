import lending from "../../fixtures/lending-rescue/stressed-venus-position.v1.json" with { type: "json" };
import lp from "../../fixtures/provider-conformance/lp-valid.v2.json" with { type: "json" };
import yieldRequest from "../../fixtures/yield-optimization/venus-to-beefy.v1.json" with { type: "json" };
import grid from "../../fixtures/provider-conformance/grid-valid.v2.json" with { type: "json" };
import { PositionCrewRequestSchema } from "../contracts/index.js";
import { executeProvider } from "../providers/index.js";

/** Synthetic documentation examples, separate from immutable benchmark and historical result artifacts. */
export function createProviderConformanceExamples() {
  const now = new Date("2026-08-12T16:00:30.000Z");
  return [lending, lp, yieldRequest, grid].map((input) => {
    const request = PositionCrewRequestSchema.parse(input);
    return { request, deliverable: executeProvider(request, now) };
  });
}
