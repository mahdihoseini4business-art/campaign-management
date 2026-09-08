/**
 * Pure entitlement helpers (no DOM / Supabase) — usable in Node smoke tests.
 */
import { PLATFORM_SETTING_DEFAULTS, PLAN_IDS } from './platform/defaults.js'

export const PLAN_FEATURE_FALLBACK = {
  [PLAN_IDS.trial]: {
    dm_chat: true,
    products_matrix: true,
    refunds: true,
    shipments: true,
    custom_subdomain: false
  },
  [PLAN_IDS.gold]: {
    dm_chat: false,
    products_matrix: false,
    refunds: false,
    shipments: false,
    custom_subdomain: false
  },
  [PLAN_IDS.diamond]: {
    dm_chat: true,
    products_matrix: true,
    refunds: true,
    shipments: true,
    custom_subdomain: true
  }
}

export function defaultFeatures(planId) {
  return { ...(PLAN_FEATURE_FALLBACK[planId] || PLAN_FEATURE_FALLBACK[PLAN_IDS.gold]) }
}

export function mergeFeatures(planId, fromDb) {
  const base = defaultFeatures(planId)
  if (fromDb && typeof fromDb === 'object' && !Array.isArray(fromDb)) {
    for (const k of Object.keys(base)) {
      if (typeof fromDb[k] === 'boolean') base[k] = fromDb[k]
    }
  }
  return base
}

/**
 * Compute effective access from subscription row + grace_days.
 */
export function computeAccessState(sub, graceDays = PLATFORM_SETTING_DEFAULTS.grace_days) {
  const now = Date.now()
  const gDays = Number.isFinite(Number(graceDays)) ? Number(graceDays) : PLATFORM_SETTING_DEFAULTS.grace_days

  if (!sub) {
    return {
      accessMode: 'readonly',
      paywall: true,
      blockImportExport: true,
      reason: 'no_subscription',
      planId: PLAN_IDS.gold,
      rawStatus: 'missing'
    }
  }

  const planId = sub.plan_id || PLAN_IDS.gold
  const rawStatus = sub.status || 'active'
  const trialEnds = sub.trial_ends_at ? new Date(sub.trial_ends_at).getTime() : null
  const endsAt = sub.ends_at ? new Date(sub.ends_at).getTime() : null

  if (rawStatus === 'suspended') {
    return {
      accessMode: 'readonly',
      paywall: true,
      blockImportExport: true,
      reason: 'suspended',
      planId,
      rawStatus
    }
  }

  if (rawStatus === 'readonly') {
    return {
      accessMode: 'readonly',
      paywall: true,
      blockImportExport: true,
      reason: 'readonly',
      planId,
      rawStatus
    }
  }

  // Trial ended → readonly + paywall (per product decision)
  if (rawStatus === 'trialing' && trialEnds && trialEnds < now) {
    return {
      accessMode: 'readonly',
      paywall: true,
      blockImportExport: true,
      reason: 'trial_ended',
      planId,
      rawStatus
    }
  }

  if (rawStatus === 'trialing') {
    return {
      accessMode: 'writable',
      paywall: false,
      blockImportExport: false,
      reason: 'trialing',
      planId,
      rawStatus
    }
  }

  // Paid expired → grace then readonly
  if ((rawStatus === 'active' || rawStatus === 'grace') && endsAt && endsAt < now) {
    const graceEnd = endsAt + gDays * 86400000
    if (now < graceEnd || rawStatus === 'grace') {
      if (now < graceEnd) {
        return {
          accessMode: 'grace',
          paywall: false,
          blockImportExport: false,
          reason: 'grace',
          planId,
          rawStatus: 'grace'
        }
      }
    }
    return {
      accessMode: 'readonly',
      paywall: true,
      blockImportExport: true,
      reason: 'expired',
      planId,
      rawStatus
    }
  }

  if (rawStatus === 'grace') {
    return {
      accessMode: 'grace',
      paywall: false,
      blockImportExport: false,
      reason: 'grace',
      planId,
      rawStatus
    }
  }

  return {
    accessMode: 'writable',
    paywall: false,
    blockImportExport: false,
    reason: 'active',
    planId,
    rawStatus
  }
}

export function paywallCopy(reason) {
  if (reason === 'trial_ended') {
    return {
      title: 'دوره آزمایشی تمام شد',
      body: 'اشتراک آزمایشی رایگان شما به پایان رسیده است. سیستم فقط‌خواندنی است و ایمپورت/اکسپورت غیرفعال شده. برای ادامه یکی از پلن‌های طلایی یا الماسی را تهیه کنید.'
    }
  }
  if (reason === 'expired' || reason === 'readonly') {
    return {
      title: 'اشتراک منقضی شده',
      body: 'اشتراک سازمان منقضی شده و دسترسی فقط‌خواندنی است. برای بازگشایی امکانات، اشتراک را تمدید کنید.'
    }
  }
  if (reason === 'suspended') {
    return {
      title: 'سازمان تعلیق شده',
      body: 'سازمان شما تعلیق شده است. با پشتیبانی تماس بگیرید یا از سوپرادمین بخواهید وضعیت را بررسی کند.'
    }
  }
  if (reason === 'no_subscription') {
    return {
      title: 'اشتراک یافت نشد',
      body: 'برای این سازمان اشتراک فعالی ثبت نشده. پلن طلایی یا الماسی را تهیه کنید یا با پشتیبانی تماس بگیرید.'
    }
  }
  return {
    title: 'اشتراک به پایان رسیده',
    body: 'برای ادامه کار به اشتراک فعال نیاز دارید.'
  }
}

/** Remaining whole days in grace window (0 if not in grace / unknown). */
export function graceDaysRemaining(endsAtIso, graceDays, nowMs = Date.now()) {
  if (!endsAtIso) return 0
  const endsAt = new Date(endsAtIso).getTime()
  if (!Number.isFinite(endsAt)) return 0
  const gDays = Number(graceDays) || 0
  const graceEnd = endsAt + gDays * 86400000
  if (nowMs >= graceEnd) return 0
  if (nowMs < endsAt) return gDays
  return Math.max(0, Math.ceil((graceEnd - nowMs) / 86400000))
}
