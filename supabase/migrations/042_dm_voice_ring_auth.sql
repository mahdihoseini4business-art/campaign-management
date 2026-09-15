-- DM walkie-talkie inbox: private Realtime topics `dm-voice-ring-{phone}`
-- so a logged-in user can receive a ring without being in that DM tab.

CREATE OR REPLACE FUNCTION public.dm_voice_ring_topic_phone()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN realtime.topic() ~ '^dm-voice-ring-[0-9]+$'
      THEN substring(realtime.topic() FROM 'dm-voice-ring-([0-9]+)')
    ELSE NULL
  END
$$;

-- Only authenticated users with a phone may join ring topics.
-- Note: Realtime requires SELECT (subscribe) before broadcast send, so senders
-- must be allowed to join the peer's topic. The client only attaches a listener
-- on the current user's own inbox channel (`startDmVoiceInbox`).
DROP POLICY IF EXISTS dm_voice_ring_broadcast_select ON realtime.messages;
CREATE POLICY dm_voice_ring_broadcast_select
ON realtime.messages
FOR SELECT
TO authenticated
USING (
  realtime.messages.extension = 'broadcast'
  AND public.dm_voice_ring_topic_phone() IS NOT NULL
  AND (SELECT public.current_user_phone()) IS NOT NULL
);

-- Authenticated users may send a ring to a peer topic (app only rings DM peers)
DROP POLICY IF EXISTS dm_voice_ring_broadcast_insert ON realtime.messages;
CREATE POLICY dm_voice_ring_broadcast_insert
ON realtime.messages
FOR INSERT
TO authenticated
WITH CHECK (
  realtime.messages.extension = 'broadcast'
  AND public.dm_voice_ring_topic_phone() IS NOT NULL
  AND (SELECT public.current_user_phone()) IS NOT NULL
);

NOTIFY pgrst, 'reload schema';
