ALTER TABLE fresh_marketplace_jobs
  ADD COLUMN provider_selection_json TEXT;

ALTER TABLE fresh_marketplace_jobs
  ADD COLUMN provider_selection_hash TEXT
  CHECK (
    provider_selection_hash IS NULL OR
    (length(provider_selection_hash) = 71 AND substr(provider_selection_hash, 1, 7) = 'sha256:')
  );
