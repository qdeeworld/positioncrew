import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FRESH_MARKETPLACE_SCHEMA_STATEMENTS } from "../db/schema.js";
import {
  FreshMarketplaceChainSchema,
  FreshMarketplaceHireRequestSchema,
  canonicalJson,
  sha256Commitment,
} from "../src/commerce/fresh-hire-schema.js";
import { FixtureJobResponseSchema } from "../src/api/fixture-response-schema.js";
import {
  type CreateFreshMarketplaceHire,
  FRESH_MARKETPLACE_ADMISSION_LEASE_MILLISECONDS,
  FRESH_MARKETPLACE_CREATE_WINDOW_MILLISECONDS,
  FRESH_MARKETPLACE_JOB_LEASE_MILLISECONDS,
  FRESH_MARKETPLACE_MAX_CREATES_PER_WINDOW,
  FreshMarketplaceCapacityExceeded,
  FreshMarketplaceIdempotencyConflict,
  FreshMarketplaceStore,
  isFreshMarketplaceCapacityExceeded,
  isFreshMarketplaceIdempotencyConflict,
  type D1Database,
  type D1PreparedStatement,
  type D1Result,
} from "../src/commerce/d1-marketplace-store.js";
import positionCrewWorker from "../worker/index.js";
import { lendingFixture } from "./helpers.js";

const IDS = {
  hire: "11111111-1111-4111-8111-111111111111",
  job: "22222222-2222-4222-8222-222222222222",
  receipt: "33333333-3333-4333-8333-333333333333",
  idempotency: "44444444-4444-4444-8444-444444444444",
};
const HASH_A = "sha256:" + "a".repeat(64);
const HASH_B = "sha256:" + "b".repeat(64);
const HASH_C = "sha256:" + "c".repeat(64);
const NOW = "2026-08-20T12:00:00.000Z";
const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

