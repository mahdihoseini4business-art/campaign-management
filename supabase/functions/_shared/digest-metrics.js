/**
 * Pure ops-digest metrics (no DOM / Supabase).
 * Used by ops-digest-cron (Deno) and scripts/test-ops-digest.mjs (Node).
 */

export const DIGEST_KIND_MORNING = 'morning_advisor'
export const DIGEST_KIND_EVENING = 'evening_manager'
export const SYSTEM_DIGEST_PHONE = 'system:digest'
export const SYSTEM_DIGEST_NAME = 'سیستم'

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹'
const EN_DIGITS = '0123456789'
const PAYMENT_APPROVED = 'approved'
const PAYMENT_PENDING = 'pending'
const PAYMENT_REJECTED = 'rejected'

const PLATFORM_FA = {
  instagram: 'اینستاگرام',
  telegram: 'تلگرام',
  whatsapp: 'واتساپ',
  outbound_call: 'تماس خروجی',
  phone: 'تلفن',
  website: 'وب‌سایت',
  other: 'سایر'
}

export function toEnDigits(str) {
  return String(str || '').replace(/[۰-۹]/g, (ch) => {
    const i = FA_DIGITS.indexOf(ch)
    return i >= 0 ? EN_DIGITS[i] : ch
  })
}

/** Normalize to 11-digit 09xxxxxxxxx when possible. */
export function normalizePhone(phone) {
  let p = toEnDigits(String(phone || '')).replace(/\D/g, '')
  if (!p) return ''
  if (p.length > 10) p = p.slice(-10)
  if (p.length === 10 && p.startsWith('9')) p = '0' + p
  return p
}

export function toJalali(gregorian) {
  const gy = gregorian.getFullYear()
  const gm = gregorian.getMonth() + 1
  const gd = gregorian.getDate()

  const g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]
  const gy2 = (gm > 2) ? (gy + 1) : gy
  let days = 355666 + (365 * gy) + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100) + Math.floor((gy2 + 399) / 400) + gd + g_d_m[gm - 1]
  let jy = -1595 + (33 * Math.floor(days / 12053))
  days %= 12053
  jy += 4 * Math.floor(days / 1461)
  days %= 1461
  if (days > 365) {
    jy += Math.floor((days - 1) / 365)
    days = (days - 1) % 365
  }
  let jm
  let jd
  if (days < 186) {
    jm = 1 + Math.floor(days / 31)
    jd = 1 + (days % 31)
  } else {
    jm = 7 + Math.floor((days - 186) / 30)
    jd = 1 + ((days - 186) % 30)
  }
  return { year: jy, month: jm, day: jd }
}

/** Jalali YYYY/MM/DD in Asia/Tehran for a Date (default now). */
export function getTodayJalaliStr(now = new Date()) {
  const tehran = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tehran' }))
  const j = toJalali(tehran)
  return `${j.year}/${String(j.month).padStart(2, '0')}/${String(j.day).padStart(2, '0')}`
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

export function normalizeJalaliDate(dateStr) {
  if (!dateStr) return ''
  return toEnDigits(String(dateStr)).trim().split(/\s+/)[0] || ''
}

export function jalaliDatePart(dateStr) {
  return normalizeJalaliDate(dateStr)
}

export function jalaliToNum(dateStr) {
  if (!dateStr) return 99999999
  const datePart = normalizeJalaliDate(dateStr)
  const parts = datePart.split('/')
  if (parts.length !== 3) return 99999999
  const y = parseInt(parts[0], 10) || 0
  const m = parseInt(parts[1], 10) || 0
  const d = parseInt(parts[2], 10) || 0
  if (!y || !m || !d) return 99999999
  return y * 10000 + m * 100 + d
}

export function jalaliNumToStr(n) {
  if (!Number.isFinite(n) || n === 99999999) return ''
  const y = Math.floor(n / 10000)
  const m = Math.floor((n % 10000) / 100)
  const d = n % 100
  return `${y}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`
}

export function isJalaliLeap(y) {
  return ((y + 2346) % 33) % 4 === 1
}

/** Returns numeric yyyymmdd after adding days to a Jalali date string. */
export function jalaliAddDays(dateStr, days) {
  const parts = normalizeJalaliDate(dateStr).split('/').map(Number)
  let y = parts[0]
  let m = parts[1]
  let d = parts[2] + days
  const daysInMonth = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, isJalaliLeap(y) ? 30 : 29]
  while (d > daysInMonth[m - 1]) {
    d -= daysInMonth[m - 1]
    m++
    if (m > 12) {
      m = 1
      y++
    }
  }
  while (d <= 0) {
    m--
    if (m < 1) {
      m = 12
      y--
    }
    const dim = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, isJalaliLeap(y) ? 30 : 29]
    d += dim[m - 1]
  }
  return y * 10000 + m * 100 + d
}

export function jalaliAddDaysStr(dateStr, days) {
  return jalaliNumToStr(jalaliAddDays(dateStr, days))
}

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

/** today | waiting | overdue | null */
export function classifyFollowupDate(dateStr, todayStr) {
  const num = jalaliToNum(dateStr)
  if (num === 99999999) return null
  const todayN = jalaliToNum(todayStr)
  if (num < todayN) return 'overdue'
  if (num === todayN) return 'today'
  return 'waiting'
}

export function isDoneFollowup(f) {
  if (!f) return false
  if (f.status === 'done') return true
  const t = f.type || ''
  return t === 'پیگیری انجام‌شده' || t === 'پیگیری معوقه انجام‌شده'
}

