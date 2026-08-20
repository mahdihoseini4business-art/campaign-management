-- Configurable customer business codes (کد مشتری)
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS customer_code text DEFAULT '';
