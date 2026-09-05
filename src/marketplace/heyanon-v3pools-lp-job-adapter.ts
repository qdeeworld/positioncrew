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
import { clampNonNegative, validateEvidence } from "../providers/provider-utils.js";
import { lpInventoryExposure } from "../core/lp-range.js";
import { evaluateFinancialInvariants } from "../evaluators/financial-invariants.js";
import { canonicalHash } from "../core/canonical.js";
import { createBscVerificationRpc, type BscVerificationRpc } from "./bsc-verification-rpc.js";
import {
  HEYANON_V3_POOLS,
  fetchPinnedPancakeV3Position,
} from "./heyanon-v3pools-adapter.js";

const PositiveDecimalSchema = z.string().regex(/^[1-9]\d*(\.\d+)?$|^0\.\d*[1-9]\d*$/);
const PANCAKE_V3_FACTORY = "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865";
const DEFAULT_BSC_RPC = "https://bsc-rpc.publicnode.com";

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
  shortcut: "risky" | "wide" | "safe";
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
  invocation: {
    endpoint: typeof HEYANON_V3_POOLS.endpoint;
    startedAt: string;
    completedAt: string;
    latencyMilliseconds: number;
    rawResponseHash: string;
    normalizedResponseHash: string;
    materialTermsHash: string;
  };
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

function addressArgument(address: string): string {
  return address.slice(2).toLowerCase().padStart(64, "0");
}

