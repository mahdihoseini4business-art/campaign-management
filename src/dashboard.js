import { getData, getStatuses } from './data.js'
import { getUsersSafe } from './auth.js'
import {
  hasPermission, getCurrentUser, formatNumber, jalaliToNum, getTodayJalaliNum,
  jalaliAddDays, getTodayJalaliStr, escapeHtml, escapeAttr, ownsCustomer,
  normalizePhone, userDisplayName, canViewOrgWideData, jalaliDiffDays, jalaliDatePart,
  getVisibleAdvisorPhones, getStatusLabels, formatPhonesDisplay,
  ensureProductPayments, syncProductStatus, getProductPayments, getPaymentEntryStatus,
  getApprovedPaid, getProductBalance, isProductCountableInSales, PAYMENT_STATUS,
  gregorianToJalaliStr, normalizeViewUserPhones
} from './utils.js'

let dashCharts = {}
/** @type {Set<string>|null} null = not initialized yet (treat as all) */
let selectedAdvisorPhones = null
let dashUsersCache = []
let dashUserDropdownInited = false
let salesChartDefaultsReady = false

const TIMEFRAME_DAYS = { day: 1, week: 7, month: 30 }
const TIMEFRAME_LABELS = { day: '۱ روز', week: '۱ هفته', month: '۱ ماه' }
const ADVISOR_CHART_COLORS = [
  '#0d6efd', '#198754', '#ffc107', '#dc3545', '#6f42c1',
  '#fd7e14', '#20c997', '#0dcaf0', '#6610f2', '#d63384',
  '#495057', '#e83e8c', '#39cccc', '#605ca8', '#f56954'
]

// ============================================
// Helpers
// ============================================

function jalaliNumToStr(n) {
  if (!n || n === 99999999) return ''
  const y = Math.floor(n / 10000)
  const m = Math.floor((n % 10000) / 100)
  const d = n % 100
  return `${y}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`
}

function jalaliAddDaysStr(dateStr, days) {
  return jalaliNumToStr(jalaliAddDays(dateStr, days))
}

/** Inclusive day count of [from, to]. Null if invalid. */
function rangeInclusiveDays(fromStr, toStr) {
  const diff = jalaliDiffDays(fromStr, toStr)
  if (diff == null || diff < 0) return null
  return diff + 1
}

/**
 * Timeframe allowed only if bucket size is strictly smaller than the range,
 * so a 7-day range cannot use week/month (would be one meaningless bar).
 */
export function getAllowedTimeframes(fromStr, toStr) {
  const days = rangeInclusiveDays(fromStr, toStr)
  if (days == null || days < 1) return []
  const allowed = ['day']
  if (days > TIMEFRAME_DAYS.week) allowed.push('week')
  if (days > TIMEFRAME_DAYS.month) allowed.push('month')
  return allowed
}

function ensureSalesChartDefaults() {
  if (salesChartDefaultsReady) return
  const fromEl = document.getElementById('salesChartFrom')
  const toEl = document.getElementById('salesChartTo')
  if (!fromEl || !toEl) return
  if (!fromEl.value.trim()) fromEl.value = jalaliAddDaysStr(getTodayJalaliStr(), -29)
  if (!toEl.value.trim()) toEl.value = getTodayJalaliStr()
  salesChartDefaultsReady = true
}

function matchesSelectedUsers(customer) {
  if (!customer) return false
  if (!selectedAdvisorPhones || selectedAdvisorPhones.size === 0) return false
  const phone = normalizePhone(customer.advisorPhone)
  if (!phone) return false
  return selectedAdvisorPhones.has(phone)
}

/**
 * Overdue/soon follow-up tables:
 * - Managers (viewUserPhones set) → only subordinates' customers
 * - Everyone else → selected advisors as usual
 */
function matchesFollowupMonitorScope(customer) {
  if (!matchesSelectedUsers(customer)) return false
  const currentUser = getCurrentUser()
  if (canViewOrgWideData(currentUser)) return true
  const teamPhones = normalizeViewUserPhones(
    currentUser?.viewUserPhones ?? currentUser?.permissions?.viewUserPhones
  )
  if (teamPhones.length === 0) return true
  const phone = normalizePhone(customer.advisorPhone)
  return !!(phone && teamPhones.includes(phone))
}

function advisorNameForCustomer(customer) {
  const phone = normalizePhone(customer?.advisorPhone)
  if (phone) {
    const user = dashUsersCache.find(u => normalizePhone(u.phone) === phone)
    if (user) return userDisplayName(user)
  }
  return (customer?.advisor || '').trim() || '—'
}

// ============================================
// User filter dropdown
// ============================================

export function toggleDashUserDropdown(event) {
  event?.stopPropagation?.()
  const dd = document.getElementById('dashUserDropdown')
  if (!dd) return
  dd.hidden = !dd.hidden
}

