import { describe, expect, it } from "vitest";
import type {
  LpRebalanceDeliverable,
  LpRebalanceRequest,
} from "../src/contracts/lp-rebalance.js";
import { auditionAiKiPancakeRebalancer } from "../src/marketplace/aiki-pancake-rebalancer-adapter.js";

const request = {
  account: "0x20f1cA5d1e5A3Ee94C29DbF95e6BF6ceA6a8d64b",
  pool: "0x36696169C63e42cd08ce11f5deeBbCeBae652050",
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

function responseBody(owner = request.account): unknown {
  return {
    assessment: {
      tokenId: "7204780",
      owner,
      token0: request.token0.address,
      token1: request.token1.address,
      fee: 500,
      tickLower: request.position.lowerTick,
      tickUpper: request.position.upperTick,
      liquidity: request.position.liquidity,
      currentTick: -65452,
      pool: request.pool,
      observedAt: "2026-08-30T12:00:00.000Z",
      category: "rebalancing",
      assessmentVersion: "pancake-v3-rebalance/v1",
      state: "IN_RANGE",
      recommendation: "HOLD",
    },
    evidence: { persisted: true },
  };
}

describe("AiKi Pancake rebalancer adapter", () => {
  it("proves semantic comparability without promoting exact Live Match", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify(responseBody()), { status: 200 })) as typeof fetch;
    const result = await auditionAiKiPancakeRebalancer(
      request,
      firstParty,
      "7204780",
      { fetchImpl, now: new Date("2026-08-30T12:01:00.000Z") },
    );

    expect(result.outcome).toBe("SEMANTICALLY_COMPARABLE");
    expect(result.completedSamePositionAssessment).toBe(true);
    expect(result.persistedByProvider).toBe(true);
    expect(result.eligibleForLiveMatch).toBe(false);
    expect(result.checks).toContainEqual(
      expect.objectContaining({ code: "EXACT_POSITION_STATE", status: "PASS" }),
    );
    expect(result.checks).toContainEqual(
      expect.objectContaining({ code: "DECISION_ALIGNMENT", status: "PASS" }),
    );
  });

  it("rejects a different position owner", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify(responseBody("0x0000000000000000000000000000000000000000")),
        { status: 200 },
      )) as typeof fetch;
    const result = await auditionAiKiPancakeRebalancer(
      request,
      firstParty,
      "7204780",
      { fetchImpl, now: new Date("2026-08-30T12:01:00.000Z") },
    );

    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.completedSamePositionAssessment).toBe(false);
  });
});
