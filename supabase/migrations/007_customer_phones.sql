-- Multi-phone support: up to 3 mobile numbers per customer
-- `phone` remains as the first number for backward compatibility
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS phones jsonb DEFAULT '[]'::jsonb;

-- Backfill existing single-phone records into phones[]
UPDATE customers
SET phones = CASE
  WHEN phone IS NOT NULL AND btrim(phone) <> '' THEN jsonb_build_array(btrim(phone))
  ELSE '[]'::jsonb
END
WHERE phones IS NULL
   OR phones = '[]'::jsonb
   OR phones = 'null'::jsonb;
