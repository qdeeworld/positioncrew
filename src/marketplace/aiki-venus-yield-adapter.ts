import { z } from "zod";
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";

import type {
  YieldOptimizationDeliverable,
  YieldOptimizationRequest,
} from "../contracts/yield-optimization.js";
import { createYieldOptimizationDeliverable } from "../providers/yield-optimization.js";
import { annualizedYieldBps } from "../telemetry/bsc.js";
import {
  assertYieldRateObservationRequestBinding,
  type VerifiedYieldRateObservation,
} from "../commerce/server-observation-binding.js";

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

class YieldComparisonUnavailable extends Error {
  constructor(
    readonly code: "PINNED_STATE_UNAVAILABLE" | "EXTERNAL_ASSESSMENT_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "YieldComparisonUnavailable";
  }
}

function hasErrorEnvelope(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && "error" in value;
}

async function readPinnedRpcResponse<T>(
  fetchImpl: typeof fetch,
  rpcUrl: string,
  body: Record<string, unknown>,
  schema: z.ZodType<T>,
  blockNumber: bigint,
): Promise<T> {
  const context = `PositionCrew could not independently verify Venus data at BSC block ${blockNumber}`;
  try {
    const response = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2_500),
    });
    if (!response.ok) {
      throw new YieldComparisonUnavailable(
        "PINNED_STATE_UNAVAILABLE",
        `${context}: the verification endpoint returned HTTP ${response.status}. Reload current markets before retrying.`,
      );
    }
    const payload: unknown = await response.json();
    if (hasErrorEnvelope(payload)) {
      const error = payload.error;
      const code = error !== null && typeof error === "object" && "code" in error &&
        typeof error.code === "number" && Number.isSafeInteger(error.code)
        ? ` (RPC ${error.code})`
        : "";
      throw new YieldComparisonUnavailable(
        "PINNED_STATE_UNAVAILABLE",
        `${context}: the verification endpoint rejected the read${code}. Reload current markets before retrying.`,
      );
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new YieldComparisonUnavailable(
        "PINNED_STATE_UNAVAILABLE",
        `${context}: the verification endpoint returned incomplete or unsupported evidence. Reload current markets before retrying.`,
      );
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof YieldComparisonUnavailable) throw error;
    throw new YieldComparisonUnavailable(
      "PINNED_STATE_UNAVAILABLE",
      `${context}: its verification request did not complete with usable evidence. Reload current markets before retrying.`,
    );
  }
}

async function readAiKiYieldAssessment(
  url: URL,
  fetchImpl: typeof fetch,
): Promise<z.infer<typeof AiKiYieldResponseSchema>> {
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(2_500),
    });
    if (!response.ok) {
      throw new YieldComparisonUnavailable(
        "EXTERNAL_ASSESSMENT_UNAVAILABLE",
        `AiKi's yield assessment endpoint returned HTTP ${response.status}. No comparable external result was admitted.`,
      );
    }
    const payload: unknown = await response.json();
    if (hasErrorEnvelope(payload)) {
      throw new YieldComparisonUnavailable(
        "EXTERNAL_ASSESSMENT_UNAVAILABLE",
        "AiKi reported that its yield assessment could not be completed. Reload current markets before retrying.",
      );
    }
    const parsed = AiKiYieldResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new YieldComparisonUnavailable(
        "EXTERNAL_ASSESSMENT_UNAVAILABLE",
        "AiKi returned an incomplete or unsupported yield assessment. No comparable external result was admitted.",
      );
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof YieldComparisonUnavailable) throw error;
    throw new YieldComparisonUnavailable(
      "EXTERNAL_ASSESSMENT_UNAVAILABLE",
      "AiKi's yield assessment did not complete with a usable response within the comparison attempt. Reload current markets before retrying.",
    );
  }
}

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
): Promise<{ rates: Map<string, bigint>; secondsPerBlock: number; apyByMarket: Map<string, number> }> {
  try {
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
      const payload = await readPinnedRpcResponse(
        fetchImpl,
        rpcUrl,
        {
          jsonrpc: "2.0",
          id: index + 1,
          method: "eth_call",
          params: [{ to: market, data }, blockTag],
        },
        JsonRpcResponseSchema,
        blockNumber,
      );
      const rate = decodeFunctionResult({
        abi: VTOKEN_ABI,
        functionName: "supplyRatePerBlock",
        data: payload.result as `0x${string}`,
      });
      return [market.toLowerCase(), rate] as const;
    }));
    const readBlock = async (number: bigint, id: number) => {
      const payload = await readPinnedRpcResponse(
        fetchImpl,
        rpcUrl,
        {
          jsonrpc: "2.0",
          id,
          method: "eth_getBlockByNumber",
          params: [`0x${number.toString(16)}`, false],
        },
        JsonRpcBlockResponseSchema,
        number,
      );
      return payload.result;
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
    const apyByMarket = new Map(entries.map(([market, rate]) =>
      [market, annualizedYieldBps(rate, secondsPerBlock)] as const
    ));
    return { rates: new Map(entries), secondsPerBlock, apyByMarket };
  } catch (error) {
    if (error instanceof YieldComparisonUnavailable) throw error;
    throw new YieldComparisonUnavailable(
      "PINNED_STATE_UNAVAILABLE",
      "PositionCrew could not independently verify the request's pinned Venus state: supply-rate decoding or annualization did not produce usable evidence. Reload current markets before retrying.",
    );
  }
}

