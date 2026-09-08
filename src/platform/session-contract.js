/**
 * قرارداد session پلتفرم / سازمان.
 *
 * جریان:
 * 1) send-otp (Edge) — rate limit؛ SMS از secrets سرور؛ purpose=tenant|platform
 * 2) verify-otp (Edge) — تأیید کد → صدور session با Supabase Auth Admin API
 * 3) کلاینت: applyAuthSession → supabase.auth.setSession
 * 4) set_current_tenant RPC → auth_context برای RLS
 * 5) درخواست‌های PostgREST با JWT؛ RLS با auth.uid() + current_tenant_id()
 *
 * سوپرادمین: purpose=platform و phone در PLATFORM_ADMIN_PHONES
 */

export const PLATFORM_SESSION_STORAGE_KEY = 'carno_platform_session_v1'

export const SERVER_SECRET_NAMES = Object.freeze({
  platformAdminPhones: 'PLATFORM_ADMIN_PHONES',
  supabaseServiceRole: 'SUPABASE_SERVICE_ROLE_KEY',
  smsUsername: 'SMS_USERNAME',
  smsPassword: 'SMS_PASSWORD',
  smsSender: 'SMS_SENDER'
})