export function isOpenAssignedFollowup(f) {
  if (!f) return false
  if (!normalizePhone(f.assigned_to_phone || f.assignedToPhone)) return false
  if (!normalizeJalaliDate(f.next_date || f.nextDate)) return false
  if (isDoneFollowup(f) || f.status === 'done') return false
  return true
}

export function formatFaNumber(n) {
  const num = Number(n)
  if (!Number.isFinite(num)) return '۰'
  try {
    return Math.round(num).toLocaleString('fa-IR')
  } catch {
    return String(Math.round(num))
  }
}

export function formatMoneyShort(amount) {
  const v = Math.round(Number(amount) || 0)
  if (Math.abs(v) >= 1e9) {
    const b = Math.round(v / 1e8) / 10
    return `${formatFaNumber(b)} میلیارد`
  }
  if (Math.abs(v) >= 1e6) {
    const m = Math.round(v / 1e5) / 10
    return `${formatFaNumber(m)} میلیون`
  }
  return formatFaNumber(v)
}

export function platformLabel(platform) {
  const key = String(platform || '').trim().toLowerCase()
  if (!key) return ''
  return PLATFORM_FA[key] || platform
}

export function displayNameFromUser(u) {
  if (!u) return ''
  return u.display_name || u.displayName ||
    `${u.first_name || u.firstName || ''} ${u.last_name || u.lastName || ''}`.trim() ||
    u.username || ''
}

export function buildPhoneNameMap(users = []) {
  const map = {}
  for (const u of users || []) {
    const phone = normalizePhone(u.phone)
    if (!phone) continue
    const name = displayNameFromUser(u)
    if (name) map[phone] = name
  }
  return map
}

function resolveAdvisorName(phone, phoneNames, fallback) {
  const p = normalizePhone(phone)
  if (p && phoneNames && phoneNames[p]) return phoneNames[p]
  if (fallback) return String(fallback).trim()
  if (p) return p.slice(0, 4) + '…' + p.slice(-4)
  return '—'
}

/* ─── lightweight sales helpers (digest-local; camelCase + snake_case) ─── */

function isGiftSale(product) {
  if (!product || typeof product !== 'object') return false
  if (product.saleType === 'gift' || product.sale_type === 'gift') return true
  return String(product.status || '') === 'هدیه'
}

function isHistoricalImportSale(product) {
  return !!(product && (product.historicalImport || product.historical_import))
}

function getPaymentEntryStatus(payment) {
  if (!payment) return PAYMENT_APPROVED
  const s = payment.paymentStatus || payment.payment_status
  if (!s) return PAYMENT_APPROVED
  return s
}

function ensureProductPayments(product) {
  if (!product) return []
  if (isGiftSale(product)) return Array.isArray(product.payments) ? product.payments : []
  if (Array.isArray(product.payments)) return product.payments

  const price = parseFloat(product.price) || 0
  const deposit = parseFloat(product.deposit) || 0
  let amount = 0
  if (product.status === 'بیعانه' && deposit > 0) amount = deposit
  else if (price > 0) amount = price
  else if (deposit > 0) amount = deposit

  const soldAt = product.soldAt || product.sold_at || ''
  const hasLegacy = amount > 0 || soldAt || product.depositorName || product.depositor_name || product.paymentStatus || product.payment_status
  if (!hasLegacy) {
    product.payments = []
    return product.payments
  }
  product.payments = [{
    amount: amount ? String(amount) : '',
    soldAt: soldAt || '',
    paymentStatus: product.paymentStatus || product.payment_status || PAYMENT_APPROVED,
    soldByPhone: product.soldByPhone || product.sold_by_phone || ''
  }]
  return product.payments
}

function getProductPayments(product) {
  return ensureProductPayments(product) || []
}

function getProductCompletedRefundTotal(product) {
  const list = Array.isArray(product?.refunds) ? product.refunds : []
  return list.reduce((sum, r) => sum + (parseFloat(r?.amount) || 0), 0)
}

function isDealCancelled(product) {
  if (!product || isGiftSale(product)) return false
  return getProductCompletedRefundTotal(product) > 0
}

function getApprovedPaid(product) {
  if (isHistoricalImportSale(product)) return 0
  return getProductPayments(product).reduce((sum, pay) => {
    if (getPaymentEntryStatus(pay) !== PAYMENT_APPROVED) return sum
    return sum + (parseFloat(pay.amount) || 0)
  }, 0)
}

function getProductBalance(product) {
  if (isDealCancelled(product) || isHistoricalImportSale(product)) return 0
  const price = parseFloat(product?.price) || 0
  return Math.max(0, price - getApprovedPaid(product))
}

function isProductCountableInSales(product) {
  if (isHistoricalImportSale(product)) return true
  if (isGiftSale(product)) {
    const s = product.giftAccountingStatus || product.gift_accounting_status || PAYMENT_PENDING
    return s === PAYMENT_APPROVED
  }
  const payments = getProductPayments(product)
  if (!payments.length) return false
  return payments.some(p => getPaymentEntryStatus(p) !== PAYMENT_REJECTED && (parseFloat(p.amount) || 0) > 0)
}

function getSaleRegistrantPhone(product, payment, customer) {
  const fromPay = normalizePhone(payment?.soldByPhone || payment?.sold_by_phone)
  if (fromPay) return fromPay
  const fromProduct = normalizePhone(product?.soldByPhone || product?.sold_by_phone)
  if (fromProduct) return fromProduct
  return normalizePhone(customer?.advisor_phone || customer?.advisorPhone)
}

