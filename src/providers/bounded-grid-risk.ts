import type { BoundedGridDeliverable } from "../contracts/bounded-grid.js";
import { ceilDivide, FIXED_SCALE, parseFixed } from "../core/fixed.js";

/** Finite, unlevered order set; quote is USD and mark price does not exceed upperPrice. */
export function calculateBoundedGridRisk(
  orders: BoundedGridDeliverable["orders"],
  midPrice: bigint,
  upperPrice: bigint,
) {
  let initialBase = 0n;
  let purchasedBase = 0n;
  let buyQuote = 0n;
  let deployedNotional = 0n;
  for (const order of orders) {
    const base = parseFixed(order.baseAmount);
    const quote = parseFixed(order.maximumQuoteAmount);
    deployedNotional += quote;
    if (order.side === "SELL") initialBase += base;
    else {
      purchasedBase += base;
      buyQuote += quote;
    }
  }
  // Sells can all remain unfilled while every buy fills, in any order or fraction.
  const maximumBase = initialBase + purchasedBase;
  return {
    deployedNotional,
    maximumInventory: ceilDivide(maximumBase * upperPrice, FIXED_SCALE),
    // Zero-price stress includes existing sell inventory and every buy reservation.
    principalAtRisk: ceilDivide(initialBase * midPrice, FIXED_SCALE) + buyQuote,
  };
}
