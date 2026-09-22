/**
 * Shared conversion-code sale filters + lock check for import.
 * Advisor/product filters on a customer_codes catalog entry (AND).
 */

import { getCustomerCodes, coerceProductName, normalizeCustomerCodeSaleFilters } from './data.js'
import { getMembersOfGroup } from './groups.js'
import {
  normalizePhone,
  gregorianToJalaliStr,
  jalaliDatePart,
  jalaliToNum,
  ensureProductPayments,
  syncProductStatus,
  getProductPayments,
  getPaymentEntryStatus,
  isProductCountableInSales,
  PAYMENT_STATUS
} from './utils.js'
import {
  backfillFieldFilledAtInMemory,
  normalizeFieldFilledAt
} from './customer-profile-fields.js'

export function getCustomerCodeEntryByKey(key) {
  const k = String(key || '').trim()
  if (!k) return null
  return getCustomerCodes().find(c => c.key === k) || null
}

export function resolveCodeAdvisorPhoneSet(entry) {
  const f = normalizeCustomerCodeSaleFilters(entry || {})
  const set = new Set(f.advisorPhones)
  for (const gid of f.advisorGroupIds) {
    for (const m of getMembersOfGroup(gid)) {
      const p = normalizePhone(m.user_phone)
      if (p) set.add(p)
    }
  }
  return set
}

/**
 * Phone of who registered the sale — payment then product soldByPhone only.
 * Does NOT fall back to customer.advisorPhone (owner ≠ registrant).
 */
export function getCodeFilterSaleRegistrantPhone(product, payment = null) {
  return normalizePhone(payment?.soldByPhone) || normalizePhone(product?.soldByPhone) || ''
}

/** Sale registrant + product filters stored on the customer-code entry (AND). */
export function paymentMatchesCodeSaleFilters(codeEntry, { product, payment }) {
  if (!codeEntry) return true
  const f = normalizeCustomerCodeSaleFilters(codeEntry)
  if (!f.filterAdvisors && !f.filterProducts) return true
  if (f.filterAdvisors) {
    const allowed = resolveCodeAdvisorPhoneSet(codeEntry)
    if (!allowed.size) return false
    const reg = getCodeFilterSaleRegistrantPhone(product, payment)
    if (!reg || !allowed.has(reg)) return false
  }
  if (f.filterProducts) {
    if (!f.productNames.length) return false
    const name = coerceProductName(product?.name) || String(product?.name || '').trim()
    const allowed = new Set(f.productNames.map(n => n.toLowerCase()))
    if (!allowed.has(name.toLowerCase())) return false
  }
  return true
}

/** Jalali YYYY/MM/DD of sticky first-fill for customerCode (legacy → createdAt). */
export function customerCodeAssignedJalali(customer) {
  if (!customer || !(customer.customerCode || '').trim()) return ''
  backfillFieldFilledAtInMemory(customer)
  const iso = normalizeFieldFilledAt(customer.fieldFilledAt).customerCode
  return iso ? gregorianToJalaliStr(iso) : ''
}

/**
 * True when this customer already has an approved countable payment that would
 * count toward conversion sales for their *current* customer code (filters +
 * payment date ≥ code first-fill). Used to lock the code against import overwrite.
 */
export function customerHasQualifiedSaleAfterCodeAssign(customer) {
  const codeKey = String(customer?.customerCode || '').trim()
  if (!codeKey) return false

  const entry = getCustomerCodeEntryByKey(codeKey)
  const assigned = customerCodeAssignedJalali(customer)
  const assignedNum = assigned ? jalaliToNum(assigned) : 0

  for (const product of customer.products || []) {
    ensureProductPayments(product)
    syncProductStatus(product)
    if (!isProductCountableInSales(product)) continue
    for (const payment of getProductPayments(product)) {
      const amount = parseFloat(payment.amount) || 0
      if (amount <= 0) continue
      if (getPaymentEntryStatus(payment) !== PAYMENT_STATUS.approved) continue
      const date = jalaliDatePart(payment.soldAt)
      if (!date) continue
      if (assignedNum && jalaliToNum(date) < assignedNum) continue
      if (!paymentMatchesCodeSaleFilters(entry, { customer, product, payment })) continue
      return true
    }
  }
  return false
}

/**
 * Whether import may replace customer.customerCode with nextCode.
 * Create / empty prev / same value → ok. Else block if a qualifying sale exists.
 */
export function canImportReplaceCustomerCode(customer, nextCode) {
  const prev = String(customer?.customerCode || '').trim()
  const next = String(nextCode || '').trim()
  if (!prev || prev === next) return true
  return !customerHasQualifiedSaleAfterCodeAssign(customer)
}
