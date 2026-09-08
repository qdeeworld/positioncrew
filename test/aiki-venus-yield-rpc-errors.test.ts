import { describe, expect, it } from "vitest";

import type { YieldOptimizationRequest } from "../src/contracts/yield-optimization.js";
import { auditionAiKiVenusYield, AIKI_VENUS_YIELD } from "../src/marketplace/aiki-venus-yield-adapter.js";
import { createYieldOptimizationDeliverable } from "../src/providers/yield-optimization.js";
import { annualizedYieldBps } from "../src/telemetry/bsc.js";

const NOW = new Date("2026-09-07T21:50:41.478Z");
const BLOCK = 120569152;
const OBSERVED_AT = "2026-09-07T21:49:16.000Z";
const RATE = 410632935n;
const MARKET = "0xC4eF4229FEc74Ccfe17B2bdeF7715fAC740BA0ba";

function request(): YieldOptimizationRequest {
  return {
    schemaVersion: "positioncrew.yield-optimization.request.v1",
    service: "YIELD_OPTIMIZATION",
    requestId: `venus-yield-${BLOCK}`,
    account: "0x0000000000000000000000000000000000000000",
    chainId: 56,
    protocol: "Venus Core Pool stablecoin supply",
    requestedAt: "2026-09-07T21:49:17.817Z",
    deadline: "2026-09-07T21:51:17.817Z",
    maxDataAgeSeconds: 120,
    capitalUsd: "1000.00",
    maxActionUsd: "1000.00",
    maxAllocationUsd: "1000.00",
    maxExecutionCostUsd: "0.25",
    maxGasUsd: "0.25",
    maxSlippageBps: 0,
    currentPositions: [],
    opportunities: [{
      opportunityId: "venus-core-fdusd-supply",
      protocol: "Venus Core Pool",
      vaultOrMarket: MARKET,
      asset: {
        address: "0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409",
        decimals: 18,
        symbol: "FDUSD",
      },
      amountUsd: "1000.00",
      grossApyBps: annualizedYieldBps(RATE, 0.45),
      liquidityUsd: "2507947.02",
      lockupSeconds: 0,
      estimatedEntryCostUsd: "0.012930",
      estimatedExitCostUsd: "0.012930",
      riskTier: "MEDIUM",
      observedAt: OBSERVED_AT,
      sourceId: `venus-yield-mainnet-block-${BLOCK}`,
    }],
    constraints: {
      evaluationHorizonDays: 90,
      maximumLockupSeconds: 0,
      maximumProtocolConcentrationBps: 10000,
      maximumRiskTier: "MEDIUM",
      minimumLiquidityUsd: "100000",
      minimumNetBenefitUsd: "1",
      protocolAllowlist: ["Venus Core Pool"],
    },
    sources: [{
      sourceId: `venus-yield-mainnet-block-${BLOCK}`,
      label: "Frozen regression observation",
      observedAt: OBSERVED_AT,
      uri: `https://bscscan.com/block/${BLOCK}`,
    }],
  };
}

function assessment(rate = RATE) {
  return {
    assessment: {
      category: "yield_optimisation",
      assessmentVersion: "venus-yield/v1",
      routes: [{
        market: MARKET,
        symbol: "vFDUSD",
        supplyRatePerBlock: rate.toString(),
        simpleAnnualRateBps: "287",
      }],
      recommendedMarket: MARKET,
      recommendation: "RATE_ONLY_CANDIDATE",
      observedAt: NOW.toISOString(),
      caveats: ["Rate-only regression response; no protocol execution."],
    },
    evidence: { persisted: true },
  };
}

type RpcRequest = { id: number; method: string; params: unknown[] };

function transport(options: {
  external?: () => Response;
  rpc?: (body: RpcRequest) => Response | undefined;
} = {}): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(AIKI_VENUS_YIELD.endpoint)) {
      return options.external?.() ?? Response.json(assessment());
    }
    const body = JSON.parse(String(init?.body)) as RpcRequest;
    const override = options.rpc?.(body);
    if (override) return override;
    const blockNumber = body.method === "eth_getBlockByNumber"
      ? Number(BigInt(String(body.params[0])))
      : BLOCK;
    return Response.json({
      jsonrpc: "2.0",
      id: body.id,
      result: body.method === "eth_call"
        ? `0x${RATE.toString(16).padStart(64, "0")}`
        : {
            number: `0x${blockNumber.toString(16)}`,
            timestamp: `0x${Math.floor(Date.parse(OBSERVED_AT) / 1000 - (BLOCK - blockNumber) * 0.45).toString(16)}`,
          },
    });
  };
}

async function compare(fetchImpl: typeof fetch, input = request()) {
  return auditionAiKiVenusYield(
    input,
    createYieldOptimizationDeliverable(input, NOW),
    { now: NOW, fetchImpl },
  );
}

