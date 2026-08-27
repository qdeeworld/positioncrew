import {
  CurrentBlockPinnedEvidenceSchema,
  FRESH_MARKETPLACE_TASKS,
  FreshMarketplaceChainSchema,
  canonicalJson,
  freshMarketplaceClaimBoundary,
  sha256Commitment,
  type CurrentBlockPinnedEvidence,
  type FreshMarketplaceChain,
  type FreshMarketplaceHireRequest,
} from "./fresh-hire-schema.js";
import { verifyLendingProviderAuditionCommitment } from "../marketplace/lending-provider-audition.js";

export interface D1Result {
  success: boolean;
  error?: string;
  meta: { changes?: number };
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

export const FRESH_MARKETPLACE_JOB_LEASE_MILLISECONDS = 5 * 60 * 1_000;
export const FRESH_MARKETPLACE_CREATE_WINDOW_MILLISECONDS = 60 * 1_000;
export const FRESH_MARKETPLACE_MAX_CREATES_PER_WINDOW = 30;

interface JoinedRow extends Record<string, unknown> {
  hire_id: string;
  idempotency_key: string;
  provider_slug: string;
  provider_id: string;
  benchmark_slug: string;
  service: string;
  evidence_mode: string;
  direct_cost_usd: string;
  wallet_required: number;
  request_json: string;
  request_hash: string;
  provider_hash: string | null;
  evidence_json: string | null;
  evidence_hash: string | null;
  hire_created_at: string;
  job_id: string;
  job_state: string;
  job_created_at: string;
  job_started_at: string | null;
  job_completed_at: string | null;
  api_duration_milliseconds: number | null;
  error_code: string | null;
  error_message: string | null;
  receipt_id: string | null;
  response_json: string | null;
  response_hash: string | null;
  deliverable_hash: string | null;
  evaluation_hash: string | null;
  receipt_created_at: string | null;
}

export interface CreateFreshMarketplaceHire {
  request: FreshMarketplaceHireRequest;
  providerId: string;
  hireId: string;
  jobId: string;
  createdAt: string;
  requestJson: string;
  requestHash: string;
  providerHash: string;
  evidenceMode: FreshMarketplaceChain["hire"]["evidenceMode"];
  evidenceJson: string;
  evidenceHash: string;
  service: FreshMarketplaceChain["hire"]["service"];
  rateLimitKey: string;
}

export interface CompleteFreshMarketplaceJob {
  hireId: string;
  jobId: string;
  claimToken: string;
  receiptId: string;
  responseJson: string;
  responseHash: string;
  deliverableHash: string;
  evaluationHash: string;
  completedAt: string;
  apiDurationMilliseconds: number;
}

export class FreshMarketplaceIdempotencyConflict extends Error {
  readonly code = "IDEMPOTENCY_CONFLICT";
  readonly domain = "positioncrew.fresh-marketplace";

  constructor() {
    super("The idempotency key is already bound to another immutable hire payload");
    this.name = "FreshMarketplaceIdempotencyConflict";
  }
}

export class FreshMarketplaceCapacityExceeded extends Error {
  readonly code = "HIRE_CAPACITY_EXCEEDED";
  readonly domain = "positioncrew.fresh-marketplace";

