import { z } from "zod";

import type {
  BoundedGridDeliverable,
  BoundedGridRequest,
} from "../contracts/bounded-grid.js";

export const AIKI_PANCAKE_GRID = {
  name: "AiKi PancakeSwap Grid Trader",
  erc8004TokenId: "315945",
  endpoint: "https://www.useaiki.xyz/v1/reference/pancake/grid/agent/315945",
} as const;

const AiKiGridResponseSchema = z.object({
  assessment: z.object({
    pool: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    tickLower: z.number().int(),
    tickUpper: z.number().int(),
    spacing: z.number().int().positive(),
    category: z.literal("grid_trading"),
    assessmentVersion: z.string().min(1),
    currentTick: z.number().int(),
    activeGridIndex: z.number().int().nonnegative(),
    activeBand: z.object({ lower: z.number().int(), upper: z.number().int() }).strict(),
    state: z.string().min(1),
    recommendation: z.string().min(1),
    poolLiquidity: z.string().regex(/^\d+$/),
    observedAt: z.string().datetime(),
    caveats: z.array(z.string().min(1)).min(1),
  }).strict(),
  evidence: z.object({ persisted: z.literal(true) }).strict(),
}).strict();

export type AiKiGridComparison = {
  provider: typeof AIKI_PANCAKE_GRID;
  evaluatedAt: string;
  outcome: "PARTIAL_COMPATIBILITY" | "INCOMPATIBLE" | "UNAVAILABLE";
  pool: string;
  positionCrewDecision: BoundedGridDeliverable["decision"];
  externalRecommendation: string | null;
  externalState: string | null;
  tickLower: number | null;
  tickUpper: number | null;
  exactRangeAccepted: boolean;
  attributable: boolean;
  persisted: boolean;
  exactRequestAccepted: false;
  eligibleForRangeAssessmentActivation: boolean;
  eligibleForGridSelection: false;
  eligibleForLiveMatch: false;
  checks: Array<{ code: string; status: "PASS" | "FAIL"; detail: string }>;
  boundary: string;
};

function priceToInverseTick(price: number): number {
  return Math.log(1 / price) / Math.log(1.0001);
}

export async function auditionAiKiPancakeGrid(
  request: BoundedGridRequest,
  firstParty: BoundedGridDeliverable,
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<AiKiGridComparison> {
  const now = options.now ?? new Date();
  const base = {
    provider: AIKI_PANCAKE_GRID,
    evaluatedAt: now.toISOString(),
    pool: request.venue,
    positionCrewDecision: firstParty.decision,
    exactRequestAccepted: false as const,
    eligibleForRangeAssessmentActivation: false,
    eligibleForGridSelection: false as const,
    eligibleForLiveMatch: false as const,
  };
  const boundary = "AiKi assessed the exact live pool and PositionCrew-derived tick range, but it did not accept the bounded-grid request, construct orders, price costs, enforce loss limits, or activate execution.";

  try {
    const lowerPrice = Number(request.constraints.lowerPrice);
    const upperPrice = Number(request.constraints.upperPrice);
    if (!Number.isFinite(lowerPrice) || !Number.isFinite(upperPrice) || lowerPrice <= 0 || upperPrice <= lowerPrice) {
      throw new Error("PositionCrew grid prices cannot be converted to a valid tick range");
    }
    // Round inward so the external range never exceeds PositionCrew's price bounds.
    const tickLower = Math.ceil(priceToInverseTick(upperPrice));
    const tickUpper = Math.floor(priceToInverseTick(lowerPrice));
    const url = new URL(AIKI_PANCAKE_GRID.endpoint);
    url.searchParams.set("pool", request.venue);
    url.searchParams.set("tickLower", String(tickLower));
    url.searchParams.set("tickUpper", String(tickUpper));
    url.searchParams.set("spacing", "1");

    const response = await (options.fetchImpl ?? fetch)(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(2_500),
    });
    if (!response.ok) throw new Error(`AiKi Grid returned HTTP ${response.status}`);
    const parsed = AiKiGridResponseSchema.parse(await response.json());
    const exactPool = parsed.assessment.pool.toLowerCase() === request.venue.toLowerCase();
    const exactRangeAccepted = parsed.assessment.tickLower === tickLower && parsed.assessment.tickUpper === tickUpper;
    const checks: AiKiGridComparison["checks"] = [
      { code: "EXACT_POOL", status: exactPool ? "PASS" : "FAIL", detail: exactPool ? "AiKi evaluated the exact PancakeSwap V3 pool." : "AiKi returned a different pool." },
      { code: "EXACT_RANGE", status: exactRangeAccepted ? "PASS" : "FAIL", detail: exactRangeAccepted ? "AiKi accepted the exact PositionCrew-derived tick range." : "AiKi did not preserve the submitted tick range." },
      { code: "PERSISTED_RESULT", status: parsed.evidence.persisted ? "PASS" : "FAIL", detail: "AiKi marked this assessment as persisted." },
      { code: "EXACT_JOB_CONTRACT", status: "FAIL" as const, detail: "AiKi assesses a caller-supplied range; it does not accept PositionCrew's bounded order, cost, loss, expiry, and execution contract." },
    ];
    const rangeAssessmentCompatible = exactPool && exactRangeAccepted && parsed.evidence.persisted;
    return {
      ...base,
      outcome: exactPool && exactRangeAccepted ? "PARTIAL_COMPATIBILITY" : "INCOMPATIBLE",
      eligibleForRangeAssessmentActivation: rangeAssessmentCompatible,
      externalRecommendation: parsed.assessment.recommendation,
      externalState: parsed.assessment.state,
      tickLower: parsed.assessment.tickLower,
      tickUpper: parsed.assessment.tickUpper,
      exactRangeAccepted,
      attributable: exactPool,
      persisted: parsed.evidence.persisted,
      checks,
      boundary,
    };
  } catch (error) {
    return {
      ...base,
      outcome: "UNAVAILABLE",
      eligibleForRangeAssessmentActivation: false,
      externalRecommendation: null,
      externalState: null,
      tickLower: null,
      tickUpper: null,
      exactRangeAccepted: false,
      attributable: false,
      persisted: false,
      checks: [{ code: "CALLABLE_RESULT", status: "FAIL", detail: error instanceof Error ? error.message : "AiKi Grid was unavailable." }],
      boundary,
    };
  }
}