function expectUnavailable(result: Awaited<ReturnType<typeof compare>>, code: string) {
  expect(result.outcome).toBe("UNAVAILABLE");
  expect(result.eligibleForRateRankingActivation).toBe(false);
  expect(result.eligibleForYieldSelection).toBe(false);
  expect(result.eligibleForLiveMatch).toBe(false);
  expect(result.attributable).toBe(false);
  expect(result.persisted).toBe(false);
  expect(result.normalizedDeliverable).toBeUndefined();
  expect(result.checks).toEqual([expect.objectContaining({ code, status: "FAIL" })]);
  expect(result.checks[0]!.detail).not.toMatch(/invalid_type|unrecognized_keys|expected string|secret=/);
  expect(result.boundary).not.toContain("AiKi ranked");
}

describe("AiKi Yield dependency failures", () => {
  it.each(["eth_call", "eth_getBlockByNumber"])("names PositionCrew verification when %s returns an RPC error", async (method) => {
    const result = await compare(transport({
      rpc: (body) => body.method === method ? Response.json({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32000, message: "header unavailable; secret=not-for-display" },
      }) : undefined,
    }));
    expectUnavailable(result, "PINNED_STATE_UNAVAILABLE");
    expect(result.checks[0]!.detail).toContain("PositionCrew could not independently verify");
    expect(result.checks[0]!.detail).toContain("RPC -32000");
    expect(result.boundary).toContain("does not establish that AiKi was offline");
  });

  it("reports verification HTTP errors without blaming the external provider", async () => {
    const result = await compare(transport({ rpc: () => new Response("denied", { status: 403 }) }));
    expectUnavailable(result, "PINNED_STATE_UNAVAILABLE");
    expect(result.checks[0]!.detail).toContain("HTTP 403");
  });

  it("keeps malformed pinned evidence unavailable without dumping schema internals", async () => {
    const result = await compare(transport({
      rpc: (body) => Response.json({ jsonrpc: "2.0", id: body.id, result: null }),
    }));
    expectUnavailable(result, "PINNED_STATE_UNAVAILABLE");
    expect(result.checks[0]!.detail).toContain("incomplete or unsupported evidence");
  });

  it.each([
    ["valid hex that cannot decode as a uint256 ABI result", "0x1"],
    ["a decoded uint256 supply rate that cannot be annualized", `0x${"f".repeat(64)}`],
  ])("attributes %s to pinned verification rather than AiKi", async (_description, resultData) => {
    const result = await compare(transport({
      rpc: (body) => body.method === "eth_call"
        ? Response.json({ jsonrpc: "2.0", id: body.id, result: resultData })
        : undefined,
    }));
    expectUnavailable(result, "PINNED_STATE_UNAVAILABLE");
    expect(result.checks[0]!.detail).toBe(
      "PositionCrew could not independently verify the request's pinned Venus state: supply-rate decoding or annualization did not produce usable evidence. Reload current markets before retrying.",
    );
    expect(result.checks[0]!.detail).not.toContain(resultData);
    expect(result.checks[0]!.detail).not.toMatch(/AbiDecoding|viem|Data size|safe integer/);
    expect(result.boundary).toContain("does not establish that AiKi was offline");
  });

  it("describes a declared provider failure without publishing its raw error", async () => {
    const result = await compare(transport({
      external: () => Response.json({ error: "upstream failed; secret=not-for-display" }),
    }));
    expectUnavailable(result, "EXTERNAL_ASSESSMENT_UNAVAILABLE");
    expect(result.checks[0]!.detail).toContain("AiKi reported");
  });

  it("describes an unsupported external response without a Zod dump", async () => {
    const result = await compare(transport({ external: () => Response.json({ assessment: {} }) }));
    expectUnavailable(result, "EXTERNAL_ASSESSMENT_UNAVAILABLE");
    expect(result.checks[0]!.detail).toContain("incomplete or unsupported yield assessment");
  });

  it("keeps a complete pinned, compatible response eligible", async () => {
    const result = await compare(transport());
    expect(result.outcome).toBe("SEMANTICALLY_COMPARABLE");
    expect(result.eligibleForYieldSelection).toBe(true);
    expect(result.checks.every((check) => check.status === "PASS")).toBe(true);
    expect(result.selection?.selectedProvider).toBe("POSITIONCREW");
  });

  it("does not relax exact rate binding to admit a changed external rate", async () => {
    const result = await compare(transport({ external: () => Response.json(assessment(RATE + 1n)) }));
    expect(result.eligibleForYieldSelection).toBe(false);
    expect(result.eligibleForLiveMatch).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({ code: "PINNED_RATE_BINDING", status: "FAIL" }));
  });

  it("does not produce an actionable allocation above the gas budget", async () => {
    const input = request();
    input.maxGasUsd = "0.000001";
    const result = await compare(transport(), input);
    expect(result.normalizedDeliverable).toBeDefined();
    expect(result.normalizedDeliverable!.status).not.toBe("ACTIONABLE");
    expect(Number(result.normalizedDeliverable!.allocationUsd)).toBe(0);
  });
});
