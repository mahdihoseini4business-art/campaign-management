-- Phase 3: scope group/DM uniqueness per tenant (not global).
-- Drops legacy global UNIQUE constraints from 014 / 028 and replaces with (tenant_id, …).

-- ---------------------------------------------------------------------------
-- groups: UNIQUE (tenant_id, name)
-- ---------------------------------------------------------------------------
ALTER TABLE public.groups DROP CONSTRAINT IF EXISTS groups_name_unique;

-- Deduplicate same-name rows within one tenant (keep oldest by created_at/id)
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT tenant_id, name, (array_agg(id ORDER BY created_at ASC NULLS LAST, id ASC))[1] AS keep_id
    FROM public.groups
    GROUP BY tenant_id, name
    HAVING COUNT(*) > 1
  LOOP
    -- Move members of duplicate groups onto the kept group, then delete extras
    UPDATE public.group_members gm
    SET group_id = r.keep_id
    WHERE gm.group_id IN (
      SELECT g.id FROM public.groups g
      WHERE g.tenant_id = r.tenant_id AND g.name = r.name AND g.id <> r.keep_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.group_members existing
      WHERE existing.group_id = r.keep_id AND existing.user_phone = gm.user_phone
    );

    DELETE FROM public.group_members
    WHERE group_id IN (
      SELECT g.id FROM public.groups g
      WHERE g.tenant_id = r.tenant_id AND g.name = r.name AND g.id <> r.keep_id
    );

    DELETE FROM public.groups
    WHERE tenant_id = r.tenant_id AND name = r.name AND id <> r.keep_id;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS groups_tenant_name_uidx
  ON public.groups (tenant_id, name);

-- ---------------------------------------------------------------------------
-- group_members: one group membership per phone per tenant
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS public.group_members_user_phone_unique;

-- Align member tenant_id with parent group (repair drift)
UPDATE public.group_members gm
SET tenant_id = g.tenant_id
FROM public.groups g
WHERE gm.group_id = g.id
  AND gm.tenant_id IS DISTINCT FROM g.tenant_id;

-- If same phone appears twice in one tenant (different groups), keep manager row
-- then earliest group membership.
DO $$
DECLARE
  r RECORD;
  keep_group UUID;
BEGIN
  FOR r IN
    SELECT tenant_id, user_phone
    FROM public.group_members
    GROUP BY tenant_id, user_phone
    HAVING COUNT(*) > 1
  LOOP
    SELECT gm.group_id INTO keep_group
    FROM public.group_members gm
    WHERE gm.tenant_id = r.tenant_id AND gm.user_phone = r.user_phone
    ORDER BY gm.is_manager DESC, gm.group_id ASC
    LIMIT 1;

    DELETE FROM public.group_members
    WHERE tenant_id = r.tenant_id
      AND user_phone = r.user_phone
      AND group_id <> keep_group;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS group_members_tenant_user_phone_uidx
  ON public.group_members (tenant_id, user_phone);

-- ---------------------------------------------------------------------------
-- dm_conversations: UNIQUE (tenant_id, phone_a, phone_b)
-- ---------------------------------------------------------------------------
ALTER TABLE public.dm_conversations DROP CONSTRAINT IF EXISTS dm_conversations_unique;

DO $$
DECLARE
  r RECORD;
  keep_id BIGINT;
BEGIN
  FOR r IN
    SELECT tenant_id, phone_a, phone_b
    FROM public.dm_conversations
    GROUP BY tenant_id, phone_a, phone_b
    HAVING COUNT(*) > 1
  LOOP
    SELECT id INTO keep_id
    FROM public.dm_conversations
    WHERE tenant_id = r.tenant_id
      AND phone_a = r.phone_a
      AND phone_b = r.phone_b
    ORDER BY created_at ASC NULLS LAST, id ASC
    LIMIT 1;

    -- Remap dependent rows of duplicate conversations onto keep_id
    UPDATE public.dm_messages SET conversation_id = keep_id
    WHERE conversation_id IN (
      SELECT id FROM public.dm_conversations
      WHERE tenant_id = r.tenant_id AND phone_a = r.phone_a AND phone_b = r.phone_b AND id <> keep_id
    );

    UPDATE public.dm_reads AS dr
    SET conversation_id = keep_id
    WHERE dr.conversation_id IN (
      SELECT id FROM public.dm_conversations
      WHERE tenant_id = r.tenant_id AND phone_a = r.phone_a AND phone_b = r.phone_b AND id <> keep_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.dm_reads AS existing
      WHERE existing.conversation_id = keep_id AND existing.user_phone = dr.user_phone
    );

    DELETE FROM public.dm_reads
    WHERE conversation_id IN (
      SELECT id FROM public.dm_conversations
      WHERE tenant_id = r.tenant_id AND phone_a = r.phone_a AND phone_b = r.phone_b AND id <> keep_id
    );

    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'dm_members'
    ) THEN
      UPDATE public.dm_members AS dm
      SET conversation_id = keep_id
      WHERE dm.conversation_id IN (
        SELECT id FROM public.dm_conversations
        WHERE tenant_id = r.tenant_id AND phone_a = r.phone_a AND phone_b = r.phone_b AND id <> keep_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.dm_members AS existing
        WHERE existing.conversation_id = keep_id AND existing.user_phone = dm.user_phone
      );

      DELETE FROM public.dm_members
      WHERE conversation_id IN (
        SELECT id FROM public.dm_conversations
        WHERE tenant_id = r.tenant_id AND phone_a = r.phone_a AND phone_b = r.phone_b AND id <> keep_id
      );
    END IF;

    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'dm_pins'
    ) THEN
      DELETE FROM public.dm_pins
      WHERE conversation_id IN (
        SELECT id FROM public.dm_conversations
        WHERE tenant_id = r.tenant_id AND phone_a = r.phone_a AND phone_b = r.phone_b AND id <> keep_id
      );
    END IF;

    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'dm_chat_time_daily'
    ) THEN
      DELETE FROM public.dm_chat_time_daily
      WHERE conversation_id IN (
        SELECT id FROM public.dm_conversations
        WHERE tenant_id = r.tenant_id AND phone_a = r.phone_a AND phone_b = r.phone_b AND id <> keep_id
      );
    END IF;

    DELETE FROM public.dm_conversations
    WHERE tenant_id = r.tenant_id
      AND phone_a = r.phone_a
      AND phone_b = r.phone_b
      AND id <> keep_id;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS dm_conversations_tenant_phones_uidx
  ON public.dm_conversations (tenant_id, phone_a, phone_b);

NOTIFY pgrst, 'reload schema';