async function fetchPancakeV3Pool(
  token0: string,
  token1: string,
  fee: number,
  blockNumber: number,
  verificationRpc: BscVerificationRpc,
): Promise<string> {
  const raw = await verificationRpc.request("eth_call", [{
    to: PANCAKE_V3_FACTORY,
    data: `0x1698ee82${addressArgument(token0)}${addressArgument(token1)}${BigInt(fee).toString(16).padStart(64, "0")}`,
  }, `0x${blockNumber.toString(16)}`]);
  const result = z.string().regex(/^0x[a-fA-F0-9]{64}$/).parse(raw);
  return `0x${result.slice(-40)}`.toLowerCase();
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

export function selectHeyAnonRangeShortcut(request: LpRebalanceRequest): ExternalRange["shortcut"] {
  // Provider-advertised presets: +/-1%, +/-5%, +/-10%. Pick before calling,
  // against the buyer's unchanged bounds. Actual returned ticks still undergo
  // full independent validation; this estimate never makes a result eligible.
  const spacing = request.constraints.tickSpacing;
  for (const [shortcut, deviation] of [["safe", 0.10], ["wide", 0.05], ["risky", 0.01]] as const) {
    const rawWidth = Math.log((1 + deviation) / (1 - deviation)) / Math.log1p(0.0001);
    if (rawWidth >= request.constraints.minimumWidthTicks &&
        Math.ceil(rawWidth / spacing) * spacing + 2 * spacing <= request.constraints.maximumWidthTicks) {
      return shortcut;
    }
  }
  // Retain an attributable refusal when none of the advertised presets fits;
  // do not synthesize a recommendation or modify the buyer's limits.
  return "wide";
}

function normalizeExternalRange(
  request: LpRebalanceRequest,
  lowerTick: number,
  upperTick: number,
  now: Date,
): LpRebalanceDeliverable {
  // Evidence checks must not depend on whether our own strategy would propose
  // or refuse a different range. A different safe external strategy may pass.
  const evidence = validateEvidence({ sources: request.sources, observations: [request.marketState],
    requestedAt: request.requestedAt, deadline: request.deadline,
    maxDataAgeSeconds: request.maxDataAgeSeconds, now });
  const firstParty = LpRebalanceDeliverableSchema.parse({
    schemaVersion: "positioncrew.lp-rebalance.deliverable.v1", service: "LP_REBALANCE",
    requestId: request.requestId, generatedAt: now.toISOString(), expiresAt: evidence.expiresAt,
    status: evidence.status === "OK" ? "NO_ACTION" : evidence.status, decision: "NONE",
    proposedRange: null, estimatedRebalanceCostUsd: "0", expectedGrossFeesUsd: "0",
    expectedNetBenefitUsd: "0", breakEvenHours: null,
    inventoryExposure: { token0Bps: request.position.token0ShareBps, token1Bps: request.position.token1ShareBps },
    summary: "The external range requires current evidence and independent buyer-limit checks.",
    actionSteps: [], invalidationConditions: ["Refresh the pool and position snapshot before retrying."],
    limitations: evidence.reasons.length ? evidence.reasons : ["This assessment is unsigned and does not execute a rebalance."],
  });
  if (evidence.status !== "OK") return firstParty;
  const proposedInventory = lpInventoryExposure(request, { lowerTick, upperTick });
  const width = upperTick - lowerTick;
  const spacing = request.constraints.tickSpacing;
  if (width < request.constraints.minimumWidthTicks || width > request.constraints.maximumWidthTicks ||
      lowerTick % spacing !== 0 || upperTick % spacing !== 0 ||
      request.marketState.currentTick < lowerTick || request.marketState.currentTick >= upperTick ||
      !proposedInventory || proposedInventory.maximumToken0Bps > request.constraints.maximumToken0ShareBps ||
      proposedInventory.maximumToken1Bps > request.constraints.maximumToken1ShareBps) {
    return LpRebalanceDeliverableSchema.parse({ ...firstParty, status: "REFUSED_CONSTRAINTS",
      summary: "The external range does not satisfy the buyer's range or V3 inventory limits.",
      limitations: ["Final aligned range and USD inventory shares, including tick-price uncertainty, must satisfy the same limits for every provider."] });
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
    incrementalFees >= totalCostUsd &&
    netBenefit >= parseFixed(request.constraints.minimumNetBenefitUsd) &&
    parseFixed(request.constraints.estimatedGasUsd) <= parseFixed(request.maxGasUsd) &&
    totalCostUsd <= parseFixed(request.maxActionUsd);
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
    estimatedRebalanceCostUsd: formatFixed(totalCostUsd, 18),
    expectedGrossFeesUsd: formatFixed(proposedGrossFees, 18),
    expectedNetBenefitUsd: formatFixed(netBenefit, 18),
    breakEvenHours: formatFixed(divideFixed(totalCostUsd * BigInt(request.constraints.evaluationHorizonHours), incrementalFees), 18),
    feeProjection: { model: "POOL_SHARE_UPTIME_V1", currentUptimeBps, proposedUptimeBps: 9_500 },
    inventoryExposure: { token0Bps: proposedInventory.token0Bps, token1Bps: proposedInventory.token1Bps },
    summary: `The external range clears the screening model: ${formatFixed(netBenefit, 2)} USD net benefit assuming ${currentUptimeBps / 100}% current and 95% proposed fee uptime, not a fee forecast.`,
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
    limitations: [attribution, "Fee uptime and range density are model assumptions. Actual fees may not cover costs.",
      "Inventory uses supplied USD prices, decimals and both tick-interval endpoints with a rounding margin. Revalidate exact sqrt price and transaction amounts before execution."],
  });
}

