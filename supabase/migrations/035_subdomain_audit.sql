-- Phase 5: custom subdomain + audit log + host resolve

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS subdomain TEXT,
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS tenants_subdomain_uidx
  ON public.tenants (lower(subdomain))
  WHERE subdomain IS NOT NULL AND subdomain <> '';

CREATE TABLE IF NOT EXISTS public.audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES public.tenants(id) ON DELETE SET NULL,
  actor_username TEXT,
  actor_auth_user_id UUID,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_tenant_created_idx
  ON public.audit_log (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_action_created_idx
  ON public.audit_log (action, created_at DESC);

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_log_select ON public.audit_log;
CREATE POLICY audit_log_select ON public.audit_log
  FOR SELECT TO authenticated
  USING (
    public.is_platform_admin()
    OR (tenant_id IS NOT NULL AND public.is_tenant_owner(tenant_id))
  );

-- Inserts via service role / SECURITY DEFINER only
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

-- Resolve tenant by exact subdomain label (e.g. "acme" from acme.carno.ir)
-- Only returns tenants that currently have diamond (or trial with feature) entitlement via active-ish sub.
CREATE OR REPLACE FUNCTION public.resolve_tenant_by_subdomain(p_subdomain TEXT)
RETURNS TABLE (
  id UUID,
  name TEXT,
  slug TEXT,
  subdomain TEXT,
  status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  label TEXT := lower(trim(p_subdomain));
BEGIN
  IF label IS NULL OR label = '' OR label ~ '[^a-z0-9-]' OR length(label) < 2 THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT t.id, t.name, t.slug, t.subdomain, t.status
  FROM public.tenants t
  JOIN public.subscriptions s ON s.tenant_id = t.id
  JOIN public.plans p ON p.id = s.plan_id
  WHERE t.archived_at IS NULL
    AND t.status = 'active'
    AND lower(t.subdomain) = label
    AND s.status IN ('trialing', 'active', 'grace')
    AND COALESCE((p.features->>'custom_subdomain')::boolean, false) = true
  LIMIT 1;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_tenant_by_subdomain(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_tenant_by_subdomain(TEXT) TO anon, authenticated, service_role;

INSERT INTO public.platform_settings (key, value) VALUES
  ('root_domain', '"carno.ir"'::jsonb),
  ('subdomain_min_length', '3'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Ensure public knobs include root_domain even if 032 already applied
DROP POLICY IF EXISTS platform_settings_read_public_keys ON public.platform_settings;
CREATE POLICY platform_settings_read_public_keys ON public.platform_settings
  FOR SELECT TO authenticated
  USING (
    key IN (
      'grace_days',
      'trial_days',
      'sms_daily_limit_trial',
      'sms_daily_limit_gold',
      'sms_daily_limit_diamond',
      'root_domain',
      'subdomain_min_length'
    )
  );

NOTIFY pgrst, 'reload schema';