function closeDashUserDropdown() {
  const dd = document.getElementById('dashUserDropdown')
  if (dd) dd.hidden = true
}

function updateUserFilterCount() {
  const el = document.getElementById('dashUserFilterCount')
  const allCb = document.getElementById('dashUserSelectAll')
  if (!el) return
  const total = dashUsersCache.length
  const selected = selectedAdvisorPhones ? selectedAdvisorPhones.size : 0
  if (total === 0) {
    el.textContent = ''
    if (allCb) allCb.checked = false
    return
  }
  if (selected === total) {
    el.textContent = '(همه)'
    if (allCb) allCb.checked = true
  } else if (selected === 0) {
    el.textContent = '(هیچ)'
    if (allCb) allCb.checked = false
  } else {
    el.textContent = `(${selected}/${total})`
    if (allCb) allCb.checked = false
  }
}

async function ensureUserFilterUI() {
  const currentUser = getCurrentUser()
  const orgWide = canViewOrgWideData()
  const users = (await getUsersSafe()).filter(u => u.phone)
  const visiblePhones = getVisibleAdvisorPhones(currentUser)
  // Admins / accountants see all advisors; others see self + granted view users
  dashUsersCache = orgWide
    ? users
    : users.filter(u => visiblePhones.has(normalizePhone(u.phone)))

  if (selectedAdvisorPhones == null) {
    selectedAdvisorPhones = new Set(dashUsersCache.map(u => normalizePhone(u.phone)))
  } else {
    const valid = new Set(dashUsersCache.map(u => normalizePhone(u.phone)))
    selectedAdvisorPhones = new Set([...selectedAdvisorPhones].filter(p => valid.has(p)))
    if (!orgWide && dashUsersCache.length && selectedAdvisorPhones.size === 0) {
      selectedAdvisorPhones = new Set(dashUsersCache.map(u => normalizePhone(u.phone)))
    }
  }

  const container = document.getElementById('dashUserCheckboxes')
  if (container) {
    const phonesKey = dashUsersCache.map(u => normalizePhone(u.phone)).join('|')
    if (container.dataset.phonesKey !== phonesKey) {
      container.dataset.phonesKey = phonesKey
      container.innerHTML = dashUsersCache.map(u => {
        const phone = normalizePhone(u.phone)
        const checked = selectedAdvisorPhones.has(phone) ? 'checked' : ''
        return `<label class="dash-user-option">
          <input type="checkbox" value="${escapeAttr(phone)}" ${checked} onchange="app.toggleDashUser('${escapeAttr(phone)}', this.checked)">
          <span>${escapeHtml(userDisplayName(u))}</span>
        </label>`
      }).join('') || '<div class="dash-user-empty">کارشناسی یافت نشد</div>'
    } else {
      container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.checked = selectedAdvisorPhones.has(normalizePhone(cb.value))
      })
    }
  }

  updateUserFilterCount()

  if (!dashUserDropdownInited) {
    dashUserDropdownInited = true
    document.addEventListener('click', (e) => {
      const wrap = document.getElementById('dashUserFilter')
      if (wrap && !wrap.contains(e.target)) closeDashUserDropdown()
    })
  }
}

export function toggleDashUser(phone, checked) {
  if (!selectedAdvisorPhones) selectedAdvisorPhones = new Set()
  const p = normalizePhone(phone)
  if (checked) selectedAdvisorPhones.add(p)
  else selectedAdvisorPhones.delete(p)
  updateUserFilterCount()
  renderDashboard()
}

export function toggleDashUsersAll(checked) {
  selectedAdvisorPhones = checked
    ? new Set(dashUsersCache.map(u => normalizePhone(u.phone)))
    : new Set()
  document.querySelectorAll('#dashUserCheckboxes input[type="checkbox"]').forEach(cb => {
    cb.checked = checked
  })
  updateUserFilterCount()
  renderDashboard()
}

// ============================================
// Sales timeline chart controls
// ============================================

export function onSalesChartControlsChange() {
  syncSalesChartTimeframeOptions()
}

export function applySalesChart() {
  const ok = syncSalesChartTimeframeOptions()
  if (!ok) return
  const dateFrom = document.getElementById('dashDateFrom')?.value.trim() || ''
  const dateTo = document.getElementById('dashDateTo')?.value.trim() || ''
  const dateFromNum = dateFrom ? jalaliToNum(dateFrom) : 0
  const dateToNum = dateTo ? jalaliToNum(dateTo) : 99999999
  const currentUser = getCurrentUser()
  renderSalesTimelineChart(dateFromNum, dateToNum, currentUser)
}

