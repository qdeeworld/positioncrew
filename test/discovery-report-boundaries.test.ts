import { describe, expect, it } from "vitest";
import { buildMarketplaceManifest } from "../src/marketplace/discovery.js";

describe("marketplace publication boundaries", () => {
  it("separates the published founder report from optional independent evaluation", () => {
    const origin = "https://positioncrew.dolepee.com";
    const manifest = buildMarketplaceManifest(origin, new Date("2026-09-06T00:00:00.000Z"));
    expect(manifest.founderAgentAdvantageStatusUrl).toBe(`${origin}/api/benchmarks/founder-comparison/status`);
    expect(manifest.independentAgentAdvantageStatusUrl).toBe(`${origin}/api/benchmarks/status`);
    expect(manifest.claims).toMatchObject({
      agentAdvantage: "FOUNDER_REPORT_PUBLISHED_INDEPENDENT_EVALUATION_PENDING",
      agentAdvantageBoundary: expect.stringContaining("does not establish current-task advantage"),
      lpProviderSelection: "EXPLICIT_CHOICE_FROM_COMPATIBLE_CURRENT_AUDITION_NO_SILENT_FALLBACK",
      externalComparisons: "FOUR_THIRD_PARTY_EVIDENCE_ONLY_NON_ACTIVATABLE",
      settlement: "IN_MEMORY_CONFORMANCE",
    });
  });
});
