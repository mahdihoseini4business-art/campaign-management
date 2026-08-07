-- Multi-address support for physical product shipping (like phones)
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS addresses jsonb DEFAULT '[]'::jsonb;

UPDATE customers
SET addresses = '[]'::jsonb
WHERE addresses IS NULL
   OR addresses = 'null'::jsonb;