function customerProducts(c) {
  return Array.isArray(c?.products) ? c.products : []
}

/**
 * Walk countable products' payments matching phoneSet + optional date + status.
 * onProduct called once per product with matching payments; onPayment per payment.
 */
function forEachSalePayment({
  customers = [],
  phoneSet = null,
  dateFromNum = 0,
  dateToNum = 99999999,
  statusFilter = PAYMENT_APPROVED,
  productNames = null,
  onPayment = null,
  onProduct = null
}) {
  const hasDateFilter = dateFromNum > 0 || dateToNum < 99999999
  const productSet = productNames instanceof Set ? productNames : (Array.isArray(productNames) ? new Set(productNames) : null)

  for (const c of customers) {
    for (const p of customerProducts(c)) {
      if (!isProductCountableInSales(p)) continue
      if (productSet && productSet.size && !productSet.has(p.name || '')) continue

      const pays = getProductPayments(p).filter(pay => {
        const amount = parseFloat(pay.amount) || 0
        if (amount <= 0) return false
        if (getPaymentEntryStatus(pay) !== statusFilter) return false
        if (phoneSet) {
          const phone = getSaleRegistrantPhone(p, pay, c)
          if (!phone || !phoneSet.has(phone)) return false
        }
        if (hasDateFilter) {
          const d = jalaliDatePart(pay.soldAt || pay.sold_at)
          const n = jalaliToNum(d)
          if (n === 99999999 || n < dateFromNum || n > dateToNum) return false
        }
        return true
      })
      if (!pays.length) continue

      if (typeof onProduct === 'function') {
        onProduct({
          customer: c,
          product: p,
          payments: pays,
          paidInScope: pays.reduce((sum, pay) => sum + (parseFloat(pay.amount) || 0), 0),
          balance: getProductBalance(p)
        })
      }
      if (typeof onPayment === 'function') {
        for (const pay of pays) {
          onPayment({
            customer: c,
            product: p,
            payment: pay,
            amount: parseFloat(pay.amount) || 0,
            phone: getSaleRegistrantPhone(p, pay, c)
          })
        }
      }
    }
  }
}

export function computeSalesSnapshot({
  customers = [],
  phoneSet = null,
  dateFromNum = 0,
  dateToNum = 99999999
} = {}) {
  let salesCount = 0
  let totalApproved = 0
  let openDepositCount = 0
  let openDepositAmount = 0
  let openBalanceAmount = 0
  let pendingCount = 0
  let pendingAmount = 0
  const byPhone = new Map()

  forEachSalePayment({
    customers,
    phoneSet,
    dateFromNum,
    dateToNum,
    statusFilter: PAYMENT_APPROVED,
    onPayment: ({ amount, phone }) => {
      totalApproved += amount
      if (!phone) return
      if (!byPhone.has(phone)) byPhone.set(phone, { phone, amount: 0, count: 0 })
      const row = byPhone.get(phone)
      row.amount += amount
    },
    onProduct: ({ customer, product, paidInScope, balance, payments }) => {
      salesCount++
      const phones = new Set(
        payments.map(pay => getSaleRegistrantPhone(product, pay, customer)).filter(Boolean)
      )
      for (const phone of phones) {
        if (!byPhone.has(phone)) byPhone.set(phone, { phone, amount: 0, count: 0 })
        byPhone.get(phone).count++
      }
      if (product.status === 'تکمیل' || isDealCancelled(product)) return
      openDepositCount++
      openDepositAmount += paidInScope
      openBalanceAmount += balance
    }
  })

  forEachSalePayment({
    customers,
    phoneSet,
    dateFromNum,
    dateToNum,
    statusFilter: PAYMENT_PENDING,
    onPayment: ({ amount }) => {
      pendingAmount += amount
      pendingCount++
    }
  })

  return {
    salesCount,
    totalApproved,
    openDepositCount,
    openDepositAmount,
    openBalanceAmount,
    pendingCount,
    pendingAmount,
    byPhone
  }
}

/** Open deposits/balances for phoneSet ignoring sale date (current book). */
export function computeOpenBookSnapshot({ customers = [], phoneSet = null } = {}) {
  let openDepositCount = 0
  let openDepositAmount = 0
  let openBalanceAmount = 0

  for (const c of customers) {
    for (const p of customerProducts(c)) {
      if (!isProductCountableInSales(p)) continue
      if (p.status === 'تکمیل' || isDealCancelled(p)) continue
      const pays = getProductPayments(p).filter(pay => {
        const amount = parseFloat(pay.amount) || 0
        if (amount <= 0) return false
        if (getPaymentEntryStatus(pay) !== PAYMENT_APPROVED) return false
        if (phoneSet) {
          const phone = getSaleRegistrantPhone(p, pay, c)
          if (!phone || !phoneSet.has(phone)) return false
        }
        return true
      })
      if (!pays.length) continue
      openDepositCount++
      openDepositAmount += pays.reduce((s, pay) => s + (parseFloat(pay.amount) || 0), 0)
      openBalanceAmount += getProductBalance(p)
    }
  }

  return { openDepositCount, openDepositAmount, openBalanceAmount }
}

function averageDailyApproved({ customers, phoneSet, todayStr, days = 7, excludeToday = true }) {
  if (!todayStr || days <= 0) return 0
  let sum = 0
  let counted = 0
  for (let i = excludeToday ? 1 : 0; i <= (excludeToday ? days : days - 1); i++) {
    const dayStr = jalaliAddDaysStr(todayStr, -i)
    const n = jalaliToNum(dayStr)
    const snap = computeSalesSnapshot({
      customers,
      phoneSet,
      dateFromNum: n,
      dateToNum: n
    })
    sum += snap.totalApproved
    counted++
  }
  return counted > 0 ? sum / counted : 0
}

