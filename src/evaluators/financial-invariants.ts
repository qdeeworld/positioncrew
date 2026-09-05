import type {
  BoundedGridDeliverable, BoundedGridRequest, LendingActionPlan, LendingRescueDeliverable, LendingRescueRequest,
  LpRebalanceDeliverable, LpRebalanceRequest, PositionCrewDeliverable, PositionCrewRequest,
  YieldOptimizationDeliverable, YieldOptimizationRequest,
} from "../contracts/index.js";
import { FIXED_SCALE, ceilDivide, parseFixed } from "../core/fixed.js";

export interface FinancialInvariantCheck { id: string; passed: boolean; detail: string }
const sum = (values: bigint[]): bigint => values.reduce((total, value) => total + value, 0n);
const check = (id: string, passed: boolean, detail: string): FinancialInvariantCheck => ({ id, passed, detail });
const sameAddress = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
const protocolKey = (protocol: string): string => protocol.trim().toLowerCase();
const positivePart = (value: bigint): bigint => value > 0n ? value : 0n;
// Legacy lending reports round USD to six decimals and HF to eight. Policy checks never use this tolerance.
function reported(actual: string | null, expected: bigint | null, decimals = 6): boolean {
  if (actual === null || expected === null) return actual === null && expected === null;
  const difference = parseFixed(actual) - expected;
  return (difference < 0n ? -difference : difference) < 10n ** BigInt(18 - decimals);
}

// Independently derive the V3 amount ratio in log space, without importing range-generation code.
function lpShare0(request: LpRebalanceRequest, lower: number, upper: number, tick: number): number {
  if (tick <= lower) return 10_000;
  if (tick >= upper) return 0;
  const logStep = Math.log(1.0001);
  const logRatio = tick * logStep
    + Math.log(-Math.expm1((lower - tick) * logStep / 2))
    - Math.log(-Math.expm1((tick - upper) * logStep / 2))
    + Math.log(Number(request.marketState.token1PriceUsd)) - Math.log(Number(request.marketState.token0PriceUsd))
    + (request.token0.decimals - request.token1.decimals) * Math.LN10;
  return 10_000 / (1 + Math.exp(logRatio));
}

