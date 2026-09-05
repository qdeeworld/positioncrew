import {
  LendingRescueDeliverableSchema,
  LendingRescueRequestSchema,
  type LendingRescueDeliverable,
  type LendingRescueRequest,
} from "../contracts/lending-rescue.js";
import {
  FIXED_SCALE,
  formatFixed,
  parseFixed,
  ratioFromBps,
} from "../core/fixed.js";
import {
  buildLendingActionCandidates,
  calculateLendingPosition,
} from "../domain/lending-math.js";

function sourceIntegrityProblems(request: LendingRescueRequest, nowMs: number): string[] {
  const sources = new Map(request.sources.map((source) => [source.sourceId, source]));
  const problems: string[] = [];
  const pricedEntries = [...request.position.collateral, ...request.position.debt];

  for (const entry of pricedEntries) {
    const source = sources.get(entry.sourceId);
    if (!source) {
      problems.push(`Missing source record ${entry.sourceId} for ${entry.symbol}`);
      continue;
    }
    const observedMs = Date.parse(entry.observedAt);
    if (observedMs > nowMs) {
      problems.push(`Future-dated price observation for ${entry.symbol}`);
    }
    if (entry.observedAt !== source.observedAt) {
      problems.push(`Source timestamp mismatch for ${entry.symbol}`);
    }
  }
  return problems;
}

function staleSources(request: LendingRescueRequest, nowMs: number): string[] {
  return request.sources
    .filter(
      (source) => nowMs - Date.parse(source.observedAt) > request.maxDataAgeSeconds * 1_000,
    )
    .map((source) => source.sourceId);
}

function resultExpiry(request: LendingRescueRequest): string {
  const sourceExpiry = Math.min(
    ...request.sources.map(
      (source) => Date.parse(source.observedAt) + request.maxDataAgeSeconds * 1_000,
    ),
  );
  return new Date(Math.min(Date.parse(request.deadline), sourceExpiry)).toISOString();
}

export function createLendingRescueDeliverable(
  input: LendingRescueRequest,
  now: Date,
): LendingRescueDeliverable {
  const request = LendingRescueRequestSchema.parse(input);
  const nowMs = now.getTime();
  const current = calculateLendingPosition(request);
  const stressed = calculateLendingPosition(
    request,
    FIXED_SCALE - ratioFromBps(request.stressPriceDropBps),
  );
  const position = {
    collateralValueUsd: formatFixed(current.collateralValueUsd, 6),
    liquidationWeightedCollateralUsd: formatFixed(
      current.liquidationWeightedCollateralUsd,
      6,
    ),
    debtValueUsd: formatFixed(current.debtValueUsd, 6),
    currentHealthFactor:
      current.healthFactor === null ? null : formatFixed(current.healthFactor, 8),
    stressedHealthFactor:
      stressed.healthFactor === null ? null : formatFixed(stressed.healthFactor, 8),
    targetHealthFactor: request.targetHealthFactor,
  };
  const common = {
    schemaVersion: "positioncrew.lending-rescue.deliverable.v1" as const,
    service: "LENDING_RESCUE" as const,
    requestId: request.requestId,
    generatedAt: now.toISOString(),
    expiresAt: resultExpiry(request),
    position,
    invalidationConditions: [
      `Any collateral or debt balance changes after ${request.requestedAt}`,
      `Any source price moves more than ${request.oracleDeviationToleranceBps} bps`,
      `Current time passes ${resultExpiry(request)}`,
    ],
    limitations: [
      "This result is a bounded action plan, not custody or guaranteed execution.",
      "Projected health factor depends on the supplied protocol thresholds and fresh prices.",
      "Version 1 returns one single-asset rescue action; it does not split repayment across assets.",
    ],
    sources: request.sources,
  };

  if (nowMs >= Date.parse(request.deadline)) {
    return LendingRescueDeliverableSchema.parse({
      ...common,
      status: "REFUSED_EXPIRED",
      decision: "NONE",
      summary: "Request expired before a safe rescue could be produced.",
      recommendation: null,
      alternatives: [],
      refusalReasons: ["The request deadline has passed."],
    });
  }

  const integrityProblems = sourceIntegrityProblems(request, nowMs);
  if (integrityProblems.length > 0) {
    return LendingRescueDeliverableSchema.parse({
      ...common,
      status: "REFUSED_INCONSISTENT_DATA",
      decision: "NONE",
      summary: "Position data is internally inconsistent; no action was proposed.",
      recommendation: null,
      alternatives: [],
      refusalReasons: integrityProblems,
    });
  }

  const stale = staleSources(request, nowMs);
  if (stale.length > 0) {
    return LendingRescueDeliverableSchema.parse({
      ...common,
      status: "REFUSED_STALE_DATA",
      decision: "NONE",
      summary: "Price data is stale; no capital action was proposed.",
      recommendation: null,
      alternatives: [],
      refusalReasons: stale.map((sourceId) => `Source ${sourceId} exceeded the freshness limit.`),
    });
  }

  if (request.position.collateral.length === 0 || request.position.debt.length === 0) {
    return LendingRescueDeliverableSchema.parse({
      ...common,
      status: "REFUSED_CONSTRAINTS",
      decision: "NONE",
      summary: "No complete Venus collateral-and-debt position was available for rescue analysis.",
      recommendation: null,
      alternatives: [],
      refusalReasons: [
        "A lending rescue requires at least one observed collateral balance and one observed debt balance.",
      ],
    });
  }

  if (current.debtValueUsd === 0n || current.healthFactor === null) {
    return LendingRescueDeliverableSchema.parse({
      ...common,
      status: "NO_ACTION",
      decision: "NONE",
      summary: "No outstanding debt requires a rescue action.",
      recommendation: null,
      alternatives: [],
      refusalReasons: [],
    });
  }

  if (current.healthFactor >= parseFixed(request.targetHealthFactor)) {
    return LendingRescueDeliverableSchema.parse({
      ...common,
      status: "NO_ACTION",
      decision: "NONE",
      summary: `Health factor ${formatFixed(current.healthFactor, 4)} already meets the ${request.targetHealthFactor} target.`,
      recommendation: null,
      alternatives: [],
      refusalReasons: [],
    });
  }

  const candidates = buildLendingActionCandidates(request, current);
  const recommendation = candidates[0]?.plan;
  if (!recommendation) {
    return LendingRescueDeliverableSchema.parse({
      ...common,
      status: "REFUSED_CONSTRAINTS",
      decision: "NONE",
      summary: "No allowed rescue action fits the wallet inventory and safety limits.",
      recommendation: null,
      alternatives: [],
      refusalReasons: [
        `Required action exceeds ${request.maxActionUsd} USD, available assets, or the ${request.maxGasUsd} USD gas ceiling.`,
      ],
    });
  }

  return LendingRescueDeliverableSchema.parse({
    ...common,
    status: "ACTIONABLE",
    decision: recommendation.kind,
    summary: recommendation.kind === "REPAY_DEBT" && recommendation.projectedHealthFactor === null
      ? `Repay ${recommendation.amount} ${recommendation.asset.symbol} to clear all observed debt. Projected health: no debt.`
      : `${recommendation.kind === "REPAY_DEBT" ? "Repay" : "Add"} ${recommendation.amount} ${recommendation.asset.symbol} to raise health factor from ${position.currentHealthFactor} to ${recommendation.projectedHealthFactor}.`,
    recommendation,
    alternatives: candidates.slice(1).map((candidate) => candidate.plan),
    refusalReasons: [],
  });
}