function trendPct(current, baseline) {
  const c = Number(current) || 0
  const b = Number(baseline) || 0
  if (!(b > 0)) return null
  return Math.round(((c - b) / b) * 100)
}

function formatTrend(pct) {
  if (pct == null) return ''
  if (pct > 0) return `↑ ${formatFaNumber(pct)}٪`
  if (pct < 0) return `↓ ${formatFaNumber(Math.abs(pct))}٪`
  return '≈ بدون تغییر'
}

function computeTargetCurrent(bar, customers, phoneSet) {
  const fromNum = bar.startDate ? jalaliToNum(bar.startDate) : 0
  const toNum = bar.endDate ? jalaliToNum(bar.endDate) : 99999999
  const productSet = (bar.productNames || []).length ? new Set(bar.productNames) : null
  let current = 0
  if (bar.metric === 'count') {
    forEachSalePayment({
      customers,
      phoneSet,
      dateFromNum: fromNum,
      dateToNum: toNum,
      productNames: productSet,
      onProduct: () => { current++ }
    })
  } else {
    forEachSalePayment({
      customers,
      phoneSet,
      dateFromNum: fromNum,
      dateToNum: toNum,
      productNames: productSet,
      onPayment: ({ amount }) => { current += amount }
    })
  }
  return current
}

function targetPace(bar, todayStr, current, goal) {
  const pct = goal > 0 ? Math.round((current / goal) * 1000) / 10 : 0
  const daysLeft = bar.endDate ? jalaliDiffDays(todayStr, bar.endDate) : null
  let timePct = null
  if (bar.startDate && bar.endDate) {
    const span = jalaliDiffDays(bar.startDate, bar.endDate)
    const elapsed = jalaliDiffDays(bar.startDate, todayStr)
    if (span != null && span > 0 && elapsed != null) {
      timePct = Math.min(100, Math.max(0, Math.round((elapsed / span) * 1000) / 10))
    }
  }
  const paceGap = timePct != null ? Math.round((timePct - pct) * 10) / 10 : null
  return { pct, daysLeft, timePct, paceGap }
}

/**
 * Best personal target: member share for phone, else first org bar scoped to phone.
 */
export function pickAdvisorTarget({ salesTargets = [], phone, customers = [], todayStr }) {
  const me = normalizePhone(phone)
  if (!me || !todayStr) return null
  const phoneSet = new Set([me])
  let best = null

  for (const group of salesTargets || []) {
    for (const alloc of group.allocations || []) {
      for (const member of alloc.members || []) {
        if (normalizePhone(member.userPhone || member.user_phone) !== me) continue
        for (const share of member.shares || []) {
          const bar = (group.items || []).find(b => b.id === share.barId)
          if (!bar) continue
          const goal = Number(share.value) || 0
          if (!(goal > 0)) continue
          const current = computeTargetCurrent(bar, customers, phoneSet)
          const pace = targetPace(bar, todayStr, current, goal)
          const candidate = {
            title: group.title || 'تارگت',
            metric: bar.metric === 'count' ? 'count' : 'amount',
            current,
            goal,
            ...pace
          }
          if (!best || (candidate.daysLeft != null && (best.daysLeft == null || candidate.daysLeft < best.daysLeft))) {
            best = candidate
          }
        }
      }
    }
  }

  if (best) return best

  for (const group of salesTargets || []) {
    for (const bar of group.items || []) {
      const goal = Number(bar.value) || 0
      if (!(goal > 0)) continue
      const current = computeTargetCurrent(bar, customers, phoneSet)
      const pace = targetPace(bar, todayStr, current, goal)
      const candidate = {
        title: group.title || 'تارگت',
        metric: bar.metric === 'count' ? 'count' : 'amount',
        current,
        goal,
        ...pace
      }
      if (!best || (candidate.daysLeft != null && (best.daysLeft == null || candidate.daysLeft < best.daysLeft))) {
        best = candidate
      }
    }
  }
  return best
}

/**
 * Best group-allocation target for manager's group ids (team phoneSet).
 */
export function pickGroupTarget({ salesTargets = [], groupIds = [], customers = [], teamPhones = [], todayStr }) {
  const phoneSet = new Set((teamPhones || []).map(normalizePhone).filter(Boolean))
  const groupIdSet = new Set((groupIds || []).filter(Boolean))
  if (!phoneSet.size || !todayStr) return null
  let best = null

  for (const group of salesTargets || []) {
    for (const alloc of group.allocations || []) {
      const gid = alloc.userGroupId || alloc.user_group_id
      if (groupIdSet.size && gid && !groupIdSet.has(gid)) continue
      if (groupIdSet.size && !gid) continue
      for (const share of alloc.shares || []) {
        const bar = (group.items || []).find(b => b.id === share.barId)
        if (!bar) continue
        const goal = Number(share.value) || 0
        if (!(goal > 0)) continue
        const current = computeTargetCurrent(bar, customers, phoneSet)
        const pace = targetPace(bar, todayStr, current, goal)
        const candidate = {
          title: group.title || 'تارگت گروه',
          metric: bar.metric === 'count' ? 'count' : 'amount',
          current,
          goal,
          ...pace
        }
        if (!best || (candidate.daysLeft != null && (best.daysLeft == null || candidate.daysLeft < best.daysLeft))) {
          best = candidate
        }
      }
    }
  }

  if (best) return best

  // Fallback: org target scoped to team
  for (const group of salesTargets || []) {
    for (const bar of group.items || []) {
      const goal = Number(bar.value) || 0
      if (!(goal > 0)) continue
      const current = computeTargetCurrent(bar, customers, phoneSet)
      const pace = targetPace(bar, todayStr, current, goal)
      const candidate = {
        title: group.title || 'تارگت',
        metric: bar.metric === 'count' ? 'count' : 'amount',
        current,
        goal,
        ...pace
      }
      if (!best || (candidate.daysLeft != null && (best.daysLeft == null || candidate.daysLeft < best.daysLeft))) {
        best = candidate
      }
    }
  }
  return best
}