function lpChecks(request: LpRebalanceRequest, output: LpRebalanceDeliverable): FinancialInvariantCheck[] {
  const exposure = output.inventoryExposure;
  if (output.status !== "ACTIONABLE") return [
    check("lp-inactive-payload", output.actionSteps.length === 0 && output.proposedRange === null
      && (output.decision === "HOLD" || output.decision === "NONE"), "A hold or refusal cannot introduce a range or executable steps."),
    check("lp-current-exposure", exposure.token0Bps === request.position.token0ShareBps && exposure.token1Bps === request.position.token1ShareBps,
      "Inactive output reports the supplied inventory; existing policy violations are not certified safe."),
  ];
  const result = [
    check("lp-action-decision", ["SHIFT", "WIDEN", "NARROW", "EXIT"].includes(output.decision), "An actionable LP result changes or exits the position."),
    check("lp-cost-limits", parseFixed(request.constraints.estimatedGasUsd) <= parseFixed(request.maxGasUsd)
      && parseFixed(output.estimatedRebalanceCostUsd) <= parseFixed(request.maxActionUsd)
      && parseFixed(output.estimatedRebalanceCostUsd) >= parseFixed(request.constraints.estimatedGasUsd) + parseFixed(request.constraints.estimatedSwapCostUsd),
      "Reported cost covers frozen gas and swap estimates and respects the buyer cost and gas ceilings."),
    check("lp-benefit-arithmetic", parseFixed(output.expectedNetBenefitUsd) >= parseFixed(request.constraints.minimumNetBenefitUsd)
      && parseFixed(output.expectedNetBenefitUsd) <= positivePart(parseFixed(output.expectedGrossFeesUsd) - parseFixed(output.estimatedRebalanceCostUsd)),
      "Net benefit cannot exceed gross fees less costs and must clear the requested minimum."),
  ];
  if (output.decision === "EXIT") {
    result.push(check("lp-fee-projection", false,
      "The pool-share uptime model cannot establish positive incremental fee income for an exit; a separate exit-benefit model is required."));
    result.push(check("lp-exit-payload", output.proposedRange === null, "An exit must not introduce a new liquidity range."));
    result.push(check("lp-exit-exposure", exposure.token0Bps === request.position.token0ShareBps && exposure.token1Bps === request.position.token1ShareBps
      && exposure.token0Bps <= request.constraints.maximumToken0ShareBps && exposure.token1Bps <= request.constraints.maximumToken1ShareBps,
      "The v1 exit retains the observed mix and satisfies both caps; an unspecified conversion is not assumed."));
    return result;
  }
  const range = output.proposedRange;
  const valid = range !== null && Number.isSafeInteger(range.lowerTick) && Number.isSafeInteger(range.upperTick)
    && range.lowerTick >= -887_272 && range.upperTick <= 887_272 && range.lowerTick < range.upperTick
    && range.lowerTick % request.constraints.tickSpacing === 0 && range.upperTick % request.constraints.tickSpacing === 0;
  result.push(check("lp-range-domain-alignment", valid, "Final V3 ticks are ordered, spacing aligned, and inside [-887272, 887272]."));
  if (!valid || range === null) return result;
  const width = range.upperTick - range.lowerTick;
  result.push(check("lp-final-width", width >= request.constraints.minimumWidthTicks && width <= request.constraints.maximumWidthTicks,
    `Final width ${width} must satisfy both requested width bounds after rounding.`));
  result.push(check("lp-current-tick-contained", range.lowerTick <= request.marketState.currentTick && request.marketState.currentTick < range.upperTick,
    "Current tick is inside the final half-open range."));
  const oldWidth = request.position.upperTick - request.position.lowerTick;
  const projection = output.feeProjection;
  result.push(check("lp-fee-projection", projection !== undefined,
    "Actionable range economics require an explicit POOL_SHARE_UPTIME_V1 projection; uptime is a model assumption, not observed future income."));
  if (projection !== undefined) {
    // Derive the declared model independently from frozen pool data and final ticks.
    // Fixed-point ratios truncate at each operation, as specified by the model.
    const share = parseFixed(request.position.positionValueUsd) * FIXED_SCALE / parseFixed(request.marketState.poolLiquidityUsd);
    const dailyFees = parseFixed(request.marketState.fees24hUsd) * share / FIXED_SCALE;
    const horizonRatio = BigInt(request.constraints.evaluationHorizonHours) * FIXED_SCALE / 24n;
    const feeBase = dailyFees * horizonRatio / FIXED_SCALE;
    const density = BigInt(oldWidth) * FIXED_SCALE / BigInt(width);
    const currentFees = feeBase * BigInt(projection.currentUptimeBps) / 10_000n;
    const proposedFees = (feeBase * density / FIXED_SCALE) * BigInt(projection.proposedUptimeBps) / 10_000n;
    const incrementalFees = proposedFees - currentFees;
    const cost = parseFixed(output.estimatedRebalanceCostUsd);
    result.push(check("lp-fee-arithmetic", parseFixed(output.expectedGrossFeesUsd) === proposedFees
      && incrementalFees > 0n && incrementalFees >= cost
      && parseFixed(output.expectedNetBenefitUsd) === incrementalFees - cost,
      "Gross and incremental fees derive from frozen pool-share, final range density, and disclosed uptime assumptions; net benefit subtracts costs without clamping a loss."));
    result.push(check("lp-break-even", incrementalFees > 0n && output.breakEvenHours !== null
      && parseFixed(output.breakEvenHours) === cost * BigInt(request.constraints.evaluationHorizonHours) * FIXED_SCALE / incrementalFees,
      "Break-even hours equal cost times the evaluation horizon divided by incremental fees, truncated only at fixed-point precision; free actions can report zero."));
  }
  result.push(check("lp-range-decision", (range.lowerTick !== request.position.lowerTick || range.upperTick !== request.position.upperTick)
    && (output.decision !== "WIDEN" || width > oldWidth) && (output.decision !== "NARROW" || width < oldWidth),
    "Widen and narrow labels agree with the emitted range width."));
  const nominal = lpShare0(request, range.lowerTick, range.upperTick, request.marketState.currentTick);
  const next = lpShare0(request, range.lowerTick, range.upperTick, Math.min(request.marketState.currentTick + 1, 887_272));
  const upperBps = (value: number): number => value === 0 ? 0 : Math.min(10_000, Math.ceil(value) + 1);
  result.push(check("lp-exposure-report", Number.isFinite(nominal) && exposure.token0Bps + exposure.token1Bps === 10_000
    && Math.abs(exposure.token0Bps - Math.floor(nominal)) <= 1,
    "Reported shares match independent V3 amounts and USD prices within one display basis point."));
  result.push(check("lp-exposure-limits", Number.isFinite(nominal) && Number.isFinite(next)
    && upperBps(Math.max(nominal, next)) <= request.constraints.maximumToken0ShareBps
    && upperBps(10_000 - Math.min(nominal, next)) <= request.constraints.maximumToken1ShareBps,
    "Both token caps hold across the current tick interval, with upward rounding and a one-basis-point numerical margin."));
  return result;
}

