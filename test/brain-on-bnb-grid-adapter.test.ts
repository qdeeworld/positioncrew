import { describe, expect, it, vi } from "vitest";

import type { BoundedGridRequest } from "../src/contracts/bounded-grid.js";
import { auditionBrainOnBnbGrid } from "../src/marketplace/brain-on-bnb-grid-adapter.js";
import { createBoundedGridDeliverable } from "../src/providers/bounded-grid.js";

const now = new Date("2026-09-01T14:01:06.000Z");
const request: BoundedGridRequest = {
  schemaVersion: "positioncrew.bounded-grid.request.v1",
  service: "BOUNDED_GRID",
  requestId: "pancake-grid-119355734",
  chainId: 56,
  account: "0x0000000000000000000000000000000000000000",
  protocol: "PancakeSwap V3 bounded grid policy",
  requestedAt: "2026-09-01T14:01:05.500Z",
  deadline: "2026-09-01T14:03:06.000Z",
  maxDataAgeSeconds: 120,
  maxActionUsd: "1000",
  maxGasUsd: "0.25",
  maxSlippageBps: 10,
  sources: [{
    sourceId: "pancake-v3-mainnet-block-119355734",
    label: "Pinned market",
    uri: "https://bscscan.com/block/119355734",
    observedAt: "2026-09-01T14:01:05.000Z",
  }],
  venue: "0x172fcD41E0913e95784454622d1c3724f546f849",
  baseAsset: { symbol: "WBNB", address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", decimals: 18 },
  quoteAsset: { symbol: "USDT", address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 },
  marketState: {
    midPrice: "687.644277",
    liquidityUsd: "223616316.27",
    realizedVolatilityBps: 37,
    venueFeeBps: 1,
    observedAt: "2026-09-01T14:01:05.000Z",
    sourceId: "pancake-v3-mainnet-block-119355734",
  },
  constraints: {
    capitalUsd: "1000",
    lowerPrice: "673.891392",
    upperPrice: "701.397163",
    levelCount: 5,
    maximumInventoryUsd: "600",
    maximumLossUsd: "150",
    minimumExpectedNetProfitUsd: "5",
    minimumLiquidityUsd: "100000",
    maximumVolatilityBps: 1000,
    expectedCompletedCycles: 10,
    estimatedGasUsd: "0.020629",
    orderExpirySeconds: 120,
  },
};

function providerResponse(overrides: Record<string, unknown> = {}) {
  return {
    tool: "pancakeswap_range_plan",
    pair: {
      token: { address: request.baseAsset.address, symbol: "WBNB", decimals: 18 },
      quote: { address: request.quoteAsset.address, symbol: "USDT", decimals: 18 },
    },
    pool: request.venue,
    fee_pct: 0.01,
    tier_chosen_because: "The tier with the most working capital.",
    price_now: 687.7,
    capital_considered_usd: 1000,
    measured_window: {
      from_block: 119351000,
      to_block: 119356000,
      blocks: 5000,
      minutes: 37.5,
      swaps: 10000,
      fees_the_pool_paid_usd: 400,
      note: "One live window.",
    },
    ranges: [1, 2].map((width) => ({
      width_pct: width,
      full_range: false,
      price_range: { low: 687.7 * (1 - width / 100), high: 687.7 * (1 + width / 100), unit: "USDT per WBNB" },
      swaps_in_range: 10000,
      swaps_total: 10000,
      share_of_window_in_range_pct: 100,
      times_it_crossed_the_edge: 0,
      fees_usd_in_window: 0.4,
      assumed_rebalance_cost_usd: 0.48,
      net_after_rebalancing_usd_in_window: 0.4,
    })),
    best_earning_range_in_this_window: "±0.25%",
    best_range_after_paying_to_put_it_back: "±1%",
    rebalance_cost_usd_assumed: 0.48,
    narrowest_range_that_held_the_whole_window: "±1%",
    times_better_than_full_range: 100,
    caveats: ["Read-only replay."],
    ...overrides,
  };
}

describe("Brain on BNB Grid adapter", () => {
  it("normalizes an attributable replay range through the exact buyer contract", async () => {
    const firstParty = createBoundedGridDeliverable(request, now);
    const result = await auditionBrainOnBnbGrid(request, firstParty, {
      now,
      fetchImpl: vi.fn(async (input: URL | RequestInfo) => {
        expect(new URL(String(input)).searchParams.get("address")).toBe(request.baseAsset.address);
        return new Response(JSON.stringify(providerResponse()), { status: 200 });
      }) as typeof fetch,
    });
    expect(result.outcome).toBe("SEMANTICALLY_COMPARABLE");
    expect(result.eligibleForLiveMatch).toBe(true);
    expect(result.normalizedDeliverable?.decision).toBe("BUILD_GRID");
    expect(result.selection?.selectedProvider).toBe("POSITIONCREW");
    expect(result.checks.every((check) => check.status === "PASS")).toBe(true);
  });

  it("rejects a provider range outside the buyer's maximum range", async () => {
    const firstParty = createBoundedGridDeliverable(request, now);
    const response = providerResponse({
      ranges: [{
        ...providerResponse().ranges[0],
        width_pct: 5,
        price_range: { low: 650, high: 725, unit: "USDT per WBNB" },
      }],
    });
    const result = await auditionBrainOnBnbGrid(request, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.eligibleForLiveMatch).toBe(false);
    expect(result.checks.find((check) => check.code === "PROVIDER_RANGE_INSIDE_BUYER_BOUND")?.status).toBe("FAIL");
  });

  it("fails closed when the provider is unavailable", async () => {
    const firstParty = createBoundedGridDeliverable(request, now);
    const result = await auditionBrainOnBnbGrid(request, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response("down", { status: 503 })) as typeof fetch,
    });
    expect(result.outcome).toBe("UNAVAILABLE");
    expect(result.eligibleForLiveMatch).toBe(false);
  });
});