export function countOpenRefunds({ refunds = [], phoneSet = null } = {}) {
  let n = 0
  for (const r of refunds || []) {
    const status = r.status || ''
    if (status !== 'requested' && status !== 'awaiting') continue
    if (phoneSet) {
      const phone = normalizePhone(r.advisor_phone || r.advisorPhone)
      if (!phone || !phoneSet.has(phone)) continue
    }
    n++
  }
  return n
}

function countDoneFollowupsToday({ followups = [], phoneSet = null, todayStr }) {
  let n = 0
  const byPhone = new Map()
  for (const f of followups || []) {
    if (!isDoneFollowup(f)) continue
    const when = jalaliDatePart(f.done_at || f.doneAt || f.date)
    if (when !== todayStr) continue
    const actor = normalizePhone(
      f.done_by_phone || f.doneByPhone || f.created_by_phone || f.createdByPhone
    )
    if (phoneSet && (!actor || !phoneSet.has(actor))) continue
    n++
    if (actor) byPhone.set(actor, (byPhone.get(actor) || 0) + 1)
  }
  return { count: n, byPhone }
}

function countNewLeadsOnDate({ customers = [], phone, dateStr }) {
  const me = normalizePhone(phone)
  if (!me || !dateStr) return 0
  let n = 0
  for (const c of customers) {
    const id = String(c.id || '')
    if (!id.startsWith('LD')) continue
    const owner = normalizePhone(c.advisor_phone || c.advisorPhone)
    if (owner !== me) continue
    const created = c.created_at || c.createdAt
    const j = created ? (String(created).includes('/') ? jalaliDatePart(created) : gregorianToJalaliStr(created)) : ''
    if (j === dateStr) n++
  }
  return n
}

function morningActionLine(counts) {
  if (counts.overdue >= 5) return `اول ${formatFaNumber(Math.min(5, counts.overdue))} معوق را ببند`
  if ((counts.openDepositCount || 0) >= 3 && (counts.overdue || 0) < 3) {
    return 'بیعانه‌های باز را پیگیری کن'
  }
  if (counts.target && counts.target.goal > 0 && counts.target.pct < 50 && (counts.target.timePct == null || counts.target.timePct >= 50)) {
    return 'تمرکز فروش امروز — تارگت عقب است'
  }
  if (counts.today > 0) return `سررسیدهای امروز (${formatFaNumber(counts.today)}) را جمع کن`
  if (counts.assignedOpen > 0) return 'ارجاع‌های باز را تعیین‌تکلیف کن'
  return ''
}

function eveningActionLine(counts) {
  const parts = []
  if (counts.overdueTop?.length) {
    const names = counts.overdueTop.slice(0, 2).map(r => r.name).join(' · ')
    parts.push(`بیشترین معوق: ${names}`)
  }
  if (counts.inactiveToday?.length) {
    parts.push(`بدون فعالیت امروز: ${formatFaNumber(counts.inactiveToday.length)} نفر`)
  }
  if (counts.target && counts.target.paceGap != null && counts.target.paceGap >= 10) {
    parts.push(`تارگت گروه ${formatFaNumber(Math.round(counts.target.paceGap))}٪ عقب است`)
  }
  return parts[0] || ''
}

/**
 * Morning advisor metrics for one phone.
 */
