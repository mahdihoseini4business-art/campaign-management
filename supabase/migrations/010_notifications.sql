-- Manual admin notifications: broadcast message + per-user recipients + read state.

CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  message TEXT NOT NULL,
  recipient_phones JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by_phone TEXT,
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_created_at
  ON notifications (created_at DESC);

CREATE TABLE IF NOT EXISTS notification_reads (
  user_phone TEXT NOT NULL,
  notification_id BIGINT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_phone, notification_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_reads_user
  ON notification_reads (user_phone);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_reads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_notifications_all" ON notifications;
CREATE POLICY "anon_notifications_all" ON notifications
  FOR ALL TO anon, authenticated
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_notification_reads_all" ON notification_reads;
CREATE POLICY "anon_notification_reads_all" ON notification_reads
  FOR ALL TO anon, authenticated
  USING (true) WITH CHECK (true);
