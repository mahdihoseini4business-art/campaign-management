-- SEC-M1 / SEC-M3: Enable RLS and lock down sensitive tables
-- Apply via Supabase SQL Editor or `supabase db push`
--
-- This app uses custom OTP login (not Supabase Auth JWTs). Business-data
-- policies stay open to the anon key so the SPA keeps working. otp_sessions
-- must never be readable/writable by anon — only Edge Functions with the
-- service role (which bypasses RLS) may access them.

-- 1) OTP sessions: remove permissive policies ⇒ deny all client access
ALTER TABLE IF EXISTS otp_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role can manage otp_sessions" ON otp_sessions;
DROP POLICY IF EXISTS "Users can read own OTP sessions" ON otp_sessions;

-- 2) Enable RLS on core tables
ALTER TABLE IF EXISTS users ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS followups ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS app_settings ENABLE ROW LEVEL SECURITY;

-- 3) SPA policies for custom OTP auth (tighten after migrating to Supabase Auth)
DROP POLICY IF EXISTS "anon_users_all" ON users;
CREATE POLICY "anon_users_all" ON users
  FOR ALL TO anon, authenticated
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_customers_all" ON customers;
CREATE POLICY "anon_customers_all" ON customers
  FOR ALL TO anon, authenticated
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_followups_all" ON followups;
CREATE POLICY "anon_followups_all" ON followups
  FOR ALL TO anon, authenticated
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_app_settings_all" ON app_settings;
CREATE POLICY "anon_app_settings_all" ON app_settings
  FOR ALL TO anon, authenticated
  USING (true) WITH CHECK (true);
