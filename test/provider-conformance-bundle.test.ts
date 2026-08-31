import { describe, expect, it } from "vitest";

import {
  buildProviderConformanceBundle,
  verifyProviderConformanceBundle,
} from "../src/marketplace/provider-conformance-bundle.js";

describe("provider conformance bundle", () => {
  it("exports deterministic passing packets for all four categories", async () => {
    const first = await buildProviderConformanceBundle();
    const second = await buildProviderConformanceBundle();
    expect(first.services).toEqual([
      "LENDING_RESCUE",
      "LP_REBALANCE",
      "YIELD_OPTIMIZATION",
      "BOUNDED_GRID",
    ]);
    expect(Object.values(first.results).every((result) => result.outcome === "CONTRACT_PASS")).toBe(true);
    expect(first.bundleHash).toBe(second.bundleHash);
    expect(verifyProviderConformanceBundle(first)).toBe(true);
  });

  it("rejects packet and report tampering", async () => {
    const bundle = await buildProviderConformanceBundle();
    const tamperedPacket = structuredClone(bundle);
    tamperedPacket.packets.BOUNDED_GRID.manifest.operator = "Tampered operator";
    expect(verifyProviderConformanceBundle(tamperedPacket)).toBe(false);

    const tamperedResult = structuredClone(bundle);
    tamperedResult.results.LENDING_RESCUE.checks[0]!.summary = "Tampered result";
    expect(verifyProviderConformanceBundle(tamperedResult)).toBe(false);
  });
});
