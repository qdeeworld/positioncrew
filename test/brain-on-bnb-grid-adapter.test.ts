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
    lowerPrice: "673.891391",
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
      to_block: 119355999,
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
      fees_usd_in_window: 0.8,
      assumed_rebalance_cost_usd: 0.48,
      net_after_rebalancing_usd_in_window: 0.32,
    })),
    best_earning_range_in_this_window: "±0.25%",
    best_range_after_paying_to_put_it_back: "±2%",
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

  it("rejects declared widths whose returned prices are unrelated", async () => {
    const firstParty = createBoundedGridDeliverable(request, now);
    const response = providerResponse({
      ranges: [{
        ...providerResponse().ranges[1],
        price_range: { low: 600, high: 800, unit: "USDT per WBNB" },
      }],
    });
    const result = await auditionBrainOnBnbGrid(request, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.checks.find((check) => check.code === "PROVIDER_RANGE_BINDING")?.status).toBe("FAIL");
  });

  it("rejects crossed raw bounds before normalization", async () => {
    const firstParty = createBoundedGridDeliverable(request, now);
    const response = providerResponse({
      best_range_after_paying_to_put_it_back: "±0.01%",
      ranges: [{
        ...providerResponse().ranges[0],
        width_pct: 0.01,
        price_range: { low: 687.71, high: 687.69, unit: "USDT per WBNB" },
      }],
    });
    const result = await auditionBrainOnBnbGrid(request, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.externalRecommendation).toBe("BUILD_GRID");
    expect(result.providerRange?.lowerPrice).toBe(687.71);
    expect(result.providerRange?.upperPrice).toBe(687.69);
    expect(result.checks.find((check) => check.code === "PROVIDER_RANGE_BINDING")?.status).toBe("FAIL");
    expect(result.eligibleForLiveMatch).toBe(false);
  });

  it("rejects ambiguous duplicate rows for the declared best width", async () => {
    const firstParty = createBoundedGridDeliverable(request, now);
    const valid = providerResponse().ranges[1];
    const response = providerResponse({
      ranges: [
        { ...valid, price_range: { low: 700, high: 690, unit: "USDT per WBNB" } },
        valid,
      ],
    });
    const result = await auditionBrainOnBnbGrid(request, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.providerRange?.lowerPrice).toBe(700);
    expect(result.checks.find((check) => check.code === "PROVIDER_RANGE_BINDING")?.status).toBe("FAIL");
    expect(result.normalizedDeliverable).toBeUndefined();
    expect(result.eligibleForLiveMatch).toBe(false);
  });

  it("requires an exact decimal match for the provider's declared best width", async () => {
    const firstParty = createBoundedGridDeliverable(request, now);
    const width = 0.0000019;
    const response = providerResponse({
      best_range_after_paying_to_put_it_back: "±0.000001%",
      ranges: [{
        ...providerResponse().ranges[0],
        width_pct: width,
        price_range: {
          low: 687.7 * (1 - width / 100),
          high: 687.7 * (1 + width / 100),
          unit: "USDT per WBNB",
        },
      }],
    });
    const result = await auditionBrainOnBnbGrid(request, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.providerRange).toBeNull();
    expect(result.eligibleForLiveMatch).toBe(false);
  });

  it("handles exponent-form provider widths without classifying the provider unavailable", async () => {
    const firstParty = createBoundedGridDeliverable(request, now);
    const width = 1e-7;
    const response = providerResponse({
      best_range_after_paying_to_put_it_back: "±0.0000001%",
      ranges: [{
        ...providerResponse().ranges[0],
        width_pct: width,
        price_range: {
          low: 687.7 * (1 - width / 100),
          high: 687.7 * (1 + width / 100),
          unit: "USDT per WBNB",
        },
      }],
    });
    const result = await auditionBrainOnBnbGrid(request, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).not.toBe("UNAVAILABLE");
    expect(result.providerRange?.widthPct).toBe(width);
  });

  it("rejects replay ranges with no demonstrated in-range activity", async () => {
    const firstParty = createBoundedGridDeliverable(request, now);
    const response = providerResponse({
      ranges: [{
        ...providerResponse().ranges[1],
        swaps_in_range: 0,
        share_of_window_in_range_pct: 0,
        fees_usd_in_window: 0,
        net_after_rebalancing_usd_in_window: 0,
      }],
    });
    const result = await auditionBrainOnBnbGrid(request, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.checks.find((check) => check.code === "ATTRIBUTABLE_REPLAY_EVIDENCE")?.status).toBe("FAIL");
  });

  it("rejects replay economics that do not subtract the declared rebalance cost", async () => {
    const firstParty = createBoundedGridDeliverable(request, now);
    const response = providerResponse({
      ranges: [{
        ...providerResponse().ranges[1],
        fees_usd_in_window: 0.4,
        assumed_rebalance_cost_usd: 0.48,
        net_after_rebalancing_usd_in_window: 0.4,
      }],
    });
    const result = await auditionBrainOnBnbGrid(request, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.externalRecommendation).toBe("BUILD_GRID");
    expect(result.providerRange).not.toBeNull();
    expect(result.eligibleForRangeAssessmentActivation).toBe(false);
    expect(result.checks.find((check) => check.code === "ATTRIBUTABLE_REPLAY_EVIDENCE")?.status).toBe("FAIL");
  });

  it("rejects apparent positive net below the consistency tolerance", async () => {
    const firstParty = createBoundedGridDeliverable(request, now);
    const response = providerResponse({
      rebalance_cost_usd_assumed: 0.000001,
      ranges: [{
        ...providerResponse().ranges[1],
        fees_usd_in_window: 0.0000005,
        assumed_rebalance_cost_usd: 0.000001,
        net_after_rebalancing_usd_in_window: 0.0000001,
      }],
    });
    const result = await auditionBrainOnBnbGrid(request, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.checks.find((check) => check.code === "ATTRIBUTABLE_REPLAY_EVIDENCE")?.status).toBe("FAIL");
  });

  it("rejects impossible replay activity and fee totals", async () => {
    const firstParty = createBoundedGridDeliverable(request, now);
    const response = providerResponse({
      ranges: [{
        ...providerResponse().ranges[1],
        swaps_in_range: 10001,
        share_of_window_in_range_pct: 101,
        fees_usd_in_window: 500,
        net_after_rebalancing_usd_in_window: 499.52,
      }],
    });
    const result = await auditionBrainOnBnbGrid(request, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.eligibleForRangeAssessmentActivation).toBe(false);
    expect(result.checks.find((check) => check.code === "ATTRIBUTABLE_REPLAY_EVIDENCE")?.status).toBe("FAIL");
  });

  it("rejects a replay from a different fee tier", async () => {
    const firstParty = createBoundedGridDeliverable(request, now);
    const result = await auditionBrainOnBnbGrid(request, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(providerResponse({ fee_pct: 0.05 })), { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.checks.find((check) => check.code === "EXACT_FEE_TIER")?.status).toBe("FAIL");
  });

  it("requires exact fixed-point replay capital", async () => {
    const smallCapitalRequest: BoundedGridRequest = {
      ...request,
      constraints: { ...request.constraints, capitalUsd: "0.0000100" },
    };
    const firstParty = createBoundedGridDeliverable(smallCapitalRequest, now);
    const result = await auditionBrainOnBnbGrid(smallCapitalRequest, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(providerResponse({
        capital_considered_usd: 0.0000109,
      })), { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.checks.find((check) => check.code === "EXACT_CAPITAL")?.status).toBe("FAIL");
  });

  it("uses the raw capital lexeme instead of its rounded JSON number", async () => {
    const firstParty = createBoundedGridDeliverable(request, now);
    const raw = JSON.stringify(providerResponse()).replace(
      '"capital_considered_usd":1000',
      '"capital_considered_usd":1000.000000000000000001',
    );
    const result = await auditionBrainOnBnbGrid(request, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(raw, { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.checks.find((check) => check.code === "EXACT_CAPITAL")?.status).toBe("FAIL");
  });

  it("uses the raw fee-tier lexeme for exact identity", async () => {
    const firstParty = createBoundedGridDeliverable(request, now);
    const raw = JSON.stringify(providerResponse()).replace(
      '"fee_pct":0.01',
      '"fee_pct":0.010000000000000001',
    );
    const result = await auditionBrainOnBnbGrid(request, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(raw, { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.checks.find((check) => check.code === "EXACT_FEE_TIER")?.status).toBe("FAIL");
  });

  it("checks replay economics from raw lexemes beyond integer precision", async () => {
    const firstParty = createBoundedGridDeliverable(request, now);
    const raw = JSON.stringify(providerResponse())
      .replace('"fees_usd_in_window":0.8', '"fees_usd_in_window":100000000000000000000')
      .replace('"assumed_rebalance_cost_usd":0.48', '"assumed_rebalance_cost_usd":1')
      .replace('"net_after_rebalancing_usd_in_window":0.32', '"net_after_rebalancing_usd_in_window":100000000000000000000')
      .replace('"rebalance_cost_usd_assumed":0.48', '"rebalance_cost_usd_assumed":1');
    const result = await auditionBrainOnBnbGrid(request, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(raw, { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.providerRange).not.toBeNull();
    expect(result.checks.find((check) => check.code === "ATTRIBUTABLE_REPLAY_EVIDENCE")?.status).toBe("FAIL");
  });

  it("enforces the measured-window fee ceiling with exact decimal values", async () => {
    const firstParty = createBoundedGridDeliverable(request, now);
    const raw = JSON.stringify(providerResponse())
      .replace('"fees_the_pool_paid_usd":400', '"fees_the_pool_paid_usd":0')
      .replace('"fees_usd_in_window":0.8', '"fees_usd_in_window":0.0000005')
      .replace('"assumed_rebalance_cost_usd":0.48', '"assumed_rebalance_cost_usd":0.0000001')
      .replace('"net_after_rebalancing_usd_in_window":0.32', '"net_after_rebalancing_usd_in_window":0.0000004')
      .replace('"rebalance_cost_usd_assumed":0.48', '"rebalance_cost_usd_assumed":0.0000001');
    const result = await auditionBrainOnBnbGrid(request, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(raw, { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.checks.find((check) => check.code === "ATTRIBUTABLE_REPLAY_EVIDENCE")?.status).toBe("FAIL");
  });

  it("rejects escaped duplicate JSON keys before trusting raw numeric evidence", async () => {
    const firstParty = createBoundedGridDeliverable(request, now);
    const raw = JSON.stringify(providerResponse())
      .replace(
        '"fees_the_pool_paid_usd":400',
        '"fees_the_pool_paid_usd":400,"fees_the_pool_paid_\\u0075sd":0',
      )
      .replace(
        '"fees_usd_in_window":0.8',
        '"fees_usd_in_window":0.8,"fees_usd_in_w\\u0069ndow":100',
      );
    const result = await auditionBrainOnBnbGrid(request, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(raw, { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.checks.find((check) => check.code === "RAW_JSON_KEY_SAFETY")?.status).toBe("FAIL");
    expect(result.eligibleForLiveMatch).toBe(false);
  });

  it("rejects literal duplicate keys even when the later value is signed", async () => {
    const firstParty = createBoundedGridDeliverable(request, now);
    const raw = JSON.stringify(providerResponse()).replace(
      '"net_after_rebalancing_usd_in_window":0.32',
      '"net_after_rebalancing_usd_in_window":0.32,"net_after_rebalancing_usd_in_window":-1',
    );
    const result = await auditionBrainOnBnbGrid(request, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(raw, { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.checks.find((check) => check.code === "RAW_JSON_KEY_SAFETY")?.status).toBe("FAIL");
  });

  it("accepts harmless unique escaped keys without erasing provider evidence", async () => {
    const firstParty = createBoundedGridDeliverable(request, now);
    const raw = JSON.stringify(providerResponse()).replace('"note":', '"n\\u006fte":');
    const result = await auditionBrainOnBnbGrid(request, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(raw, { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("SEMANTICALLY_COMPARABLE");
    expect(result.providerRange).not.toBeNull();
    expect(result.checks.find((check) => check.code === "RAW_JSON_KEY_SAFETY")?.status).toBe("PASS");
  });

  it("rejects unbounded decimal exponents without expanding them", async () => {
    const firstParty = createBoundedGridDeliverable(request, now);
    const raw = JSON.stringify(providerResponse()).replace(
      '"fees_the_pool_paid_usd":400',
      '"fees_the_pool_paid_usd":1e-100000000',
    );
    const result = await auditionBrainOnBnbGrid(request, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(raw, { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.checks.find((check) => check.code === "ATTRIBUTABLE_REPLAY_EVIDENCE")?.status).toBe("FAIL");
  });

  it("preserves a declared width that exceeds the safe exponent expansion bound", async () => {
    const firstParty = createBoundedGridDeliverable(request, now);
    const bestWidth = `0.${"0".repeat(100)}1`;
    const response = providerResponse({
      best_range_after_paying_to_put_it_back: `±${bestWidth}%`,
      ranges: [{
        ...providerResponse().ranges[0],
        width_pct: 1e-101,
        price_range: { low: 687.7, high: 687.7, unit: "USDT per WBNB" },
      }],
    });
    const result = await auditionBrainOnBnbGrid(request, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.externalRecommendation).toBe("BUILD_GRID");
    expect(result.providerRange?.widthPct).toBe(1e-101);
    expect(result.eligibleForLiveMatch).toBe(false);
  });

  it("does not associate a rounded exponent width with a different declared claim", async () => {
    const firstParty = createBoundedGridDeliverable(request, now);
    const bestWidth = `0.${"0".repeat(100)}1`;
    const raw = JSON.stringify(providerResponse({
      best_range_after_paying_to_put_it_back: `±${bestWidth}%`,
      ranges: [{
        ...providerResponse().ranges[0],
        width_pct: 1e-101,
        price_range: { low: 687.7, high: 687.7, unit: "USDT per WBNB" },
      }],
    })).replace('"width_pct":1e-101', '"width_pct":1.00000000000000001e-101');
    const result = await auditionBrainOnBnbGrid(request, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(raw, { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.externalRecommendation).toBe("NO_GRID");
    expect(result.providerRange).toBeNull();
  });

  it("rejects oversized decimal mantissas before fixed-point conversion", async () => {
    const firstParty = createBoundedGridDeliverable(request, now);
    const oversized = `0.${"0".repeat(300)}1`;
    const raw = JSON.stringify(providerResponse()).replace(
      '"fees_the_pool_paid_usd":400',
      `"fees_the_pool_paid_usd":${oversized}`,
    );
    const result = await auditionBrainOnBnbGrid(request, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(raw, { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.checks.find((check) => check.code === "ATTRIBUTABLE_REPLAY_EVIDENCE")?.status).toBe("FAIL");
  });

  it("binds token decimals as part of the requested pair identity", async () => {
    const firstParty = createBoundedGridDeliverable(request, now);
    const response = providerResponse();
    response.pair.token.decimals = 8;
    const result = await auditionBrainOnBnbGrid(request, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.checks.find((check) => check.code === "EXACT_POOL_AND_PAIR")?.status).toBe("FAIL");
  });

  it("binds token decimals from their raw integer lexemes", async () => {
    const firstParty = createBoundedGridDeliverable(request, now);
    const raw = JSON.stringify(providerResponse()).replace(
      '"decimals":18',
      '"decimals":17.999999999999999999',
    );
    const result = await auditionBrainOnBnbGrid(request, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(raw, { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.checks.find((check) => check.code === "EXACT_POOL_AND_PAIR")?.status).toBe("FAIL");
  });

  it("rejects raw price deviations just beyond the declared tolerance", async () => {
    const firstParty = createBoundedGridDeliverable(request, now);
    const priceJustBeyondTolerance = Number(request.marketState.midPrice) * (1 + 25.4 / 10_000);
    const response = providerResponse({
      price_now: priceJustBeyondTolerance,
      ranges: [2].map((width) => ({
        ...providerResponse().ranges[1],
        width_pct: width,
        price_range: {
          low: priceJustBeyondTolerance * (1 - width / 100),
          high: priceJustBeyondTolerance * (1 + width / 100),
          unit: "USDT per WBNB",
        },
      })),
    });
    const result = await auditionBrainOnBnbGrid(request, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.checks.find((check) => check.code === "CURRENT_PRICE_COHERENCE")?.status).toBe("FAIL");
  });

  it("rejects a replay whose declared block count contradicts its endpoints", async () => {
    const firstParty = createBoundedGridDeliverable(request, now);
    const response = providerResponse();
    response.measured_window.blocks = 4000;
    const result = await auditionBrainOnBnbGrid(request, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.checks.find((check) => check.code === "MEASURED_WINDOW_BLOCK_COUNT")?.status).toBe("FAIL");
  });

  it("rejects replay block declarations beyond safe integer precision", async () => {
    const firstParty = createBoundedGridDeliverable(request, now);
    const raw = JSON.stringify(providerResponse())
      .replace('"to_block":119355999', '"to_block":10000000000000000000000000')
      .replace('"blocks":5000', '"blocks":10000000000000000000000000');
    const result = await auditionBrainOnBnbGrid(request, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(raw, { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("UNAVAILABLE");
    expect(result.eligibleForLiveMatch).toBe(false);
  });

  it("rejects fractional replay block lexemes that JSON rounds to integers", async () => {
    const firstParty = createBoundedGridDeliverable(request, now);
    const raw = JSON.stringify(providerResponse()).replace(
      '"from_block":119351000',
      '"from_block":119350999.999999999999',
    );
    const result = await auditionBrainOnBnbGrid(request, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(raw, { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.checks.find((check) => check.code === "MEASURED_WINDOW_BLOCK_COUNT")?.status).toBe("FAIL");
    expect(result.eligibleForLiveMatch).toBe(false);
  });

  it("rejects fractional swap-count lexemes that JSON rounds to integers", async () => {
    const firstParty = createBoundedGridDeliverable(request, now);
    const raw = JSON.stringify(providerResponse()).replaceAll(
      '"swaps_in_range":10000',
      '"swaps_in_range":99.999999999999999999',
    );
    const result = await auditionBrainOnBnbGrid(request, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(raw, { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.checks.find((check) => check.code === "ATTRIBUTABLE_REPLAY_EVIDENCE")?.status).toBe("FAIL");
    expect(result.eligibleForLiveMatch).toBe(false);
  });

  it("does not substitute an adapter-selected range for the provider's declared best range", async () => {
    const firstParty = createBoundedGridDeliverable(request, now);
    const result = await auditionBrainOnBnbGrid(request, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(providerResponse({
        best_range_after_paying_to_put_it_back: "±0.75%",
      })), { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.externalRecommendation).toBe("NO_GRID");
    expect(result.providerRange).toBeNull();
  });

  it("preserves a validated provider recommendation when buyer-policy normalization refuses it", async () => {
    const constrainedRequest: BoundedGridRequest = {
      ...request,
      constraints: { ...request.constraints, minimumExpectedNetProfitUsd: "10000" },
    };
    const firstParty = createBoundedGridDeliverable(constrainedRequest, now);
    const result = await auditionBrainOnBnbGrid(constrainedRequest, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(providerResponse()), { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.externalRecommendation).toBe("BUILD_GRID");
    expect(result.providerRange).not.toBeNull();
    expect(result.checks.find((check) => check.code === "ATTRIBUTABLE_REPLAY_EVIDENCE")?.status).toBe("PASS");
    expect(result.checks.find((check) => check.code === "EXACT_OUTPUT_CONTRACT")?.status).toBe("FAIL");
    expect(result.eligibleForLiveMatch).toBe(false);
  });

  it("preserves raw provider bounds when exact recentering crosses the buyer boundary", async () => {
    const narrowRequest: BoundedGridRequest = {
      ...request,
      constraints: {
        ...request.constraints,
        lowerPrice: String(Number(request.marketState.midPrice) * (1 - 1.99 / 100)),
        upperPrice: String(Number(request.marketState.midPrice) * (1 + 1.99 / 100)),
      },
    };
    const firstParty = createBoundedGridDeliverable(narrowRequest, now);
    const providerPrice = Number(request.marketState.midPrice) * (1 - 20 / 10_000);
    const rawLow = providerPrice * 0.98;
    const rawHigh = providerPrice * 1.02;
    const response = providerResponse({
      price_now: providerPrice,
      ranges: [{
        ...providerResponse().ranges[1],
        width_pct: 2,
        price_range: { low: rawLow, high: rawHigh, unit: "USDT per WBNB" },
      }],
    });
    const result = await auditionBrainOnBnbGrid(narrowRequest, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.externalRecommendation).toBe("BUILD_GRID");
    expect(result.providerRange?.lowerPrice).toBe(rawLow);
    expect(result.providerRange?.upperPrice).toBe(rawHigh);
    expect(result.normalizedDeliverable).toBeUndefined();
    expect(result.checks.find((check) => check.code === "EXACT_OUTPUT_CONTRACT")?.status).toBe("FAIL");
  });

  it("enforces exact buyer bounds for low-priced assets without a dollar epsilon", async () => {
    const midPrice = 0.0003;
    const lowPriceRequest: BoundedGridRequest = {
      ...request,
      marketState: { ...request.marketState, midPrice: String(midPrice) },
      constraints: {
        ...request.constraints,
        lowerPrice: (midPrice * (1 - 1.99 / 100)).toFixed(8),
        upperPrice: (midPrice * (1 + 1.99 / 100)).toFixed(8),
      },
    };
    const firstParty = createBoundedGridDeliverable(lowPriceRequest, now);
    const providerPrice = midPrice * (1 - 20 / 10_000);
    const response = providerResponse({
      price_now: providerPrice,
      ranges: [{
        ...providerResponse().ranges[1],
        price_range: {
          low: providerPrice * 0.98,
          high: providerPrice * 1.02,
          unit: "USDT per WBNB",
        },
      }],
    });
    const result = await auditionBrainOnBnbGrid(lowPriceRequest, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })) as typeof fetch,
    });
    expect(result.externalRecommendation).toBe("BUILD_GRID");
    expect(result.normalizedDeliverable).toBeUndefined();
    expect(result.checks.find((check) => check.code === "EXACT_OUTPUT_CONTRACT")?.status).toBe("FAIL");
    expect(result.eligibleForLiveMatch).toBe(false);
  });

  it("binds the replay window to the source used by the market state", async () => {
    const requestWithAuxiliarySource: BoundedGridRequest = {
      ...request,
      sources: [
        { sourceId: "auxiliary-block-119355734", label: "Auxiliary", uri: "https://bscscan.com/block/119355734", observedAt: request.requestedAt },
        {
          sourceId: request.marketState.sourceId,
          label: "Pinned market",
          uri: "https://bscscan.com/block/119400000",
          observedAt: request.marketState.observedAt,
        },
      ],
    };
    const firstParty = createBoundedGridDeliverable(requestWithAuxiliarySource, now);
    const result = await auditionBrainOnBnbGrid(requestWithAuxiliarySource, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(providerResponse()), { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.checks.find((check) => check.code === "MEASURED_WINDOW_BINDING")?.status).toBe("FAIL");
  });

  it("rejects conflicting block declarations in the matched market source", async () => {
    const conflictingRequest: BoundedGridRequest = {
      ...request,
      sources: [{
        ...request.sources[0]!,
        sourceId: "pancake-v3-mainnet-block-119400000",
        uri: "https://bscscan.com/block/119355734",
      }],
      marketState: { ...request.marketState, sourceId: "pancake-v3-mainnet-block-119400000" },
    };
    const firstParty = createBoundedGridDeliverable(conflictingRequest, now);
    const result = await auditionBrainOnBnbGrid(conflictingRequest, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(providerResponse()), { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.checks.find((check) => check.code === "MEASURED_WINDOW_BINDING")?.status).toBe("FAIL");
  });

  it("rejects BSC-mainnet replay evidence for a testnet request", async () => {
    const testnetRequest: BoundedGridRequest = { ...request, chainId: 97 };
    const firstParty = createBoundedGridDeliverable(testnetRequest, now);
    const result = await auditionBrainOnBnbGrid(testnetRequest, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(providerResponse()), { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.checks.find((check) => check.code === "EXACT_CHAIN")?.status).toBe("FAIL");
    expect(result.eligibleForLiveMatch).toBe(false);
  });

  it("constructs normalized low-price bounds without exponent or excess precision", async () => {
    const lowPriceRequest: BoundedGridRequest = {
      ...request,
      marketState: { ...request.marketState, midPrice: "0.0003" },
      constraints: { ...request.constraints, lowerPrice: "0.00029", upperPrice: "0.00031" },
    };
    const firstParty = createBoundedGridDeliverable(lowPriceRequest, now);
    const response = providerResponse({
      price_now: 0.0003,
      best_range_after_paying_to_put_it_back: "±1%",
      ranges: [{
        ...providerResponse().ranges[0],
        width_pct: 1,
        price_range: { low: 0.000297, high: 0.000303, unit: "USDT per WBNB" },
      }],
    });
    const result = await auditionBrainOnBnbGrid(lowPriceRequest, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).not.toBe("UNAVAILABLE");
    expect(result.normalizedDeliverable).toBeDefined();
  });

  it("preserves evidence when an exact range collapses at 18-decimal output precision", async () => {
    const tinyRequest: BoundedGridRequest = {
      ...request,
      marketState: { ...request.marketState, midPrice: "0.000000000000000002" },
      constraints: {
        ...request.constraints,
        lowerPrice: "0.000000000000000001",
        upperPrice: "0.000000000000000003",
      },
    };
    const firstParty = createBoundedGridDeliverable(tinyRequest, now);
    const response = providerResponse({
      price_now: 0.000000000000000002,
      best_range_after_paying_to_put_it_back: "±10%",
      ranges: [{
        ...providerResponse().ranges[0],
        width_pct: 10,
        price_range: {
          low: 0.0000000000000000018,
          high: 0.0000000000000000022,
          unit: "USDT per WBNB",
        },
      }],
    });
    const result = await auditionBrainOnBnbGrid(tinyRequest, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.externalRecommendation).toBe("BUILD_GRID");
    expect(result.providerRange).not.toBeNull();
    expect(result.normalizedDeliverable).toBeUndefined();
  });

  it("preserves evidence when downstream order prices are below eight-decimal precision", async () => {
    const tinyRequest: BoundedGridRequest = {
      ...request,
      marketState: { ...request.marketState, midPrice: "0.000000002" },
      constraints: {
        ...request.constraints,
        lowerPrice: "0.000000001",
        upperPrice: "0.000000003",
      },
    };
    const firstParty = createBoundedGridDeliverable(request, now);
    const response = providerResponse({
      price_now: 0.000000002,
      best_range_after_paying_to_put_it_back: "±10%",
      ranges: [{
        ...providerResponse().ranges[0],
        width_pct: 10,
        price_range: { low: 0.0000000018, high: 0.0000000022, unit: "USDT per WBNB" },
      }],
    });
    const result = await auditionBrainOnBnbGrid(tinyRequest, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.externalRecommendation).toBe("BUILD_GRID");
    expect(result.providerRange).not.toBeNull();
    expect(result.normalizedDeliverable).toBeUndefined();
  });

  it("withholds activation when replay evidence is not bound to the requested pool", async () => {
    const firstParty = createBoundedGridDeliverable(request, now);
    const response = providerResponse({ pool: "0x0000000000000000000000000000000000000001" });
    const result = await auditionBrainOnBnbGrid(request, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.eligibleForRangeAssessmentActivation).toBe(false);
    expect(result.eligibleForLiveMatch).toBe(false);
  });

  it("does not claim a two-provider match when the first-party result is a refusal", async () => {
    const firstParty = {
      ...createBoundedGridDeliverable(request, now),
      status: "REFUSED_CONSTRAINTS" as const,
      decision: "NO_GRID" as const,
    };
    const result = await auditionBrainOnBnbGrid(request, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(providerResponse()), { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.eligibleForRangeAssessmentActivation).toBe(true);
    expect(result.eligibleForLiveMatch).toBe(false);
    expect(result.selection).toBeUndefined();
    expect(result.checks.find((check) => check.code === "FIRST_PARTY_ACTIONABLE_RESULT")?.status).toBe("FAIL");
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

  it("cancels both failed response bodies across a 5xx retry", async () => {
    const firstParty = createBoundedGridDeliverable(request, now);
    let canceled = 0;
    const failedResponse = () => new Response(new ReadableStream<Uint8Array>({
      cancel() {
        canceled += 1;
      },
    }), { status: 503 });
    const result = await auditionBrainOnBnbGrid(request, firstParty, {
      now,
      fetchImpl: vi.fn(async () => failedResponse()) as typeof fetch,
    });
    expect(result.outcome).toBe("UNAVAILABLE");
    expect(canceled).toBe(2);
  });

  it("retries a 5xx response even when body cancellation rejects", async () => {
    const firstParty = createBoundedGridDeliverable(request, now);
    let calls = 0;
    const result = await auditionBrainOnBnbGrid(request, firstParty, {
      now,
      fetchImpl: vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(new ReadableStream<Uint8Array>({
            cancel() {
              return Promise.reject(new Error("cancel failed"));
            },
          }), { status: 503 });
        }
        return new Response(JSON.stringify(providerResponse()), { status: 200 });
      }) as typeof fetch,
    });
    expect(calls).toBe(2);
    expect(result.outcome).toBe("SEMANTICALLY_COMPARABLE");
  });

  it("cancels a final 4xx provider response body", async () => {
    const firstParty = createBoundedGridDeliverable(request, now);
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        canceled = true;
      },
    });
    const result = await auditionBrainOnBnbGrid(request, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(body, { status: 422 })) as typeof fetch,
    });
    expect(result.outcome).toBe("UNAVAILABLE");
    expect(canceled).toBe(true);
  });

  it("cancels a chunked provider response as soon as it exceeds the byte cap", async () => {
    const firstParty = createBoundedGridDeliverable(request, now);
    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(600_000));
        controller.enqueue(new Uint8Array(600_000));
        controller.close();
      },
    });
    const result = await auditionBrainOnBnbGrid(request, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(oversizedBody, { status: 200 })) as typeof fetch,
    });
    expect(result.outcome).toBe("UNAVAILABLE");
    expect(result.checks[0]?.detail).toContain("exceeds the admitted size");
    expect(result.eligibleForLiveMatch).toBe(false);
  });

  it("cancels a provider body rejected from its Content-Length header", async () => {
    const firstParty = createBoundedGridDeliverable(request, now);
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        canceled = true;
      },
    });
    const result = await auditionBrainOnBnbGrid(request, firstParty, {
      now,
      fetchImpl: vi.fn(async () => new Response(body, {
        status: 200,
        headers: { "content-length": "1000001" },
      })) as typeof fetch,
    });
    expect(result.outcome).toBe("UNAVAILABLE");
    expect(canceled).toBe(true);
  });
});