function syncSalesChartTimeframeOptions() {
  ensureSalesChartDefaults()
  const fromEl = document.getElementById('salesChartFrom')
  const toEl = document.getElementById('salesChartTo')
  const tfEl = document.getElementById('salesChartTimeframe')
  const hint = document.getElementById('salesChartHint')
  if (!fromEl || !toEl || !tfEl) return false

  let from = fromEl.value.trim()
  let to = toEl.value.trim()

  if (!from || !to || jalaliToNum(from) === 99999999 || jalaliToNum(to) === 99999999) {
    if (hint) hint.textContent = 'بازه زمانی نمودار را کامل وارد کنید.'
    return false
  }

  if (jalaliToNum(from) > jalaliToNum(to)) {
    ;[from, to] = [to, from]
    fromEl.value = from
    toEl.value = to
  }

  const days = rangeInclusiveDays(from, to)
  if (days == null) {
    if (hint) hint.textContent = 'بازه زمانی نامعتبر است.'
    return false
  }

  if (days > 366) {
    if (hint) hint.textContent = 'حداکثر بازه نمودار ۳۶۶ روز است.'
    return false
  }

  const allowed = getAllowedTimeframes(from, to)
  ;[...tfEl.options].forEach(opt => {
    const ok = allowed.includes(opt.value)
    opt.disabled = !ok
    opt.hidden = !ok
  })

  if (!allowed.includes(tfEl.value)) {
    tfEl.value = allowed[allowed.length - 1] || 'day'
  }

  const disabledNotes = []
  if (!allowed.includes('week')) disabledNotes.push('بازه ≤ ۷ روز → تایم‌فریم هفته غیرفعال')
  if (!allowed.includes('month')) disabledNotes.push('بازه ≤ ۳۰ روز → تایم‌فریم ماه غیرفعال')

  if (hint) {
    const tf = TIMEFRAME_LABELS[tfEl.value] || tfEl.value
    hint.textContent = `بازه ${days} روز · هر میله = ${tf}` +
      (disabledNotes.length ? ` · ${disabledNotes.join(' · ')}` : '')
  }
  return true
}

function buildSalesBuckets(fromStr, toStr, timeframe) {
  const bucketSize = TIMEFRAME_DAYS[timeframe] || 1
  const buckets = []
  let cursor = fromStr
  const toNum = jalaliToNum(toStr)

  while (jalaliToNum(cursor) <= toNum) {
    const endNum = Math.min(jalaliToNum(jalaliAddDaysStr(cursor, bucketSize - 1)), toNum)
    const endStr = jalaliNumToStr(endNum)
    let label
    if (timeframe === 'day') label = cursor
    else if (cursor === endStr) label = cursor
    else label = `${cursor} تا ${endStr}`

    buckets.push({
      fromNum: jalaliToNum(cursor),
      toNum: endNum,
      label
    })
    cursor = jalaliAddDaysStr(endStr, 1)
    if (!cursor) break
  }
  return buckets
}

function forEachDashSalePayment(inUserScope, hasDateFilter, inDateRange, onPayment, onProduct = null, statusFilter = PAYMENT_STATUS.approved) {
  const data = getData()
  data.customers.forEach(c => {
    if (c.id.startsWith('LD') && !hasPermission('customers_ld')) return
    if (c.id.startsWith('CS') && !hasPermission('customers_cs')) return
    if (!inUserScope(c)) return
    ;(c.products || []).forEach(p => {
      ensureProductPayments(p)
      syncProductStatus(p)
      if (!isProductCountableInSales(p)) return

      const pays = getProductPayments(p).filter(pay => {
        const amount = parseFloat(pay.amount) || 0
        if (amount <= 0) return false
        if (getPaymentEntryStatus(pay) !== statusFilter) return false
        if (hasDateFilter && !inDateRange(jalaliDatePart(pay.soldAt))) return false
        return true
      })

      if (hasDateFilter && pays.length === 0) return
      if (!hasDateFilter && pays.length === 0 && statusFilter !== PAYMENT_STATUS.approved) return

      if (onProduct) {
        onProduct({
          customer: c,
          product: p,
          payments: pays,
          paidInScope: pays.reduce((sum, pay) => sum + (parseFloat(pay.amount) || 0), 0),
          price: parseFloat(p.price) || 0,
          deposit: getApprovedPaid(p),
          balance: getProductBalance(p)
        })
      }
      pays.forEach(pay => {
        onPayment({
          customer: c,
          product: p,
          payment: pay,
          amount: parseFloat(pay.amount) || 0,
          date: jalaliDatePart(pay.soldAt)
        })
      })
    })
  })
}

