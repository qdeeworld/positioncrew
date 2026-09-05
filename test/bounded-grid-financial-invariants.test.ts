import { describe, expect, it } from "vitest";
import fixture from "../fixtures/bounded-grid/bnb-usdt-grid.v1.json" with { type: "json" };
import { BoundedGridRequestSchema, type BoundedGridRequest, type BoundedGridDeliverable } from "../src/contracts/bounded-grid.js";
import { createBoundedGridDeliverable } from "../src/providers/bounded-grid.js";

const now = new Date("2026-08-12T16:00:00.000Z");
const unit = 10n ** 18n;

// Independent test arithmetic deliberately does not import the provider's risk helper.
function decimal(value: string) {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * unit + BigInt(fraction.padEnd(18, "0"));
}
function ceiling(numerator: bigint, denominator: bigint) {
  return numerator / denominator + (numerator % denominator === 0n ? 0n : 1n);
}
function request(constraints: Partial<BoundedGridRequest["constraints"]> = {}) {
  return BoundedGridRequestSchema.parse({
    ...structuredClone(fixture),
    constraints: { ...fixture.constraints, minimumExpectedNetProfitUsd: "0", ...constraints },
  });
}
function independentBounds(input: BoundedGridRequest, output: BoundedGridDeliverable) {
  const buys = output.orders.filter((order) => order.side === "BUY");
  const sells = output.orders.filter((order) => order.side === "SELL");
  const initialBase = sells.reduce((sum, order) => sum + decimal(order.baseAmount), 0n);
  const boughtBase = buys.reduce((sum, order) => sum + decimal(order.baseAmount), 0n);
  const buyCost = buys.reduce((sum, order) => sum + decimal(order.maximumQuoteAmount), 0n);
  const notional = output.orders.reduce((sum, order) => sum + decimal(order.maximumQuoteAmount), 0n);
  const turnover = notional * BigInt(input.constraints.expectedCompletedCycles) * 2n;
  const costs = ceiling(turnover * BigInt(input.marketState.venueFeeBps), 10_000n)
    + ceiling(turnover * BigInt(input.maxSlippageBps), 10_000n)
    + decimal(input.constraints.estimatedGasUsd);
  return {
    initialBase,
    inventory: ceiling((initialBase + boughtBase) * decimal(input.constraints.upperPrice), unit),
    principal: ceiling(initialBase * decimal(input.marketState.midPrice), unit) + buyCost,
    loss: ceiling(initialBase * decimal(input.marketState.midPrice), unit) + buyCost + costs,
  };
}

