import { describe, expect, it } from "vitest";
import { createProviderConformanceExamples } from "../src/marketplace/provider-conformance-examples.js";
import { PROVIDER_CATALOG } from "../src/marketplace/catalog.js";
import {
  buildProviderContractTemplate,
  runProviderContractPreflight,
  verifyProviderContractPreflightResult,
  type ProviderContractPacket,
} from "../src/marketplace/provider-compatibility.js";

type ServiceId = ProviderContractPacket["service"];

async function templates(): Promise<Record<ServiceId, ProviderContractPacket>> {
  return Object.fromEntries(createProviderConformanceExamples().map((example) => {
    const provider = PROVIDER_CATALOG.find((candidate) => candidate.service === example.request.service);
    if (!provider) throw new Error("Missing provider");
    return [example.request.service, buildProviderContractTemplate(
      provider,
      example.request,
      example.deliverable,
    )];
  })) as Record<ServiceId, ProviderContractPacket>;
}

describe("provider contract preflight", () => {
  it("passes one deterministic reference packet for every frozen capital category", async () => {
    const packets = await templates();
    expect(Object.keys(packets)).toEqual([
      "LENDING_RESCUE",
      "LP_REBALANCE",
      "YIELD_OPTIMIZATION",
      "BOUNDED_GRID",
    ]);
    for (const packet of Object.values(packets)) {
      const first = runProviderContractPreflight(packet);
      const second = runProviderContractPreflight(structuredClone(packet));
      expect(first.outcome).toBe("CONTRACT_PASS");
      expect(first.inputHash).toBe(second.inputHash);
      expect(first.resultHash).toBe(second.resultHash);
      expect(verifyProviderContractPreflightResult(first)).toBe(true);
      expect(first.checks.filter((check) => check.status === "NOT_PROVEN")).toHaveLength(11);
    }
  });

  it("fails closed on critical manifest, schema, binding, semantic, and limit mutations", async () => {
    const packets = await templates();
    const base = packets.LENDING_RESCUE!;
    const mutations: Array<(packet: typeof base) => void> = [
      (packet) => { packet.manifest.service = "LP_REBALANCE"; },
      (packet) => { packet.manifest.requestSchema = "positioncrew.lp-rebalance.request.v1"; },
      (packet) => { packet.request.requestId = "short"; },
      (packet) => { packet.actionableDeliverable.requestId = "different-request"; },
      (packet) => { packet.actionableDeliverable.status = "NO_ACTION"; },
      (packet) => {
        if (packet.actionableDeliverable.service === "LENDING_RESCUE" && packet.actionableDeliverable.recommendation) {
          packet.actionableDeliverable.recommendation.amountUsd = "1000000";
        }
      },
      (packet) => { packet.refusalDeliverable.requestId = "different-request"; },
      (packet) => { packet.refusalDeliverable.status = "ACTIONABLE"; },
      (packet) => { packet.actionableDeliverable.expiresAt = "2099-01-01T00:00:00.000Z"; },
    ];
    for (const mutate of mutations) {
      const packet = structuredClone(base);
      mutate(packet);
      expect(runProviderContractPreflight(packet).outcome).toBe("CONTRACT_FAIL");
    }
    const unknownField = { ...structuredClone(base), unexpected: true };
    expect(runProviderContractPreflight(unknownField).outcome).toBe("CONTRACT_FAIL");
  });

  it("uses exact caps and category-specific request binding across all four services", async () => {
    const packets = await templates();
    const capMutations: Record<ServiceId, (packet: ProviderContractPacket) => void> = {
      LENDING_RESCUE: (packet) => {
        if (packet.actionableDeliverable.service === "LENDING_RESCUE" && packet.actionableDeliverable.recommendation) {
          packet.actionableDeliverable.recommendation.amountUsd = "250.000000000000000001";
        }
      },
      LP_REBALANCE: (packet) => {
        if (packet.actionableDeliverable.service === "LP_REBALANCE") {
          packet.actionableDeliverable.estimatedRebalanceCostUsd = "250.000000000000000001";
        }
      },
      YIELD_OPTIMIZATION: (packet) => {
        if (packet.actionableDeliverable.service === "YIELD_OPTIMIZATION") {
          packet.actionableDeliverable.allocationUsd = "1000.000000000000000001";
        }
      },
      BOUNDED_GRID: (packet) => {
        if (packet.actionableDeliverable.service === "BOUNDED_GRID") {
          packet.actionableDeliverable.worstCaseLossUsd = "150.000000000000000001";
        }
      },
    };
    const bindingMutations: Record<ServiceId, (packet: ProviderContractPacket) => void> = {
      LENDING_RESCUE: (packet) => {
        if (packet.actionableDeliverable.service === "LENDING_RESCUE" && packet.actionableDeliverable.recommendation) {
          packet.actionableDeliverable.recommendation.protocol = "Unrelated protocol";
        }
      },
      LP_REBALANCE: (packet) => {
        if (packet.actionableDeliverable.service === "LP_REBALANCE") {
          packet.actionableDeliverable.proposedRange = { lowerTick: -120, upperTick: 120 };
        }
      },
      YIELD_OPTIMIZATION: (packet) => {
        if (packet.actionableDeliverable.service === "YIELD_OPTIMIZATION") {
          packet.actionableDeliverable.selectedOpportunityId = "high-risk-farm";
        }
      },
      BOUNDED_GRID: (packet) => {
        if (packet.actionableDeliverable.service === "BOUNDED_GRID") {
          packet.actionableDeliverable.orders[0]!.price = "8.999999999999999999";
        }
      },
    };
    for (const service of Object.keys(packets) as ServiceId[]) {
      const overCap = structuredClone(packets[service]);
      capMutations[service](overCap);
      expect(runProviderContractPreflight(overCap).outcome, `${service} cap`).toBe("CONTRACT_FAIL");
      const unbound = structuredClone(packets[service]);
      bindingMutations[service](unbound);
      expect(runProviderContractPreflight(unbound).outcome, `${service} binding`).toBe("CONTRACT_FAIL");
    }

    const expiredLendingAction = structuredClone(packets.LENDING_RESCUE);
    if (expiredLendingAction.actionableDeliverable.service === "LENDING_RESCUE" && expiredLendingAction.actionableDeliverable.recommendation) {
      expiredLendingAction.actionableDeliverable.recommendation.executeBefore = new Date(
        Date.parse(expiredLendingAction.actionableDeliverable.expiresAt) + 1_000,
      ).toISOString();
    }
    expect(runProviderContractPreflight(expiredLendingAction).outcome, "lending action validity window").toBe("CONTRACT_FAIL");

    const upperBoundaryLp = structuredClone(packets.LP_REBALANCE);
    if (upperBoundaryLp.request.service === "LP_REBALANCE" && upperBoundaryLp.actionableDeliverable.service === "LP_REBALANCE") {
      upperBoundaryLp.request.marketState.currentTick = upperBoundaryLp.actionableDeliverable.proposedRange!.upperTick;
    }
    expect(runProviderContractPreflight(upperBoundaryLp).outcome, "LP upper-exclusive tick").toBe("CONTRACT_FAIL");

    const policyMutations: Record<ServiceId, (packet: ProviderContractPacket) => void> = {
      LENDING_RESCUE: (packet) => {
        if (packet.request.service === "LENDING_RESCUE") packet.request.targetHealthFactor = "1.01";
      },
      LP_REBALANCE: (packet) => {
        if (packet.actionableDeliverable.service === "LP_REBALANCE") {
          packet.actionableDeliverable.expectedNetBenefitUsd = "4.999999999999999999";
        }
      },
      YIELD_OPTIMIZATION: (packet) => {
        if (packet.actionableDeliverable.service === "YIELD_OPTIMIZATION") {
          packet.actionableDeliverable.netBenefitUsd = "4.999999999999999999";
        }
      },
      BOUNDED_GRID: (packet) => {
        if (packet.request.service === "BOUNDED_GRID") {
          packet.request.marketState.midPrice = packet.request.constraints.lowerPrice;
        }
      },
    };
    for (const service of Object.keys(packets) as ServiceId[]) {
      const rejected = structuredClone(packets[service]);
      policyMutations[service](rejected);
      expect(runProviderContractPreflight(rejected).outcome, `${service} canonical policy`).toBe("CONTRACT_FAIL");
    }
  });

  it("detects a tampered result hash", async () => {
    const packets = await templates();
    const result = runProviderContractPreflight(packets.BOUNDED_GRID);
    expect(verifyProviderContractPreflightResult(result)).toBe(true);
    expect(verifyProviderContractPreflightResult({
      ...result,
      checks: result.checks.map((check, index) => index === 0 ? { ...check, summary: "Tampered" } : check),
    })).toBe(false);
  });

  it("does not hide an executable yield withdrawal inside a refusal example", async () => {
    const packet = (await templates()).YIELD_OPTIMIZATION;
    if (packet.refusalDeliverable.service !== "YIELD_OPTIMIZATION" || packet.actionableDeliverable.service !== "YIELD_OPTIMIZATION") throw new Error("Expected yield");
    expect(packet.refusalDeliverable.withdrawals).toBeUndefined();
    packet.refusalDeliverable.withdrawals = structuredClone(packet.actionableDeliverable.withdrawals!);
    expect(runProviderContractPreflight(packet).outcome).toBe("CONTRACT_FAIL");
  });
});
