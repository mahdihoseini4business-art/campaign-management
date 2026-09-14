-- DM walkie-talkie: authorize private Realtime broadcast topics `dm-voice-{id}`
-- to conversation members only (authenticated JWT + dm_members / phone_a|phone_b).

CREATE OR REPLACE FUNCTION public.current_user_phone()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT u.phone
  FROM public.users u
  WHERE u.auth_user_id = auth.uid()
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.dm_voice_topic_conversation_id()
RETURNS BIGINT
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN realtime.topic() ~ '^dm-voice-[0-9]+$'
      THEN substring(realtime.topic() FROM 'dm-voice-([0-9]+)')::BIGINT
    ELSE NULL
  END
$$;

CREATE OR REPLACE FUNCTION public.is_dm_conversation_member(p_conversation_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    p_conversation_id IS NOT NULL
    AND (
      EXISTS (
        SELECT 1
        FROM public.dm_members m
        WHERE m.conversation_id = p_conversation_id
          AND m.user_phone = (SELECT public.current_user_phone())
          AND m.tenant_id = (SELECT public.current_tenant_id())
      )
      OR EXISTS (
        SELECT 1
        FROM public.dm_conversations c
        WHERE c.id = p_conversation_id
          AND c.tenant_id = (SELECT public.current_tenant_id())
          AND (
            c.phone_a = (SELECT public.current_user_phone())
            OR c.phone_b = (SELECT public.current_user_phone())
          )
      )
    )
$$;

-- Receive broadcasts on dm-voice-* only if member
DROP POLICY IF EXISTS dm_voice_broadcast_select ON realtime.messages;
CREATE POLICY dm_voice_broadcast_select
ON realtime.messages
FOR SELECT
TO authenticated
USING (
  realtime.messages.extension = 'broadcast'
  AND public.dm_voice_topic_conversation_id() IS NOT NULL
  AND public.is_dm_conversation_member(public.dm_voice_topic_conversation_id())
);

-- Send broadcasts on dm-voice-* only if member
DROP POLICY IF EXISTS dm_voice_broadcast_insert ON realtime.messages;
CREATE POLICY dm_voice_broadcast_insert
ON realtime.messages
FOR INSERT
TO authenticated
WITH CHECK (
  realtime.messages.extension = 'broadcast'
  AND public.dm_voice_topic_conversation_id() IS NOT NULL
  AND public.is_dm_conversation_member(public.dm_voice_topic_conversation_id())
);

NOTIFY pgrst, 'reload schema';

-- Full enforcement: Dashboard → Realtime → Settings → disable "Allow public access".
-- Until then, private:true + these policies still block unauthorized *private* joins;
-- also keep the client-side membership assert in src/dm-voice.js.
--
-- If you disable public access, also authorize existing app channels:
DROP POLICY IF EXISTS app_realtime_known_broadcast_select ON realtime.messages;
CREATE POLICY app_realtime_known_broadcast_select
ON realtime.messages
FOR SELECT
TO authenticated
USING (
  realtime.messages.extension = 'broadcast'
  AND realtime.topic() IN ('sale-live-toasts')
);

DROP POLICY IF EXISTS app_realtime_known_broadcast_insert ON realtime.messages;
CREATE POLICY app_realtime_known_broadcast_insert
ON realtime.messages
FOR INSERT
TO authenticated
WITH CHECK (
  realtime.messages.extension = 'broadcast'
  AND realtime.topic() IN ('sale-live-toasts')
);

DROP POLICY IF EXISTS app_realtime_known_postgres_select ON realtime.messages;
CREATE POLICY app_realtime_known_postgres_select
ON realtime.messages
FOR SELECT
TO authenticated
USING (
  realtime.messages.extension = 'postgres_changes'
  AND realtime.topic() IN ('live-data-sync', 'dm-chat-live')
);
