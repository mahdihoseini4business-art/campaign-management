/**
 * Customer profile field catalog + fill/completion helpers for sales targets.
 * Sticky first-fill timestamps live on customer.fieldFilledAt (DB: field_filled_at).
 */

import { getCustomerPhones, getCustomerAddresses, normalizePhone, toEnDigits } from './utils.js'

export const CUSTOMER_PROFILE_FIELD_CATALOG = Object.freeze([
  { key: 'name', label: 'نام' },
  { key: 'nameEn', label: 'نام انگلیسی' },
  { key: 'nationalId', label: 'کد ملی' },
  { key: 'birthDate', label: 'تاریخ تولد' },
  { key: 'status', label: 'وضعیت' },
  { key: 'customerCode', label: 'کد مشتری' },
  { key: 'customerLevel', label: 'سطح مشتری' },
  { key: 'phones', label: 'شماره تماس' },
  { key: 'addresses', label: 'آدرس پستی' },
  { key: 'advisor', label: 'کارشناس مسئول' },
  { key: 'platform', label: 'پلتفرم' },
  { key: 'platformId', label: 'ایدی پلتفرم' }
])

const CATALOG_KEYS = new Set(CUSTOMER_PROFILE_FIELD_CATALOG.map(f => f.key))

export function getCustomerProfileFieldCatalog() {
  return CUSTOMER_PROFILE_FIELD_CATALOG
}

export function isCustomerProfileFieldKey(key) {
  return CATALOG_KEYS.has(String(key || ''))
}

export function sanitizeProfileFieldKeys(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const item of raw) {
    const key = String(item || '').trim()
    if (!CATALOG_KEYS.has(key) || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

export function profileFieldLabels(keys) {
  const map = new Map(CUSTOMER_PROFILE_FIELD_CATALOG.map(f => [f.key, f.label]))
  return sanitizeProfileFieldKeys(keys).map(k => map.get(k) || k)
}

function nonEmptyStr(v) {
  return String(v || '').trim() !== ''
}

/** True when the field currently has a meaningful value on the customer. */
export function isCustomerProfileFieldFilled(customer, key) {
  if (!customer) return false
  switch (key) {
    case 'name':
      return nonEmptyStr(customer.name)
    case 'nameEn':
      return nonEmptyStr(customer.nameEn)
    case 'nationalId': {
      const id = toEnDigits(String(customer.nationalId || '')).replace(/\D/g, '')
      return /^\d{10}$/.test(id)
    }
    case 'birthDate': {
      const d = toEnDigits(String(customer.birthDate || '').trim()).replace(/[-.]/g, '/')
      return /^\d{4}\/\d{2}\/\d{2}$/.test(d)
    }
    case 'status':
      return nonEmptyStr(customer.status)
    case 'customerCode':
      return nonEmptyStr(customer.customerCode)
    case 'customerLevel':
      return nonEmptyStr(customer.customerLevel)
    case 'phones':
      return getCustomerPhones(customer).some(p => /^09\d{9}$/.test(p))
    case 'addresses':
      return getCustomerAddresses(customer).some(a => nonEmptyStr(a?.text))
    case 'advisor':
      return !!normalizePhone(customer.advisorPhone || '')
    case 'platform':
      return nonEmptyStr(customer.platform)
    case 'platformId':
      return nonEmptyStr(customer.platformId)
    default:
      return false
  }
}

export function customerMeetsProfileFields(customer, keys) {
  const list = sanitizeProfileFieldKeys(keys)
  if (!list.length) return false
  return list.every(k => isCustomerProfileFieldFilled(customer, k))
}

/** Normalize DB/memory map → { [fieldKey]: ISO string }. */
export function normalizeFieldFilledAt(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [k, v] of Object.entries(raw)) {
    if (!CATALOG_KEYS.has(k)) continue
    const iso = String(v || '').trim()
    if (!iso) continue
    out[k] = iso
  }
  return out
}

/**
 * Soft backfill in memory: filled fields without a stamp get createdAt (legacy).
 * Does not clear stamps when a field is emptied (sticky).
 */
export function backfillFieldFilledAtInMemory(customer) {
  if (!customer) return customer
  const map = normalizeFieldFilledAt(customer.fieldFilledAt)
  const legacy = String(customer.createdAt || '').trim() || '1970-01-01T00:00:00.000Z'
  let changed = false
  for (const { key } of CUSTOMER_PROFILE_FIELD_CATALOG) {
    if (!isCustomerProfileFieldFilled(customer, key)) continue
    if (map[key]) continue
    map[key] = legacy
    changed = true
  }
  if (changed || customer.fieldFilledAt !== map) customer.fieldFilledAt = map
  return customer
}

/**
 * ISO moment when the selected set became complete = max(firstFilledAt[f]).
 * Returns '' if incomplete or any stamp missing after backfill attempt.
 */
export function completionMomentIso(customer, keys) {
  const list = sanitizeProfileFieldKeys(keys)
  if (!list.length || !customer) return ''
  if (!customerMeetsProfileFields(customer, list)) return ''
  backfillFieldFilledAtInMemory(customer)
  const map = normalizeFieldFilledAt(customer.fieldFilledAt)
  let maxMs = 0
  for (const key of list) {
    const iso = map[key]
    if (!iso) return ''
    const ms = Date.parse(iso)
    if (!Number.isFinite(ms)) return ''
    if (ms > maxMs) maxMs = ms
  }
  return maxMs ? new Date(maxMs).toISOString() : ''
}

/**
 * Sticky first-fill: set now only when field newly becomes filled and has no stamp.
 * If already filled on prev without stamp, use createdAt (legacy).
 */
export function applyFieldFilledAtOnSave(prev, next, nowIso = new Date().toISOString()) {
  if (!next) return next
  const map = {
    ...normalizeFieldFilledAt(prev?.fieldFilledAt),
    ...normalizeFieldFilledAt(next.fieldFilledAt)
  }
  const legacy = String(next.createdAt || prev?.createdAt || '').trim() || '1970-01-01T00:00:00.000Z'
  for (const { key } of CUSTOMER_PROFILE_FIELD_CATALOG) {
    if (!isCustomerProfileFieldFilled(next, key)) continue
    if (map[key]) continue
    const wasFilled = prev ? isCustomerProfileFieldFilled(prev, key) : false
    map[key] = wasFilled ? legacy : nowIso
  }
  next.fieldFilledAt = map
  return next
}
