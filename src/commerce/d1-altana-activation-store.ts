import type { D1Database } from "./d1-marketplace-store.js";

export type AltanaActivationState = "CREATED" | "RUNNING" | "CHAIN_SUBMITTED" | "CHAIN_CONFIRMED" | "CONFIRMED" | "COMPLETED" | "FAILED";

export interface AltanaActivationRecord {
  schemaVersion: "positioncrew.altana-venus-activation.v1";
  activationId: string;
  idempotencyKey: string;
  sourceHireId: string;
  sourceReceiptId: string;
  state: AltanaActivationState;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  receiptId: string | null;
  receipt: unknown | null;
  receiptHash: string | null;
  error: { code: string; message: string } | null;
  confirmedExecution: unknown | null;
}

interface ActivationRow extends Record<string, unknown> {
  activation_id: string;
  idempotency_key: string;
  source_hire_id: string;
  source_receipt_id: string;
  state: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  receipt_id: string | null;
  receipt_json: string | null;
  receipt_hash: string | null;
  error_code: string | null;
  error_message: string | null;
  confirmed_receipt_id: string | null;
  confirmed_receipt_json: string | null;
  confirmed_receipt_hash: string | null;
  confirmed_execution_json: string | null;
  confirmed_execution_hash: string | null;
}

function record(row: ActivationRow): AltanaActivationRecord {
  return {
    schemaVersion: "positioncrew.altana-venus-activation.v1",
    activationId: row.activation_id,
    idempotencyKey: row.idempotency_key,
    sourceHireId: row.source_hire_id,
    sourceReceiptId: row.source_receipt_id,
    state: row.state as AltanaActivationState,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    receiptId: row.receipt_id,
    receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null,
    receiptHash: row.receipt_hash,
    error: row.error_code && row.error_message
      ? { code: row.error_code, message: row.error_message }
      : null,
    confirmedExecution: row.confirmed_execution_json ? JSON.parse(row.confirmed_execution_json) : null,
  };
}

const SELECT = `SELECT activation_id, idempotency_key, source_hire_id, source_receipt_id,
 state, created_at, started_at, completed_at, receipt_id, receipt_json, receipt_hash,
 error_code, error_message, confirmed_receipt_id, confirmed_receipt_json, confirmed_receipt_hash,
 confirmed_execution_json, confirmed_execution_hash
 FROM altana_venus_activations`;

export class AltanaVenusActivationCapacityExceeded extends Error {
  readonly code = "ACTIVATION_CAPACITY_EXCEEDED";
  constructor() {
    super("The bounded testnet activation budget is unavailable for this client or day");
    this.name = "AltanaVenusActivationCapacityExceeded";
  }
}

export class AltanaVenusActivationIdempotencyConflict extends Error {
  readonly code = "ACTIVATION_IDEMPOTENCY_CONFLICT";
  constructor() {
    super("The activation idempotency key is already bound to another source receipt");
    this.name = "AltanaVenusActivationIdempotencyConflict";
  }
}

export class AltanaVenusActivationStore {
  constructor(private readonly db: D1Database) {}

  async get(activationId: string): Promise<AltanaActivationRecord | null> {
    const row = await this.db.prepare(`${SELECT} WHERE activation_id = ?`).bind(activationId).first<ActivationRow>();
    return row ? record(row) : null;
  }

  async getReceipt(receiptId: string): Promise<AltanaActivationRecord | null> {
    const row = await this.db.prepare(`${SELECT} WHERE receipt_id = ?`).bind(receiptId).first<ActivationRow>();
    return row ? record(row) : null;
  }

  async getBySourceReceipt(sourceReceiptId: string): Promise<AltanaActivationRecord | null> {
    const row = await this.db.prepare(`${SELECT} WHERE source_receipt_id = ?`)
      .bind(sourceReceiptId).first<ActivationRow>();
    return row ? record(row) : null;
  }

  async create(input: {
    activationId: string;
    idempotencyKey: string;
    sourceHireId: string;
    sourceReceiptId: string;
    clientKeyHash: string;
    dayBucket: string;
    createdAt: string;
    globalDailyLimit: number;
  }): Promise<AltanaActivationRecord> {
    const existing = await this.db.prepare(`${SELECT} WHERE idempotency_key = ?`)
      .bind(input.idempotencyKey).first<ActivationRow>();
    if (existing) {
      if (existing.source_hire_id !== input.sourceHireId || existing.source_receipt_id !== input.sourceReceiptId) {
        throw new AltanaVenusActivationIdempotencyConflict();
      }
      return record(existing);
    }
    const result = await this.db.prepare(`INSERT OR IGNORE INTO altana_venus_activations (
      activation_id, idempotency_key, source_hire_id, source_receipt_id,
      client_key_hash, day_bucket, state, created_at
    ) SELECT ?, ?, ?, ?, ?, ?, 'CREATED', ?
      WHERE (SELECT COUNT(*) FROM altana_venus_activations WHERE day_bucket = ?) < ?
      AND NOT EXISTS (
        SELECT 1 FROM altana_venus_activations
        WHERE state IN ('CREATED', 'RUNNING')
      )`)
      .bind(
        input.activationId, input.idempotencyKey, input.sourceHireId, input.sourceReceiptId,
        input.clientKeyHash, input.dayBucket, input.createdAt,
        input.dayBucket, input.globalDailyLimit,
      ).run();
    if ((result.meta.changes ?? 0) !== 1) {
      const replay = await this.db.prepare(`${SELECT} WHERE idempotency_key = ? OR source_receipt_id = ?`)
        .bind(input.idempotencyKey, input.sourceReceiptId).first<ActivationRow>();
      if (replay) {
        if (replay.idempotency_key === input.idempotencyKey &&
          (replay.source_hire_id !== input.sourceHireId || replay.source_receipt_id !== input.sourceReceiptId)) {
          throw new AltanaVenusActivationIdempotencyConflict();
        }
        return record(replay);
      }
      throw new AltanaVenusActivationCapacityExceeded();
    }
    const created = await this.get(input.activationId);
    if (!created) throw new Error("ACTIVATION_CREATE_LOST");
    return created;
  }