function semanticSqlStatements(sql: string): string[] {
  return sql
    .replaceAll("--> statement-breakpoint", "")
    .split(";")
    .map((statement) => statement.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

class FakeD1Statement implements D1PreparedStatement {
  constructor(
    private readonly database: FakeD1,
    private readonly sql: string,
    private readonly bindings: unknown[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new FakeD1Statement(this.database, this.sql, values);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return this.database.first(this.sql, this.bindings) as T | null;
  }

  async run(): Promise<D1Result> {
    return this.database.run(this.sql, this.bindings);
  }
}

class FakeD1 implements D1Database {
  private hire: Record<string, unknown> | null = null;
  private job: Record<string, unknown> | null = null;
  private receipt: Record<string, unknown> | null = null;
  private rateLimitCount = 0;

  constructor(
    private readonly failReads = false,
    private readonly denyCreates = false,
  ) {}

  async downgradeStoredLendingEvidenceToLegacy(): Promise<void> {
    if (!this.hire || typeof this.hire.evidence_json !== "string") {
      throw new Error("No stored hire evidence is available");
    }
    const evidence = JSON.parse(this.hire.evidence_json) as Record<string, unknown>;
    delete evidence.providerAudition;
    this.hire.evidence_json = canonicalJson(evidence);
    this.hire.evidence_hash = await sha256Commitment(evidence);
  }

  markRunning(startedAt: string): void {
    if (!this.job) throw new Error("Create the fake job before marking it RUNNING");
    this.job.job_state = "RUNNING";
    this.job.job_started_at = startedAt;
  }

  get jobStartedAt(): unknown {
    return this.job?.job_started_at;
  }

  get jobState(): unknown {
    return this.job?.job_state;
  }

  prepare(sql: string): D1PreparedStatement {
    return new FakeD1Statement(this, sql);
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    const results: D1Result[] = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }

  first(sql: string, bindings: unknown[]): Record<string, unknown> | null {
    if (this.failReads) throw new Error("unrelated D1 read failure");
    const normalized = sql.replace(/\s+/g, " ");
    if (normalized.includes("SELECT create_count FROM fresh_marketplace_rate_limits")) {
      return { create_count: this.rateLimitCount };
    }
    if (normalized.includes("FROM fresh_marketplace_hires WHERE idempotency_key = ?")) {
      return this.hire?.idempotency_key === bindings[0] ? { ...this.hire } : null;
    }
    if (!this.hire || !this.job) return null;
    if (
      normalized.includes("WHERE r.receipt_id = ?") &&
      (!this.receipt || this.receipt.receipt_id !== bindings[0])
    ) {
      return null;
    }
    if (
      normalized.includes("WHERE h.idempotency_key = ?") &&
      this.hire.idempotency_key !== bindings[0]
    ) {
      return null;
    }
    if (
      normalized.includes("WHERE h.hire_id = ?") &&
      this.hire.hire_id !== bindings[0]
    ) {
      return null;
    }
    return {
      ...this.hire,
      ...this.job,
      receipt_id: this.receipt?.receipt_id ?? null,
      response_json: this.receipt?.response_json ?? null,
      response_hash: this.receipt?.response_hash ?? null,
      deliverable_hash: this.receipt?.deliverable_hash ?? null,
      evaluation_hash: this.receipt?.evaluation_hash ?? null,
      receipt_created_at: this.receipt?.receipt_created_at ?? null,
    };
  }

  run(sql: string, bindings: unknown[]): D1Result {
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (normalized.startsWith("DELETE FROM fresh_marketplace_rate_limits")) {
      return { success: true, meta: { changes: 0 } };
    } else if (normalized.startsWith("INSERT INTO fresh_marketplace_rate_limits")) {
      this.rateLimitCount = this.denyCreates
        ? FRESH_MARKETPLACE_MAX_CREATES_PER_WINDOW + 1
        : this.rateLimitCount + 1;
    } else if (normalized.startsWith("INSERT INTO fresh_marketplace_hires")) {
      if (this.denyCreates) return { success: true, meta: { changes: 0 } };
      this.hire = {
        hire_id: bindings[0],
        idempotency_key: bindings[1],
        provider_slug: bindings[2],
        provider_id: bindings[3],
        benchmark_slug: bindings[4],
        service: bindings[5],
        evidence_mode: bindings[6],
        direct_cost_usd: bindings[7],
        wallet_required: bindings[8],
        request_json: bindings[9],
        request_hash: bindings[10],
        provider_hash: bindings[11],
        evidence_json: bindings[12],
        evidence_hash: bindings[13],
        hire_created_at: bindings[14],
      };
    } else if (normalized.startsWith("UPDATE fresh_marketplace_hires SET provider_hash")) {
      if (
        !this.hire ||
        this.hire.hire_id !== bindings[3] ||
        this.hire.idempotency_key !== bindings[4] ||
        this.hire.hire_created_at !== bindings[5] ||
        this.hire.provider_hash !== null ||
        this.hire.evidence_json !== null ||
        this.hire.evidence_hash !== null
      ) {
        return { success: true, meta: { changes: 0 } };
      }
      this.hire.provider_hash = bindings[0];
      this.hire.evidence_json = bindings[1];
      this.hire.evidence_hash = bindings[2];
    } else if (normalized.startsWith("UPDATE fresh_marketplace_hires SET created_at")) {
      if (
        !this.hire ||
        this.hire.hire_id !== bindings[1] ||
        this.hire.idempotency_key !== bindings[2] ||
        this.hire.hire_created_at !== bindings[3] ||
        this.hire.provider_hash !== null ||
        this.hire.evidence_json !== null ||
        this.hire.evidence_hash !== null
      ) {
        return { success: true, meta: { changes: 0 } };
      }
      this.hire.hire_created_at = bindings[0];
    } else if (normalized.startsWith("UPDATE fresh_marketplace_jobs SET created_at")) {
      if (
        !this.hire ||
        !this.job ||
        this.job.job_id !== bindings[1] ||
        this.hire.hire_id !== bindings[2] ||
        this.job.job_state !== "CREATED" ||
        this.job.job_started_at !== null
      ) {
        return { success: true, meta: { changes: 0 } };
      }
      this.job.job_created_at = bindings[0];
    } else if (normalized.startsWith("INSERT INTO fresh_marketplace_jobs")) {
      const directValues = normalized.includes("VALUES (?, ?, 'CREATED', ?)");
      const hireId = bindings[directValues ? 1 : 2];
      if (!this.hire || this.hire.hire_id !== hireId) {
        return { success: true, meta: { changes: 0 } };
      }
      this.job = {
        job_id: bindings[0],
        job_state: "CREATED",
        job_created_at: bindings[directValues ? 2 : 1],
        job_started_at: null,
        job_completed_at: null,
        api_duration_milliseconds: null,
        error_code: null,
        error_message: null,
      };
    } else if (normalized.startsWith("INSERT INTO fresh_marketplace_receipts")) {
      const canComplete = Boolean(
        this.hire &&
        this.job &&
        this.job.job_id === bindings[6] &&
        this.hire.hire_id === bindings[7] &&
        this.job.job_state === "RUNNING" &&
        this.job.job_started_at === bindings[8],
      );
      if (!canComplete) return { success: true, meta: { changes: 0 } };
      this.receipt = {
        receipt_id: bindings[0],
        response_json: bindings[1],
        response_hash: bindings[2],
        deliverable_hash: bindings[3],
        evaluation_hash: bindings[4],
        receipt_created_at: bindings[5],
      };
    } else if (normalized.startsWith("UPDATE fresh_marketplace_jobs SET state = 'COMPLETED'")) {
      const canComplete = Boolean(
        this.hire &&
        this.job &&
        this.job.job_id === bindings[2] &&
        this.hire.hire_id === bindings[3] &&
        this.job.job_state === "RUNNING" &&
        this.job.job_started_at === bindings[4],
      );
      if (!canComplete) return { success: true, meta: { changes: 0 } };
      this.job = {
        ...this.job,
        job_state: "COMPLETED",
        job_completed_at: bindings[0],
        api_duration_milliseconds: bindings[1],
      };
    } else if (normalized.startsWith("UPDATE fresh_marketplace_jobs SET state = 'FAILED'")) {
      const canFail = Boolean(
        this.hire &&
        this.job &&
        this.job.job_id === bindings[4] &&
        this.hire.hire_id === bindings[5] &&
        this.job.job_state === "RUNNING" &&
        this.job.job_started_at === bindings[6],
      );
      if (!canFail) return { success: true, meta: { changes: 0 } };
      this.job = {
        ...this.job,
        job_state: "FAILED",
        job_completed_at: bindings[0],
        api_duration_milliseconds: bindings[1],
        error_code: bindings[2],
        error_message: bindings[3],
      };
    } else if (normalized.startsWith("UPDATE fresh_marketplace_jobs SET state = 'RUNNING'")) {
      const canClaim = Boolean(
        this.hire &&
        this.job &&
        this.hire.hire_id === bindings[1] &&
        (this.job.job_state === "CREATED" ||
          (this.job.job_state === "RUNNING" &&
            typeof this.job.job_started_at === "string" &&
            this.job.job_started_at <= String(bindings[2]))),
      );
      if (!canClaim) return { success: true, meta: { changes: 0 } };
      this.job = {
        ...this.job,
        job_state: "RUNNING",
        job_started_at: bindings[0],
        job_completed_at: null,
        api_duration_milliseconds: null,
        error_code: null,
        error_message: null,
      };
    }
    return { success: true, meta: { changes: 1 } };
  }
}

interface RateLimitBucket {
  windowStartedAt: string;
  windowExpiresAt: string;
  createCount: number;
}

class RateLimitD1Statement implements D1PreparedStatement {
  constructor(
    private readonly database: RateLimitD1,
    private readonly sql: string,
    private readonly bindings: unknown[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new RateLimitD1Statement(this.database, this.sql, values);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return this.database.first(this.sql, this.bindings) as T | null;
  }

  async run(): Promise<D1Result> {
    return this.database.run(this.sql, this.bindings);
  }
}

class RateLimitD1 implements D1Database {
  private readonly buckets = new Map<string, RateLimitBucket>();
  private readonly hires = new Map<string, Record<string, unknown>>();
  private readonly jobs = new Map<string, Record<string, unknown>>();

  getBucket(keyHash: string): RateLimitBucket | null {
    const bucket = this.buckets.get(keyHash);
    return bucket ? { ...bucket } : null;
  }

  prepare(sql: string): D1PreparedStatement {
    return new RateLimitD1Statement(this, sql);
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    const results: D1Result[] = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }

  first(sql: string, bindings: unknown[]): Record<string, unknown> | null {
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (normalized.startsWith("SELECT create_count FROM fresh_marketplace_rate_limits")) {
      const bucket = this.buckets.get(String(bindings[0]));
      return bucket ? { create_count: bucket.createCount } : null;
    }
    if (normalized.includes("FROM fresh_marketplace_hires WHERE idempotency_key = ?")) {
      const hire = [...this.hires.values()].find(
        (candidate) => candidate.idempotency_key === bindings[0],
      );
      return hire ? { ...hire } : null;
    }
    let hire: Record<string, unknown> | undefined;
    if (normalized.includes("WHERE h.idempotency_key = ?")) {
      hire = [...this.hires.values()].find(
        (candidate) => candidate.idempotency_key === bindings[0],
      );
    } else if (normalized.includes("WHERE h.hire_id = ?")) {
      hire = this.hires.get(String(bindings[0]));
    }
    if (!hire) return null;

    const job = this.jobs.get(String(hire.hire_id));
    if (!job) return null;
    return {
      ...hire,
      ...job,
      receipt_id: null,
      response_json: null,
      response_hash: null,
      deliverable_hash: null,
      evaluation_hash: null,
      receipt_created_at: null,
    };
  }

  run(sql: string, bindings: unknown[]): D1Result {
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (normalized.startsWith("DELETE FROM fresh_marketplace_rate_limits")) {
      const now = String(bindings[0]);
      let changes = 0;
      for (const [keyHash, bucket] of this.buckets) {
        if (bucket.windowExpiresAt <= now) {
          this.buckets.delete(keyHash);
          changes += 1;
        }
      }
      return { success: true, meta: { changes } };
    }

    if (normalized.startsWith("INSERT INTO fresh_marketplace_rate_limits")) {
      const keyHash = String(bindings[0]);
      const windowStartedAt = String(bindings[1]);
      const windowExpiresAt = String(bindings[2]);
      const existing = this.buckets.get(keyHash);
      if (!existing) {
        this.buckets.set(keyHash, { windowStartedAt, windowExpiresAt, createCount: 1 });
      } else {
        existing.createCount += 1;
        if (
          normalized.includes("window_started_at = excluded.window_started_at") ||
          normalized.includes("window_expires_at = excluded.window_expires_at")
        ) {
          existing.windowStartedAt = windowStartedAt;
          existing.windowExpiresAt = windowExpiresAt;
        }
      }
      return { success: true, meta: { changes: 1 } };
    }

    if (normalized.startsWith("INSERT INTO fresh_marketplace_hires")) {
      if (normalized.includes("WHERE (SELECT create_count")) {
        const bucket = this.buckets.get(String(bindings[15]));
        if (!bucket || bucket.createCount > Number(bindings[16])) {
          return { success: true, meta: { changes: 0 } };
        }
      }
      const hireId = String(bindings[0]);
      this.hires.set(hireId, {
        hire_id: hireId,
        idempotency_key: bindings[1],
        provider_slug: bindings[2],
        provider_id: bindings[3],
        benchmark_slug: bindings[4],
        service: bindings[5],
        evidence_mode: bindings[6],
        direct_cost_usd: bindings[7],
        wallet_required: bindings[8],
        request_json: bindings[9],
        request_hash: bindings[10],
        provider_hash: bindings[11],
        evidence_json: bindings[12],
        evidence_hash: bindings[13],
        hire_created_at: bindings[14],
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (normalized.startsWith("UPDATE fresh_marketplace_hires SET provider_hash")) {
      const hire = this.hires.get(String(bindings[3]));
      if (
        !hire ||
        hire.idempotency_key !== bindings[4] ||
        hire.hire_created_at !== bindings[5] ||
        hire.provider_hash !== null ||
        hire.evidence_json !== null ||
        hire.evidence_hash !== null
      ) {
        return { success: true, meta: { changes: 0 } };
      }
      hire.provider_hash = bindings[0];
      hire.evidence_json = bindings[1];
      hire.evidence_hash = bindings[2];
      return { success: true, meta: { changes: 1 } };
    }

    if (normalized.startsWith("UPDATE fresh_marketplace_hires SET created_at")) {
      const hire = this.hires.get(String(bindings[1]));
      if (
        !hire ||
        hire.idempotency_key !== bindings[2] ||
        hire.hire_created_at !== bindings[3] ||
        hire.provider_hash !== null ||
        hire.evidence_json !== null ||
        hire.evidence_hash !== null
      ) {
        return { success: true, meta: { changes: 0 } };
      }
      hire.hire_created_at = bindings[0];
      return { success: true, meta: { changes: 1 } };
    }

    if (normalized.startsWith("UPDATE fresh_marketplace_jobs SET created_at")) {
      const job = this.jobs.get(String(bindings[2]));
      if (
        !job ||
        job.job_id !== bindings[1] ||
        job.job_state !== "CREATED" ||
        job.job_started_at !== null
      ) {
        return { success: true, meta: { changes: 0 } };
      }
      job.job_created_at = bindings[0];
      return { success: true, meta: { changes: 1 } };
    }

    if (normalized.startsWith("INSERT INTO fresh_marketplace_jobs")) {
      const directValues = normalized.includes("VALUES (?, ?, 'CREATED', ?)");
      const hireId = String(bindings[directValues ? 1 : 2]);
      if (!this.hires.has(hireId)) return { success: true, meta: { changes: 0 } };
      this.jobs.set(hireId, {
        job_id: bindings[0],
        job_state: "CREATED",
        job_created_at: bindings[directValues ? 2 : 1],
        job_started_at: null,
        job_completed_at: null,
        api_duration_milliseconds: null,
        error_code: null,
        error_message: null,
      });
      return { success: true, meta: { changes: 1 } };
    }

    throw new Error(`Unsupported rate-limit test SQL: ${normalized}`);
  }
}

function indexedUuid(marker: "1" | "2" | "4", index: number): string {
  const suffix = index.toString(16).padStart(12, "0");
  return `${marker.repeat(8)}-${marker.repeat(4)}-4${marker.repeat(3)}-8${marker.repeat(3)}-${suffix}`;
}

async function rateLimitHireInput(
  index: number,
  createdAt: string,
  rateLimitKey = HASH_A,
): Promise<CreateFreshMarketplaceHire> {
  const request = { requestSchema: "positioncrew.lending-rescue.request.v1" };
  const provider = {
    providerSlug: "lending-rescue",
    providerId: "positioncrew:provider:lending-rescue:v1",
    service: "LENDING_RESCUE",
    requestSchema: "positioncrew.lending-rescue.request.v1",
  };
  const evidence = {
    schemaVersion: "positioncrew.historical-fixture-evidence.v1",
    evidenceClass: "HISTORICAL_FIXTURE",
    benchmarkSlug: "lending-rescue",
    requestSchema: "positioncrew.lending-rescue.request.v1",
  } as const;
  return {
    request: FreshMarketplaceHireRequestSchema.parse({
      schemaVersion: "positioncrew.fresh-marketplace-hire-request.v1",
      idempotencyKey: indexedUuid("4", index),
      benchmarkSlug: "lending-rescue",
      providerSlug: "lending-rescue",
    }),
    providerId: "positioncrew:provider:lending-rescue:v1",
    hireId: indexedUuid("1", index),
    jobId: indexedUuid("2", index),
    createdAt,
    requestJson: canonicalJson(request),
    requestHash: await sha256Commitment(request),
    providerHash: await sha256Commitment(provider),
    evidenceMode: "HISTORICAL_FIXTURE",
    evidenceJson: canonicalJson(evidence),
    evidenceHash: await sha256Commitment(evidence),
    service: "LENDING_RESCUE",
    rateLimitKey,
  };
}

const TEST_ASSETS = {
  async fetch(request: Request): Promise<Response> {
    return new Response(request.url);
  },
};
const TEST_CONTEXT = {
  waitUntil(_promise: Promise<unknown>): void {},
};

function capturingContext(): { tasks: Promise<unknown>[]; waitUntil(promise: Promise<unknown>): void } {
  const tasks: Promise<unknown>[] = [];
  return { tasks, waitUntil(promise) { tasks.push(promise); } };
}

function marketplaceHireRequest(
  benchmarkSlug: "lending-rescue" | "lp-rebalance" | "bounded-grid",
  providerSlug: "lending-rescue" | "lp-rebalance" | "bounded-grid",
  origin?: string,
): Request {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (origin) headers.Origin = origin;
  return new Request("https://positioncrew.example/api/benchmark-hires", {
    method: "POST",
    headers,
    body: JSON.stringify({
      schemaVersion: "positioncrew.fresh-marketplace-hire-request.v1",
      idempotencyKey: IDS.idempotency,
      benchmarkSlug,
      providerSlug,
    }),
  });
}

function currentLendingHireRequest(
  mode: "ACTIONABLE" | "STALE" | "EMPTY" | "UNSAFE" = "ACTIONABLE",
): { httpRequest: Request; providerRequest: ReturnType<typeof lendingFixture> } {
  const providerRequest = lendingFixture();
  const blockNumber = mode === "ACTIONABLE"
    ? "70000001"
    : mode === "STALE"
      ? "70000002"
      : mode === "EMPTY"
        ? "70000003"
        : "70000004";
  const now = Date.now();
  const observedAt = new Date(mode === "STALE" ? now - 10 * 60_000 : now - 15_000).toISOString();
  providerRequest.requestId = `venus-live-test-${blockNumber}`;
  providerRequest.protocol = "Venus Classic";
  providerRequest.market = "0xfD36E2c2a6789Db23113685031d7F16329158384";
  providerRequest.requestedAt = new Date(mode === "STALE" ? Date.parse(observedAt) + 1_000 : now).toISOString();
  providerRequest.deadline = new Date(now + 5 * 60_000).toISOString();
  const sourceId = `venus-mainnet-block-${blockNumber}`;
  const explorerUrl = `https://bscscan.com/block/${blockNumber}`;
  providerRequest.sources = [{
    sourceId,
    label: `Block-pinned Venus test observation ${blockNumber}`,
    uri: explorerUrl,
    observedAt,
  }];
  providerRequest.position.collateral = providerRequest.position.collateral.map((entry) => ({
    ...entry,
    sourceId,
    observedAt,
  }));
  providerRequest.position.debt = providerRequest.position.debt.map((entry) => ({
    ...entry,
    sourceId,
    observedAt,
  }));
  if (mode === "EMPTY") providerRequest.position = { collateral: [], debt: [] };
  const firstCollateral = providerRequest.position.collateral[0];
  if (mode === "UNSAFE" && firstCollateral) {
    firstCollateral.observedAt = new Date(now + 60_000).toISOString();
  }
  const body = {
    schemaVersion: "positioncrew.fresh-marketplace-hire-request.v2",
    idempotencyKey: IDS.idempotency,
    benchmarkSlug: "lending-rescue",
    providerSlug: "lending-rescue",
    evidenceMode: "CURRENT_BLOCK_PINNED",
    observation: { blockNumber, observedAt, explorerUrl },
    request: providerRequest,
  };
  return {
    httpRequest: new Request("https://positioncrew.example/api/benchmark-hires", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Origin: "https://positioncrew.example",
        "CF-Connecting-IP": "203.0.113.10",
      },
      body: JSON.stringify(body),
    }),
    providerRequest,
  };
}

describe("fresh marketplace hire contract", () => {
  it("maps a conflicting retry through the real Worker route and preserves unrelated 500s", async () => {
    const database = new FakeD1();
    const environment = { DB: database, ASSETS: TEST_ASSETS };
    const created = await positionCrewWorker.fetch(
      marketplaceHireRequest("lending-rescue", "lending-rescue"),
      environment,
      TEST_CONTEXT,
    );
    expect(created.status).toBe(201);

    const conflict = await positionCrewWorker.fetch(
      marketplaceHireRequest("bounded-grid", "bounded-grid"),
      environment,
      TEST_CONTEXT,
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      schemaVersion: "positioncrew.api-error.v1",
      error: "IDEMPOTENCY_CONFLICT",
    });

    const unrelated = await positionCrewWorker.fetch(
      marketplaceHireRequest("lending-rescue", "lending-rescue"),
      { DB: new FakeD1(true), ASSETS: TEST_ASSETS },
      TEST_CONTEXT,
    );
    expect(unrelated.status).toBe(500);
    await expect(unrelated.json()).resolves.toMatchObject({
      schemaVersion: "positioncrew.api-error.v1",
      error: "REQUEST_FAILED",
    });
  });

  it("replays a pre-audition current Lending hire without weakening immutable bindings", async () => {
    const database = new FakeD1();
    const environment = { DB: database, ASSETS: TEST_ASSETS };
    const { httpRequest } = currentLendingHireRequest();
    const retryBody = await httpRequest.clone().text();
    const retryHeaders = new Headers(httpRequest.headers);

    const createdResponse = await positionCrewWorker.fetch(httpRequest, environment, TEST_CONTEXT);
    expect(createdResponse.status).toBe(201);
    const created = FreshMarketplaceChainSchema.parse(await createdResponse.json());
    const createdEvidence = created.hire.evidence;
    expect(createdEvidence?.evidenceClass).toBe("CURRENT_BLOCK_PINNED");
    if (!createdEvidence || createdEvidence.evidenceClass !== "CURRENT_BLOCK_PINNED") {
      throw new Error("Expected current block-pinned evidence");
    }
    expect(createdEvidence.providerAudition).toBeDefined();

    await database.downgradeStoredLendingEvidenceToLegacy();
    const replayResponse = await positionCrewWorker.fetch(
      new Request("https://positioncrew.example/api/benchmark-hires", {
        method: "POST",
        headers: retryHeaders,
        body: retryBody,
      }),
      environment,
      TEST_CONTEXT,
    );

    expect(replayResponse.status).toBe(200);
    const replayed = FreshMarketplaceChainSchema.parse(await replayResponse.json());
    expect(replayed.hire.hireId).toBe(created.hire.hireId);
    expect(replayed.hire.requestHash).toBe(created.hire.requestHash);
    expect(replayed.hire.providerHash).toBe(created.hire.providerHash);
    const replayedEvidence = replayed.hire.evidence;
    expect(replayedEvidence?.evidenceClass).toBe("CURRENT_BLOCK_PINNED");
    if (!replayedEvidence || replayedEvidence.evidenceClass !== "CURRENT_BLOCK_PINNED") {
      throw new Error("Expected replayed current block-pinned evidence");
    }
    expect(replayedEvidence.providerAudition).toBeUndefined();
  });

  it("classifies malformed and oversized hire bodies as client errors", async () => {
    const environment = { DB: new FakeD1(), ASSETS: TEST_ASSETS };
    const malformed = await positionCrewWorker.fetch(
      new Request("https://positioncrew.example/api/benchmark-hires", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }),
      environment,
      TEST_CONTEXT,
    );
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({ error: "INVALID_JSON" });

    const oversized = await positionCrewWorker.fetch(
      new Request("https://positioncrew.example/api/benchmark-hires", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ padding: "x".repeat(32_768) }),
      }),
      environment,
      TEST_CONTEXT,
    );
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({ error: "REQUEST_TOO_LARGE" });
  });

  it("persists, runs, polls, and reloads one exact current block-pinned receipt", async () => {
    const database = new FakeD1();
    const environment = { DB: database, ASSETS: TEST_ASSETS };
    const { httpRequest, providerRequest } = currentLendingHireRequest();
    const createdResponse = await positionCrewWorker.fetch(httpRequest, environment, TEST_CONTEXT);
    expect(createdResponse.status, await createdResponse.clone().text()).toBe(201);
    const created = FreshMarketplaceChainSchema.parse(await createdResponse.json());
    expect(created.hire.evidenceMode).toBe("CURRENT_BLOCK_PINNED");
    expect(created.hire.request).toEqual(providerRequest);
    expect(created.hire.providerHash).toMatch(/^sha256:/);
    expect(created.hire.evidenceHash).toMatch(/^sha256:/);

    const context = capturingContext();
    const runResponse = await positionCrewWorker.fetch(
      new Request(`https://positioncrew.example/api/benchmark-hires/${created.hire.hireId}/jobs`, {
        method: "POST",
        headers: { Origin: "https://positioncrew.example" },
      }),
      environment,
      context,
    );
    expect(runResponse.status).toBe(202);
    await Promise.all(context.tasks);

    const completedResponse = await positionCrewWorker.fetch(
      new Request(`https://positioncrew.example/api/benchmark-hires/${created.hire.hireId}`),
      environment,
      TEST_CONTEXT,
    );
    const completed = FreshMarketplaceChainSchema.parse(await completedResponse.json());
    expect(completed.job.state).toBe("COMPLETED");
    const providerResponse = FixtureJobResponseSchema.parse(completed.receipt?.response);
    expect(providerResponse.evidenceMode).toBe("CURRENT_BLOCK_PINNED");
    expect(providerResponse.result.request).toEqual(providerRequest);
    expect(providerResponse.result.evaluation.requestHash).toBe(completed.hire.requestHash);
    expect(providerResponse.result.deliverable.status).toBe("ACTIONABLE");

    const receiptResponse = await positionCrewWorker.fetch(
      new Request(`https://positioncrew.example${completed.receipt?.publicUrl}`),
      environment,
      TEST_CONTEXT,
    );
    const reloaded = FreshMarketplaceChainSchema.parse(await receiptResponse.json());
    expect(reloaded).toEqual(completed);
  });

  it("refuses a current hire that expires before its delayed job claim", async () => {
    vi.useFakeTimers();
    try {
      const createdAt = new Date("2026-08-24T12:00:00.000Z");
      vi.setSystemTime(createdAt);
      const database = new FakeD1();
      const environment = { DB: database, ASSETS: TEST_ASSETS };
      const { httpRequest, providerRequest } = currentLendingHireRequest();
      const createdResponse = await positionCrewWorker.fetch(httpRequest, environment, TEST_CONTEXT);
      const created = FreshMarketplaceChainSchema.parse(await createdResponse.json());
      const committedRequestHash = created.hire.requestHash;
      const committedEvidenceHash = created.hire.evidenceHash;

      const claimedAt = new Date(createdAt.getTime() + 6 * 60_000);
      vi.setSystemTime(claimedAt);
      const context = capturingContext();
      const runResponse = await positionCrewWorker.fetch(
        new Request(`https://positioncrew.example/api/benchmark-hires/${created.hire.hireId}/jobs`, {
          method: "POST",
          headers: { Origin: "https://positioncrew.example" },
        }),
        environment,
        context,
      );
      expect(runResponse.status).toBe(202);
      const running = FreshMarketplaceChainSchema.parse(await runResponse.json());
      expect(running.job.state).toBe("RUNNING");
      expect(running.receipt).toBeNull();
      await Promise.all(context.tasks);

      const completedResponse = await positionCrewWorker.fetch(
        new Request(`https://positioncrew.example/api/benchmark-hires/${created.hire.hireId}`),
        environment,
        TEST_CONTEXT,
      );
      const completed = FreshMarketplaceChainSchema.parse(await completedResponse.json());
      expect({ state: completed.job.state, error: completed.job.error }).toEqual({
        state: "COMPLETED",
        error: null,
      });
      expect(completed.job.startedAt).toBe(claimedAt.toISOString());
      if (!completed.receipt) {
        throw new Error(`Completed delayed hire did not persist a receipt: ${JSON.stringify(completed.job)}`);
      }
      const providerResponse = FixtureJobResponseSchema.parse(completed.receipt.response);
      expect(providerResponse.result.deliverable.status).toBe("REFUSED_EXPIRED");
      expect(providerResponse.result.request).toEqual(providerRequest);
      expect(providerResponse.result.evaluation.requestHash).toBe(committedRequestHash);
      expect(completed.hire.requestHash).toBe(committedRequestHash);
      expect(completed.hire.evidenceHash).toBe(committedEvidenceHash);
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists stale, empty, and inconsistent positions as completed provider refusals", async () => {
    for (const [mode, status] of [
      ["STALE", "REFUSED_STALE_DATA"],
      ["EMPTY", "REFUSED_CONSTRAINTS"],
      ["UNSAFE", "REFUSED_INCONSISTENT_DATA"],
    ] as const) {
      const database = new FakeD1();
      const environment = { DB: database, ASSETS: TEST_ASSETS };
      const { httpRequest } = currentLendingHireRequest(mode);
      const createdResponse = await positionCrewWorker.fetch(httpRequest, environment, TEST_CONTEXT);
      const created = FreshMarketplaceChainSchema.parse(await createdResponse.json());
      const context = capturingContext();
      await positionCrewWorker.fetch(
        new Request(`https://positioncrew.example/api/benchmark-hires/${created.hire.hireId}/jobs`, {
          method: "POST",
          headers: { Origin: "https://positioncrew.example" },
        }),
        environment,
        context,
      );
      await Promise.all(context.tasks);
      const completedResponse = await positionCrewWorker.fetch(
        new Request(`https://positioncrew.example/api/benchmark-hires/${created.hire.hireId}`),
        environment,
        TEST_CONTEXT,
      );
      const completed = FreshMarketplaceChainSchema.parse(await completedResponse.json());
      const providerResponse = FixtureJobResponseSchema.parse(completed.receipt?.response);
      expect(completed.job.state).toBe("COMPLETED");
      expect(providerResponse.result.deliverable.status).toBe(status);
    }
  });

  it("rejects cross-origin mutations while allowing same and canonical product origins", async () => {
    const denied = await positionCrewWorker.fetch(
      marketplaceHireRequest("lending-rescue", "lending-rescue", "https://evil.example"),
      { DB: new FakeD1(), ASSETS: TEST_ASSETS },
      TEST_CONTEXT,
    );
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({ error: "ORIGIN_NOT_ALLOWED" });

    const allowed = await positionCrewWorker.fetch(
      marketplaceHireRequest("lending-rescue", "lending-rescue", "https://positioncrew.dolepee.com"),
      { DB: new FakeD1(), ASSETS: TEST_ASSETS },
      TEST_CONTEXT,
    );
    expect(allowed.status).toBe(201);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("https://positioncrew.dolepee.com");
  });

  it("reclaims a RUNNING job only after its bounded lease expires", async () => {
    expect(FRESH_MARKETPLACE_JOB_LEASE_MILLISECONDS).toBe(300_000);
    const database = new FakeD1();
    const createdResponse = await positionCrewWorker.fetch(
      marketplaceHireRequest("lending-rescue", "lending-rescue"),
      { DB: database, ASSETS: TEST_ASSETS },
      TEST_CONTEXT,
    );
    const created = await createdResponse.json() as { hire: { hireId: string } };
    database.markRunning("2026-08-20T12:00:00.000Z");
    const store = new FreshMarketplaceStore(database);

    const early = await store.claimJob(created.hire.hireId, "2026-08-20T12:04:59.999Z");
    expect(early.claimed).toBe(false);
    expect(database.jobStartedAt).toBe("2026-08-20T12:00:00.000Z");

    const reclaimed = await store.claimJob(created.hire.hireId, "2026-08-20T12:05:00.000Z");
    expect(reclaimed.claimed).toBe(true);
    expect(database.jobStartedAt).toBe("2026-08-20T12:05:00.000Z");

    const duplicate = await store.claimJob(created.hire.hireId, "2026-08-20T12:09:59.999Z");
    expect(duplicate.claimed).toBe(false);
  });

  it("fences an earlier worker from failing a reclaimed lease", async () => {
    const database = new FakeD1();
    const createdResponse = await positionCrewWorker.fetch(
      marketplaceHireRequest("lending-rescue", "lending-rescue"),
      { DB: database, ASSETS: TEST_ASSETS },
      TEST_CONTEXT,
    );
    const created = await createdResponse.json() as {
      hire: { hireId: string };
      job: { jobId: string };
    };
    const store = new FreshMarketplaceStore(database);
    const original = await store.claimJob(created.hire.hireId, "2026-08-20T12:00:00.000Z");
    const replacement = await store.claimJob(created.hire.hireId, "2026-08-20T12:05:00.000Z");
    if (!original.claimToken || !replacement.claimToken) throw new Error("Expected both claim tokens");

    await store.failJob(
      created.hire.hireId,
      created.job.jobId,
      original.claimToken,
      "2026-08-20T12:05:01.000Z",
      1,
      "OLD_WORKER_FAILED",
      "Old worker failed after reclaim",
    );
    expect(database.jobState).toBe("RUNNING");

    await store.failJob(
      created.hire.hireId,
      created.job.jobId,
      replacement.claimToken,
      "2026-08-20T12:05:02.000Z",
      2,
      "REPLACEMENT_FAILED",
      "Replacement worker failed",
    );
    expect(database.jobState).toBe("FAILED");
  });

  it("recognizes only the branded idempotency conflict across bundle boundaries", () => {
    const conflict = new FreshMarketplaceIdempotencyConflict();
    const bundleEquivalent = {
      name: conflict.name,
      message: conflict.message,
      code: conflict.code,
      domain: conflict.domain,
    };

    expect(isFreshMarketplaceIdempotencyConflict(bundleEquivalent)).toBe(true);
    expect(bundleEquivalent.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(isFreshMarketplaceIdempotencyConflict(new Error(conflict.message))).toBe(false);
    expect(isFreshMarketplaceIdempotencyConflict({
      ...bundleEquivalent,
      domain: "unrelated.domain",
    })).toBe(false);
  });

  it("enforces a branded atomic durable-write boundary before creating jobs", async () => {
    expect(FRESH_MARKETPLACE_MAX_CREATES_PER_WINDOW).toBe(30);
    const capacity = new FreshMarketplaceCapacityExceeded();
    expect(isFreshMarketplaceCapacityExceeded({
      name: capacity.name,
      message: capacity.message,
      code: capacity.code,
      domain: capacity.domain,
    })).toBe(true);

    const response = await positionCrewWorker.fetch(
      marketplaceHireRequest("lending-rescue", "lending-rescue"),
      { DB: new FakeD1(false, true), ASSETS: TEST_ASSETS },
      TEST_CONTEXT,
    );
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({ error: "HIRE_CAPACITY_EXCEEDED" });
  });

  it("starts a fresh fixed bucket after expiry without accumulating low steady traffic", async () => {
    const database = new RateLimitD1();
    const store = new FreshMarketplaceStore(database);
    const startedAt = Date.parse(NOW);

    for (const [index, offset] of [0, 30_000, 60_000, 90_000, 120_000].entries()) {
      await store.createHire(
        await rateLimitHireInput(index, new Date(startedAt + offset).toISOString()),
      );
    }

    expect(database.getBucket(HASH_A)).toEqual({
      windowStartedAt: new Date(startedAt + 120_000).toISOString(),
      windowExpiresAt: new Date(
        startedAt + 120_000 + FRESH_MARKETPLACE_CREATE_WINDOW_MILLISECONDS,
      ).toISOString(),
      createCount: 1,
    });
  });

  it("blocks the thirty-first create inside one fixed bucket", async () => {
    const database = new RateLimitD1();
    const store = new FreshMarketplaceStore(database);
    const startedAt = Date.parse(NOW);

    for (let index = 0; index < FRESH_MARKETPLACE_MAX_CREATES_PER_WINDOW; index += 1) {
      await store.createHire(
        await rateLimitHireInput(index, new Date(startedAt + index * 1_000).toISOString()),
      );
    }

    await expect(store.createHire(await rateLimitHireInput(
      FRESH_MARKETPLACE_MAX_CREATES_PER_WINDOW,
      new Date(
        startedAt + FRESH_MARKETPLACE_MAX_CREATES_PER_WINDOW * 1_000,
      ).toISOString(),
    ))).rejects.toBeInstanceOf(FreshMarketplaceCapacityExceeded);

    expect(database.getBucket(HASH_A)).toEqual({
      windowStartedAt: NOW,
      windowExpiresAt: new Date(
        startedAt + FRESH_MARKETPLACE_CREATE_WINDOW_MILLISECONDS,
      ).toISOString(),
      createCount: FRESH_MARKETPLACE_MAX_CREATES_PER_WINDOW + 1,
    });
  });

  it("admits external work once and replays it without consuming another slot", async () => {
    const database = new RateLimitD1();
    const store = new FreshMarketplaceStore(database);
    const input = await rateLimitHireInput(0, NOW);
    const admissionInput = {
      request: input.request,
      providerId: input.providerId,
      createdAt: input.createdAt,
      requestHash: input.requestHash,
      providerHash: input.providerHash,
      evidenceMode: input.evidenceMode,
      service: input.service,
      rateLimitKey: input.rateLimitKey,
      hireId: input.hireId,
      jobId: input.jobId,
      leaseToken: input.createdAt,
      requestJson: input.requestJson,
    };

    await expect(store.admitHireCreation(admissionInput)).resolves.toMatchObject({
      replayed: false,
      chain: null,
      hireId: input.hireId,
      jobId: input.jobId,
      leaseToken: input.createdAt,
    });
    await expect(store.admitHireCreation(admissionInput)).resolves.toEqual({
      replayed: true,
      chain: null,
      hireId: input.hireId,
      jobId: input.jobId,
      leaseToken: input.createdAt,
    });
    await store.createHire({
      ...input,
      rateLimitAdmitted: true,
      admissionLeaseToken: input.createdAt,
    });
    await expect(store.admitHireCreation(admissionInput)).resolves.toMatchObject({
      replayed: true,
      chain: { hire: { hireId: input.hireId } },
    });
    expect(database.getBucket(HASH_A)?.createCount).toBe(1);
  });

  it("takes over an abandoned admission after its bounded lease without another quota slot", async () => {
    const database = new RateLimitD1();
    const store = new FreshMarketplaceStore(database);
    const input = await rateLimitHireInput(0, NOW);
    const admissionInput = {
      request: input.request,
      providerId: input.providerId,
      hireId: input.hireId,
      jobId: input.jobId,
      createdAt: input.createdAt,
      requestJson: input.requestJson,
      requestHash: input.requestHash,
      providerHash: input.providerHash,
      evidenceMode: input.evidenceMode,
      service: input.service,
      rateLimitKey: input.rateLimitKey,
    };
    await store.admitHireCreation(admissionInput);
    const recoveredAt = new Date(
      Date.parse(NOW) + FRESH_MARKETPLACE_ADMISSION_LEASE_MILLISECONDS,
    ).toISOString();

    await expect(store.admitHireCreation({
      ...admissionInput,
      hireId: indexedUuid("1", 9),
      jobId: indexedUuid("2", 9),
      createdAt: recoveredAt,
    })).resolves.toEqual({
      chain: null,
      replayed: false,
      hireId: input.hireId,
      jobId: input.jobId,
      leaseToken: recoveredAt,
    });
    await expect(store.createHire({
      ...input,
      rateLimitAdmitted: true,
      admissionLeaseToken: input.createdAt,
    })).rejects.toThrow("D1 hire admission is still in progress");
    await expect(store.createHire({
      ...input,
      createdAt: recoveredAt,
      rateLimitAdmitted: true,
      admissionLeaseToken: recoveredAt,
    })).resolves.toMatchObject({ replayed: false });
    expect(database.getBucket(HASH_A)?.createCount).toBe(1);
  });

  it("rejects pre-admission at capacity before provider work can begin", async () => {
    const database = new RateLimitD1();
    const store = new FreshMarketplaceStore(database);

    for (let index = 0; index < FRESH_MARKETPLACE_MAX_CREATES_PER_WINDOW; index += 1) {
      const input = await rateLimitHireInput(index, new Date(Date.parse(NOW) + index).toISOString());
      await expect(store.admitHireCreation({
        request: input.request,
        providerId: input.providerId,
        createdAt: input.createdAt,
        requestHash: input.requestHash,
        providerHash: input.providerHash,
        evidenceMode: input.evidenceMode,
        service: input.service,
        rateLimitKey: input.rateLimitKey,
        hireId: input.hireId,
        jobId: input.jobId,
        requestJson: input.requestJson,
      })).resolves.toMatchObject({ replayed: false });
    }

    const denied = await rateLimitHireInput(
      FRESH_MARKETPLACE_MAX_CREATES_PER_WINDOW,
      new Date(Date.parse(NOW) + FRESH_MARKETPLACE_MAX_CREATES_PER_WINDOW).toISOString(),
    );
    await expect(store.admitHireCreation({
      request: denied.request,
      providerId: denied.providerId,
      createdAt: denied.createdAt,
      requestHash: denied.requestHash,
      providerHash: denied.providerHash,
      evidenceMode: denied.evidenceMode,
      service: denied.service,
      rateLimitKey: denied.rateLimitKey,
      hireId: denied.hireId,
      jobId: denied.jobId,
      requestJson: denied.requestJson,
    })).rejects.toBeInstanceOf(FreshMarketplaceCapacityExceeded);
  });

  it("accepts only the three exact frozen provider/task bindings", () => {
    for (const [benchmarkSlug, providerSlug] of [
      ["lending-rescue", "lending-rescue"],
      ["lp-rebalance", "lp-rebalance"],
      ["bounded-grid", "bounded-grid"],
    ] as const) {
      expect(FreshMarketplaceHireRequestSchema.parse({
        schemaVersion: "positioncrew.fresh-marketplace-hire-request.v1",
        idempotencyKey: IDS.idempotency,
        benchmarkSlug,
        providerSlug,
      }).benchmarkSlug).toBe(benchmarkSlug);
    }
    expect(() => FreshMarketplaceHireRequestSchema.parse({
      schemaVersion: "positioncrew.fresh-marketplace-hire-request.v1",
      idempotencyKey: IDS.idempotency,
      benchmarkSlug: "lending-rescue",
      providerSlug: "bounded-grid",
    })).toThrow();
    expect(() => FreshMarketplaceHireRequestSchema.parse({
      schemaVersion: "positioncrew.fresh-marketplace-hire-request.v1",
      idempotencyKey: IDS.idempotency,
      benchmarkSlug: "yield-optimization",
      providerSlug: "yield-optimization",
    })).toThrow();
  });

  it("commits canonical JSON independently of object key order", async () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 4 }, b: 2 }),
    );
    await expect(sha256Commitment({ b: 2, a: 1 })).resolves.toBe(
      await sha256Commitment({ a: 1, b: 2 }),
    );
  });

  it("requires the persisted zero-cost boundary and immutable receipt commitments", () => {
    const chain = FreshMarketplaceChainSchema.parse({
      schemaVersion: "positioncrew.fresh-marketplace-chain.v1",
      claimBoundary: [
        "This is a public-workspace run of a frozen historical benchmark fixture.",
        "The run costs $0.00, requires no wallet, and creates no payment or settlement.",
        "The server receipt proves only this PositionCrew request, provider selection, result, and timing trace.",
        "It does not establish an external buyer, paid demand, third-party protocol execution, onchain immutability, or live financial advice.",
      ],
      hire: {
        hireId: IDS.hire,
        idempotencyKey: IDS.idempotency,
        providerSlug: "lending-rescue",
        providerId: "positioncrew:lending-rescue:v1",
        benchmarkSlug: "lending-rescue",
        service: "LENDING_RESCUE",
        evidenceMode: "HISTORICAL_FIXTURE",
        commerce: { directCostUsd: "0.00", walletRequired: false, settlement: "NO_PAYMENT" },
        request: { requestSchema: "positioncrew.lending-rescue.request.v1" },
        requestHash: HASH_A,
        providerHash: null,
        evidence: null,
        evidenceHash: null,
        createdAt: NOW,
      },
      job: {
        jobId: IDS.job,
        state: "COMPLETED",
        status: "COMPLETED",
        createdAt: NOW,
        startedAt: NOW,
        completedAt: NOW,
        apiDurationMilliseconds: 21,
        error: null,
      },
      receipt: {
        receiptId: IDS.receipt,
        publicUrl: "/api/benchmark-receipts/" + IDS.receipt,
        responseHash: HASH_A,
        deliverableHash: HASH_B,
        evaluationHash: HASH_C,
        createdAt: NOW,
        response: { result: "attached" },
      },
    });
    expect(chain.receipt?.receiptId).toBe(IDS.receipt);
    expect(() => FreshMarketplaceChainSchema.parse({
      ...chain,
      hire: { ...chain.hire, commerce: { ...chain.hire.commerce, directCostUsd: "5.00" } },
    })).toThrow();
  });

  it("defines one statement per prepared schema operation with relational uniqueness", () => {
    expect(FRESH_MARKETPLACE_SCHEMA_STATEMENTS).toHaveLength(3);
    for (const statement of FRESH_MARKETPLACE_SCHEMA_STATEMENTS) {
      expect(statement.trim().replace(/;$/, "")).not.toContain(";");
    }
    expect(FRESH_MARKETPLACE_SCHEMA_STATEMENTS[0]).toContain("idempotency_key TEXT NOT NULL UNIQUE");
    expect(FRESH_MARKETPLACE_SCHEMA_STATEMENTS[1]).toContain("hire_id TEXT NOT NULL UNIQUE REFERENCES");
    expect(FRESH_MARKETPLACE_SCHEMA_STATEMENTS[2]).toContain("job_id TEXT NOT NULL UNIQUE REFERENCES");
  });

  it("binds the closed Drizzle inventory to the reference migration and schema truth", () => {
    const drizzleRoot = resolve(PROJECT_ROOT, "drizzle");
    const generatedMigrationName = "0000_fresh_benchmark_hires.sql";
    const generatedCurrentMigrationName = "0001_current_block_pinned_hires.sql";
    const generatedFourCategoryMigrationName = "0002_four_category_current_hires.sql";
    const generatedShadowGridMigrationName = "0003_shadow_grid_events.sql";
    const generatedAltanaActivationMigrationName = "0004_altana_venus_activations.sql";
    expect(readdirSync(drizzleRoot).sort()).toEqual([
      generatedMigrationName,
      generatedCurrentMigrationName,
      generatedFourCategoryMigrationName,
      generatedShadowGridMigrationName,
      generatedAltanaActivationMigrationName,
      "meta",
    ]);
    expect(readdirSync(resolve(drizzleRoot, "meta")).sort()).toEqual([
      "0000_snapshot.json",
      "0001_snapshot.json",
      "0002_snapshot.json",
      "0003_snapshot.json",
      "_journal.json",
    ]);

    const referenceSql = readFileSync(
      resolve(PROJECT_ROOT, "migrations", "0001_fresh_benchmark_hires.sql"),
      "utf8",
    );
    const generatedSql = readFileSync(resolve(drizzleRoot, generatedMigrationName), "utf8");
    expect(generatedSql).toBe(referenceSql);
    expect(semanticSqlStatements(generatedSql)).toEqual(
      FRESH_MARKETPLACE_SCHEMA_STATEMENTS.map((statement) =>
        statement.replace(/\s+/g, " ").trim()
      ),
    );

    const journal = JSON.parse(
      readFileSync(resolve(drizzleRoot, "meta", "_journal.json"), "utf8"),
    ) as { dialect?: string; entries?: Array<{ idx?: number; tag?: string }> };
    expect(journal.dialect).toBe("sqlite");
    expect(journal.entries?.map(({ idx, tag }) => ({ idx, tag }))).toEqual([
      { idx: 0, tag: "0000_fresh_benchmark_hires" },
      { idx: 1, tag: "0001_current_block_pinned_hires" },
      { idx: 2, tag: "0002_four_category_current_hires" },
      { idx: 3, tag: "0003_shadow_grid_events" },
      { idx: 4, tag: "0004_altana_venus_activations" },
    ]);

    const altanaActivationMigration = readFileSync(
      resolve(PROJECT_ROOT, "migrations", "0005_altana_venus_activations.sql"),
      "utf8",
    );
    const generatedAltanaActivationMigration = readFileSync(
      resolve(drizzleRoot, generatedAltanaActivationMigrationName),
      "utf8",
    );
    expect(generatedAltanaActivationMigration).toBe(altanaActivationMigration);

    const currentMigration = readFileSync(
      resolve(PROJECT_ROOT, "migrations", "0002_current_block_pinned_hires.sql"),
      "utf8",
    );
    expect(currentMigration).toContain("CURRENT_BLOCK_PINNED");
    expect(currentMigration).toContain("CREATE TABLE fresh_marketplace_rate_limits");
    expect(currentMigration).not.toContain("COUNT(*) FROM fresh_marketplace_hires");
    const generatedCurrentMigration = readFileSync(
      resolve(drizzleRoot, generatedCurrentMigrationName),
      "utf8",
    );
    expect(
      generatedCurrentMigration
        .replaceAll("--> statement-breakpoint", "")
        .replace(/\s+/g, " ")
        .trim(),
    ).toBe(currentMigration.replace(/\s+/g, " ").trim());
  });
});


