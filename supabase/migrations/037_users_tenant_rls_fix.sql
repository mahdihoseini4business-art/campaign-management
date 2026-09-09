-- Fix cross-tenant user directory leak.
--
-- Bug (031): policy users_write_owner was FOR ALL with
--   USING (is_tenant_owner(current_tenant_id()) OR ...)
-- Postgres ORs permissive policies, so any tenant owner could SELECT
-- every row in the global `users` table (no membership check).
-- Symptom: new signup org sees main-app users, and main org sees the new owner.
--
-- Fix: keep SELECT membership-scoped; split write policies so UPDATE/DELETE
-- only apply to usernames that are members of the current tenant.

DROP POLICY IF EXISTS users_write_owner ON public.users;
DROP POLICY IF EXISTS users_select_tenant ON public.users;
DROP POLICY IF EXISTS users_insert_owner ON public.users;
DROP POLICY IF EXISTS users_update_member ON public.users;
DROP POLICY IF EXISTS users_delete_member ON public.users;

CREATE POLICY users_select_tenant ON public.users
  FOR SELECT TO authenticated
  USING (
    auth_user_id = auth.uid()
    OR public.is_platform_admin()
    OR EXISTS (
      SELECT 1
      FROM public.tenant_members tm
      WHERE tm.tenant_id = (SELECT public.current_tenant_id())
        AND tm.username = users.username
    )
  );

-- Invite/create path: tenant owner (or self / platform) may insert rows.
-- Membership is attached separately (tenant_members / Edge invite).
CREATE POLICY users_insert_owner ON public.users
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_platform_admin()
    OR auth_user_id = auth.uid()
    OR public.is_tenant_owner((SELECT public.current_tenant_id()))
  );

CREATE POLICY users_update_member ON public.users
  FOR UPDATE TO authenticated
  USING (
    public.is_platform_admin()
    OR auth_user_id = auth.uid()
    OR (
      public.is_tenant_owner((SELECT public.current_tenant_id()))
      AND EXISTS (
        SELECT 1
        FROM public.tenant_members tm
        WHERE tm.tenant_id = (SELECT public.current_tenant_id())
          AND tm.username = users.username
      )
    )
  )
  WITH CHECK (
    public.is_platform_admin()
    OR auth_user_id = auth.uid()
    OR public.is_tenant_owner((SELECT public.current_tenant_id()))
  );

CREATE POLICY users_delete_member ON public.users
  FOR DELETE TO authenticated
  USING (
    public.is_platform_admin()
    OR (
      public.is_tenant_owner((SELECT public.current_tenant_id()))
      AND EXISTS (
        SELECT 1
        FROM public.tenant_members tm
        WHERE tm.tenant_id = (SELECT public.current_tenant_id())
          AND tm.username = users.username
      )
    )
  );

NOTIFY pgrst, 'reload schema';
