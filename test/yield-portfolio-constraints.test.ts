import { describe, expect, it } from "vitest";
import type { YieldOptimizationRequest } from "../src/contracts/yield-optimization.js";
import { createYieldOptimizationDeliverable } from "../src/providers/yield-optimization.js";

const now = new Date("2026-09-05T10:00:10.000Z");
const observedAt = "2026-09-05T10:00:00.000Z";
type Position = YieldOptimizationRequest["currentPositions"][number];
const S = 10n ** 18n;
// Independent test arithmetic, deliberately not the provider's fixed helpers.
function usd(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * S + BigInt(fraction.padEnd(18, "0"));
}
function position(id: number, overrides: Partial<Position> = {}): Position {
  return {
    opportunityId: `position-${id}`,
    protocol: id === 1 ? "Venus" : "Beefy",
    vaultOrMarket: `0x${id.toString(16).padStart(40, "0")}`,
    asset: { symbol: "USDT", address: `0x${"a".repeat(40)}`, decimals: 18 },
    amountUsd: "1000", grossApyBps: id === 1 ? 400 : 1000,
    liquidityUsd: "1000000", lockupSeconds: 0,
    estimatedEntryCostUsd: "1", estimatedExitCostUsd: "1",
    riskTier: "LOW", observedAt, sourceId: "independent-yield-snapshot",
    ...overrides,
  };
}
function request(): YieldOptimizationRequest {
  return {
    schemaVersion: "positioncrew.yield-optimization.request.v1", service: "YIELD_OPTIMIZATION",
    requestId: "yield-independent-001", chainId: 56, account: `0x${"1".repeat(40)}`,
    protocol: "Yield Router", requestedAt: observedAt, deadline: "2026-09-05T10:05:00.000Z",
    maxDataAgeSeconds: 300, maxActionUsd: "20", maxGasUsd: "5", maxSlippageBps: 30,
    sources: [{ sourceId: "independent-yield-snapshot", label: "Independent audit fixture", uri: "https://example.com/yield", observedAt }],
    capitalUsd: "1000", currentPositions: [position(1)], opportunities: [position(2)],
    constraints: {
      protocolAllowlist: ["Venus", "Beefy", "Other"], maximumRiskTier: "MEDIUM",
      maximumProtocolConcentrationBps: 10_000, maximumLockupSeconds: 0,
      minimumLiquidityUsd: "0", minimumNetBenefitUsd: "0", evaluationHorizonDays: 365,
    },
  };
}

function assertPortfolio(r: YieldOptimizationRequest) {
  const result = createYieldOptimizationDeliverable(r, now);
  if (result.status !== "ACTIONABLE") return result;
  expect(result.withdrawals).toBeDefined();
  const selected = r.opportunities.find((opportunity) => opportunity.opportunityId === result.selectedOpportunityId)!;
  const final = new Map<string, bigint>();
  const key = (protocol: string) => protocol.trim().toLowerCase();
  const held = r.currentPositions.reduce((sum, p) => sum + usd(p.amountUsd), 0n);
  const withdrawnById = new Map(result.withdrawals!.map((w) => [w.opportunityId, usd(w.amountUsd)]));
  expect(withdrawnById.size).toBe(result.withdrawals!.length);
  let withdrawn = 0n;
  let cost = usd(selected.estimatedEntryCostUsd);
  let foregone = 0n;
  for (const p of r.currentPositions) {
    const amount = withdrawnById.get(p.opportunityId) ?? 0n;
    expect(amount <= usd(p.amountUsd)).toBe(true);
    expect(amount <= usd(p.liquidityUsd)).toBe(true);
    if (amount > 0n) {
      expect(p.lockupSeconds).toBe(0);
      expect(p.asset.address.toLowerCase()).toBe(selected.asset.address.toLowerCase());
      cost += usd(p.estimatedExitCostUsd);
    }
    withdrawn += amount;
    foregone += amount * BigInt(p.grossApyBps);
    final.set(key(p.protocol), (final.get(key(p.protocol)) ?? 0n) + usd(p.amountUsd) - amount);
  }
  const allocation = usd(result.allocationUsd);
  const idleUsed = usd(result.idleCapitalUsedUsd!);
  const postCapital = usd(r.capitalUsd) - cost;
  expect(allocation > 0n && allocation <= usd(selected.amountUsd) && allocation <= usd(selected.liquidityUsd)).toBe(true);
  expect(cost).toBe(usd(result.migrationCostUsd));
  expect(cost <= usd(r.maxGasUsd) && cost <= usd(r.maxActionUsd)).toBe(true);
  expect(withdrawn + idleUsed).toBe(allocation + cost);
  expect(idleUsed >= 0n && idleUsed <= usd(r.capitalUsd) - held).toBe(true);
  expect(usd(result.postMigrationCapitalUsd!)).toBe(postCapital);
  expect(usd(result.remainingIdleCapitalUsd!)).toBe(usd(r.capitalUsd) - held - idleUsed);
  final.set(key(selected.protocol), (final.get(key(selected.protocol)) ?? 0n) + allocation);
  for (const exposure of final.values()) {
    expect(exposure >= 0n && exposure * 10_000n <= postCapital * BigInt(r.constraints.maximumProtocolConcentrationBps)).toBe(true);
  }
  expect(new Map(result.finalProtocolAllocations!.map((p) => [key(p.protocol), usd(p.amountUsd)]))).toEqual(final);
  const annual = (allocation * BigInt(selected.grossApyBps) - foregone) / 10_000n;
  expect(usd(result.annualYieldUpliftUsd)).toBe(annual);
  const net = annual * BigInt(r.constraints.evaluationHorizonDays) / 365n - cost;
  expect(usd(result.netBenefitUsd)).toBe(net);
  expect(net >= usd(r.constraints.minimumNetBenefitUsd)).toBe(true);
  expect([...final.values()].reduce((sum, p) => sum + p, 0n) + usd(result.remainingIdleCapitalUsd!)).toBe(postCapital);
  return result;
}

