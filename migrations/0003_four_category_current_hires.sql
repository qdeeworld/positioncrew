CREATE TABLE fresh_marketplace_hires_next (
  hire_id TEXT PRIMARY KEY NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  provider_slug TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  benchmark_slug TEXT NOT NULL,
  service TEXT NOT NULL,
  evidence_mode TEXT NOT NULL CHECK (evidence_mode IN ('HISTORICAL_FIXTURE', 'CURRENT_BLOCK_PINNED')),
  direct_cost_usd TEXT NOT NULL CHECK (direct_cost_usd = '0.00'),
  wallet_required INTEGER NOT NULL CHECK (wallet_required = 0),
  request_json TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 71 AND substr(request_hash, 1, 7) = 'sha256:'),
  provider_hash TEXT CHECK (provider_hash IS NULL OR (length(provider_hash) = 71 AND substr(provider_hash, 1, 7) = 'sha256:')),
  evidence_json TEXT,
  evidence_hash TEXT CHECK (evidence_hash IS NULL OR (length(evidence_hash) = 71 AND substr(evidence_hash, 1, 7) = 'sha256:')),
  created_at TEXT NOT NULL,
  CHECK ((provider_hash IS NULL AND evidence_json IS NULL AND evidence_hash IS NULL) OR (provider_hash IS NOT NULL AND evidence_json IS NOT NULL AND evidence_hash IS NOT NULL)),
  CHECK (
    (
      evidence_mode = 'HISTORICAL_FIXTURE' AND (
        (benchmark_slug = 'lending-rescue' AND provider_slug = 'lending-rescue' AND service = 'LENDING_RESCUE') OR
        (benchmark_slug = 'lp-rebalance' AND provider_slug = 'lp-rebalance' AND service = 'LP_REBALANCE') OR
        (benchmark_slug = 'bounded-grid' AND provider_slug = 'bounded-grid' AND service = 'BOUNDED_GRID')
      )
    ) OR (
      evidence_mode = 'CURRENT_BLOCK_PINNED' AND (
        (benchmark_slug = 'lending-rescue' AND provider_slug = 'lending-rescue' AND service = 'LENDING_RESCUE') OR
        (benchmark_slug = 'lp-rebalance' AND provider_slug = 'lp-rebalance' AND service = 'LP_REBALANCE') OR
        (benchmark_slug = 'yield-optimization' AND provider_slug = 'yield-optimization' AND service = 'YIELD_OPTIMIZATION') OR
        (benchmark_slug = 'bounded-grid' AND provider_slug = 'bounded-grid' AND service = 'BOUNDED_GRID')
      )
    )
  )
) STRICT;

CREATE TABLE fresh_marketplace_jobs_next (
  job_id TEXT PRIMARY KEY NOT NULL,
  hire_id TEXT NOT NULL UNIQUE REFERENCES fresh_marketplace_hires_next(hire_id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('CREATED', 'RUNNING', 'COMPLETED', 'FAILED')),
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  api_duration_milliseconds INTEGER CHECK (api_duration_milliseconds IS NULL OR api_duration_milliseconds > 0),
  error_code TEXT,
  error_message TEXT
) STRICT;

CREATE TABLE fresh_marketplace_receipts_next (
  receipt_id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL UNIQUE REFERENCES fresh_marketplace_jobs_next(job_id) ON DELETE RESTRICT,
  hire_id TEXT NOT NULL UNIQUE REFERENCES fresh_marketplace_hires_next(hire_id) ON DELETE RESTRICT,
  response_json TEXT NOT NULL,
  response_hash TEXT NOT NULL CHECK (length(response_hash) = 71 AND substr(response_hash, 1, 7) = 'sha256:'),
  deliverable_hash TEXT NOT NULL CHECK (length(deliverable_hash) = 71 AND substr(deliverable_hash, 1, 7) = 'sha256:'),
  evaluation_hash TEXT NOT NULL CHECK (length(evaluation_hash) = 71 AND substr(evaluation_hash, 1, 7) = 'sha256:'),
  created_at TEXT NOT NULL
) STRICT;

INSERT INTO fresh_marketplace_hires_next (
  hire_id, idempotency_key, provider_slug, provider_id, benchmark_slug, service,
  evidence_mode, direct_cost_usd, wallet_required, request_json, request_hash,
  provider_hash, evidence_json, evidence_hash, created_at
)
SELECT
  hire_id, idempotency_key, provider_slug, provider_id, benchmark_slug, service,
  evidence_mode, direct_cost_usd, wallet_required, request_json, request_hash,
  provider_hash, evidence_json, evidence_hash, created_at
FROM fresh_marketplace_hires;

INSERT INTO fresh_marketplace_jobs_next
SELECT * FROM fresh_marketplace_jobs;

INSERT INTO fresh_marketplace_receipts_next
SELECT * FROM fresh_marketplace_receipts;

DROP TABLE fresh_marketplace_receipts;
DROP TABLE fresh_marketplace_jobs;
DROP TABLE fresh_marketplace_hires;

ALTER TABLE fresh_marketplace_hires_next RENAME TO fresh_marketplace_hires;
ALTER TABLE fresh_marketplace_jobs_next RENAME TO fresh_marketplace_jobs;
ALTER TABLE fresh_marketplace_receipts_next RENAME TO fresh_marketplace_receipts;