describe("bounded grid financial invariants", () => {
  it("refuses the audited fixture when truthful risk sizing cannot meet its profit target", () => {
    const output = createBoundedGridDeliverable(BoundedGridRequestSchema.parse(fixture), now);
    expect(output.status).toBe("NO_ACTION");
    expect(output.orders).toEqual([]);
    expect(output.summary).toContain("zero-price stress loss budget");
  });

  it("sizes down to the zero-price loss budget and includes existing sell inventory", () => {
    const input = request();
    const output = createBoundedGridDeliverable(input, now);
    expect(output.status).toBe("ACTIONABLE");
    const bounds = independentBounds(input, output);
    expect(decimal(output.worstCaseLossUsd)).toBe(bounds.loss);
    expect(bounds.loss).toBeLessThanOrEqual(decimal(input.constraints.maximumLossUsd));
    expect(bounds.principal).toBeLessThanOrEqual(decimal(input.constraints.capitalUsd));
    expect(decimal(output.maximumInventoryUsd)).toBe(bounds.inventory);
    expect(bounds.inventory).toBeLessThanOrEqual(decimal(input.constraints.maximumInventoryUsd));
    expect(bounds.principal).toBeGreaterThan(decimal(output.worstCaseLossUsd) / 2n);
  });

  it("bounds every partial-fill combination even if sells and cancellation fail", () => {
    const input = request({ maximumLossUsd: "10000" });
    const output = createBoundedGridDeliverable(input, now);
    expect(output.status).toBe("ACTIONABLE");
    const bounds = independentBounds(input, output);
    for (let state = 0; state < 3 ** output.orders.length; state += 1) {
      let choices = state;
      let inventory = bounds.initialBase;
      for (const order of output.orders) {
        const filled = (decimal(order.baseAmount) * BigInt(choices % 3)) / 2n;
        choices = Math.floor(choices / 3);
        inventory += order.side === "BUY" ? filled : -filled;
      }
      expect(inventory).toBeGreaterThanOrEqual(0n);
      for (const mark of [input.constraints.lowerPrice, input.marketState.midPrice, input.constraints.upperPrice]) {
        const value = ceiling(inventory * decimal(mark), unit);
        expect(value).toBeLessThanOrEqual(decimal(output.maximumInventoryUsd));
        expect(value).toBeLessThanOrEqual(decimal(input.constraints.maximumInventoryUsd));
      }
    }
    expect(bounds.inventory).toBe(decimal(output.maximumInventoryUsd));
    expect(bounds.inventory).toBeGreaterThan(decimal("599.999999"));
  });

  it.each([2, 3, 5, 10, 100])("enforces emitted-order bounds for %i asymmetric levels", (levelCount) => {
    const input = request({ levelCount, lowerPrice: "1", upperPrice: "10.1", expectedCompletedCycles: 1, estimatedGasUsd: "0" });
    input.marketState.venueFeeBps = 0;
    input.maxSlippageBps = 0;
    const output = createBoundedGridDeliverable(input, now);
    expect(output.status).toBe("ACTIONABLE");
    const bounds = independentBounds(input, output);
    expect(bounds.inventory).toBeLessThanOrEqual(decimal(input.constraints.maximumInventoryUsd));
    expect(bounds.loss).toBeLessThanOrEqual(decimal(input.constraints.maximumLossUsd));
    for (const order of output.orders) {
      expect(ceiling(decimal(order.price) * decimal(order.baseAmount), unit)).toBeLessThanOrEqual(decimal(order.maximumQuoteAmount));
    }
  });

  it("keeps sub-micro-dollar costs and risk without rounding down", () => {
    const input = request({ capitalUsd: "0.000001", maximumInventoryUsd: "0.000001", maximumLossUsd: "0.000001", estimatedGasUsd: "0.000000000000000001" });
    const output = createBoundedGridDeliverable(input, now);
    expect(output.status).toBe("ACTIONABLE");
    expect(output.estimatedGasUsd).toBe("0.000000000000000001");
    expect(decimal(output.estimatedFeesUsd)).toBeGreaterThan(0n);
    expect(decimal(output.estimatedSlippageUsd)).toBeGreaterThan(0n);
    const bounds = independentBounds(input, output);
    expect(decimal(output.worstCaseLossUsd)).toBe(bounds.loss);
    expect(decimal(output.maximumInventoryUsd)).toBe(bounds.inventory);
  });

  it("preserves tiny positive prices instead of emitting zero-price orders", () => {
    const input = request({ lowerPrice: "0.0000000000009", upperPrice: "0.0000000000011" });
    input.marketState.midPrice = "0.000000000001";
    const output = createBoundedGridDeliverable(input, now);
    expect(output.status).toBe("ACTIONABLE");
    expect(output.orders.every((order) => decimal(order.price) > 0n)).toBe(true);
    expect(independentBounds(input, output).loss).toBeLessThanOrEqual(decimal(input.constraints.maximumLossUsd));
  });

  it("refuses sizes below token precision without throwing a schema error", () => {
    const input = request({ capitalUsd: "0.000000000000000001", estimatedGasUsd: "0" });
    input.baseAsset.decimals = 0;
    input.quoteAsset.decimals = 0;
    expect(createBoundedGridDeliverable(input, now).status).toBe("NO_ACTION");
  });

  it("quantizes order amounts to token precision while keeping quote reservations sufficient", () => {
    const input = request({ maximumLossUsd: "10000" });
    input.baseAsset.decimals = 6;
    input.quoteAsset.decimals = 6;
    const output = createBoundedGridDeliverable(input, now);
    expect(output.status).toBe("ACTIONABLE");
    for (const order of output.orders) {
      expect(decimal(order.baseAmount) % (10n ** 12n)).toBe(0n);
      expect(decimal(order.maximumQuoteAmount) % (10n ** 12n)).toBe(0n);
      expect(ceiling(decimal(order.baseAmount) * decimal(order.price), unit)).toBeLessThanOrEqual(decimal(order.maximumQuoteAmount));
    }
  });

  it("refuses when estimated gas alone exceeds the loss budget", () => {
    const input = request({ maximumLossUsd: "0.5" });
    expect(createBoundedGridDeliverable(input, now).status).toBe("NO_ACTION");
  });

  it("discloses finite-order, price-range, quote-value and cancellation assumptions", () => {
    const output = createBoundedGridDeliverable(request(), now);
    const limitations = output.limitations.join(" ");
    expect(limitations).toContain("Marks above upperPrice can exceed this USD bound");
    expect(limitations).toContain("zero-price stress scenario");
    expect(limitations).toContain("No hard loss guarantee");
    expect(limitations).toContain("quote remains worth 1 USD");
    expect(limitations).toContain("each order fills at most once");
    expect(limitations).toContain("Replacement orders require a fresh inventory and risk check");
  });
});