export function countAdvisorMorningMetrics({
  phone,
  customers = [],
  followups = [],
  todayStr,
  salesTargets = [],
  refunds = [],
  phoneNames = {}
}) {
  const me = normalizePhone(phone)
  const empty = {
    overdue: 0,
    today: 0,
    assignedOpen: 0,
    assignedOverdue: 0,
    assignedToday: 0,
    noFollowup: 0,
    overdueTop: [],
    salesYesterdayCount: 0,
    salesYesterdayAmount: 0,
    salesAvg7dAmount: 0,
    salesTrendPct: null,
    openDepositCount: 0,
    openDepositAmount: 0,
    openBalanceAmount: 0,
    pendingCount: 0,
    pendingAmount: 0,
    target: null,
    newLeadsYesterday: 0,
    refundsOpen: 0,
    actionLine: ''
  }
  if (!me || !todayStr) return empty

  const yesterdayStr = jalaliAddDaysStr(todayStr, -1)
  const yesterdayN = jalaliToNum(yesterdayStr)
  const phoneSet = new Set([me])

  let overdue = 0
  let today = 0
  let noFollowup = 0
  const overdueRows = []

  for (const c of customers) {
    const owner = normalizePhone(c.advisor_phone || c.advisorPhone)
    if (owner !== me) continue
    const next = c.next_followup_date || c.nextFollowupDate || ''
    if (!normalizeJalaliDate(next)) {
      noFollowup++
      continue
    }
    const cat = classifyFollowupDate(next, todayStr)
    if (cat === 'overdue') {
      overdue++
      const daysLate = jalaliDiffDays(next, todayStr) || 0
      overdueRows.push({
        name: String(c.name || c.id || 'بدون نام').trim() || 'بدون نام',
        daysLate,
        platform: platformLabel(c.platform || c.platform_id || c.platformId)
      })
    } else if (cat === 'today') today++
  }

  overdueRows.sort((a, b) => b.daysLate - a.daysLate)
  const overdueTop = overdueRows.slice(0, 3)

  let assignedOpen = 0
  let assignedOverdue = 0
  let assignedToday = 0
  for (const f of followups) {
    if (!isOpenAssignedFollowup(f)) continue
    const assignee = normalizePhone(f.assigned_to_phone || f.assignedToPhone)
    if (assignee !== me) continue
    assignedOpen++
    const cat = classifyFollowupDate(f.next_date || f.nextDate, todayStr)
    if (cat === 'overdue') assignedOverdue++
    else if (cat === 'today') assignedToday++
  }

  const salesY = computeSalesSnapshot({
    customers,
    phoneSet,
    dateFromNum: yesterdayN,
    dateToNum: yesterdayN
  })
  const book = computeOpenBookSnapshot({ customers, phoneSet })
  // Pending accounting (any date) scoped to registrant
  let pendingCount = 0
  let pendingAmount = 0
  forEachSalePayment({
    customers,
    phoneSet,
    statusFilter: PAYMENT_PENDING,
    onPayment: ({ amount }) => {
      pendingAmount += amount
      pendingCount++
    }
  })

  const salesAvg7dAmount = averageDailyApproved({
    customers,
    phoneSet,
    todayStr,
    days: 7,
    excludeToday: true
  })
  const salesTrendPct = trendPct(salesY.totalApproved, salesAvg7dAmount)

  const target = pickAdvisorTarget({ salesTargets, phone: me, customers, todayStr })
  const newLeadsYesterday = countNewLeadsOnDate({ customers, phone: me, dateStr: yesterdayStr })
  const refundsOpen = countOpenRefunds({ refunds, phoneSet })

  const counts = {
    overdue,
    today,
    assignedOpen,
    assignedOverdue,
    assignedToday,
    noFollowup,
    overdueTop,
    salesYesterdayCount: salesY.salesCount,
    salesYesterdayAmount: salesY.totalApproved,
    salesAvg7dAmount,
    salesTrendPct,
    openDepositCount: book.openDepositCount,
    openDepositAmount: book.openDepositAmount,
    openBalanceAmount: book.openBalanceAmount,
    pendingCount,
    pendingAmount,
    target,
    newLeadsYesterday,
    refundsOpen,
    actionLine: ''
  }
  counts.actionLine = morningActionLine(counts)
  return counts
}

/**
 * Evening manager metrics for a team (subordinate phones only).
 * Soon = not overdue and date <= today+3 (dashboard monitor).
 */
