-- Follow-up assignment (ارجاع پیگیری): assignee queue independent of customer.next_followup_date
ALTER TABLE IF EXISTS followups
  ADD COLUMN IF NOT EXISTS assigned_to_phone TEXT,
  ADD COLUMN IF NOT EXISTS assigned_by_phone TEXT,
  ADD COLUMN IF NOT EXISTS assigned_at TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_followups_assigned_to_phone
  ON followups (assigned_to_phone)
  WHERE assigned_to_phone IS NOT NULL;
