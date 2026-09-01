import { z } from "zod";

import type {
  BoundedGridDeliverable,
  BoundedGridRequest,
} from "../contracts/bounded-grid.js";
import { createBoundedGridDeliverable } from "../providers/bounded-grid.js";

export const BRAIN_ON_BNB_GRID = {
  name: "Brain on BNB BSC Grid Planner",
  erc8004TokenId: "302258",
  endpoint: "https://brainonbnb.com/api/range-plan",
} as const;

const RangeSchema = z.object({
  width_pct: z.number().positive().nullable(),
  full_range: z.boolean(),
  price_range: z.object({
    low: z.number().positive(),
    high: z.number().positive(),
    unit: z.string().min(1),
  }).strict().nullable(),
  swaps_in_range: z.number().int().nonnegative(),
  swaps_total: z.number().int().positive(),
  share_of_window_in_range_pct: z.number().nonnegative(),
  times_it_crossed_the_edge: z.number().int().nonnegative(),
  fees_usd_in_window: z.number().nonnegative(),
  assumed_rebalance_cost_usd: z.number().nonnegative(),
  net_after_rebalancing_usd_in_window: z.number(),
}).strict();

const BrainGridResponseSchema = z.object({
  tool: z.literal("pancakeswap_range_plan"),
  pair: z.object({
    token: z.object({
      address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      symbol: z.string().min(1),
      decimals: z.number().int().nonnegative(),
    }).strict(),
    quote: z.object({
      address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      symbol: z.string().min(1),
      decimals: z.number().int().nonnegative(),
    }).strict(),
  }).strict(),
  pool: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  fee_pct: z.number().nonnegative(),
  tier_chosen_because: z.string().min(1),
  price_now: z.number().positive(),
  capital_considered_usd: z.number().positive(),
  measured_window: z.object({
    from_block: z.number().int().positive(),
    to_block: z.number().int().positive(),
    blocks: z.number().int().positive(),
    minutes: z.number().positive(),
    swaps: z.number().int().positive(),
    fees_the_pool_paid_usd: z.number().nonnegative(),
    note: z.string().min(1),
  }).strict(),
  ranges: z.array(RangeSchema).min(1),
  best_earning_range_in_this_window: z.string().min(1),
  best_range_after_paying_to_put_it_back: z.string().min(1),
  rebalance_cost_usd_assumed: z.number().nonnegative(),
  narrowest_range_that_held_the_whole_window: z.string().min(1),
  times_better_than_full_range: z.number().nonnegative(),
  caveats: z.array(z.string().min(1)).min(1),
}).strict();

export type BrainOnBnbGridComparison = {
  provider: typeof BRAIN_ON_BNB_GRID;
  evaluatedAt: string;
  outcome: "SEMANTICALLY_COMPARABLE" | "INCOMPATIBLE" | "UNAVAILABLE";
  pool: string;
  positionCrewDecision: BoundedGridDeliverable["decision"];
  externalRecommendation: "BUILD_GRID" | "NO_GRID" | null;
  externalState: "RANGE_REPLAY_READY" | null;
  exactRequestAccepted: false;
  eligibleForRangeAssessmentActivation: boolean;
  eligibleForGridSelection: boolean;
  eligibleForLiveMatch: boolean;
  attributable: boolean;
  adapterNormalized: boolean;
  providerRange: {
    widthPct: number;
    lowerPrice: number;
    upperPrice: number;
    netAfterRebalancingUsdInWindow: number;
  } | null;
  measuredWindow: {
    fromBlock: number;
    toBlock: number;
    swaps: number;
    minutes: number;
  } | null;
  normalizedDeliverable?: BoundedGridDeliverable;
  selection?: {
    selectedProvider: "POSITIONCREW" | "EXTERNAL";
    externalEligible: boolean;
    basis: string;
  };
  checks: Array<{ code: string; status: "PASS" | "FAIL"; detail: string }>;
  boundary: string;
};