function computeDashSalesMetrics(inUserScope, hasDateFilter, inDateRange) {
  let salesCount = 0
  let totalCash = 0
  let totalDeposit = 0
  let totalBalance = 0
  let totalApproved = 0
  let totalPending = 0

  // Approved payments — used for cash/deposit/balance/total cards
  forEachDashSalePayment(inUserScope, hasDateFilter, inDateRange, ({ amount }) => {
    totalApproved += amount
  }, ({ product, paidInScope, deposit, balance }) => {
    salesCount++
    if (hasDateFilter) {
      if (product.status === 'تکمیل') totalCash += paidInScope
      else {
        totalDeposit += paidInScope
        totalBalance += balance
      }
    } else if (product.status === 'تکمیل') {
      // Sum approved payments only (not full list price)
      totalCash += deposit
    } else {
      totalDeposit += deposit
      totalBalance += balance
    }
  })

  // Pending accounting approval amounts
  forEachDashSalePayment(
    inUserScope,
    hasDateFilter,
    inDateRange,
    ({ amount }) => { totalPending += amount },
    null,
    PAYMENT_STATUS.pending
  )

  return {
    salesCount,
    totalCash,
    totalDeposit,
    totalBalance,
    totalAll: totalCash + totalDeposit,
    totalApproved,
    totalPending
  }
}

function renderSalesTimelineChart(dateFromNum, dateToNum, currentUser) {
  if (dashCharts.salesTimeline) {
    dashCharts.salesTimeline.destroy()
    delete dashCharts.salesTimeline
  }

  const canvas = document.getElementById('chartSalesTimeline')
  if (!canvas || typeof Chart === 'undefined') return
  if (!syncSalesChartTimeframeOptions()) return

  const from = document.getElementById('salesChartFrom').value.trim()
  const to = document.getElementById('salesChartTo').value.trim()
  const timeframe = document.getElementById('salesChartTimeframe').value || 'day'
  const buckets = buildSalesBuckets(from, to, timeframe)
  const totals = buckets.map(() => 0)
  const chartFromNum = jalaliToNum(from)
  const chartToNum = jalaliToNum(to)

  forEachDashSalePayment(
    matchesSelectedUsers,
    true,
    (dateStr) => {
      if (!dateStr) return false
      const n = jalaliToNum(dateStr)
      return n >= chartFromNum && n <= chartToNum
    },
    ({ amount, date }) => {
      if (!date || jalaliToNum(date) === 99999999) return
      const n = jalaliToNum(date)
      const idx = buckets.findIndex(b => n >= b.fromNum && n <= b.toNum)
      if (idx !== -1) totals[idx] += amount
    }
  )

  dashCharts.salesTimeline = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: buckets.map(b => b.label),
      datasets: [{
        label: 'مبلغ فروش',
        data: totals,
        backgroundColor: '#0d6efd',
        borderRadius: 6,
        maxBarThickness: 48
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => formatNumber(ctx.raw || 0) + ' ریال'
          }
        }
      },
      scales: {
        x: {
          ticks: {
            font: { family: 'Vazirmatn', size: 10 },
            maxRotation: 45,
            minRotation: 0
          }
        },
        y: {
          ticks: {
            font: { family: 'Vazirmatn', size: 11 },
            callback: v => formatNumber(v)
          }
        }
      }
    }
  })
}

// ============================================
// Ownership transfer metrics
// ============================================

const TRANSFER_CONVERSION_DAYS = 30

function transferInDateRange(transfer, dateFromNum, dateToNum) {
  if (!dateFromNum && (!dateToNum || dateToNum === 99999999)) return true
  const jalali = gregorianToJalaliStr(transfer.createdAt)
  if (!jalali) return false
  const n = jalaliToNum(jalali)
  return n >= (dateFromNum || 0) && n <= (dateToNum || 99999999)
}

function transferTouchesSelected(transfer) {
  if (!selectedAdvisorPhones || selectedAdvisorPhones.size === 0) return false
  const from = normalizePhone(transfer.fromAdvisorPhone)
  const to = normalizePhone(transfer.toAdvisorPhone)
  return (from && selectedAdvisorPhones.has(from)) || (to && selectedAdvisorPhones.has(to))
}

function customerConvertedAfter(customer, transferAtMs, withinDays) {
  if (!customer) return false
  const deadline = transferAtMs + withinDays * 24 * 60 * 60 * 1000
  if (customer.status === 'purchased') {
    // Status alone has no timestamp — count if currently purchased and has countable sale
  }
  const products = customer.products || []
  for (const p of products) {
    ensureProductPayments(p)
    if (!isProductCountableInSales(p)) continue
    for (const pay of getProductPayments(p)) {
      const sold = pay.soldAt || p.soldAt
      if (!sold) continue
      // soldAt is Jalali datetime — approximate via gregorian if ISO, else accept as post-transfer if countable
      const d = new Date(sold)
      if (!Number.isNaN(d.getTime())) {
        const t = d.getTime()
        if (t >= transferAtMs && t <= deadline) return true
        continue
      }
      // Jalali soldAt: treat countable sale as conversion signal within window if no reliable clock
      const j = jalaliDatePart(sold)
      if (!j) continue
      const jNum = jalaliToNum(j)
      const transferJ = gregorianToJalaliStr(new Date(transferAtMs))
      const deadlineJ = gregorianToJalaliStr(new Date(deadline))
      if (jNum >= jalaliToNum(transferJ) && jNum <= jalaliToNum(deadlineJ)) return true
    }
  }
  return false
}

