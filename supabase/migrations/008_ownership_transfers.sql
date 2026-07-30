-- Structured ownership transfer log for metrics (bulk & single reassignment).
-- Followups still carry a human-readable timeline note; this table is the source of truth for rates.

CREATE TABLE IF NOT EXISTS ownership_transfers (
  id BIGSERIAL PRIMARY KEY,
  customer_id TEXT NOT NULL,
  from_advisor_phone TEXT,
  from_advisor_name TEXT,
  to_advisor_phone TEXT,
  to_advisor_name TEXT,
  acted_by_phone TEXT,
  batch_id TEXT,
  reason TEXT,
  customer_status_at_transfer TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ownership_transfers_customer_id
  ON ownership_transfers (customer_id);
CREATE INDEX IF NOT EXISTS idx_ownership_transfers_created_at
  ON ownership_transfers (created_at);
CREATE INDEX IF NOT EXISTS idx_ownership_transfers_batch_id
  ON ownership_transfers (batch_id);
CREATE INDEX IF NOT EXISTS idx_ownership_transfers_from_phone
  ON ownership_transfers (from_advisor_phone);
CREATE INDEX IF NOT EXISTS idx_ownership_transfers_to_phone
  ON ownership_transfers (to_advisor_phone);

ALTER TABLE ownership_transfers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_ownership_transfers_all" ON ownership_transfers;
CREATE POLICY "anon_ownership_transfers_all" ON ownership_transfers
  FOR ALL TO anon, authenticated
  USING (true) WITH CHECK (true);
