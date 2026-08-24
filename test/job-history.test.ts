import { describe, expect, it } from "vitest";
import { runCurrentBlockPinnedProviderRequest, runFrozenFixture } from "../src/api/fixture-jobs.js";
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
    const chainFor = (
      response: Awaited<ReturnType<typeof runFrozenFixture>>,
      evidenceMode: "HISTORICAL_FIXTURE" | "CURRENT_BLOCK_PINNED",
    ): Record<string, unknown> => {
      const providerId = response.result.job.providerId;
      const deliverable = response.result.job.deliverable;
      if (!providerId || !deliverable) throw new Error("Canonical fixture is missing completed provider evidence");
      return {
        schemaVersion: "positioncrew.fresh-marketplace-chain.v1",
        hire: { hireId, service: "LP_REBALANCE", providerId, evidenceMode },
        job: {
          jobId: "88888888-8888-4888-8888-888888888888",
          state: "COMPLETED",
          error: null,
        },
        receipt: {
          receiptId: "77777777-7777-4777-8777-777777777777",
          publicUrl: "/api/benchmark-receipts/77777777-7777-4777-8777-777777777777",
          responseHash: `sha256:${"9".repeat(64)}`,
          deliverableHash: deliverable.deliverableHash,
          evaluationHash: response.result.evaluation.evaluationHash,
          createdAt: response.generatedAt,
          response,
        },
      };
    };

    const saved = referenceFor(historicalResponse.generatedAt);
    const chain = chainFor(historicalResponse, "HISTORICAL_FIXTURE");
    expect(isFreshMarketplaceChainForReference(chain, saved)).toBe(true);

    const currentResponse = await runCurrentBlockPinnedProviderRequest(
      historicalResponse.result.request,
      new Date(historicalResponse.generatedAt),
    );
    const current = chainFor(currentResponse, "CURRENT_BLOCK_PINNED");
    expect(isFreshMarketplaceChainForReference(current, saved)).toBe(true);

    const wrongResponseMode = structuredClone(current);
    const wrongModeReceipt = wrongResponseMode.receipt as Record<string, unknown>;
    (wrongModeReceipt.response as Record<string, unknown>).evidenceMode = "CALLER_SUPPLIED_OBSERVATIONS";
    expect(isFreshMarketplaceChainForReference(wrongResponseMode, saved)).toBe(false);

    const mismatchedHire = structuredClone(chain);
    (mismatchedHire.hire as Record<string, unknown>).hireId = reference(2).hireId;
    expect(isFreshMarketplaceChainForReference(mismatchedHire, saved)).toBe(false);

    expect(isFreshMarketplaceChainForReference({ ...chain, receipt: null }, saved)).toBe(false);

    const mismatchedService = structuredClone(chain);
    const mismatchedServiceResponse = ((mismatchedService.receipt as Record<string, unknown>).response as Record<string, unknown>);
    const mismatchedServiceResult = mismatchedServiceResponse.result as Record<string, unknown>;
    (mismatchedServiceResult.request as Record<string, unknown>).service = "BOUNDED_GRID";
    expect(isFreshMarketplaceChainForReference(mismatchedService, saved)).toBe(false);

    const mismatchedProvider = structuredClone(chain);
    const mismatchedProviderResponse = ((mismatchedProvider.receipt as Record<string, unknown>).response as Record<string, unknown>);
    const mismatchedProviderResult = mismatchedProviderResponse.result as Record<string, unknown>;
    (mismatchedProviderResult.job as Record<string, unknown>).providerId = "positioncrew:other-provider:v1";
    expect(isFreshMarketplaceChainForReference(mismatchedProvider, saved)).toBe(false);

    const invalidExpiry = structuredClone(chain);
    const invalidExpiryResponse = ((invalidExpiry.receipt as Record<string, unknown>).response as Record<string, unknown>);
    const invalidExpiryResult = invalidExpiryResponse.result as Record<string, unknown>;
    (invalidExpiryResult.deliverable as Record<string, unknown>).expiresAt = "not-a-date";
    expect(isFreshMarketplaceChainForReference(invalidExpiry, saved)).toBe(false);

    const invalidCategoryPayload = structuredClone(chain);
    const invalidCategoryResponse = ((invalidCategoryPayload.receipt as Record<string, unknown>).response as Record<string, unknown>);
    const invalidCategoryResult = invalidCategoryResponse.result as Record<string, unknown>;
    (invalidCategoryResult.deliverable as Record<string, unknown>).actionSteps = [{}];
    expect(isFreshMarketplaceChainForReference(invalidCategoryPayload, saved)).toBe(false);

    const invalidError = structuredClone(chain);
    invalidError.job = {
      ...(invalidError.job as Record<string, unknown>),
      state: "FAILED",
      error: { code: "PROVIDER_TIMEOUT", message: 42 },
    };
    invalidError.receipt = null;
    expect(isFreshMarketplaceChainForReference(invalidError, saved)).toBe(false);
  });
});
