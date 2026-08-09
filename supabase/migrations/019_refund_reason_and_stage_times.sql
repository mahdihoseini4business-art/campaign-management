-- Refund reason + timestamps for entering each kanban stage
ALTER TABLE refunds
  ADD COLUMN IF NOT EXISTS refund_reason TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS awaiting_at TIMESTAMPTZ;

UPDATE refunds
SET requested_at = COALESCE(requested_at, created_at)
WHERE requested_at IS NULL;

UPDATE refunds
SET completed_at = COALESCE(completed_at, updated_at)
WHERE status = 'completed' AND completed_at IS NULL;
