/**
 * قرارداد session پلتفرم / سازمان (فاز ۰ — مستندسازی؛ پیاده‌سازی واقعی در فاز ۱).
 *
 * جریان هدف:
 * 1) send-otp (Edge) — rate limit؛ SMS از secrets سرور
 * 2) verify-otp (Edge) — تأیید کد → صدور session با Supabase Auth Admin API
 * 3) کلاینت: supabase.auth.setSession({ access_token, refresh_token })
 * 4) درخواست‌های PostgREST با JWT؛ RLS با auth.uid() + tenant_members
 *
 * سوپرادمین:
 * - همان OTP، ولی Edge فقط اگر phone در PLATFORM_ADMIN_PHONES (secret سرور) باشد ادامه می‌دهد
 * - هرگز allowlist را در VITE_* نگذارید
 */

export const PLATFORM_SESSION_STORAGE_KEY = 'carno_platform_session_v1'

/** کلیدهای secret سرور (فقط Edge / داشبورد Supabase — نه فرانت) */
export const SERVER_SECRET_NAMES = Object.freeze({
  platformAdminPhones: 'PLATFORM_ADMIN_PHONES',
  supabaseServiceRole: 'SUPABASE_SERVICE_ROLE_KEY'
})

/**
 * فاز ۰: هنوز به سرور وصل نیست — همیشه رد.
 * فاز ۱ این تابع را به Edge Function واقعی وصل می‌کند.
 *
 * @param {string} _phone
 * @param {string} [_otp]
 * @returns {Promise<{ ok: false, code: string, message: string }>}
 */
export async function requestPlatformSession(_phone, _otp) {
  return {
    ok: false,
    code: 'PHASE0_STUB',
    message:
      'احراز هویت سوپرادمین در فاز ۱ به Edge و allowlist سرور (PLATFORM_ADMIN_PHONES) متصل می‌شود.'
  }
}
