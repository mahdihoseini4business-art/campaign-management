-- Incremental sync watermarks (reduce repeated full-table egress)

ALTER TABLE IF EXISTS customers
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE IF EXISTS followups
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE IF EXISTS ownership_transfers
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE IF EXISTS ownership_transfer_acks
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Refunds already has updated_at; ensure trigger keeps it fresh on UPDATE

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS customers_set_updated_at ON customers;
CREATE TRIGGER customers_set_updated_at
  BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS followups_set_updated_at ON followups;
CREATE TRIGGER followups_set_updated_at
  BEFORE UPDATE ON followups
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS ownership_transfers_set_updated_at ON ownership_transfers;
CREATE TRIGGER ownership_transfers_set_updated_at
  BEFORE UPDATE ON ownership_transfers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS ownership_transfer_acks_set_updated_at ON ownership_transfer_acks;
CREATE TRIGGER ownership_transfer_acks_set_updated_at
  BEFORE UPDATE ON ownership_transfer_acks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS refunds_set_updated_at ON refunds;
CREATE TRIGGER refunds_set_updated_at
  BEFORE UPDATE ON refunds
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS idx_customers_updated_at ON customers (updated_at);
CREATE INDEX IF NOT EXISTS idx_followups_updated_at ON followups (updated_at);
CREATE INDEX IF NOT EXISTS idx_ownership_transfers_updated_at ON ownership_transfers (updated_at);
CREATE INDEX IF NOT EXISTS idx_ownership_transfer_acks_updated_at ON ownership_transfer_acks (updated_at);
CREATE INDEX IF NOT EXISTS idx_refunds_updated_at ON refunds (updated_at);
