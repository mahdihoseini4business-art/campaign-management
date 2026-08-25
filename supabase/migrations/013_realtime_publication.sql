-- Enable Supabase Realtime (postgres_changes) for live data sync.
-- IMPORTANT: apply this migration on the remote Supabase project
-- (CLI `db push` / SQL Editor). Without it, the SPA may subscribe
-- successfully but never receive table change events.

ALTER TABLE IF EXISTS customers REPLICA IDENTITY FULL;
ALTER TABLE IF EXISTS followups REPLICA IDENTITY FULL;
ALTER TABLE IF EXISTS notifications REPLICA IDENTITY FULL;
ALTER TABLE IF EXISTS notification_reads REPLICA IDENTITY FULL;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE customers;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE followups;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE notifications;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE notification_reads;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;
