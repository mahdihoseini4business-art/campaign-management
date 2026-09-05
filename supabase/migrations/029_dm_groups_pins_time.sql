-- Groups, pins, membership, daily chat-time tracking for DM chat.

-- 1) Extend conversations for groups
ALTER TABLE dm_conversations
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'dm',
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS created_by_phone TEXT;

ALTER TABLE dm_conversations
  DROP CONSTRAINT IF EXISTS dm_conversations_phone_order;

ALTER TABLE dm_conversations
  ALTER COLUMN phone_a DROP NOT NULL,
  ALTER COLUMN phone_b DROP NOT NULL;

ALTER TABLE dm_conversations
  DROP CONSTRAINT IF EXISTS dm_conversations_kind_check;

ALTER TABLE dm_conversations
  ADD CONSTRAINT dm_conversations_kind_check CHECK (
    (kind = 'dm' AND phone_a IS NOT NULL AND phone_b IS NOT NULL AND phone_a < phone_b)
    OR (kind = 'group' AND title IS NOT NULL AND length(trim(title)) > 0)
  );

UPDATE dm_conversations
SET kind = 'dm'
WHERE kind IS NULL OR kind = '';

-- 2) Members
CREATE TABLE IF NOT EXISTS dm_members (
  conversation_id BIGINT NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE,
  user_phone TEXT NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (conversation_id, user_phone)
);

CREATE INDEX IF NOT EXISTS idx_dm_members_user
  ON dm_members (user_phone);

INSERT INTO dm_members (conversation_id, user_phone)
SELECT id, phone_a FROM dm_conversations
WHERE kind = 'dm' AND phone_a IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO dm_members (conversation_id, user_phone)
SELECT id, phone_b FROM dm_conversations
WHERE kind = 'dm' AND phone_b IS NOT NULL
ON CONFLICT DO NOTHING;

-- 3) Pins
CREATE TABLE IF NOT EXISTS dm_pins (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'global')),
  user_phone TEXT,
  pinned_by_phone TEXT,
  pinned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT dm_pins_scope_user CHECK (
    (scope = 'personal' AND user_phone IS NOT NULL)
    OR (scope = 'global' AND user_phone IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_pins_personal_unique
  ON dm_pins (conversation_id, user_phone)
  WHERE scope = 'personal';

CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_pins_global_unique
  ON dm_pins (conversation_id)
  WHERE scope = 'global';

CREATE INDEX IF NOT EXISTS idx_dm_pins_user
  ON dm_pins (user_phone)
  WHERE scope = 'personal';

-- 4) Daily presence / chat time
CREATE TABLE IF NOT EXISTS dm_chat_time_daily (
  day DATE NOT NULL,
  user_phone TEXT NOT NULL,
  conversation_id BIGINT NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE,
  seconds INT NOT NULL DEFAULT 0 CHECK (seconds >= 0),
  PRIMARY KEY (day, user_phone, conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_dm_chat_time_daily_user_day
  ON dm_chat_time_daily (user_phone, day);

CREATE INDEX IF NOT EXISTS idx_dm_chat_time_daily_day
  ON dm_chat_time_daily (day);

CREATE OR REPLACE FUNCTION public.dm_add_chat_seconds(
  p_day DATE,
  p_user_phone TEXT,
  p_conversation_id BIGINT,
  p_seconds INT DEFAULT 15
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_seconds IS NULL OR p_seconds <= 0 THEN
    RETURN;
  END IF;
  INSERT INTO public.dm_chat_time_daily (day, user_phone, conversation_id, seconds)
  VALUES (p_day, p_user_phone, p_conversation_id, p_seconds)
  ON CONFLICT (day, user_phone, conversation_id)
  DO UPDATE SET seconds = public.dm_chat_time_daily.seconds + EXCLUDED.seconds;
END;
$$;

GRANT EXECUTE ON FUNCTION public.dm_add_chat_seconds(DATE, TEXT, BIGINT, INT) TO anon, authenticated;

-- RLS (open, app-layer auth — same pattern as notifications)
ALTER TABLE dm_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE dm_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE dm_chat_time_daily ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_dm_members_all" ON dm_members;
CREATE POLICY "anon_dm_members_all" ON dm_members
  FOR ALL TO anon, authenticated
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_dm_pins_all" ON dm_pins;
CREATE POLICY "anon_dm_pins_all" ON dm_pins
  FOR ALL TO anon, authenticated
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_dm_chat_time_daily_all" ON dm_chat_time_daily;
CREATE POLICY "anon_dm_chat_time_daily_all" ON dm_chat_time_daily
  FOR ALL TO anon, authenticated
  USING (true) WITH CHECK (true);

-- Realtime
ALTER TABLE IF EXISTS dm_members REPLICA IDENTITY FULL;
ALTER TABLE IF EXISTS dm_pins REPLICA IDENTITY FULL;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE dm_members;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE dm_pins;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

-- Deletion log extension
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
    WHEN 'dm_members' THEN
      rid := OLD.conversation_id::text || chr(0) || OLD.user_phone;
    WHEN 'dm_pins' THEN
      rid := OLD.id::text;
    WHEN 'dm_chat_time_daily' THEN
      rid := OLD.day::text || chr(0) || OLD.user_phone || chr(0) || OLD.conversation_id::text;
    ELSE
      RETURN OLD;
  END CASE;

  INSERT INTO deletion_log (table_name, record_id, deleted_at)
  VALUES (TG_TABLE_NAME, rid, NOW());

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS dm_members_log_deletion ON dm_members;
CREATE TRIGGER dm_members_log_deletion
  AFTER DELETE ON dm_members
  FOR EACH ROW EXECUTE FUNCTION public.log_deletion_for_backup();

DROP TRIGGER IF EXISTS dm_pins_log_deletion ON dm_pins;
CREATE TRIGGER dm_pins_log_deletion
  AFTER DELETE ON dm_pins
  FOR EACH ROW EXECUTE FUNCTION public.log_deletion_for_backup();

DROP TRIGGER IF EXISTS dm_chat_time_daily_log_deletion ON dm_chat_time_daily;
CREATE TRIGGER dm_chat_time_daily_log_deletion
  AFTER DELETE ON dm_chat_time_daily
  FOR EACH ROW EXECUTE FUNCTION public.log_deletion_for_backup();
