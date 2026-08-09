-- Soft-archive completed refunds so the kanban stays uncluttered

ALTER TABLE refunds
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_refunds_archived_at ON refunds (archived_at DESC NULLS LAST);
