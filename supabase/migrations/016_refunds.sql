-- Refund requests kanban (عودت وجه)

CREATE TABLE IF NOT EXISTS refunds (
  id BIGSERIAL PRIMARY KEY,
  customer_id TEXT NOT NULL,
  product_index INTEGER NOT NULL DEFAULT 0,
  product_name TEXT NOT NULL DEFAULT '',
  payment_id TEXT NOT NULL,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  is_full_payment BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'awaiting', 'completed', 'rejected')),
  note TEXT NOT NULL DEFAULT '',
  reject_reason TEXT NOT NULL DEFAULT '',
  advisor_phone TEXT,
  customer_name TEXT NOT NULL DEFAULT '',
  created_by_phone TEXT,
  created_by_name TEXT,
  updated_by_phone TEXT,
  completed_by_phone TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refunds_status ON refunds (status);
CREATE INDEX IF NOT EXISTS idx_refunds_customer ON refunds (customer_id);
CREATE INDEX IF NOT EXISTS idx_refunds_payment ON refunds (payment_id);
CREATE INDEX IF NOT EXISTS idx_refunds_completed_at ON refunds (completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_refunds_advisor ON refunds (advisor_phone);

ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_refunds_all" ON refunds;
CREATE POLICY "anon_refunds_all" ON refunds
  FOR ALL TO anon, authenticated
  USING (true) WITH CHECK (true);

ALTER TABLE IF EXISTS refunds REPLICA IDENTITY FULL;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE refunds;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;
