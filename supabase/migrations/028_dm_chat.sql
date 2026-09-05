-- Private 1:1 chat (DM) between users. Access control is app-layer
-- (same pattern as notifications): open RLS for anon/authenticated.

CREATE TABLE IF NOT EXISTS dm_conversations (
  id BIGSERIAL PRIMARY KEY,
  phone_a TEXT NOT NULL,
  phone_b TEXT NOT NULL,
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT dm_conversations_phone_order CHECK (phone_a < phone_b),
  CONSTRAINT dm_conversations_unique UNIQUE (phone_a, phone_b)
);

CREATE INDEX IF NOT EXISTS idx_dm_conversations_phone_a
  ON dm_conversations (phone_a);

CREATE INDEX IF NOT EXISTS idx_dm_conversations_phone_b
  ON dm_conversations (phone_b);

CREATE INDEX IF NOT EXISTS idx_dm_conversations_last_message
  ON dm_conversations (last_message_at DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS dm_messages (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE,
  sender_phone TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dm_messages_conversation_created
  ON dm_messages (conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_dm_messages_conversation_id
  ON dm_messages (conversation_id, id);

CREATE TABLE IF NOT EXISTS dm_reads (
  conversation_id BIGINT NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE,
  user_phone TEXT NOT NULL,
  last_read_message_id BIGINT,
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (conversation_id, user_phone)
);

CREATE INDEX IF NOT EXISTS idx_dm_reads_user
  ON dm_reads (user_phone);

CREATE OR REPLACE FUNCTION public.dm_touch_conversation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.dm_conversations
  SET last_message_at = NEW.created_at
  WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS dm_messages_touch_conversation ON dm_messages;
CREATE TRIGGER dm_messages_touch_conversation
  AFTER INSERT ON dm_messages
  FOR EACH ROW EXECUTE FUNCTION public.dm_touch_conversation();

ALTER TABLE dm_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE dm_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE dm_reads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_dm_conversations_all" ON dm_conversations;
CREATE POLICY "anon_dm_conversations_all" ON dm_conversations
  FOR ALL TO anon, authenticated
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_dm_messages_all" ON dm_messages;
CREATE POLICY "anon_dm_messages_all" ON dm_messages
  FOR ALL TO anon, authenticated
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_dm_reads_all" ON dm_reads;
CREATE POLICY "anon_dm_reads_all" ON dm_reads
  FOR ALL TO anon, authenticated
  USING (true) WITH CHECK (true);

-- Realtime (postgres_changes)
ALTER TABLE IF EXISTS dm_conversations REPLICA IDENTITY FULL;
ALTER TABLE IF EXISTS dm_messages REPLICA IDENTITY FULL;
ALTER TABLE IF EXISTS dm_reads REPLICA IDENTITY FULL;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE dm_conversations;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE dm_messages;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE dm_reads;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

-- Deletion log for backup merge (extend existing function)
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
    WHEN 'dm_conversations' THEN
      rid := OLD.id::text;
    WHEN 'dm_messages' THEN
      rid := OLD.id::text;
    WHEN 'dm_reads' THEN
      rid := OLD.conversation_id::text || chr(0) || OLD.user_phone;
    ELSE
      RETURN OLD;
  END CASE;

  INSERT INTO deletion_log (table_name, record_id, deleted_at)
  VALUES (TG_TABLE_NAME, rid, NOW());

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS dm_conversations_log_deletion ON dm_conversations;
CREATE TRIGGER dm_conversations_log_deletion
  AFTER DELETE ON dm_conversations
  FOR EACH ROW EXECUTE FUNCTION public.log_deletion_for_backup();

DROP TRIGGER IF EXISTS dm_messages_log_deletion ON dm_messages;
CREATE TRIGGER dm_messages_log_deletion
  AFTER DELETE ON dm_messages
  FOR EACH ROW EXECUTE FUNCTION public.log_deletion_for_backup();

DROP TRIGGER IF EXISTS dm_reads_log_deletion ON dm_reads;
CREATE TRIGGER dm_reads_log_deletion
  AFTER DELETE ON dm_reads
  FOR EACH ROW EXECUTE FUNCTION public.log_deletion_for_backup();