const FOUR_CATEGORY_CURRENT_CASES = [
  {
    service: "BOUNDED_GRID",
    benchmarkSlug: "bounded-grid",
    providerSlug: "bounded-grid",
    fixturePath: "fixtures/bounded-grid/bnb-usdt-grid.v1.json",
    blockNumber: "117112307",
    sourceId: "pancake-v3-mainnet-block-117112307",
    protocol: "PancakeSwap V3 bounded grid policy",
    requestId: "pancake-grid-117112307",
  },
  {
    service: "LP_REBALANCE",
    benchmarkSlug: "lp-rebalance",
    providerSlug: "lp-rebalance",
    fixturePath: "fixtures/lp-rebalance/out-of-range-v3-position.v1.json",
    blockNumber: "115618500",
    sourceId: "pancake-position-mainnet-block-115618500",
    protocol: "PancakeSwap V3 position analysis",
    requestId: "pancake-position-1456267-115618500",
  },
  {
    service: "YIELD_OPTIMIZATION",
    benchmarkSlug: "yield-optimization",
    providerSlug: "yield-optimization",
    fixturePath: "fixtures/yield-optimization/venus-to-beefy.v1.json",
    blockNumber: "117112308",
    sourceId: "venus-yield-mainnet-block-117112308",
    protocol: "Venus Core Pool stablecoin supply",
    requestId: "venus-yield-117112308",
  },
  {
    service: "LENDING_RESCUE",
    benchmarkSlug: "lending-rescue",
    providerSlug: "lending-rescue",
    fixturePath: null,
    blockNumber: "117112309",
    sourceId: "venus-mainnet-block-117112309",
    protocol: "Venus Classic",
    requestId: "venus-live-schema-117112309",
  },
] as const;