function renderTransferMetrics(dateFromNum, dateToNum) {
  const data = getData()
  const transfers = (data.ownershipTransfers || []).filter(t =>
    transferInDateRange(t, dateFromNum, dateToNum) && transferTouchesSelected(t)
  )

  const countEl = document.getElementById('dash-transfer-count')
  const batchesEl = document.getElementById('dash-transfer-batches')
  const dwellEl = document.getElementById('dash-transfer-dwell')
  const convEl = document.getElementById('dash-transfer-conversion')
  const bodyEl = document.getElementById('dashTransferBody')

  if (countEl) countEl.textContent = String(transfers.length)

  const batches = new Set(transfers.map(t => t.batchId).filter(Boolean))
  if (batchesEl) batchesEl.textContent = String(batches.size)

  // Dwell: days between consecutive transfers on same customer (ownership tenure)
  const byCustomer = {}
  for (const t of (data.ownershipTransfers || [])) {
    if (!t.customerId || !t.createdAt) continue
    if (!byCustomer[t.customerId]) byCustomer[t.customerId] = []
    byCustomer[t.customerId].push(t)
  }
  const dwellDays = []
  for (const list of Object.values(byCustomer)) {
    list.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1]
      const curr = list[i]
      // Only count tenure that ended (outgoing transfer) in the filtered set
      if (!transfers.some(t => t.id === curr.id)) continue
      const to = normalizePhone(prev.toAdvisorPhone)
      if (selectedAdvisorPhones && to && !selectedAdvisorPhones.has(to)) continue
      const ms = new Date(curr.createdAt) - new Date(prev.createdAt)
      if (ms >= 0) dwellDays.push(ms / (1000 * 60 * 60 * 24))
    }
  }
  if (dwellEl) {
    dwellEl.textContent = dwellDays.length
      ? formatNumber(Math.round(dwellDays.reduce((a, b) => a + b, 0) / dwellDays.length))
      : '—'
  }

  // Conversion within 30 days after receiving a transfer (to_advisor)
  let convEligible = 0
  let convHit = 0
  for (const t of transfers) {
    const to = normalizePhone(t.toAdvisorPhone)
    if (!to || !selectedAdvisorPhones?.has(to)) continue
    const at = new Date(t.createdAt).getTime()
    if (Number.isNaN(at)) continue
    convEligible++
    const customer = data.customers.find(c => c.id === t.customerId)
    if (customerConvertedAfter(customer, at, TRANSFER_CONVERSION_DAYS)) convHit++
  }
  if (convEl) {
    convEl.textContent = convEligible
      ? `${formatNumber(Math.round((convHit / convEligible) * 100))}% (${convHit}/${convEligible})`
      : '—'
  }

  // In / out table
  const stats = {}
  function ensureRow(phone, name) {
    const key = phone || name || '—'
    if (!stats[key]) stats[key] = { phone: phone || '', name: name || phone || '—', in: 0, out: 0 }
    return stats[key]
  }
  for (const t of transfers) {
    const from = normalizePhone(t.fromAdvisorPhone)
    const to = normalizePhone(t.toAdvisorPhone)
    if (from && selectedAdvisorPhones.has(from)) {
      ensureRow(from, t.fromAdvisorName).out++
    }
    if (to && selectedAdvisorPhones.has(to)) {
      ensureRow(to, t.toAdvisorName).in++
    }
  }

  const rows = Object.values(stats).sort((a, b) => (b.in + b.out) - (a.in + a.out))
  if (bodyEl) {
    if (rows.length === 0) {
      bodyEl.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:16px;color:var(--text-muted);font-size:13px;">انتقالی در این بازه ثبت نشده</td></tr>'
    } else {
      bodyEl.innerHTML = rows.map(r => {
        const net = r.in - r.out
        const netColor = net > 0 ? 'var(--success)' : net < 0 ? 'var(--danger)' : 'var(--text-muted)'
        return `<tr>
          <td>${escapeHtml(r.name || r.phone)}</td>
          <td style="text-align:center;color:var(--success);">${r.in}</td>
          <td style="text-align:center;color:var(--danger);">${r.out}</td>
          <td style="text-align:center;color:${netColor};font-weight:600;">${net > 0 ? '+' : ''}${net}</td>
        </tr>`
      }).join('')
    }
  }
}

// ============================================
// Dashboard
// ============================================

export function toggleDashSection(section) {
  const body = document.getElementById(`dash-${section}-body`)
  const arrow = document.getElementById(`dash-arrow-${section}`)
  const toggle = document.getElementById(`dash-${section}-toggle`)
  if (!body) return

  const isOpen = body.classList.toggle('open')
  arrow?.classList.toggle('open', isOpen)
  toggle?.setAttribute('aria-expanded', isOpen ? 'true' : 'false')
}

