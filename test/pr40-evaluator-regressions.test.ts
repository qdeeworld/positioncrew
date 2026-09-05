import { describe, expect, it } from "vitest";
import { PositionCrewRequestSchema, type PositionCrewDeliverable, type PositionCrewRequest } from "../src/contracts/index.js";
import { createProviderConformanceExamples } from "../src/marketplace/provider-conformance-examples.js";
import { evaluateProviderConformance } from "../src/evaluators/provider-conformance.js";
import { evaluateFinancialInvariants, yieldPortfolioInputConsistent } from "../src/evaluators/financial-invariants.js";
import { executeProvider } from "../src/providers/index.js";
import { parseFixed, formatFixed } from "../src/core/fixed.js";
import { FIXTURE_NOW } from "./helpers.js";

function example(service: PositionCrewRequest["service"]) {
  const entry = createProviderConformanceExamples().find((item) => item.request.service === service);
  if (!entry) throw new Error("Missing conformance example");
  return entry;
}
function evaluate(request: PositionCrewRequest, output: PositionCrewDeliverable, now = FIXTURE_NOW) {
  return evaluateProviderConformance(request, output, "positioncrew:pr40-regression", now);
}
function rejected(request: PositionCrewRequest, output: PositionCrewDeliverable, id: string, now = FIXTURE_NOW) {
  const receipt = evaluate(request, output, now);
  expect(receipt.passed).toBe(false);
  expect(receipt.score).toBeLessThan(100);
  expect(receipt.checks.find((item) => item.id === id)?.passed).toBe(false);
}

