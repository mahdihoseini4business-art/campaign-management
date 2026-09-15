-- Fix dm-voice-ring: senders must JOIN the peer's ring topic to broadcast.
-- Supabase Realtime requires SELECT (subscribe) before send(); owner-only SELECT
-- caused CHANNEL_ERROR on sendRing while inbox (own topic) still worked.

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

-- INSERT policy unchanged: any authenticated user with a phone may ring a topic.
-- App only opens the inbox listener on the current user's own ring channel.

NOTIFY pgrst, 'reload schema';
