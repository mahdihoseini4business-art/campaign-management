-- Fix statement timeouts when loading large customers/followups under RLS.
--
-- Symptom (PostgREST 500): canceling statement due to statement timeout
-- on pages like offset=9000&limit=1000 ORDER BY id.
--
-- Cause:
--   tenant_isolation_all used same_tenant(tenant_id) OR is_platform_admin().
--   Function-wrapped checks block index use on tenant_id, and platform admins
--   SELECT every tenant's rows in the CRM app.
--
-- Fix:
--   1) Index-friendly equality: tenant_id = (SELECT current_tenant_id())
--      (SELECT ...) forces a single initPlan evaluation per statement.
--   2) Composite (tenant_id, id) indexes for ORDER BY id paging.
--   3) No global SELECT bypass for platform admins — they already may
--      set_current_tenant() and are scoped to that tenant (Edge/platform
--      APIs use service_role when cross-tenant access is needed).

CREATE INDEX IF NOT EXISTS customers_tenant_id_id_idx
  ON public.customers (tenant_id, id);

CREATE INDEX IF NOT EXISTS followups_tenant_id_id_idx
  ON public.followups (tenant_id, id);

CREATE INDEX IF NOT EXISTS refunds_tenant_id_id_idx
  ON public.refunds (tenant_id, id);

CREATE INDEX IF NOT EXISTS ownership_transfers_tenant_id_id_idx
  ON public.ownership_transfers (tenant_id, id);

CREATE INDEX IF NOT EXISTS ownership_transfer_acks_tenant_id_id_idx
  ON public.ownership_transfer_acks (tenant_id, id);

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'customers',
    'followups',
    'app_settings',
    'ownership_transfers',
    'ownership_transfer_acks',
    'notifications',
    'notification_reads',
    'groups',
    'group_members',
    'refunds',
    'deletion_log',
    'dm_conversations',
    'dm_messages',
    'dm_reads',
    'dm_members',
    'dm_pins',
    'dm_chat_time_daily'
  ]
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = tbl
    ) THEN
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_all ON public.%I', tbl);
      EXECUTE format(
        'CREATE POLICY tenant_isolation_all ON public.%I
           FOR ALL TO authenticated
           USING (tenant_id = (SELECT public.current_tenant_id()))
           WITH CHECK (tenant_id = (SELECT public.current_tenant_id()))',
        tbl
      );
    END IF;
  END LOOP;
END $$;

-- Keep helper correct for any remaining callers; prefer equality in policies.
CREATE OR REPLACE FUNCTION public.same_tenant(p_tenant_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_tenant_id IS NOT NULL
    AND p_tenant_id = (SELECT public.current_tenant_id());
$$;

NOTIFY pgrst, 'reload schema';