describe("PR40 independent evaluator regressions", () => {
  it("accepts a truthful Yield refusal for overcommitted current holdings", () => {
    const { request } = example("YIELD_OPTIMIZATION");
    if (request.service !== "YIELD_OPTIMIZATION") throw new Error("Expected yield");
    request.currentPositions[0]!.amountUsd = formatFixed(parseFixed(request.capitalUsd) + parseFixed("1"), 18);
    expect(yieldPortfolioInputConsistent(request)).toBe(false);
    const output = executeProvider(request, FIXTURE_NOW);
    expect(output.status).toBe("REFUSED_INCONSISTENT_DATA");
    expect(evaluate(request, output).passed).toBe(true);
    rejected(request, { ...output, status: "REFUSED_CONSTRAINTS" }, "evidence-decision");
  });

  it.each(["holding-id", "opportunity-id", "holding-market", "market-protocol", "market-asset", "market-decimals"] as const)(
    "recognizes a truthful Yield portfolio refusal for %s", (conflict) => {
      const { request } = example("YIELD_OPTIMIZATION");
      if (request.service !== "YIELD_OPTIMIZATION") throw new Error("Expected yield");
      const holding = request.currentPositions[0]!;
      if (conflict === "holding-id") {
        request.currentPositions.push({ ...structuredClone(holding), vaultOrMarket: "0x9999999999999999999999999999999999999999" });
      } else if (conflict === "opportunity-id") {
        request.opportunities.push(structuredClone(request.opportunities[0]!));
      } else if (conflict === "holding-market") {
        request.currentPositions.push({ ...structuredClone(holding), opportunityId: "duplicate-held-market" });
      } else {
        const conflicting = { ...structuredClone(holding), opportunityId: "conflicting-market-identity" };
        if (conflict === "market-protocol") conflicting.protocol = "Conflicting protocol";
        if (conflict === "market-asset") conflicting.asset.address = "0x9999999999999999999999999999999999999999";
        if (conflict === "market-decimals") conflicting.asset.decimals = holding.asset.decimals === 18 ? 17 : 18;
        request.opportunities.push(conflicting);
      }
      const held = request.currentPositions.reduce((total, entry) => total + parseFixed(entry.amountUsd), 0n);
      if (held > parseFixed(request.capitalUsd)) request.capitalUsd = formatFixed(held, 18);
      expect(yieldPortfolioInputConsistent(request)).toBe(false);
      const output = executeProvider(request, FIXTURE_NOW);
      expect(output.status).toBe("REFUSED_INCONSISTENT_DATA");
      expect(evaluate(request, output).passed).toBe(true);
    },
  );

  it("independently rejects a source and destination sharing one ID for different vaults", () => {
    const { request, deliverable } = example("YIELD_OPTIMIZATION");
    if (request.service !== "YIELD_OPTIMIZATION" || deliverable.service !== "YIELD_OPTIMIZATION") throw new Error("Expected yield");
    expect(evaluate(request, deliverable).passed).toBe(true);
    const holding = request.currentPositions[0]!;
    const previousId = holding.opportunityId;
    holding.opportunityId = deliverable.selectedOpportunityId!;
    for (const withdrawal of deliverable.withdrawals!) {
      if (withdrawal.opportunityId === previousId) withdrawal.opportunityId = holding.opportunityId;
    }
    expect(yieldPortfolioInputConsistent(request)).toBe(false);
    expect(evaluateFinancialInvariants(request, deliverable).find((item) => item.id === "yield-opportunity-identities")?.passed).toBe(false);
    rejected(request, deliverable, "yield-opportunity-identities");
    const refusal = executeProvider(request, FIXTURE_NOW);
    expect(refusal.status).toBe("REFUSED_INCONSISTENT_DATA");
    expect(evaluate(request, refusal).passed).toBe(true);
  });

  it("allows the same canonical Yield identity in both lists with role-specific terms", () => {
    const { request } = example("YIELD_OPTIMIZATION");
    if (request.service !== "YIELD_OPTIMIZATION") throw new Error("Expected yield");
    const holding = structuredClone(request.currentPositions[0]!);
    request.currentPositions = [holding];
    request.opportunities = [{ ...structuredClone(holding),
      protocol: `  ${holding.protocol.toUpperCase()}  `,
      vaultOrMarket: `0x${holding.vaultOrMarket.slice(2).toUpperCase()}`,
      asset: { ...holding.asset, address: `0x${holding.asset.address.slice(2).toUpperCase()}` },
      amountUsd: formatFixed(parseFixed(holding.amountUsd) * 2n, 18),
      grossApyBps: holding.grossApyBps + 1,
    }];
    expect(yieldPortfolioInputConsistent(request)).toBe(true);
    request.opportunities.push({ ...structuredClone(request.opportunities[0]!), opportunityId: "same-market-different-quote-id" });
    expect(yieldPortfolioInputConsistent(request)).toBe(true);
  });

  it.each(["expired", "stale", "observation-inconsistent"] as const)(
    "keeps %s evidence ahead of Yield portfolio inconsistency", (condition) => {
      const { request } = example("YIELD_OPTIMIZATION");
      if (request.service !== "YIELD_OPTIMIZATION") throw new Error("Expected yield");
      request.currentPositions[0]!.amountUsd = formatFixed(parseFixed(request.capitalUsd) + parseFixed("1"), 18);
      request.maxDataAgeSeconds = 15;
      if (condition === "observation-inconsistent") request.currentPositions[0]!.sourceId = "missing-source";
      const now = condition === "expired" ? new Date(request.deadline) : FIXTURE_NOW;
      const expected = condition === "expired" ? "REFUSED_EXPIRED" : condition === "stale" ? "REFUSED_STALE_DATA" : "REFUSED_INCONSISTENT_DATA";
      const output = executeProvider(request, now);
      expect(output.status).toBe(expected);
      expect(evaluate(request, output, now).passed).toBe(true);
      if (expected !== "REFUSED_INCONSISTENT_DATA") rejected(request, { ...output, status: "REFUSED_INCONSISTENT_DATA" }, "evidence-decision", now);
    },
  );

  it.each(["grossSpreadCaptureUsd", "estimatedFeesUsd", "estimatedSlippageUsd", "estimatedGasUsd",
    "expectedNetProfitUsd", "maximumInventoryUsd", "worstCaseLossUsd"] as const)(
    "rejects unsupported inactive Grid %s", (field) => {
      const { request } = example("BOUNDED_GRID");
      request.maxActionUsd = "0.000000000000000001";
      const output = executeProvider(request, FIXTURE_NOW);
      if (output.service !== "BOUNDED_GRID") throw new Error("Expected grid");
      expect(output.status).toBe("NO_ACTION");
      expect(parseFixed(output[field])).toBe(0n);
      expect(evaluate(request, output).passed).toBe(true);
      for (const status of ["REFUSED_CONSTRAINTS", "NO_ACTION"] as const) {
        const inactive = { ...output, status, decision: "NO_GRID" as const };
        expect(evaluate(request, inactive).passed).toBe(true);
        rejected(request, { ...inactive, [field]: "999999" }, "grid-inactive-economics");
      }
    },
  );

  it.each(["LENDING_RESCUE", "LP_REBALANCE", "YIELD_OPTIMIZATION", "BOUNDED_GRID"] as const)(
    "requires usable expiry for a fresh non-action result in %s", (service) => {
      const { request } = example(service);
      request.maxActionUsd = "0.000000000000000001";
      const output = executeProvider(request, FIXTURE_NOW);
      expect(output.status).not.toBe("ACTIONABLE");
      expect(evaluate(request, output).passed).toBe(true);
      for (const expiresAt of ["2020-01-01T00:00:00.000Z", FIXTURE_NOW.toISOString()]) {
        rejected(request, { ...output, expiresAt }, "bounded-expiry");
      }
    },
  );

  it.each(["sourceId", "uri", "observedAt", "label"] as const)("binds the Lending output source %s", (field) => {
    const { request, deliverable } = example("LENDING_RESCUE");
    if (deliverable.service !== "LENDING_RESCUE") throw new Error("Expected lending");
    expect(evaluate(request, deliverable).passed).toBe(true);
    const replacement = field === "uri" ? "https://unrelated.example/block/1"
      : field === "observedAt" ? "2026-08-12T15:58:00.000Z" : "unrelated-source";
    deliverable.sources = structuredClone(deliverable.sources);
    deliverable.sources[0]![field] = replacement;
    rejected(request, deliverable, "lending-source-binding");
  });

  it.each(["opportunityId", "vaultOrMarket"] as const)("rejects ambiguous Yield %s identities", (field) => {
    const { request, deliverable } = example("YIELD_OPTIMIZATION");
    if (request.service !== "YIELD_OPTIMIZATION" || deliverable.service !== "YIELD_OPTIMIZATION") throw new Error("Expected yield");
    expect(deliverable.status).toBe("ACTIONABLE");
    expect(evaluate(request, deliverable).passed).toBe(true);
    const selected = request.opportunities.find((item) => item.opportunityId === deliverable.selectedOpportunityId)!;
    request.opportunities.push({ ...structuredClone(selected),
      opportunityId: field === "opportunityId" ? selected.opportunityId : "conflicting-other-id",
      vaultOrMarket: field === "vaultOrMarket" ? selected.vaultOrMarket : "0x9999999999999999999999999999999999999999",
      protocol: "Conflicting protocol", grossApyBps: selected.grossApyBps + 1 });
    rejected(request, deliverable, "yield-opportunity-identities");
  });

  it("accepts native orders denominated in a six-decimal quote asset", () => {
    const { request } = example("BOUNDED_GRID");
    if (request.service !== "BOUNDED_GRID") throw new Error("Expected grid");
    request.quoteAsset.decimals = 6;
    const output = executeProvider(request, FIXTURE_NOW);
    expect(output.status).toBe("ACTIONABLE");
    expect(evaluate(request, output).passed).toBe(true);
    if (output.service !== "BOUNDED_GRID") throw new Error("Expected grid");
    expect(output.orders.every((order) => parseFixed(order.maximumQuoteAmount) % 1_000_000_000_000n === 0n)).toBe(true);
  });

  it.each(["BUY", "SELL"] as const)("rejects a fractional quote base unit in a %s reservation", (side) => {
    const { request } = example("BOUNDED_GRID");
    if (request.service !== "BOUNDED_GRID") throw new Error("Expected grid");
    request.quoteAsset.decimals = 6;
    const output = executeProvider(request, FIXTURE_NOW);
    if (output.service !== "BOUNDED_GRID") throw new Error("Expected grid");
    const order = output.orders.find((item) => item.side === side)!;
    order.maximumQuoteAmount = formatFixed(parseFixed(order.maximumQuoteAmount) + 1n, 18);
    rejected(request, output, "grid-order-semantics");
  });

  it.each(["LENDING_RESCUE", "LP_REBALANCE", "YIELD_OPTIMIZATION", "BOUNDED_GRID"] as const)(
    "rejects false fresh-data refusal codes for %s", (service) => {
      const { request } = example(service);
      const staleRequest = PositionCrewRequestSchema.parse({ ...request, maxDataAgeSeconds: 15 });
      const refusal = executeProvider(staleRequest, FIXTURE_NOW);
      expect(refusal.status).toBe("REFUSED_STALE_DATA");
      for (const status of ["REFUSED_EXPIRED", "REFUSED_STALE_DATA", "REFUSED_INCONSISTENT_DATA"] as const) {
        rejected(request, { ...refusal, status }, "evidence-decision");
      }
    },
  );

  it.each(["LENDING_RESCUE", "LP_REBALANCE", "YIELD_OPTIMIZATION", "BOUNDED_GRID"] as const)(
    "requires a truthful stale-data refusal for %s", (service) => {
      const { request } = example(service);
      request.maxDataAgeSeconds = 15;
      const refusal = executeProvider(request, FIXTURE_NOW);
      expect(evaluate(request, refusal).passed).toBe(true);
      for (const status of ["REFUSED_CONSTRAINTS", "REFUSED_EXPIRED", "REFUSED_INCONSISTENT_DATA"] as const) {
        rejected(request, { ...refusal, status }, "evidence-decision");
      }
    },
  );

  it("gives inconsistent data precedence over staleness", () => {
    const { request } = example("LP_REBALANCE");
    if (request.service !== "LP_REBALANCE") throw new Error("Expected LP");
    request.maxDataAgeSeconds = 15;
    request.marketState.sourceId = "missing-source-id";
    const refusal = executeProvider(request, FIXTURE_NOW);
    expect(refusal.status).toBe("REFUSED_INCONSISTENT_DATA");
    expect(evaluate(request, refusal).passed).toBe(true);
    rejected(request, { ...refusal, status: "REFUSED_STALE_DATA" }, "evidence-decision");
    rejected(request, { ...refusal, status: "REFUSED_CONSTRAINTS" }, "evidence-decision");
  });

  it("requires expiration at the exact deadline even when sources are also inconsistent", () => {
    const { request } = example("LP_REBALANCE");
    if (request.service !== "LP_REBALANCE") throw new Error("Expected LP");
    request.marketState.sourceId = "missing-source-id";
    const now = new Date(request.deadline);
    const refusal = executeProvider(request, now);
    expect(refusal.status).toBe("REFUSED_EXPIRED");
    expect(evaluate(request, refusal, now).passed).toBe(true);
    rejected(request, { ...refusal, status: "REFUSED_INCONSISTENT_DATA" }, "evidence-decision", now);
    rejected(request, { ...refusal, status: "REFUSED_CONSTRAINTS" }, "evidence-decision", now);
  });

  it("classifies an unused future-dated source as inconsistent, not stale", () => {
    const { request } = example("LP_REBALANCE");
    request.sources.push({ ...request.sources[0]!, sourceId: "future-unused-source", observedAt: "2026-08-12T16:01:00.000Z" });
    const refusal = executeProvider(request, FIXTURE_NOW);
    expect(refusal.status).toBe("REFUSED_INCONSISTENT_DATA");
    expect(evaluate(request, refusal).passed).toBe(true);
    rejected(request, { ...refusal, status: "REFUSED_STALE_DATA" }, "evidence-decision");
  });

  it.each([null, "0", "999999999", "1.000000000000000001"])("rejects fabricated LP break-even hours %s", (breakEvenHours) => {
    const { request, deliverable } = example("LP_REBALANCE");
    if (deliverable.service !== "LP_REBALANCE") throw new Error("Expected LP");
    expect(deliverable.status).toBe("ACTIONABLE");
    expect(evaluate(request, deliverable).passed).toBe(true);
    deliverable.breakEvenHours = breakEvenHours;
    rejected(request, deliverable, "lp-break-even");
  });

  it("does not admit legacy actionable LP economics with no declared fee projection", () => {
    const { request, deliverable } = example("LP_REBALANCE");
    if (deliverable.service !== "LP_REBALANCE") throw new Error("Expected LP");
    delete deliverable.feeProjection;
    rejected(request, deliverable, "lp-fee-projection");
  });

  it("recomputes LP fee income instead of accepting an internally consistent fabricated basis", () => {
    const { request, deliverable } = example("LP_REBALANCE");
    if (request.service !== "LP_REBALANCE" || deliverable.service !== "LP_REBALANCE") throw new Error("Expected LP");
    deliverable.expectedGrossFeesUsd = "1000000";
    deliverable.expectedNetBenefitUsd = formatFixed(parseFixed("1000000") - parseFixed(deliverable.estimatedRebalanceCostUsd), 18);
    deliverable.breakEvenHours = formatFixed(parseFixed(deliverable.estimatedRebalanceCostUsd) * BigInt(request.constraints.evaluationHorizonHours) / 1_000_000n, 18);
    rejected(request, deliverable, "lp-fee-arithmetic");
  });

  it("binds changed uptime assumptions to their resulting LP economics", () => {
    const { request, deliverable } = example("LP_REBALANCE");
    if (deliverable.service !== "LP_REBALANCE") throw new Error("Expected LP");
    deliverable.feeProjection!.proposedUptimeBps -= 1;
    rejected(request, deliverable, "lp-fee-arithmetic");
  });

  it("allows zero break-even only when the declared free-action formula yields zero", () => {
    const { request } = example("LP_REBALANCE");
    if (request.service !== "LP_REBALANCE") throw new Error("Expected LP");
    request.constraints.estimatedGasUsd = "0";
    request.constraints.estimatedSwapCostUsd = "0";
    const output = executeProvider(request, FIXTURE_NOW);
    if (output.service !== "LP_REBALANCE") throw new Error("Expected LP");
    expect(output.status).toBe("ACTIONABLE");
    expect(output.breakEvenHours).toBe("0");
    expect(evaluate(request, output).passed).toBe(true);
  });
});
