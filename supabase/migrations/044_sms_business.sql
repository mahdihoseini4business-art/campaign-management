-- Business SMS: templates, logs, campaigns, schedules, usage + default feature flags

CREATE TABLE IF NOT EXISTS public.sms_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);

CREATE INDEX IF NOT EXISTS sms_templates_tenant_idx ON public.sms_templates (tenant_id);

CREATE TABLE IF NOT EXISTS public.sms_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  template_key TEXT,
  customer_id TEXT,
  to_phone TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sent', 'failed', 'skipped')),
  provider_ref TEXT,
  error TEXT,
  triggered_by TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sms_logs_tenant_created_idx ON public.sms_logs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sms_logs_tenant_kind_idx ON public.sms_logs (tenant_id, kind, created_at DESC);

CREATE TABLE IF NOT EXISTS public.sms_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  template_key TEXT,
  body TEXT,
  filter JSONB NOT NULL DEFAULT '{}'::jsonb,
  mode TEXT NOT NULL DEFAULT 'immediate'
    CHECK (mode IN ('immediate', 'scheduled', 'drip')),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sending', 'done', 'cancelled')),
  total INT NOT NULL DEFAULT 0,
  sent INT NOT NULL DEFAULT 0,
  failed INT NOT NULL DEFAULT 0,
  send_at TIMESTAMPTZ,
  drip_interval_min INT NOT NULL DEFAULT 5,
  drip_batch_size INT NOT NULL DEFAULT 20,
  next_batch_at TIMESTAMPTZ,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sms_campaigns_tenant_idx ON public.sms_campaigns (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.sms_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  customer_id TEXT,
  campaign_id UUID REFERENCES public.sms_campaigns(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'followup_schedule',
  template_key TEXT,
  body_override TEXT,
  send_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'cancelled', 'failed')),
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sms_schedules_due_idx
  ON public.sms_schedules (status, send_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS sms_schedules_tenant_idx ON public.sms_schedules (tenant_id, send_at);

CREATE TABLE IF NOT EXISTS public.sms_usage_daily (
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  sent_count INT NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day)
);

-- Default org feature flags for every tenant (idempotent upsert per tenant)
INSERT INTO public.app_settings (tenant_id, key, value)
SELECT t.id, 'sms_features', '{
  "shipment_queued": true,
  "shipment_shipped": true,
  "sales_single": true,
  "sales_group_debtors": true,
  "customer_single": true,
  "customer_campaign": true,
  "followup_on_schedule": true,
  "followup_bulk": true,
  "templates_edit": true,
  "history_view": true
}'::jsonb
FROM public.tenants t
ON CONFLICT (tenant_id, key) DO NOTHING;

INSERT INTO public.app_settings (tenant_id, key, value)
SELECT t.id, 'sms_followup_default_hour', '10'::jsonb
FROM public.tenants t
ON CONFLICT (tenant_id, key) DO NOTHING;

-- Seed default templates per tenant
INSERT INTO public.sms_templates (tenant_id, key, name, body, enabled)
SELECT t.id, v.key, v.name, v.body, true
FROM public.tenants t
CROSS JOIN (VALUES
  (
    'shipment_queued',
    'ورود به صف ارسال',
    'سلام {customer_name} عزیز، سفارش «{product_name}» شما در صف ارسال آکادمی کارنو قرار گرفت.'
  ),
  (
    'shipment_shipped',
    'تأیید ارسال و رهگیری',
    'سلام {customer_name} عزیز، سفارش «{product_name}» ارسال شد. کد رهگیری: {tracking_code}'
  ),
  (
    'sale_balance',
    'مانده حساب',
    'سلام {customer_name} عزیز، مانده حساب شما بابت «{product_name}»: {balance} ریال.'
  ),
  (
    'customer_campaign',
    'کمپین مشتریان',
    'سلام {customer_name} عزیز، {org_name}'
  ),
  (
    'followup_due',
    'اطلاع موعد پیگیری',
    'سلام {customer_name} عزیز، کارشناس ما ({advisor}) در تاریخ {followup_date} با شما تماس خواهد گرفت.'
  ),
  (
    'followup_bulk',
    'پیام دسته‌ای فالوآپ',
    'سلام {customer_name} عزیز، زمان ارتباط کارشناس با شما: {followup_date}.'
  )
) AS v(key, name, body)
ON CONFLICT (tenant_id, key) DO NOTHING;

ALTER TABLE public.sms_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_usage_daily ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sms_templates_member_all ON public.sms_templates;
CREATE POLICY sms_templates_member_all ON public.sms_templates
  FOR ALL TO authenticated
  USING (public.is_tenant_member(tenant_id) OR public.is_platform_admin())
  WITH CHECK (
    (tenant_id = public.current_tenant_id() AND public.is_tenant_member(tenant_id))
    OR public.is_platform_admin()
  );

DROP POLICY IF EXISTS sms_logs_member_select ON public.sms_logs;
CREATE POLICY sms_logs_member_select ON public.sms_logs
  FOR SELECT TO authenticated
  USING (public.is_tenant_member(tenant_id) OR public.is_platform_admin());

DROP POLICY IF EXISTS sms_campaigns_member_all ON public.sms_campaigns;
CREATE POLICY sms_campaigns_member_all ON public.sms_campaigns
  FOR ALL TO authenticated
  USING (public.is_tenant_member(tenant_id) OR public.is_platform_admin())
  WITH CHECK (
    (tenant_id = public.current_tenant_id() AND public.is_tenant_member(tenant_id))
    OR public.is_platform_admin()
  );

DROP POLICY IF EXISTS sms_schedules_member_all ON public.sms_schedules;
CREATE POLICY sms_schedules_member_all ON public.sms_schedules
  FOR ALL TO authenticated
  USING (public.is_tenant_member(tenant_id) OR public.is_platform_admin())
  WITH CHECK (
    (tenant_id = public.current_tenant_id() AND public.is_tenant_member(tenant_id))
    OR public.is_platform_admin()
  );

DROP POLICY IF EXISTS sms_usage_daily_member_select ON public.sms_usage_daily;
CREATE POLICY sms_usage_daily_member_select ON public.sms_usage_daily
  FOR SELECT TO authenticated
  USING (public.is_tenant_member(tenant_id) OR public.is_platform_admin());

NOTIFY pgrst, 'reload schema';
