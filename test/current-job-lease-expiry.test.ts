import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCurrentBlockPinnedProviderRequest } from "../src/api/fixture-jobs.js";
import { FreshMarketplaceStore, type D1Database, type D1PreparedStatement, type D1Result } from "../src/commerce/d1-marketplace-store.js";
import {
  CurrentBlockPinnedEvidenceSchema, CurrentLendingMarketplaceHireRequestSchema, FRESH_MARKETPLACE_TASKS,
  FreshMarketplaceChainSchema, canonicalJson, sha256Commitment,
} from "../src/commerce/fresh-hire-schema.js";
import { issueServerObservationBinding, verifyServerObservationBinding } from "../src/commerce/server-observation-binding.js";
import { LendingRescueRequestSchema } from "../src/contracts/lending-rescue.js";
import positionCrewWorker from "../worker/index.js";
import { lendingFixture } from "./helpers.js";

const NOW = "2026-09-05T12:00:00.000Z";
const KEY = "positioncrew-expired-lease-test-key-not-production";
const HIRE = "11111111-1111-4111-8111-111111111111";
const JOB = "22222222-2222-4222-8222-222222222222";
const RECEIPT = "33333333-3333-4333-8333-333333333333";
const SOURCE_ID = "venus-mainnet-block-120000000";
const source = { blockNumber: "120000000", observedAt: NOW, explorerUrl: "https://bscscan.com/block/120000000" };
const openDatabases: DatabaseSync[] = [];
const later = (milliseconds: number) => new Date(Date.parse(NOW) + milliseconds);

class SqliteStatement implements D1PreparedStatement {
  constructor(private readonly sqlite: DatabaseSync, private readonly sql: string, private readonly values: SQLInputValue[] = []) {}
  bind(...values: unknown[]): D1PreparedStatement {
    return new SqliteStatement(this.sqlite, this.sql, values.map((value) => {
      if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint" || value instanceof Uint8Array) return value;
      throw new Error("Unsupported SQLite test binding");
    }));
  }
  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return (this.sqlite.prepare(this.sql).get(...this.values) as T | undefined) ?? null;
  }
  async run(): Promise<D1Result> {
    const result = this.sqlite.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

function database(): D1Database {
  const sqlite = new DatabaseSync(":memory:");
  openDatabases.push(sqlite);
  sqlite.exec("PRAGMA foreign_keys = OFF");
  for (const migration of [
    "0001_fresh_benchmark_hires.sql", "0002_current_block_pinned_hires.sql",
    "0003_four_category_current_hires.sql", "0006_lp_live_match_selection.sql",
  ]) sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  sqlite.exec("PRAGMA foreign_keys = ON");
  return {
    prepare: (sql) => new SqliteStatement(sqlite, sql),
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results: D1Result[] = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

async function fixture(ttl = 120, options: { claimedAt?: string | null; badSignature?: boolean } = {}) {
  const original = lendingFixture();
  const request = LendingRescueRequestSchema.parse({
    ...JSON.parse(JSON.stringify(original, (key, value) => key === "observedAt" ? NOW : key === "sourceId" ? SOURCE_ID : value)),
    requestId: "lease-expiry-current-lending", chainId: 56, protocol: "Venus Classic",
    market: "0xfd36e2c2a6789db23113685031d7f16329158384",
    requestedAt: NOW, deadline: later(ttl * 1_000).toISOString(), maxDataAgeSeconds: ttl,
    sources: [{ ...original.sources[0], sourceId: SOURCE_ID, observedAt: NOW, uri: source.explorerUrl }],
  });
  const binding = await issueServerObservationBinding(request, source, KEY, new Date(NOW));
  const response = await runCurrentBlockPinnedProviderRequest(request, new Date(NOW));
  if (options.badSignature) binding.signature = `${binding.signature[0] === "0" ? "1" : "0"}${binding.signature.slice(1)}`;
  const evidence = CurrentBlockPinnedEvidenceSchema.parse({
    schemaVersion: "positioncrew.current-block-pinned-evidence.v1", evidenceClass: "CURRENT_BLOCK_PINNED",
    chainId: 56, source, freshnessAtCreation: "FRESH", evaluatedAt: NOW, maxDataAgeSeconds: ttl, observationBinding: binding,
  });
  const hireRequest = CurrentLendingMarketplaceHireRequestSchema.parse({
    schemaVersion: "positioncrew.fresh-marketplace-hire-request.v2",
    idempotencyKey: "44444444-4444-4444-8444-444444444444",
    benchmarkSlug: "lending-rescue", providerSlug: "lending-rescue", evidenceMode: "CURRENT_BLOCK_PINNED",
    observation: source, observationBinding: binding, request,
  });
  const db = database();
  const store = new FreshMarketplaceStore(db);
  const providerId = response.result.job.providerId;
  if (!providerId) throw new Error("Expected a native provider identity");
  const { chain } = await store.createHire({
    request: hireRequest, providerId, hireId: HIRE, jobId: JOB, createdAt: NOW,
    requestJson: canonicalJson(request), requestHash: await sha256Commitment(request),
    providerHash: await sha256Commitment({ providerSlug: "lending-rescue", providerId,
      service: "LENDING_RESCUE", requestSchema: FRESH_MARKETPLACE_TASKS["lending-rescue"].requestSchema }),
    evidenceMode: "CURRENT_BLOCK_PINNED", evidenceJson: canonicalJson(evidence), evidenceHash: await sha256Commitment(evidence),
    service: "LENDING_RESCUE", rateLimitKey: await sha256Commitment("lease-expiry-test-client"),
  });
  const claimedAt = options.claimedAt === undefined ? NOW : options.claimedAt;
  if (claimedAt !== null) expect((await store.claimJob(HIRE, claimedAt)).claimed).toBe(true);
  return {
    db, store, chain, request, binding,
    async complete() {
      const deliverable = response.result.job.deliverable;
      if (!deliverable || !claimedAt) throw new Error("Expected a claimed deliverable");
      return store.completeJob({
        hireId: HIRE, jobId: JOB, claimToken: claimedAt, receiptId: RECEIPT,
        responseJson: canonicalJson(response), responseHash: await sha256Commitment(response),
        deliverableHash: deliverable.deliverableHash, evaluationHash: response.result.evaluation.evaluationHash,
        completedAt: new Date().toISOString(), apiDurationMilliseconds: 1,
      });
    },
  };
}

async function recover(input: Awaited<ReturnType<typeof fixture>>, key = KEY) {
  const tasks: Promise<unknown>[] = [];
  const response = await positionCrewWorker.fetch(new Request(`https://positioncrew.example/api/benchmark-hires/${HIRE}/jobs`, {
    method: "POST", headers: { Origin: "https://positioncrew.example" },
  }), { DB: input.db, ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    SOURCE_OBSERVATION_HMAC_KEY: key }, { waitUntil: (task) => tasks.push(task) });
  return { response, tasks };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(NOW)); });
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const sqlite of openDatabases.splice(0)) sqlite.close();
});

