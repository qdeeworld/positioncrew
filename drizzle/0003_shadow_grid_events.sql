CREATE TABLE IF NOT EXISTS shadow_grid_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  event_sequence INTEGER NOT NULL CHECK (event_sequence >= 0),
  event_type TEXT NOT NULL CHECK (event_type IN ('EPOCH_STARTED', 'PRECOMMITTED', 'REFUSED', 'OBSERVED', 'SHADOW_FILL', 'CLOSED', 'VOID_SOURCE_GAP', 'RISK_EXIT')),
  chain_id INTEGER NOT NULL CHECK (chain_id = 56),
  market TEXT NOT NULL CHECK (market = 'WBNB/USDT'),
  strategy_version TEXT NOT NULL CHECK (strategy_version = 'positioncrew:bounded-grid-forward-shadow:v1'),
  fill_model TEXT NOT NULL CHECK (fill_model = 'CONSERVATIVE_SAMPLED_CROSSING_V1'),
  epoch_started_at TEXT NOT NULL,
  horizon_ends_at TEXT NOT NULL,
  hire_id TEXT NOT NULL REFERENCES fresh_marketplace_hires(hire_id) ON DELETE RESTRICT,
  receipt_id TEXT NOT NULL REFERENCES fresh_marketplace_receipts(receipt_id) ON DELETE RESTRICT,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 71 AND substr(request_hash, 1, 7) = 'sha256:'),
  provider_hash TEXT NOT NULL CHECK (length(provider_hash) = 71 AND substr(provider_hash, 1, 7) = 'sha256:'),
  evidence_hash TEXT NOT NULL CHECK (length(evidence_hash) = 71 AND substr(evidence_hash, 1, 7) = 'sha256:'),
  response_hash TEXT NOT NULL CHECK (length(response_hash) = 71 AND substr(response_hash, 1, 7) = 'sha256:'),
  deliverable_hash TEXT NOT NULL CHECK (length(deliverable_hash) = 71 AND substr(deliverable_hash, 1, 7) = 'sha256:'),
  evaluation_hash TEXT NOT NULL CHECK (length(evaluation_hash) = 71 AND substr(evaluation_hash, 1, 7) = 'sha256:'),
  event_json TEXT NOT NULL,
  previous_event_hash TEXT CHECK (previous_event_hash IS NULL OR (length(previous_event_hash) = 71 AND substr(previous_event_hash, 1, 7) = 'sha256:')),
  event_hash TEXT NOT NULL UNIQUE CHECK (length(event_hash) = 71 AND substr(event_hash, 1, 7) = 'sha256:'),
  recorded_at TEXT NOT NULL,
  UNIQUE (run_id, event_sequence),
  CHECK ((event_sequence = 0 AND previous_event_hash IS NULL) OR (event_sequence > 0 AND previous_event_hash IS NOT NULL))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS shadow_grid_events_epoch_unique ON shadow_grid_events (chain_id, market, strategy_version, epoch_started_at) WHERE event_type = 'EPOCH_STARTED';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS shadow_grid_events_receipt_run_unique ON shadow_grid_events (receipt_id) WHERE event_type = 'EPOCH_STARTED';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS shadow_grid_events_terminal_time_idx ON shadow_grid_events (recorded_at DESC, event_id DESC) WHERE event_type IN ('REFUSED', 'CLOSED', 'VOID_SOURCE_GAP', 'RISK_EXIT');
