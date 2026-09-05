import type { LpRebalanceRequest } from "../contracts/lp-rebalance.js";

export const MIN_V3_TICK = -887272;
export const MAX_V3_TICK = 887272;

/** Choose a feasible aligned width first; never round two halves outwards. */
export function boundedLpRange(request: LpRebalanceRequest, desiredWidth: number) {
  const { tickSpacing: spacing, minimumWidthTicks, maximumWidthTicks } = request.constraints;
  const tick = request.marketState.currentTick;
  const lowest = Math.ceil(MIN_V3_TICK / spacing) * spacing;
  const highest = Math.floor(MAX_V3_TICK / spacing) * spacing;
  const minimumSteps = Math.max(1, Math.ceil(minimumWidthTicks / spacing));
  const maximumSteps = Math.min(Math.floor(maximumWidthTicks / spacing), (highest - lowest) / spacing);
  if (!Number.isSafeInteger(spacing) || !Number.isSafeInteger(minimumSteps) ||
      !Number.isSafeInteger(maximumSteps) || minimumSteps > maximumSteps ||
      tick < lowest || tick >= highest) return null;
  const steps = Math.max(minimumSteps, Math.min(maximumSteps, Math.round(desiredWidth / spacing)));
  const width = steps * spacing;
  const lowerTick = Math.max(lowest, Math.min(highest - width,
    Math.floor((tick - width / 2) / spacing) * spacing));
  const upperTick = lowerTick + width;
  if (width < minimumWidthTicks || width > maximumWidthTicks ||
      lowerTick % spacing !== 0 || upperTick % spacing !== 0 ||
      tick < lowerTick || tick >= upperTick) return null;
  return { lowerTick, upperTick };
}

/**
 * V3 liquidity amounts, valued using the supplied USD prices and token decimals.
 * Tick-only input hides the fractional tick: use both endpoints for cap checks.
 * This is a snapshot screening model, not a swap quote or execution guarantee.
 */
export function lpInventoryExposure(request: LpRebalanceRequest, range: { lowerTick: number; upperTick: number }) {
  const { lowerTick, upperTick } = range;
  const current = request.marketState.currentTick;
  if (lowerTick < MIN_V3_TICK || upperTick > MAX_V3_TICK || lowerTick >= upperTick ||
      current < MIN_V3_TICK || current >= MAX_V3_TICK) return null;
  const a = Math.exp(Math.log1p(0.0001) * lowerTick / 2);
  const b = Math.exp(Math.log1p(0.0001) * upperTick / 2);
  const usd0 = Number(request.marketState.token0PriceUsd) / 10 ** request.token0.decimals;
  const usd1 = Number(request.marketState.token1PriceUsd) / 10 ** request.token1.decimals;
  function shareAt(tick: number) {
    const s = Math.max(a, Math.min(b, Math.exp(Math.log1p(0.0001) * tick / 2)));
    const value0 = (b - s) / (s * b) * usd0;
    const value1 = (s - a) * usd1;
    return value0 / (value0 + value1) * 10_000;
  }
  const start = shareAt(current);
  const end = shareAt(Math.min(current + 1, MAX_V3_TICK));
  if (![start, end].every(Number.isFinite)) return null;
  const token0Bps = Math.max(0, Math.min(10_000, Math.floor(start)));
  // One additional bp absorbs floating-point approximation; exact all-token
  // endpoints remain 0/10000. Financial validation recomputes independently.
  const conservativeCeil = (value: number) => value <= 0 ? 0 : Math.min(10_000, Math.ceil(value) + 1);
  return {
    token0Bps,
    token1Bps: 10_000 - token0Bps,
    maximumToken0Bps: conservativeCeil(Math.max(start, end)),
    maximumToken1Bps: conservativeCeil(Math.max(10_000 - start, 10_000 - end)),
  };
}