export async function renderDashboard() {
  const data = getData()
  await ensureUserFilterUI()
  ensureSalesChartDefaults()
  syncSalesChartTimeframeOptions()

  const dateFrom = document.getElementById('dashDateFrom')?.value.trim() || ''
  const dateTo = document.getElementById('dashDateTo')?.value.trim() || ''
  const dateFromNum = dateFrom ? jalaliToNum(dateFrom) : 0
  const dateToNum = dateTo ? jalaliToNum(dateTo) : 99999999
  const todayNum = getTodayJalaliNum()
  const in3DaysNum = jalaliAddDays(getTodayJalaliStr(), 3)

  function inDateRange(dateStr) {
    if (!dateFrom && !dateTo) return true
    if (!dateStr) return false
    const dNum = jalaliToNum(dateStr)
    return dNum >= dateFromNum && dNum <= dateToNum
  }

  const currentUser = getCurrentUser()

  function inUserScope(c) {
    return matchesSelectedUsers(c)
  }

  const scopedCustomers = data.customers.filter(c => {
    if (c.id.startsWith('LD') && !hasPermission('customers_ld')) return false
    if (c.id.startsWith('CS') && !hasPermission('customers_cs')) return false
    return inUserScope(c)
  })

  document.getElementById('dash-total-customers').textContent = scopedCustomers.length
  document.getElementById('dash-my-customers').textContent = scopedCustomers.filter(c =>
    ownsCustomer(c, currentUser)
  ).length
  document.getElementById('dash-total-leads').textContent = scopedCustomers.filter(c => c.id.startsWith('LD')).length
  document.getElementById('dash-total-cs').textContent = scopedCustomers.filter(c => c.id.startsWith('CS')).length
  document.getElementById('dash-total-followups').textContent = data.followups.filter(f => {
    const customer = data.customers.find(c => c.id === f.customerId)
    if (!customer || !inUserScope(customer)) return false
    if (customer.id.startsWith('LD') && !hasPermission('customers_ld')) return false
    if (customer.id.startsWith('CS') && !hasPermission('customers_cs')) return false
    if (!inDateRange(f.date)) return false
    return true
  }).length

  // Fixed snapshot cards — ignore date filter (always current operational state)
  let overdueList = []
  let soonList = []
  let setCount = 0
  let noSetCount = 0

  scopedCustomers.forEach(c => {
    if (c.nextFollowupDate) {
      const dNum = jalaliToNum(c.nextFollowupDate)
      // Overdue/soon lists: managers only see subordinates
      if (matchesFollowupMonitorScope(c)) {
        if (dNum < todayNum) overdueList.push(c)
        else if (dNum <= in3DaysNum) soonList.push(c)
      }
      setCount++
    } else {
      noSetCount++
    }
  })

  document.getElementById('dash-overdue-followup').textContent = overdueList.length
  document.getElementById('dash-soon-followup').textContent = soonList.length
  document.getElementById('dash-set-followup').textContent = setCount
  document.getElementById('dash-no-followup').textContent = noSetCount
  document.getElementById('dash-overdue-badge').textContent = overdueList.length
  document.getElementById('dash-soon-badge').textContent = soonList.length

  const activeCustomers = scopedCustomers.filter(c => c.products && c.products.length > 0)
  document.getElementById('dash-active-customers').textContent = activeCustomers.length

  const hasDateFilter = !!(dateFrom || dateTo)
  const salesMetrics = computeDashSalesMetrics(inUserScope, hasDateFilter, inDateRange)

  document.getElementById('dash-sales-count').textContent = salesMetrics.salesCount
  document.getElementById('dash-sales-cash').textContent = formatNumber(salesMetrics.totalCash) + ' ریال'
  document.getElementById('dash-sales-deposit').textContent = formatNumber(salesMetrics.totalDeposit) + ' ریال'
  document.getElementById('dash-sales-balance').textContent = formatNumber(salesMetrics.totalBalance) + ' ریال'
  document.getElementById('dash-sales-total').textContent = formatNumber(salesMetrics.totalApproved) + ' ریال'
  const pendingEl = document.getElementById('dash-sales-pending')
  if (pendingEl) pendingEl.textContent = formatNumber(salesMetrics.totalPending) + ' ریال'

  const avgSale = salesMetrics.salesCount > 0
    ? Math.round(salesMetrics.totalApproved / salesMetrics.salesCount)
    : 0
  document.getElementById('dash-avg-sale').textContent = formatNumber(avgSale) + ' ریال'

  renderTransferMetrics(dateFromNum, dateToNum)

  const overdueBody = document.getElementById('dashOverdueBody')
  if (overdueList.length === 0) {
    overdueBody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px;">پیگیری عقب افتاده‌ای وجود ندارد</td></tr>'
  } else {
    overdueBody.innerHTML = overdueList.map(c => {
      const disp = formatPhonesDisplay(c)
      const phoneHtml = disp.text
        ? `${escapeHtml(disp.text)}${disp.extra > 0 ? ` <span style="color:var(--text-muted);font-size:11px;">+${disp.extra}</span>` : ''}`
        : '—'
      return `<tr class="clickable-row" style="background:#fff8f0;" onclick="app.onCustomerRowClick(event, '${escapeAttr(c.id)}')">
      <td>${escapeHtml(c.name || c.platformId)}</td>
      <td style="direction:ltr;text-align:right;font-family:'Vazirmatn',sans-serif;font-size:13px;">${phoneHtml}</td>
      <td>${escapeHtml(advisorNameForCustomer(c))}</td>
      <td><span class="settlement-badge settlement-overdue-badge">⚠ ${c.nextFollowupDate}</span></td>
      <td style="text-align:center;">${(c.products || []).length}</td>
    </tr>`
    }).join('')
  }

  const soonBody = document.getElementById('dashSoonBody')
  if (soonList.length === 0) {
    soonBody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px;">پیگیری نزدیکی وجود ندارد</td></tr>'
  } else {
    soonBody.innerHTML = soonList.map(c => {
      const disp = formatPhonesDisplay(c)
      const phoneHtml = disp.text
        ? `${escapeHtml(disp.text)}${disp.extra > 0 ? ` <span style="color:var(--text-muted);font-size:11px;">+${disp.extra}</span>` : ''}`
        : '—'
      return `<tr class="clickable-row" style="background:#f0fff4;" onclick="app.onCustomerRowClick(event, '${escapeAttr(c.id)}')">
      <td>${escapeHtml(c.name || c.platformId)}</td>
      <td style="direction:ltr;text-align:right;font-family:'Vazirmatn',sans-serif;font-size:13px;">${phoneHtml}</td>
      <td>${escapeHtml(advisorNameForCustomer(c))}</td>
      <td><span class="settlement-badge settlement-soon-badge">${c.nextFollowupDate}</span></td>
      <td style="text-align:center;">${(c.products || []).length}</td>
    </tr>`
    }).join('')
  }

  renderDashCharts(dateFromNum, dateToNum, currentUser)
}