function rebaseCurrentSchemaValue(value: unknown, observedAt: string, sourceId: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => rebaseCurrentSchemaValue(item, observedAt, sourceId));
  }
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (key === "observedAt") return [key, observedAt];
      if (key === "sourceId") return [key, sourceId];
      return [key, rebaseCurrentSchemaValue(child, observedAt, sourceId)];
    }),
  );
}

function fourCategoryCurrentBody(
  definition: (typeof FOUR_CATEGORY_CURRENT_CASES)[number],
  ordinal: number,
) {
  const observedAt = `2026-08-24T12:0${ordinal}:00.000Z`;
  const explorerUrl = `https://bscscan.com/block/${definition.blockNumber}`;
  const fixture = definition.fixturePath === null
    ? lendingFixture()
    : JSON.parse(readFileSync(resolve(PROJECT_ROOT, definition.fixturePath), "utf8"));
  const providerRequest = rebaseCurrentSchemaValue(
    structuredClone(fixture),
    observedAt,
    definition.sourceId,
  ) as Record<string, unknown>;
  providerRequest.requestId = definition.requestId;
  providerRequest.chainId = 56;
  providerRequest.protocol = definition.protocol;
  providerRequest.requestedAt = new Date(Date.parse(observedAt) + 5_000).toISOString();
  providerRequest.deadline = new Date(Date.parse(observedAt) + 5 * 60_000).toISOString();
  providerRequest.sources = [{
    sourceId: definition.sourceId,
    label: `Deterministic current-schema observation for ${definition.service}`,
    uri: explorerUrl,
    observedAt,
  }];
  if (definition.service === "LENDING_RESCUE") {
    providerRequest.market = "0xfD36E2c2a6789Db23113685031d7F16329158384";
  }

  return {
    schemaVersion: "positioncrew.fresh-marketplace-hire-request.v2" as const,
    idempotencyKey: `${ordinal + 5}${ordinal + 5}${ordinal + 5}${ordinal + 5}${ordinal + 5}${ordinal + 5}${ordinal + 5}${ordinal + 5}-2222-4222-8222-222222222222`,
    benchmarkSlug: definition.benchmarkSlug,
    providerSlug: definition.providerSlug,
    evidenceMode: "CURRENT_BLOCK_PINNED" as const,
    observation: {
      blockNumber: definition.blockNumber,
      observedAt,
      explorerUrl,
    },
    request: providerRequest,
  };
}

