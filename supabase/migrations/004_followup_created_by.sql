-- Track who logged each followup (for 30-day activity / ownership rules)
ALTER TABLE IF EXISTS followups
  ADD COLUMN IF NOT EXISTS created_by_phone TEXT;

CREATE INDEX IF NOT EXISTS idx_followups_created_by_phone
  ON followups (created_by_phone);
