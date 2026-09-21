/** SMS business feature flags + permission mapping (client). */

export const SMS_FEATURE_KEYS = [
  'shipment_queued',
  'shipment_shipped',
  'sales_single',
  'sales_group_debtors',
  'sales_settlement_due',
  'customer_single',
  'customer_campaign',
  'followup_on_schedule',
  'followup_bulk',
  'events',
  'templates_edit',
  'history_view',
]

export const DEFAULT_SMS_FEATURES = Object.freeze(
  Object.fromEntries(
    SMS_FEATURE_KEYS.map((k) => [k, k === 'sales_settlement_due' ? false : true])
  )
)

export const SMS_FEATURE_LABELS = Object.freeze({
  shipment_queued: 'پیامک خودکار ورود به صف ارسالی',
  shipment_shipped: 'پیامک تأیید ارسال و کد رهگیری',
  sales_single: 'پیامک فروش / مانده تکی',
  sales_group_debtors: 'پیامک گروهی به بدهکاران',
  sales_settlement_due: 'پیامک خودکار فقط در روز موعد تسویه (بر اساس مانده)',
  customer_single: 'پیامک تکی به مشتری',
  customer_campaign: 'کمپین پیامکی مشتریان',
  followup_on_schedule: 'پیامک زمان‌بندی‌شده روی موعد فالوآپ',
  followup_bulk: 'پیامک دسته‌ای به فالوآپ‌دارها',
  events: 'پیامک رویدادها (خوش‌آمد / اطلاع‌رسانی)',
  templates_edit: 'ویرایش قالب‌های پیامک',
  history_view: 'مشاهده تاریخچه پیامک',
})

/** kind (API) → org feature key */
export const SMS_KIND_FEATURE = Object.freeze({
  shipment_queued: 'shipment_queued',
  shipment_shipped: 'shipment_shipped',
  sale_single: 'sales_single',
  sale_group: 'sales_group_debtors',
  sale_settlement_due: 'sales_settlement_due',
  customer_single: 'customer_single',
  customer_campaign: 'customer_campaign',
  followup_schedule: 'followup_on_schedule',
  followup_bulk: 'followup_bulk',
  event_single: 'events',
})

/** kind (API) → user permission (null = auto-only gate via feature) */
export const SMS_KIND_PERMISSION = Object.freeze({
  shipment_queued: 'sms_shipment_queued',
  shipment_shipped: 'sms_shipment_shipped',
  sale_single: 'sms_sales_single',
  sale_group: 'sms_sales_group',
  sale_settlement_due: 'sms_sales_settlement',
  customer_single: 'sms_customer_single',
  customer_campaign: 'sms_customer_campaign',
  followup_schedule: 'sms_followup_schedule',
  followup_bulk: 'sms_followup_bulk',
  event_single: 'sms_events',
})

export const DEFAULT_SMS_TEMPLATES = Object.freeze([
  {
    key: 'shipment_queued',
    name: 'ورود به صف ارسال',
    body: 'سلام {customer_name} عزیز، سفارش «{product_name}» شما در صف ارسال آکادمی کارنو قرار گرفت.',
  },
  {
    key: 'shipment_shipped',
    name: 'تأیید ارسال و رهگیری',
    body: 'سلام {customer_name} عزیز، سفارش «{product_name}» ارسال شد. کد رهگیری: {tracking_code}',
  },
  {
    key: 'sale_balance',
    name: 'مانده حساب',
    body: 'سلام {customer_name} عزیز، مانده حساب شما بابت «{product_name}»: {balance} ریال.',
  },
  {
    key: 'sale_settlement_due',
    name: 'موعد تسویه',
    body: 'سلام {customer_name} عزیز، موعد تسویه «{product_name}» ({settlement_date}) فرا رسیده است. مانده: {balance} ریال. کارشناس شما {advisor_name} — {advisor_phone}',
  },
  {
    key: 'customer_campaign',
    name: 'کمپین مشتریان',
    body: 'سلام {customer_name} عزیز، {org_name}',
  },
  {
    key: 'followup_due',
    name: 'اطلاع موعد پیگیری',
    body: 'سلام {customer_name} عزیز، کارشناس ما ({advisor}) با شماره {advisor_phone} در تاریخ {followup_date} با شما تماس خواهد گرفت.',
  },
  {
    key: 'followup_bulk',
    name: 'پیام دسته‌ای فالوآپ',
    body: 'سلام {customer_name} عزیز، زمان ارتباط کارشناس با شما: {followup_date}.',
  },
])

