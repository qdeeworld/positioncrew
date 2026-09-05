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
import { clampNonNegative, validateEvidence } from "./provider-utils.js";
import { boundedLpRange, lpInventoryExposure } from "../core/lp-range.js";

function refusal(
  request: LpRebalanceRequest,
  now: Date,
  status: Exclude<LpRebalanceDeliverable["status"], "ACTIONABLE" | "NO_ACTION">,
  expiresAt: string,
  reasons: string[],
): LpRebalanceDeliverable {
  return LpRebalanceDeliverableSchema.parse({
    schemaVersion: "positioncrew.lp-rebalance.deliverable.v1",
    service: "LP_REBALANCE",
    requestId: request.requestId,
    generatedAt: now.toISOString(),
    expiresAt,
    status,
    decision: "NONE",
    proposedRange: null,
    estimatedRebalanceCostUsd: "0",
    expectedGrossFeesUsd: "0",
    expectedNetBenefitUsd: "0",
    breakEvenHours: null,
    inventoryExposure: {
      token0Bps: request.position.token0ShareBps,
      token1Bps: request.position.token1ShareBps,
    },
    summary: "LP evidence or constraints are unsafe; no rebalance was proposed.",
    actionSteps: [],
    invalidationConditions: ["Refresh the pool and position snapshot before retrying."],
    limitations: reasons.length > 0 ? reasons : ["No safe action is available."],
  });
}

