-- Unlimited daily SMS: 0 = no cap (send-sms treats dayLimit > 0 as cap, else unlimited).
-- 031 seeded 20/50/200 and its ON CONFLICT DO NOTHING never updates existing rows,
-- so this migration updates live servers idempotently.
UPDATE public.platform_settings
SET value = '0'::jsonb, updated_at = now()
WHERE key IN ('sms_daily_limit_trial', 'sms_daily_limit_gold', 'sms_daily_limit_diamond')
  AND value IS DISTINCT FROM '0'::jsonb;

INSERT INTO public.platform_settings (key, value) VALUES
  ('sms_daily_limit_trial', '0'::jsonb),
  ('sms_daily_limit_gold', '0'::jsonb),
  ('sms_daily_limit_diamond', '0'::jsonb)
ON CONFLICT (key) DO NOTHING;
