import { z } from "zod";
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";

import type {
  YieldOptimizationDeliverable,
  YieldOptimizationRequest,
} from "../contracts/yield-optimization.js";
import { createYieldOptimizationDeliverable } from "../providers/yield-optimization.js";
import { annualizedYieldBps } from "../telemetry/bsc.js";

export const AIKI_VENUS_YIELD = {
  name: "AiKi Venus Yield Optimiser",
  erc8004TokenId: "315946",
  endpoint: "https://www.useaiki.xyz/v1/reference/yield/agent/315946",
} as const;

const AiKiYieldResponseSchema = z.object({
  assessment: z.object({
    category: z.literal("yield_optimisation"),
    assessmentVersion: z.string().min(1),
    routes: z.array(z.object({
      market: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      symbol: z.string().min(1),
      supplyRatePerBlock: z.string().regex(/^\d+$/),
      simpleAnnualRateBps: z.string().regex(/^\d+$/),
    }).strict()).min(1),
    recommendedMarket: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    recommendation: z.literal("RATE_ONLY_CANDIDATE"),
    observedAt: z.string().datetime(),
    caveats: z.array(z.string().min(1)).min(1),
  }).strict(),
  evidence: z.object({ persisted: z.literal(true) }).strict(),
}).strict();

const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.number(),
  result: z.string().regex(/^0x[0-9a-fA-F]+$/),
}).strict();
const JsonRpcBlockResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.number(),
  result: z.object({
    number: z.string().regex(/^0x[0-9a-fA-F]+$/),
    timestamp: z.string().regex(/^0x[0-9a-fA-F]+$/),
  }).passthrough(),
}).strict();

const VTOKEN_ABI = parseAbi(["function supplyRatePerBlock() view returns (uint256)"]);
const DEFAULT_BSC_RPC = "https://bsc-dataseed.binance.org";

export type AiKiYieldComparison = {
  provider: typeof AIKI_VENUS_YIELD;
  evaluatedAt: string;
  outcome: "SEMANTICALLY_COMPARABLE" | "PARTIAL_COMPATIBILITY" | "INCOMPATIBLE" | "UNAVAILABLE";
  marketCount: number;
  positionCrewSelectedMarket: string | null;
  externalRecommendedMarket: string | null;
  sameRateLeader: boolean;
  positionCrewGrossApyBps: number | null;
  externalSimpleAnnualRateBps: number | null;
  rateDifferenceBps: number | null;
  attributable: boolean;
  persisted: boolean;
  exactRequestAccepted: false;
  eligibleForRateRankingActivation: boolean;
  eligibleForYieldSelection: boolean;
  eligibleForLiveMatch: boolean;
  adapterNormalized?: boolean;
  normalizedDeliverable?: YieldOptimizationDeliverable;
  selection?: {
    selectedProvider: "POSITIONCREW" | "EXTERNAL";
    externalEligible: boolean;
    basis: string;
  };
  checks: Array<{ code: string; status: "PASS" | "FAIL"; detail: string }>;
  boundary: string;
};

function pinnedBlock(request: YieldOptimizationRequest): bigint {
  const match = /\/block\/([1-9]\d*)$/.exec(request.sources[0]?.uri ?? "");
  if (!match) throw new Error("Yield request source does not identify a pinned BSC block");
  return BigInt(match[1]!);
}

