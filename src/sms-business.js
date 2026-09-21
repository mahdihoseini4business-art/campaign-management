import { supabase } from './supabase.js'
import { getStoredTenantId } from './tenant.js'
import { readFunctionsInvokeError } from './edge-error.js'
import { hasPermission, isMainAdmin, formatNumber, jalaliDiffDays, getTodayJalaliStr, jalaliToNum, jalaliAddDays, normalizePhone, userDisplayName } from './utils.js'
import { SMS_KIND_FEATURE, SMS_KIND_PERMISSION } from './sms-features.js'
import { getSmsFeatures, getFollowupSmsDefaultHour } from './data.js'

/**
 * Whether org feature + user permission allow this SMS kind in UI.
 * @param {string} kind API kind
 * @param {{ auto?: boolean }} [opts]
 */
export function canUseSmsKind(kind, opts = {}) {
  const featureKey = SMS_KIND_FEATURE[kind]
  if (!featureKey) return false
  const features = getSmsFeatures()
  if (features[featureKey] !== true) return false
  if (opts.auto) return true
  if (isMainAdmin()) return true
  const perm = SMS_KIND_PERMISSION[kind]
  if (!perm) return true
  return hasPermission(perm) || hasPermission('sms_manage')
}

export function canManageSmsSettings() {
  return isMainAdmin() || hasPermission('sms_manage')
}

export function canViewSmsHistory() {
  const features = getSmsFeatures()
  if (features.history_view !== true) return false
  return isMainAdmin() || hasPermission('sms_history') || hasPermission('sms_manage')
}

/** Who may see the per-customer SMS tab in the customer panel. */
export function canViewCustomerSmsHistory() {
  if (isMainAdmin()) return true
  return hasPermission('sms_customer_history') || hasPermission('sms_manage')
}

export function canEditSmsTemplates() {
  const features = getSmsFeatures()
  if (features.templates_edit !== true) return false
  return canManageSmsSettings()
}

/**
 * @param {object} payload
 */
export async function invokeSendSms(payload) {
  const tenantId = getStoredTenantId()
  if (!tenantId) return { success: false, error: 'سازمان انتخاب نشده' }
  try {
    const { data, error } = await supabase.functions.invoke('send-sms', {
      body: { ...payload, tenant_id: tenantId },
    })
    if (error) {
      const detail = await readFunctionsInvokeError(error, 'خطا در ارسال پیامک')
      return { success: false, error: data?.error || detail, ...(data || {}) }
    }
    return data || { success: false, error: 'پاسخ نامعتبر' }
  } catch (e) {
    console.error('invokeSendSms', e)
    return { success: false, error: 'خطا در اتصال به سرور' }
  }
}

/** Daily SMS quota for current tenant (no send). */
export async function fetchSmsQuota() {
  return invokeSendSms({ mode: 'quota' })
}

export function formatBalanceFa(n) {
  return formatNumber(Math.max(0, Number(n) || 0))
}

/**
 * Advisor placeholders for SMS — per customer's own advisor.
 * Resolves display name from users list when customer.advisor is empty/stale.
 * @param {object} customer
 * @param {object[]} [users]
 */
export function buildAdvisorSmsVars(customer, users = null) {
  const phone = normalizePhone(customer?.advisorPhone || customer?.advisor_phone || '')
  let name = String(customer?.advisor || '').trim()
  if (phone && Array.isArray(users) && users.length) {
    const u = users.find((x) => normalizePhone(x?.phone) === phone)
    const resolved = userDisplayName(u).trim()
    if (resolved) name = resolved
  }
  return {
    advisor: name || phone || '',
    advisor_name: name || '',
    advisor_phone: phone || '',
  }
}

/**
 * Placeholders for settlement-due personalization.
 * days_to_settlement: signed integer (positive = remaining, 0 = today, negative = overdue)
 * days_to_settlement_text: Persian phrase for remaining/overdue
 */
export function buildSettlementSmsVars(settlementDate) {
  const date = String(settlementDate || '').trim()
  if (!date) {
    return {
      settlement_date: '',
      days_to_settlement: '',
      days_to_settlement_text: '',
    }
  }
  const days = jalaliDiffDays(getTodayJalaliStr(), date)
  if (days == null) {
    return {
      settlement_date: date,
      days_to_settlement: '',
      days_to_settlement_text: '',
    }
  }
  let text = 'امروز'
  if (days > 0) text = `${formatNumber(days)} روز مانده`
  else if (days < 0) text = `${formatNumber(-days)} روز از موعد گذشته`
  return {
    settlement_date: date,
    days_to_settlement: String(days),
    days_to_settlement_text: text,
  }
}