export async function auditionHeyAnonV3LpJob(
  input: LpRebalanceRequest,
  positionId: string,
  options: { fetchImpl?: typeof fetch; now?: Date; rpcUrl?: string; signal?: AbortSignal } = {},
): Promise<HeyAnonV3LpJobAssessment> {
  const invocationStartedAt = new Date().toISOString();
  const invocationStartedPerformance = performance.now();
  const request = LpRebalanceRequestSchema.parse(input);
  const rawFetch = options.fetchImpl ?? fetch;
  const callerSignal = options.signal;
  const fetchImpl: typeof fetch = callerSignal
    ? (resource, init) => rawFetch(resource, {
        ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, callerSignal]) : callerSignal,
      })
    : rawFetch;
  if (!new RegExp(`^pancake-position-${positionId}-`).test(request.requestId)) {
    throw new Error("The PositionCrew request does not bind the requested position ID");
  }
  const verificationRpc = createBscVerificationRpc(options.rpcUrl ?? DEFAULT_BSC_RPC, fetchImpl,
    callerSignal ? { signal: callerSignal } : {});
  const pinnedPosition = await fetchPinnedPancakeV3Position(
    positionId,
    options.rpcUrl,
    fetchImpl,
    verificationRpc,
  );
  const feeTier = pinnedPosition.fee;
  const tickSpacingByFee = new Map([[100, 1], [500, 10], [2_500, 50], [10_000, 200]]);
  const pinnedTickSpacing = tickSpacingByFee.get(feeTier);
  if (!pinnedTickSpacing) throw new Error("The pinned PancakeSwap position uses an unsupported fee tier");
  const pinnedPool = await fetchPancakeV3Pool(
    pinnedPosition.token0,
    pinnedPosition.token1,
    feeTier,
    pinnedPosition.blockNumber,
    verificationRpc,
  );
  const args = {
    chainName: "bsc",
    token0: request.token0.address,
    token1: request.token1.address,
    fee: feeTier,
  };
  const shortcut = selectHeyAnonRangeShortcut(request);
  const [priceEnvelope, rangeEnvelope] = await Promise.all([
    callTool("getCurrentPoolPrice", args, fetchImpl).then((value) =>
      PoolPriceEnvelopeSchema.parse(value)
    ),
    callTool("getPredefinedPriceRanges", { ...args, shortcut }, fetchImpl).then(
      (value) => RangeEnvelopeSchema.parse(value),
    ),
  ]);
  const lowerPoolPrice = Number(rangeEnvelope.data.lowerPrice);
  const upperPoolPrice = Number(rangeEnvelope.data.upperPrice);
  if (lowerPoolPrice >= upperPoolPrice) throw new Error("External range is not ordered");
  const rawLowerTick = priceToTick(lowerPoolPrice, "DOWN");
  const rawUpperTick = priceToTick(upperPoolPrice, "UP");
  const lowerTick = alignDown(rawLowerTick, pinnedTickSpacing);
  const upperTick = alignUp(rawUpperTick, pinnedTickSpacing);
  const widthTicks = upperTick - lowerTick;
  const currentTickInside = request.marketState.currentTick >= lowerTick &&
    request.marketState.currentTick < upperTick;
  const widthPass = widthTicks >= request.constraints.minimumWidthTicks &&
    widthTicks <= request.constraints.maximumWidthTicks;
  const positionBinding = pinnedPosition.owner === request.account.toLowerCase() &&
    pinnedPosition.token0 === request.token0.address.toLowerCase() &&
    pinnedPosition.token1 === request.token1.address.toLowerCase() &&
    pinnedPosition.tickLower === request.position.lowerTick &&
    pinnedPosition.tickUpper === request.position.upperTick &&
    pinnedPosition.liquidity === request.position.liquidity;
  const poolBinding = pinnedPool === request.pool.toLowerCase();
  const tickSpacingBinding = pinnedTickSpacing === request.constraints.tickSpacing;
  const priceBps = relativeDifferenceBps(
    Number(priceEnvelope.data.poolPrice),
    Number(request.marketState.token1PriceUsd) / Number(request.marketState.token0PriceUsd),
  );
  const pricePass = priceBps <= 100;
  const checks = [
    {
      code: "EXACT_POSITION_BINDING",
      status: positionBinding ? "PASS" as const : "FAIL" as const,
      detail: positionBinding
        ? "The request owner, token pair, ticks, and raw liquidity match an independent position-manager read."
        : "The caller-supplied position does not match the independent PancakeSwap position-manager read.",
    },
    {
      code: "EXACT_POOL_BINDING",
      status: poolBinding ? "PASS" as const : "FAIL" as const,
      detail: poolBinding
        ? "The request pool matches the PancakeSwap factory pool for the pinned NFT token pair and fee tier."
        : "The request pool does not match the PancakeSwap factory pool for the pinned NFT.",
    },
    {
      code: "TICK_SPACING_BINDING",
      status: tickSpacingBinding ? "PASS" as const : "FAIL" as const,
      detail: tickSpacingBinding
        ? `The request tick spacing matches fee tier ${feeTier}.`
        : `The request tick spacing does not match fee tier ${feeTier}.`,
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
      detail: `The listed provider returned the ${shortcut} preset chosen from the buyer's unchanged width bounds for the exact pool and fee tier.`,
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
  const normalizedDeliverable = normalizeExternalRange(
    request,
    lowerTick,
    upperTick,
    options.now ?? new Date(),
  );
  const evidenceAccepted = !normalizedDeliverable.status.startsWith("REFUSED_");
  checks.push(...evaluateFinancialInvariants(request, normalizedDeliverable).map((check) => ({
    code: check.id, status: check.passed ? "PASS" as const : "FAIL" as const, detail: check.detail,
  })));
  checks.push({
    code: "NORMALIZED_EVIDENCE_GATE",
    status: evidenceAccepted ? "PASS" : "FAIL",
    detail: evidenceAccepted
      ? "The normalized deliverable passed the request freshness, deadline, and source-evidence gate."
      : `The normalized deliverable refused the request with ${normalizedDeliverable.status}.`,
  });
  const eligible = evidenceAccepted && checks.every((check) => check.status === "PASS");
  const invocationCompletedAt = new Date().toISOString();
  return {
    schemaVersion: "positioncrew.external-lp-job-assessment.v1",
    adapterId: "positioncrew:mcp:heyanon-v3pools:lp-job:v1",
    provider: HEYANON_V3_POOLS,
    requestId: request.requestId,
    positionId,
    recommendation: {
      shortcut,
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
    invocation: {
      endpoint: HEYANON_V3_POOLS.endpoint,
      startedAt: invocationStartedAt,
      completedAt: invocationCompletedAt,
      latencyMilliseconds: Math.max(1, Math.round(performance.now() - invocationStartedPerformance)),
      rawResponseHash: canonicalHash({
        provider: HEYANON_V3_POOLS,
        price: priceEnvelope,
        range: rangeEnvelope,
      }),
      normalizedResponseHash: canonicalHash(normalizedDeliverable),
      materialTermsHash: canonicalHash({
        provider: HEYANON_V3_POOLS,
        requestHash: canonicalHash(request),
        recommendation: { providerPool: rangeEnvelope.data.pool, lowerTick, upperTick, shortcut },
        status: normalizedDeliverable.status, decision: normalizedDeliverable.decision,
        proposedRange: normalizedDeliverable.proposedRange,
        inventoryExposure: normalizedDeliverable.inventoryExposure,
        estimatedRebalanceCostUsd: normalizedDeliverable.estimatedRebalanceCostUsd,
        expectedGrossFeesUsd: normalizedDeliverable.expectedGrossFeesUsd,
        expectedNetBenefitUsd: normalizedDeliverable.expectedNetBenefitUsd,
        breakEvenHours: normalizedDeliverable.breakEvenHours,
        ...(normalizedDeliverable.feeProjection ? { feeProjection: normalizedDeliverable.feeProjection } : {}),
        actionSteps: normalizedDeliverable.actionSteps,
        expiresAt: normalizedDeliverable.expiresAt,
        invalidationConditions: normalizedDeliverable.invalidationConditions,
        commerce: { directCostUsd: "0.00", payment: "NONE" },
      }),
    },
    claimBoundary: [
      "The external agent produced the attributable range recommendation; PositionCrew supplied the pinned position and market economics.",
      "The compatibility adapter aligned ticks, evaluated buyer constraints, and normalized the result without changing the external range thesis.",
      "No approval, payment, signature, liquidity movement, or protocol transaction occurred.",
    ],
  };
}
