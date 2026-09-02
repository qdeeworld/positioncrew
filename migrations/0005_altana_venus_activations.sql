CREATE TABLE altana_venus_activations (
  activation_id TEXT PRIMARY KEY NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  source_hire_id TEXT NOT NULL,
  source_receipt_id TEXT NOT NULL UNIQUE,
  client_key_hash TEXT NOT NULL,
  day_bucket TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('CREATED', 'RUNNING', 'CONFIRMED', 'COMPLETED', 'FAILED')),
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  receipt_id TEXT UNIQUE,
  receipt_json TEXT,
  receipt_hash TEXT,
  error_code TEXT,
  error_message TEXT,
  confirmed_receipt_id TEXT,
  confirmed_receipt_json TEXT,
  confirmed_receipt_hash TEXT,
  UNIQUE (client_key_hash, day_bucket)
);

CREATE INDEX altana_venus_activations_day_state_idx
  ON altana_venus_activations (day_bucket, state);
