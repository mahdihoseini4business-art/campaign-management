-- Ops digests: kind + meta for morning advisor / evening manager notifications.
-- Enables idempotency per (tenant, kind, digest_date, recipient) in ops-digest-cron.

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS kind TEXT,
  ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.notifications.kind IS
  'manual | morning_advisor | evening_manager; NULL treated as manual for legacy rows';
COMMENT ON COLUMN public.notifications.meta IS
  'Optional JSON; digests store { "digest_date": "YYYY/MM/DD" } (Jalali Tehran)';

CREATE INDEX IF NOT EXISTS idx_notifications_tenant_kind_digest_date
  ON public.notifications (tenant_id, kind, ((meta ->> 'digest_date')))
  WHERE kind IS NOT NULL AND kind <> 'manual';

NOTIFY pgrst, 'reload schema';
