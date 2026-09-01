import { z } from "zod";

import type {
  YieldOptimizationDeliverable,
  YieldOptimizationRequest,
} from "../contracts/yield-optimization.js";

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

export type AiKiYieldComparison = {
  provider: typeof AIKI_VENUS_YIELD;
  evaluatedAt: string;
  outcome: "PARTIAL_COMPATIBILITY" | "INCOMPATIBLE" | "UNAVAILABLE";
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
  eligibleForYieldSelection: false;
  eligibleForLiveMatch: false;
  checks: Array<{ code: string; status: "PASS" | "FAIL"; detail: string }>;
  boundary: string;
};

export async function auditionAiKiVenusYield(
  request: YieldOptimizationRequest,
  firstParty: YieldOptimizationDeliverable,
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<AiKiYieldComparison> {
  const now = options.now ?? new Date();
  const selected = request.opportunities.find((candidate) => candidate.opportunityId === firstParty.selectedOpportunityId);
  const base = {
    provider: AIKI_VENUS_YIELD,
    evaluatedAt: now.toISOString(),
    marketCount: request.opportunities.length,
    positionCrewSelectedMarket: selected?.vaultOrMarket ?? null,
    positionCrewGrossApyBps: firstParty.grossApyBps ?? null,
    exactRequestAccepted: false as const,
    eligibleForRateRankingActivation: false,
    eligibleForYieldSelection: false as const,
    eligibleForLiveMatch: false as const,
  };
  const boundary = "AiKi ranked live Venus supply rates for the same market set. It explicitly did not evaluate liquidity, depeg and protocol risk, gas, withdrawal conditions, horizon benefit, or the complete PositionCrew optimisation contract.";

  try {
    const markets = request.opportunities.map((candidate) => candidate.vaultOrMarket);
    const url = new URL(AIKI_VENUS_YIELD.endpoint);
    url.searchParams.set("markets", markets.join(","));
    url.searchParams.set("rateOnly", "true");
    const response = await (options.fetchImpl ?? fetch)(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(2_500),
    });
    if (!response.ok) throw new Error(`AiKi Yield returned HTTP ${response.status}`);
    const parsed = AiKiYieldResponseSchema.parse(await response.json());
    const requestedMarkets = new Set(markets.map((market) => market.toLowerCase()));
    const returnedMarkets = new Set(parsed.assessment.routes.map((route) => route.market.toLowerCase()));
    const exactMarketSet = requestedMarkets.size === returnedMarkets.size && [...requestedMarkets].every((market) => returnedMarkets.has(market));
    const sameRateLeader = selected?.vaultOrMarket.toLowerCase() === parsed.assessment.recommendedMarket.toLowerCase();
    const externalRoute = parsed.assessment.routes.find((route) => route.market.toLowerCase() === parsed.assessment.recommendedMarket.toLowerCase());
    const externalRate = externalRoute ? Number(externalRoute.simpleAnnualRateBps) : null;
    const localRate = firstParty.grossApyBps ?? null;
    const checks: AiKiYieldComparison["checks"] = [
      { code: "EXACT_MARKET_SET", status: exactMarketSet ? "PASS" : "FAIL", detail: exactMarketSet ? "AiKi evaluated the same frozen Venus market set." : "AiKi returned a different market set." },
      { code: "SAME_RATE_LEADER", status: sameRateLeader ? "PASS" : "FAIL", detail: sameRateLeader ? "Both providers identified the same highest-rate market." : "The providers identified different rate leaders." },
      { code: "PERSISTED_RESULT", status: parsed.evidence.persisted ? "PASS" : "FAIL", detail: "AiKi marked this assessment as persisted." },
      { code: "EXACT_JOB_CONTRACT", status: "FAIL" as const, detail: "AiKi labels its output rate-only and does not accept PositionCrew's risk, liquidity, cost, horizon, and allocation constraints." },
    ];
    const rateRankingCompatible = exactMarketSet && sameRateLeader && parsed.evidence.persisted;
    return {
      ...base,
      outcome: exactMarketSet && sameRateLeader ? "PARTIAL_COMPATIBILITY" : "INCOMPATIBLE",
      eligibleForRateRankingActivation: rateRankingCompatible,
      externalRecommendedMarket: parsed.assessment.recommendedMarket,
      sameRateLeader,
      externalSimpleAnnualRateBps: externalRate,
      rateDifferenceBps: localRate === null || externalRate === null ? null : Math.abs(localRate - externalRate),
      attributable: exactMarketSet,
      persisted: parsed.evidence.persisted,
      checks,
      boundary,
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
      boundary,
    };
  }
}
