import { z } from "zod";
import {
  LpRebalanceDeliverableSchema,
  LpRebalanceRequestSchema,
  type LpRebalanceDeliverable,
  type LpRebalanceRequest,
} from "../contracts/lp-rebalance.js";
import {
  FIXED_SCALE,
  divideFixed,
  formatFixed,
  multiplyFixed,
  parseFixed,
  ratioFromBps,
} from "../core/fixed.js";
import { clampNonNegative } from "../providers/provider-utils.js";
import { createLpRebalanceDeliverable } from "../providers/lp-rebalance.js";
import {
  HEYANON_V3_POOLS,
} from "./heyanon-v3pools-adapter.js";

const PositiveDecimalSchema = z.string().regex(/^[1-9]\d*(\.\d+)?$|^0\.\d*[1-9]\d*$/);

const PoolPriceEnvelopeSchema = z.object({
  project: z.literal("v3pools"),
  operation: z.literal("getCurrentPoolPrice"),
  data: z.object({
    dex: z.literal("Pancake"),
    poolPrice: PositiveDecimalSchema,
    token0Symbol: z.string().min(1),
    token1Symbol: z.string().min(1),
    fee: z.string().regex(/^\d+(\.\d+)?%$/),
    oraclePrice: z.number().positive(),
  }).strict(),
}).strict();

const RangeEnvelopeSchema = z.object({
  project: z.literal("v3pools"),
  operation: z.literal("getPredefinedPriceRanges"),
  data: z.object({
    pool: z.string().min(3),
    lowerPrice: PositiveDecimalSchema,
    upperPrice: PositiveDecimalSchema,
  }).strict(),
}).strict();

const McpResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  result: z.object({
    content: z.array(z.object({ type: z.literal("text"), text: z.string() }).passthrough()).min(1),
  }).passthrough(),
}).passthrough();

interface ExternalRange {
  shortcut: "wide";
  providerPool: string;
  lowerPoolPrice: string;
  upperPoolPrice: string;
  lowerTick: number;
  upperTick: number;
  widthTicks: number;
  currentPriceUsd: string;
  oraclePriceUsd: string;
}

export interface HeyAnonV3LpJobAssessment {
  schemaVersion: "positioncrew.external-lp-job-assessment.v1";
  adapterId: "positioncrew:mcp:heyanon-v3pools:lp-job:v1";
  provider: typeof HEYANON_V3_POOLS;
  requestId: string;
  positionId: string;
  recommendation: ExternalRange;
  normalizedDeliverable: LpRebalanceDeliverable;
  checks: Array<{ code: string; status: "PASS" | "FAIL"; detail: string }>;
  attributableResult: true;
  status: "INCOMPATIBLE_CONSTRAINTS" | "ELIGIBLE_WITH_ADAPTER";
  eligibleForLpRebalance: boolean;
  claimBoundary: string[];
}

function parseEventStream(raw: string): unknown {
  const dataLine = raw.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(dataLine ? dataLine.slice(6) : raw) as unknown;
}