function renderDashCharts(dateFromNum, dateToNum, currentUser) {
  const data = getData()
  Object.values(dashCharts).forEach(c => { try { c.destroy() } catch (_) {} })
  dashCharts = {}

  function inChartDateRange(dateStr) {
    if (!dateFromNum && (!dateToNum || dateToNum === 99999999)) return true
    if (!dateStr) return false
    const dNum = jalaliToNum(dateStr)
    return dNum >= (dateFromNum || 0) && dNum <= (dateToNum || 99999999)
  }

  function inUserScope(c) {
    return matchesSelectedUsers(c)
  }

  const statusLabels = getStatusLabels()
  const statusColors = {}
  for (const s of getStatuses()) statusColors[s.key] = s.bgColor

  const custStatusCounts = {}
  data.customers.forEach(c => {
    if (c.id.startsWith('LD') && !hasPermission('customers_ld')) return
    if (c.id.startsWith('CS') && !hasPermission('customers_cs')) return
    if (!inUserScope(c)) return
    const label = statusLabels[c.status] || c.status
    custStatusCounts[label] = (custStatusCounts[label] || 0) + 1
  })
  dashCharts.custStatus = new Chart(document.getElementById('chartCustomers'), {
    type: 'doughnut',
    data: {
      labels: Object.keys(custStatusCounts),
      datasets: [{
        data: Object.values(custStatusCounts),
        backgroundColor: Object.keys(custStatusCounts).map(k => {
          const key = Object.keys(statusLabels).find(sk => statusLabels[sk] === k)
          return statusColors[key] || '#dee2e6'
        }),
        borderWidth: 2, borderColor: '#fff'
      }]
    },
    options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { font: { family: 'Vazirmatn', size: 11 } } } } }
  })

  const salesStatus = { 'تکمیل': 0, 'بیعانه': 0 }
  const productSales = {}
  const hasDateFilter = dateFromNum > 0 || dateToNum < 99999999

  forEachDashSalePayment(
    inUserScope,
    hasDateFilter,
    inChartDateRange,
    () => {},
    ({ product, paidInScope, price }) => {
      const value = hasDateFilter
        ? paidInScope
        : (product.status === 'تکمیل' ? price : getApprovedPaid(product))
      const statusKey = product.status === 'تکمیل' ? 'تکمیل' : 'بیعانه'
      salesStatus[statusKey] = (salesStatus[statusKey] || 0) + value
      const name = product.name || '—'
      productSales[name] = (productSales[name] || 0) + value
    }
  )

  dashCharts.salesStatus = new Chart(document.getElementById('chartSalesStatus'), {
    type: 'pie',
    data: {
      labels: Object.keys(salesStatus),
      datasets: [{ data: Object.values(salesStatus), backgroundColor: ['#198754', '#ffc107'], borderWidth: 2, borderColor: '#fff' }]
    },
    options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { font: { family: 'Vazirmatn', size: 11 } } } } }
  })

  dashCharts.products = new Chart(document.getElementById('chartProducts'), {
    type: 'bar',
    data: {
      labels: Object.keys(productSales),
      datasets: [{ label: 'مبلغ فروش', data: Object.values(productSales), backgroundColor: '#0d6efd', borderRadius: 6 }]
    },
    options: {
      responsive: true,
      indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: { x: { ticks: { font: { family: 'monospace' }, callback: v => formatNumber(v) } } }
    }
  })

  renderAdvisorCompareChart(dateFromNum, dateToNum)
  renderSalesTimelineChart(dateFromNum, dateToNum, currentUser)
}

