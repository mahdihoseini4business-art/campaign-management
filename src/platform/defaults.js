/**
 * مقادیر اولیه تنظیمات پلتفرم (seed / fallback کلاینت).
 * منبع حقیقت: جدول سروری platform_settings.
 * این فایل allowlist و راز نیست.
 */
export const PLATFORM_SETTING_DEFAULTS = Object.freeze({
  trial_days: 7,
  /** روزهای مهلت بعد از انقضای اشتراک پولی، قبل از فقط‌خواندنی */
  grace_days: 3,
  /** سقف ارسال OTP SMS در روز به ازای هر پلن */
  sms_daily_limit_trial: 20,
  sms_daily_limit_gold: 50,
  sms_daily_limit_diamond: 200,
  root_domain: 'carno.ir',
  subdomain_min_length: 3
})

export const PLATFORM_SETTING_NUMBER_KEYS = Object.freeze([
  'trial_days',
  'grace_days',
  'sms_daily_limit_trial',
  'sms_daily_limit_gold',
  'sms_daily_limit_diamond',
  'subdomain_min_length'
])

export const PLATFORM_SETTING_STRING_KEYS = Object.freeze([
  'root_domain'
])

/**
 * Normalize a platform_settings jsonb value to a stable JS type.
 * Handles legacy double-encoded strings like `"\"carno.ir\""`.
 */
export function coercePlatformSetting(key, value) {
  if (PLATFORM_SETTING_NUMBER_KEYS.includes(key)) {
    let raw = value
    if (typeof raw === 'string') {
      const t = raw.trim()
      try {
        raw = JSON.parse(t)
      } catch {
        raw = t
      }
    }
    const n = Number(raw)
    return Number.isFinite(n) ? n : PLATFORM_SETTING_DEFAULTS[key]
  }

  if (PLATFORM_SETTING_STRING_KEYS.includes(key)) {
    let s = value == null ? '' : String(value).trim()
    for (let i = 0; i < 2; i++) {
      if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
        try {
          const parsed = JSON.parse(s)
          if (typeof parsed === 'string') {
            s = parsed.trim()
            continue
          }
        } catch {
          s = s.slice(1, -1).trim()
          continue
        }
      }
      break
    }
    return s || PLATFORM_SETTING_DEFAULTS[key]
  }

  return value
}

/** Merge server map onto defaults with coercion. */
export function mergePlatformSettings(raw = {}) {
  const out = { ...PLATFORM_SETTING_DEFAULTS }
  for (const key of Object.keys(PLATFORM_SETTING_DEFAULTS)) {
    if (Object.prototype.hasOwnProperty.call(raw, key) && raw[key] != null) {
      out[key] = coercePlatformSetting(key, raw[key])
    }
  }
  return out
}

export const PLAN_IDS = Object.freeze({
  trial: 'trial',
  gold: 'gold',
  diamond: 'diamond'
})

/**
 * ماتریس فیچر پیش‌فرض پلن‌ها — منبع واحد برای entitlements و UI platform.
 * Trial موقتاً همان قابلیت‌های الماس را دارد به‌جز ساب‌دامین.
 */
export const PLAN_FEATURE_FALLBACK = Object.freeze({
  [PLAN_IDS.trial]: Object.freeze({
    dm_chat: true,
    products_matrix: true,
    refunds: true,
    shipments: true,
    custom_subdomain: false
  }),
  [PLAN_IDS.gold]: Object.freeze({
    dm_chat: false,
    products_matrix: false,
    refunds: false,
    shipments: false,
    custom_subdomain: false
  }),
  [PLAN_IDS.diamond]: Object.freeze({
    dm_chat: true,
    products_matrix: true,
    refunds: true,
    shipments: true,
    custom_subdomain: true
  })
})

/** Features enabled on diamond but not on gold (derived — do not edit by hand). */
export const DIAMOND_ONLY_FEATURES = Object.freeze(
  Object.keys(PLAN_FEATURE_FALLBACK[PLAN_IDS.diamond]).filter(
    (key) =>
      PLAN_FEATURE_FALLBACK[PLAN_IDS.diamond][key] === true &&
      PLAN_FEATURE_FALLBACK[PLAN_IDS.gold][key] !== true
  )
)