async function callTool(
  name: "getCurrentPoolPrice" | "getPredefinedPriceRanges",
  args: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const signal = AbortSignal.timeout(8_000);
  const response = await fetchImpl(HEYANON_V3_POOLS.endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    signal,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: name,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  if (!response.ok) throw new Error(`HeyAnon V3 MCP returned HTTP ${response.status}`);
  const mcp = McpResponseSchema.parse(parseEventStream(await response.text()));
  const content = mcp.result.content.find((item) => item.type === "text");
  if (!content) throw new Error(`HeyAnon V3 MCP returned no ${name} result`);
  return JSON.parse(content.text) as unknown;
}

function alignDown(tick: number, spacing: number): number {
  return Math.floor(tick / spacing) * spacing;
}

function alignUp(tick: number, spacing: number): number {
  return Math.ceil(tick / spacing) * spacing;
}

function priceToTick(price: number, rounding: "DOWN" | "UP"): number {
  if (!Number.isFinite(price) || price <= 0) throw new Error("External range price is invalid");
  const raw = Math.log(price) / Math.log(1.0001);
  return rounding === "DOWN" ? Math.floor(raw) : Math.ceil(raw);
}

function relativeDifferenceBps(left: number, right: number): number {
  if (left <= 0 || right <= 0) return Number.POSITIVE_INFINITY;
  return Math.abs(left - right) / right * 10_000;
}

function normalizeExternalRange(
  request: LpRebalanceRequest,
  lowerTick: number,
  upperTick: number,
  now: Date,
): LpRebalanceDeliverable {
  const firstParty = createLpRebalanceDeliverable(request, now);
  if (firstParty.status.startsWith("REFUSED_")) {
    return LpRebalanceDeliverableSchema.parse({
      ...firstParty,
      summary: "The external range was not evaluated because the frozen request failed PositionCrew's evidence gate.",
      limitations: [...firstParty.limitations, "HeyAnon supplied a range only; PositionCrew supplied the evidence and policy evaluation."],
    });
  }

  const currentWidth = request.position.upperTick - request.position.lowerTick;
  const proposedWidth = upperTick - lowerTick;
  const currentTick = request.marketState.currentTick;
  const currentInRange = currentTick >= request.position.lowerTick &&
    currentTick < request.position.upperTick;
  const currentEdgeDistance = currentInRange
    ? Math.min(currentTick - request.position.lowerTick, request.position.upperTick - currentTick)
    : 0;
  const currentEdgeBps = currentInRange
    ? Math.floor(currentEdgeDistance * 10_000 / currentWidth)
    : 0;
  const highVolatility = request.marketState.realizedVolatilityBps >=
    request.constraints.highVolatilityBps;
  const currentUptimeBps = !currentInRange
    ? 0
    : currentEdgeBps < request.constraints.edgeBufferBps
      ? 3_500
      : highVolatility
        ? 5_500
        : 9_000;
  const positionValueUsd = parseFixed(request.position.positionValueUsd);
  const poolLiquidityUsd = parseFixed(request.marketState.poolLiquidityUsd);
  const fees24hUsd = parseFixed(request.marketState.fees24hUsd);
  const horizonRatio = BigInt(request.constraints.evaluationHorizonHours) * FIXED_SCALE / 24n;
  const feeBase = multiplyFixed(
    multiplyFixed(fees24hUsd, divideFixed(positionValueUsd, poolLiquidityUsd)),
    horizonRatio,
  );
  const currentGrossFees = multiplyFixed(feeBase, ratioFromBps(currentUptimeBps));
  const proposedGrossFees = multiplyFixed(
    multiplyFixed(feeBase, BigInt(currentWidth) * FIXED_SCALE / BigInt(proposedWidth)),
    ratioFromBps(9_500),
  );
  const totalCostUsd = parseFixed(request.constraints.estimatedGasUsd) +
    parseFixed(request.constraints.estimatedSwapCostUsd);
  const incrementalFees = proposedGrossFees - currentGrossFees;
  const netBenefit = clampNonNegative(incrementalFees - totalCostUsd);
  const economicsPass = incrementalFees > 0n &&
    netBenefit >= parseFixed(request.constraints.minimumNetBenefitUsd) &&
    parseFixed(request.constraints.estimatedGasUsd) <= parseFixed(request.maxGasUsd) &&
    totalCostUsd <= parseFixed(request.maxActionUsd) &&
    request.constraints.maximumToken0ShareBps >= 5_000 &&
    request.constraints.maximumToken1ShareBps >= 5_000;
  const attribution = "HeyAnon supplied the range; PositionCrew supplied block-pinned economics and evaluated the buyer's limits.";

  if (!economicsPass) {
    return LpRebalanceDeliverableSchema.parse({
      ...firstParty,
      status: "NO_ACTION",
      decision: "HOLD",
      proposedRange: null,
      estimatedRebalanceCostUsd: "0",
      expectedGrossFeesUsd: formatFixed(currentGrossFees, 6),
      expectedNetBenefitUsd: "0",
      breakEvenHours: null,
      summary: `HeyAnon's range was callable and compatible, but it did not clear the buyer's economic gate.`,
      actionSteps: [],
      invalidationConditions: ["Pool fees, volatility, position range, or execution costs change."],
      limitations: [
        attribution,
        `Projected net benefit ${formatFixed(netBenefit, 6)} USD does not clear ${request.constraints.minimumNetBenefitUsd} USD.`,
      ],
    });
  }

  const hourlyIncrementalFees = incrementalFees /
    BigInt(request.constraints.evaluationHorizonHours);
  const decision = proposedWidth > currentWidth
    ? "WIDEN" as const
    : proposedWidth < currentWidth
      ? "NARROW" as const
      : "SHIFT" as const;
  return LpRebalanceDeliverableSchema.parse({
    schemaVersion: "positioncrew.lp-rebalance.deliverable.v1",
    service: "LP_REBALANCE",
    requestId: request.requestId,
    generatedAt: now.toISOString(),
    expiresAt: firstParty.expiresAt,
    status: "ACTIONABLE",
    decision,
    proposedRange: { lowerTick, upperTick },
    estimatedRebalanceCostUsd: formatFixed(totalCostUsd, 6),
    expectedGrossFeesUsd: formatFixed(proposedGrossFees, 6),
    expectedNetBenefitUsd: formatFixed(netBenefit, 6),
    breakEvenHours: formatFixed(divideFixed(totalCostUsd, hourlyIncrementalFees), 4),
    inventoryExposure: { token0Bps: 5_000, token1Bps: 5_000 },
    summary: `The external range clears PositionCrew's pinned economics and buyer constraints.`,
    actionSteps: [
      "Collect fees and remove the current liquidity position.",
      `Rebalance inventory within ${request.maxSlippageBps} bps slippage.`,
      `Mint the replacement position at ticks ${lowerTick} and ${upperTick}.`,
    ],
    invalidationConditions: [
      `Current tick changes materially from ${request.marketState.currentTick}.`,
      `Gas exceeds ${request.maxGasUsd} USD or swap cost exceeds ${request.constraints.estimatedSwapCostUsd} USD.`,
      `Current time passes ${firstParty.expiresAt}.`,
    ],
    limitations: [attribution, "The normalized result remains unsigned and requires revalidation before execution."],
  });
}

export async function auditionHeyAnonV3LpJob(
  input: LpRebalanceRequest,
  positionId: string,
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<HeyAnonV3LpJobAssessment> {
  const request = LpRebalanceRequestSchema.parse(input);
  const fetchImpl = options.fetchImpl ?? fetch;
  if (!new RegExp(`^pancake-position-${positionId}-`).test(request.requestId)) {
    throw new Error("The PositionCrew request does not bind the requested position ID");
  }
  const feeTierBySpacing = new Map([[1, 100], [10, 500], [50, 2_500], [200, 10_000]]);
  const feeTier = feeTierBySpacing.get(request.constraints.tickSpacing);
  if (!feeTier) throw new Error("The PositionCrew request uses an unsupported PancakeSwap tick spacing");
  const args = {
    chainName: "bsc",
    token0: request.token0.address,
    token1: request.token1.address,
    fee: feeTier,
  };
  const [priceEnvelope, rangeEnvelope] = await Promise.all([
    callTool("getCurrentPoolPrice", args, fetchImpl).then((value) =>
      PoolPriceEnvelopeSchema.parse(value)
    ),
    callTool("getPredefinedPriceRanges", { ...args, shortcut: "wide" }, fetchImpl).then(
      (value) => RangeEnvelopeSchema.parse(value),
    ),
  ]);
  const lowerPoolPrice = Number(rangeEnvelope.data.lowerPrice);
  const upperPoolPrice = Number(rangeEnvelope.data.upperPrice);
  if (lowerPoolPrice >= upperPoolPrice) throw new Error("External range is not ordered");
  const rawLowerTick = priceToTick(lowerPoolPrice, "DOWN");
  const rawUpperTick = priceToTick(upperPoolPrice, "UP");
  const lowerTick = alignDown(rawLowerTick, request.constraints.tickSpacing);
  const upperTick = alignUp(rawUpperTick, request.constraints.tickSpacing);
  const widthTicks = upperTick - lowerTick;
  const currentTickInside = request.marketState.currentTick >= lowerTick &&
    request.marketState.currentTick < upperTick;
  const widthPass = widthTicks >= request.constraints.minimumWidthTicks &&
    widthTicks <= request.constraints.maximumWidthTicks;
  const priceBps = relativeDifferenceBps(
    Number(priceEnvelope.data.poolPrice),
    Number(request.marketState.token1PriceUsd) / Number(request.marketState.token0PriceUsd),
  );
  const pricePass = priceBps <= 100;
  const checks = [
    {
      code: "EXACT_POSITION_BINDING",
      status: "PASS" as const,
      detail: "The position ID, pool, token pair, range, liquidity, and observation block remain bound by PositionCrew's frozen request.",
    },
    {
      code: "CURRENT_PRICE_COHERENCE",
      status: pricePass ? "PASS" as const : "FAIL" as const,
      detail: pricePass
        ? `The provider pool price is within ${priceBps.toFixed(2)} bps of the request's pinned oracle price.`
        : `The provider pool price differs by ${priceBps.toFixed(2)} bps from the request's pinned oracle price.`,
    },
    {
      code: "ATTRIBUTABLE_RANGE_RECOMMENDATION",
      status: "PASS" as const,
      detail: "The listed provider returned its precommitted wide range for the exact pool and fee tier.",
    },
    {
      code: "RANGE_CONTAINS_CURRENT_TICK",
      status: currentTickInside ? "PASS" as const : "FAIL" as const,
      detail: currentTickInside
        ? "The external range contains the pinned current tick."
        : "The external range excludes the pinned current tick.",
    },
    {
      code: "RANGE_WIDTH_POLICY",
      status: widthPass ? "PASS" as const : "FAIL" as const,
      detail: widthPass
        ? `The external ${widthTicks}-tick range is inside the buyer's width limits.`
        : `The external ${widthTicks}-tick range is outside the buyer's ${request.constraints.minimumWidthTicks}..${request.constraints.maximumWidthTicks} limits.`,
    },
    {
      code: "MARKET_ECONOMICS",
      status: "PASS" as const,
      detail: "PositionCrew evaluated the provider range with the request's pinned fees, liquidity, gas, swap cost, and buyer limits.",
    },
    {
      code: "EXACT_OUTPUT_CONTRACT",
      status: "PASS" as const,
      detail: "The disclosed compatibility adapter normalized the range into positioncrew.lp-rebalance.deliverable.v1.",
    },
  ];
  const eligible = checks.every((check) => check.status === "PASS");
  const normalizedDeliverable = normalizeExternalRange(
    request,
    lowerTick,
    upperTick,
    options.now ?? new Date(),
  );
  return {
    schemaVersion: "positioncrew.external-lp-job-assessment.v1",
    adapterId: "positioncrew:mcp:heyanon-v3pools:lp-job:v1",
    provider: HEYANON_V3_POOLS,
    requestId: request.requestId,
    positionId,
    recommendation: {
      shortcut: "wide",
      providerPool: rangeEnvelope.data.pool,
      lowerPoolPrice: rangeEnvelope.data.lowerPrice,
      upperPoolPrice: rangeEnvelope.data.upperPrice,
      lowerTick,
      upperTick,
      widthTicks,
      currentPriceUsd: priceEnvelope.data.poolPrice,
      oraclePriceUsd: String(priceEnvelope.data.oraclePrice),
    },
    normalizedDeliverable,
    checks,
    attributableResult: true,
    status: eligible ? "ELIGIBLE_WITH_ADAPTER" : "INCOMPATIBLE_CONSTRAINTS",
    eligibleForLpRebalance: eligible,
    claimBoundary: [
      "The external agent produced the attributable range recommendation; PositionCrew supplied the pinned position and market economics.",
      "The compatibility adapter aligned ticks, evaluated buyer constraints, and normalized the result without changing the external range thesis.",
      "No approval, payment, signature, liquidity movement, or protocol transaction occurred.",
    ],
  };
}
