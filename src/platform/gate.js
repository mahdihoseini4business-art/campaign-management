import { PLATFORM_SESSION_STORAGE_KEY, requestPlatformSession } from './session-contract.js'

/**
 * گیت دسترسی سوپرادمین — پیش‌فرض deny.
 * تا فاز ۱ هیچ session معتبری از کلاینت پذیرفته نمی‌شود.
 */

export function clearPlatformGateSession() {
  try {
    localStorage.removeItem(PLATFORM_SESSION_STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

/**
 * @returns {{ authenticated: false } | { authenticated: true, phone: string }}
 */
export function readPlatformGateSession() {
  // فاز ۰: ذخیرهٔ کلاینتی را معتبر نمی‌دانیم (جلوگیری از حس امنیت کاذب).
  clearPlatformGateSession()
  return { authenticated: false }
}

/**
 * تلاش ورود — فعلاً همیشه رد با پیام فاز ۱.
 * @param {string} phone
 * @param {string} otp
 */
export async function attemptPlatformLogin(phone, otp) {
  const normalized = String(phone || '').trim()
  const code = String(otp || '').trim()
  if (!normalized || !code) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'شماره موبایل و کد تأیید لازم است.'
    }
  }
  return requestPlatformSession(normalized, code)
}

export function isPlatformAccessGranted() {
  return readPlatformGateSession().authenticated === true
}
