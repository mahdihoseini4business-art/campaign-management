-- Track row deletions for full backup / offline merge (deletions since last export).

CREATE TABLE IF NOT EXISTS deletion_log (
  id BIGSERIAL PRIMARY KEY,
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_by_phone TEXT
);

CREATE INDEX IF NOT EXISTS idx_deletion_log_table_name
  ON deletion_log (table_name);

CREATE INDEX IF NOT EXISTS idx_deletion_log_deleted_at
  ON deletion_log (deleted_at);

ALTER TABLE deletion_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_deletion_log_all" ON deletion_log;
CREATE POLICY "anon_deletion_log_all" ON deletion_log
  FOR ALL TO anon, authenticated
  USING (true) WITH CHECK (true);

-- Record primary/composite keys in the same encoding as src/backup/backup-tables.js recordKey().
CREATE OR REPLACE FUNCTION public.log_deletion_for_backup()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  rid TEXT;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'customers' THEN
      rid := OLD.id;
    WHEN 'followups' THEN
      rid := OLD.id::text;
    WHEN 'refunds' THEN
      rid := OLD.id::text;
    WHEN 'ownership_transfers' THEN
      rid := OLD.id::text;
    WHEN 'ownership_transfer_acks' THEN
      rid := OLD.id::text;
    WHEN 'users' THEN
      rid := OLD.username;
    WHEN 'groups' THEN
      rid := OLD.id::text;
    WHEN 'group_members' THEN
      rid := OLD.group_id::text || chr(0) || OLD.user_phone;
    WHEN 'app_settings' THEN
      rid := OLD.key;
    WHEN 'notifications' THEN
      rid := OLD.id::text;
    WHEN 'notification_reads' THEN
      rid := OLD.user_phone || chr(0) || OLD.notification_id::text;
    ELSE
      RETURN OLD;
  END CASE;

  INSERT INTO deletion_log (table_name, record_id, deleted_at)
  VALUES (TG_TABLE_NAME, rid, NOW());

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS customers_log_deletion ON customers;
CREATE TRIGGER customers_log_deletion
  AFTER DELETE ON customers
  FOR EACH ROW EXECUTE FUNCTION public.log_deletion_for_backup();

DROP TRIGGER IF EXISTS followups_log_deletion ON followups;
CREATE TRIGGER followups_log_deletion
  AFTER DELETE ON followups
  FOR EACH ROW EXECUTE FUNCTION public.log_deletion_for_backup();

DROP TRIGGER IF EXISTS refunds_log_deletion ON refunds;
CREATE TRIGGER refunds_log_deletion
  AFTER DELETE ON refunds
  FOR EACH ROW EXECUTE FUNCTION public.log_deletion_for_backup();

DROP TRIGGER IF EXISTS ownership_transfers_log_deletion ON ownership_transfers;
CREATE TRIGGER ownership_transfers_log_deletion
  AFTER DELETE ON ownership_transfers
  FOR EACH ROW EXECUTE FUNCTION public.log_deletion_for_backup();

DROP TRIGGER IF EXISTS ownership_transfer_acks_log_deletion ON ownership_transfer_acks;
CREATE TRIGGER ownership_transfer_acks_log_deletion
  AFTER DELETE ON ownership_transfer_acks
  FOR EACH ROW EXECUTE FUNCTION public.log_deletion_for_backup();

DROP TRIGGER IF EXISTS users_log_deletion ON users;
CREATE TRIGGER users_log_deletion
  AFTER DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION public.log_deletion_for_backup();

DROP TRIGGER IF EXISTS groups_log_deletion ON groups;
CREATE TRIGGER groups_log_deletion
  AFTER DELETE ON groups
  FOR EACH ROW EXECUTE FUNCTION public.log_deletion_for_backup();

DROP TRIGGER IF EXISTS group_members_log_deletion ON group_members;
CREATE TRIGGER group_members_log_deletion
  AFTER DELETE ON group_members
  FOR EACH ROW EXECUTE FUNCTION public.log_deletion_for_backup();

DROP TRIGGER IF EXISTS app_settings_log_deletion ON app_settings;
CREATE TRIGGER app_settings_log_deletion
  AFTER DELETE ON app_settings
  FOR EACH ROW EXECUTE FUNCTION public.log_deletion_for_backup();

DROP TRIGGER IF EXISTS notifications_log_deletion ON notifications;
CREATE TRIGGER notifications_log_deletion
  AFTER DELETE ON notifications
  FOR EACH ROW EXECUTE FUNCTION public.log_deletion_for_backup();

DROP TRIGGER IF EXISTS notification_reads_log_deletion ON notification_reads;
CREATE TRIGGER notification_reads_log_deletion
  AFTER DELETE ON notification_reads
  FOR EACH ROW EXECUTE FUNCTION public.log_deletion_for_backup();