export function normalizeSmsFeatures(raw) {
  const out = { ...DEFAULT_SMS_FEATURES }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const k of SMS_FEATURE_KEYS) {
    if (typeof raw[k] === 'boolean') out[k] = raw[k]
  }
  return out
}

/** Normalize to "HH:MM" (supports legacy integer hour 0–23). Default 10:00. */
export function normalizeFollowupDefaultHour(raw) {
  if (typeof raw === 'string') {
    const m = raw.trim().match(/^(\d{1,2})(?::(\d{1,2}))?$/)
    if (m) {
      const h = Number(m[1])
      const min = m[2] != null ? Number(m[2]) : 0
      if (Number.isFinite(h) && h >= 0 && h <= 23 && Number.isFinite(min) && min >= 0 && min <= 59) {
        return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
      }
    }
  }
  const n = Number(raw)
  if (Number.isFinite(n) && n >= 0 && n <= 23) {
    return `${String(Math.floor(n)).padStart(2, '0')}:00`
  }
  return '10:00'
}

/**
 * Placeholder chips for the SMS template editor (key → {token, label}[]).
 * Tokens must match vars passed into send-sms renderTemplate.
 */
export const SMS_TEMPLATE_PLACEHOLDERS = Object.freeze({
  shipment_queued: [
    { token: 'customer_name', label: 'نام مشتری' },
    { token: 'product_name', label: 'نام محصول' },
    { token: 'advisor_name', label: 'نام کارشناس' },
    { token: 'advisor_phone', label: 'شماره کارشناس' },
    { token: 'org_name', label: 'نام سازمان' },
  ],
  shipment_shipped: [
    { token: 'customer_name', label: 'نام مشتری' },
    { token: 'product_name', label: 'نام محصول' },
    { token: 'tracking_code', label: 'کد رهگیری' },
    { token: 'advisor_name', label: 'نام کارشناس' },
    { token: 'advisor_phone', label: 'شماره کارشناس' },
  ],
  sale_balance: [
    { token: 'customer_name', label: 'نام مشتری' },
    { token: 'product_name', label: 'نام محصول' },
    { token: 'balance', label: 'مانده' },
    { token: 'settlement_date', label: 'تاریخ تسویه' },
    { token: 'advisor_name', label: 'نام کارشناس' },
    { token: 'advisor_phone', label: 'شماره کارشناس' },
  ],
  sale_settlement_due: [
    { token: 'customer_name', label: 'نام مشتری' },
    { token: 'product_name', label: 'نام محصول' },
    { token: 'balance', label: 'مانده' },
    { token: 'settlement_date', label: 'تاریخ تسویه' },
    { token: 'days_to_settlement_text', label: 'متن روز مانده/گذشته' },
    { token: 'advisor_name', label: 'نام کارشناس' },
    { token: 'advisor', label: 'کارشناس (نام یا شماره)' },
    { token: 'advisor_phone', label: 'شماره کارشناس' },
    { token: 'org_name', label: 'نام سازمان' },
  ],
  customer_campaign: [
    { token: 'customer_name', label: 'نام مشتری' },
    { token: 'advisor_name', label: 'نام کارشناس' },
    { token: 'advisor_phone', label: 'شماره کارشناس' },
    { token: 'org_name', label: 'نام سازمان' },
    { token: 'followup_date', label: 'تاریخ پیگیری' },
  ],
  followup_due: [
    { token: 'customer_name', label: 'نام مشتری' },
    { token: 'followup_date', label: 'تاریخ پیگیری' },
    { token: 'advisor_name', label: 'نام کارشناس' },
    { token: 'advisor', label: 'کارشناس' },
    { token: 'advisor_phone', label: 'شماره کارشناس' },
  ],
  followup_bulk: [
    { token: 'customer_name', label: 'نام مشتری' },
    { token: 'followup_date', label: 'تاریخ پیگیری' },
    { token: 'advisor_name', label: 'نام کارشناس' },
    { token: 'advisor_phone', label: 'شماره کارشناس' },
  ],
})
