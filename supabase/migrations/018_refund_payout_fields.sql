-- Separate payout destination fields for completed refunds
ALTER TABLE refunds
  ADD COLUMN IF NOT EXISTS account_holder_name TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS sheba TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS card_number TEXT NOT NULL DEFAULT '';
