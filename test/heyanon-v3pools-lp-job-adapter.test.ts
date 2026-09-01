import { describe, expect, it } from "vitest";
import { LpRebalanceRequestSchema } from "../src/contracts/lp-rebalance.js";
import { auditionHeyAnonV3LpJob } from "../src/marketplace/heyanon-v3pools-lp-job-adapter.js";

const positionId = "7284554";
const token0 = "0x55d398326f99059fF775485246999027B3197955";
const token1 = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const owner = "0xD746e0921d1a3D7fD3b346F037b6acC34A1eE4B3";
const liquidity = "67739875241796152863897";
const pool = "0x172fcD41E0913e95784454622d1c3724f546f849";

const request = LpRebalanceRequestSchema.parse({
  schemaVersion: "positioncrew.lp-rebalance.request.v1",
  service: "LP_REBALANCE",
  requestId: "pancake-position-7284554-test",
  chainId: 56,
  account: owner,
  protocol: "PancakeSwap V3 position analysis",
  requestedAt: "2026-08-30T12:00:00.000Z",
  deadline: "2026-08-30T12:02:00.000Z",
  maxDataAgeSeconds: 120,
  maxActionUsd: "20",
  maxGasUsd: "2",
  maxSlippageBps: 30,
  sources: [{
    sourceId: "pancake-position-mainnet-block-118955550",
    label: "Pinned Pancake V3 position",
    uri: "https://bscscan.com/block/118955550",
    observedAt: "2026-08-30T11:59:00.000Z",
  }],
  pool,
  token0: { symbol: "USDT", address: token0, decimals: 18 },
  token1: { symbol: "WBNB", address: token1, decimals: 18 },
  position: {
    lowerTick: -65467,
    upperTick: -65388,
    liquidity,
    positionValueUsd: "7032.410787",
    feesEarnedUsd: "1.572293",
    token0ShareBps: 2878,
    token1ShareBps: 7122,
  },
  marketState: {
    currentTick: -65411,
    token0PriceUsd: "1",
    token1PriceUsd: "692.7356257",
    volume24hUsd: "67507413.91",
    fees24hUsd: "6750.74",
    poolLiquidityUsd: "251766626.13",
    realizedVolatilityBps: 41,
    observedAt: "2026-08-30T11:59:00.000Z",
    sourceId: "pancake-position-mainnet-block-118955550",
  },
  constraints: {
    minimumWidthTicks: 39,
    maximumWidthTicks: 237,
    tickSpacing: 1,
    edgeBufferBps: 1000,
    highVolatilityBps: 1000,
    maximumToken0ShareBps: 7500,
    maximumToken1ShareBps: 7500,
    minimumNetBenefitUsd: "7.032411",
    estimatedGasUsd: "0.1",
    estimatedSwapCostUsd: "5",
    evaluationHorizonHours: 24,
  },
});

function word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function addressWord(value: string): string {
  return value.slice(2).toLowerCase().padStart(64, "0");
}

function positionResponse(): string {
  return `0x${[
    word(0n), word(0n), addressWord(token0), addressWord(token1), word(100n),
    word(BigInt.asUintN(256, -65467n)), word(BigInt.asUintN(256, -65388n)),
    word(BigInt(liquidity)), word(0n), word(0n), word(0n), word(0n),
  ].join("")}`;
}

function mcp(content: unknown): Response {
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: JSON.stringify(content) }] },
  }), { status: 200 });
}

const fetchImpl: typeof fetch = async (input, init) => {
  const url = String(input);
  const body = JSON.parse(String(init?.body)) as {
    method: string;
    params?: Array<{ data?: string }> | { name?: string };
  };
  if (url.includes("heyanon.ai")) {
    const name = !Array.isArray(body.params) ? body.params?.name : undefined;
    if (name === "getCurrentPoolPrice") {
      return mcp({
        project: "v3pools",
        operation: "getCurrentPoolPrice",
        data: {
          dex: "Pancake",
          poolPrice: "692.735625705",
          token0Symbol: "usdt",
          token1Symbol: "wbnb",
          fee: "0.01%",
          oraclePrice: 692.762137,
        },
      });
    }
    if (name === "getPredefinedPriceRanges") {
      return mcp({
        project: "v3pools",
        operation: "getPredefinedPriceRanges",
        data: {
          pool: "wbnb/usdt",
          lowerPrice: "0.001371374539938155",
          upperPrice: "0.001515729754668487",
        },
      });
    }
    return mcp({
      project: "v3pools",
      operation: "getLpPosition",
      data: { positions: [{
        chainName: "bsc",
        protocol: "Pancake",
        positionId,
        token0: { symbol: "usdt", address: token0 },
        token1: { symbol: "wbnb", address: token1 },
        fee: "0.01%",
        liquidity,
        amount0: "2023.97",
        amount0Pct: 28.78,
        amount1: "7.23",
        amount1Pct: 71.22,
        pendingFee0: "0.74",
        pendingFee1: "0.0012",
        currentPrice: "0.0014434",
        lowerPrice: "0.0014353",
        upperPrice: "0.0014467",
      }] },
    });
  }
  const params = Array.isArray(body.params) ? body.params : [];
  const data = params[0]?.data ?? "";
  const result = body.method === "eth_blockNumber"
    ? "0x7170000"
    : data.includes("1698ee82")
      ? `0x${addressWord(pool)}`
    : data.includes("6352211e")
      ? `0x${addressWord(owner)}`
      : positionResponse();
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
};

