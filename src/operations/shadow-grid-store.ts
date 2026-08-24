import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
} from "../commerce/d1-marketplace-store.js";

export const SHADOW_GRID_EVENT_TYPES = [
  "EPOCH_STARTED",
  "PRECOMMITTED",
  "REFUSED",
  "OBSERVED",
  "SHADOW_FILL",
  "CLOSED",
  "VOID_SOURCE_GAP",
  "RISK_EXIT",
] as const;

export type ShadowGridEventType = (typeof SHADOW_GRID_EVENT_TYPES)[number];

export interface ShadowGridEvent {
  eventId: string;
  idempotencyKey: string;
  runId: string;
  eventSequence: number;
  eventType: ShadowGridEventType;
  chainId: 56;
  market: "WBNB/USDT";
  strategyVersion: string;
  fillModel: "CONSERVATIVE_SAMPLED_CROSSING_V1";
  epochStartedAt: string;
  horizonEndsAt: string;
  hireId: string;
  receiptId: string;
  requestHash: string;
  providerHash: string;
  evidenceHash: string;
  responseHash: string;
  deliverableHash: string;
  evaluationHash: string;
  eventJson: string;
  previousEventHash: string | null;
  eventHash: string;
  recordedAt: string;
}

export type AppendShadowGridEvent = ShadowGridEvent;

interface ShadowGridEventRow extends Record<string, unknown> {
  event_id: string;
  idempotency_key: string;
  run_id: string;
  event_sequence: number;
  event_type: string;
  chain_id: number;
  market: string;
  strategy_version: string;
  fill_model: string;
  epoch_started_at: string;
  horizon_ends_at: string;
  hire_id: string;
  receipt_id: string;
  request_hash: string;
  provider_hash: string;
  evidence_hash: string;
  response_hash: string;
  deliverable_hash: string;
  evaluation_hash: string;
  event_json: string;
  previous_event_hash: string | null;
  event_hash: string;
  recorded_at: string;
}

interface D1QueryResult<T> extends D1Result {
  results: T[];
}

type QueryableD1Statement = D1PreparedStatement & {
  all<T = Record<string, unknown>>(): Promise<D1QueryResult<T>>;
};

function queryable(statement: D1PreparedStatement): QueryableD1Statement {
  if (!("all" in statement) || typeof statement.all !== "function") {
    throw new Error("D1 statement does not support result-set reads");
  }
  return statement as QueryableD1Statement;
}

function eventType(value: string): ShadowGridEventType {
  if (!(SHADOW_GRID_EVENT_TYPES as readonly string[]).includes(value)) {
    throw new Error("Unknown persisted shadow-grid event type");
  }
  return value as ShadowGridEventType;
}

function rowToEvent(row: ShadowGridEventRow): ShadowGridEvent {
  if (row.chain_id !== 56 || row.market !== "WBNB/USDT") {
    throw new Error("Persisted shadow-grid event changed its fixed market binding");
  }
  if (row.fill_model !== "CONSERVATIVE_SAMPLED_CROSSING_V1") {
    throw new Error("Persisted shadow-grid event changed its fill model");
  }
  JSON.parse(row.event_json);
  return {
    eventId: row.event_id,
    idempotencyKey: row.idempotency_key,
    runId: row.run_id,
    eventSequence: row.event_sequence,
    eventType: eventType(row.event_type),
    chainId: 56,
    market: "WBNB/USDT",
    strategyVersion: row.strategy_version,
    fillModel: "CONSERVATIVE_SAMPLED_CROSSING_V1",
    epochStartedAt: row.epoch_started_at,
    horizonEndsAt: row.horizon_ends_at,
    hireId: row.hire_id,
    receiptId: row.receipt_id,
    requestHash: row.request_hash,
    providerHash: row.provider_hash,
    evidenceHash: row.evidence_hash,
    responseHash: row.response_hash,
    deliverableHash: row.deliverable_hash,
    evaluationHash: row.evaluation_hash,
    eventJson: row.event_json,
    previousEventHash: row.previous_event_hash,
    eventHash: row.event_hash,
    recordedAt: row.recorded_at,
  };
}

function validateInput(input: AppendShadowGridEvent): void {
  const started = Date.parse(input.epochStartedAt);
  const horizon = Date.parse(input.horizonEndsAt);
  if (!Number.isFinite(started) || !Number.isFinite(horizon) || !Number.isFinite(Date.parse(input.recordedAt))) {
    throw new Error("Shadow-grid events require valid ISO timestamps");
  }
  if (horizon - started !== 15 * 60_000) {
    throw new Error("Shadow-grid events require an exact 15-minute horizon");
  }
  if (!Number.isInteger(input.eventSequence) || input.eventSequence < 0) {
    throw new Error("Shadow-grid event sequence must be a non-negative integer");
  }
  JSON.parse(input.eventJson);
}

const INSERT_EVENT = [
  "INSERT INTO shadow_grid_events (",
  "event_id, idempotency_key, run_id, event_sequence, event_type, chain_id, market,",
  "strategy_version, fill_model, epoch_started_at, horizon_ends_at, hire_id, receipt_id,",
  "request_hash, provider_hash, evidence_hash, response_hash, deliverable_hash, evaluation_hash,",
  "event_json, previous_event_hash, event_hash, recorded_at",
  ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
].join(" ");

