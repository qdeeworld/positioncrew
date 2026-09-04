import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalHash } from "../src/core/canonical.js";
import { LpRebalanceRequestSchema } from "../src/contracts/lp-rebalance.js";
import { runCurrentBlockPinnedProviderRequest } from "../src/api/fixture-jobs.js";
import { createLpLiveMatchAudition, executeLpLiveMatchProvider, selectLpLiveMatchProvider } from "../src/marketplace/lp-live-match.js";
import { auditionHeyAnonV3LpJob } from "../src/marketplace/heyanon-v3pools-lp-job-adapter.js";
import { validatedFreshMarketplaceChain } from "../web/src/job-history.js";
import { FixtureJobResponseSchema } from "../src/api/fixture-response-schema.js";
import { sha256Commitment } from "../src/commerce/fresh-hire-schema.js";

vi.mock("../src/marketplace/heyanon-v3pools-lp-job-adapter.js", () => ({ auditionHeyAnonV3LpJob: vi.fn() }));
const mockAudition = vi.mocked(auditionHeyAnonV3LpJob);
const hireId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const hash = `sha256:${"a".repeat(64)}`;

async function prepared() {
  const now = new Date();
  const fixture = JSON.parse(readFileSync(new URL("../fixtures/lp-rebalance/out-of-range-v3-position.v1.json", import.meta.url), "utf8"));
  const source = { blockNumber: "119900001", observedAt: now.toISOString(), explorerUrl: "https://bscscan.com/block/119900001" };
  const request = LpRebalanceRequestSchema.parse({
    ...fixture, requestId: "pancake-position-9000001-test", requestedAt: now.toISOString(), deadline: new Date(now.getTime() + 300000).toISOString(),
    sources: [{ sourceId: "test-block", label: "Test block observation", uri: source.explorerUrl, observedAt: source.observedAt }],
    marketState: { ...fixture.marketState, sourceId: "test-block", observedAt: source.observedAt },
  });
  const response = await runCurrentBlockPinnedProviderRequest(request, now);
  const assessment = {
    eligibleForLpRebalance: true, attributableResult: true,
    normalizedDeliverable: response.result.deliverable,
    recommendation: { lowerTick: 0, upperTick: 240, widthTicks: 240 },
    invocation: { rawResponseHash: hash, normalizedResponseHash: canonicalHash(response.result.deliverable), latencyMilliseconds: 3 },
    checks: [{ code: "EXACT_JOB", status: "PASS", detail: "Selected provider passes this job." }],
    claimBoundary: ["Controlled adapter response for this test."],
  } as unknown as Awaited<ReturnType<typeof auditionHeyAnonV3LpJob>>;
  mockAudition.mockResolvedValue(assessment);
  const requestHash = await sha256Commitment(request);
  const { audition } = await createLpLiveMatchAudition(request, source, requestHash, now);
  const evidence = { schemaVersion: "positioncrew.current-block-pinned-evidence.v1", evidenceClass: "CURRENT_BLOCK_PINNED", chainId: 56, source, freshnessAtCreation: "FRESH", evaluatedAt: now.toISOString(), maxDataAgeSeconds: 300, lpLiveMatchAudition: audition };
  const evidenceHash = await sha256Commitment(evidence);
  const selection = selectLpLiveMatchProvider(audition, { schemaVersion: "positioncrew.lp-live-match-selection-request.v1", selectedProvider: "HEYANON", auditionHash: evidenceHash }, evidenceHash, now);
  return { now, source, request, requestHash, audition, evidence, evidenceHash, selection, assessment, hireId, jobId };
}

beforeEach(() => mockAudition.mockReset());

describe("selected external LP execution", () => {
  it("invokes HeyAnon again and reloads its attributed result while rejecting a changed selection", async () => {
    const input = await prepared();
    const response = await executeLpLiveMatchProvider(input);
    expect(mockAudition).toHaveBeenCalledTimes(2);
    expect(response.result.job.providerId).toBe("erc8004:56:45650");
    expect(response.liveMatchExecution?.outcome).toBe("DELIVERED");
    const chain = {
      schemaVersion: "positioncrew.fresh-marketplace-chain.v1",
      hire: { hireId, service: "LP_REBALANCE", providerSlug: "lp-rebalance", benchmarkSlug: "lp-rebalance", providerId: "positioncrew:provider:lp-rebalance:v1", request: input.request, requestHash: input.requestHash, evidenceMode: "CURRENT_BLOCK_PINNED", evidence: input.evidence, evidenceHash: input.evidenceHash, createdAt: input.now.toISOString() },
      job: { jobId, state: "COMPLETED", status: "COMPLETED", error: null, providerSelection: input.selection, providerSelectionHash: await sha256Commitment(input.selection) },
      receipt: { receiptId: "33333333-3333-4333-8333-333333333333", publicUrl: "/api/benchmark-receipts/test", response, responseHash: await sha256Commitment(response), deliverableHash: canonicalHash(response.result.deliverable), evaluationHash: response.result.evaluation.evaluationHash, createdAt: input.now.toISOString() },
    };
    expect(FixtureJobResponseSchema.safeParse(response)).toMatchObject({ success: true });
    expect(await sha256Commitment(input.request)).toBe(input.requestHash);
    expect(await sha256Commitment(input.evidence)).toBe(input.evidenceHash);
    expect(await sha256Commitment(input.selection)).toBe(chain.job.providerSelectionHash);
    expect(await sha256Commitment(response)).toBe(chain.receipt.responseHash);
    expect(await validatedFreshMarketplaceChain(chain)).not.toBeNull();
    const altered = structuredClone(chain);
    altered.job.providerSelection.providerId = "another-provider";
    altered.job.providerSelectionHash = await sha256Commitment(altered.job.providerSelection);
    expect(await validatedFreshMarketplaceChain(altered)).toBeNull();
  });

  it.each(["outage", "changed", "incompatible"])("persists a refusal for %s without changing the selected provider", async (failure) => {
    const input = await prepared();
    if (failure === "outage") mockAudition.mockRejectedValueOnce(new Error("Provider unavailable"));
    if (failure === "changed") mockAudition.mockResolvedValueOnce({ ...input.assessment, invocation: { ...input.assessment.invocation, rawResponseHash: `sha256:${"b".repeat(64)}` } });
    if (failure === "incompatible") mockAudition.mockResolvedValueOnce({ ...input.assessment, eligibleForLpRebalance: false });
    const response = await executeLpLiveMatchProvider(input);
    expect(response.liveMatchExecution?.outcome).toBe("REFUSED");
    expect(response.result.deliverable.decision).toBe("NONE");
    expect(response.result.job.providerId).toBe("erc8004:56:45650");
    expect(mockAudition).toHaveBeenCalledTimes(2);
  });
});
