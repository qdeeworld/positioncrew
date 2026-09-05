import type {
  LendingActionPlan,
  LendingRescueRequest,
} from "../contracts/lending-rescue.js";
import { canonicalHash } from "../core/canonical.js";
import {
  FIXED_SCALE,
  divideFixed,
  fixedTokenAmountFromBaseUnits,
  formatFixed,
  minimum,
  multiplyFixed,
  parseFixed,
  ratioFromBps,
  tokenBaseUnitsForUsd,
} from "../core/fixed.js";

export interface LendingPositionMetrics {
  collateralValueUsd: bigint;
  liquidationWeightedCollateralUsd: bigint;
  debtValueUsd: bigint;
  healthFactor: bigint | null;
}

export interface LendingActionCandidate {
  plan: LendingActionPlan;
  capitalRequiredUsd: bigint;
}

function valueUsd(amount: string, priceUsd: string): bigint {
  return multiplyFixed(parseFixed(amount), parseFixed(priceUsd));
}

export function calculateLendingPosition(
  request: LendingRescueRequest,
  collateralPriceMultiplier = FIXED_SCALE,
): LendingPositionMetrics {
  let collateralValueUsd = 0n;
  let liquidationWeightedCollateralUsd = 0n;
  let debtValueUsd = 0n;

  for (const collateral of request.position.collateral) {
    const currentValue = valueUsd(collateral.amount, collateral.priceUsd);
    const stressedValue = multiplyFixed(currentValue, collateralPriceMultiplier);
    collateralValueUsd += stressedValue;
    if (collateral.collateralEnabled) {
      liquidationWeightedCollateralUsd += multiplyFixed(
        stressedValue,
        ratioFromBps(collateral.liquidationThresholdBps),
      );
    }
  }

  for (const debt of request.position.debt) {
    debtValueUsd += valueUsd(debt.amount, debt.priceUsd);
  }

  return {
    collateralValueUsd,
    liquidationWeightedCollateralUsd,
    debtValueUsd,
    healthFactor:
      debtValueUsd === 0n
        ? null
        : divideFixed(liquidationWeightedCollateralUsd, debtValueUsd),
  };
}

function availableAmount(request: LendingRescueRequest, address: string): bigint {
  const balance = request.availableAssets.find(
    (entry) => entry.address.toLowerCase() === address.toLowerCase(),
  );
  return balance ? parseFixed(balance.availableAmount) : 0n;
}

function actionId(request: LendingRescueRequest, payload: unknown): string {
  return `action_${canonicalHash({ requestId: request.requestId, payload }).slice(7, 31)}`;
}

function executeBefore(request: LendingRescueRequest): string {
  const sourceExpiry = Math.min(
    ...request.sources.map(
      (source) => Date.parse(source.observedAt) + request.maxDataAgeSeconds * 1_000,
    ),
  );
  return new Date(Math.min(Date.parse(request.deadline), sourceExpiry)).toISOString();
}

function commonPlanFields(request: LendingRescueRequest) {
  return {
    chainId: request.chainId,
    protocol: request.protocol,
    market: request.market,
    account: request.account,
    estimatedGasUsd: formatFixed(parseFixed(request.estimatedGasUsd), 6),
    executeBefore: executeBefore(request),
    maxSlippageBps: request.maxSlippageBps,
    preconditions: [
      `Position debt and collateral balances still match request ${request.requestId}`,
      `Oracle deviation remains within ${request.oracleDeviationToleranceBps} bps`,
      `Estimated gas remains at or below ${request.maxGasUsd} USD`,
    ],
  };
}