describe("authenticated current-job expiry and real SQLite lease fencing", () => {
  it.each([120, 300])("terminalizes an expired %is observation at the exact 300s lease boundary", async (ttl) => {
    const input = await fixture(ttl);
    vi.setSystemTime(later(300_000));
    const { response, tasks } = await recover(input);
    expect(response.status).toBe(200);
    const failed = FreshMarketplaceChainSchema.parse(await response.json());
    expect(failed.job).toMatchObject({ state: "FAILED", startedAt: NOW, completedAt: later(300_000).toISOString(), error: { code: "REFRESH_REQUIRED" } });
    expect(failed.receipt).toBeNull();
    expect(failed.hire).toEqual(input.chain.hire);
    expect(tasks).toHaveLength(0);
  });

  it.each([120, 300])("preserves an active lease at the exact %is observation expiry", async (ttl) => {
    const input = await fixture(ttl, { claimedAt: later(60_000).toISOString() });
    vi.setSystemTime(later(ttl * 1_000));
    const { response, tasks } = await recover(input);
    expect(response.status).toBe(202);
    expect(FreshMarketplaceChainSchema.parse(await response.json()).job).toMatchObject({ state: "RUNNING", startedAt: later(60_000).toISOString(), completedAt: null, error: null });
    expect(tasks).toHaveLength(0);
  });

  it("does not finalize one millisecond before the lease is reclaimable", async () => {
    const input = await fixture();
    vi.setSystemTime(later(299_999));
    const { response } = await recover(input);
    expect(response.status).toBe(202);
    expect((await input.store.getHire(HIRE))?.job.state).toBe("RUNNING");
  });

  it("keeps an expired CREATED job unclaimed and refuses execution", async () => {
    const input = await fixture(120, { claimedAt: null });
    vi.setSystemTime(later(300_000));
    const { response, tasks } = await recover(input);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "REFRESH_REQUIRED" });
    expect((await input.store.getHire(HIRE))?.job.state).toBe("CREATED");
    expect(tasks).toHaveLength(0);
  });

  it("returns one durable failure across concurrent recovery calls and replay", async () => {
    const input = await fixture();
    vi.setSystemTime(later(300_000));
    const results = await Promise.all([recover(input), recover(input)]);
    const bodies = await Promise.all(results.map(async ({ response, tasks }) => {
      expect(response.status).toBe(200);
      expect(tasks).toHaveLength(0);
      return FreshMarketplaceChainSchema.parse(await response.json());
    }));
    expect(bodies[0]).toEqual(bodies[1]);
    const replay = await recover(input);
    expect(await replay.response.json()).toEqual(bodies[0]);
  });

  it("does not let an expired stale observer overwrite a newer claim token", async () => {
    const input = await fixture();
    vi.setSystemTime(later(300_000));
    const original = FreshMarketplaceStore.prototype.failExpiredRunningJob;
    vi.spyOn(FreshMarketplaceStore.prototype, "failExpiredRunningJob").mockImplementationOnce(async function (this: FreshMarketplaceStore, ...args) {
      expect((await input.store.claimJob(HIRE, later(300_000).toISOString())).claimed).toBe(true);
      return original.apply(this, args);
    });
    const { response, tasks } = await recover(input);
    expect(response.status).toBe(202);
    expect(FreshMarketplaceChainSchema.parse(await response.json()).job).toMatchObject({ state: "RUNNING", startedAt: later(300_000).toISOString(), error: null });
    expect(tasks).toHaveLength(0);
  });

  it("returns a concurrent completion without replacing its receipt with failure", async () => {
    const input = await fixture();
    vi.setSystemTime(later(300_000));
    const original = FreshMarketplaceStore.prototype.failExpiredRunningJob;
    vi.spyOn(FreshMarketplaceStore.prototype, "failExpiredRunningJob").mockImplementationOnce(async function (this: FreshMarketplaceStore, ...args) {
      await input.complete();
      return original.apply(this, args);
    });
    const { response, tasks } = await recover(input);
    expect(response.status).toBe(200);
    const completed = FreshMarketplaceChainSchema.parse(await response.json());
    expect(completed.job.state).toBe("COMPLETED");
    expect(completed.receipt?.receiptId).toBe(RECEIPT);
    expect(tasks).toHaveLength(0);
  });

  it("replays completed receipts after expiry without a current signing key", async () => {
    const input = await fixture();
    const completed = await input.complete();
    vi.setSystemTime(later(600_000));
    const { response, tasks } = await recover(input, "");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(completed);
    expect(tasks).toHaveLength(0);
  });

  it.each(["bad-signature", "missing-key"])("does not grant expiry cleanup authority to %s", async (mode) => {
    const input = await fixture(120, { badSignature: mode === "bad-signature" });
    vi.setSystemTime(later(300_000));
    const { response, tasks } = await recover(input, mode === "missing-key" ? "" : KEY);
    expect(response.status).toBe(409);
    expect((await input.store.getHire(HIRE))?.job).toMatchObject({ state: "RUNNING", startedAt: NOW, error: null });
    expect(tasks).toHaveLength(0);
  });

  it("classifies authenticated but mismatched inputs as INVALID before considering expiry", async () => {
    const input = await fixture();
    const changedAccount = input.request.account.toLowerCase() === "0x1111111111111111111111111111111111111111"
      ? "0x2222222222222222222222222222222222222222"
      : "0x1111111111111111111111111111111111111111";
    await expect(verifyServerObservationBinding({ ...input.request, account: changedAccount },
      { ...source, binding: input.binding }, KEY, later(300_000))).rejects.toMatchObject({ code: "REFRESH_REQUIRED", reason: "INVALID" });
    await expect(verifyServerObservationBinding({ ...input.request, deadline: later(600_000).toISOString() },
      { ...source, binding: input.binding }, KEY, later(300_000))).rejects.toMatchObject({ code: "REFRESH_REQUIRED", reason: "INVALID" });
  });
});