describe("four-category current persisted-hire schema", () => {
  it.each(FOUR_CATEGORY_CURRENT_CASES)(
    "accepts only the exact current $service source and provider/task binding",
    (definition) => {
      const ordinal = FOUR_CATEGORY_CURRENT_CASES.indexOf(definition);
      const body = fourCategoryCurrentBody(definition, ordinal);
      const parsed = FreshMarketplaceHireRequestSchema.parse(body) as {
        evidenceMode: string;
        benchmarkSlug: string;
        providerSlug: string;
        request: {
          service: string;
          requestId: string;
          sources: Array<{ sourceId: string; uri: string; observedAt: string }>;
        };
      };

      expect(parsed.evidenceMode).toBe("CURRENT_BLOCK_PINNED");
      expect(parsed.benchmarkSlug).toBe(definition.benchmarkSlug);
      expect(parsed.providerSlug).toBe(definition.providerSlug);
      expect(parsed.request.service).toBe(definition.service);
      expect(parsed.request.requestId).toBe(definition.requestId);
      const source = parsed.request.sources[0];
      if (!source) throw new Error(`${definition.service} request omitted its bound source`);
      expect(source.sourceId).toBe(definition.sourceId);
      expect(source.uri).toBe(body.observation.explorerUrl);
      expect(source.observedAt).toBe(body.observation.observedAt);

      const mismatched = FOUR_CATEGORY_CURRENT_CASES[(ordinal + 1) % FOUR_CATEGORY_CURRENT_CASES.length];
      if (!mismatched) throw new Error("Current-hire mismatch case is unavailable");
      expect(FreshMarketplaceHireRequestSchema.safeParse({
        ...body,
        providerSlug: mismatched.providerSlug,
      }).success).toBe(false);
      expect(FreshMarketplaceHireRequestSchema.safeParse({
        ...body,
        observation: { ...body.observation, observedAt: "2026-08-24T11:59:00.000Z" },
      }).success).toBe(false);
      expect(FreshMarketplaceHireRequestSchema.safeParse({
        ...body,
        observation: { ...body.observation, explorerUrl: "https://bscscan.com/block/1" },
      }).success).toBe(false);
    },
  );

  it.each(FOUR_CATEGORY_CURRENT_CASES.slice(0, 3))(
    "rejects a historical-style requestId for current $service",
    (definition) => {
      const ordinal = FOUR_CATEGORY_CURRENT_CASES.indexOf(definition);
      const body = fourCategoryCurrentBody(definition, ordinal);
      expect(FreshMarketplaceHireRequestSchema.safeParse({
        ...body,
        request: { ...body.request, requestId: `fixture-${definition.service.toLowerCase()}` },
      }).success).toBe(false);
    },
  );

  it("binds the generated four-category migration to exact reference SQL", () => {
    const reference = semanticSqlStatements(
      readFileSync(resolve(PROJECT_ROOT, "migrations/0003_four_category_current_hires.sql"), "utf8"),
    );
    const generated = semanticSqlStatements(
      readFileSync(resolve(PROJECT_ROOT, "drizzle/0002_four_category_current_hires.sql"), "utf8"),
    );
    expect(generated).toEqual(reference);
    const sql = reference.join("\n");
    for (const definition of FOUR_CATEGORY_CURRENT_CASES) {
      expect(sql).toContain(`'${definition.benchmarkSlug}'`);
      expect(sql).toContain(`'${definition.providerSlug}'`);
      expect(sql).toContain(`'${definition.service}'`);
    }
    expect(sql).toContain("CURRENT_BLOCK_PINNED");
    expect(sql).toContain("provider_hash");
    expect(sql).toContain("evidence_json");
    expect(sql).toContain("evidence_hash");
  });
});
