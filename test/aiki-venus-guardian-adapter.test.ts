import { describe, expect, it } from "vitest";
import type {
  LendingRescueDeliverable,
  LendingRescueRequest,
} from "../src/contracts/lending-rescue.js";
import { auditionAiKiVenusGuardian } from "../src/marketplace/aiki-venus-guardian-adapter.js";

const request = {
  account: "0xe02702687b1653a782af57fbcc56d59b7e99a935",
  targetHealthFactor: "1.25",
  maxDataAgeSeconds: 300,
} as LendingRescueRequest;

const firstParty = {
  decision: "REPAY_DEBT",
  position: { currentHealthFactor: "1.21185497" },
} as LendingRescueDeliverable;

function body(account = request.account): unknown {
  return {
    assessment: {
      account,
      protocol: "Venus",
      category: "health_factor",
      assessmentVersion: "venus-health/v1",
      observedAt: "2026-08-30T12:00:00.000Z",
      status: "AT_RISK",
      minimumHealthFactor: "1.25",
      healthFactor: "1.211855005406098484",
      methodology: "Venus Comptroller cross-check",
      consistency: { verified: true, detail: "Verified." },
    },
    evidence: { observationsInserted: 11, persisted: true },
  };
}

describe("AiKi Venus guardian adapter", () => {
  it("proves a comparable diagnosis without making the monitor rescue-eligible", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify(body()), { status: 200 })) as typeof fetch;
    const result = await auditionAiKiVenusGuardian(request, firstParty, {
      fetchImpl,
      now: new Date("2026-08-30T12:01:00.000Z"),
    });

    expect(result.outcome).toBe("SEMANTICALLY_COMPARABLE");
    expect(result.completedSamePositionAssessment).toBe(true);
    expect(result.healthFactorDifferenceBps).toBeLessThan(5);
    expect(result.eligibleForRescueSelection).toBe(false);
    expect(result.eligibleForLiveMatch).toBe(false);
    expect(result.checks).toContainEqual(
      expect.objectContaining({ code: "HEALTH_FACTOR_ALIGNMENT", status: "PASS" }),
    );
    expect(result.checks).toContainEqual(
      expect.objectContaining({ code: "RESCUE_OUTPUT_CONTRACT", status: "FAIL" }),
    );
  });

  it("rejects a different account", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify(body("0x0000000000000000000000000000000000000000")),
        { status: 200 },
      )) as typeof fetch;
    const result = await auditionAiKiVenusGuardian(request, firstParty, {
      fetchImpl,
      now: new Date("2026-08-30T12:01:00.000Z"),
    });

    expect(result.outcome).toBe("INCOMPATIBLE");
    expect(result.completedSamePositionAssessment).toBe(false);
  });
});
