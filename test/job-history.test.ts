import { describe, expect, it } from "vitest";
import { runCurrentBlockPinnedProviderRequest, runFrozenFixture } from "../src/api/fixture-jobs.js";
import { sha256Commitment } from "../src/commerce/fresh-hire-schema.js";
import {
  clearRecentJobReferences,
  isFreshMarketplaceChainForReference,
  readRecentJobReferences,
  RECENT_JOB_LIMIT,
  RECENT_JOB_STORAGE_KEY,
  rememberRecentJobReference,
  removeRecentJobReference,
  type RecentJobReference,
  type StorageLike,
} from "../web/src/job-history.js";

class MemoryStorage implements StorageLike {
  values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function reference(index = 1): RecentJobReference {
  const suffix = String(index).padStart(12, "0");
  return {
    hireId: `11111111-1111-4111-8111-${suffix}`,
    service: "LENDING_RESCUE",
    rememberedAt: new Date(Date.UTC(2026, 7, 24, 12, index)).toISOString(),
  };
}

describe("recent job device index", () => {
  it("stores only the bounded reference schema and deduplicates newest first", () => {
    const storage = new MemoryStorage();
    for (let index = 1; index <= RECENT_JOB_LIMIT + 3; index += 1) {
      expect(rememberRecentJobReference(reference(index), storage).ok).toBe(true);
    }
    const newer = { ...reference(8), rememberedAt: "2026-08-25T00:00:00.000Z" };
    rememberRecentJobReference(newer, storage);

    const stored = JSON.parse(storage.getItem(RECENT_JOB_STORAGE_KEY) ?? "null") as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(["entries", "schemaVersion"]);
    const entries = stored.entries as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(RECENT_JOB_LIMIT);
    expect(Object.keys(entries[0]!).sort()).toEqual(["hireId", "rememberedAt", "service"]);
    expect(JSON.stringify(stored)).not.toMatch(/request|response|account|collateral|wallet/i);
    expect(entries.filter((entry) => entry.hireId === newer.hireId)).toHaveLength(1);
  });

  it("fails closed for malformed or over-broad saved entries", () => {
    const storage = new MemoryStorage();
    storage.setItem(RECENT_JOB_STORAGE_KEY, JSON.stringify({
      schemaVersion: "positioncrew.recent-jobs.v1",
      entries: [
        reference(1),
        { ...reference(2), request: { account: "0xprivate" } },
        { ...reference(3), hireId: "not-a-uuid" },
      ],
    }));

    const result = readRecentJobReferences(storage);
    expect(result.available).toBe(true);
    expect(result.entries).toEqual([reference(1)]);
    expect(result.corruptCount).toBe(2);

    storage.setItem(RECENT_JOB_STORAGE_KEY, "not-json");
    expect(readRecentJobReferences(storage)).toEqual({ available: false, entries: [], corruptCount: 0 });
  });

  it("reports denied storage without throwing", () => {
    const denied: StorageLike = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
      removeItem: () => { throw new Error("denied"); },
    };
    expect(readRecentJobReferences(denied).available).toBe(false);
    expect(rememberRecentJobReference(reference(1), denied).reason).toBe("STORAGE_UNAVAILABLE");
    expect(clearRecentJobReferences(denied).reason).toBe("STORAGE_UNAVAILABLE");
  });

  it("removes one reference or clears the device index without deleting server data", () => {
    const storage = new MemoryStorage();
    rememberRecentJobReference(reference(1), storage);
    rememberRecentJobReference(reference(2), storage);
    expect(removeRecentJobReference(reference(1).hireId, storage).entries).toEqual([reference(2)]);
    expect(clearRecentJobReferences(storage).ok).toBe(true);
    expect(storage.getItem(RECENT_JOB_STORAGE_KEY)).toBeNull();
  });

  it("accepts only a canonical server response bound to the saved hire and service", async () => {
    const historicalResponse = await runFrozenFixture("LP_REBALANCE");
    const hireId = "99999999-9999-4999-8999-999999999999";
    const referenceFor = (rememberedAt: string): RecentJobReference => ({
      hireId,
      service: "LP_REBALANCE",
      rememberedAt,
    });
    const chainFor = async (
      response: Awaited<ReturnType<typeof runFrozenFixture>>,
      evidenceMode: "HISTORICAL_FIXTURE" | "CURRENT_BLOCK_PINNED",
    ): Promise<Record<string, unknown>> => {
      const providerId = response.result.job.providerId;
      const deliverable = response.result.job.deliverable;
      if (!providerId || !deliverable) throw new Error("Canonical fixture is missing completed provider evidence");
      const currentBlockPinned = evidenceMode === "CURRENT_BLOCK_PINNED";
      const persistedRequest = currentBlockPinned
        ? structuredClone(response.result.request)
        : {
            schemaVersion: "positioncrew.fresh-marketplace-provider-request.v1",
            benchmarkSlug: "lp-rebalance",
            providerSlug: "lp-rebalance",
            providerId,
            requestSchema: "positioncrew.lp-rebalance.request.v1",
            evidenceMode: "HISTORICAL_FIXTURE",
            directCostUsd: "0.00",
            walletRequired: false,
          };
      return {
        schemaVersion: "positioncrew.fresh-marketplace-chain.v1",
        hire: {
          hireId,
          service: "LP_REBALANCE",
          benchmarkSlug: "lp-rebalance",
          providerSlug: "lp-rebalance",
          providerId,
          evidenceMode,
          request: persistedRequest,
          requestHash: currentBlockPinned
            ? response.result.evaluation.requestHash
            : `sha256:${"1".repeat(64)}`,
        },
        job: {
          jobId: "88888888-8888-4888-8888-888888888888",
          state: "COMPLETED",
          status: "COMPLETED",
          error: null,
        },
        receipt: {
          receiptId: "77777777-7777-4777-8777-777777777777",
          publicUrl: "/api/benchmark-receipts/77777777-7777-4777-8777-777777777777",
          responseHash: await sha256Commitment(response),
          deliverableHash: deliverable.deliverableHash,
          evaluationHash: response.result.evaluation.evaluationHash,
          createdAt: response.generatedAt,
          response,
        },
      };
    };

    const saved = referenceFor(historicalResponse.generatedAt);
    const chain = await chainFor(historicalResponse, "HISTORICAL_FIXTURE");
    expect(await isFreshMarketplaceChainForReference(chain, saved)).toBe(true);
    expect((chain.hire as Record<string, unknown>).requestHash)
      .not.toBe(historicalResponse.result.evaluation.requestHash);

    const currentResponse = await runCurrentBlockPinnedProviderRequest(
      historicalResponse.result.request,
      new Date(historicalResponse.generatedAt),
    );
    const current = await chainFor(currentResponse, "CURRENT_BLOCK_PINNED");
    expect(await isFreshMarketplaceChainForReference(current, saved)).toBe(true);

    const wrongResponseMode = structuredClone(current);
    const wrongModeReceipt = wrongResponseMode.receipt as Record<string, unknown>;
    (wrongModeReceipt.response as Record<string, unknown>).evidenceMode = "CALLER_SUPPLIED_OBSERVATIONS";
    expect(await isFreshMarketplaceChainForReference(wrongResponseMode, saved)).toBe(false);

    const mismatchedHire = structuredClone(chain);
    (mismatchedHire.hire as Record<string, unknown>).hireId = reference(2).hireId;
    expect(await isFreshMarketplaceChainForReference(mismatchedHire, saved)).toBe(false);

    const copiedResponse = structuredClone(current);
    (copiedResponse.hire as Record<string, unknown>).requestHash = `sha256:${"a".repeat(64)}`;
    expect(await isFreshMarketplaceChainForReference(copiedResponse, saved)).toBe(false);

    const requestHashLocations = [
      ["job", "envelope"],
      ["job", "deliverable"],
      ["job", "evaluation"],
      ["evaluation"],
    ] as const;
    for (const location of requestHashLocations) {
      const alteredHash = structuredClone(chain);
      const alteredResponse = (alteredHash.receipt as Record<string, unknown>).response as Record<string, unknown>;
      const alteredResult = alteredResponse.result as Record<string, unknown>;
      let target = alteredResult;
      for (const key of location) {
        target = target[key] as Record<string, unknown>;
      }
      target.requestHash = `sha256:${"b".repeat(64)}`;
      expect(await isFreshMarketplaceChainForReference(alteredHash, saved)).toBe(false);
    }

    const alteredRequestBody = structuredClone(current);
    const alteredBodyResponse = (alteredRequestBody.receipt as Record<string, unknown>).response as Record<string, unknown>;
    const alteredBodyResult = alteredBodyResponse.result as Record<string, unknown>;
    (alteredBodyResult.request as Record<string, unknown>).account = "0x2222222222222222222222222222222222222222";
    expect(await isFreshMarketplaceChainForReference(alteredRequestBody, saved)).toBe(false);

    const alteredFixtureLock = structuredClone(chain);
    const alteredFixtureResponse = (alteredFixtureLock.receipt as Record<string, unknown>).response as Record<string, unknown>;
    (alteredFixtureResponse.benchmarkLock as Record<string, unknown>).fixtureHash = `sha256:${"2".repeat(64)}`;
    expect(await isFreshMarketplaceChainForReference(alteredFixtureLock, saved)).toBe(false);

    const alteredFixtureTask = structuredClone(chain);
    const alteredTaskResponse = (alteredFixtureTask.receipt as Record<string, unknown>).response as Record<string, unknown>;
    (alteredTaskResponse.benchmarkLock as Record<string, unknown>).taskId = "different-task";
    expect(await isFreshMarketplaceChainForReference(alteredFixtureTask, saved)).toBe(false);

    const alteredHistoricalMetadata = structuredClone(chain);
    const alteredMetadataHire = alteredHistoricalMetadata.hire as Record<string, unknown>;
    (alteredMetadataHire.request as Record<string, unknown>).requestSchema = "positioncrew.bounded-grid.request.v1";
    expect(await isFreshMarketplaceChainForReference(alteredHistoricalMetadata, saved)).toBe(false);

    const alteredResponse = structuredClone(chain);
    const alteredReceipt = alteredResponse.receipt as Record<string, unknown>;
    const alteredPayload = alteredReceipt.response as Record<string, unknown>;
    const alteredResult = alteredPayload.result as Record<string, unknown>;
    (alteredResult.deliverable as Record<string, unknown>).summary = "A schema-valid plan that was not committed by the receipt.";
    expect(await isFreshMarketplaceChainForReference(alteredResponse, saved)).toBe(false);

    const missingStatus = structuredClone(chain);
    delete (missingStatus.job as Record<string, unknown>).status;
    expect(await isFreshMarketplaceChainForReference(missingStatus, saved)).toBe(false);

    const mismatchedStatus = structuredClone(chain);
    (mismatchedStatus.job as Record<string, unknown>).status = "RUNNING";
    expect(await isFreshMarketplaceChainForReference(mismatchedStatus, saved)).toBe(false);

    expect(await isFreshMarketplaceChainForReference({ ...chain, receipt: null }, saved)).toBe(false);

    const mismatchedService = structuredClone(chain);
    const mismatchedServiceResponse = ((mismatchedService.receipt as Record<string, unknown>).response as Record<string, unknown>);
    const mismatchedServiceResult = mismatchedServiceResponse.result as Record<string, unknown>;
    (mismatchedServiceResult.request as Record<string, unknown>).service = "BOUNDED_GRID";
    expect(await isFreshMarketplaceChainForReference(mismatchedService, saved)).toBe(false);

    const mismatchedProvider = structuredClone(chain);
    const mismatchedProviderResponse = ((mismatchedProvider.receipt as Record<string, unknown>).response as Record<string, unknown>);
    const mismatchedProviderResult = mismatchedProviderResponse.result as Record<string, unknown>;
    (mismatchedProviderResult.job as Record<string, unknown>).providerId = "positioncrew:other-provider:v1";
    expect(await isFreshMarketplaceChainForReference(mismatchedProvider, saved)).toBe(false);

    const invalidExpiry = structuredClone(chain);
    const invalidExpiryResponse = ((invalidExpiry.receipt as Record<string, unknown>).response as Record<string, unknown>);
    const invalidExpiryResult = invalidExpiryResponse.result as Record<string, unknown>;
    (invalidExpiryResult.deliverable as Record<string, unknown>).expiresAt = "not-a-date";
    expect(await isFreshMarketplaceChainForReference(invalidExpiry, saved)).toBe(false);

    const invalidCategoryPayload = structuredClone(chain);
    const invalidCategoryResponse = ((invalidCategoryPayload.receipt as Record<string, unknown>).response as Record<string, unknown>);
    const invalidCategoryResult = invalidCategoryResponse.result as Record<string, unknown>;
    (invalidCategoryResult.deliverable as Record<string, unknown>).actionSteps = [{}];
    expect(await isFreshMarketplaceChainForReference(invalidCategoryPayload, saved)).toBe(false);

    const invalidError = structuredClone(chain);
    invalidError.job = {
      ...(invalidError.job as Record<string, unknown>),
      state: "FAILED",
      error: { code: "PROVIDER_TIMEOUT", message: 42 },
    };
    invalidError.receipt = null;
    expect(await isFreshMarketplaceChainForReference(invalidError, saved)).toBe(false);
  });
});
