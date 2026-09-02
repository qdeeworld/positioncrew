import type { D1Database } from "./d1-marketplace-store.js";

export type AltanaActivationState = "CREATED" | "RUNNING" | "COMPLETED" | "FAILED";

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
  };
}

const SELECT = `SELECT activation_id, idempotency_key, source_hire_id, source_receipt_id,
 state, created_at, started_at, completed_at, receipt_id, receipt_json, receipt_hash,
 error_code, error_message FROM altana_venus_activations`;

export class AltanaVenusActivationCapacityExceeded extends Error {
  readonly code = "ACTIVATION_CAPACITY_EXCEEDED";
  constructor() {
    super("The bounded testnet activation budget is unavailable for this client or day");
    this.name = "AltanaVenusActivationCapacityExceeded";
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
    runningLeaseCutoff: string;
  }): Promise<AltanaActivationRecord> {
    const existing = await this.db.prepare(`${SELECT} WHERE idempotency_key = ?`)
      .bind(input.idempotencyKey).first<ActivationRow>();
    if (existing) {
      if (existing.source_hire_id !== input.sourceHireId || existing.source_receipt_id !== input.sourceReceiptId) {
        throw new Error("ACTIVATION_IDEMPOTENCY_CONFLICT");
      }
      return record(existing);
    }
    const result = await this.db.prepare(`INSERT OR IGNORE INTO altana_venus_activations (
      activation_id, idempotency_key, source_hire_id, source_receipt_id,
      client_key_hash, day_bucket, state, created_at, started_at
    ) SELECT ?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?
      WHERE (SELECT COUNT(*) FROM altana_venus_activations WHERE day_bucket = ?) < ?
      AND NOT EXISTS (
        SELECT 1 FROM altana_venus_activations
        WHERE state = 'RUNNING' AND started_at >= ?
      )`)
      .bind(
        input.activationId, input.idempotencyKey, input.sourceHireId, input.sourceReceiptId,
        input.clientKeyHash, input.dayBucket, input.createdAt, input.createdAt,
        input.dayBucket, input.globalDailyLimit, input.runningLeaseCutoff,
      ).run();
    if ((result.meta.changes ?? 0) !== 1) {
      const replay = await this.db.prepare(`${SELECT} WHERE idempotency_key = ? OR source_receipt_id = ?`)
        .bind(input.idempotencyKey, input.sourceReceiptId).first<ActivationRow>();
      if (replay) return record(replay);
      throw new AltanaVenusActivationCapacityExceeded();
    }
    const created = await this.get(input.activationId);
    if (!created) throw new Error("ACTIVATION_CREATE_LOST");
    return created;
  }

  async claim(activationId: string, startedAt: string): Promise<AltanaActivationRecord | null> {
    await this.db.prepare(
      "UPDATE altana_venus_activations SET state = 'RUNNING', started_at = ? WHERE activation_id = ? AND state = 'CREATED'",
    ).bind(startedAt, activationId).run();
    return this.get(activationId);
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