function readAuthenticatedSupplyState(
  request: YieldOptimizationRequest,
  observation: VerifiedYieldRateObservation,
  now: Date,
): Awaited<ReturnType<typeof readPinnedSupplyState>> {
  try {
    assertYieldRateObservationRequestBinding(observation, request, now);
    const secondsPerBlock = Math.max(0.1,
      (Date.parse(observation.observedBlock.observedAt) - Date.parse(observation.baselineBlock.observedAt)) / 1000 / 120);
    const rates = new Map(observation.marketRates.map((market) =>
      [market.market.toLowerCase(), BigInt(market.supplyRatePerBlock)] as const));
    return { rates, secondsPerBlock, apyByMarket: new Map([...rates].map(([market, rate]) =>
      [market, annualizedYieldBps(rate, secondsPerBlock)] as const)) };
  } catch {
    throw new YieldComparisonUnavailable("PINNED_STATE_UNAVAILABLE",
      "PositionCrew could not authenticate a still-valid captured Venus observation for this request. Reload current markets before retrying.");
  }
}

export async function auditionAiKiVenusYield(
  request: YieldOptimizationRequest,
  firstParty: YieldOptimizationDeliverable,
  options: {
    fetchImpl?: typeof fetch;
    now?: Date;
    rpcUrl?: string;
    verifiedYieldRateObservation?: VerifiedYieldRateObservation;
    completionNow?: () => Date;
  } = {},
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
  const firstPartySelectedOpportunity = firstParty.status === "ACTIONABLE"
    ? request.opportunities.find((opportunity) =>
        opportunity.opportunityId === firstParty.selectedOpportunityId
      )
    : undefined;
  const firstPartySelectedApyBps = firstPartySelectedOpportunity?.grossApyBps ?? null;
  const base = {
    provider: AIKI_VENUS_YIELD,
    evaluatedAt: now.toISOString(),
    marketCount: request.opportunities.length,
    positionCrewSelectedMarket: firstPartySelectedOpportunity?.vaultOrMarket ?? null,
    positionCrewGrossApyBps: firstPartySelectedApyBps,
    exactRequestAccepted: false as const,
    eligibleForRateRankingActivation: false,
    eligibleForYieldSelection: false,
    eligibleForLiveMatch: false,
  };
  const partialBoundary = "AiKi ranked live Venus supply rates for the same market set. PositionCrew independently binds those rates to the request's pinned block and applies the unchanged allocation and withdrawal principal caps, execution cost and gas caps, liquidity, risk, concentration, expiry, and horizon constraints through a disclosed compatibility adapter.";

  try {
    const started = performance.now();
    const captured = options.verifiedYieldRateObservation;
    // Authenticate before invoking a provider. Loose or replayed caller caches
    // cannot replace independent server evidence, even when their APYs match.
    const capturedState = captured ? readAuthenticatedSupplyState(request, captured, now) : undefined;
    const markets = request.opportunities.map((candidate) => candidate.vaultOrMarket);
    const url = new URL(AIKI_VENUS_YIELD.endpoint);
    url.searchParams.set("markets", markets.join(","));
    url.searchParams.set("rateOnly", "true");
    const [parsed, pinnedState] = await Promise.all([
      readAiKiYieldAssessment(url, fetchImpl),
      capturedState ?? readPinnedSupplyState(request, fetchImpl, options.rpcUrl ?? DEFAULT_BSC_RPC),
    ]);
    if (captured) {
      readAuthenticatedSupplyState(request, captured, options.completionNow?.() ??
        new Date(now.getTime() + Math.max(0, performance.now() - started)));
    }
    const requestedMarkets = new Set(markets.map((market) => market.toLowerCase()));
    const returnedMarkets = new Set(parsed.assessment.routes.map((route) => route.market.toLowerCase()));
    const exactMarketSet = requestedMarkets.size === returnedMarkets.size && [...requestedMarkets].every((market) => returnedMarkets.has(market));
    const sameRateLeader = frozenRateLeader.vaultOrMarket.toLowerCase() === parsed.assessment.recommendedMarket.toLowerCase();
    const externalRoute = parsed.assessment.routes.find((route) => route.market.toLowerCase() === parsed.assessment.recommendedMarket.toLowerCase());
    const externalRate = externalRoute ? Number(externalRoute.simpleAnnualRateBps) : null;
    const mismatchedRateMarkets = parsed.assessment.routes.filter((route) =>
      pinnedState.rates.get(route.market.toLowerCase()) !== BigInt(route.supplyRatePerBlock)
    );
    const pinnedRateBinding = exactMarketSet && mismatchedRateMarkets.length === 0;
    const pinnedApyByMarket = pinnedState.apyByMarket;
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
      { code: "PINNED_RATE_BINDING", status: pinnedRateBinding ? "PASS" : "FAIL", detail: pinnedRateBinding ? (captured ? "Every provider per-block rate matches server-authenticated Venus reads retained from the request's pinned BSC block; historical RPC state was not re-fetched." : "Every provider per-block rate matches an independent Venus read at the request's pinned BSC block.") : !exactMarketSet ? "The provider did not return the exact requested market set, so complete pinned-rate agreement cannot be established." : `${mismatchedRateMarkets.length} of ${parsed.assessment.routes.length} provider rates differ from the saved BSC block. Agreement on the best market does not establish agreement on this exact snapshot.` },
      { code: "PINNED_APY_BINDING", status: requestApyBinding ? "PASS" : "FAIL", detail: requestApyBinding ? "Every request APY matches the independently pinned rate annualized with measured BSC block time." : "At least one caller-supplied APY does not match independently annualized pinned state." },
      { code: "SAME_RATE_LEADER", status: sameRateLeader ? "PASS" : "FAIL", detail: sameRateLeader ? "AiKi identified the highest-rate opportunity in the frozen request." : "AiKi's recommended market differs from the frozen request's highest-rate opportunity." },
      { code: "PINNED_RATE_LEADER", status: samePinnedRateLeader ? "PASS" : "FAIL", detail: samePinnedRateLeader ? "The provider recommendation is also the highest-rate market in the independently pinned on-chain state." : "The provider recommendation is not the rate leader in the independently pinned on-chain state." },
      { code: "OBSERVATION_FRESHNESS", status: observationFresh ? "PASS" : "FAIL", detail: observationFresh ? "The provider observation is inside the buyer's freshness window." : "The provider observation is stale or future-dated." },
      { code: "PERSISTED_RESULT", status: parsed.evidence.persisted ? "PASS" : "FAIL", detail: "AiKi marked this assessment as persisted." },
      { code: "BUYER_CONSTRAINT_EVALUATION", status: normalizedContractPass ? "PASS" : "FAIL", detail: normalizedContractPass ? "PositionCrew evaluated the provider's attributable market thesis against the unchanged allocation and withdrawal principal caps, execution cost and gas caps, liquidity, risk, concentration, expiry, and horizon limits." : "The provider thesis could not produce a schema-valid bounded decision under the buyer's request." },
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
          ? "PositionCrew remains selected; the external rate thesis passed the recorded compatibility checks."
          : "PositionCrew remains selected; the external rate thesis failed at least one recorded compatibility check.",
      },
      externalRecommendedMarket: parsed.assessment.recommendedMarket,
      sameRateLeader,
      externalSimpleAnnualRateBps: externalRate,
      rateDifferenceBps: firstPartySelectedApyBps === null || externalRate === null ? null : Math.abs(firstPartySelectedApyBps - externalRate),
      attributable: exactMarketSet,
      persisted: parsed.evidence.persisted,
      checks,
      boundary: `${partialBoundary} ${captured ? "Pinned state was authenticated from the original server capture, not a new execution-time RPC read or a trustless state proof. " : ""}AiKi did not directly accept the native PositionCrew request; no payment, authority grant, supply, withdrawal, or protocol transaction occurred.`,
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
      checks: [{
        code: error instanceof YieldComparisonUnavailable ? error.code : "CALLABLE_RESULT",
        status: "FAIL",
        detail: error instanceof YieldComparisonUnavailable
          ? error.message
          : "The external yield comparison could not be completed safely. Reload current markets before retrying.",
      }],
      boundary: "This comparison requires AiKi's rate-only assessment and PositionCrew's independent verification of the same BSC snapshot. " +
        (error instanceof YieldComparisonUnavailable && error.code === "PINNED_STATE_UNAVAILABLE"
          ? "PositionCrew's independent verification was unavailable; this does not establish that AiKi was offline. "
          : "A verified external assessment was not available. ") +
        "No admitted external result, provider selection, payment, authority grant, supply, withdrawal, or protocol transaction is claimed.",
    };
  }
}