  async claim(activationId: string, startedAt: string): Promise<{
    claimed: boolean;
    activation: AltanaActivationRecord | null;
  }> {
    const result = await this.db.prepare(
      "UPDATE altana_venus_activations SET state = 'RUNNING', started_at = ? WHERE activation_id = ? AND state = 'CREATED'",
    ).bind(startedAt, activationId).run();
    return { claimed: (result.meta.changes ?? 0) === 1, activation: await this.get(activationId) };
  }

  async failStaleRunning(activationId: string, cutoff: string, completedAt: string): Promise<AltanaActivationRecord | null> {
    await this.db.prepare(`UPDATE altana_venus_activations
      SET state = 'FAILED', completed_at = ?, error_code = 'ACTIVATION_EXECUTION_UNCERTAIN',
          error_message = 'The execution lease expired without durable confirmation; no retry was broadcast.'
      WHERE activation_id = ? AND state = 'RUNNING' AND started_at < ?`)
      .bind(completedAt, activationId, cutoff).run();
    return this.get(activationId);
  }

  async persistConfirmed(input: {
    activationId: string;
    receiptId: string;
    receiptJson: string;
    receiptHash: string;
  }): Promise<void> {
    const result = await this.db.prepare(`UPDATE altana_venus_activations
      SET state = 'CONFIRMED', confirmed_receipt_id = ?, confirmed_receipt_json = ?, confirmed_receipt_hash = ?
      WHERE activation_id = ? AND state = 'CHAIN_CONFIRMED'`)
      .bind(input.receiptId, input.receiptJson, input.receiptHash, input.activationId).run();
    if ((result.meta.changes ?? 0) !== 1) throw new Error("ACTIVATION_CONFIRMATION_PERSISTENCE_RACE");
  }

  async persistChainConfirmed(input: {
    activationId: string;
    executionJson: string;
    executionHash: string;
  }): Promise<void> {
    const result = await this.db.prepare(`UPDATE altana_venus_activations
      SET state = 'CHAIN_CONFIRMED', confirmed_execution_json = ?, confirmed_execution_hash = ?
      WHERE activation_id = ? AND state = 'CHAIN_SUBMITTED'`)
      .bind(input.executionJson, input.executionHash, input.activationId).run();
    if ((result.meta.changes ?? 0) !== 1) throw new Error("ACTIVATION_CHAIN_CONFIRMATION_PERSISTENCE_RACE");
  }

  async persistChainSubmitted(input: {
    activationId: string;
    executionJson: string;
    executionHash: string;
  }): Promise<void> {
    const result = await this.db.prepare(`UPDATE altana_venus_activations
      SET state = 'CHAIN_SUBMITTED', confirmed_execution_json = ?, confirmed_execution_hash = ?
      WHERE activation_id = ? AND state = 'RUNNING'`)
      .bind(input.executionJson, input.executionHash, input.activationId).run();
    if ((result.meta.changes ?? 0) !== 1) throw new Error("ACTIVATION_CHAIN_SUBMISSION_PERSISTENCE_RACE");
  }

  async finalizeConfirmed(activationId: string, completedAt: string): Promise<void> {
    const result = await this.db.prepare(`UPDATE altana_venus_activations
      SET state = 'COMPLETED', completed_at = ?, receipt_id = confirmed_receipt_id,
          receipt_json = confirmed_receipt_json, receipt_hash = confirmed_receipt_hash
      WHERE activation_id = ? AND state = 'CONFIRMED'
        AND confirmed_receipt_id IS NOT NULL AND confirmed_receipt_json IS NOT NULL AND confirmed_receipt_hash IS NOT NULL`)
      .bind(completedAt, activationId).run();
    if ((result.meta.changes ?? 0) !== 1) throw new Error("ACTIVATION_FINALIZATION_RACE");
  }

  async complete(input: {
    activationId: string;
    receiptId: string;
    receiptJson: string;
    receiptHash: string;
    completedAt: string;
  }): Promise<void> {
    const result = await this.db.prepare(`UPDATE altana_venus_activations
      SET state = 'COMPLETED', completed_at = ?, receipt_id = ?, receipt_json = ?, receipt_hash = ?
      WHERE activation_id = ? AND state = 'RUNNING'`)
      .bind(input.completedAt, input.receiptId, input.receiptJson, input.receiptHash, input.activationId).run();
    if ((result.meta.changes ?? 0) !== 1) throw new Error("ACTIVATION_COMPLETION_RACE");
  }

  async fail(activationId: string, code: string, message: string, completedAt: string): Promise<void> {
    await this.db.prepare(`UPDATE altana_venus_activations
      SET state = 'FAILED', completed_at = ?, error_code = ?, error_message = ?
      WHERE activation_id = ? AND state = 'RUNNING'`)
      .bind(completedAt, code, message.slice(0, 500), activationId).run();
  }

  async dailyCount(dayBucket: string): Promise<number> {
    const row = await this.db.prepare(
      "SELECT COUNT(*) AS count FROM altana_venus_activations WHERE day_bucket = ?",
    ).bind(dayBucket).first<{ count: number }>();
    return Number(row?.count ?? 0);
  }
}
