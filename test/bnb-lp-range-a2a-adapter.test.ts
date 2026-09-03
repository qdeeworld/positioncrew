import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress, keccak256, toBytes } from "viem";

import type { LpRebalanceRequest } from "../src/contracts/lp-rebalance.js";
import { requestBnbLpRangeQuote } from "../src/marketplace/bnb-lp-range-a2a-adapter.js";

const verifyMessageMock = vi.hoisted(() => vi.fn());
vi.mock("ethers", () => ({ verifyMessage: verifyMessageMock }));

const now = new Date("2026-09-03T14:33:40.000Z");
const request: LpRebalanceRequest = {
  schemaVersion: "positioncrew.lp-rebalance.request.v1",
  service: "LP_REBALANCE",
  requestId: "pancake-position-1456267-119743416",
  chainId: 56,
  account: "0x556B9306565093C855AEA9AE92A594704c2Cd59e",
  protocol: "PancakeSwap V3 position analysis",
  requestedAt: "2026-09-03T14:33:36.101Z",
  deadline: "2026-09-03T14:35:36.101Z",
  maxDataAgeSeconds: 120,
  maxActionUsd: "1.000000",
  maxGasUsd: "0.250000",
  maxSlippageBps: 30,
  sources: [{
    sourceId: "pancake-position-mainnet-block-119743416",
    label: "Block-pinned PancakeSwap V3 position",
    uri: "https://bscscan.com/block/119743416",
    observedAt: "2026-09-03T14:33:34.000Z",
  }],
  pool: "0x36696169C63e42cd08ce11f5deeBbCeBae652050",
  token0: { symbol: "USDT", address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 },
  token1: { symbol: "WBNB", address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", decimals: 18 },
  position: {
    lowerTick: -68150,
    upperTick: -63690,
    liquidity: "612955555285030311979",
    positionValueUsd: "3465.906595",
    feesEarnedUsd: "12.981737",
    token0ShareBps: 4691,
    token1ShareBps: 5309,
  },
  marketState: {
    currentTick: -65775,
    token0PriceUsd: "0.99984469",
    token1PriceUsd: "718.51748247",
    volume24hUsd: "19847187.02",
    fees24hUsd: "9923.59",
    poolLiquidityUsd: "188733107.72",
    realizedVolatilityBps: 51,
    volumeMeasurementWindowSeconds: 3602,
    volumeNormalizationFactor: "23.986674",
    swapCount: 729,
    observedAt: "2026-09-03T14:33:34.000Z",
    sourceId: "pancake-position-mainnet-block-119743416",
  },
  constraints: {
    minimumWidthTicks: 2230,
    maximumWidthTicks: 13380,
    tickSpacing: 10,
    edgeBufferBps: 1000,
    highVolatilityBps: 1000,
    maximumToken0ShareBps: 7500,
    maximumToken1ShareBps: 7500,
    minimumNetBenefitUsd: "3.465907",
    estimatedGasUsd: "0.026944",
    estimatedSwapCostUsd: "0.374257",
    evaluationHorizonHours: 24,
  },
};

function canonical(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item)
    ? item.map(sort)
    : item !== null && typeof item === "object"
      ? Object.fromEntries(Object.keys(item as Record<string, unknown>).sort().map((key) => [key, sort((item as Record<string, unknown>)[key])]))
      : item;
  return JSON.stringify(sort(value)).replace(/[\u007f-\uffff]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function hash(value: unknown): string {
  return keccak256(toBytes(canonical(value)));
}

function sanitize(value: unknown): string {
  return String(value)
    .replaceAll("[", "(")
    .replaceAll("]", ")")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

function rehash(data: any): void {
  data.request_hash = hash(data.request);
  const response = {
    accepted: data.response.accepted,
    terms: data.response.terms,
    estimated_completion_seconds: data.response.estimated_completion_seconds,
    quote_expires_at: data.response.quote_expires_at,
  };
  data.response_hash = hash(response);
  const terms: Record<string, unknown> = {
    deliverables: sanitize(data.response.terms.deliverables),
    quality_standards: sanitize(data.response.terms.quality_standards),
  };
  if (Array.isArray(data.response.terms.success_criteria) && data.response.terms.success_criteria.length > 0) {
    terms.success_criteria = data.response.terms.success_criteria.map(sanitize);
  }
  data.negotiation_hash = hash({
    version: 1,
    negotiated_at: data.response.negotiated_at,
    task: sanitize(data.request.task_description),
    terms,
    price: data.response.terms.price,
    currency: data.response.terms.currency,
    quote_expires_at: data.response.quote_expires_at,
    chain_id: data.chain_id,
    verifying_contract: getAddress(data.verifying_contract),
  });
}

function responseFor(body: string, overrides: Record<string, unknown> = {}): unknown {
  const rpc = JSON.parse(body) as { id: string; params: { message: { parts: Array<{ data: Record<string, unknown> }> } } };
  const submitted = rpc.params.message.parts[0]!.data;
  const envelope = {
    jsonrpc: "2.0",
    id: rpc.id,
    result: {
      kind: "message",
      messageId: "provider-message",
      parts: [{
        kind: "data",
        data: {
          request: {
            task_description: submitted.task_description,
            terms: submitted.terms,
          },
          request_hash: `0x${"1".repeat(64)}`,
          response: {
            accepted: true,
            terms: {
              ...(submitted.terms as Record<string, unknown>),
              price: "100000000000000000",
              currency: "0xcE24439F2D9C6a2289F741120FE202248B666666",
            },
            estimated_completion_seconds: 600,
            quote_expires_at: Math.floor(now.getTime() / 1_000) + 900,
            negotiated_at: Math.floor(now.getTime() / 1_000),
          },
          response_hash: `0x${"2".repeat(64)}`,
          negotiation_hash: `0x${"3".repeat(64)}`,
          provider_sig: `0x${"4".repeat(130)}`,
          chain_id: 56,
          verifying_contract: "0xEa4DAa3100A767e86FDed867729ae7446476EBA6",
          ...overrides,
        },
      }],
    },
  };
  rehash(envelope.result.parts[0]!.data);
  return envelope;
}

beforeEach(() => {
  verifyMessageMock.mockReset();
  verifyMessageMock.mockReturnValue("0x20f1cA5d1e5A3Ee94C29DbF95e6BF6ceA6a8d64b");
});

describe("BNB LP Range signed quote adapter", () => {
  it("accepts an exact-request quote signed by the frozen registry owner", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      new Response(JSON.stringify(responseFor(String(init?.body))), { status: 200 })) as typeof fetch;
    const trace = await requestBnbLpRangeQuote(request, { fetchImpl, now });
    expect(trace.states.identity).toBe("FROZEN_REGISTRY_OWNER_SIGNATURE_MATCHED");
    expect(trace.states.selection).toBe("NOT_ELIGIBLE_YET");
    expect(trace.authenticatedQuote.price).toBe("100000000000000000");
    expect(verifyMessageMock).toHaveBeenCalledWith(
      trace.authenticatedQuote.negotiation_hash,
      trace.authenticatedQuote.provider_sig,
    );
  });

  it("rejects a quote that changes the frozen quality terms", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const response = responseFor(String(init?.body)) as any;
      response.result.parts[0].data.response.terms.quality_standards = "trust us";
      return new Response(JSON.stringify(response), { status: 200 });
    }) as typeof fetch;
    await expect(requestBnbLpRangeQuote(request, { fetchImpl, now })).rejects.toThrow("changed the frozen job or quality terms");
  });

  it("rejects a response whose signed-content hash does not match its fields", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const response = responseFor(String(init?.body)) as any;
      response.result.parts[0].data.response.terms.price = "1";
      return new Response(JSON.stringify(response), { status: 200 });
    }) as typeof fetch;
    await expect(requestBnbLpRangeQuote(request, { fetchImpl, now })).rejects.toThrow("response_hash does not match");
  });

  it("rejects a signature that does not recover the frozen ERC-8004 owner", async () => {
    verifyMessageMock.mockReturnValue("0x0000000000000000000000000000000000000001");
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      new Response(JSON.stringify(responseFor(String(init?.body))), { status: 200 })) as typeof fetch;
    await expect(requestBnbLpRangeQuote(request, { fetchImpl, now })).rejects.toThrow("does not match the frozen ERC-8004 owner");
  });

  it("rejects a quote above the frozen 0.1 U maximum", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const response = responseFor(String(init?.body)) as any;
      response.result.parts[0].data.response.terms.price = "100000000000000001";
      rehash(response.result.parts[0].data);
      return new Response(JSON.stringify(response), { status: 200 });
    }) as typeof fetch;
    await expect(requestBnbLpRangeQuote(request, { fetchImpl, now })).rejects.toThrow("exceeds the frozen maximum price");
  });

  it("rejects a signed quote for an already-expired PositionCrew request", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      new Response(JSON.stringify(responseFor(String(init?.body))), { status: 200 })) as typeof fetch;
    const afterDeadline = new Date("2026-09-03T14:35:37.000Z");
    await expect(requestBnbLpRangeQuote(request, { fetchImpl, now: afterDeadline })).rejects.toThrow("REFUSED_EXPIRED");
  });

  it("rejects a mainnet provider quote for a testnet request", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      new Response(JSON.stringify(responseFor(String(init?.body))), { status: 200 })) as typeof fetch;
    await expect(requestBnbLpRangeQuote({ ...request, chainId: 97 }, { fetchImpl, now })).rejects.toThrow(
      "request chain does not match",
    );
  });

  it("does not expose unsigned response fields as authenticated quote terms", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const response = responseFor(String(init?.body)) as any;
      response.result.parts[0].data.response.estimated_completion_seconds = 86_400;
      response.result.parts[0].data.response.terms.unsigned_extension = "not-owner-authenticated";
      rehash(response.result.parts[0].data);
      return new Response(JSON.stringify(response), { status: 200 });
    }) as typeof fetch;
    const trace = await requestBnbLpRangeQuote(request, { fetchImpl, now });
    expect(trace.authenticatedQuote).not.toHaveProperty("estimated_completion_seconds");
    expect(trace.authenticatedQuote.terms).not.toHaveProperty("unsigned_extension");
    expect(trace.protocolIntegrity.boundary).toContain("not covered by the provider owner signature");
  });

  it("exposes the normalized strings covered by the owner signature", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const response = responseFor(String(init?.body)) as any;
      response.result.parts[0].data.request.task_description = response.result.parts[0].data.request.task_description.replace(
        "PositionCrew",
        "PositionCrew[exact]",
      );
      response.result.parts[0].data.response.terms.success_criteria = ["Return [bounded] output"];
      rehash(response.result.parts[0].data);
      return new Response(JSON.stringify(response), { status: 200 });
    }) as typeof fetch;
    await expect(requestBnbLpRangeQuote(request, { fetchImpl, now })).rejects.toThrow("changed the frozen job");

    const normalFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const response = responseFor(String(init?.body)) as any;
      response.result.parts[0].data.response.terms.success_criteria = ["Return [bounded] output"];
      rehash(response.result.parts[0].data);
      return new Response(JSON.stringify(response), { status: 200 });
    }) as typeof fetch;
    const trace = await requestBnbLpRangeQuote(request, { fetchImpl: normalFetch, now });
    expect((trace.authenticatedQuote.terms as Record<string, unknown>).success_criteria).toEqual([
      "Return (bounded) output",
    ]);
    expect(String(trace.authenticatedQuote.task)).not.toContain("[");
  });

  it("rejects a stale frozen source even when the market observation is fresh", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      new Response(JSON.stringify(responseFor(String(init?.body))), { status: 200 })) as typeof fetch;
    const staleSourceRequest: LpRebalanceRequest = {
      ...request,
      sources: [
        ...request.sources,
        {
          sourceId: "stale-extra-source",
          label: "Stale supplemental evidence",
          uri: "https://bscscan.com/block/119743000",
          observedAt: "2026-09-03T14:30:00.000Z",
        },
      ],
    };
    await expect(requestBnbLpRangeQuote(staleSourceRequest, { fetchImpl, now })).rejects.toThrow(
      "REFUSED_STALE_DATA",
    );
  });
});
