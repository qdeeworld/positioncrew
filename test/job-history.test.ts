import { describe, expect, it } from "vitest";
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

  it("accepts only a server chain bound to the saved hire and service", () => {
    const saved = reference(1);
    const chain = {
      schemaVersion: "positioncrew.fresh-marketplace-chain.v1",
      hire: { hireId: saved.hireId, service: saved.service },
      job: { jobId: "job-1", state: "COMPLETED" },
      receipt: { publicUrl: "/receipt/1", response: {} },
    };
    expect(isFreshMarketplaceChainForReference(chain, saved)).toBe(true);
    expect(isFreshMarketplaceChainForReference({ ...chain, hire: { ...chain.hire, hireId: reference(2).hireId } }, saved)).toBe(false);
    expect(isFreshMarketplaceChainForReference({ ...chain, receipt: null }, saved)).toBe(false);
  });
});
