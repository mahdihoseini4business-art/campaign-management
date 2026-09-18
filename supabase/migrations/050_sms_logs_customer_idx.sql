-- Index for the per-customer SMS tab (listCustomerSmsLogs / countCustomerSmsLogs):
-- tenant + customer + newest-first. Idempotent, safe to re-run.
CREATE INDEX IF NOT EXISTS sms_logs_tenant_customer_created_idx
  ON public.sms_logs (tenant_id, customer_id, created_at DESC);
