-- Enrich ownership_transfers with phone snapshot + per-user batch acknowledgements (inbox seen state).

ALTER TABLE ownership_transfers
  ADD COLUMN IF NOT EXISTS customer_phone TEXT;

CREATE TABLE IF NOT EXISTS ownership_transfer_acks (
  id BIGSERIAL PRIMARY KEY,
  user_phone TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_phone, batch_id)
);

CREATE INDEX IF NOT EXISTS idx_ownership_transfer_acks_user
  ON ownership_transfer_acks (user_phone);
CREATE INDEX IF NOT EXISTS idx_ownership_transfer_acks_batch
  ON ownership_transfer_acks (batch_id);

ALTER TABLE ownership_transfer_acks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_ownership_transfer_acks_all" ON ownership_transfer_acks;
CREATE POLICY "anon_ownership_transfer_acks_all" ON ownership_transfer_acks
  FOR ALL TO anon, authenticated
  USING (true) WITH CHECK (true);
