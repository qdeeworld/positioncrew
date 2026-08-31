import { describe, expect, it } from "vitest";
import type {
  LpRebalanceDeliverable,
  LpRebalanceRequest,
} from "../src/contracts/lp-rebalance.js";
import { auditionBnbLpRangeRebalancer } from "../src/marketplace/bnb-lp-range-rebalancer-adapter.js";

const request = {
  chainId: 56,
  account: "0x20f1cA5d1e5A3Ee94C29DbF95e6BF6ceA6a8d64b",
  token0: { address: "0x55d398326f99059fF775485246999027B3197955" },
  token1: { address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" },
  position: {
    lowerTick: -65970,
    upperTick: -63960,
    liquidity: "331686056257200361",
  },
  maxDataAgeSeconds: 120,
} as LpRebalanceRequest;

const firstParty = { decision: "HOLD" } as LpRebalanceDeliverable;

function fetchFixture(route: string): unknown {
  if (route.endsWith("/health")) {
    return {
      status: "ok",
      rpc: "up",
      protocol: "up",
      chain_id: 56,
      last_check: "2026-08-30T12:00:00.000Z",
    };
  }
  if (route.endsWith("/status")) {
    return {
      status: "active",
      token_id: 7204780,
      rebalance_required: false,
      last_check: "2026-08-30T12:00:00.000Z",
    };
  }
  if (route.endsWith("/positions")) {
    return {
      network: "bsc-mainnet",
      positions: [
        {
          token_id: 7204780,
          owner: request.account,
          token0: request.token0.address,
          token1: request.token1.address,
          tick_lower: request.position.lowerTick,
          tick_upper: request.position.upperTick,
          liquidity: request.position.liquidity,
          verification: { verified: true, checks: {}, problems: [] },
        },
      ],
    };
  }
  return {
    name: "BNB LP Range Rebalancer",
    category: "rebalancing",
    protocol: "PancakeSwap V3",
  };
}

const fetchImpl = (async (input: RequestInfo | URL) =>
  new Response(JSON.stringify(fetchFixture(String(input))), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;

describe("BNB LP Range Rebalancer adapter", () => {
  it("records an attributable semantic match without promoting exact Live Match", async () => {
    const result = await auditionBnbLpRangeRebalancer(
      request,
      firstParty,
      "7204780",
      { fetchImpl, now: new Date("2026-08-30T12:01:00.000Z") },
    );

    expect(result.outcome).toBe("SEMANTIC_MATCH_ONLY");
    expect(result.attributableResult).toBe(true);
    expect(result.externalDecision).toBe("HOLD");
    expect(result.eligibleForLiveMatch).toBe(false);
    expect(result.exactRequestAccepted).toBe(false);
    expect(result.exactOutputContract).toBe(false);
    expect(result.checks).toContainEqual(
      expect.objectContaining({ code: "DECISION_ALIGNMENT", status: "PASS" }),
    );
    expect(result.checks).toContainEqual(
      expect.objectContaining({ code: "RAW_LIQUIDITY_PRECISION", status: "PASS" }),
    );
    expect(result.checks).toContainEqual(
      expect.objectContaining({ code: "EXACT_REQUEST_ACCEPTANCE", status: "FAIL" }),
    );
  });

  it("fails semantic compatibility when the provider owner differs", async () => {
    const mismatchedFetch = (async (input: RequestInfo | URL) => {
      const fixture = fetchFixture(String(input));
      if (String(input).endsWith("/positions")) {
        const positions = fixture as { positions: Array<{ owner: string }> };
        positions.positions[0]!.owner = "0x0000000000000000000000000000000000000000";
      }
      return new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const result = await auditionBnbLpRangeRebalancer(
      request,
      firstParty,
      "7204780",
      { fetchImpl: mismatchedFetch, now: new Date("2026-08-30T12:01:00.000Z") },
    );

    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.eligibleForLiveMatch).toBe(false);
  });
});