export function countManagerEveningMetrics({
  teamPhones = [],
  customers = [],
  followups = [],
  todayStr,
  salesTargets = [],
  refunds = [],
  phoneNames = {},
  groupIds = []
}) {
  const team = new Set((teamPhones || []).map(normalizePhone).filter(Boolean))
  const empty = {
    overdue: 0,
    soon: 0,
    assignedOpen: 0,
    doneToday: 0,
    overdueTop: [],
    inactiveToday: [],
    salesTodayCount: 0,
    salesTodayAmount: 0,
    salesYesterdayAmount: 0,
    salesAvg7dAmount: 0,
    salesTrendVsYesterday: null,
    salesTrendVsAvg: null,
    openDepositAmount: 0,
    openBalanceAmount: 0,
    salesTop: [],
    target: null,
    refundsOpen: 0,
    actionLine: ''
  }
  if (!team.size || !todayStr) return empty

  const in3DaysNum = jalaliAddDays(todayStr, 3)
  const todayN = jalaliToNum(todayStr)
  const yesterdayStr = jalaliAddDaysStr(todayStr, -1)
  const yesterdayN = jalaliToNum(yesterdayStr)

  let overdue = 0
  let soon = 0
  const overdueByPhone = new Map()
  const advisorNameHint = new Map()

  for (const c of customers) {
    const owner = normalizePhone(c.advisor_phone || c.advisorPhone)
    if (!owner || !team.has(owner)) continue
    if (c.advisor) advisorNameHint.set(owner, String(c.advisor).trim())
    const num = jalaliToNum(c.next_followup_date || c.nextFollowupDate)
    if (num === 99999999) continue
    if (num < todayN) {
      overdue++
      overdueByPhone.set(owner, (overdueByPhone.get(owner) || 0) + 1)
    } else if (num <= in3DaysNum) soon++
  }

  let assignedOpen = 0
  for (const f of followups) {
    if (!isOpenAssignedFollowup(f)) continue
    const assignee = normalizePhone(f.assigned_to_phone || f.assignedToPhone)
    if (!assignee || !team.has(assignee)) continue
    assignedOpen++
  }

  const done = countDoneFollowupsToday({ followups, phoneSet: team, todayStr })
  const salesToday = computeSalesSnapshot({
    customers,
    phoneSet: team,
    dateFromNum: todayN,
    dateToNum: todayN
  })
  const salesY = computeSalesSnapshot({
    customers,
    phoneSet: team,
    dateFromNum: yesterdayN,
    dateToNum: yesterdayN
  })
  const book = computeOpenBookSnapshot({ customers, phoneSet: team })
  const salesAvg7dAmount = averageDailyApproved({
    customers,
    phoneSet: team,
    todayStr,
    days: 7,
    excludeToday: true
  })

  const overdueTop = [...overdueByPhone.entries()]
    .map(([phone, count]) => ({
      phone,
      count,
      name: resolveAdvisorName(phone, phoneNames, advisorNameHint.get(phone))
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)

  const salesTop = [...salesToday.byPhone.values()]
    .map(row => ({
      phone: row.phone,
      amount: row.amount,
      count: row.count,
      name: resolveAdvisorName(row.phone, phoneNames, advisorNameHint.get(row.phone))
    }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 3)

  const inactiveToday = []
  for (const phone of team) {
    const hadFollowup = (done.byPhone.get(phone) || 0) > 0
    const hadSale = salesToday.byPhone.has(phone)
    if (!hadFollowup && !hadSale) {
      inactiveToday.push({
        phone,
        name: resolveAdvisorName(phone, phoneNames, advisorNameHint.get(phone))
      })
    }
  }

  const target = pickGroupTarget({
    salesTargets,
    groupIds,
    customers,
    teamPhones: [...team],
    todayStr
  })
  const refundsOpen = countOpenRefunds({ refunds, phoneSet: team })

  const counts = {
    overdue,
    soon,
    assignedOpen,
    doneToday: done.count,
    overdueTop,
    inactiveToday: inactiveToday.slice(0, 5),
    salesTodayCount: salesToday.salesCount,
    salesTodayAmount: salesToday.totalApproved,
    salesYesterdayAmount: salesY.totalApproved,
    salesAvg7dAmount,
    salesTrendVsYesterday: trendPct(salesToday.totalApproved, salesY.totalApproved),
    salesTrendVsAvg: trendPct(salesToday.totalApproved, salesAvg7dAmount),
    openDepositAmount: book.openDepositAmount,
    openBalanceAmount: book.openBalanceAmount,
    salesTop,
    target,
    refundsOpen,
    actionLine: ''
  }
  counts.actionLine = eveningActionLine(counts)
  return counts
}

export function morningHasWork(counts) {
  if (!counts) return false
  return !!(
    counts.overdue > 0 ||
    counts.today > 0 ||
    counts.assignedOpen > 0 ||
    counts.noFollowup > 0 ||
    counts.salesYesterdayCount > 0 ||
    counts.openDepositCount > 0 ||
    counts.pendingCount > 0 ||
    counts.refundsOpen > 0 ||
    counts.newLeadsYesterday > 0 ||
    (counts.target && counts.target.goal > 0)
  )
}

/** Evening digests always send when the manager has a team (caller gates on team). */
export function eveningHasWork(counts) {
  return !!counts
}

export function formatMorningTitle(digestDate) {
  return `خلاصه صبح — ${digestDate}`
}

export function formatEveningTitle(digestDate) {
  return `خلاصه عصر تیم — ${digestDate}`
}

function formatTargetLine(target, prefix = 'تارگت') {
  if (!target || !(target.goal > 0)) return ''
  const unit = target.metric === 'count' ? 'فروش' : ''
  const cur = target.metric === 'count'
    ? `${formatFaNumber(target.current)}/${formatFaNumber(target.goal)} ${unit}`.trim()
    : `${formatMoneyShort(target.current)} / ${formatMoneyShort(target.goal)}`
  const title = target.title ? ` «${target.title}»` : ''
  let extra = ''
  if (target.daysLeft != null) {
    if (target.daysLeft < 0) extra = ' · مهلت گذشته'
    else if (target.daysLeft === 0) extra = ' · مهلت امروز'
    else extra = ` · ${formatFaNumber(target.daysLeft)} روز مانده`
  }
  return `- ${prefix}${title}: **${formatFaNumber(target.pct)}٪** · ${cur}${extra}`
}

/** Markdown body; sectioned, capped ~12 lines of signal. */
export function formatMorningMessage(counts) {
  const lines = []

  lines.push('🔥 اولویت')
  const pri = []
  if (counts.overdue > 0) pri.push(`معوق: **${formatFaNumber(counts.overdue)}**`)
  if (counts.today > 0) pri.push(`امروز: **${formatFaNumber(counts.today)}**`)
  if (counts.assignedOpen > 0) {
    let a = `ارجاع باز: **${formatFaNumber(counts.assignedOpen)}**`
    const bits = []
    if (counts.assignedOverdue > 0) bits.push(`${formatFaNumber(counts.assignedOverdue)} معوق`)
    if (counts.assignedToday > 0) bits.push(`${formatFaNumber(counts.assignedToday)} امروز`)
    if (bits.length) a += ` (${bits.join(' · ')})`
    pri.push(a)
  }
  if (pri.length) lines.push(`- ${pri.join(' · ')}`)
  if (counts.noFollowup > 0) {
    lines.push(`- بدون فالوآپ در کتاب: **${formatFaNumber(counts.noFollowup)}**`)
  }
  if (!pri.length && !(counts.noFollowup > 0)) {
    lines.push('- کار فوری فالوآپ ندارید')
  }

  const moneyBits = []
  if (counts.salesYesterdayCount > 0 || counts.salesYesterdayAmount > 0) {
    let s = `فروش دیروز: **${formatFaNumber(counts.salesYesterdayCount)}** · ${formatMoneyShort(counts.salesYesterdayAmount)}`
    const t = formatTrend(counts.salesTrendPct)
    if (t) s += ` (${t} نسبت به میانگین هفته)`
    moneyBits.push(s)
  }
  if (counts.openDepositCount > 0 || counts.openBalanceAmount > 0) {
    moneyBits.push(
      `بیعانه باز: **${formatFaNumber(counts.openDepositCount)}** · ${formatMoneyShort(counts.openDepositAmount)}` +
      (counts.openBalanceAmount > 0 ? ` · مانده ${formatMoneyShort(counts.openBalanceAmount)}` : '')
    )
  }
  if (counts.pendingCount > 0) {
    moneyBits.push(`در انتظار حسابداری: **${formatFaNumber(counts.pendingCount)}** · ${formatMoneyShort(counts.pendingAmount)}`)
  }
  if (moneyBits.length) {
    lines.push('💰 دیروز / کتاب')
    for (const b of moneyBits) lines.push(`- ${b}`)
  }

  const funnel = []
  const tgt = formatTargetLine(counts.target)
  if (tgt) funnel.push(tgt)
  if (counts.newLeadsYesterday > 0) {
    funnel.push(`- لید جدید دیروز: **${formatFaNumber(counts.newLeadsYesterday)}**`)
  }
  if (counts.refundsOpen > 0) {
    funnel.push(`- استرداد باز: **${formatFaNumber(counts.refundsOpen)}**`)
  }
  if (funnel.length) {
    lines.push('🎯 تارگت / قیف')
    lines.push(...funnel)
  }

  if (counts.overdueTop?.length) {
    lines.push('⏭ شروع با')
    for (const row of counts.overdueTop) {
      const plat = row.platform ? ` · ${row.platform}` : ''
      lines.push(`- ${row.name} (معوق ${formatFaNumber(row.daysLate)} روز${plat})`)
    }
  }

  if (counts.actionLine) {
    lines.push(`💡 ${counts.actionLine}`)
  }

  return lines.join('\n')
}

export function formatEveningMessage(counts) {
  const lines = []

  lines.push('🔥 عملیات')
  const ops = []
  if (counts.overdue > 0) ops.push(`معوق: **${formatFaNumber(counts.overdue)}**`)
  if (counts.soon > 0) ops.push(`قریب ۳روز: **${formatFaNumber(counts.soon)}**`)
  if (counts.assignedOpen > 0) ops.push(`ارجاع باز: **${formatFaNumber(counts.assignedOpen)}**`)
  if (ops.length) lines.push(`- ${ops.join(' · ')}`)
  else lines.push('- تیم بدون معوق/قریب — وضعیت تمیز')
  if (counts.doneToday > 0) {
    lines.push(`- فالوآپ انجام‌شده امروز: **${formatFaNumber(counts.doneToday)}**`)
  }
  if (counts.overdueTop?.length) {
    lines.push(
      `- بیشترین معوق: ${counts.overdueTop.map(r => `${r.name} (${formatFaNumber(r.count)})`).join(' · ')}`
    )
  }
  if (counts.inactiveToday?.length) {
    const names = counts.inactiveToday.slice(0, 3).map(r => r.name).join(' · ')
    lines.push(`- بدون فعالیت امروز: **${formatFaNumber(counts.inactiveToday.length)}** نفر (${names})`)
  }

  lines.push('💰 فروش امروز')
  {
    let s = `**${formatFaNumber(counts.salesTodayCount)}** فروش · ${formatMoneyShort(counts.salesTodayAmount)}`
    const vsY = formatTrend(counts.salesTrendVsYesterday)
    if (vsY) s += ` (${vsY} نسبت به دیروز)`
    lines.push(`- ${s}`)
  }
  if (counts.salesTop?.length) {
    lines.push(
      `- برتر: ${counts.salesTop.map(r => `${r.name} ${formatMoneyShort(r.amount)}`).join(' · ')}`
    )
  }
  if (counts.openDepositAmount > 0 || counts.openBalanceAmount > 0) {
    lines.push(
      `- بیعانه/مانده باز تیم: ${formatMoneyShort(counts.openDepositAmount)}` +
      (counts.openBalanceAmount > 0 ? ` · مانده ${formatMoneyShort(counts.openBalanceAmount)}` : '')
    )
  }

  const tgt = formatTargetLine(counts.target, 'تارگت گروه')
  if (tgt) {
    lines.push('🎯 تارگت')
    lines.push(tgt)
    if (counts.target.timePct != null && counts.target.paceGap != null) {
      const gap = counts.target.paceGap
      const gapLabel = gap > 0
        ? `${formatFaNumber(gap)}٪ عقب`
        : gap < 0
          ? `${formatFaNumber(Math.abs(gap))}٪ جلو`
          : 'هم‌قدم با زمان'
      lines.push(`- زمان **${formatFaNumber(counts.target.timePct)}٪** · پیشرفت **${formatFaNumber(counts.target.pct)}٪** → ${gapLabel}`)
    }
  }

  if (counts.refundsOpen > 0) {
    lines.push('⚠ ریسک')
    lines.push(`- استرداد باز: **${formatFaNumber(counts.refundsOpen)}**`)
  }

  if (counts.actionLine) {
    lines.push(`💡 ${counts.actionLine}`)
  }

  return lines.join('\n')
}

export function isDigestKind(kind) {
  return kind === DIGEST_KIND_MORNING || kind === DIGEST_KIND_EVENING
}

export function isSystemDigestSender(createdByPhone) {
  return String(createdByPhone || '') === SYSTEM_DIGEST_PHONE
}