describe("HeyAnon V3 Pools exact LP job adapter", () => {
  it("preserves an attributable recommendation while rejecting a range outside buyer limits", async () => {
    const result = await auditionHeyAnonV3LpJob(request, positionId, { fetchImpl });
    expect(result.attributableResult).toBe(true);
    expect(result.checks.find((check) => check.code === "EXACT_POSITION_BINDING")?.status).toBe("PASS");
    expect(result.checks.find((check) => check.code === "RANGE_WIDTH_POLICY")?.status).toBe("FAIL");
    expect(result.status).toBe("INCOMPATIBLE_CONSTRAINTS");
    expect(result.eligibleForLpRebalance).toBe(false);
  });

  it("normalizes a compatible external range into the exact LP deliverable contract", async () => {
    const compatibleRequest = LpRebalanceRequestSchema.parse({
      ...request,
      constraints: {
        ...request.constraints,
        minimumWidthTicks: 500,
        maximumWidthTicks: 3_000,
      },
    });
    const result = await auditionHeyAnonV3LpJob(compatibleRequest, positionId, {
      fetchImpl,
      now: new Date("2026-08-30T12:00:30.000Z"),
    });
    expect(result.status).toBe("ELIGIBLE_WITH_ADAPTER");
    expect(result.eligibleForLpRebalance).toBe(true);
    expect(result.normalizedDeliverable.schemaVersion).toBe("positioncrew.lp-rebalance.deliverable.v1");
    expect(result.checks.find((check) => check.code === "EXACT_OUTPUT_CONTRACT")?.status).toBe("PASS");
  });

  it("rejects a caller-supplied position that does not match the position manager", async () => {
    const alteredRequest = LpRebalanceRequestSchema.parse({
      ...request,
      position: { ...request.position, liquidity: "1" },
    });
    const result = await auditionHeyAnonV3LpJob(alteredRequest, positionId, { fetchImpl });
    expect(result.checks.find((check) => check.code === "EXACT_POSITION_BINDING")?.status).toBe("FAIL");
    expect(result.eligibleForLpRebalance).toBe(false);
  });

  it("does not promote an expired normalized refusal", async () => {
    const result = await auditionHeyAnonV3LpJob(request, positionId, {
      fetchImpl,
      now: new Date("2026-08-30T12:03:00.000Z"),
    });
    expect(result.normalizedDeliverable.status).toBe("REFUSED_EXPIRED");
    expect(result.checks.find((check) => check.code === "NORMALIZED_EVIDENCE_GATE")?.status).toBe("FAIL");
    expect(result.eligibleForLpRebalance).toBe(false);
  });

  it("rejects tick spacing that does not match the pinned fee tier", async () => {
    const alteredRequest = LpRebalanceRequestSchema.parse({
      ...request,
      constraints: { ...request.constraints, tickSpacing: 10 },
    });
    const result = await auditionHeyAnonV3LpJob(alteredRequest, positionId, { fetchImpl });
    expect(result.checks.find((check) => check.code === "TICK_SPACING_BINDING")?.status).toBe("FAIL");
    expect(result.eligibleForLpRebalance).toBe(false);
  });

  it("rejects market economics bound to a different pool", async () => {
    const alteredRequest = LpRebalanceRequestSchema.parse({
      ...request,
      pool: "0x0000000000000000000000000000000000000001",
    });
    const result = await auditionHeyAnonV3LpJob(alteredRequest, positionId, { fetchImpl });
    expect(result.checks.find((check) => check.code === "EXACT_POOL_BINDING")?.status).toBe("FAIL");
    expect(result.eligibleForLpRebalance).toBe(false);
  });
});
