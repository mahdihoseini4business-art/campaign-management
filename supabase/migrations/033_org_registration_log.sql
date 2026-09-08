-- Phase 3: rate-limit log for self-serve org registration

CREATE TABLE IF NOT EXISTS public.org_registration_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone TEXT NOT NULL,
  tenant_id UUID REFERENCES public.tenants(id) ON DELETE SET NULL,
  org_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS org_registration_log_phone_created_idx
  ON public.org_registration_log (phone, created_at DESC);

ALTER TABLE public.org_registration_log ENABLE ROW LEVEL SECURITY;

-- No client policies: service role / Edge only
DROP POLICY IF EXISTS org_registration_log_deny ON public.org_registration_log;