export function buildLendingActionCandidates(
  request: LendingRescueRequest,
  metrics: LendingPositionMetrics,
): LendingActionCandidate[] {
  if (metrics.debtValueUsd === 0n || metrics.healthFactor === null) {
    return [];
  }

  const target = parseFixed(request.targetHealthFactor);
  if (metrics.healthFactor >= target) {
    return [];
  }

  const maxActionUsd = parseFixed(request.maxActionUsd);
  const maxGasUsd = parseFixed(request.maxGasUsd);
  const estimatedGasUsd = parseFixed(request.estimatedGasUsd);
  if (estimatedGasUsd > maxGasUsd) {
    return [];
  }

  const candidates: LendingActionCandidate[] = [];

  if (request.allowedActions.includes("REPAY_DEBT")) {
    const maximumDebtAtTarget =
      (metrics.liquidationWeightedCollateralUsd * FIXED_SCALE) / target;
    const repayUsd = metrics.debtValueUsd - maximumDebtAtTarget;

    for (const debt of request.position.debt) {
      const priceUsd = parseFixed(debt.priceUsd);
      const amountBaseUnits = tokenBaseUnitsForUsd(repayUsd, priceUsd, debt.decimals);
      const amount = fixedTokenAmountFromBaseUnits(amountBaseUnits, debt.decimals);
      const actualRepayUsd = multiplyFixed(amount, priceUsd);
      const walletAvailable = availableAmount(request, debt.address);
      const debtTokenAmount = parseFixed(debt.amount);
      const cappedRepayUsd = minimum(actualRepayUsd, metrics.debtValueUsd);
      const projectedDebtUsd = metrics.debtValueUsd - cappedRepayUsd;
      const projectedHealthFactor =
        projectedDebtUsd === 0n
          ? null
          : divideFixed(metrics.liquidationWeightedCollateralUsd, projectedDebtUsd);

      if (
        amount <= walletAvailable &&
        amount <= debtTokenAmount &&
        actualRepayUsd <= maxActionUsd &&
        (projectedHealthFactor === null || projectedHealthFactor >= target)
      ) {
        const payload = {
          kind: "REPAY_DEBT" as const,
          asset: debt.address,
          amountBaseUnits: amountBaseUnits.toString(),
        };
        candidates.push({
          capitalRequiredUsd: actualRepayUsd,
          plan: {
            actionId: actionId(request, payload),
            ...commonPlanFields(request),
            kind: "REPAY_DEBT",
            asset: {
              symbol: debt.symbol,
              address: debt.address,
              decimals: debt.decimals,
            },
            amount: formatFixed(amount, debt.decimals),
            amountBaseUnits: amountBaseUnits.toString(),
            amountUsd: formatFixed(actualRepayUsd, 6),
            projectedHealthFactor: projectedHealthFactor === null ? null : formatFixed(projectedHealthFactor, 8),
          },
        });
      }
    }
  }

  if (request.allowedActions.includes("ADD_COLLATERAL")) {
    const requiredWeightedCollateral =
      multiplyFixed(target, metrics.debtValueUsd) -
      metrics.liquidationWeightedCollateralUsd;

    for (const collateral of request.position.collateral) {
      if (!collateral.collateralEnabled) {
        continue;
      }
      const threshold = ratioFromBps(collateral.liquidationThresholdBps);
      const addUsd =
        (requiredWeightedCollateral * FIXED_SCALE + threshold - 1n) / threshold;
      const priceUsd = parseFixed(collateral.priceUsd);
      const amountBaseUnits = tokenBaseUnitsForUsd(
        addUsd,
        priceUsd,
        collateral.decimals,
      );
      const amount = fixedTokenAmountFromBaseUnits(
        amountBaseUnits,
        collateral.decimals,
      );
      const actualAddUsd = multiplyFixed(amount, priceUsd);
      const walletAvailable = availableAmount(request, collateral.address);
      const projectedWeighted =
        metrics.liquidationWeightedCollateralUsd +
        multiplyFixed(actualAddUsd, threshold);
      const projectedHealthFactor = divideFixed(projectedWeighted, metrics.debtValueUsd);

      if (
        amount <= walletAvailable &&
        actualAddUsd <= maxActionUsd &&
        projectedHealthFactor >= target
      ) {
        const payload = {
          kind: "ADD_COLLATERAL" as const,
          asset: collateral.address,
          amountBaseUnits: amountBaseUnits.toString(),
        };
        candidates.push({
          capitalRequiredUsd: actualAddUsd,
          plan: {
            actionId: actionId(request, payload),
            ...commonPlanFields(request),
            kind: "ADD_COLLATERAL",
            asset: {
              symbol: collateral.symbol,
              address: collateral.address,
              decimals: collateral.decimals,
            },
            amount: formatFixed(amount, collateral.decimals),
            amountBaseUnits: amountBaseUnits.toString(),
            amountUsd: formatFixed(actualAddUsd, 6),
            projectedHealthFactor: formatFixed(projectedHealthFactor, 8),
          },
        });
      }
    }
  }

  return candidates.sort((left, right) => {
    if (left.capitalRequiredUsd === right.capitalRequiredUsd) {
      return left.plan.kind.localeCompare(right.plan.kind);
    }
    return left.capitalRequiredUsd < right.capitalRequiredUsd ? -1 : 1;
  });
}
