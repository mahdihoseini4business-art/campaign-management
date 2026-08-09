-- Account details required when a refund is marked completed
ALTER TABLE refunds
  ADD COLUMN IF NOT EXISTS account_info TEXT NOT NULL DEFAULT '';
