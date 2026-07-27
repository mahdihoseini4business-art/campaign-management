-- Ensure customers have a creation timestamp for L (length of relationship)
ALTER TABLE customers ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

UPDATE customers
SET created_at = NOW()
WHERE created_at IS NULL;
