import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalHash } from "../src/core/canonical.js";
import { LpRebalanceRequestSchema } from "../src/contracts/lp-rebalance.js";
import { runCurrentBlockPinnedProviderRequest } from "../src/api/fixture-jobs.js";
import { createLpLiveMatchAudition, executeLpLiveMatchProvider, selectLpLiveMatchProvider } from "../src/marketplace/lp-live-match.js";
import { auditionHeyAnonV3LpJob, HeyAnonMcpCallError } from "../src/marketplace/heyanon-v3pools-lp-job-adapter.js";
import { validatedFreshMarketplaceChain } from "../web/src/job-history.js";
import { FixtureJobResponseSchema } from "../src/api/fixture-response-schema.js";
import { sha256Commitment } from "../src/commerce/fresh-hire-schema.js";
import { BscPositionVerificationError, BscVerificationRpcError, createBscVerificationRpc } from "../src/marketplace/bsc-verification-rpc.js";

vi.mock("../src/marketplace/heyanon-v3pools-lp-job-adapter.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/marketplace/heyanon-v3pools-lp-job-adapter.js")>(),
  auditionHeyAnonV3LpJob: vi.fn(),
}));
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
    marketState: { ...fixture.marketState, token1PriceUsd: String(1 / 1.0001 ** fixture.marketState.currentTick), sourceId: "test-block", observedAt: source.observedAt },
  });
  const response = await runCurrentBlockPinnedProviderRequest(request, now);
  const assessment = {
    eligibleForLpRebalance: true, attributableResult: true,
    normalizedDeliverable: response.result.deliverable,
    recommendation: { lowerTick: 0, upperTick: 240, widthTicks: 240 },
    invocation: { rawResponseHash: hash, materialTermsHash: hash, normalizedResponseHash: canonicalHash(response.result.deliverable), latencyMilliseconds: 3 },
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
  it.each(["FETCH", "RESPONSE_BODY"])("retains the selected-job deadline during real verification %s cancellation", async (phase) => {
    vi.useFakeTimers();
    try {
      const input = await prepared();
      input.request.deadline = new Date(input.now.getTime() + 1_000).toISOString();
      let reads = 0;
      mockAudition.mockImplementationOnce(async (_request, _position, options) => {
        const fetchImpl: typeof fetch = async () => {
          reads += 1;
          if (phase === "FETCH") return new Promise<Response>(() => {});
          const response = new Response("");
          response.json = () => new Promise<unknown>(() => {});
          return response;
        };
        const rpc = createBscVerificationRpc("https://bsc-rpc.publicnode.com", fetchImpl, { signal: options!.signal! });
        await rpc.request("eth_blockNumber", []);
        throw new Error("An expired prerequisite must not reach the provider");
      });
      const pending = executeLpLiveMatchProvider(input);
      await vi.advanceTimersByTimeAsync(1_000);
      const response = await pending;
      expect(response.liveMatchExecution?.outcome).toBe("REFUSED");
      expect(response.liveMatchExecution?.invocation.checks[0]?.code).toBe("LP_DELIVERY_DEADLINE");
      expect(response.liveMatchExecution?.invocation.checks[0]?.detail).toContain("after 1000 ms");
      expect(response.liveMatchExecution?.invocation.rawResponseHash).toBeNull();
      expect(response.result.job.providerId).toBe("erc8004:56:45650");
      expect(reads).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not relabel an independent verification error just because the delivery timer also fired", async () => {
    vi.useFakeTimers();
    try {
      const input = await prepared();
      input.request.deadline = new Date(input.now.getTime() + 1_000).toISOString();
      mockAudition.mockImplementationOnce(async (_request, _position, options) => new Promise((_resolve, reject) => {
        options!.signal!.addEventListener("abort", () => reject(new BscVerificationRpcError("HTTP 403")), { once: true });
      }));
      const pending = executeLpLiveMatchProvider(input);
      await vi.advanceTimersByTimeAsync(1_000);
      const response = await pending;
      expect(response.liveMatchExecution?.invocation.checks[0]?.code).toBe("BSC_POSITION_VERIFICATION");
      expect(response.liveMatchExecution?.invocation.checks[0]?.detail).toContain("HTTP 403");
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows a slower fresh delivery within the bounded selected-job budget without another invocation", async () => {
    vi.useFakeTimers();
    try {
      const input = await prepared();
      mockAudition.mockImplementationOnce(async (_request, _position, options) => {
        expect(options?.mcpTimeoutMilliseconds).toBe(15_000);
        await new Promise<void>((resolve) => setTimeout(resolve, 14_000));
        return input.assessment;
      });
      const pending = executeLpLiveMatchProvider(input);
      await vi.advanceTimersByTimeAsync(14_000);
      const response = await pending;
      expect(response.liveMatchExecution?.outcome).toBe("DELIVERED");
      expect(response.result.job.providerId).toBe("erc8004:56:45650");
      expect(mockAudition).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["request deadline", "source freshness"])("never extends the %s to accommodate a slow provider", async (limit) => {
    vi.useFakeTimers();
    try {
      const input = await prepared();
      const remaining = limit === "request deadline" ? 2_500 : 1_000;
      if (limit === "request deadline") input.request.deadline = new Date(input.now.getTime() + remaining).toISOString();
      else {
        input.request.maxDataAgeSeconds = 30;
        input.request.marketState.observedAt = new Date(input.now.getTime() - 29_000).toISOString();
      }
      mockAudition.mockImplementationOnce(async (_request, _position, options) => {
        expect(options?.mcpTimeoutMilliseconds).toBe(remaining);
        return new Promise((_resolve, reject) => {
          const aborted = () => reject(new HeyAnonMcpCallError("getCurrentPoolPrice", "FETCH", "CALLER_CANCELLED"));
          options!.signal!.addEventListener("abort", aborted, { once: true });
          if (options!.signal!.aborted) aborted();
        });
      });
      const pending = executeLpLiveMatchProvider(input);
      await vi.advanceTimersByTimeAsync(remaining);
      const response = await pending;
      expect(response.liveMatchExecution?.outcome).toBe("REFUSED");
      expect(response.liveMatchExecution?.invocation.checks[0]?.code).toBe("LP_DELIVERY_DEADLINE");
      expect(response.liveMatchExecution?.invocation.checks[0]?.detail).toContain(`after ${remaining} ms`);
      expect(response.result.job.providerId).toBe("erc8004:56:45650");
      expect(mockAudition).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { phase: "FETCH", kind: "CALLER_CANCELLED", expected: "LP_DELIVERY_DEADLINE" },
    { phase: "RESPONSE_BODY", kind: "CALLER_CANCELLED", expected: "LP_DELIVERY_DEADLINE" },
    { phase: "FETCH", kind: "LOCAL_TIMEOUT", expected: "HEYANON_MCP_LOCAL_TIMEOUT" },
    { phase: "RESPONSE_BODY", kind: "TRANSPORT_FAILURE", expected: "HEYANON_MCP_TRANSPORT_FAILURE" },
  ] as const)("preserves $kind provenance during $phase after delayed prerequisites", async ({ phase, kind, expected }) => {
    vi.useFakeTimers();
    try {
      const input = await prepared();
      mockAudition.mockImplementationOnce(async (_request, _positionId, options) => {
        // Six seconds of prerequisites leave less than the MCP's own
        // fifteen-second budget before the twenty-second delivery deadline.
        await new Promise<void>((resolve) => setTimeout(resolve, 6_000));
        return new Promise<Awaited<ReturnType<typeof auditionHeyAnonV3LpJob>>>((_resolve, reject) => {
          const aborted = () => reject(new HeyAnonMcpCallError("getPredefinedPriceRanges", phase, kind));
          options!.signal!.addEventListener("abort", aborted, { once: true });
          if (options!.signal!.aborted) aborted();
        });
      });
      const pending = executeLpLiveMatchProvider(input);
      await vi.advanceTimersByTimeAsync(20_000);
      const response = await pending;
      expect(response.liveMatchExecution?.outcome).toBe("REFUSED");
      expect(response.result.deliverable.decision).toBe("NONE");
      expect(response.result.job.providerId).toBe("erc8004:56:45650");
      expect(response.liveMatchExecution?.invocation.rawResponseHash).toBeNull();
      expect(response.liveMatchExecution?.invocation.checks[0]?.code).toBe(expected);
      if (kind === "CALLER_CANCELLED") {
        expect(response.liveMatchExecution?.invocation.checks[0]?.detail)
          .toContain("PositionCrew's LP delivery deadline expired after 20000 ms");
      }
      expect(mockAudition).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["position-abi", "factory-abi", "unsupported-fee", "rpc-429"])(
    "persists %s as a verification refusal without provider substitution",
    async (failure) => {
      const input = await prepared();
      const error = failure === "rpc-429"
        ? new BscVerificationRpcError("HTTP 429")
        : new BscPositionVerificationError(`PositionCrew BSC position verification failed: ${failure}`);
      mockAudition.mockRejectedValueOnce(error);
      const response = await executeLpLiveMatchProvider(input);
      expect(response.liveMatchExecution?.outcome).toBe("REFUSED");
      expect(response.result.deliverable.decision).toBe("NONE");
      expect(response.result.job.providerId).toBe("erc8004:56:45650");
      expect(response.liveMatchExecution?.invocation.rawResponseHash).toBeNull();
      expect(response.liveMatchExecution?.invocation.checks).toEqual([
        { code: "BSC_POSITION_VERIFICATION", status: "FAIL", detail: error.message },
      ]);
      expect(mockAudition).toHaveBeenCalledTimes(2);
    },
  );

  it("retains provider-stage attribution for a genuine selected-provider MCP failure", async () => {
    const input = await prepared();
    mockAudition.mockRejectedValueOnce(new Error("HeyAnon V3 MCP returned HTTP 503"));
    const response = await executeLpLiveMatchProvider(input);
    expect(response.liveMatchExecution?.outcome).toBe("REFUSED");
    expect(response.result.job.providerId).toBe("erc8004:56:45650");
    expect(response.liveMatchExecution?.invocation.checks).toEqual([
      { code: "FRESH_SELECTED_PROVIDER_RUN", status: "FAIL", detail: "HeyAnon V3 MCP returned HTTP 503" },
    ]);
    expect(mockAudition).toHaveBeenCalledTimes(2);
  });

  it("refuses evidence that becomes stale during the external call even before the deadline", async () => {
    vi.useFakeTimers();
    try {
      const input = await prepared();
      input.request.maxDataAgeSeconds = 30;
      input.requestHash = await sha256Commitment(input.request);
      input.audition.requestHash = input.requestHash;
      input.evidenceHash = await sha256Commitment(input.evidence);
      input.selection.auditionHash = input.evidenceHash;
      mockAudition.mockImplementationOnce(async () => {
        vi.setSystemTime(input.now.getTime() + 31000);
        return input.assessment;
      });
      const response = await executeLpLiveMatchProvider(input);
      expect(response.liveMatchExecution?.outcome).toBe("REFUSED");
      expect(response.result.deliverable.decision).toBe("NONE");
      expect(response.liveMatchExecution?.invocation.checks[0]?.detail).toContain("became stale");
    } finally {
      vi.useRealTimers();
    }
  });
  it("persists an expired refusal when the request expires during the external call", async () => {
    vi.useFakeTimers();
    try {
      const input = await prepared();
      mockAudition.mockImplementationOnce(async () => {
        vi.setSystemTime(Date.parse(input.request.deadline) + 1);
        return input.assessment;
      });
      const response = await executeLpLiveMatchProvider(input);
      expect(response.result.deliverable.status).toBe("REFUSED_EXPIRED");
      expect(response.liveMatchExecution?.outcome).toBe("REFUSED");
      expect(response.result.job.providerId).toBe("erc8004:56:45650");
    } finally {
      vi.useRealTimers();
    }
  });
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
    if (failure === "changed") mockAudition.mockResolvedValueOnce({ ...input.assessment, invocation: { ...input.assessment.invocation, materialTermsHash: `sha256:${"b".repeat(64)}` } });
    if (failure === "incompatible") mockAudition.mockResolvedValueOnce({ ...input.assessment, eligibleForLpRebalance: false });
    const response = await executeLpLiveMatchProvider(input);
    expect(response.liveMatchExecution?.outcome).toBe("REFUSED");
    expect(response.result.deliverable.decision).toBe("NONE");
    expect(response.result.job.providerId).toBe("erc8004:56:45650");
    expect(mockAudition).toHaveBeenCalledTimes(2);
  });

  it("accepts independently coherent live evidence changes when committed material terms are unchanged", async () => {
    const input = await prepared();
    mockAudition.mockResolvedValueOnce({ ...input.assessment, invocation: {
      ...input.assessment.invocation, rawResponseHash: `sha256:${"b".repeat(64)}`,
    } });
    const response = await executeLpLiveMatchProvider(input);
    expect(response.liveMatchExecution?.outcome).toBe("DELIVERED");
    expect(response.liveMatchExecution?.invocation.rawResponseHash).not.toBe(hash);
    expect(response.result.job.providerId).toBe("erc8004:56:45650");
  });
});
