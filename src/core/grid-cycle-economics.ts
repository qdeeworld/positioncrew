import { FIXED_SCALE, ceilDivide, parseFixed } from "./fixed.js";

interface CycleOrder { side: "BUY" | "SELL"; price: string; baseAmount: string }

// A hypothetical nearest-mid cycle, not a fill forecast or authority to replace orders.
export function calculateGridCycleEconomics(
  orders: readonly CycleOrder[], quoteDecimals: number, feeBps: number, slippageBps: number,
) {
  const quantum = 10n ** BigInt(18 - quoteDecimals);
  const rows = orders.map((order) => ({ side: order.side, price: parseFixed(order.price),
    amount: parseFixed(order.baseAmount), matched: 0n }));
  const compareAmount = (a: typeof rows[number], b: typeof rows[number]) => a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0;
  const buys = rows.filter((row) => row.side === "BUY").sort((a, b) =>
    a.price > b.price ? -1 : a.price < b.price ? 1 : compareAmount(a, b));
  const sells = rows.filter((row) => row.side === "SELL").sort((a, b) =>
    a.price < b.price ? -1 : a.price > b.price ? 1 : compareAmount(a, b));
  let buy = 0, sell = 0;
  while (buy < buys.length && sell < sells.length) {
    const bid = buys[buy]!, ask = sells[sell]!;
    const buyRemaining = bid.amount - bid.matched, sellRemaining = ask.amount - ask.matched;
    const quantity = buyRemaining < sellRemaining ? buyRemaining : sellRemaining;
    bid.matched += quantity;
    ask.matched += quantity;
    if (bid.matched === bid.amount) buy += 1;
    if (ask.matched === ask.amount) sell += 1;
  }
  let debits = 0n, credits = 0n, chargeNotional = 0n, fees = 0n, slippage = 0n;
  for (const row of rows) {
    // Aggregate matches per emitted order before quote rounding.
    const matchedNumerator = row.price * row.matched;
    if (row.side === "BUY") debits += ceilDivide(matchedNumerator, FIXED_SCALE * quantum) * quantum;
    else credits += (matchedNumerator / (FIXED_SCALE * quantum)) * quantum;
    const notional = ceilDivide(row.price * row.amount, FIXED_SCALE * quantum) * quantum;
    chargeNotional += notional;
    fees += ceilDivide(notional * BigInt(feeBps), 10_000n * quantum) * quantum;
    slippage += ceilDivide(notional * BigInt(slippageBps), 10_000n * quantum) * quantum;
  }
  return {
    gross: credits > debits ? credits - debits : 0n,
    chargeNotional,
    // Both sides are already counted; 2x is an explicit conservative cost buffer.
    feeBuffer: fees * 2n,
    slippageBuffer: slippage * 2n,
  };
}
