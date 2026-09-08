/**
 * مقادیر اولیه تنظیمات پلتفرم (فاز ۰).
 * منبع حقیقت از فاز ۲: ذخیره سروری platform_settings که سوپرادمین ویرایش می‌کند.
 * این فایل فقط seed / fallback است — نه allowlist و نه راز.
 */
export const PLATFORM_SETTING_DEFAULTS = Object.freeze({
  trial_days: 7,
  /** روزهای مهلت بعد از انقضای اشتراک پولی، قبل از فقط‌خواندنی */
  grace_days: 3,
  /** سقف ارسال OTP SMS در روز به ازای هر پلن (قابل تغییر در سوپرادمین) */
  sms_daily_limit_trial: 20,
  sms_daily_limit_gold: 50,
  sms_daily_limit_diamond: 200
})

export const PLAN_IDS = Object.freeze({
  trial: 'trial',
  gold: 'gold',
  diamond: 'diamond'
})

/** قابلیت‌هایی که فقط در Trial موقت و پلن الماسی دائم فعال‌اند */
export const DIAMOND_ONLY_FEATURES = Object.freeze([
  'dm_chat',
  'products_matrix',
  'refunds',
  'shipments',
  'custom_subdomain'
])