function advisorLabelForPhone(phone, fallbackName = '') {
  const p = normalizePhone(phone)
  const user = dashUsersCache.find(u => normalizePhone(u.phone) === p)
  if (user) return userDisplayName(user)
  if (fallbackName) return fallbackName
  return p || 'نامشخص'
}

function buildAdvisorCompareRows(dateFromNum, dateToNum) {
  const hasDateFilter = dateFromNum > 0 || dateToNum < 99999999
  function inChartDateRange(dateStr) {
    if (!hasDateFilter) return true
    if (!dateStr) return false
    const dNum = jalaliToNum(dateStr)
    return dNum >= (dateFromNum || 0) && dNum <= (dateToNum || 99999999)
  }

  const totals = new Map()
  forEachDashSalePayment(
    matchesSelectedUsers,
    hasDateFilter,
    inChartDateRange,
    () => {},
    ({ customer, product, paidInScope, price }) => {
      const phone = normalizePhone(customer.advisorPhone)
      if (!phone) return
      const value = hasDateFilter
        ? paidInScope
        : (product.status === 'تکمیل' ? price : getApprovedPaid(product))
      if (value <= 0) return
      const prev = totals.get(phone) || { phone, label: advisorLabelForPhone(phone, customer.advisor), value: 0 }
      prev.value += value
      if (!prev.label) prev.label = advisorLabelForPhone(phone, customer.advisor)
      totals.set(phone, prev)
    }
  )

  return [...totals.values()].sort((a, b) => b.value - a.value)
}

function renderAdvisorCompareChart(dateFromNum, dateToNum) {
  if (dashCharts.advisorCompare) {
    try { dashCharts.advisorCompare.destroy() } catch (_) {}
    delete dashCharts.advisorCompare
  }

  const canvas = document.getElementById('chartAdvisorCompare')
  if (!canvas || typeof Chart === 'undefined') return

  const type = document.getElementById('advisorCompareType')?.value === 'pie' ? 'pie' : 'bar'
  const rows = buildAdvisorCompareRows(dateFromNum, dateToNum)
  const labels = rows.map(r => r.label)
  const values = rows.map(r => r.value)
  const colors = rows.map((_, i) => ADVISOR_CHART_COLORS[i % ADVISOR_CHART_COLORS.length])

  const moneyTooltip = {
    callbacks: {
      label: (ctx) => {
        let amount = 0
        if (typeof ctx.parsed === 'number') amount = ctx.parsed
        else if (ctx.parsed && typeof ctx.parsed.y === 'number') amount = ctx.parsed.y
        else amount = Number(ctx.raw) || 0
        return `${ctx.label || ''}: ${formatNumber(amount)}`
      }
    }
  }

  if (type === 'pie') {
    dashCharts.advisorCompare = new Chart(canvas, {
      type: 'pie',
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: colors,
          borderWidth: 2,
          borderColor: '#fff'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { font: { family: 'Vazirmatn', size: 11 } } },
          tooltip: moneyTooltip
        }
      }
    })
    return
  }

  dashCharts.advisorCompare = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'مبلغ فروش',
        data: values,
        backgroundColor: colors,
        borderRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: moneyTooltip
      },
      scales: {
        x: { ticks: { font: { family: 'Vazirmatn', size: 11 } } },
        y: { ticks: { font: { family: 'monospace' }, callback: v => formatNumber(v) } }
      }
    }
  })
}

export function onAdvisorCompareTypeChange() {
  const dateFrom = document.getElementById('dashDateFrom')?.value.trim() || ''
  const dateTo = document.getElementById('dashDateTo')?.value.trim() || ''
  const dateFromNum = dateFrom ? jalaliToNum(dateFrom) : 0
  const dateToNum = dateTo ? jalaliToNum(dateTo) : 99999999
  renderAdvisorCompareChart(dateFromNum, dateToNum)
}

export function clearDashFilter() {
  document.getElementById('dashDateFrom').value = ''
  document.getElementById('dashDateTo').value = ''
  renderDashboard()
}