export function createLpRebalanceDeliverable(
  input: LpRebalanceRequest,
  now: Date,
): LpRebalanceDeliverable {
  const request = LpRebalanceRequestSchema.parse(input);
  const evidence = validateEvidence({
    sources: request.sources,
    observations: [request.marketState],
    requestedAt: request.requestedAt,
    deadline: request.deadline,
    maxDataAgeSeconds: request.maxDataAgeSeconds,
    now,
  });
  if (evidence.status !== "OK") {
    return refusal(request, now, evidence.status, evidence.expiresAt, evidence.reasons);
  }

  const width = request.position.upperTick - request.position.lowerTick;
  const currentTick = request.marketState.currentTick;
  const inRange =
    currentTick >= request.position.lowerTick && currentTick < request.position.upperTick;
  const edgeDistance = inRange
    ? Math.min(
        currentTick - request.position.lowerTick,
        request.position.upperTick - currentTick,
      )
    : 0;
  const edgeDistanceBps = inRange ? Math.floor((edgeDistance * 10_000) / width) : 0;
  const highVolatility =
    request.marketState.realizedVolatilityBps >= request.constraints.highVolatilityBps;

  let proposedDecision: "SHIFT" | "WIDEN" | "NARROW" | null = null;
  let desiredWidth = width;
  if (!inRange || edgeDistanceBps < request.constraints.edgeBufferBps) {
    proposedDecision = "SHIFT";
  } else if (highVolatility && width < request.constraints.maximumWidthTicks) {
    proposedDecision = "WIDEN";
    desiredWidth = Math.ceil(width * 1.5);
  } else if (
    request.marketState.realizedVolatilityBps <
      Math.floor(request.constraints.highVolatilityBps / 3) &&
    width > request.constraints.minimumWidthTicks * 2
  ) {
    proposedDecision = "NARROW";
    desiredWidth = Math.floor(width * 0.75);
  }

  const positionValueUsd = parseFixed(request.position.positionValueUsd);
  const poolLiquidityUsd = parseFixed(request.marketState.poolLiquidityUsd);
  const fees24hUsd = parseFixed(request.marketState.fees24hUsd);
  const horizonRatio =
    (BigInt(request.constraints.evaluationHorizonHours) * FIXED_SCALE) / 24n;
  const poolShare = divideFixed(positionValueUsd, poolLiquidityUsd);
  const feeBase = multiplyFixed(multiplyFixed(fees24hUsd, poolShare), horizonRatio);
  const currentUptimeBps = !inRange
    ? 0
    : edgeDistanceBps < request.constraints.edgeBufferBps
      ? 3_500
      : highVolatility
        ? 5_500
        : 9_000;
  const currentGrossFees = multiplyFixed(feeBase, ratioFromBps(currentUptimeBps));
  const volumeBoundary = request.marketState.volumeMeasurementWindowSeconds
    ? `The 24-hour fee input is a run-rate extrapolated from ${request.marketState.volumeMeasurementWindowSeconds} seconds and ${request.marketState.swapCount ?? 0} onchain swaps.`
    : "Fee estimates use the frozen pool-share and uptime model, not guaranteed future volume.";

  if (proposedDecision === null) {
    return LpRebalanceDeliverableSchema.parse({
      schemaVersion: "positioncrew.lp-rebalance.deliverable.v1",
      service: "LP_REBALANCE",
      requestId: request.requestId,
      generatedAt: now.toISOString(),
      expiresAt: evidence.expiresAt,
      status: "NO_ACTION",
      decision: "HOLD",
      proposedRange: null,
      estimatedRebalanceCostUsd: "0",
      expectedGrossFeesUsd: formatFixed(currentGrossFees, 6),
      expectedNetBenefitUsd: "0",
      breakEvenHours: null,
      inventoryExposure: {
        token0Bps: request.position.token0ShareBps,
        token1Bps: request.position.token1ShareBps,
      },
      summary: "The LP remains safely inside its range and no rebalance clears the policy gate.",
      actionSteps: [],
      invalidationConditions: [
        `Current tick approaches within ${request.constraints.edgeBufferBps} bps of either range edge.`,
        `Realized volatility reaches ${request.constraints.highVolatilityBps} bps.`,
      ],
      limitations: [
        volumeBoundary,
      ],
    });
  }

  const proposedRange = boundedLpRange(request, desiredWidth);
  if (!proposedRange) {
    return refusal(request, now, "REFUSED_CONSTRAINTS", evidence.expiresAt, [
      "No tick-aligned range containing the current tick fits both width bounds and the V3 tick domain.",
    ]);
  }
  const inventory = lpInventoryExposure(request, proposedRange);
  if (!inventory || inventory.maximumToken0Bps > request.constraints.maximumToken0ShareBps ||
      inventory.maximumToken1Bps > request.constraints.maximumToken1ShareBps) {
    return refusal(request, now, "REFUSED_CONSTRAINTS", evidence.expiresAt, [
      "The proposed V3 inventory, valued with the supplied prices across the current tick interval, exceeds a token-share cap or cannot be calculated.",
    ]);
  }
  const proposedWidth = proposedRange.upperTick - proposedRange.lowerTick;
  if (proposedRange.lowerTick === request.position.lowerTick && proposedRange.upperTick === request.position.upperTick) {
    return LpRebalanceDeliverableSchema.parse({
      schemaVersion: "positioncrew.lp-rebalance.deliverable.v1", service: "LP_REBALANCE",
      requestId: request.requestId, generatedAt: now.toISOString(), expiresAt: evidence.expiresAt,
      status: "NO_ACTION", decision: "HOLD", proposedRange: null,
      estimatedRebalanceCostUsd: "0", expectedGrossFeesUsd: formatFixed(currentGrossFees, 6),
      expectedNetBenefitUsd: "0", breakEvenHours: null,
      inventoryExposure: { token0Bps: request.position.token0ShareBps, token1Bps: request.position.token1ShareBps },
      summary: "No feasible range change remains after tick alignment and width limits; keep the existing position.",
      actionSteps: [], invalidationConditions: ["Refresh if the position, volatility or buyer limits change."],
      limitations: ["An unchanged range is not credited with improved fee uptime or hypothetical rebalance profit.", volumeBoundary],
    });
  }
  proposedDecision = proposedWidth > width ? "WIDEN" : proposedWidth < width ? "NARROW" : "SHIFT";
  const widthDensity = (BigInt(width) * FIXED_SCALE) / BigInt(proposedWidth);
  const proposedUptimeBps = proposedDecision === "NARROW" ? 7_500 : 9_500;
  const expectedGrossFees = multiplyFixed(
    multiplyFixed(feeBase, widthDensity),
    ratioFromBps(proposedUptimeBps),
  );
  const gasUsd = parseFixed(request.constraints.estimatedGasUsd);
  const swapCostUsd = parseFixed(request.constraints.estimatedSwapCostUsd);
  const totalCostUsd = gasUsd + swapCostUsd;
  const incrementalFees = expectedGrossFees - currentGrossFees;
  const netBenefit = clampNonNegative(incrementalFees - totalCostUsd);
  const economicsPass =
    incrementalFees > 0n &&
    incrementalFees >= totalCostUsd &&
    netBenefit >= parseFixed(request.constraints.minimumNetBenefitUsd) &&
    gasUsd <= parseFixed(request.maxGasUsd) &&
    totalCostUsd <= parseFixed(request.maxActionUsd);

  if (!economicsPass) {
    return LpRebalanceDeliverableSchema.parse({
      schemaVersion: "positioncrew.lp-rebalance.deliverable.v1",
      service: "LP_REBALANCE",
      requestId: request.requestId,
      generatedAt: now.toISOString(),
      expiresAt: evidence.expiresAt,
      status: "NO_ACTION",
      decision: "HOLD",
      proposedRange: null,
      estimatedRebalanceCostUsd: "0",
      expectedGrossFeesUsd: formatFixed(currentGrossFees, 6),
      expectedNetBenefitUsd: "0",
      breakEvenHours: null,
      inventoryExposure: {
        token0Bps: request.position.token0ShareBps,
        token1Bps: request.position.token1ShareBps,
      },
      summary: "A range change was considered but rejected after costs and inventory limits.",
      actionSteps: [],
      invalidationConditions: ["Pool fees, volatility, range position, or execution costs change."],
      limitations: [
        `Projected net benefit ${formatFixed(netBenefit, 6)} USD does not clear ${request.constraints.minimumNetBenefitUsd} USD.`,
      ],
    });
  }

  const breakEvenHours = divideFixed(
    totalCostUsd * BigInt(request.constraints.evaluationHorizonHours), incrementalFees,
  );
  return LpRebalanceDeliverableSchema.parse({
    schemaVersion: "positioncrew.lp-rebalance.deliverable.v1",
    service: "LP_REBALANCE",
    requestId: request.requestId,
    generatedAt: now.toISOString(),
    expiresAt: evidence.expiresAt,
    status: "ACTIONABLE",
    decision: proposedDecision,
    proposedRange,
    estimatedRebalanceCostUsd: formatFixed(totalCostUsd, 18),
    expectedGrossFeesUsd: formatFixed(expectedGrossFees, 18),
    expectedNetBenefitUsd: formatFixed(netBenefit, 18),
    breakEvenHours: formatFixed(breakEvenHours, 18),
    feeProjection: { model: "POOL_SHARE_UPTIME_V1", currentUptimeBps, proposedUptimeBps },
    inventoryExposure: { token0Bps: inventory.token0Bps, token1Bps: inventory.token1Bps },
    summary: `${proposedDecision} the LP range to ${proposedRange.lowerTick}..${proposedRange.upperTick}; modeled net benefit is ${formatFixed(netBenefit, 2)} USD after costs, assuming ${currentUptimeBps / 100}% current and ${proposedUptimeBps / 100}% proposed fee uptime.`,
    actionSteps: [
      "Collect fees and remove the current liquidity position.",
      `Rebalance inventory within ${request.maxSlippageBps} bps slippage.`,
      `Mint the replacement position at ticks ${proposedRange.lowerTick} and ${proposedRange.upperTick}.`,
    ],
    invalidationConditions: [
      `Current tick changes materially from ${request.marketState.currentTick}.`,
      `Gas exceeds ${request.maxGasUsd} USD or swap cost exceeds ${request.constraints.estimatedSwapCostUsd} USD.`,
      `Current time passes ${evidence.expiresAt}.`,
    ],
    limitations: [
      `Fee uptime is a model assumption, not a forecast: current ${currentUptimeBps / 100}%, proposed ${proposedUptimeBps / 100}%. Fees may not cover costs.`,
      ...(request.marketState.volumeMeasurementWindowSeconds ? [volumeBoundary] : []),
      "V3 inventory uses supplied USD prices and token decimals; share caps include both ends of the current tick interval plus a rounding margin. Revalidate prices, sqrt price and execution amounts before any transaction.",
    ],
  });
}
