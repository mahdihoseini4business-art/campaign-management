/** SMS business feature flags + permission mapping (client). */

export const SMS_FEATURE_KEYS = [
  'shipment_queued',
  'shipment_shipped',
  'sales_single',
  'sales_group_debtors',
  'customer_single',
  'customer_campaign',
  'followup_on_schedule',
  'followup_bulk',
  'templates_edit',
  'history_view',
]

export const DEFAULT_SMS_FEATURES = Object.freeze(
  Object.fromEntries(SMS_FEATURE_KEYS.map((k) => [k, true]))
)

export const SMS_FEATURE_LABELS = Object.freeze({
  shipment_queued: 'پیامک خودکار ورود به صف ارسالی',
  shipment_shipped: 'پیامک تأیید ارسال و کد رهگیری',
  sales_single: 'پیامک فروش / مانده تکی',
  sales_group_debtors: 'پیامک گروهی به بدهکاران',
  customer_single: 'پیامک تکی به مشتری',
  customer_campaign: 'کمپین پیامکی مشتریان',
  followup_on_schedule: 'پیامک زمان‌بندی‌شده روی موعد فالوآپ',
  followup_bulk: 'پیامک دسته‌ای به فالوآپ‌دارها',
  templates_edit: 'ویرایش قالب‌های پیامک',
  history_view: 'مشاهده تاریخچه پیامک',
})

/** kind (API) → org feature key */
export const SMS_KIND_FEATURE = Object.freeze({
  shipment_queued: 'shipment_queued',
  shipment_shipped: 'shipment_shipped',
  sale_single: 'sales_single',
  sale_group: 'sales_group_debtors',
  customer_single: 'customer_single',
  customer_campaign: 'customer_campaign',
  followup_schedule: 'followup_on_schedule',
  followup_bulk: 'followup_bulk',
})

/** kind (API) → user permission (null = auto-only gate via feature) */
export const SMS_KIND_PERMISSION = Object.freeze({
  shipment_queued: 'sms_shipment_queued',
  shipment_shipped: 'sms_shipment_shipped',
  sale_single: 'sms_sales_single',
  sale_group: 'sms_sales_group',
  customer_single: 'sms_customer_single',
  customer_campaign: 'sms_customer_campaign',
  followup_schedule: 'sms_followup_schedule',
  followup_bulk: 'sms_followup_bulk',
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
    key: 'customer_campaign',
    name: 'کمپین مشتریان',
    body: 'سلام {customer_name} عزیز، {org_name}',
  },
  {
    key: 'followup_due',
    name: 'اطلاع موعد پیگیری',
    body: 'سلام {customer_name} عزیز، کارشناس ما ({advisor}) در تاریخ {followup_date} با شما تماس خواهد گرفت.',
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

export function normalizeFollowupDefaultHour(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0 || n > 23) return 10
  return Math.floor(n)
}