async function readPinnedSupplyState(
  request: YieldOptimizationRequest,
  fetchImpl: typeof fetch,
  rpcUrl: string,
): Promise<{ rates: Map<string, bigint>; secondsPerBlock: number }> {
  const blockNumber = pinnedBlock(request);
  const priorBlockNumber = blockNumber > 120n ? blockNumber - 120n : 0n;
  const blockTag = `0x${blockNumber.toString(16)}`;
  const data = encodeFunctionData({ abi: VTOKEN_ABI, functionName: "supplyRatePerBlock" });
  const markets = [...new Map(
    [...request.currentPositions, ...request.opportunities].map((position) =>
      [position.vaultOrMarket.toLowerCase(), position.vaultOrMarket] as const
    ),
  ).values()];
  const rateEntriesPromise = Promise.all(markets.map(async (market, index) => {
    const response = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: index + 1,
        method: "eth_call",
        params: [{ to: market, data }, blockTag],
      }),
      signal: AbortSignal.timeout(2_500),
    });
    if (!response.ok) throw new Error(`Pinned Venus rate query returned HTTP ${response.status}`);
    const payload = JsonRpcResponseSchema.parse(await response.json());
    const rate = decodeFunctionResult({
      abi: VTOKEN_ABI,
      functionName: "supplyRatePerBlock",
      data: payload.result as `0x${string}`,
    });
    return [market.toLowerCase(), rate] as const;
  }));
  const readBlock = async (number: bigint, id: number) => {
    const response = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "eth_getBlockByNumber",
        params: [`0x${number.toString(16)}`, false],
      }),
      signal: AbortSignal.timeout(2_500),
    });
    if (!response.ok) throw new Error(`Pinned BSC block query returned HTTP ${response.status}`);
    return JsonRpcBlockResponseSchema.parse(await response.json()).result;
  };
  const [entries, block, priorBlock] = await Promise.all([
    rateEntriesPromise,
    readBlock(blockNumber, 10_001),
    readBlock(priorBlockNumber, 10_002),
  ]);
  const secondsPerBlock = Math.max(
    0.1,
    Number(BigInt(block.timestamp) - BigInt(priorBlock.timestamp)) / 120,
  );
  return { rates: new Map(entries), secondsPerBlock };
}

