// ============================================
// Utility Functions
// ============================================

import { ADMIN_PHONE } from './config.js'
import { getPlatforms, getStatuses } from './data.js'

/** Dynamic platform labels (value → Persian label) built from settings */
export function getPlatformLabels() {
  const result = {}
  for (const p of getPlatforms()) result[p.key] = p.label
  return result
}

/** Dynamic CSS class for platform color dots */
export function getPlatformClass(key) {
  return `platform-${key}`
}

/** Build import alias map dynamically from current platforms */
export function buildPlatformImportMap() {
  const map = {}
  for (const p of getPlatforms()) {
    map[p.label] = p.key
    map[p.key] = p.key
    map[p.label.toLowerCase()] = p.key
  }
  return map
}

/** Build a profile/chat URL from the platform's linkTemplate */
export function getPlatformUrl(platform, platformId, phone) {
  const id = (platformId || '').trim()
  const p = getPlatforms().find(x => x.key === platform)
  if (!p || !p.linkTemplate) return ''

  const tpl = p.linkTemplate
  if (tpl.includes('{phone}')) {
    const raw = String(phone || id).replace(/\D/g, '')
    if (!raw) return ''
    const intl = raw.startsWith('0') ? `98${raw.slice(1)}` : raw
    return tpl.replace('{phone}', encodeURIComponent(intl))
  }

  if (!id) return ''
  const cleanId = id.replace(/^@/, '')
  let url = tpl.replace('{id}', encodeURIComponent(cleanId))
  if (platform === 'website') {
    if (/^https?:\/\//i.test(id)) return id
    url = tpl.replace('{id}', cleanId)
  }
  return url
}

/** Dynamic status labels built from settings */
export function getStatusLabels() {
  const result = {}
  for (const s of getStatuses()) result[s.key] = s.label
  return result
}

/** Dynamic status CSS class */
export function getStatusClass(key) {
  return `status-${key}`
}

/** Get ordered status keys (for sorting) */
export function getStatusOrder() {
  return getStatuses().map(s => s.key)
}

export function toEnDigits(str) {
  return String(str).replace(/[\u06F0-\u06F9\u0660-\u0669]/g, ch =>
    String.fromCharCode(ch.charCodeAt(0) + (ch >= '\u06F0' ? -1728 : -1584))
  )
}

export function formatNumber(n) {
  if (n === '' || n === null || n === undefined) return ''
  const num = typeof n === 'string' ? n.replace(/[^\d.-]/g, '') : n
  if (num === '' || isNaN(num)) return ''
  return Number(num).toLocaleString('en-US')
}

export function formatInput(el) {
  let raw = el.value.replace(/[^\d-]/g, '')
  // Handle negative sign at the beginning
  if (raw.startsWith('-')) {
    raw = '-' + raw.replace(/-/g, '')
  } else {
    raw = raw.replace(/-/g, '')
  }
  el.value = raw ? Number(raw).toLocaleString('en-US') : ''
}

export function unformatInput(el) {
  return el.value.replace(/[^\d-]/g, '')
}

/** Close all toolbar export/import action menus */
export function closeAllToolbarActions() {
  document.querySelectorAll('.toolbar-actions-dropdown').forEach(dd => {
    dd.hidden = true
  })
}

/** Toggle one toolbar actions dropdown (closes others first) */
export function toggleToolbarActions(btn, event) {
  event?.stopPropagation?.()
  const wrap = btn?.closest?.('.toolbar-actions')
  const dd = wrap?.querySelector?.('.toolbar-actions-dropdown')
  if (!dd) return
  const willOpen = dd.hidden
  closeAllToolbarActions()
  if (willOpen) dd.hidden = false
}

let toolbarActionsInited = false
export function initToolbarActionsMenus() {
  if (toolbarActionsInited) return
  toolbarActionsInited = true
  document.addEventListener('click', (e) => {
    if (e.target?.closest?.('.toolbar-actions')) return
    closeAllToolbarActions()
  })
}

/** Show/hide export-import menus based on permissions */
export function syncToolbarActionsMenus() {
  const menus = [
    { id: 'customersActionsMenu', perms: ['customers_export', 'customers_import'] },
    { id: 'followupsActionsMenu', perms: ['followups_export'] },
    { id: 'salesActionsMenu', perms: ['sales_export', 'sales_import'] },
  ]
  for (const { id, perms } of menus) {
    const el = document.getElementById(id)
    if (!el) continue
    el.style.display = perms.some(p => hasPermission(p)) ? '' : 'none'
  }
}

/**
 * Shared list-search (same behavior as accounting tab).
 * Matches query against any of the provided field values (id, name, phone, advisor, product, depositor, …).
 */
export function matchesTabSearch(search, fields = []) {
  const q = toEnDigits(String(search || '')).trim().toLowerCase()
  if (!q) return true
  const phoneQ = q.replace(/\D/g, '')
  return fields.some(raw => {
    const s = toEnDigits(String(raw ?? '')).trim().toLowerCase()
    if (!s) return false
    if (s.includes(q)) return true
    if (phoneQ && normalizePhone(s).includes(phoneQ)) return true
    return false
  })
}

/** Collect product names + depositor names from a customer for search parity with accounting. */
export function getCustomerSearchExtras(customer) {
  const products = []
  const depositors = []
  ;(customer?.products || []).forEach(p => {
    ensureProductPayments(p)
    if (p.name) products.push(p.name)
    ;(p.payments || []).forEach(pay => {
      if (pay.depositorName) depositors.push(pay.depositorName)
    })
    if (p.depositorName) depositors.push(p.depositorName)
  })
  return { products, depositors }
}

export function escapeHtml(str) {
  if (!str) return ''
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/`/g, '&#96;')
}

export function escapeAttr(str) {
  if (str === null || str === undefined) return ''
  return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

let toastTimer = null

export function showToast(msg) {
  const t = document.getElementById('toast')
  if (!t) return
  if (toastTimer) clearTimeout(toastTimer)
  t.textContent = msg
  t.classList.remove('show')
  void t.offsetWidth // force reflow
  t.classList.add('show')
  toastTimer = setTimeout(() => t.classList.remove('show'), 2500)
}

// ============================================
// Jalali Date Utilities
// ============================================

export function toJalali(gregorian) {
  const gy = gregorian.getFullYear()
  const gm = gregorian.getMonth() + 1
  const gd = gregorian.getDate()

  const g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]
  let gy2 = (gm > 2) ? (gy + 1) : gy
  let days = 355666 + (365 * gy) + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100) + Math.floor((gy2 + 399) / 400) + gd + g_d_m[gm - 1]
  let jy = -1595 + (33 * Math.floor(days / 12053))
  days %= 12053
  jy += 4 * Math.floor(days / 1461)
  days %= 1461
  if (days > 365) {
    jy += Math.floor((days - 1) / 365)
    days = (days - 1) % 365
  }
  let jm, jd
  if (days < 186) {
    jm = 1 + Math.floor(days / 31)
    jd = 1 + (days % 31)
  } else {
    jm = 7 + Math.floor((days - 186) / 30)
    jd = 1 + ((days - 186) % 30)
  }
  return { year: jy, month: jm, day: jd }
}

// Returns a numeric representation of a Jalali date for comparison/sorting.
// Empty/invalid dates return 99999999 (sorts to end of list).
export function jalaliToNum(dateStr) {
  if (!dateStr) return 99999999
  const datePart = toEnDigits(String(dateStr)).trim().split(/\s+/)[0] || ''
  const parts = datePart.split('/')
  if (parts.length !== 3) return 99999999
  const y = parseInt(parts[0], 10) || 0
  const m = parseInt(parts[1], 10) || 0
  const d = parseInt(parts[2], 10) || 0
  if (!y || !m || !d) return 99999999
  return y * 10000 + m * 100 + d
}

export function getTodayJalaliStr() {
  // Use Asia/Tehran timezone for consistent Jalali dates
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tehran' }))
  const j = toJalali(now)
  return `${j.year}/${String(j.month).padStart(2, '0')}/${String(j.day).padStart(2, '0')}`
}

export function getTodayJalaliNum() {
  return jalaliToNum(getTodayJalaliStr())
}

export function isJalaliLeap(y) {
  return ((y + 2346) % 33) % 4 === 1
}

export function jalaliAddDays(dateStr, days) {
  const parts = dateStr.split('/').map(Number)
  let y = parts[0], m = parts[1], d = parts[2] + days
  // Jalali leap year check: Esfand has 30 days in leap years
  const daysInMonth = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, isJalaliLeap(y) ? 30 : 29]
  while (d > daysInMonth[m - 1]) { d -= daysInMonth[m - 1]; m++; if (m > 12) { m = 1; y++; } }
  while (d <= 0) { m--; if (m < 1) { m = 12; y--; } d += daysInMonth[m - 1] }
  return y * 10000 + m * 100 + d
}

/** Day-serial for Jalali YYYY/MM/DD (relative diffs are exact). */
function jalaliDaySerial(dateStr) {
  const part = jalaliDatePart(dateStr)
  const num = jalaliToNum(part)
  if (num === 99999999) return null
  const y = Math.floor(num / 10000)
  const m = Math.floor((num % 10000) / 100)
  const d = num % 100
  let days = 0
  for (let yy = 1; yy < y; yy++) days += isJalaliLeap(yy) ? 366 : 365
  const dim = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, isJalaliLeap(y) ? 30 : 29]
  for (let mm = 1; mm < m; mm++) days += dim[mm - 1]
  return days + d
}

/** Difference in whole days: to − from. Null if either date invalid. */
export function jalaliDiffDays(fromStr, toStr) {
  const a = jalaliDaySerial(fromStr)
  const b = jalaliDaySerial(toStr)
  if (a == null || b == null) return null
  return b - a
}

/** ISO / Date → Jalali YYYY/MM/DD in Asia/Tehran */
export function gregorianToJalaliStr(input) {
  if (!input) return ''
  const d = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(d.getTime())) return ''
  const tehran = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Tehran' }))
  const j = toJalali(tehran)
  return `${j.year}/${String(j.month).padStart(2, '0')}/${String(j.day).padStart(2, '0')}`
}

/**
 * LRFM metrics for customer panel:
 * L = days since first entry into the program
 * R = last follow-up date (Jalali string)
 * F = average days between consecutive follow-up dates
 * M = sum of approved payments
 */
export function computeCustomerLrfm(customer, followups = []) {
  const empty = { L: null, R: '', F: null, M: 0 }
  if (!customer) return empty

  let monetary = 0
  ;(customer.products || []).forEach(p => {
    ensureProductPayments(p)
    monetary += getApprovedPaid(p)
  })

  const customerFollowups = followups.filter(f => f.customerId === customer.id)
  const followupDates = customerFollowups
    .map(f => jalaliDatePart(f.date))
    .filter(d => jalaliToNum(d) !== 99999999)
    .sort((a, b) => jalaliToNum(a) - jalaliToNum(b))

  const uniqueFollowupNums = []
  const uniqueFollowupDates = []
  followupDates.forEach(d => {
    const n = jalaliToNum(d)
    if (uniqueFollowupNums[uniqueFollowupNums.length - 1] === n) return
    uniqueFollowupNums.push(n)
    uniqueFollowupDates.push(d)
  })

  let freqAvg = null
  if (uniqueFollowupDates.length >= 2) {
    let sum = 0
    for (let i = 1; i < uniqueFollowupDates.length; i++) {
      sum += jalaliDiffDays(uniqueFollowupDates[i - 1], uniqueFollowupDates[i]) || 0
    }
    freqAvg = Math.round(sum / (uniqueFollowupDates.length - 1))
  }

  const lastFollowup = uniqueFollowupDates.length
    ? uniqueFollowupDates[uniqueFollowupDates.length - 1]
    : ''

  let entryJalali = customer.createdAt ? gregorianToJalaliStr(customer.createdAt) : ''
  if (!entryJalali || jalaliToNum(entryJalali) === 99999999) {
    const acts = getCustomerActivities(customer, followups)
    if (acts.length) {
      const earliest = acts.reduce((min, a) => (a.dateNum < min.dateNum ? a : min), acts[0])
      entryJalali = jalaliDatePart(earliest.dateStr)
    }
  }

  let lengthDays = null
  if (entryJalali && jalaliToNum(entryJalali) !== 99999999) {
    lengthDays = Math.max(0, jalaliDiffDays(entryJalali, getTodayJalaliStr()) ?? 0)
  }

  return { L: lengthDays, R: lastFollowup, F: freqAvg, M: monetary }
}

// ============================================
// Customer loyalty levels
// ============================================

export const CUSTOMER_LEVELS = {
  bronze: { key: 'bronze', label: 'برنزی', emoji: '🥉' },
  silver: { key: 'silver', label: 'نقره‌ای', emoji: '🥈' },
  gold: { key: 'gold', label: 'طلایی', emoji: '🥇' },
  vip: { key: 'vip', label: 'VIP', emoji: '🎖' },
  cip: { key: 'cip', label: 'CIP', emoji: '🏆' }
}

export function formatCustomerLevel(level) {
  const meta = CUSTOMER_LEVELS[level]
  if (!meta) return '—'
  return `${meta.emoji} ${meta.label}`
}

/** Map import / UI labels → level key */
export function parseCustomerLevel(raw) {
  const t = toEnDigits(String(raw || '')).trim().toLowerCase()
  if (!t) return ''
  const cleaned = t.replace(/[🥇🥈🥉🎖🏆]/g, '').trim()
  const map = {
    bronze: 'bronze', 'برنزی': 'bronze', 'bronze': 'bronze',
    silver: 'silver', 'نقره ای': 'silver', 'نقره‌ای': 'silver', 'نقره\u200cای': 'silver',
    gold: 'gold', 'طلایی': 'gold',
    vip: 'vip', 'وی آی پی': 'vip', 'ویایپی': 'vip',
    cip: 'cip', 'سی آی پی': 'cip', 'سیایپی': 'cip'
  }
  if (map[cleaned]) return map[cleaned]
  if (map[t]) return map[t]
  if (t.includes('cip') || t.includes('سی آی پی') || t.includes('سیایپی')) return 'cip'
  if (t.includes('vip') || t.includes('وی آی پی')) return 'vip'
  if (t.includes('طلا')) return 'gold'
  if (t.includes('نقره')) return 'silver'
  if (t.includes('برنز')) return 'bronze'
  return ''
}

export function countCustomerPurchases(customer) {
  return (customer?.products || []).filter(p => {
    ensureProductPayments(p)
    return isProductCountableInSales(p)
  }).length
}

export function hasInPersonPurchase(customer) {
  return (customer?.products || []).some(p => {
    ensureProductPayments(p)
    if (!isProductCountableInSales(p)) return false
    return String(p.name || '').includes('حضوری')
  })
}

export function countCustomerReferrals(customer, allCustomers = []) {
  const phones = getCustomerPhones(customer)
  if (!phones.length) return 0
  const set = new Set(phones)
  return (allCustomers || []).filter(c =>
    c.id !== customer.id && set.has(normalizePhone(c.referredByPhone))
  ).length
}

/**
 * Auto level rules:
 * bronze: ≥1 purchase
 * silver: ≥3 purchases
 * gold: ≥5 purchases AND ≥1 year with brand
 * vip: ≥5 purchases AND ≥1 in-person course AND ≥1 year
 * cip: ≥5 referred customers
 * Priority: cip > vip > gold > silver > bronze
 */
export function computeAutoCustomerLevel(customer, allCustomers = [], followups = []) {
  if (!customer) return ''
  const purchases = countCustomerPurchases(customer)
  const days = computeCustomerLrfm(customer, followups).L
  const oneYear = days != null && days >= 365
  const inPerson = hasInPersonPurchase(customer)
  const refs = countCustomerReferrals(customer, allCustomers)

  if (refs >= 5) return 'cip'
  if (purchases >= 5 && inPerson && oneYear) return 'vip'
  if (purchases >= 5 && oneYear) return 'gold'
  if (purchases >= 3) return 'silver'
  if (purchases >= 1) return 'bronze'
  return ''
}

/** Effective level: locked manual/import value, else auto. */
export function resolveCustomerLevel(customer, allCustomers = [], followups = []) {
  if (!customer) return ''
  if (customer.customerLevelLocked) {
    return parseCustomerLevel(customer.customerLevel) || customer.customerLevel || ''
  }
  return computeAutoCustomerLevel(customer, allCustomers, followups)
}

/** Update customer.customerLevel when not locked. Returns level. */
export function syncCustomerLevel(customer, allCustomers = [], followups = []) {
  if (!customer) return ''
  if (customer.customerLevelLocked) {
    return parseCustomerLevel(customer.customerLevel) || customer.customerLevel || ''
  }
  const level = computeAutoCustomerLevel(customer, allCustomers, followups)
  customer.customerLevel = level
  return level
}

/** Current Jalali date + time in Asia/Tehran, e.g. "1404/04/15 14:30" (24h) */
export function getNowJalaliDateTime() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tehran' }))
  const j = toJalali(now)
  const date = `${j.year}/${String(j.month).padStart(2, '0')}/${String(j.day).padStart(2, '0')}`
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  return { date, time, dateTime: `${date} ${time}` }
}

/**
 * Normalize any time string to 24h "HH:MM" (no AM/PM).
 * Accepts: "14:30", "2:30 PM", "02:30:00", "2:30 ب.ظ"
 */
export function normalizeTimeTo24h(timeStr) {
  if (!timeStr) return ''
  let t = toEnDigits(String(timeStr).trim())
  if (!t) return ''

  let isPm = false
  let isAm = false
  if (/\bP\.?M\.?\b/i.test(t) || /ب\.?\s*ظ/i.test(t)) isPm = true
  if (/\bA\.?M\.?\b/i.test(t) || /ق\.?\s*ظ/i.test(t)) isAm = true
  t = t.replace(/\b(A\.?M\.?|P\.?M\.?)\b/ig, '').replace(/[قب]\.?\s*ظ\.?/ig, '').trim()

  const m = t.match(/^(\d{1,2}):(\d{2})(?::\d{2})?/)
  if (!m) return ''
  let h = parseInt(m[1], 10)
  const min = parseInt(m[2], 10)
  if (Number.isNaN(h) || Number.isNaN(min) || min < 0 || min > 59) return ''

  if (isPm || isAm) {
    if (h < 1 || h > 12) return ''
    if (isPm && h < 12) h += 12
    if (isAm && h === 12) h = 0
  } else if (h > 23) {
    return ''
  }

  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

/** Extract HH:MM (24h) from soldAt "date time" or bare time */
export function soldAtTimePart(soldAt) {
  const raw = toEnDigits(String(soldAt || '')).trim()
  if (!raw) return ''
  const parts = raw.split(/\s+/)
  if (parts.length < 2) return normalizeTimeTo24h(parts[0])
  return normalizeTimeTo24h(parts.slice(1).join(' '))
}

/** Format soldAt for display with 24h clock */
export function formatSoldAt24h(soldAt) {
  const date = jalaliDatePart(soldAt)
  const time = soldAtTimePart(soldAt)
  if (date && time) return `${date} ${time}`
  return date || time || ''
}

/** Extract Jalali YYYY/MM/DD from "1404/04/15" or "1404/04/15 14:30" */
export function jalaliDatePart(dateStr) {
  if (!dateStr) return ''
  return toEnDigits(String(dateStr)).trim().split(/\s+/)[0] || ''
}

export function activityDateNum(dateStr) {
  return jalaliToNum(jalaliDatePart(dateStr))
}

/** Activities = followups + sales with soldAt */
export function getCustomerActivities(customer, followups = []) {
  if (!customer) return []
  const acts = []

  followups.filter(f => f.customerId === customer.id).forEach(f => {
    const dateNum = activityDateNum(f.date)
    if (dateNum === 99999999) return
    acts.push({
      kind: 'followup',
      dateStr: f.date,
      dateNum,
      byPhone: normalizePhone(f.createdByPhone || customer.advisorPhone),
      label: 'پیگیری'
    })
  })

  ;(customer.products || []).forEach(p => {
    ensureProductPayments(p)
    const pays = Array.isArray(p.payments) ? p.payments : []
    if (pays.length === 0 && p.soldAt) {
      const dateNum = activityDateNum(p.soldAt)
      if (dateNum === 99999999) return
      acts.push({
        kind: 'sale',
        dateStr: p.soldAt,
        dateNum,
        byPhone: normalizePhone(p.soldByPhone || customer.advisorPhone),
        label: 'فروش'
      })
      return
    }
    pays.forEach(pay => {
      if (!pay.soldAt) return
      const dateNum = activityDateNum(pay.soldAt)
      if (dateNum === 99999999) return
      acts.push({
        kind: 'sale',
        dateStr: pay.soldAt,
        dateNum,
        byPhone: normalizePhone(pay.soldByPhone || p.soldByPhone || customer.advisorPhone),
        label: 'فروش'
      })
    })
  })

  acts.sort((a, b) => b.dateNum - a.dateNum)
  return acts
}

export function getLastActivity(customer, followups = []) {
  return getCustomerActivities(customer, followups)[0] || null
}

/** True if another user logged followup/sale within the last `days` days (rolling). */
export function hasRecentActivityByOther(customer, followups, userPhone, days = 30) {
  const myPhone = normalizePhone(userPhone)
  const cutoff = jalaliAddDays(getTodayJalaliStr(), -days)
  return getCustomerActivities(customer, followups).some(a =>
    a.dateNum >= cutoff && a.byPhone && a.byPhone !== myPhone
  )
}

/** Max mobile numbers allowed per customer */
export const MAX_CUSTOMER_PHONES = 3

/**
 * Normalize a customer (or raw phone / phones list) into a unique array of
 * valid Iranian mobiles (09XXXXXXXXX), capped at MAX_CUSTOMER_PHONES.
 */
export function normalizeCustomerPhones(source) {
  let raw = []
  if (Array.isArray(source)) {
    raw = source
  } else if (source && typeof source === 'object') {
    if (Array.isArray(source.phones) && source.phones.length) {
      raw = source.phones
    } else if (source.phone) {
      raw = [source.phone]
    }
  } else if (typeof source === 'string' && source.trim()) {
    raw = source.split(/[,،;/|\n]+/)
  }

  const seen = new Set()
  const out = []
  for (const item of raw) {
    const n = normalizePhone(item)
    if (!n || !/^09\d{9}$/.test(n)) continue
    if (seen.has(n)) continue
    seen.add(n)
    out.push(n)
    if (out.length >= MAX_CUSTOMER_PHONES) break
  }
  return out
}

/** Phones array for a customer (compat with legacy `phone` field). */
export function getCustomerPhones(customer) {
  return normalizeCustomerPhones(customer)
}

/** First phone — kept for display / legacy call sites. */
export function getPrimaryPhone(customer) {
  return getCustomerPhones(customer)[0] || ''
}

/** True if any of the customer's phones matches `phone`. */
export function customerHasPhone(customer, phone) {
  const n = normalizePhone(phone)
  if (!n) return false
  return getCustomerPhones(customer).includes(n)
}

/**
 * Compact table display: first phone, plus "+N" when more exist.
 * Returns { text, extra } where extra is the count beyond the first.
 */
export function formatPhonesDisplay(customer) {
  const phones = getCustomerPhones(customer)
  if (!phones.length) return { text: '', extra: 0, phones }
  return { text: phones[0], extra: Math.max(0, phones.length - 1), phones }
}

/** Find customer that owns this phone on any of their numbers. */
export function findCustomerByPhone(phone, customers, excludeId = null) {
  const n = normalizePhone(phone)
  if (!n || !/^09\d{9}$/.test(n)) return null
  return (customers || []).find(c =>
    (!excludeId || c.id !== excludeId) && customerHasPhone(c, n)
  ) || null
}

/** Alias — same semantics as findCustomerByPhone after multi-phone upgrade. */
export function findCustomerByAnyPhone(phone, customers, excludeId = null) {
  return findCustomerByPhone(phone, customers, excludeId)
}

// ============================================
// Permission System
// ============================================

export const ALL_PERMISSIONS = {
  dashboard: 'مشاهده داشبورد',
  customers_view: 'مشاهده مشتریان',
  customers_ld: 'مشاهده لیدها (LD)',
  customers_cs: 'مشاهده مشتریان تماسی (CS)',
  customers_add: 'افزودن و ویرایش مشتری',
  customers_delete: 'حذف مشتری',
  customers_import: 'ایمپورت اکسل مشتریان',
  customers_export: 'خروجی مشتریان',
  followups_view: 'مشاهده پیگیری‌ها',
  followups_add: 'افزودن و ویرایش پیگیری',
  followups_delete: 'حذف پیگیری',
  followups_export: 'خروجی پیگیری‌ها',
  sales_view: 'مشاهده فروش‌ها',
  sales_import: 'ایمپورت فروش',
  sales_add_others: 'ثبت فروش برای مشتریان دیگران',
  sales_export: 'خروجی فروش‌ها',
  accounting: 'تأیید واریزی‌ها (حسابداری)'
}

export const PERMISSION_GROUPS = [
  { label: 'داشبورد', keys: ['dashboard'] },
  { label: 'مشتریان', keys: ['customers_view', 'customers_ld', 'customers_cs', 'customers_add', 'customers_delete', 'customers_import', 'customers_export'] },
  { label: 'پیگیری‌ها', keys: ['followups_view', 'followups_add', 'followups_delete', 'followups_export'] },
  { label: 'فروش‌ها', keys: ['sales_view', 'sales_add_others', 'sales_import', 'sales_export'] },
  { label: 'حسابداری', keys: ['accounting'] }
]

export const PAYMENT_STATUS = {
  pending: 'pending',
  approved: 'approved',
  rejected: 'rejected'
}

export const PAYMENT_STATUS_LABELS = {
  pending: 'در انتظار تأیید',
  approved: 'تأیید شده',
  rejected: 'رد شده'
}

let _paySeq = 0
export function createPayment(overrides = {}) {
  const { dateTime } = getNowJalaliDateTime()
  _paySeq += 1
  return {
    id: `pay_${Date.now()}_${_paySeq}`,
    amount: '',
    soldAt: dateTime,
    depositorName: '',
    destinationBank: '',
    paymentStatus: PAYMENT_STATUS.pending,
    paymentRejectReason: '',
    paymentReviewedAt: '',
    paymentReviewedBy: '',
    soldByPhone: '',
    ...overrides
  }
}

/** Migrate legacy single-payment product fields into payments[] (in-memory). */
export function ensureProductPayments(product) {
  if (!product) return product
  if (Array.isArray(product.payments)) return product

  const price = parseFloat(product.price) || 0
  const deposit = parseFloat(product.deposit) || 0
  let amount = 0
  if (product.status === 'بیعانه' && deposit > 0) amount = deposit
  else if (price > 0) amount = price
  else if (deposit > 0) amount = deposit

  const hasLegacy = amount > 0 || product.soldAt || product.depositorName || product.paymentStatus
  if (hasLegacy) {
    product.payments = [createPayment({
      amount: amount ? String(amount) : '',
      soldAt: product.soldAt || getNowJalaliDateTime().dateTime,
      depositorName: product.depositorName || '',
      destinationBank: product.destinationBank || '',
      paymentStatus: product.paymentStatus || PAYMENT_STATUS.approved,
      paymentRejectReason: product.paymentRejectReason || '',
      paymentReviewedAt: product.paymentReviewedAt || '',
      paymentReviewedBy: product.paymentReviewedBy || '',
      soldByPhone: product.soldByPhone || ''
    })]
  } else {
    product.payments = []
  }
  return product
}

export function getPaymentEntryStatus(payment) {
  if (!payment) return PAYMENT_STATUS.approved
  if (!payment.paymentStatus) return PAYMENT_STATUS.approved
  return payment.paymentStatus
}

export function getProductPayments(product) {
  ensureProductPayments(product)
  return product.payments || []
}

export function sumProductPayments(product, predicate) {
  return getProductPayments(product).reduce((sum, pay) => {
    if (predicate && !predicate(pay)) return sum
    return sum + (parseFloat(pay.amount) || 0)
  }, 0)
}

export function getApprovedPaid(product) {
  return sumProductPayments(product, p => getPaymentEntryStatus(p) === PAYMENT_STATUS.approved)
}

/** Paid amounts that count toward sales (exclude rejected). */
export function getCountablePaid(product) {
  return sumProductPayments(product, p => getPaymentEntryStatus(p) !== PAYMENT_STATUS.rejected)
}

export function getProductBalance(product) {
  const price = parseFloat(product?.price) || 0
  return Math.max(0, price - getApprovedPaid(product))
}

/** Remaining after approved + pending (excludes rejected) — for next deposit UX */
export function getOperationalBalance(product) {
  const price = parseFloat(product?.price) || 0
  return Math.max(0, price - getCountablePaid(product))
}

/** Amount / date / time / destination bank present (depositor optional) */
export function isPaymentFilled(payment) {
  if (!payment) return false
  const amount = parseFloat(payment.amount) || 0
  const soldAt = toEnDigits(String(payment.soldAt || '')).trim()
  const parts = soldAt.split(/\s+/)
  const hasDate = !!(parts[0] && parts[0].split('/').length === 3)
  const time24 = normalizeTimeTo24h(parts.slice(1).join(' '))
  const hasTime = /^\d{2}:\d{2}/.test(time24)
  const bank = String(payment.destinationBank || '').trim()
  // Legacy approved rows may not have destinationBank yet
  if (getPaymentEntryStatus(payment) === PAYMENT_STATUS.approved) {
    return amount > 0 && hasDate && hasTime
  }
  return amount > 0 && hasDate && hasTime && !!bank
}

export function areProductPaymentsFilled(product) {
  const pays = getProductPayments(product)
  if (pays.length === 0) return true
  return pays.every(isPaymentFilled)
}

/** Price locked once a positive total was saved */
export function isProductPriceLocked(product) {
  if (!product) return false
  if (product.priceLocked === true) return true
  return (parseFloat(product.price) || 0) > 0
}

/**
 * Invoice closed: total price set, approved payments cover it,
 * and every payment is approved (no pending/rejected left).
 */
export function isInvoiceClosed(product) {
  ensureProductPayments(product)
  const price = parseFloat(product?.price) || 0
  if (price <= 0) return false
  const pays = getProductPayments(product)
  if (pays.length === 0) return false
  if (getApprovedPaid(product) < price) return false
  return pays.every(p => getPaymentEntryStatus(p) === PAYMENT_STATUS.approved)
}

/** Auto status from approved payments vs total price. */
export function syncProductStatus(product) {
  ensureProductPayments(product)
  const price = parseFloat(product.price) || 0
  if (price > 0) product.priceLocked = true
  const approved = getApprovedPaid(product)
  product.status = (price > 0 && approved >= price) ? 'تکمیل' : 'بیعانه'
  product.invoiceClosed = isInvoiceClosed(product)
  // Keep legacy deposit mirror for exports/older code paths
  product.deposit = String(approved || '')
  const pays = product.payments || []
  const last = pays[pays.length - 1]
  if (last) {
    product.soldAt = last.soldAt || product.soldAt || ''
    product.depositorName = last.depositorName || ''
    product.paymentStatus = getWorstPaymentStatus(product)
  }
  return product
}

export function productHasRejectedPayment(product) {
  return getProductPayments(product).some(p => getPaymentEntryStatus(p) === PAYMENT_STATUS.rejected)
}

export function isProductCountableInSales(product) {
  const payments = getProductPayments(product)
  if (payments.length === 0) return false
  return payments.some(p => getPaymentEntryStatus(p) !== PAYMENT_STATUS.rejected && (parseFloat(p.amount) || 0) > 0)
}

export function getWorstPaymentStatus(product) {
  const payments = getProductPayments(product)
  if (payments.some(p => getPaymentEntryStatus(p) === PAYMENT_STATUS.rejected)) return PAYMENT_STATUS.rejected
  if (payments.some(p => getPaymentEntryStatus(p) === PAYMENT_STATUS.pending)) return PAYMENT_STATUS.pending
  if (payments.length === 0) return PAYMENT_STATUS.pending
  return PAYMENT_STATUS.approved
}

export function getLatestRejectReason(product) {
  const rejected = getProductPayments(product).filter(p => getPaymentEntryStatus(p) === PAYMENT_STATUS.rejected)
  if (!rejected.length) return ''
  return rejected[rejected.length - 1].paymentRejectReason || ''
}

/** @deprecated use getCountablePaid — kept for older call sites */
export function getPaymentAmount(product) {
  return getCountablePaid(product)
}

/** @deprecated use getWorstPaymentStatus */
export function getPaymentStatus(product) {
  return getWorstPaymentStatus(product)
}

export function getDefaultPermissions() {
  const p = {}
  Object.keys(ALL_PERMISSIONS).forEach(k => p[k] = true)
  p.customers_delete = false
  p.followups_delete = false
  p.sales_add_others = false
  p.accounting = false
  return p
}

export function hasPermission(key) {
  const user = getCurrentUser()
  if (!user) return false
  if (user.role === 'admin') return true
  return user.permissions && user.permissions[key] === true
}

/**
 * Org-wide read for financial roles (admin or accounting).
 * Sales list, dashboard, and similar views use this instead of ownsCustomer.
 */
export function canViewOrgWideData(user = getCurrentUser()) {
  if (!user) return false
  if (user.role === 'admin') return true
  return !!(user.permissions && user.permissions.accounting === true)
}

/** Normalize list of phones granted for extra read access. */
export function normalizeViewUserPhones(raw) {
  if (!raw) return []
  let list = raw
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw) } catch { return [] }
  }
  if (!Array.isArray(list)) return []
  return [...new Set(list.map(p => normalizePhone(p)).filter(Boolean))]
}

/** Phones whose customer data this user may view: self + granted users. */
export function getVisibleAdvisorPhones(user = getCurrentUser()) {
  const phones = new Set()
  if (!user) return phones
  const self = normalizePhone(user.phone)
  if (self) phones.add(self)
  normalizeViewUserPhones(user.viewUserPhones ?? user.permissions?.viewUserPhones)
    .forEach(p => phones.add(p))
  return phones
}

/**
 * Read access to a customer record in lists/dashboard/followups/sales.
 * Admin/accounting → org-wide. Others → own + viewUserPhones grants (view-only for grants).
 */
export function canViewScopedCustomer(customer, user = getCurrentUser()) {
  if (!user || !customer) return false
  if (canViewOrgWideData(user)) return true
  if (ownsCustomer(customer, user)) return true
  const ownerPhone = normalizePhone(customer.advisorPhone)
  if (ownerPhone && getVisibleAdvisorPhones(user).has(ownerPhone)) return true
  return false
}

/** Permissions auto-enabled with accounting (Level-1 accountant pack). */
export const ACCOUNTING_PERMISSION_BUNDLE = [
  'dashboard',
  'sales_view',
  'customers_view',
  'customers_ld',
  'customers_cs'
]

export function applyAccountingPermissionBundle(permissions = {}) {
  const next = { ...permissions }
  if (next.accounting) {
    ACCOUNTING_PERMISSION_BUNDLE.forEach(k => { next[k] = true })
  }
  return next
}

/** Guard for actions — shows toast and returns false when denied. */
export function requirePermission(key) {
  if (hasPermission(key)) return true
  showToast('شما به این بخش دسترسی ندارید')
  return false
}

/** Normalize Iranian mobile to digits starting with 09… */
export function normalizePhone(phone) {
  let p = toEnDigits(String(phone || '').replace(/[\s\-()]/g, ''))
  if (p.startsWith('+98')) p = '0' + p.slice(3)
  else if (p.startsWith('98') && p.length >= 12) p = '0' + p.slice(2)
  else if (p.length === 10 && p.startsWith('9')) p = '0' + p
  return p
}

export function userDisplayName(u) {
  if (!u) return ''
  return u.display_name || u.displayName ||
    `${u.first_name || u.firstName || ''} ${u.last_name || u.lastName || ''}`.trim() ||
    u.username || ''
}

/**
 * Ownership is keyed by advisorPhone (stable). Falls back to display-name
 * match only for legacy rows not yet backfilled.
 */
export function ownsCustomer(customer, user = getCurrentUser()) {
  if (!user || !customer) return false
  if (user.role === 'admin') return true

  const myPhone = normalizePhone(user.phone)
  const ownerPhone = normalizePhone(customer.advisorPhone)
  if (myPhone && ownerPhone) return myPhone === ownerPhone

  const myName = userDisplayName(user).trim()
  const advisorName = (customer.advisor || '').trim()
  if (myName && advisorName) return myName === advisorName
  return false
}

/** View by LD/CS permission (search / collaboration). */
export function canViewCustomer(customer, user = getCurrentUser()) {
  if (!user || !customer) return false
  if (customer.id.startsWith('LD') && !hasPermission('customers_ld')) return false
  if (customer.id.startsWith('CS') && !hasPermission('customers_cs')) return false
  return true
}

/** Edit core fields / delete / change owner: owner or admin. */
export function canManageCustomer(customer, user = getCurrentUser()) {
  if (!canViewCustomer(customer, user)) return false
  if (user.role === 'admin') return true
  return ownsCustomer(customer, user)
}

/** @deprecated use canViewCustomer / canManageCustomer */
export function canAccessCustomer(customer, user = getCurrentUser()) {
  return canManageCustomer(customer, user)
}

/** Resolve advisor display name + phone from a phone value and users list */
export function resolveAdvisor(advisorPhoneOrName, users = []) {
  const raw = String(advisorPhoneOrName || '').trim()
  const asPhone = normalizePhone(raw)
  let user = null
  if (asPhone && /^09\d{9}$/.test(asPhone)) {
    user = users.find(u => normalizePhone(u.phone) === asPhone)
  }
  if (!user && raw) {
    user = users.find(u => userDisplayName(u) === raw)
  }
  if (user) {
    return { advisorPhone: normalizePhone(user.phone), advisor: userDisplayName(user) }
  }
  if (asPhone && /^09\d{9}$/.test(asPhone)) {
    return { advisorPhone: asPhone, advisor: raw }
  }
  return { advisorPhone: '', advisor: raw }
}

// ============================================
// Session (signed localStorage + server revalidation)
// ============================================

const SESSION_KEY = 'campaign_manager_session'
const SESSION_EXPIRY_HOURS = 24
const SESSION_SECRET = import.meta.env.VITE_HASH_SECRET || 'c4mp_m4n4g3r_s3cr3t_k3y_2024'

let cachedUser = null

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
}

async function signSessionPayload(payload) {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(stableStringify(payload)))
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Sync read of verified in-memory session (call restoreSession first). */
export function getCurrentUser() {
  return cachedUser
}

/** Verify HMAC envelope from localStorage and hydrate cache (SEC-M2). */
export async function restoreSession() {
  cachedUser = null
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null

    const envelope = JSON.parse(raw)
    if (!envelope || !envelope.data || !envelope.sig || !envelope.expiresAt) {
      localStorage.removeItem(SESSION_KEY)
      return null
    }

    if (Date.now() > envelope.expiresAt) {
      localStorage.removeItem(SESSION_KEY)
      return null
    }

    const payload = { data: envelope.data, expiresAt: envelope.expiresAt }
    const expectedSig = await signSessionPayload(payload)
    if (envelope.sig !== expectedSig) {
      localStorage.removeItem(SESSION_KEY)
      return null
    }

    cachedUser = { ...envelope.data, expiresAt: envelope.expiresAt }
    return cachedUser
  } catch (e) {
    localStorage.removeItem(SESSION_KEY)
    cachedUser = null
    return null
  }
}

export async function setCurrentUser(user) {
  const permissions = user.permissions || null
  const data = {
    username: user.username,
    displayName: user.displayName,
    firstName: user.firstName || null,
    lastName: user.lastName || null,
    phone: user.phone || null,
    role: user.role,
    permissions,
    viewUserPhones: normalizeViewUserPhones(user.viewUserPhones ?? permissions?.viewUserPhones)
  }
  const expiresAt = Date.now() + (SESSION_EXPIRY_HOURS * 60 * 60 * 1000)
  const payload = { data, expiresAt }
  const sig = await signSessionPayload(payload)
  const envelope = { ...payload, sig }

  cachedUser = { ...data, expiresAt }
  localStorage.setItem(SESSION_KEY, JSON.stringify(envelope))
  return cachedUser
}

export function clearCurrentUser() {
  cachedUser = null
  localStorage.removeItem(SESSION_KEY)
}

export function isAdmin() {
  const user = getCurrentUser()
  return user && user.role === 'admin'
}

/** Primary admins only (role admin / seeded admin / configured admin phone). */
export function isMainAdmin(user = getCurrentUser()) {
  if (!user) return false
  if (user.role === 'admin') return true
  if (user.username === 'admin') return true
  const adminPhone = normalizePhone(ADMIN_PHONE)
  if (adminPhone && normalizePhone(user.phone) === adminPhone) return true
  return false
}

export function requireMainAdmin() {
  if (isMainAdmin()) return true
  showToast('فقط ادمین اصلی به این بخش دسترسی دارد')
  return false
}

// ============================================
// Global digit conversion listener
// ============================================

export function initDigitConversion() {
  document.addEventListener('input', function (e) {
    const el = e.target
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const converted = toEnDigits(el.value)
      if (el.value !== converted) el.value = converted
    }
  })
}
