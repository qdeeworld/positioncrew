import {
  YieldOptimizationRequestSchema,
  type YieldOptimizationRequest,
} from "../contracts/yield-optimization.js";
import { minimum, parseFixed } from "../core/fixed.js";

const riskRank = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;
const protocolKey = (value: string): string => value.trim().toLowerCase();
type Position = YieldOptimizationRequest["currentPositions"][number];
const assetKey = (position: Position): string =>
  `${position.asset.address.toLowerCase()}:${position.asset.decimals}`;

/**
 * Sufficient request-only proofs that no positive funded Yield destination can
 * satisfy the hard constraints. False means unproven, not that a migration is
 * profitable or feasible. No allocation, ordering, or strategy is reproduced.
 * Evidence freshness and other refusal classifications are checked separately.
 */
export function yieldConstraintRefusalJustified(input: YieldOptimizationRequest): boolean {
  const parsed = YieldOptimizationRequestSchema.safeParse(input);
  if (!parsed.success) return false;
  const request = parsed.data;
  const capital = parseFixed(request.capitalUsd);
  const held = request.currentPositions.reduce((sum, position) => sum + parseFixed(position.amountUsd), 0n);
  if (held > capital) return false;

  // Contradictory or duplicated balances are an input-consistency issue, not
  // evidence that an otherwise valid request is blocked by its constraints.
  const markets = new Map<string, string>();
  const identifiers = new Map<string, string>();
  for (const positions of [request.currentPositions, request.opportunities]) {
    if (new Set(positions.map((position) => position.opportunityId)).size !== positions.length) return false;
    for (const position of positions) {
      const market = position.vaultOrMarket.toLowerCase();
      const identity = `${protocolKey(position.protocol)}:${assetKey(position)}`;
      const descriptor = `${market}:${identity}`;
      if (markets.has(market) && markets.get(market) !== identity) return false;
      if (identifiers.has(position.opportunityId) && identifiers.get(position.opportunityId) !== descriptor) return false;
      markets.set(market, identity);
      identifiers.set(position.opportunityId, descriptor);
    }
  }
  if (new Set(request.currentPositions.map((position) => position.vaultOrMarket.toLowerCase())).size
    !== request.currentPositions.length) return false;

  const idle = capital - held;
  const feeLimit = minimum(parseFixed(request.maxGasUsd), parseFixed(request.maxActionUsd));
  const minimumLiquidity = parseFixed(request.constraints.minimumLiquidityUsd);
  const allowlist = new Set(request.constraints.protocolAllowlist.map(protocolKey));
  for (const destination of request.opportunities) {
    if (!allowlist.has(protocolKey(destination.protocol))
      || riskRank[destination.riskTier] > riskRank[request.constraints.maximumRiskTier]
      || destination.lockupSeconds > request.constraints.maximumLockupSeconds
      || parseFixed(destination.liquidityUsd) < minimumLiquidity
      || minimum(parseFixed(destination.amountUsd), parseFixed(destination.liquidityUsd)) <= 0n) continue;

    const entry = parseFixed(destination.estimatedEntryCostUsd);
    if (entry > feeLimit || entry >= capital) continue;

    // For any used holding, withdrawal minus its mandatory quoted exit fee is
    // at most max(0, capacity - exit fee). A source whose entry+exit exceeds a
    // fee cap cannot be used. Ignoring the aggregate fee cap, concentration,
    // foregone yield, and destination-vault exclusion only enlarges this bound.
    let optimisticFunding = idle;
    for (const source of request.currentPositions) {
      if (source.lockupSeconds !== 0 || assetKey(source) !== assetKey(destination)) continue;
      const exit = parseFixed(source.estimatedExitCostUsd);
      if (entry + exit > feeLimit) continue;
      const capacity = minimum(parseFixed(source.amountUsd), parseFixed(source.liquidityUsd));
      if (capacity > exit) optimisticFunding += capacity - exit;
    }
    // Positive allocation requires funding strictly greater than the entry
    // cost. Keep all 18 decimal places; even one remaining unit is unproven.
    if (optimisticFunding > entry) return false;
  }
  return true;
}