export class ShadowGridEventIdempotencyConflict extends Error {
  readonly code = "EVENT_IDEMPOTENCY_CONFLICT";
  readonly domain = "positioncrew.shadow-grid";

  constructor() {
    super("The idempotency key is already bound to another immutable shadow-grid event");
    this.name = "ShadowGridEventIdempotencyConflict";
  }
}

export class ShadowGridLedgerStore {
  constructor(private readonly db: D1Database) {}

  async appendEvent(input: AppendShadowGridEvent): Promise<{ event: ShadowGridEvent; replayed: boolean }> {
    validateInput(input);
    const existing = await this.getByIdempotencyKey(input.idempotencyKey);
    if (existing) return this.matchReplay(existing, input);
    try {
      const result = await this.db.prepare(INSERT_EVENT).bind(
        input.eventId,
        input.idempotencyKey,
        input.runId,
        input.eventSequence,
        input.eventType,
        input.chainId,
        input.market,
        input.strategyVersion,
        input.fillModel,
        input.epochStartedAt,
        input.horizonEndsAt,
        input.hireId,
        input.receiptId,
        input.requestHash,
        input.providerHash,
        input.evidenceHash,
        input.responseHash,
        input.deliverableHash,
        input.evaluationHash,
        input.eventJson,
        input.previousEventHash,
        input.eventHash,
        input.recordedAt,
      ).run();
      if (!result.success || result.meta.changes !== 1) {
        throw new Error(result.error ?? "D1 did not append exactly one shadow-grid event");
      }
    } catch (error) {
      const raced = await this.getByIdempotencyKey(input.idempotencyKey);
      if (raced) return this.matchReplay(raced, input);
      throw error;
    }
    const event = await this.getEvent(input.eventId);
    if (!event) throw new Error("Persisted shadow-grid event could not be read back");
    return { event, replayed: false };
  }

  async getEvent(eventId: string): Promise<ShadowGridEvent | null> {
    const row = await this.db.prepare("SELECT * FROM shadow_grid_events WHERE event_id = ?")
      .bind(eventId).first<ShadowGridEventRow>();
    return row ? rowToEvent(row) : null;
  }

  async getLatestEvent(runId: string): Promise<ShadowGridEvent | null> {
    const row = await this.db.prepare(
      "SELECT * FROM shadow_grid_events WHERE run_id = ? ORDER BY event_sequence DESC LIMIT 1",
    ).bind(runId).first<ShadowGridEventRow>();
    return row ? rowToEvent(row) : null;
  }

  async getRun(runId: string): Promise<readonly ShadowGridEvent[]> {
    const result = await queryable(this.db.prepare(
      "SELECT * FROM shadow_grid_events WHERE run_id = ? ORDER BY event_sequence ASC",
    ).bind(runId)).all<ShadowGridEventRow>();
    if (!result.success) throw new Error(result.error ?? "D1 shadow-grid run read failed");
    return result.results.map(rowToEvent);
  }

  async listEpochEvents(limit = 500): Promise<readonly ShadowGridEvent[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Shadow-grid epoch limit must be between 1 and 500");
    }
    const result = await queryable(this.db.prepare(
      "SELECT * FROM shadow_grid_events WHERE event_type = 'EPOCH_STARTED' ORDER BY recorded_at DESC, event_id DESC LIMIT ?",
    ).bind(limit)).all<ShadowGridEventRow>();
    if (!result.success) throw new Error(result.error ?? "D1 shadow-grid epoch read failed");
    return result.results.map(rowToEvent);
  }

  async listTerminalEvents(limit = 500): Promise<readonly ShadowGridEvent[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Shadow-grid terminal limit must be between 1 and 500");
    }
    const result = await queryable(this.db.prepare([
      "SELECT * FROM shadow_grid_events",
      "WHERE event_type IN ('REFUSED', 'CLOSED', 'VOID_SOURCE_GAP', 'RISK_EXIT')",
      "ORDER BY recorded_at DESC, event_id DESC LIMIT ?",
    ].join(" ")).bind(limit)).all<ShadowGridEventRow>();
    if (!result.success) throw new Error(result.error ?? "D1 shadow-grid terminal read failed");
    return result.results.map(rowToEvent);
  }

  private async getByIdempotencyKey(idempotencyKey: string): Promise<ShadowGridEvent | null> {
    const row = await this.db.prepare("SELECT * FROM shadow_grid_events WHERE idempotency_key = ?")
      .bind(idempotencyKey).first<ShadowGridEventRow>();
    return row ? rowToEvent(row) : null;
  }

  private matchReplay(existing: ShadowGridEvent, input: AppendShadowGridEvent): {
    event: ShadowGridEvent;
    replayed: true;
  } {
    if (
      existing.eventId !== input.eventId ||
      existing.runId !== input.runId ||
      existing.eventSequence !== input.eventSequence ||
      existing.eventType !== input.eventType ||
      existing.previousEventHash !== input.previousEventHash ||
      existing.eventHash !== input.eventHash ||
      existing.eventJson !== input.eventJson
    ) {
      throw new ShadowGridEventIdempotencyConflict();
    }
    return { event: existing, replayed: true };
  }
}