function gridChecks(request: BoundedGridRequest, output: BoundedGridDeliverable): FinancialInvariantCheck[] {
  if (output.status !== "ACTIONABLE") return [check("grid-inactive-payload", output.orders.length === 0
    && (output.decision === "NO_GRID" || output.decision === "NONE"), "Inactive grids cannot contain orders.")];
  const lower = parseFixed(request.constraints.lowerPrice), upper = parseFixed(request.constraints.upperPrice), mid = parseFixed(request.marketState.midPrice);
  const buys = output.orders.filter((order) => order.side === "BUY"), sells = output.orders.filter((order) => order.side === "SELL");
  const initialBase = sum(sells.map((order) => parseFixed(order.baseAmount)));
  const accumulatedBase = initialBase + sum(buys.map((order) => parseFixed(order.baseAmount)));
  const buyReservations = sum(buys.map((order) => parseFixed(order.maximumQuoteAmount)));
  const initialBaseCost = ceilDivide(initialBase * mid, FIXED_SCALE);
  const inventoryBound = ceilDivide(accumulatedBase * upper, FIXED_SCALE);
  const turnover = sum(output.orders.map((order) => parseFixed(order.maximumQuoteAmount))) * BigInt(request.constraints.expectedCompletedCycles);
  const minimumFees = ceilDivide(2n * turnover * BigInt(request.marketState.venueFeeBps), 10_000n);
  const minimumSlippage = ceilDivide(2n * turnover * BigInt(request.maxSlippageBps), 10_000n);
  const fees = parseFixed(output.estimatedFeesUsd), slippage = parseFixed(output.estimatedSlippageUsd), gas = parseFixed(output.estimatedGasUsd);
  const lossBound = initialBaseCost + buyReservations + fees + slippage + gas;
  const step = (upper - lower) / BigInt(request.constraints.levelCount - 1);
  const modeledGrossBound = turnover * step / (2n * mid);
  return [
    check("grid-order-semantics", output.decision === "BUILD_GRID" && buys.length > 0 && sells.length > 0
      && output.orders.length <= request.constraints.levelCount && output.orders.every((order) => {
        const price = parseFixed(order.price), amount = parseFixed(order.baseAmount), quote = parseFixed(order.maximumQuoteAmount);
        return price >= lower && price <= upper && (order.side === "BUY" ? price <= mid : price >= mid)
          && amount % (10n ** BigInt(18 - request.baseAsset.decimals)) === 0n
          && quote % (10n ** BigInt(18 - request.quoteAsset.decimals)) === 0n
          && ceilDivide(price * amount, FIXED_SCALE) <= quote;
      }), "A finite two-sided grid uses precision-valid orders with sufficient quote reservations inside the supplied price range."),
    check("grid-market-policy", lower < mid && mid < upper
      && parseFixed(request.marketState.liquidityUsd) >= parseFixed(request.constraints.minimumLiquidityUsd)
      && request.marketState.realizedVolatilityBps <= request.constraints.maximumVolatilityBps, "Midpoint, liquidity, and volatility satisfy policy."),
    check("grid-funded-capital", initialBaseCost + buyReservations <= parseFixed(request.constraints.capitalUsd)
      && initialBaseCost + buyReservations <= parseFixed(request.maxActionUsd), "Initial sell inventory and every buy reservation fit capital and action limits together."),
    check("grid-accumulated-inventory", inventoryBound <= parseFixed(output.maximumInventoryUsd)
      && parseFixed(output.maximumInventoryUsd) <= parseFixed(request.constraints.maximumInventoryUsd),
      "Initial base plus every buy fill, marked at the upper boundary, fits reported and requested inventory bounds."),
    check("grid-modeled-costs", fees >= minimumFees && slippage >= minimumSlippage
      && gas >= parseFixed(request.constraints.estimatedGasUsd) && gas <= parseFixed(request.maxGasUsd),
      "Frozen-cycle fee and slippage estimates are rounded up; the full gas estimate fits maxGasUsd."),
    check("grid-zero-price-loss", lossBound <= parseFixed(output.worstCaseLossUsd)
      && parseFixed(output.worstCaseLossUsd) <= parseFixed(request.constraints.maximumLossUsd),
      "Zero base price after all buys and no sells loses initial base cost, buy reservations, and modeled costs; cancellation is not a guaranteed stop."),
    check("grid-profit-arithmetic", parseFixed(output.grossSpreadCaptureUsd) <= positivePart(modeledGrossBound)
      && parseFixed(output.expectedNetProfitUsd) <= positivePart(parseFixed(output.grossSpreadCaptureUsd) - fees - slippage - gas)
      && parseFixed(output.expectedNetProfitUsd) >= parseFixed(request.constraints.minimumExpectedNetProfitUsd),
      "The requested completed-cycle model bounds gross spread and net profit after costs; fills are not proven."),
    check("grid-order-expiry", Date.parse(output.expiresAt) - Date.parse(output.generatedAt) <= request.constraints.orderExpirySeconds * 1_000,
      "The grid expires within the requested order lifetime."),
  ];
}

