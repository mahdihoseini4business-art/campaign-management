/**
 * قرارداد session پلتفرم / سازمان.
 *
 * جریان سوپرادمین:
 * 1) send-otp (Edge) — purpose=platform؛ allowlist سرور PLATFORM_ADMIN_PHONES
 * 2) verify-otp (Edge) — صدور session Supabase Auth
 * 3) کلاینت: setSession روی platformSupabase (storage جدا از اپ tenant)
 * 4) whoami روی platform-api قبل از showShell — فلگ کلاینتی کافی نیست
 *
 * تصمیم نشست (فاز ۲):
 * - اپ tenant: storageKey = carno-supabase-auth
 * - /platform: storageKey = carno-platform-supabase-auth
 * - خروج از platform فقط نشست platform را پاک می‌کند
 */

/** @deprecated Phase-0 local gate key; cleared on logout for leftover cleanup */
export const PLATFORM_SESSION_STORAGE_KEY = 'carno_platform_session_v1'

/** UX cache only — never grant shell access from this alone */
export const PLATFORM_AUTH_FLAG_KEY = 'carno_platform_authed_v1'

/** Supabase Auth persist key for /platform only */
export const PLATFORM_AUTH_STORAGE_KEY = 'carno-platform-supabase-auth'

export const SERVER_SECRET_NAMES = Object.freeze({
  platformAdminPhones: 'PLATFORM_ADMIN_PHONES',
  supabaseServiceRole: 'SUPABASE_SERVICE_ROLE_KEY',
  smsUsername: 'SMS_USERNAME',
  smsPassword: 'SMS_PASSWORD',
  smsSender: 'SMS_SENDER',
  /** Comma-separated origins; unset or * = allow all (dev default) */
  platformCorsOrigins: 'PLATFORM_CORS_ORIGINS'
})