function requestBlock(request: BoundedGridRequest): number | null {
  const source = request.sources.find(({ sourceId }) => sourceId === request.marketState.sourceId);
  if (!source) return null;
  const match = source.uri.match(/\/block\/(\d+)(?:$|[/?#])/);
  if (match) return Number(match[1]);
  const idMatch = source.sourceId.match(/block-(\d+)$/);
  if (idMatch) return Number(idMatch[1]);
  return null;
}

function priceDifferenceBps(left: number, right: number): number {
  return Math.round(Math.abs(left - right) / right * 10_000);
}

function replayEconomicsAreConsistent(
  candidate: z.infer<typeof RangeSchema>,
  declaredRebalanceCostUsd: number,
): boolean {
  const toleranceUsd = 0.000001;
  const expectedNetUsd = candidate.fees_usd_in_window - candidate.assumed_rebalance_cost_usd;
  return Math.abs(candidate.assumed_rebalance_cost_usd - declaredRebalanceCostUsd) <= toleranceUsd &&
    Math.abs(candidate.net_after_rebalancing_usd_in_window - expectedNetUsd) <= toleranceUsd;
}

function replayActivityIsConsistent(
  candidate: z.infer<typeof RangeSchema>,
  window: z.infer<typeof BrainGridResponseSchema>["measured_window"],
): boolean {
  const calculatedShare = candidate.swaps_in_range / candidate.swaps_total * 100;
  return candidate.swaps_total === window.swaps &&
    candidate.swaps_in_range <= candidate.swaps_total &&
    candidate.share_of_window_in_range_pct <= 100 &&
    Math.abs(candidate.share_of_window_in_range_pct - calculatedShare) <= 0.1 &&
    candidate.fees_usd_in_window <= window.fees_the_pool_paid_usd + 0.000001;
}

export async function auditionBrainOnBnbGrid(
  request: BoundedGridRequest,
  firstParty: BoundedGridDeliverable,
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<BrainOnBnbGridComparison> {
  const now = options.now ?? new Date();
  const boundary = "Brain on BNB independently replayed live PancakeSwap swaps and supplied a range thesis. PositionCrew bound that evidence to the requested pool and market window, then applied the unchanged capital, liquidity, volatility, fee, slippage, gas, inventory, loss, expiry, and output-contract rules through a disclosed adapter. No payment, authority grant, order placement, swap, or protocol transaction occurred.";
  const base = {
    provider: BRAIN_ON_BNB_GRID,
    evaluatedAt: now.toISOString(),
    pool: request.venue,
    positionCrewDecision: firstParty.decision,
    exactRequestAccepted: false as const,
  };

  try {
    const url = new URL(BRAIN_ON_BNB_GRID.endpoint);
    url.searchParams.set("address", request.baseAsset.address);
    const fetchImpl = options.fetchImpl ?? fetch;
    let response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(4_000),
    });
    if (response.status >= 500) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      response = await fetchImpl(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(4_000),
      });
    }
    if (!response.ok) throw new Error(`Brain on BNB Grid returned HTTP ${response.status}`);
    const parsed = BrainGridResponseSchema.parse(await response.json());
    const exactPool = parsed.pool.toLowerCase() === request.venue.toLowerCase();
    const exactPair =
      parsed.pair.token.address.toLowerCase() === request.baseAsset.address.toLowerCase() &&
      parsed.pair.quote.address.toLowerCase() === request.quoteAsset.address.toLowerCase();
    const exactCapital = Math.abs(parsed.capital_considered_usd - Number(request.constraints.capitalUsd)) < 0.000001;
    const pinnedBlock = requestBlock(request);
    const windowBindsRequest = pinnedBlock !== null &&
      pinnedBlock >= parsed.measured_window.from_block &&
      pinnedBlock <= parsed.measured_window.to_block;
    const priceCoherent = priceDifferenceBps(parsed.price_now, Number(request.marketState.midPrice)) <= 25;
    const midPrice = Number(request.marketState.midPrice);
    const buyerLower = Number(request.constraints.lowerPrice);
    const buyerUpper = Number(request.constraints.upperPrice);
    const rawRangeBindsProviderAndBuyer = (candidate: z.infer<typeof RangeSchema>): boolean => {
      if (candidate.width_pct === null || candidate.full_range || !candidate.price_range) return false;
      const expectedLower = parsed.price_now * (1 - candidate.width_pct / 100);
      const expectedUpper = parsed.price_now * (1 + candidate.width_pct / 100);
      const expectedUnit = `${request.quoteAsset.symbol} per ${request.baseAsset.symbol}`.toLowerCase();
      return candidate.price_range.unit.toLowerCase() === expectedUnit &&
        priceDifferenceBps(candidate.price_range.low, expectedLower) <= 5 &&
        priceDifferenceBps(candidate.price_range.high, expectedUpper) <= 5 &&
        candidate.price_range.low >= buyerLower * (1 - 25 / 10_000) &&
        candidate.price_range.high <= buyerUpper * (1 + 25 / 10_000);
    };
    const providerRangeBinding = parsed.ranges.some(rawRangeBindsProviderAndBuyer);
    const candidates = parsed.ranges.flatMap((candidate) => {
      if (candidate.width_pct === null || candidate.full_range || !candidate.price_range) return [];
      if (!rawRangeBindsProviderAndBuyer(candidate)) return [];
      if (
        !replayActivityIsConsistent(candidate, parsed.measured_window) ||
        candidate.swaps_in_range < 100 ||
        candidate.share_of_window_in_range_pct < 10 ||
        candidate.fees_usd_in_window <= 0 ||
        !replayEconomicsAreConsistent(candidate, parsed.rebalance_cost_usd_assumed) ||
        candidate.net_after_rebalancing_usd_in_window <= 0
      ) return [];
      const lowerPrice = midPrice * (1 - candidate.width_pct / 100);
      const upperPrice = midPrice * (1 + candidate.width_pct / 100);
      if (lowerPrice < buyerLower - 0.000001 || upperPrice > buyerUpper + 0.000001) return [];
      const deliverable = createBoundedGridDeliverable({
        ...request,
        constraints: {
          ...request.constraints,
          lowerPrice: String(lowerPrice),
          upperPrice: String(upperPrice),
        },
      }, now);
      return [{ candidate, lowerPrice, upperPrice, deliverable }];
    });
    const selected = candidates
      .filter(({ deliverable }) => deliverable.status === "ACTIONABLE" && deliverable.decision === "BUILD_GRID")
      .sort((left, right) => Number(right.deliverable.expectedNetProfitUsd) - Number(left.deliverable.expectedNetProfitUsd))[0];
    const selectedRange = selected?.candidate;
    const widthPct = selectedRange?.width_pct ?? null;
    const rangeInsideBuyerBounds = Boolean(selected);
    const providerEvidenceSufficient = Boolean(selectedRange) &&
      parsed.measured_window.swaps >= 100 &&
      replayActivityIsConsistent(selectedRange!, parsed.measured_window) &&
      replayEconomicsAreConsistent(selectedRange!, parsed.rebalance_cost_usd_assumed) &&
      selectedRange!.net_after_rebalancing_usd_in_window > 0;
    const normalizedDeliverable = selected?.deliverable;
    const exactOutputContract = normalizedDeliverable?.status === "ACTIONABLE" &&
      normalizedDeliverable.decision === "BUILD_GRID";
    const externalEligible = exactPool && exactPair && exactCapital && windowBindsRequest &&
      priceCoherent && rangeInsideBuyerBounds && providerEvidenceSufficient && exactOutputContract;
    const firstPartyEligible = firstParty.status === "ACTIONABLE" && firstParty.decision === "BUILD_GRID";
    const liveMatchEligible = externalEligible && firstPartyEligible;
    const checks: BrainOnBnbGridComparison["checks"] = [
      { code: "EXACT_POOL_AND_PAIR", status: exactPool && exactPair ? "PASS" : "FAIL", detail: exactPool && exactPair ? "The provider measured the requested PancakeSwap WBNB/USDT pool." : "The provider result did not bind the requested pool and pair." },
      { code: "EXACT_CAPITAL", status: exactCapital ? "PASS" : "FAIL", detail: exactCapital ? "The replay used the buyer's exact capital amount." : "The replay used a different capital amount." },
      { code: "MEASURED_WINDOW_BINDING", status: windowBindsRequest ? "PASS" : "FAIL", detail: windowBindsRequest ? "The request's pinned block is inside the provider's disclosed replay window." : "The provider replay window does not bind the request's pinned market observation." },
      { code: "CURRENT_PRICE_COHERENCE", status: priceCoherent ? "PASS" : "FAIL", detail: priceCoherent ? "Provider and PositionCrew prices differ by no more than 25 bps." : "Provider and PositionCrew prices diverge beyond the admitted tolerance." },
      { code: "PROVIDER_RANGE_BINDING", status: providerRangeBinding ? "PASS" : "FAIL", detail: providerRangeBinding ? "At least one returned low/high pair matches its declared width and unit, and remains inside the buyer boundary within the admitted price-coherence tolerance." : "No returned low/high pair binds its declared width, unit, and buyer boundary." },
      { code: "PROVIDER_RANGE_INSIDE_BUYER_BOUND", status: rangeInsideBuyerBounds ? "PASS" : "FAIL", detail: rangeInsideBuyerBounds ? `A provider-replayed ±${widthPct}% width remains inside the buyer's maximum range after centering on the pinned request price.` : "No provider-replayed width remains inside the buyer boundary and survives the unchanged economics contract." },
      { code: "ATTRIBUTABLE_REPLAY_EVIDENCE", status: providerEvidenceSufficient ? "PASS" : "FAIL", detail: providerEvidenceSufficient ? `The admitted width captured at least 100 of ${parsed.measured_window.swaps} replayed swaps, covered at least 10% of the window, earned fees, and preserved positive observed net value after the provider's rebalance-cost model.` : "The provider did not demonstrate meaningful in-range activity and positive replay economics for an admitted width." },
      { code: "EXACT_OUTPUT_CONTRACT", status: exactOutputContract ? "PASS" : "FAIL", detail: exactOutputContract ? "PositionCrew normalized the provider range through the unchanged bounded order, economics, inventory, loss, expiry, and refusal contract." : "The provider thesis did not survive the unchanged PositionCrew grid contract." },
      { code: "FIRST_PARTY_ACTIONABLE_RESULT", status: firstPartyEligible ? "PASS" : "FAIL", detail: firstPartyEligible ? "The first-party provider also returned an actionable grid under the same buyer contract." : "The first-party provider did not return an actionable grid, so PositionCrew cannot claim a two-provider live match." },
    ];
    return {
      ...base,
      outcome: liveMatchEligible ? "SEMANTICALLY_COMPARABLE" : "INCOMPATIBLE",
      externalRecommendation: exactOutputContract ? "BUILD_GRID" : "NO_GRID",
      externalState: "RANGE_REPLAY_READY",
      eligibleForRangeAssessmentActivation: externalEligible,
      eligibleForGridSelection: liveMatchEligible,
      eligibleForLiveMatch: liveMatchEligible,
      attributable: exactPool && exactPair,
      adapterNormalized: Boolean(normalizedDeliverable),
      providerRange: selected && widthPct !== null
        ? {
            widthPct,
            lowerPrice: selected.lowerPrice,
            upperPrice: selected.upperPrice,
            netAfterRebalancingUsdInWindow: selected.candidate.net_after_rebalancing_usd_in_window,
          }
        : null,
      measuredWindow: {
        fromBlock: parsed.measured_window.from_block,
        toBlock: parsed.measured_window.to_block,
        swaps: parsed.measured_window.swaps,
        minutes: parsed.measured_window.minutes,
      },
      ...(normalizedDeliverable ? { normalizedDeliverable } : {}),
      ...(liveMatchEligible
        ? {
            selection: {
              selectedProvider: "POSITIONCREW" as const,
              externalEligible: true,
              basis: "The first-party provider won the native exact-contract tiebreak; the external replay-derived range remained attributable and fully evaluated.",
            },
          }
        : {}),
      checks,
      boundary,
    };
  } catch (error) {
    return {
      ...base,
      outcome: "UNAVAILABLE",
      externalRecommendation: null,
      externalState: null,
      eligibleForRangeAssessmentActivation: false,
      eligibleForGridSelection: false,
      eligibleForLiveMatch: false,
      attributable: false,
      adapterNormalized: false,
      providerRange: null,
      measuredWindow: null,
      selection: {
        selectedProvider: "POSITIONCREW",
        externalEligible: false,
        basis: "The external provider was unavailable; the first-party bounded-grid hire remained available.",
      },
      checks: [{ code: "CALLABLE_RESULT", status: "FAIL", detail: error instanceof Error ? error.message : "Brain on BNB Grid was unavailable." }],
      boundary,
    };
  }
}
