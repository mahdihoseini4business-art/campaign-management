-- Phase 1: multi-tenant foundation + Auth-ready RLS
-- Default tenant gets all existing rows; OTP→Auth JWT required for client access.

-- ---------------------------------------------------------------------------
-- Helpers: updated_at
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Core tenancy tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'pending')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS tenants_set_updated_at ON public.tenants;
CREATE TRIGGER tenants_set_updated_at
  BEFORE UPDATE ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.plans (
  id TEXT PRIMARY KEY,
  name_fa TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  features JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.plans (id, name_fa, sort_order, features) VALUES
  ('trial', 'آزمایشی', 0, '{"dm_chat":true,"products_matrix":true,"refunds":true,"shipments":true,"custom_subdomain":false}'::jsonb),
  ('gold', 'طلایی', 1, '{"dm_chat":false,"products_matrix":false,"refunds":false,"shipments":false,"custom_subdomain":false}'::jsonb),
  ('diamond', 'الماسی', 2, '{"dm_chat":true,"products_matrix":true,"refunds":true,"shipments":true,"custom_subdomain":true}'::jsonb)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL UNIQUE REFERENCES public.tenants(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES public.plans(id),
  status TEXT NOT NULL DEFAULT 'trialing'
    CHECK (status IN ('trialing', 'active', 'grace', 'readonly', 'suspended')),
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at TIMESTAMPTZ,
  trial_ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS subscriptions_set_updated_at ON public.subscriptions;
CREATE TRIGGER subscriptions_set_updated_at
  BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.tenant_members (
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user'
    CHECK (role IN ('owner', 'user')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, username)
);

CREATE INDEX IF NOT EXISTS tenant_members_username_idx ON public.tenant_members (username);

CREATE TABLE IF NOT EXISTS public.platform_admins (
  phone TEXT PRIMARY KEY,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.platform_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT 'null'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.platform_settings (key, value) VALUES
  ('grace_days', '3'::jsonb),
  ('trial_days', '7'::jsonb),
  ('sms_daily_limit_trial', '20'::jsonb),
  ('sms_daily_limit_gold', '50'::jsonb),
  ('sms_daily_limit_diamond', '200'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Current tenant for JWT subject (set via RPC after login / switch)
CREATE TABLE IF NOT EXISTS public.auth_context (
  auth_user_id UUID PRIMARY KEY,
  current_tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- users.auth_user_id bridge
-- ---------------------------------------------------------------------------
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS auth_user_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS users_auth_user_id_uidx
  ON public.users (auth_user_id)
  WHERE auth_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS users_phone_idx ON public.users (phone);

-- ---------------------------------------------------------------------------
-- Default tenant + backfill memberships / subscriptions
-- ---------------------------------------------------------------------------
INSERT INTO public.tenants (id, name, slug, status)
SELECT
  '00000000-0000-4000-8000-000000000001'::uuid,
  'سازمان اصلی',
  'default',
  'active'
WHERE NOT EXISTS (SELECT 1 FROM public.tenants WHERE slug = 'default');

INSERT INTO public.subscriptions (tenant_id, plan_id, status, trial_ends_at, ends_at)
SELECT
  t.id,
  'diamond',
  'active',
  NULL,
  NULL
FROM public.tenants t
WHERE t.slug = 'default'
  AND NOT EXISTS (SELECT 1 FROM public.subscriptions s WHERE s.tenant_id = t.id);

INSERT INTO public.tenant_members (tenant_id, username, role)
SELECT
  t.id,
  u.username,
  CASE
    WHEN lower(coalesce(u.role, '')) = 'admin' OR u.username = 'admin' THEN 'owner'
    ELSE 'user'
  END
FROM public.users u
CROSS JOIN public.tenants t
WHERE t.slug = 'default'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Add tenant_id to business tables
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  default_tenant UUID;
  tbl TEXT;
BEGIN
  SELECT id INTO default_tenant FROM public.tenants WHERE slug = 'default' LIMIT 1;

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
      EXECUTE format(
        'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id)',
        tbl
      );
      EXECUTE format(
        'UPDATE public.%I SET tenant_id = $1 WHERE tenant_id IS NULL',
        tbl
      ) USING default_tenant;
      EXECUTE format(
        'ALTER TABLE public.%I ALTER COLUMN tenant_id SET NOT NULL',
        tbl
      );
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS %I ON public.%I (tenant_id)',
        tbl || '_tenant_id_idx',
        tbl
      );
    END IF;
  END LOOP;
END $$;

-- app_settings: unique per tenant+key (drop old unique on key if present)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'app_settings'
  ) THEN
    -- Drop common unique constraints on key alone
    ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_pkey;
    ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_key_key;
    -- Ensure composite identity
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_schema = 'public'
        AND table_name = 'app_settings'
        AND constraint_name = 'app_settings_tenant_key_pkey'
    ) THEN
      BEGIN
        ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_tenant_key_pkey PRIMARY KEY (tenant_id, key);
      EXCEPTION WHEN others THEN
        CREATE UNIQUE INDEX IF NOT EXISTS app_settings_tenant_key_uidx
          ON public.app_settings (tenant_id, key);
      END;
    END IF;
  END IF;
END $$;

-- Strip SMS password from client-readable settings (Edge uses SMS_* env)
UPDATE public.app_settings
SET value = COALESCE(value, '{}'::jsonb) - 'password'
WHERE key = 'sms_panel';

-- ---------------------------------------------------------------------------
-- Tenant context helpers (must exist before INSERT trigger)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.current_tenant_id
  FROM public.auth_context c
  WHERE c.auth_user_id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION public.current_username()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT u.username
  FROM public.users u
  WHERE u.auth_user_id = auth.uid()
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.is_platform_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.platform_admins pa ON pa.phone = u.phone
    WHERE u.auth_user_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION public.is_tenant_member(p_tenant_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.tenant_members tm
    JOIN public.users u ON u.username = tm.username
    WHERE tm.tenant_id = p_tenant_id
      AND u.auth_user_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION public.is_tenant_owner(p_tenant_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.tenant_members tm
    JOIN public.users u ON u.username = tm.username
    WHERE tm.tenant_id = p_tenant_id
      AND u.auth_user_id = auth.uid()
      AND tm.role = 'owner'
  );
$$;

CREATE OR REPLACE FUNCTION public.same_tenant(p_tenant_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_tenant_id IS NOT NULL
    AND p_tenant_id = public.current_tenant_id()
    AND public.is_tenant_member(p_tenant_id);
$$;

CREATE OR REPLACE FUNCTION public.tg_set_tenant_id()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tid UUID;
BEGIN
  IF NEW.tenant_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  tid := public.current_tenant_id();
  IF tid IS NULL THEN
    RAISE EXCEPTION 'tenant context is not set';
  END IF;
  NEW.tenant_id := tid;
  RETURN NEW;
END;
$$;

-- Attach BEFORE INSERT triggers
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
      EXECUTE format('DROP TRIGGER IF EXISTS trg_set_tenant_id ON public.%I', tbl);
      EXECUTE format(
        'CREATE TRIGGER trg_set_tenant_id BEFORE INSERT ON public.%I
         FOR EACH ROW EXECUTE FUNCTION public.tg_set_tenant_id()',
        tbl
      );
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_current_tenant(p_tenant_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF NOT public.is_tenant_member(p_tenant_id) AND NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'not a member of tenant';
  END IF;
  INSERT INTO public.auth_context (auth_user_id, current_tenant_id, updated_at)
  VALUES (auth.uid(), p_tenant_id, now())
  ON CONFLICT (auth_user_id) DO UPDATE
    SET current_tenant_id = EXCLUDED.current_tenant_id,
        updated_at = now();
  RETURN p_tenant_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_my_tenants()
RETURNS TABLE (
  id UUID,
  name TEXT,
  slug TEXT,
  status TEXT,
  member_role TEXT,
  plan_id TEXT,
  subscription_status TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    t.id,
    t.name,
    t.slug,
    t.status,
    tm.role AS member_role,
    s.plan_id,
    s.status AS subscription_status
  FROM public.tenant_members tm
  JOIN public.tenants t ON t.id = tm.tenant_id
  JOIN public.users u ON u.username = tm.username
  LEFT JOIN public.subscriptions s ON s.tenant_id = t.id
  WHERE u.auth_user_id = auth.uid()
  ORDER BY t.created_at ASC;
$$;

REVOKE ALL ON FUNCTION public.set_current_tenant(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_my_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_current_tenant(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_my_tenants() TO authenticated;

-- ---------------------------------------------------------------------------
-- RLS: drop open anon policies and apply tenant-scoped policies
-- ---------------------------------------------------------------------------
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_context ENABLE ROW LEVEL SECURITY;

-- auth_context: users manage own row only via RPC (no direct client writes needed)
DROP POLICY IF EXISTS auth_context_select_own ON public.auth_context;
CREATE POLICY auth_context_select_own ON public.auth_context
  FOR SELECT TO authenticated
  USING (auth_user_id = auth.uid());

-- plans: readable by authenticated
DROP POLICY IF EXISTS plans_read ON public.plans;
CREATE POLICY plans_read ON public.plans
  FOR SELECT TO authenticated
  USING (true);

-- tenants
DROP POLICY IF EXISTS tenants_select_member ON public.tenants;
CREATE POLICY tenants_select_member ON public.tenants
  FOR SELECT TO authenticated
  USING (public.is_tenant_member(id) OR public.is_platform_admin());

DROP POLICY IF EXISTS tenants_update_platform ON public.tenants;
CREATE POLICY tenants_update_platform ON public.tenants
  FOR ALL TO authenticated
  USING (public.is_platform_admin())
  WITH CHECK (public.is_platform_admin());

-- subscriptions
DROP POLICY IF EXISTS subscriptions_select ON public.subscriptions;
CREATE POLICY subscriptions_select ON public.subscriptions
  FOR SELECT TO authenticated
  USING (public.is_tenant_member(tenant_id) OR public.is_platform_admin());

DROP POLICY IF EXISTS subscriptions_platform_write ON public.subscriptions;
CREATE POLICY subscriptions_platform_write ON public.subscriptions
  FOR ALL TO authenticated
  USING (public.is_platform_admin())
  WITH CHECK (public.is_platform_admin());

-- tenant_members
DROP POLICY IF EXISTS tenant_members_select ON public.tenant_members;
CREATE POLICY tenant_members_select ON public.tenant_members
  FOR SELECT TO authenticated
  USING (public.is_tenant_member(tenant_id) OR public.is_platform_admin());

DROP POLICY IF EXISTS tenant_members_owner_write ON public.tenant_members;
CREATE POLICY tenant_members_owner_write ON public.tenant_members
  FOR ALL TO authenticated
  USING (public.is_tenant_owner(tenant_id) OR public.is_platform_admin())
  WITH CHECK (public.is_tenant_owner(tenant_id) OR public.is_platform_admin());

-- platform_admins / settings: platform only
DROP POLICY IF EXISTS platform_admins_platform ON public.platform_admins;
CREATE POLICY platform_admins_platform ON public.platform_admins
  FOR ALL TO authenticated
  USING (public.is_platform_admin())
  WITH CHECK (public.is_platform_admin());

DROP POLICY IF EXISTS platform_settings_platform ON public.platform_settings;
CREATE POLICY platform_settings_platform ON public.platform_settings
  FOR ALL TO authenticated
  USING (public.is_platform_admin())
  WITH CHECK (public.is_platform_admin());

-- Helper to recreate tenant-scoped policy on a table
-- users: special (no tenant_id column)
DROP POLICY IF EXISTS anon_users_all ON public.users;
DROP POLICY IF EXISTS users_select_tenant ON public.users;
CREATE POLICY users_select_tenant ON public.users
  FOR SELECT TO authenticated
  USING (
    auth_user_id = auth.uid()
    OR public.is_platform_admin()
    OR EXISTS (
      SELECT 1
      FROM public.tenant_members tm
      WHERE tm.tenant_id = public.current_tenant_id()
        AND tm.username = users.username
    )
  );

DROP POLICY IF EXISTS users_write_owner ON public.users;
CREATE POLICY users_write_owner ON public.users
  FOR ALL TO authenticated
  USING (
    public.is_platform_admin()
    OR public.is_tenant_owner(public.current_tenant_id())
    OR auth_user_id = auth.uid()
  )
  WITH CHECK (
    public.is_platform_admin()
    OR public.is_tenant_owner(public.current_tenant_id())
    OR auth_user_id = auth.uid()
  );

-- Generic tenant tables
DO $$
DECLARE
  tbl TEXT;
  pol TEXT;
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
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);

      -- Drop legacy open policies (common names)
      FOREACH pol IN ARRAY ARRAY[
        'anon_' || tbl || '_all',
        'anon_' || replace(tbl, 'ownership_', 'ownership_') || '_all'
      ]
      LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol, tbl);
      END LOOP;

      -- Explicit known policy names
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'anon_' || tbl || '_all', tbl);
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_all ON public.%I', tbl);

      EXECUTE format(
        'CREATE POLICY tenant_isolation_all ON public.%I
           FOR ALL TO authenticated
           USING (public.same_tenant(tenant_id) OR public.is_platform_admin())
           WITH CHECK (
             (tenant_id = public.current_tenant_id() AND public.is_tenant_member(tenant_id))
             OR public.is_platform_admin()
           )',
        tbl
      );
    END IF;
  END LOOP;
END $$;

-- Drop any remaining known open policies by exact name from older migrations
DROP POLICY IF EXISTS anon_ownership_transfers_all ON public.ownership_transfers;
DROP POLICY IF EXISTS anon_ownership_transfer_acks_all ON public.ownership_transfer_acks;
DROP POLICY IF EXISTS anon_notifications_all ON public.notifications;
DROP POLICY IF EXISTS anon_notification_reads_all ON public.notification_reads;
DROP POLICY IF EXISTS anon_groups_all ON public.groups;
DROP POLICY IF EXISTS anon_group_members_all ON public.group_members;
DROP POLICY IF EXISTS anon_refunds_all ON public.refunds;
DROP POLICY IF EXISTS anon_deletion_log_all ON public.deletion_log;
DROP POLICY IF EXISTS anon_dm_conversations_all ON public.dm_conversations;
DROP POLICY IF EXISTS anon_dm_messages_all ON public.dm_messages;
DROP POLICY IF EXISTS anon_dm_reads_all ON public.dm_reads;
DROP POLICY IF EXISTS anon_dm_members_all ON public.dm_members;
DROP POLICY IF EXISTS anon_dm_pins_all ON public.dm_pins;
DROP POLICY IF EXISTS anon_dm_chat_time_daily_all ON public.dm_chat_time_daily;
DROP POLICY IF EXISTS anon_customers_all ON public.customers;
DROP POLICY IF EXISTS anon_followups_all ON public.followups;
DROP POLICY IF EXISTS anon_app_settings_all ON public.app_settings;

-- otp_sessions stays locked (no client policies)
ALTER TABLE IF EXISTS public.otp_sessions ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