describe("yield portfolio financial constraints", () => {
  it("funds entry and withdrawal costs inside total capital", () => {
    const result = assertPortfolio(request());
    expect(result.status).toBe("ACTIONABLE");
    expect(result.allocationUsd).toBe("998");
    expect(result.withdrawals).toEqual([{ opportunityId: "position-1", amountUsd: "1000" }]);
    expect(result.annualYieldUpliftUsd).toBe("59.8");
    expect(result.netBenefitUsd).toBe("57.8");
  });

  it("rejects a move between Beefy vaults that leaves the whole portfolio on Beefy", () => {
    const r = request();
    r.currentPositions[0]!.protocol = "Beefy";
    r.constraints.maximumProtocolConcentrationBps = 5000;
    expect(assertPortfolio(r).status).toBe("NO_ACTION");
  });

  it("cannot leave another retained protocol above the final cap", () => {
    const r = request();
    r.currentPositions = [position(1, { amountUsd: "800", lockupSeconds: 3600 }), position(3, { protocol: "Other", amountUsd: "200" })];
    r.constraints.maximumProtocolConcentrationBps = 5000;
    expect(assertPortfolio(r).status).toBe("NO_ACTION");
  });

  it("aggregates case and whitespace variations of a protocol name", () => {
    const r = request();
    r.currentPositions = [position(1, { protocol: " BEEFY ", amountUsd: "400" }), position(3, { protocol: "beefy", amountUsd: "600" })];
    r.constraints.maximumProtocolConcentrationBps = 5000;
    expect(assertPortfolio(r).status).toBe("NO_ACTION");
  });

  it("finds a true 50/50 migration using the portfolio after costs", () => {
    const r = request();
    r.constraints.maximumProtocolConcentrationBps = 5000;
    const result = assertPortfolio(r);
    expect(result.status).toBe("ACTIONABLE");
    expect(result.allocationUsd).toBe("499");
    expect(result.withdrawals).toEqual([{ opportunityId: "position-1", amountUsd: "501" }]);
    expect(result.finalProtocolAllocations).toEqual([{ protocol: "beefy", amountUsd: "499" }, { protocol: "venus", amountUsd: "499" }]);
  });

  it("accounts for destination protocol holdings retained in another vault", () => {
    const r = request();
    r.currentPositions = [position(1, { amountUsd: "900" }), position(3, { amountUsd: "100", grossApyBps: 2000, lockupSeconds: 10 })];
    r.constraints.maximumProtocolConcentrationBps = 5000;
    const result = assertPortfolio(r);
    expect(result.status).toBe("ACTIONABLE");
    expect(result.allocationUsd).toBe("399");
    expect(result.finalProtocolAllocations).toEqual([{ protocol: "beefy", amountUsd: "499" }, { protocol: "venus", amountUsd: "499" }]);
  });

  it("independently enforces gas even when the action cost budget allows the route", () => {
    const r = request();
    r.maxGasUsd = "1.999999999999999999";
    expect(assertPortfolio(r).status).toBe("NO_ACTION");
    r.maxGasUsd = "2";
    expect(assertPortfolio(r).status).toBe("ACTIONABLE");
  });

  it("enforces the separate action cost budget", () => {
    const r = request();
    r.maxActionUsd = "1.999999999999999999";
    expect(assertPortfolio(r).status).toBe("NO_ACTION");
  });

  it("charges no exit cost for an unused holding", () => {
    const r = request();
    r.currentPositions = [position(1, { amountUsd: "500" }), position(3, { protocol: "Other", amountUsd: "500", grossApyBps: 5000, estimatedExitCostUsd: "100" })];
    const result = assertPortfolio(r);
    expect(result.status).toBe("ACTIONABLE");
    expect(result.migrationCostUsd).toBe("2");
    expect(result.withdrawals).toEqual([{ opportunityId: "position-1", amountUsd: "500" }]);
    expect(result.annualYieldUpliftUsd).toBe("29.8");
  });

  it("uses actual withdrawn yield rather than the portfolio average", () => {
    const r = request();
    r.currentPositions = [position(1, { amountUsd: "500", grossApyBps: 100 }), position(3, { protocol: "Other", amountUsd: "500", grossApyBps: 9000 })];
    const result = assertPortfolio(r);
    expect(result.status).toBe("ACTIONABLE");
    expect(result.currentWeightedApyBps).toBe(4550);
    expect(result.annualYieldUpliftUsd).toBe("44.8");
  });

  it("combines B and C when expensive A invalidates every APY prefix and neither singleton clears benefit", () => {
    const r = request();
    r.capitalUsd = "900";
    r.currentPositions = [
      position(1, { opportunityId: "A", protocol: "Venus", amountUsd: "300", grossApyBps: 100, estimatedExitCostUsd: "100" }),
      position(3, { opportunityId: "B", protocol: "Venus", amountUsd: "300", grossApyBps: 300 }),
      position(4, { opportunityId: "C", protocol: "Venus", amountUsd: "300", grossApyBps: 400 }),
    ];
    r.opportunities[0]!.grossApyBps = 2000;
    r.constraints.minimumNetBenefitUsd = "70";
    // Preserve the other holdings but lock them to prove each singleton fails.
    for (const unlocked of ["B", "C"]) {
      const alone = structuredClone(r);
      for (const p of alone.currentPositions) if (p.opportunityId !== unlocked) p.lockupSeconds = 3600;
      expect(assertPortfolio(alone).status).toBe("NO_ACTION");
    }
    const result = assertPortfolio(r);
    expect(result.status).toBe("ACTIONABLE");
    expect(result.withdrawals).toEqual([{ opportunityId: "B", amountUsd: "300" }, { opportunityId: "C", amountUsd: "300" }]);
    expect(result.allocationUsd).toBe("597");
    expect(result.migrationCostUsd).toBe("3");
    expect(result.netBenefitUsd).toBe("95.4");
  });

  it("finds the funded cheap combination even when expensive A fits the budget individually", () => {
    const r = request();
    r.capitalUsd = "900";
    r.maxGasUsd = "4";
    r.currentPositions = [
      position(1, { opportunityId: "A", protocol: "Venus", amountUsd: "100", grossApyBps: 100, estimatedExitCostUsd: "3" }),
      position(3, { opportunityId: "B", protocol: "Venus", amountUsd: "400", grossApyBps: 200 }),
      position(4, { opportunityId: "C", protocol: "Venus", amountUsd: "400", grossApyBps: 300 }),
    ];
    r.opportunities[0]!.grossApyBps = 2000;
    r.constraints.minimumNetBenefitUsd = "100";
    const result = assertPortfolio(r);
    expect(result.status).toBe("ACTIONABLE");
    expect(result.withdrawals).toEqual([{ opportunityId: "B", amountUsd: "400" }, { opportunityId: "C", amountUsd: "400" }]);
    expect(result.allocationUsd).toBe("797");
    expect(result.migrationCostUsd).toBe("3");
    expect(result.netBenefitUsd).toBe("136.4");
    r.currentPositions.reverse();
    expect(assertPortfolio(r)).toEqual(result);
  });

  it("uses a bounded search for a large portfolio requiring joint funding", () => {
    const r = request();
    r.capitalUsd = "1280";
    r.maxGasUsd = "3";
    r.currentPositions = Array.from({ length: 128 }, (_, index) => position(index + 10, {
      protocol: "Venus", amountUsd: "10", grossApyBps: 100, estimatedExitCostUsd: "0.01",
    }));
    r.opportunities = [position(1000, { amountUsd: "1280", grossApyBps: 2000 })];
    r.constraints.minimumNetBenefitUsd = "200";
    const result = assertPortfolio(r);
    expect(result.status).toBe("ACTIONABLE");
    expect(result.withdrawals).toHaveLength(128);
    expect(result.allocationUsd).toBe("1277.72");
    expect(result.migrationCostUsd).toBe("2.28");
    expect(result.netBenefitUsd).toBe("240.464");
  });

  it("uses idle funds without inventing a migration or exiting existing capital", () => {
    const r = request();
    r.currentPositions = [position(1, { amountUsd: "500", grossApyBps: 5000, lockupSeconds: 3600 })];
    const result = assertPortfolio(r);
    expect(result.status).toBe("ACTIONABLE");
    expect(result.decision).toBe("SUPPLY");
    expect(result.withdrawals).toEqual([]);
    expect(result.allocationUsd).toBe("499");
    expect(result.idleCapitalUsedUsd).toBe("500");
    expect(result.annualYieldUpliftUsd).toBe("49.9");
  });

  it("does not count held capital again as idle capital", () => {
    const r = request();
    r.currentPositions[0]!.lockupSeconds = 3600;
    expect(assertPortfolio(r).status).toBe("NO_ACTION");
  });

  it("refuses overcommitted and duplicate current balances", () => {
    const r = request();
    r.currentPositions[0]!.amountUsd = "1000.000000000000000001";
    expect(assertPortfolio(r).status).toBe("REFUSED_INCONSISTENT_DATA");
    r.currentPositions = [position(1, { amountUsd: "500" }), position(1, { opportunityId: "duplicate-alias", amountUsd: "500" })];
    expect(assertPortfolio(r).status).toBe("REFUSED_INCONSISTENT_DATA");
  });

  it("does not treat an unquoted cross-asset swap as a migration", () => {
    const r = request();
    r.currentPositions[0]!.asset = { symbol: "USDC", address: `0x${"b".repeat(40)}`, decimals: 18 };
    expect(assertPortfolio(r).status).toBe("NO_ACTION");
  });

  it("limits withdrawals and deposits to available liquidity", () => {
    const r = request();
    r.currentPositions[0]!.liquidityUsd = "100";
    r.opportunities[0]!.liquidityUsd = "50";
    const result = assertPortfolio(r);
    expect(result.status).toBe("ACTIONABLE");
    expect(result.allocationUsd).toBe("50");
    expect(result.withdrawals).toEqual([{ opportunityId: "position-1", amountUsd: "52" }]);
  });

  it("preserves fractional boundary precision and never emits zero-sized actions", () => {
    const r = request();
    r.currentPositions = [];
    r.opportunities[0]!.estimatedEntryCostUsd = "0";
    r.opportunities[0]!.amountUsd = "0.000000000000000001";
    expect(assertPortfolio(r).status).toBe("NO_ACTION");
    r.opportunities[0]!.amountUsd = "0.00000000000000001";
    const result = assertPortfolio(r);
    expect(result.status).toBe("ACTIONABLE");
    expect(result.allocationUsd).toBe("0.00000000000000001");
  });

  it("rejects contradictory market identity and zero-capacity opportunities", () => {
    const r = request();
    r.opportunities[0]!.vaultOrMarket = r.currentPositions[0]!.vaultOrMarket;
    expect(assertPortfolio(r).status).toBe("REFUSED_INCONSISTENT_DATA");
    r.opportunities = [position(2, { amountUsd: "0", estimatedEntryCostUsd: "0" })];
    expect(assertPortfolio(r).status).toBe("NO_ACTION");
  });

  it("independently reconstructs every actionable outcome across adversarial portfolio combinations", () => {
    let actionable = 0;
    for (const cap of [2500, 3333, 5000, 7500, 10_000]) {
      for (const held of [0, 100, 499, 500, 900, 1000]) {
        for (const targetHeld of [0, Math.floor(held / 2), held]) {
          const r = request();
          r.constraints.maximumProtocolConcentrationBps = cap;
          r.currentPositions = [];
          if (held - targetHeld > 0) r.currentPositions.push(position(1, { amountUsd: String(held - targetHeld) }));
          if (targetHeld > 0) r.currentPositions.push(position(3, { amountUsd: String(targetHeld), protocol: "BeEfY", grossApyBps: 300 }));
          r.opportunities[0]!.estimatedEntryCostUsd = "0.123456789012345678";
          if (assertPortfolio(r).status === "ACTIONABLE") actionable += 1;
        }
      }
    }
    expect(actionable).toBeGreaterThan(25);
  });
});
