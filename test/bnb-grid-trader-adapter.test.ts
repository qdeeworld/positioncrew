import { describe, expect, it } from "vitest";
import type {
  BoundedGridDeliverable,
  BoundedGridRequest,
} from "../src/contracts/bounded-grid.js";
import { auditionBnbGridTrader } from "../src/marketplace/bnb-grid-trader-adapter.js";

const request = {
  chainId: 56,
  maxSlippageBps: 10,
  baseAsset: { symbol: "WBNB" },
  quoteAsset: { symbol: "USDT" },
  marketState: { midPrice: "695" },
  constraints: {
    capitalUsd: "100.00",
    levelCount: 5,
    lowerPrice: "681",
    upperPrice: "709",
    maximumLossUsd: "15.00",
  },
} as BoundedGridRequest;

const firstParty = {
  decision: "BUILD_GRID",
  orders: [{}, {}, {}, {}, {}],
  expectedNetProfitUsd: "2.75",
  worstCaseLossUsd: "3.25",
} as BoundedGridDeliverable;

function fixture(url: string): unknown {
  if (url.endsWith("/health")) {
    return { status: "ok", keyless: true, network: "bsc-mainnet" };
  }
  if (url.endsWith("/status")) {
    return { status: "paused", network: "bsc-mainnet", price_usdt_per_bnb: 695 };
  }
  return {
    spot_price: 695,
    lower: 625.5,
    upper: 764.5,
    levels: 9,
    grid: [625.5, 642, 658, 675, 692, 709, 727, 746, 764.5],
    capital_quote: 100,
    slippage_pct: 0.5,
    network: "bsc-mainnet",
    pair: "BNB/USDT",
    pool_fee_tier: 500,
  };
}

const fetchImpl = (async (input: RequestInfo | URL) =>
  new Response(JSON.stringify(fixture(String(input))), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;

describe("BNB Grid Trader adapter", () => {
  it("keeps an attributable public plan below exact Live Match", async () => {
    const result = await auditionBnbGridTrader(request, firstParty, {
      fetchImpl,
      now: new Date("2026-08-30T12:00:00.000Z"),
    });

    expect(result.outcome).toBe("PARTIAL_COMPATIBILITY");
    expect(result.attributableResult).toBe(true);
    expect(result.activatable).toBe(false);
    expect(result.eligibleForLiveMatch).toBe(false);
    expect(result.checks).toContainEqual(
      expect.objectContaining({ code: "PRICE_COHERENCE", status: "PASS" }),
    );
    expect(result.checks).toContainEqual(
      expect.objectContaining({ code: "LEVEL_COUNT", status: "FAIL" }),
    );
    expect(result.checks).toContainEqual(
      expect.objectContaining({ code: "ACTIVATABLE", status: "FAIL" }),
    );
  });

  it("rejects a plan for a different pair", async () => {
    const wrongPairFetch = (async (input: RequestInfo | URL) => {
      const value = fixture(String(input)) as Record<string, unknown>;
      if (String(input).includes("/plan?")) value.pair = "ETH/USDT";
      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const result = await auditionBnbGridTrader(request, firstParty, {
      fetchImpl: wrongPairFetch,
    });

    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.attributableResult).toBe(false);
  });
});
