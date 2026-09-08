-- Phase 2: allow authenticated tenants to read non-secret platform knobs.
-- Writes remain platform-admin only (existing policy).

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
