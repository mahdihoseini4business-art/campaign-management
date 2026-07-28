-- Customer loyalty levels + optional referrer for CIP auto-count
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS customer_level text DEFAULT '',
  ADD COLUMN IF NOT EXISTS customer_level_locked boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS referred_by_phone text DEFAULT '';
