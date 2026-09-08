-- Phase 4: billing payments / invoices + plan prices

ALTER TABLE public.plans
  ADD COLUMN IF NOT EXISTS price_monthly_irr BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS price_yearly_irr BIGINT NOT NULL DEFAULT 0;

UPDATE public.plans SET
  price_monthly_irr = 990000,
  price_yearly_irr = 9900000
WHERE id = 'gold';

UPDATE public.plans SET
  price_monthly_irr = 1990000,
  price_yearly_irr = 19900000
WHERE id = 'diamond';

UPDATE public.plans SET
  price_monthly_irr = 0,
  price_yearly_irr = 0
WHERE id = 'trial';

CREATE TABLE IF NOT EXISTS public.billing_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  invoice_id UUID,
  plan_id TEXT NOT NULL REFERENCES public.plans(id),
  period TEXT NOT NULL CHECK (period IN ('monthly', 'yearly')),
  amount_irr BIGINT NOT NULL CHECK (amount_irr >= 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'failed', 'cancelled', 'manual')),
  authority TEXT UNIQUE,
  ref_id TEXT,
  gateway TEXT NOT NULL DEFAULT 'zarinpal',
  created_by_username TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS billing_payments_tenant_idx ON public.billing_payments (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS billing_payments_status_idx ON public.billing_payments (status);

CREATE TABLE IF NOT EXISTS public.billing_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  payment_id UUID REFERENCES public.billing_payments(id) ON DELETE SET NULL,
  number TEXT NOT NULL,
  plan_id TEXT,
  period TEXT,
  amount_irr BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'issued'
    CHECK (status IN ('issued', 'paid', 'void')),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS billing_invoices_number_uidx ON public.billing_invoices (number);
CREATE INDEX IF NOT EXISTS billing_invoices_tenant_idx ON public.billing_invoices (tenant_id, issued_at DESC);

-- Link payment → invoice after invoice create
ALTER TABLE public.billing_payments
  DROP CONSTRAINT IF EXISTS billing_payments_invoice_id_fkey;
ALTER TABLE public.billing_payments
  ADD CONSTRAINT billing_payments_invoice_id_fkey
  FOREIGN KEY (invoice_id) REFERENCES public.billing_invoices(id) ON DELETE SET NULL;

INSERT INTO public.platform_settings (key, value) VALUES
  ('billing_default_period_days_monthly', '30'::jsonb),
  ('billing_default_period_days_yearly', '365'::jsonb)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE public.billing_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_invoices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS billing_payments_select ON public.billing_payments;
CREATE POLICY billing_payments_select ON public.billing_payments
  FOR SELECT TO authenticated
  USING (public.is_tenant_member(tenant_id) OR public.is_platform_admin());

DROP POLICY IF EXISTS billing_invoices_select ON public.billing_invoices;
CREATE POLICY billing_invoices_select ON public.billing_invoices
  FOR SELECT TO authenticated
  USING (public.is_tenant_member(tenant_id) OR public.is_platform_admin());

-- Writes only via service role (Edge)
DROP POLICY IF EXISTS billing_payments_platform_write ON public.billing_payments;
CREATE POLICY billing_payments_platform_write ON public.billing_payments
  FOR ALL TO authenticated
  USING (public.is_platform_admin())
  WITH CHECK (public.is_platform_admin());

DROP POLICY IF EXISTS billing_invoices_platform_write ON public.billing_invoices;
CREATE POLICY billing_invoices_platform_write ON public.billing_invoices
  FOR ALL TO authenticated
  USING (public.is_platform_admin())
  WITH CHECK (public.is_platform_admin());

NOTIFY pgrst, 'reload schema';
