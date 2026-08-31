import { describe, expect, it, vi } from "vitest";

import type { BoundedGridDeliverable, BoundedGridRequest } from "../src/contracts/bounded-grid.js";
import { auditionAiKiPancakeGrid } from "../src/marketplace/aiki-pancake-grid-adapter.js";

const request = {
  venue: "0x172fcD41E0913e95784454622d1c3724f546f849",
  constraints: { lowerPrice: "681.612897", upperPrice: "709.433831" },
} as unknown as BoundedGridRequest;
const firstParty = { decision: "BUILD_GRID" } as BoundedGridDeliverable;

describe("AiKi Pancake Grid adapter", () => {
  it("records an exact pool and range as partial compatibility", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("pool")).toBe(request.venue);
      expect(url.searchParams.get("tickLower")).toBe("-65647");
      expect(url.searchParams.get("tickUpper")).toBe("-65248");
      return new Response(JSON.stringify({
        assessment: {
          pool: request.venue,
          tickLower: -65647,
          tickUpper: -65248,
          spacing: 1,
          category: "grid_trading",
          assessmentVersion: "pancake-v3-grid/v1",
          currentTick: -65447,
          activeGridIndex: 200,
          activeBand: { lower: -65447, upper: -65446 },
          state: "IN_GRID",
          recommendation: "WAIT",
          poolLiquidity: "4914628040853005978365510",
          observedAt: "2026-08-30T12:55:06.231Z",
          caveats: ["Read-only assessment."],
        },
        evidence: { persisted: true },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const result = await auditionAiKiPancakeGrid(request, firstParty, { fetchImpl: fetchImpl as typeof fetch });
    expect(result.outcome).toBe("PARTIAL_COMPATIBILITY");
    expect(result.externalRecommendation).toBe("WAIT");
    expect(result.exactRangeAccepted).toBe(true);
    expect(result.eligibleForLiveMatch).toBe(false);
  });

  it("fails closed when the provider is unavailable", async () => {
    const result = await auditionAiKiPancakeGrid(request, firstParty, {
      fetchImpl: vi.fn(async () => new Response("down", { status: 503 })) as typeof fetch,
    });
    expect(result.outcome).toBe("UNAVAILABLE");
    expect(result.attributable).toBe(false);
  });
});
