import type { BoundedGridRequest } from "../contracts/bounded-grid.js";
import { ceilDivide, FIXED_SCALE, parseFixed } from "../core/fixed.js";

/**
 * Sufficient request-only proofs that no admitted two-sided grid can satisfy a
 * hard constraint. False means unproven, not that a profitable grid exists.
 *
 * This deliberately does not reproduce the native grid's price ladder, budget
 * split, search, or profit forecast. An external provider may choose different
 * in-range prices and use less than the requested capital or level count.
 * Evidence freshness and non-constraint refusal statuses are checked elsewhere.
 */
export function gridConstraintRefusalJustified(request: BoundedGridRequest): boolean {
  const lower = parseFixed(request.constraints.lowerPrice);
  const mid = parseFixed(request.marketState.midPrice);
  const upper = parseFixed(request.constraints.upperPrice);
  if (lower >= mid || mid >= upper
    || parseFixed(request.marketState.liquidityUsd) < parseFixed(request.constraints.minimumLiquidityUsd)
    || request.marketState.realizedVolatilityBps > request.constraints.maximumVolatilityBps) {
    return true;
  }

  const gas = parseFixed(request.constraints.estimatedGasUsd);
  if (gas > parseFixed(request.maxGasUsd)) return true;

  // Any admitted grid contains at least one positive BUY and one positive SELL.
  // Each needs at least one base-token quantum, regardless of the strategy.
  const baseQuantum = 10n ** BigInt(18 - request.baseAsset.decimals);
  const quoteQuantum = 10n ** BigInt(18 - request.quoteAsset.decimals);
  const minimumBuyReservation = ceilDivide(lower * baseQuantum, FIXED_SCALE * quoteQuantum) * quoteQuantum;
  const minimumInitialSellCost = ceilDivide(mid * baseQuantum, FIXED_SCALE);
  const minimumPrincipal = minimumBuyReservation + minimumInitialSellCost;
  const minimumInventory = ceilDivide(2n * baseQuantum * upper, FIXED_SCALE);

  // These are optimistic lower bounds: more orders, larger quantities, fees,
  // and slippage can only increase them. Equality alone is not a refusal proof.
  return minimumPrincipal > parseFixed(request.constraints.capitalUsd)
    || minimumPrincipal > parseFixed(request.maxActionUsd)
    || minimumInventory > parseFixed(request.constraints.maximumInventoryUsd)
    || minimumPrincipal + gas > parseFixed(request.constraints.maximumLossUsd);
}
