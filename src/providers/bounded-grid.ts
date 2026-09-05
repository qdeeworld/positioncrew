import {
  BoundedGridDeliverableSchema,
  BoundedGridRequestSchema,
  type BoundedGridDeliverable,
  type BoundedGridRequest,
  type GridOrderSchema,
} from "../contracts/bounded-grid.js";
import type { z } from "zod";
import {
  FIXED_SCALE,
  ceilDivide,
  divideFixed,
  formatFixed,
  parseFixed,
} from "../core/fixed.js";
import { clampNonNegative, validateEvidence } from "./provider-utils.js";
import { calculateBoundedGridRisk } from "./bounded-grid-risk.js";
import { calculateGridCycleEconomics } from "../core/grid-cycle-economics.js";

type GridOrder = z.infer<typeof GridOrderSchema>;

function emptyResult(
  request: BoundedGridRequest,
  now: Date,
  expiresAt: string,
  status: BoundedGridDeliverable["status"],
  summary: string,
  limitations: string[],
): BoundedGridDeliverable {
  return BoundedGridDeliverableSchema.parse({
    schemaVersion: "positioncrew.bounded-grid.deliverable.v1",
    service: "BOUNDED_GRID",
    requestId: request.requestId,
    generatedAt: now.toISOString(),
    expiresAt,
    status,
    decision: status === "NO_ACTION" ? "NO_GRID" : "NONE",
    orders: [],
    grossSpreadCaptureUsd: "0",
    estimatedFeesUsd: "0",
    estimatedSlippageUsd: "0",
    estimatedGasUsd: "0",
    expectedNetProfitUsd: "0",
    riskModel: "FINITE_GRID_ZERO_PRICE_STRESS_V1",
    worstCaseLossUsd: "0",
    maximumInventoryUsd: "0",
    summary,
    cancellationConditions: ["Refresh market evidence before constructing another grid."],
    limitations,
  });
}

