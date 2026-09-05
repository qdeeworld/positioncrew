import { describe, expect, it } from "vitest";
import { effectiveResultExpiry, isResultExpired } from "../web/src/presentation.js";
import type { LendingAction, ProviderDeliverable, ServiceId } from "../web/src/types.js";

const outer = "2026-09-05T12:05:00.000Z";
const early = "2026-09-05T12:01:00.000Z";
const middle = "2026-09-05T12:03:00.000Z";

function action(executeBefore = outer): LendingAction {
  return {
    kind: "REPAY_DEBT", amount: "1", amountBaseUnits: "1000000", amountUsd: "1",
    asset: { symbol: "USDT", address: "0x1111111111111111111111111111111111111111", decimals: 6 },
    projectedHealthFactor: "1.25", estimatedGasUsd: "0.01", executeBefore, maxSlippageBps: 30,
    preconditions: ["Refresh the position before execution."],
  };
}

function result(): ProviderDeliverable {
  return {
    service: "LENDING_RESCUE", status: "ACTIONABLE", decision: "REPAY_DEBT",
    summary: "Bounded action for the observed position.", expiresAt: outer,
    recommendation: action(), alternatives: [],
  };
}

describe("earliest usable Lending result deadline", () => {
  it("uses the recommendation's earlier execution deadline", () => {
    const output = result();
    output.recommendation = action(early);
    expect(effectiveResultExpiry(output)).toBe(early);
    expect(isResultExpired(effectiveResultExpiry(output)!, Date.parse(early) - 1)).toBe(false);
    expect(isResultExpired(effectiveResultExpiry(output)!, Date.parse(early))).toBe(true);
    expect(isResultExpired(output.expiresAt, Date.parse(early))).toBe(false);
  });

  it("includes every alternative, not just the first displayed alternative", () => {
    const output = result();
    output.recommendation = action(middle);
    output.alternatives = [action(outer), action(early), action(middle)];
    expect(effectiveResultExpiry(output)).toBe(early);
    output.alternatives.reverse();
    expect(effectiveResultExpiry(output)).toBe(early);
  });

  it("never extends an earlier outer receipt deadline", () => {
    const output = result();
    output.expiresAt = early;
    output.alternatives = [action(middle)];
    expect(effectiveResultExpiry(output)).toBe(early);
  });

  it("preserves receipts and original action deadlines without mutation", () => {
    const output = result();
    output.recommendation = action(early);
    const before = JSON.stringify(output);
    expect(effectiveResultExpiry(output)).toBe(early);
    expect(JSON.stringify(output)).toBe(before);
  });

  it.each(["LP_REBALANCE", "YIELD_OPTIMIZATION", "BOUNDED_GRID"] as ServiceId[])("preserves %s outer expiry", (service) => {
    const output = { ...result(), service, recommendation: action(early) };
    expect(effectiveResultExpiry(output)).toBe(outer);
  });

  it.each(["NO_ACTION", "REFUSED_CONSTRAINTS", "REFUSED_EXPIRED"])("preserves inactive Lending %s outer expiry", (status) => {
    const output = { ...result(), status, recommendation: null, alternatives: [] };
    expect(effectiveResultExpiry(output)).toBe(outer);
  });

  it("fails closed for an actionable result with no recommendation", () => {
    expect(effectiveResultExpiry({ ...result(), recommendation: null })).toBeNull();
  });

  it.each(["receipt", "recommendation", "alternative"] as const)("fails closed for an invalid %s deadline without throwing", (location) => {
    const output = result();
    if (location === "receipt") output.expiresAt = "invalid";
    else if (location === "recommendation") output.recommendation = action("invalid");
    else output.alternatives = [action("invalid")];
    expect(effectiveResultExpiry(output)).toBeNull();
  });
});
