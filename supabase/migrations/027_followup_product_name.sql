-- Product context for follow-up notes (which product the customer is being followed up for)
ALTER TABLE IF EXISTS followups
  ADD COLUMN IF NOT EXISTS product_name TEXT NOT NULL DEFAULT '';
