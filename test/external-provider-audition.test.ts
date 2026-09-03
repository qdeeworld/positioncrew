import { describe, expect, it } from "vitest";
import {
  createLendingProviderAudition,
  LendingProviderAuditionSchema,
  verifyLendingProviderAuditionCommitment,
} from "../src/marketplace/lending-provider-audition.js";
import { lendingFixture } from "./helpers.js";

const OBSERVED_AT = "2026-08-30T05:24:24.186Z";
const EVALUATED_AT = new Date("2026-08-30T05:24:25.186Z");
const EXPLORER_URL = "https://bscscan.com/block/118900000";

async function audition() {
  const request = lendingFixture();
  request.chainId = 56;
  request.protocol = "Venus Classic";
  request.sources = [{
    sourceId: "venus-mainnet-block-118900000",
    label: "Block-pinned Venus mainnet test observation",
    uri: EXPLORER_URL,
    observedAt: OBSERVED_AT,
  }];
  request.position.collateral = request.position.collateral.map((entry) => ({
    ...entry,
    sourceId: "venus-mainnet-block-118900000",
    observedAt: OBSERVED_AT,
  }));
  request.position.debt = request.position.debt.map((entry) => ({
    ...entry,
    sourceId: "venus-mainnet-block-118900000",
    observedAt: OBSERVED_AT,
  }));
  return await createLendingProviderAudition(
    request,
    {
      blockNumber: "118900000",
      observedAt: OBSERVED_AT,
      explorerUrl: EXPLORER_URL,
    },
    EVALUATED_AT,
  );
}

describe("external provider audition evidence", () => {
  it("preserves the attributable mainnet delivery without promoting compatibility", async () => {
    const result = await audition();
    const evidence = result.externalProviderAudit;

    expect(evidence).toBeDefined();
    expect(evidence).toMatchObject({
      schemaVersion: "positioncrew.external-provider-audition.v1",
      chainId: 56,
      provider: {
        name: "Brain on BNB",
        address: "0x73809F69916FcF7Ddc5BB1315fBdf96A569a5963",
      },
      commerce: {
        protocol: "ERC-8183",
        jobId: "56699",
        contentHashMatchesOnchain: true,
        escrowedAmount: "0.10 U",
        settlementStatus: "PENDING_OPTIMISTIC_WINDOW",
      },
      validation: {
        status: "DELIVERED_INCOMPATIBLE",
        passedChecks: 9,
        failedChecks: 3,
      },
    });
    expect(evidence?.validation.checks.filter((check) => check.status === "FAIL").map(
      (check) => check.code,
    )).toEqual(["PROTOCOL_BINDING", "PROTOCOL_CROSS_CHECK", "BLOCK_ATTRIBUTION"]);
    expect(result.selection.eligibleCandidateCount).toBe(1);
    expect(result.selection.winnerProviderSlug).toBe("lending-rescue");
    expect(result.claimBoundary).not.toContain(expect.stringMatching(/strongest|ranked/i));
  });

  it("survives receipt serialization and remains bound by the audition commitment", async () => {
    const result = await audition();
    const serialized = JSON.stringify(result);
    const restored = LendingProviderAuditionSchema.parse(JSON.parse(serialized));

    await expect(verifyLendingProviderAuditionCommitment(restored)).resolves.toBe(true);

    const tampered = LendingProviderAuditionSchema.parse({
      ...restored,
      externalProviderAudit: {
        ...restored.externalProviderAudit,
        validation: {
          ...restored.externalProviderAudit?.validation,
          boundary: "The external provider is eligible.",
        },
      },
    });
    await expect(verifyLendingProviderAuditionCommitment(tampered)).resolves.toBe(false);
  });
});
