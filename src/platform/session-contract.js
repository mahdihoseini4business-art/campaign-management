/**
 * قرارداد session سوپرادمین `/platform`.
 *
 * جریان:
 * 1) send-otp — purpose=platform؛ allowlist سرور PLATFORM_ADMIN_PHONES
 * 2) verify-otp — صدور session Supabase Auth
 * 3) setSession روی platformSupabase (storage جدا از اپ tenant)
 * 4) whoami روی platform-api قبل از showShell — فلگ کلاینتی به‌تنهایی کافی نیست
 *
 * نشست‌ها:
 * - اپ tenant: storageKey = carno-supabase-auth
 * - /platform: storageKey = PLATFORM_AUTH_STORAGE_KEY
 * - خروج از platform فقط نشست platform را پاک می‌کند
 */

/** UX cache only — never grant shell access from this alone */
export const PLATFORM_AUTH_FLAG_KEY = 'carno_platform_authed_v1'

/** Supabase Auth persist key for /platform only */
export const PLATFORM_AUTH_STORAGE_KEY = 'carno-platform-supabase-auth'

/** Phase-0 leftover; cleared on logout if still present */
export const LEGACY_PLATFORM_SESSION_STORAGE_KEY = 'carno_platform_session_v1'

export const SERVER_SECRET_NAMES = Object.freeze({
  platformAdminPhones: 'PLATFORM_ADMIN_PHONES',
  supabaseServiceRole: 'SUPABASE_SERVICE_ROLE_KEY',
  smsUsername: 'SMS_USERNAME',
  smsPassword: 'SMS_PASSWORD',
  smsSender: 'SMS_SENDER',
  /** Comma-separated origins; unset or * = allow all (dev default) */
  platformCorsOrigins: 'PLATFORM_CORS_ORIGINS'
})
