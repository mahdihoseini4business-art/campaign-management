-- Phase 4: harden write_audit_log — only member/owner of p_tenant_id (or platform admin).

CREATE OR REPLACE FUNCTION public.write_audit_log(
  p_tenant_id UUID,
  p_action TEXT,
  p_entity_type TEXT DEFAULT NULL,
  p_entity_id TEXT DEFAULT NULL,
  p_meta JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rid UUID;
  uname TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'tenant_id required';
  END IF;

  IF NOT public.is_platform_admin()
     AND NOT public.is_tenant_member(p_tenant_id) THEN
    RAISE EXCEPTION 'not a member of tenant';
  END IF;

  uname := public.current_username();
  INSERT INTO public.audit_log (
    tenant_id, actor_username, actor_auth_user_id, action, entity_type, entity_id, meta
  ) VALUES (
    p_tenant_id,
    uname,
    auth.uid(),
    p_action,
    p_entity_type,
    p_entity_id,
    COALESCE(p_meta, '{}'::jsonb)
  )
  RETURNING id INTO rid;
  RETURN rid;
END;
$$;

REVOKE ALL ON FUNCTION public.write_audit_log(UUID, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.write_audit_log(UUID, TEXT, TEXT, TEXT, JSONB) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
