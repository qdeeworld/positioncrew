import type { LpRebalanceRequest } from "../contracts/lp-rebalance.js";
import { ceilDivide, parseFixed } from "../core/fixed.js";

/**
 * Sufficient request-only impossibility proofs for the current LP range model.
 * False means unproven, not that a useful rebalance is guaranteed to exist.
 *
 * No native candidate, centered-range search, inventory sampling, or profit
 * forecast participates. Different providers may choose different aligned
 * ranges. Evidence refusals and a strategy's NO_ACTION/HOLD remain separate.
 */
export function lpConstraintRefusalJustified(request: LpRebalanceRequest): boolean {
  const gas = parseFixed(request.constraints.estimatedGasUsd);
  const swap = parseFixed(request.constraints.estimatedSwapCostUsd);
  if (gas > parseFixed(request.maxGasUsd) || gas + swap > parseFixed(request.maxActionUsd)) return true;

  // Every complete replacement position has shares summing to 10,000 bps.
  // Equality is not proof of feasibility or impossibility at rounding margins.
  if (request.constraints.maximumToken0ShareBps + request.constraints.maximumToken1ShareBps < 10_000) return true;

  // Endpoints must be multiples of spacing inside the symmetric V3 domain.
  // All arithmetic is integer: odd widths and domain-edge clipping do not
  // require the native strategy's centered range to exist.
  const spacing = BigInt(request.constraints.tickSpacing);
  const alignedLimit = (887_272n / spacing) * spacing;
  const minimumAlignedWidth = ceilDivide(BigInt(request.constraints.minimumWidthTicks), spacing) * spacing;
  const tick = BigInt(request.marketState.currentTick);
  return minimumAlignedWidth > BigInt(request.constraints.maximumWidthTicks)
    || minimumAlignedWidth > 2n * alignedLimit
    || tick < -alignedLimit
    || tick >= alignedLimit;
}