function yieldChecks(request: YieldOptimizationRequest, output: YieldOptimizationDeliverable): FinancialInvariantCheck[] {
  if (output.status !== "ACTIONABLE") return [check("yield-inactive-payload", output.selectedOpportunityId === null
    && parseFixed(output.allocationUsd) === 0n && output.actionSteps.length === 0 && (output.withdrawals?.length ?? 0) === 0
    && (output.decision === "HOLD" || output.decision === "NONE"), "An inactive yield result cannot allocate or withdraw; retained concentrations are not certified safe.")];
  const present = output.withdrawals !== undefined && output.idleCapitalUsedUsd !== undefined && output.finalProtocolAllocations !== undefined
    && output.remainingIdleCapitalUsd !== undefined && output.postMigrationCapitalUsd !== undefined;
  const result = [check("yield-funding-evidence", present, "Actionable yield requires explicit withdrawals, idle funding, post-cost capital, and final protocol allocations.")];
  result.push(check("yield-opportunity-identities",
    new Set(request.opportunities.map((item) => item.opportunityId)).size === request.opportunities.length &&
      new Set(request.opportunities.map((item) => item.vaultOrMarket.toLowerCase())).size === request.opportunities.length,
    "Opportunity IDs and destination addresses are unique; the selected identifier cannot hide conflicting protocol or economic terms."));
  if (!present) return result;
  const selected = request.opportunities.find((item) => item.opportunityId === output.selectedOpportunityId);
  result.push(check("yield-selected-opportunity", selected !== undefined, "Selected opportunity belongs to the frozen request."));
  if (!selected) return result;
  const capital = parseFixed(request.capitalUsd), held = sum(request.currentPositions.map((item) => parseFixed(item.amountUsd)));
  const allocation = parseFixed(output.allocationUsd), cost = parseFixed(output.migrationCostUsd), idleUsed = parseFixed(output.idleCapitalUsedUsd!);
  const withdrawn = new Map<string, bigint>();
  let fundingValid = true, routeCost = parseFixed(selected.estimatedEntryCostUsd), foregoneAnnualNumerator = 0n;
  for (const withdrawal of output.withdrawals!) {
    const position = request.currentPositions.find((item) => item.opportunityId === withdrawal.opportunityId);
    const amount = parseFixed(withdrawal.amountUsd);
    if (!position || withdrawn.has(withdrawal.opportunityId) || amount === 0n) { fundingValid = false; continue; }
    withdrawn.set(withdrawal.opportunityId, amount);
    fundingValid &&= amount <= parseFixed(position.amountUsd) && amount <= parseFixed(position.liquidityUsd) && position.lockupSeconds === 0
      && sameAddress(position.asset.address, selected.asset.address) && position.asset.decimals === selected.asset.decimals
      && !sameAddress(position.vaultOrMarket, selected.vaultOrMarket);
    routeCost += parseFixed(position.estimatedExitCostUsd);
    foregoneAnnualNumerator += amount * BigInt(position.grossApyBps);
  }
  const uniquePositions = new Set(request.currentPositions.map((item) => item.opportunityId)).size === request.currentPositions.length
    && new Set(request.currentPositions.map((item) => item.vaultOrMarket.toLowerCase())).size === request.currentPositions.length;
  const withdrawnTotal = sum([...withdrawn.values()]);
  result.push(check("yield-funding-conservation", uniquePositions && held <= capital && fundingValid && allocation > 0n
    && idleUsed <= capital - held && withdrawnTotal + idleUsed === allocation + cost
    && output.decision === (withdrawnTotal > 0n ? "MIGRATE" : "SUPPLY"),
    "Distinct unlocked positions and available idle principal fund the allocation plus costs exactly."));
  result.push(check("yield-cost-limits", cost === routeCost && cost <= parseFixed(request.maxGasUsd) && cost <= parseFixed(request.maxActionUsd),
    "Full entry and actually used exit quotes equal reported route cost and fit gas and action-cost ceilings."));
  const postCapital = capital - cost, remainingIdle = capital - held - idleUsed;
  const protocolAmounts = new Map<string, bigint>();
  for (const position of request.currentPositions) {
    const key = protocolKey(position.protocol);
    protocolAmounts.set(key, (protocolAmounts.get(key) ?? 0n) + parseFixed(position.amountUsd) - (withdrawn.get(position.opportunityId) ?? 0n));
  }
  const selectedProtocol = protocolKey(selected.protocol);
  protocolAmounts.set(selectedProtocol, (protocolAmounts.get(selectedProtocol) ?? 0n) + allocation);
  const positiveAllocations = [...protocolAmounts].filter(([, amount]) => amount > 0n);
  const reportedProtocols = new Map(output.finalProtocolAllocations!.map((item) => [protocolKey(item.protocol), parseFixed(item.amountUsd)]));
  const reportedPositive = new Map([...reportedProtocols].filter(([, amount]) => amount > 0n));
  result.push(check("yield-final-allocation-report", postCapital > 0n && remainingIdle >= 0n
    && parseFixed(output.postMigrationCapitalUsd!) === postCapital && parseFixed(output.remainingIdleCapitalUsd!) === remainingIdle
    && reportedProtocols.size === output.finalProtocolAllocations!.length && reportedPositive.size === positiveAllocations.length
    && positiveAllocations.every(([key, amount]) => reportedPositive.get(key) === amount)
    && sum(positiveAllocations.map(([, amount]) => amount)) + remainingIdle === postCapital,
    "Final protocol holdings and remaining idle funds conserve post-cost portfolio principal."));
  result.push(check("yield-final-protocol-concentration", postCapital > 0n && [...protocolAmounts.values()].every((amount) => amount >= 0n
    && amount * 10_000n <= postCapital * BigInt(request.constraints.maximumProtocolConcentrationBps)),
    "Every retained and destination protocol respects the concentration cap using post-cost capital."));
  const riskRank = { LOW: 0, MEDIUM: 1, HIGH: 2 };
  result.push(check("yield-destination-policy", request.constraints.protocolAllowlist.some((protocol) => protocolKey(protocol) === selectedProtocol)
    && riskRank[selected.riskTier] <= riskRank[request.constraints.maximumRiskTier] && selected.lockupSeconds <= request.constraints.maximumLockupSeconds
    && parseFixed(selected.liquidityUsd) >= parseFixed(request.constraints.minimumLiquidityUsd)
    && allocation <= parseFixed(selected.amountUsd) && allocation <= parseFixed(selected.liquidityUsd) && output.grossApyBps === selected.grossApyBps,
    "Destination respects allowlist, risk, lockup, liquidity, capacity, and APY binding."));
  const annualNumerator = allocation * BigInt(selected.grossApyBps) - foregoneAnnualNumerator;
  const annualUplift = annualNumerator / 10_000n, netBenefit = annualUplift * BigInt(request.constraints.evaluationHorizonDays) / 365n - cost;
  const weightedNumerator = sum(request.currentPositions.map((item) => parseFixed(item.amountUsd) * BigInt(item.grossApyBps)));
  result.push(check("yield-benefit-arithmetic", annualNumerator > 0n && netBenefit >= parseFixed(request.constraints.minimumNetBenefitUsd)
    && parseFixed(output.annualYieldUpliftUsd) === annualUplift && parseFixed(output.netBenefitUsd) === netBenefit
    && BigInt(output.currentWeightedApyBps) === (held > 0n ? weightedNumerator / held : 0n)
    && output.breakEvenDays !== null && annualUplift > 0n && parseFixed(output.breakEvenDays) === cost * 365n * FIXED_SCALE / annualUplift,
    "Uplift compares destination funding with actually withdrawn yield; retained positions remain invested."));
  return result;
}