export async function auditionAiKiVenusYield(
  request: YieldOptimizationRequest,
  firstParty: YieldOptimizationDeliverable,
  options: { fetchImpl?: typeof fetch; now?: Date; rpcUrl?: string } = {},
): Promise<AiKiYieldComparison> {
  const now = options.now ?? new Date();
  const fetchImpl = options.fetchImpl ?? fetch;
  const frozenRateLeader = request.opportunities.reduce((leader, candidate) => {
    if (candidate.grossApyBps > leader.grossApyBps) return candidate;
    if (
      candidate.grossApyBps === leader.grossApyBps &&
      candidate.opportunityId.localeCompare(leader.opportunityId) < 0
    ) return candidate;
    return leader;
  });
  const base = {
    provider: AIKI_VENUS_YIELD,
    evaluatedAt: now.toISOString(),
    marketCount: request.opportunities.length,
    positionCrewSelectedMarket: frozenRateLeader.vaultOrMarket,
    positionCrewGrossApyBps: frozenRateLeader.grossApyBps,
    exactRequestAccepted: false as const,
    eligibleForRateRankingActivation: false,
    eligibleForYieldSelection: false,
    eligibleForLiveMatch: false,
  };
  const partialBoundary = "AiKi ranked live Venus supply rates for the same market set. PositionCrew independently binds those rates to the request's pinned block and applies liquidity, risk, cost, concentration, expiry, and horizon constraints through a disclosed compatibility adapter.";

  try {
    const markets = request.opportunities.map((candidate) => candidate.vaultOrMarket);
    const url = new URL(AIKI_VENUS_YIELD.endpoint);
    url.searchParams.set("markets", markets.join(","));
    url.searchParams.set("rateOnly", "true");
    const [response, pinnedState] = await Promise.all([
      fetchImpl(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(2_500),
      }),
      readPinnedSupplyState(request, fetchImpl, options.rpcUrl ?? DEFAULT_BSC_RPC),
    ]);
    if (!response.ok) throw new Error(`AiKi Yield returned HTTP ${response.status}`);
    const parsed = AiKiYieldResponseSchema.parse(await response.json());
    const requestedMarkets = new Set(markets.map((market) => market.toLowerCase()));
    const returnedMarkets = new Set(parsed.assessment.routes.map((route) => route.market.toLowerCase()));
    const exactMarketSet = requestedMarkets.size === returnedMarkets.size && [...requestedMarkets].every((market) => returnedMarkets.has(market));
    const sameRateLeader = frozenRateLeader.vaultOrMarket.toLowerCase() === parsed.assessment.recommendedMarket.toLowerCase();
    const externalRoute = parsed.assessment.routes.find((route) => route.market.toLowerCase() === parsed.assessment.recommendedMarket.toLowerCase());
    const externalRate = externalRoute ? Number(externalRoute.simpleAnnualRateBps) : null;
    const localRate = frozenRateLeader.grossApyBps;
    const mismatchedRateMarkets = parsed.assessment.routes.filter((route) =>
      pinnedState.rates.get(route.market.toLowerCase()) !== BigInt(route.supplyRatePerBlock)
    );
    const pinnedRateBinding = exactMarketSet && mismatchedRateMarkets.length === 0;
    const pinnedApyByMarket = new Map([...pinnedState.rates].map(([market, rate]) =>
      [market, annualizedYieldBps(rate, pinnedState.secondsPerBlock)] as const
    ));
    const requestApyBinding = [...request.currentPositions, ...request.opportunities].every((position) =>
      pinnedApyByMarket.get(position.vaultOrMarket.toLowerCase()) === position.grossApyBps
    );
    const pinnedRateLeader = request.opportunities.reduce((leader, candidate) => {
      const leaderRate = pinnedState.rates.get(leader.vaultOrMarket.toLowerCase()) ?? -1n;
      const candidateRate = pinnedState.rates.get(candidate.vaultOrMarket.toLowerCase()) ?? -1n;
      if (candidateRate > leaderRate) return candidate;
      if (candidateRate === leaderRate && candidate.opportunityId.localeCompare(leader.opportunityId) < 0) {
        return candidate;
      }
      return leader;
    });
    const samePinnedRateLeader =
      pinnedRateLeader.vaultOrMarket.toLowerCase() === parsed.assessment.recommendedMarket.toLowerCase();
    const observedAtMs = Date.parse(parsed.assessment.observedAt);
    const observationFresh = Number.isFinite(observedAtMs) &&
      observedAtMs <= now.getTime() + 30_000 &&
      now.getTime() - observedAtMs <= request.maxDataAgeSeconds * 1_000;
    const recommendedOpportunity = request.opportunities.find((opportunity) =>
      opportunity.vaultOrMarket.toLowerCase() === parsed.assessment.recommendedMarket.toLowerCase()
    );
    const normalizedCurrentPositions = request.currentPositions.map((position) => ({
      ...position,
      grossApyBps: pinnedApyByMarket.get(position.vaultOrMarket.toLowerCase()) ?? position.grossApyBps,
    }));
    const normalizedOpportunity = recommendedOpportunity
      ? {
          ...recommendedOpportunity,
          grossApyBps: pinnedApyByMarket.get(recommendedOpportunity.vaultOrMarket.toLowerCase()) ??
            recommendedOpportunity.grossApyBps,
        }
      : undefined;
    const normalizedDeliverable = normalizedOpportunity
      ? createYieldOptimizationDeliverable({
          ...request,
          currentPositions: normalizedCurrentPositions,
          opportunities: [normalizedOpportunity],
        }, now)
      : undefined;
    const normalizedContractPass = normalizedDeliverable !== undefined &&
      !normalizedDeliverable.status.startsWith("REFUSED_");
    const eligible = exactMarketSet && pinnedRateBinding && requestApyBinding && sameRateLeader && samePinnedRateLeader && observationFresh &&
      parsed.evidence.persisted && normalizedContractPass;
    const checks: AiKiYieldComparison["checks"] = [
      { code: "EXACT_MARKET_SET", status: exactMarketSet ? "PASS" : "FAIL", detail: exactMarketSet ? "AiKi evaluated the same frozen Venus market set." : "AiKi returned a different market set." },
      { code: "PINNED_RATE_BINDING", status: pinnedRateBinding ? "PASS" : "FAIL", detail: pinnedRateBinding ? "Every provider per-block rate matches an independent Venus read at the request's pinned BSC block." : !exactMarketSet ? "The provider did not return the exact requested market set, so complete pinned-rate agreement cannot be established." : `${mismatchedRateMarkets.length} of ${parsed.assessment.routes.length} provider rates differ from the saved BSC block. Agreement on the best market does not establish agreement on this exact snapshot.` },
      { code: "PINNED_APY_BINDING", status: requestApyBinding ? "PASS" : "FAIL", detail: requestApyBinding ? "Every request APY matches the independently pinned rate annualized with measured BSC block time." : "At least one caller-supplied APY does not match independently annualized pinned state." },
      { code: "SAME_RATE_LEADER", status: sameRateLeader ? "PASS" : "FAIL", detail: sameRateLeader ? "Both providers identified the same highest-rate market." : "The providers identified different rate leaders." },
      { code: "PINNED_RATE_LEADER", status: samePinnedRateLeader ? "PASS" : "FAIL", detail: samePinnedRateLeader ? "The provider recommendation is also the highest-rate market in the independently pinned on-chain state." : "The provider recommendation is not the rate leader in the independently pinned on-chain state." },
      { code: "OBSERVATION_FRESHNESS", status: observationFresh ? "PASS" : "FAIL", detail: observationFresh ? "The provider observation is inside the buyer's freshness window." : "The provider observation is stale or future-dated." },
      { code: "PERSISTED_RESULT", status: parsed.evidence.persisted ? "PASS" : "FAIL", detail: "AiKi marked this assessment as persisted." },
      { code: "BUYER_CONSTRAINT_EVALUATION", status: normalizedContractPass ? "PASS" : "FAIL", detail: normalizedContractPass ? "PositionCrew evaluated the provider's attributable market thesis against the unchanged liquidity, risk, cost, concentration, expiry, and horizon limits." : "The provider thesis could not produce a schema-valid bounded decision under the buyer's request." },
      { code: "EXACT_OUTPUT_CONTRACT", status: normalizedContractPass ? "PASS" : "FAIL", detail: normalizedContractPass ? "The disclosed adapter normalized the provider thesis into positioncrew.yield-optimization.deliverable.v1." : "No valid normalized Yield deliverable is available." },
    ];
    const rateRankingCompatible = exactMarketSet && sameRateLeader && parsed.evidence.persisted;
    return {
      ...base,
      outcome: eligible ? "SEMANTICALLY_COMPARABLE" : rateRankingCompatible ? "PARTIAL_COMPATIBILITY" : "INCOMPATIBLE",
      eligibleForRateRankingActivation: rateRankingCompatible,
      eligibleForYieldSelection: eligible,
      eligibleForLiveMatch: eligible,
      adapterNormalized: normalizedDeliverable !== undefined,
      ...(normalizedDeliverable ? { normalizedDeliverable } : {}),
      selection: {
        selectedProvider: "POSITIONCREW",
        externalEligible: eligible,
        basis: eligible
          ? "The first-party provider won the native exact-contract tiebreak; the external rate thesis remains attributable and fully evaluated."
          : "The external rate thesis failed at least one pinned-state, freshness, or buyer-constraint check.",
      },
      externalRecommendedMarket: parsed.assessment.recommendedMarket,
      sameRateLeader,
      externalSimpleAnnualRateBps: externalRate,
      rateDifferenceBps: localRate === null || externalRate === null ? null : Math.abs(localRate - externalRate),
      attributable: exactMarketSet,
      persisted: parsed.evidence.persisted,
      checks,
      boundary: `${partialBoundary} AiKi did not directly accept the native PositionCrew request; no payment, authority grant, supply, withdrawal, or protocol transaction occurred.`,
    };
  } catch (error) {
    return {
      ...base,
      outcome: "UNAVAILABLE",
      eligibleForRateRankingActivation: false,
      externalRecommendedMarket: null,
      sameRateLeader: false,
      externalSimpleAnnualRateBps: null,
      rateDifferenceBps: null,
      attributable: false,
      persisted: false,
      checks: [{ code: "CALLABLE_RESULT", status: "FAIL", detail: error instanceof Error ? error.message : "AiKi Yield was unavailable." }],
      boundary: `${partialBoundary} The external provider was unavailable, so no external result or selection claim is made.`,
    };
  }
}