/** True when Jalali settlement date is exactly today (Tehran calendar via getTodayJalaliStr). */
export function isSettlementDateToday(settlementDate) {
  const date = String(settlementDate || '').trim()
  if (!date) return false
  const n = jalaliToNum(date)
  if (!n || n === 99999999) return false
  return n === jalaliToNum(getTodayJalaliStr())
}

/**
 * Auto reminders relative to settlement date.
 * - minus3: 3 days before
 * - due: on settlement day
 */
export const SETTLEMENT_REMINDER_OFFSETS = Object.freeze([
  { kind: 'minus3', offsetDays: -3, label: '۳ روز قبل' },
  { kind: 'due', offsetDays: 0, label: 'روز موعد' },
])

function jalaliNumToDateStr(n) {
  if (!n || n === 99999999) return ''
  const y = Math.floor(n / 10000)
  const m = Math.floor((n % 10000) / 100)
  const d = n % 100
  return `${y}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`
}

/** Jalali send day for a settlement reminder (settlementDate + offsetDays). */
export function settlementReminderSendDate(settlementDate, offsetDays = 0) {
  const date = String(settlementDate || '').trim()
  if (!date || jalaliToNum(date) === 99999999) return ''
  return jalaliNumToDateStr(jalaliAddDays(date, Number(offsetDays) || 0))
}

export function normalizeSettlementReminderKind(raw) {
  const k = String(raw || '').trim()
  if (k === 'minus3') return 'minus3'
  return 'due'
}

/** Dedup key: one SMS per customer+product+reminderKind per day. */
export function settlementSmsSentKey(customerId, productIndex, reminderKind = 'due') {
  const kind = normalizeSettlementReminderKind(reminderKind)
  return `${customerId}::${productIndex}::${kind}`
}

/**
 * Auto-schedule when settlement is today or future (never overdue backlog).
 * Each reminder's send day must also be today or future.
 */
export function isSettlementDateSchedulable(settlementDate) {
  const date = String(settlementDate || '').trim()
  if (!date) return false
  const n = jalaliToNum(date)
  if (!n || n === 99999999) return false
  return n >= jalaliToNum(getTodayJalaliStr())
}

/** True when today is the send day for this reminder kind. */
export function isSettlementReminderDueToday(settlementDate, reminderKind = 'due') {
  const kind = normalizeSettlementReminderKind(reminderKind)
  const offset = kind === 'minus3' ? -3 : 0
  const sendDate = settlementReminderSendDate(settlementDate, offset)
  if (!sendDate) return false
  return jalaliToNum(sendDate) === jalaliToNum(getTodayJalaliStr())
}

/** Whether this reminder's send day is still in the future or today (ok to queue). */
export function isSettlementReminderSchedulable(settlementDate, reminderKind = 'due') {
  if (!isSettlementDateSchedulable(settlementDate)) return false
  const kind = normalizeSettlementReminderKind(reminderKind)
  const offset = kind === 'minus3' ? -3 : 0
  const sendDate = settlementReminderSendDate(settlementDate, offset)
  if (!sendDate) return false
  return jalaliToNum(sendDate) >= jalaliToNum(getTodayJalaliStr())
}

export function buildRecipientFromCustomer(customer, vars = {}, meta = {}, users = null) {
  const phones = []
  if (customer?.phone) phones.push(customer.phone)
  if (Array.isArray(customer?.phones)) {
    for (const p of customer.phones) if (p) phones.push(p)
  }
  const phone = phones[0] || ''
  return {
    phone,
    customer_id: customer?.id,
    vars: {
      customer_name: customer?.name || '',
      customer_code: customer?.id || '',
      phone: phone || '',
      ...buildAdvisorSmsVars(customer, users),
      followup_date: customer?.nextFollowupDate || '',
      org_name: 'آکادمی کارنو',
      ...vars,
    },
    meta,
  }
}

/** kind (API) → Persian label for history UI. */
export const SMS_KIND_LABELS = Object.freeze({
  shipment_queued: 'صف ارسال',
  shipment_shipped: 'تأیید ارسال',
  sale_single: 'مانده حساب',
  sale_group: 'بدهکاران گروهی',
  sale_settlement_due: 'موعد تسویه',
  customer_single: 'تکی',
  customer_campaign: 'کمپین',
  followup_schedule: 'موعد پیگیری',
  followup_bulk: 'دسته‌ای پیگیری',
  event_single: 'رویداد',
})

/** sms_logs status → Persian label for history UI. */
export const SMS_STATUS_LABELS = Object.freeze({
  queued: 'در صف',
  sent: 'ارسال شد',
  failed: 'ناموفق',
  skipped: 'رد شد',
})

export { getFollowupSmsDefaultHour, getSmsFeatures }