  constructor() {
    super("The client rolling durable-hire creation limit has been reached");
    this.name = "FreshMarketplaceCapacityExceeded";
  }
}

export function isFreshMarketplaceCapacityExceeded(
  error: unknown,
): error is FreshMarketplaceCapacityExceeded {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as Record<string, unknown>;
  return (
    candidate.name === "FreshMarketplaceCapacityExceeded" &&
    candidate.code === "HIRE_CAPACITY_EXCEEDED" &&
    candidate.domain === "positioncrew.fresh-marketplace" &&
    candidate.message === "The client rolling durable-hire creation limit has been reached"
  );
}

export function isFreshMarketplaceIdempotencyConflict(
  error: unknown,
): error is FreshMarketplaceIdempotencyConflict {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as Record<string, unknown>;
  return (
    candidate.name === "FreshMarketplaceIdempotencyConflict" &&
    candidate.code === "IDEMPOTENCY_CONFLICT" &&
    candidate.domain === "positioncrew.fresh-marketplace" &&
    candidate.message === "The idempotency key is already bound to another immutable hire payload"
  );
}

function jobStatus(state: string): FreshMarketplaceChain["job"]["status"] {
  if (state === "CREATED") return "HIRE_RECORDED";
  if (state === "RUNNING") return "RUNNING";
  if (state === "COMPLETED") return "COMPLETED";
  if (state === "FAILED") return "FAILED";
  throw new Error("Unknown persisted job state");
}

type LendingProviderAudition = NonNullable<CurrentBlockPinnedEvidence["providerAudition"]>;

function lendingProviderAuditionReplayPayload(audition: LendingProviderAudition): unknown {
  return {
    schemaVersion: audition.schemaVersion,
    policyVersion: audition.policyVersion,
    service: audition.service,
    requestHash: audition.requestHash,
    observation: audition.observation,
    candidates: audition.candidates,
    selection: audition.selection,
    claimBoundary: audition.claimBoundary,
  };
}

function currentEvidenceReplayPayload(
  evidence: CurrentBlockPinnedEvidence,
  includeProviderAudition = true,
): unknown {
  const payload = {
    schemaVersion: evidence.schemaVersion,
    evidenceClass: evidence.evidenceClass,
    chainId: evidence.chainId,
    source: evidence.source,
    maxDataAgeSeconds: evidence.maxDataAgeSeconds,
  };
  return includeProviderAudition
    ? {
        ...payload,
        providerAudition: evidence.providerAudition
          ? lendingProviderAuditionReplayPayload(evidence.providerAudition)
          : null,
      }
    : payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function embeddedReceiptHashes(response: unknown): {
  deliverableHash: string | null;
  evaluationHash: string | null;
} {
  if (!isRecord(response) || !isRecord(response.result)) {
    return { deliverableHash: null, evaluationHash: null };
  }
  const job = isRecord(response.result.job) ? response.result.job : null;
  const deliverable = job && isRecord(job.deliverable) ? job.deliverable : null;
  const evaluation = isRecord(response.result.evaluation) ? response.result.evaluation : null;
  return {
    deliverableHash: deliverable && typeof deliverable.deliverableHash === "string"
      ? deliverable.deliverableHash
      : null,
    evaluationHash: evaluation && typeof evaluation.evaluationHash === "string"
      ? evaluation.evaluationHash
      : null,
  };
}

async function verifyPersistedCommitments(chain: FreshMarketplaceChain): Promise<void> {
  if (await sha256Commitment(chain.hire.request) !== chain.hire.requestHash) {
    throw new Error("Persisted marketplace request commitment mismatch");
  }

  const commitmentPresence = [
    chain.hire.providerHash !== null,
    chain.hire.evidence !== null,
    chain.hire.evidenceHash !== null,
  ];
  if (commitmentPresence.some((present) => present !== commitmentPresence[0])) {
    throw new Error("Persisted marketplace evidence commitment set is incomplete");
  }
  if (chain.hire.providerHash !== null) {
    const task = FRESH_MARKETPLACE_TASKS[chain.hire.benchmarkSlug];
    const expectedProviderHash = await sha256Commitment({
      providerSlug: chain.hire.providerSlug,
      providerId: chain.hire.providerId,
      service: chain.hire.service,
      requestSchema: task.requestSchema,
    });
    if (expectedProviderHash !== chain.hire.providerHash) {
      throw new Error("Persisted marketplace provider commitment mismatch");
    }
  }
  if (
    chain.hire.evidence !== null &&
    chain.hire.evidenceHash !== null &&
    await sha256Commitment(chain.hire.evidence) !== chain.hire.evidenceHash
  ) {
    throw new Error("Persisted marketplace evidence commitment mismatch");
  }
  const audition = chain.hire.evidence?.evidenceClass === "CURRENT_BLOCK_PINNED"
    ? chain.hire.evidence.providerAudition
    : undefined;
  if (audition && !await verifyLendingProviderAuditionCommitment(audition)) {
    throw new Error("Persisted marketplace provider audition commitment mismatch");
  }

  if (chain.receipt) {
    if (await sha256Commitment(chain.receipt.response) !== chain.receipt.responseHash) {
      throw new Error("Persisted marketplace response commitment mismatch");
    }
    const embedded = embeddedReceiptHashes(chain.receipt.response);
    if (
      embedded.deliverableHash !== null &&
      embedded.deliverableHash !== chain.receipt.deliverableHash
    ) {
      throw new Error("Persisted marketplace deliverable commitment mismatch");
    }
    if (
      embedded.evaluationHash !== null &&
      embedded.evaluationHash !== chain.receipt.evaluationHash
    ) {
      throw new Error("Persisted marketplace evaluation commitment mismatch");
    }
  }
}

async function rowToChain(row: JoinedRow): Promise<FreshMarketplaceChain> {
  const request = JSON.parse(row.request_json) as Record<string, unknown>;
  const receipt = row.receipt_id === null ? null : {
    receiptId: row.receipt_id,
    publicUrl: "/api/benchmark-receipts/" + encodeURIComponent(row.receipt_id),
    responseHash: row.response_hash,
    deliverableHash: row.deliverable_hash,
    evaluationHash: row.evaluation_hash,
    createdAt: row.receipt_created_at,
    response: JSON.parse(row.response_json ?? "null") as unknown,
  };
  const chain = FreshMarketplaceChainSchema.parse({
    schemaVersion: "positioncrew.fresh-marketplace-chain.v1",
    claimBoundary: [...freshMarketplaceClaimBoundary(row.evidence_mode as FreshMarketplaceChain["hire"]["evidenceMode"])],
    hire: {
      hireId: row.hire_id,
      idempotencyKey: row.idempotency_key,
      providerSlug: row.provider_slug,
      providerId: row.provider_id,
      benchmarkSlug: row.benchmark_slug,
      service: row.service,
      evidenceMode: row.evidence_mode,
      commerce: {
        directCostUsd: row.direct_cost_usd,
        walletRequired: row.wallet_required === 1,
        settlement: "NO_PAYMENT",
      },
      request,
      requestHash: row.request_hash,
      providerHash: row.provider_hash,
      evidence: row.evidence_json === null
        ? null
        : JSON.parse(row.evidence_json) as unknown,
      evidenceHash: row.evidence_hash,
      createdAt: row.hire_created_at,
    },
    job: {
      jobId: row.job_id,
      state: row.job_state,
      status: jobStatus(row.job_state),
      createdAt: row.job_created_at,
      startedAt: row.job_started_at,
      completedAt: row.job_completed_at,
      apiDurationMilliseconds: row.api_duration_milliseconds,
      error: row.error_code === null || row.error_message === null
        ? null
        : { code: row.error_code, message: row.error_message },
    },
    receipt,
  });
  await verifyPersistedCommitments(chain);
  return chain;
}

const JOINED_SELECT = [
  "SELECT h.hire_id, h.idempotency_key, h.provider_slug, h.provider_id,",
  "h.benchmark_slug, h.service, h.evidence_mode, h.direct_cost_usd, h.wallet_required,",
  "h.request_json, h.request_hash, h.provider_hash, h.evidence_json, h.evidence_hash,",
  "h.created_at AS hire_created_at,",
  "j.job_id, j.state AS job_state, j.created_at AS job_created_at,",
  "j.started_at AS job_started_at, j.completed_at AS job_completed_at,",
  "j.api_duration_milliseconds, j.error_code, j.error_message,",
  "r.receipt_id, r.response_json, r.response_hash, r.deliverable_hash,",
  "r.evaluation_hash, r.created_at AS receipt_created_at",
  "FROM fresh_marketplace_hires h",
  "JOIN fresh_marketplace_jobs j ON j.hire_id = h.hire_id",
  "LEFT JOIN fresh_marketplace_receipts r ON r.job_id = j.job_id",
].join(" ");

export class FreshMarketplaceStore {
  constructor(private readonly db: D1Database) {}

  async createHire(input: CreateFreshMarketplaceHire): Promise<{
    chain: FreshMarketplaceChain;
    replayed: boolean;
  }> {
    const existing = await this.getByIdempotencyKey(input.request.idempotencyKey);
    if (existing) return this.matchReplay(existing, input);
    const createdAtMilliseconds = Date.parse(input.createdAt);
    if (!Number.isFinite(createdAtMilliseconds)) {
      throw new Error("D1 hire creation requires a valid ISO timestamp");
    }
    const createWindowExpiresAt = new Date(
      createdAtMilliseconds + FRESH_MARKETPLACE_CREATE_WINDOW_MILLISECONDS,
    ).toISOString();

    try {
      const results = await this.db.batch([
        this.db.prepare(
          "DELETE FROM fresh_marketplace_rate_limits WHERE window_expires_at <= ?",
        ).bind(input.createdAt),
        this.db.prepare([
          "INSERT INTO fresh_marketplace_rate_limits",
          "(key_hash, window_started_at, window_expires_at, create_count) VALUES (?, ?, ?, 1)",
          "ON CONFLICT(key_hash) DO UPDATE SET",
          "create_count = fresh_marketplace_rate_limits.create_count + 1",
        ].join(" ")).bind(input.rateLimitKey, input.createdAt, createWindowExpiresAt),
        this.db.prepare([
          "INSERT INTO fresh_marketplace_hires",
          "(hire_id, idempotency_key, provider_slug, provider_id, benchmark_slug, service,",
          "evidence_mode, direct_cost_usd, wallet_required, request_json, request_hash,",
          "provider_hash, evidence_json, evidence_hash, created_at)",
          "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?",
          "WHERE (SELECT create_count FROM fresh_marketplace_rate_limits WHERE key_hash = ?) <= ?",
        ].join(" ")).bind(
          input.hireId,
          input.request.idempotencyKey,
          input.request.providerSlug,
          input.providerId,
          input.request.benchmarkSlug,
          input.service,
          input.evidenceMode,
          "0.00",
          0,
          input.requestJson,
          input.requestHash,
          input.providerHash,
          input.evidenceJson,
          input.evidenceHash,
          input.createdAt,
          input.rateLimitKey,
          FRESH_MARKETPLACE_MAX_CREATES_PER_WINDOW,
        ),
        this.db.prepare(
          [
            "INSERT INTO fresh_marketplace_jobs (job_id, hire_id, state, created_at)",
            "SELECT ?, h.hire_id, 'CREATED', ? FROM fresh_marketplace_hires h WHERE h.hire_id = ?",
          ].join(" "),
        ).bind(input.jobId, input.createdAt, input.hireId),
      ]);
      const failed = results.find((result) => !result.success);
      if (failed) throw new Error(failed.error ?? "D1 hire creation failed");
      if (results[2]?.meta.changes !== 1) throw new FreshMarketplaceCapacityExceeded();
      if (results[3]?.meta.changes !== 1) throw new Error("D1 job creation did not follow its hire");
    } catch (error) {
      const raced = await this.getByIdempotencyKey(input.request.idempotencyKey);
      if (raced) return this.matchReplay(raced, input);
      throw error;
    }

    const chain = await this.getHire(input.hireId);
    if (!chain) throw new Error("Persisted hire could not be read back");
    return { chain, replayed: false };
  }

  async getHire(hireId: string): Promise<FreshMarketplaceChain | null> {
    const row = await this.db.prepare(JOINED_SELECT + " WHERE h.hire_id = ?").bind(hireId).first<JoinedRow>();
    return row ? await rowToChain(row) : null;
  }

  async getReceipt(receiptId: string): Promise<FreshMarketplaceChain | null> {
    const row = await this.db.prepare(JOINED_SELECT + " WHERE r.receipt_id = ?").bind(receiptId).first<JoinedRow>();
    return row ? await rowToChain(row) : null;
  }

  async claimJob(hireId: string, startedAt: string): Promise<{
    chain: FreshMarketplaceChain | null;
    claimed: boolean;
    claimToken: string | null;
  }> {
    const startedAtMilliseconds = Date.parse(startedAt);
    if (!Number.isFinite(startedAtMilliseconds)) {
      throw new Error("D1 job claim requires a valid ISO timestamp");
    }
    const staleBefore = new Date(
      startedAtMilliseconds - FRESH_MARKETPLACE_JOB_LEASE_MILLISECONDS,
    ).toISOString();
    const result = await this.db.prepare(
      [
        "UPDATE fresh_marketplace_jobs SET state = 'RUNNING', started_at = ?,",
        "completed_at = NULL, api_duration_milliseconds = NULL, error_code = NULL, error_message = NULL",
        "WHERE hire_id = ? AND (state = 'CREATED' OR",
        "(state = 'RUNNING' AND started_at IS NOT NULL AND started_at <= ?))",
      ].join(" "),
    ).bind(startedAt, hireId, staleBefore).run();
    if (!result.success) throw new Error(result.error ?? "D1 job claim failed");
    const claimed = result.meta.changes === 1;
    return {
      chain: await this.getHire(hireId),
      claimed,
      claimToken: claimed ? startedAt : null,
    };
  }

  async completeJob(input: CompleteFreshMarketplaceJob): Promise<FreshMarketplaceChain> {
    const results = await this.db.batch([
      this.db.prepare([
        "INSERT INTO fresh_marketplace_receipts",
        "(receipt_id, job_id, hire_id, response_json, response_hash, deliverable_hash, evaluation_hash, created_at)",
        "SELECT ?, j.job_id, j.hire_id, ?, ?, ?, ?, ? FROM fresh_marketplace_jobs j",
        "WHERE j.job_id = ? AND j.hire_id = ? AND j.state = 'RUNNING' AND j.started_at = ?",
      ].join(" ")).bind(
        input.receiptId,
        input.responseJson,
        input.responseHash,
        input.deliverableHash,
        input.evaluationHash,
        input.completedAt,
        input.jobId,
        input.hireId,
        input.claimToken,
      ),
      this.db.prepare([
        "UPDATE fresh_marketplace_jobs SET state = 'COMPLETED', completed_at = ?,",
        "api_duration_milliseconds = ? WHERE job_id = ? AND hire_id = ?",
        "AND state = 'RUNNING' AND started_at = ?",
      ].join(" ")).bind(
        input.completedAt,
        input.apiDurationMilliseconds,
        input.jobId,
        input.hireId,
        input.claimToken,
      ),
    ]);
    const failed = results.find((result) => !result.success);
    if (failed) throw new Error(failed.error ?? "D1 job finalization failed");
    const chain = await this.getHire(input.hireId);
    if (!chain || chain.job.state !== "COMPLETED" || !chain.receipt) {
      throw new Error("D1 job finalization did not commit a receipt");
    }
    return chain;
  }

  async failJob(
    hireId: string,
    jobId: string,
    claimToken: string,
    completedAt: string,
    apiDurationMilliseconds: number,
    code: string,
    message: string,
  ): Promise<FreshMarketplaceChain | null> {
    const result = await this.db.prepare([
      "UPDATE fresh_marketplace_jobs SET state = 'FAILED', completed_at = ?,",
      "api_duration_milliseconds = ?, error_code = ?, error_message = ?",
      "WHERE job_id = ? AND hire_id = ? AND state = 'RUNNING' AND started_at = ?",
    ].join(" ")).bind(
      completedAt,
      apiDurationMilliseconds,
      code,
      message,
      jobId,
      hireId,
      claimToken,
    ).run();
    if (!result.success) throw new Error(result.error ?? "D1 failed-job persistence failed");
    return this.getHire(hireId);
  }

  private async getByIdempotencyKey(idempotencyKey: string): Promise<FreshMarketplaceChain | null> {
    const row = await this.db.prepare(JOINED_SELECT + " WHERE h.idempotency_key = ?")
      .bind(idempotencyKey)
      .first<JoinedRow>();
    return row ? await rowToChain(row) : null;
  }

  private matchReplay(
    existing: FreshMarketplaceChain,
    input: CreateFreshMarketplaceHire,
  ): { chain: FreshMarketplaceChain; replayed: true } {
    if (
      existing.hire.providerSlug !== input.request.providerSlug ||
      existing.hire.benchmarkSlug !== input.request.benchmarkSlug ||
      existing.hire.evidenceMode !== input.evidenceMode ||
      existing.hire.requestHash !== input.requestHash
    ) {
      throw new FreshMarketplaceIdempotencyConflict();
    }
    if (input.evidenceMode === "CURRENT_BLOCK_PINNED") {
      if (
        existing.hire.providerId !== input.providerId ||
        existing.hire.service !== input.service ||
        existing.hire.providerHash !== input.providerHash ||
        existing.hire.evidence?.evidenceClass !== "CURRENT_BLOCK_PINNED"
      ) {
        throw new FreshMarketplaceIdempotencyConflict();
      }
      const proposedEvidence = CurrentBlockPinnedEvidenceSchema.parse(
        JSON.parse(input.evidenceJson) as unknown,
      );
      const legacyLendingReplay = input.service === "LENDING_RESCUE" &&
        !existing.hire.evidence.providerAudition &&
        Boolean(proposedEvidence.providerAudition);
      if (
        canonicalJson(currentEvidenceReplayPayload(
          existing.hire.evidence,
          !legacyLendingReplay,
        )) !== canonicalJson(currentEvidenceReplayPayload(
          proposedEvidence,
          !legacyLendingReplay,
        ))
      ) {
        throw new FreshMarketplaceIdempotencyConflict();
      }
      if (
        input.service === "LENDING_RESCUE" &&
        !proposedEvidence.providerAudition
      ) {
        throw new FreshMarketplaceIdempotencyConflict();
      }
    }
    return { chain: existing, replayed: true };
  }
}
