CREATE TABLE buyer_venus_executions (
  source_receipt_id TEXT PRIMARY KEY NOT NULL REFERENCES fresh_marketplace_receipts(receipt_id) ON DELETE RESTRICT,
  row_version INTEGER NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  state_json TEXT NOT NULL CHECK (json_valid(state_json))
) STRICT;