function lendingChecks(request: LendingRescueRequest, output: LendingRescueDeliverable): FinancialInvariantCheck[] {
  let collateral = 0n, weighted = 0n, stressWeighted = 0n;
  for (const item of request.position.collateral) {
    const value = parseFixed(item.amount) * parseFixed(item.priceUsd) / FIXED_SCALE;
    collateral += value;
    if (item.collateralEnabled) {
      weighted += value * BigInt(item.liquidationThresholdBps) / 10_000n;
      stressWeighted += (value * BigInt(10_000 - request.stressPriceDropBps) / 10_000n) * BigInt(item.liquidationThresholdBps) / 10_000n;
    }
  }
  const debt = sum(request.position.debt.map((item) => parseFixed(item.amount) * parseFixed(item.priceUsd) / FIXED_SCALE));
  const health = debt > 0n ? weighted * FIXED_SCALE / debt : null, stressedHealth = debt > 0n ? stressWeighted * FIXED_SCALE / debt : null;
  const target = parseFixed(request.targetHealthFactor);
  const result = [check("lending-position-values", reported(output.position.collateralValueUsd, collateral)
    && reported(output.position.liquidationWeightedCollateralUsd, weighted) && reported(output.position.debtValueUsd, debt)
    && reported(output.position.currentHealthFactor, health, 8) && reported(output.position.stressedHealthFactor, stressedHealth, 8)
    && parseFixed(output.position.targetHealthFactor) === target,
    "Position USD values and current/stressed health factors are recomputed from balances and thresholds.")];
  const actionValid = (action: LendingActionPlan): boolean => {
    const asset = action.kind === "REPAY_DEBT" ? request.position.debt.find((item) => sameAddress(item.address, action.asset.address))
      : request.position.collateral.find((item) => sameAddress(item.address, action.asset.address) && item.collateralEnabled);
    const available = request.availableAssets.find((item) => sameAddress(item.address, action.asset.address));
    if (!asset || !available || asset.decimals !== action.asset.decimals || available.decimals !== action.asset.decimals) return false;
    const units = BigInt(action.amountBaseUnits), amount = units * FIXED_SCALE / (10n ** BigInt(asset.decimals));
    const value = amount * parseFixed(asset.priceUsd) / FIXED_SCALE;
    let projectedWeighted = weighted, projectedDebt = debt;
    if (action.kind === "REPAY_DEBT") { if (amount > parseFixed(asset.amount)) return false; projectedDebt -= value; }
    else { if (!("liquidationThresholdBps" in asset)) return false; projectedWeighted += value * BigInt(asset.liquidationThresholdBps as number) / 10_000n; }
    const projected = projectedDebt > 0n ? projectedWeighted * FIXED_SCALE / projectedDebt : null;
    return units > 0n && amount === parseFixed(action.amount) && amount <= parseFixed(available.availableAmount)
      && value <= parseFixed(request.maxActionUsd) && reported(action.amountUsd, value)
      && parseFixed(action.estimatedGasUsd) >= parseFixed(request.estimatedGasUsd) && parseFixed(action.estimatedGasUsd) <= parseFixed(request.maxGasUsd)
      && projected !== null && projected >= target && reported(action.projectedHealthFactor, projected, 8)
      && request.allowedActions.includes(action.kind) && action.chainId === request.chainId && action.protocol === request.protocol
      && sameAddress(action.market, request.market) && sameAddress(action.account, request.account) && action.maxSlippageBps <= request.maxSlippageBps
      && Date.parse(action.executeBefore) <= Date.parse(output.expiresAt) && Date.parse(action.executeBefore) > Date.parse(output.generatedAt);
  };
  const incomplete = request.position.collateral.length === 0 || request.position.debt.length === 0;
  result.push(check("decision", output.status === "ACTIONABLE"
    ? !incomplete && health !== null && health < target && output.recommendation !== null && output.decision === output.recommendation.kind
      && actionValid(output.recommendation) && output.alternatives.every(actionValid)
    : output.recommendation === null && output.alternatives.length === 0 && output.decision === "NONE"
      && (output.status !== "NO_ACTION" || !incomplete && (health === null || health >= target))
      && (output.status !== "REFUSED_CONSTRAINTS" || incomplete || health !== null && health < target),
    "Submitted lending actions must be funded, permitted, denominated and bound correctly, and independently reach the target; no native action match is required."));
  return result;
}

/** Declared-constraint checks do not prove future performance, execution, or complete economic optimality. */
export function evaluateFinancialInvariants(request: PositionCrewRequest, output: PositionCrewDeliverable): FinancialInvariantCheck[] {
  if (request.service !== output.service) return [check("financial-service-binding", false, "Financial validation requires the requested service.")];
  switch (request.service) {
    case "LP_REBALANCE": return lpChecks(request, output as LpRebalanceDeliverable);
    case "BOUNDED_GRID": return gridChecks(request, output as BoundedGridDeliverable);
    case "YIELD_OPTIMIZATION": return yieldChecks(request, output as YieldOptimizationDeliverable);
    case "LENDING_RESCUE": return lendingChecks(request, output as LendingRescueDeliverable);
  }
}