export function createBoundedGridDeliverable(
  input: BoundedGridRequest,
  now: Date,
): BoundedGridDeliverable {
  const request = BoundedGridRequestSchema.parse(input);
  const evidence = validateEvidence({
    sources: request.sources,
    observations: [request.marketState],
    requestedAt: request.requestedAt,
    deadline: request.deadline,
    maxDataAgeSeconds: request.maxDataAgeSeconds,
    now,
  });
  if (evidence.status !== "OK") {
    return emptyResult(
      request,
      now,
      evidence.expiresAt,
      evidence.status,
      "Grid evidence is unsafe or expired; no orders were proposed.",
      evidence.reasons,
    );
  }

  const mid = parseFixed(request.marketState.midPrice);
  const lower = parseFixed(request.constraints.lowerPrice);
  const upper = parseFixed(request.constraints.upperPrice);
  const capital = parseFixed(request.constraints.capitalUsd);
  const liquidity = parseFixed(request.marketState.liquidityUsd);
  if (
    mid <= lower ||
    mid >= upper ||
    liquidity < parseFixed(request.constraints.minimumLiquidityUsd) ||
    request.marketState.realizedVolatilityBps > request.constraints.maximumVolatilityBps ||
    capital > parseFixed(request.maxActionUsd)
  ) {
    return emptyResult(
      request,
      now,
      evidence.expiresAt,
      "NO_ACTION",
      "The requested grid fails range, liquidity, volatility, or capital policy.",
      ["No order is emitted when any hard market constraint fails."],
    );
  }

  const step = (upper - lower) / BigInt(request.constraints.levelCount - 1);
  const levels = Array.from({ length: request.constraints.levelCount }, (_, index) =>
    lower + ((upper - lower) * BigInt(index)) / BigInt(request.constraints.levelCount - 1),
  );
  const buyLevels = levels.filter((price) => price < mid);
  const sellLevels = levels.filter((price) => price > mid);
  if (buyLevels.length === 0 || sellLevels.length === 0 || step <= 0n) {
    return emptyResult(
      request,
      now,
      evidence.expiresAt,
      "NO_ACTION",
      "The requested range cannot form both buy and sell sides.",
      ["At least one valid level is required on each side of the mid price."],
    );
  }

  const gas = parseFixed(request.constraints.estimatedGasUsd);
  const inventoryLimit = parseFixed(request.constraints.maximumInventoryUsd);
  const lossLimit = parseFixed(request.constraints.maximumLossUsd);
  const baseDecimals = Math.min(18, request.baseAsset.decimals);
  const quoteUnit = FIXED_SCALE / 10n ** BigInt(Math.min(18, request.quoteAsset.decimals));
  function planForBudget(budget: bigint) {
    const buyCapital = budget / 2n;
    const sellCapital = budget - buyCapital;
    const buyQuote = (buyCapital / BigInt(buyLevels.length) / quoteUnit) * quoteUnit;
    const sellQuote = (sellCapital / BigInt(sellLevels.length) / quoteUnit) * quoteUnit;
    const orders: GridOrder[] = [
      ...buyLevels.map((price) => ({
        side: "BUY" as const,
        price: formatFixed(price, 18),
        baseAmount: formatFixed(divideFixed(buyQuote, price), baseDecimals),
        maximumQuoteAmount: formatFixed(buyQuote, 18),
      })),
      ...sellLevels.map((price) => ({
        side: "SELL" as const,
        price: formatFixed(price, 18),
        baseAmount: formatFixed(divideFixed(sellQuote, price), baseDecimals),
        maximumQuoteAmount: formatFixed(sellQuote, 18),
      })),
    ];
    const risk = calculateBoundedGridRisk(orders, mid, upper);
    const cycle = calculateGridCycleEconomics(orders, request.quoteAsset.decimals, request.marketState.venueFeeBps, request.maxSlippageBps);
    const cycles = BigInt(request.constraints.expectedCompletedCycles);
    const nominalForecast = (cycle.chargeNotional * cycles * step) / (2n * mid);
    const executableCeiling = cycle.gross * cycles;
    // Do not raise the old forecast; cap it by matched emitted quantities and prices.
    const grossSpreadCapture = nominalForecast < executableCeiling ? nominalForecast : executableCeiling;
    const fees = cycle.feeBuffer * cycles;
    const slippage = cycle.slippageBuffer * cycles;
    const netProfit = clampNonNegative(grossSpreadCapture - fees - slippage - gas);
    return {
      orders,
      ...risk,
      grossSpreadCapture,
      fees,
      slippage,
      netProfit,
      worstCaseLoss: risk.principalAtRisk + fees + slippage + gas,
    };
  }
  const respectsRiskLimits = (plan: ReturnType<typeof planForBudget>) =>
    plan.maximumInventory <= inventoryLimit && plan.worstCaseLoss <= lossLimit;

  // Risk is monotone in funded order size. Keep unused capital outside this grid.
  let budgetLower = 0n;
  let budgetUpper = capital;
  let plan = planForBudget(capital);
  if (!respectsRiskLimits(plan)) {
    while (budgetLower < budgetUpper) {
      const budget = (budgetLower + budgetUpper + 1n) / 2n;
      if (respectsRiskLimits(planForBudget(budget))) budgetLower = budget;
      else budgetUpper = budget - 1n;
    }
    plan = planForBudget(budgetLower);
  }
  const { orders, grossSpreadCapture, fees, slippage, netProfit, worstCaseLoss, maximumInventory } = plan;
  const economicsPass =
    orders.every((order) => parseFixed(order.baseAmount) > 0n && parseFixed(order.maximumQuoteAmount) > 0n) &&
    grossSpreadCapture > fees + slippage + gas &&
    netProfit >= parseFixed(request.constraints.minimumExpectedNetProfitUsd) &&
    respectsRiskLimits(plan) &&
    gas <= parseFixed(request.maxGasUsd);

  if (!economicsPass) {
    return emptyResult(
      request,
      now,
      evidence.expiresAt,
      "NO_ACTION",
      "No grid size meets the profit target, reachable inventory cap, zero-price stress loss budget, and order precision limits.",
      [
        `After risk sizing: projected net ${formatFixed(netProfit, 6)} USD; zero-price stress loss ${formatFixed(worstCaseLoss, 6)} USD; in-range inventory bound ${formatFixed(maximumInventory, 6)} USD.`,
        "The loss model includes all funded base inventory falling to zero plus estimated costs; it is not an execution-enforced loss guarantee.",
      ],
    );
  }

  const orderExpiry = new Date(
    Math.min(
      Date.parse(evidence.expiresAt),
      now.getTime() + request.constraints.orderExpirySeconds * 1_000,
    ),
  ).toISOString();
  return BoundedGridDeliverableSchema.parse({
    schemaVersion: "positioncrew.bounded-grid.deliverable.v1",
    service: "BOUNDED_GRID",
    requestId: request.requestId,
    generatedAt: now.toISOString(),
    expiresAt: orderExpiry,
    status: "ACTIONABLE",
    decision: "BUILD_GRID",
    orders,
    grossSpreadCaptureUsd: formatFixed(grossSpreadCapture, 18),
    estimatedFeesUsd: formatFixed(fees, 18),
    estimatedSlippageUsd: formatFixed(slippage, 18),
    estimatedGasUsd: formatFixed(gas, 18),
    expectedNetProfitUsd: formatFixed(netProfit, 18),
    riskModel: "FINITE_GRID_ZERO_PRICE_STRESS_V1",
    worstCaseLossUsd: formatFixed(worstCaseLoss, 18),
    maximumInventoryUsd: formatFixed(maximumInventory, 18),
    summary: `Propose ${orders.length} unsigned orders using ${formatFixed(plan.deployedNotional, 2)} USD of the capital budget; projected net ${formatFixed(netProfit, 2)} USD and zero-price stress loss ${formatFixed(worstCaseLoss, 2)} USD.`,
    cancellationConditions: [
      `Cancel at ${orderExpiry}.`,
      `Cancel if volatility exceeds ${request.constraints.maximumVolatilityBps} bps.`,
      `Cancel if available liquidity falls below ${request.constraints.minimumLiquidityUsd} USD.`,
      `Cancel if price leaves ${request.constraints.lowerPrice} to ${request.constraints.upperPrice}; cancellation is not guaranteed.`,
      `Cancel if inventory reaches ${request.constraints.maximumInventoryUsd} USD.`,
    ],
    limitations: [
      `The profit model assumes ${request.constraints.expectedCompletedCycles} completed cycles; fills are not guaranteed.`,
      "Each hypothetical cycle pairs nearest-mid BUY and SELL quantities once; unmatched inventory earns no spread credit. BUY quote debits round up and SELL credits round down per emitted order.",
      "Fees and slippage use executable price-times-quantity notionals, rounded up per fill, with an explicit 2x conservative cost buffer. Quote reservations are not turnover or revenue.",
      "Inventory includes initial SELL base plus every BUY fill, valued at upperPrice, with no SELL fills assumed. Marks above upperPrice can exceed this USD bound.",
      "worstCaseLossUsd is a zero-price stress scenario: initial SELL base valued at midPrice, every BUY reservation, and estimated fees, slippage, and gas.",
      "No hard loss guarantee: gaps, cancellation failures, and costs above estimates are not execution-enforced. A lowerPrice cancellation is not a stop-loss guarantee.",
      "Assumes quote remains worth 1 USD, pre-funded SELL base, no leverage, and each order fills at most once. Replacement orders require a fresh inventory and risk check.",
      "Unused requested capital remains outside the proposed orders. Cycle profit is hypothetical; additional fills require new authorization and risk checks.",
    ],
  });
}
