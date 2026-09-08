import { PLATFORM_SESSION_STORAGE_KEY } from './session-contract.js'

/** @deprecated Phase 1 uses Supabase Auth + platform-api; kept for API stability. */
export function clearPlatformGateSession() {
  try {
    localStorage.removeItem(PLATFORM_SESSION_STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

export function readPlatformGateSession() {
  clearPlatformGateSession()
  return { authenticated: false }
}

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
  return {
    ok: false,
    code: 'USE_EDGE',
    message: 'از verifyOTP با purpose=platform استفاده کنید.'
  }
}

export function isPlatformAccessGranted() {
  return false
}
