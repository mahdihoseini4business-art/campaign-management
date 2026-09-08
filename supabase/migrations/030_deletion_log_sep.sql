-- Fix: Postgres TEXT cannot store chr(0). Composite deletion_log.record_id
-- previously used NUL as separator, so deletes on group_members (and other
-- composite-key tables) failed with "null character not permitted".
-- Use ASCII unit separator (chr(31)) instead — must match recordKey() in JS.

CREATE OR REPLACE FUNCTION public.log_deletion_for_backup()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  rid TEXT;
  sep TEXT := chr(31);
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
      rid := OLD.group_id::text || sep || OLD.user_phone;
    WHEN 'app_settings' THEN
      rid := OLD.key;
    WHEN 'notifications' THEN
      rid := OLD.id::text;
    WHEN 'notification_reads' THEN
      rid := OLD.user_phone || sep || OLD.notification_id::text;
    WHEN 'dm_conversations' THEN
      rid := OLD.id::text;
    WHEN 'dm_messages' THEN
      rid := OLD.id::text;
    WHEN 'dm_reads' THEN
      rid := OLD.conversation_id::text || sep || OLD.user_phone;
    WHEN 'dm_members' THEN
      rid := OLD.conversation_id::text || sep || OLD.user_phone;
    WHEN 'dm_pins' THEN
      rid := OLD.id::text;
    WHEN 'dm_chat_time_daily' THEN
      rid := OLD.day::text || sep || OLD.user_phone || sep || OLD.conversation_id::text;
    ELSE
      RETURN OLD;
  END CASE;

  INSERT INTO deletion_log (table_name, record_id, deleted_at)
  VALUES (TG_TABLE_NAME, rid, NOW());

  RETURN OLD;
END;
$$;
