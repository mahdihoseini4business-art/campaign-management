-- Optional auto-delete schedule for notifications.

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_notifications_expires_at
  ON notifications (expires_at)
  WHERE expires_at IS NOT NULL;
