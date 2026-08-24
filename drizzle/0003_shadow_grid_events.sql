CREATE TABLE shadow_grid_events (
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
CREATE TRIGGER shadow_grid_events_no_update BEFORE UPDATE ON shadow_grid_events BEGIN
  SELECT RAISE(ABORT, 'shadow_grid_events is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER shadow_grid_events_no_delete BEFORE DELETE ON shadow_grid_events BEGIN
  SELECT RAISE(ABORT, 'shadow_grid_events is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER shadow_grid_events_validate_reference BEFORE INSERT ON shadow_grid_events BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM fresh_marketplace_hires h
    JOIN fresh_marketplace_jobs j ON j.hire_id = h.hire_id
    JOIN fresh_marketplace_receipts r ON r.job_id = j.job_id AND r.hire_id = h.hire_id
    WHERE h.hire_id = NEW.hire_id AND r.receipt_id = NEW.receipt_id
      AND h.benchmark_slug = 'bounded-grid' AND h.provider_slug = 'bounded-grid'
      AND h.service = 'BOUNDED_GRID' AND h.evidence_mode = 'CURRENT_BLOCK_PINNED'
      AND j.state = 'COMPLETED' AND h.request_hash = NEW.request_hash
      AND h.provider_hash = NEW.provider_hash AND h.evidence_hash = NEW.evidence_hash
      AND r.response_hash = NEW.response_hash AND r.deliverable_hash = NEW.deliverable_hash
      AND r.evaluation_hash = NEW.evaluation_hash
  ) THEN RAISE(ABORT, 'shadow grid event must reference an exact completed current bounded-grid receipt') END;
END;
--> statement-breakpoint
CREATE TRIGGER shadow_grid_events_validate_chain BEFORE INSERT ON shadow_grid_events BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM shadow_grid_events WHERE run_id = NEW.run_id)
    AND (NEW.event_sequence <> 0 OR NEW.event_type <> 'EPOCH_STARTED' OR NEW.previous_event_hash IS NOT NULL)
    THEN RAISE(ABORT, 'shadow grid run must begin with EPOCH_STARTED sequence 0') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM shadow_grid_events WHERE run_id = NEW.run_id)
    AND (NEW.event_sequence <> (SELECT event_sequence + 1 FROM shadow_grid_events WHERE run_id = NEW.run_id ORDER BY event_sequence DESC LIMIT 1)
      OR NEW.previous_event_hash IS NOT (SELECT event_hash FROM shadow_grid_events WHERE run_id = NEW.run_id ORDER BY event_sequence DESC LIMIT 1))
    THEN RAISE(ABORT, 'shadow grid event sequence or previous hash is invalid') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM shadow_grid_events WHERE run_id = NEW.run_id AND event_type IN ('REFUSED', 'CLOSED', 'VOID_SOURCE_GAP', 'RISK_EXIT'))
    THEN RAISE(ABORT, 'shadow grid run is already terminal') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM shadow_grid_events first_event WHERE first_event.run_id = NEW.run_id AND first_event.event_sequence = 0 AND (
      first_event.chain_id IS NOT NEW.chain_id OR first_event.market IS NOT NEW.market OR first_event.strategy_version IS NOT NEW.strategy_version OR
      first_event.fill_model IS NOT NEW.fill_model OR first_event.epoch_started_at IS NOT NEW.epoch_started_at OR first_event.horizon_ends_at IS NOT NEW.horizon_ends_at OR
      first_event.hire_id IS NOT NEW.hire_id OR first_event.receipt_id IS NOT NEW.receipt_id OR first_event.request_hash IS NOT NEW.request_hash OR
      first_event.provider_hash IS NOT NEW.provider_hash OR first_event.evidence_hash IS NOT NEW.evidence_hash OR first_event.response_hash IS NOT NEW.response_hash OR
      first_event.deliverable_hash IS NOT NEW.deliverable_hash OR first_event.evaluation_hash IS NOT NEW.evaluation_hash
    )
  ) THEN RAISE(ABORT, 'shadow grid run invariants cannot change') END;
END;
--> statement-breakpoint
CREATE TRIGGER shadow_grid_events_validate_transition BEFORE INSERT ON shadow_grid_events
WHEN EXISTS (SELECT 1 FROM shadow_grid_events WHERE run_id = NEW.run_id) BEGIN
  SELECT CASE WHEN NOT (
    ((SELECT event_type FROM shadow_grid_events WHERE run_id = NEW.run_id ORDER BY event_sequence DESC LIMIT 1) = 'EPOCH_STARTED' AND NEW.event_type = 'PRECOMMITTED') OR
    ((SELECT event_type FROM shadow_grid_events WHERE run_id = NEW.run_id ORDER BY event_sequence DESC LIMIT 1) = 'PRECOMMITTED' AND NEW.event_type IN ('REFUSED', 'OBSERVED', 'VOID_SOURCE_GAP')) OR
    ((SELECT event_type FROM shadow_grid_events WHERE run_id = NEW.run_id ORDER BY event_sequence DESC LIMIT 1) IN ('OBSERVED', 'SHADOW_FILL') AND NEW.event_type IN ('OBSERVED', 'SHADOW_FILL', 'CLOSED', 'VOID_SOURCE_GAP', 'RISK_EXIT'))
  ) THEN RAISE(ABORT, 'invalid shadow grid lifecycle transition') END;
END;
--> statement-breakpoint
CREATE UNIQUE INDEX shadow_grid_events_epoch_unique ON shadow_grid_events (chain_id, market, strategy_version, epoch_started_at) WHERE event_type = 'EPOCH_STARTED';
--> statement-breakpoint
CREATE UNIQUE INDEX shadow_grid_events_receipt_run_unique ON shadow_grid_events (receipt_id) WHERE event_type = 'EPOCH_STARTED';
--> statement-breakpoint
CREATE INDEX shadow_grid_events_terminal_time_idx ON shadow_grid_events (recorded_at DESC, event_id DESC) WHERE event_type IN ('REFUSED', 'CLOSED', 'VOID_SOURCE_GAP', 'RISK_EXIT');
