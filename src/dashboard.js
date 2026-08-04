import { getData, getStatuses, getSalesTargets, getDeadlineUrgency, colorForDeadlineRemaining, coerceProductName } from './data.js'
import { getUsersSafe } from './auth.js'
import { loadGroupsData, organizeUsersByGroup, getGroupById, getMembersOfGroup } from './groups.js'
import {
  hasPermission, getCurrentUser, formatNumber, jalaliToNum, getTodayJalaliNum,
  jalaliAddDays, getTodayJalaliStr, escapeHtml, escapeAttr, ownsCustomer,
  normalizePhone, userDisplayName, canViewOrgWideData, jalaliDiffDays, jalaliDatePart,
  getVisibleAdvisorPhones, getStatusLabels, formatPhonesDisplay,
  ensureProductPayments, syncProductStatus, getProductPayments, getPaymentEntryStatus,
  getApprovedPaid, getProductBalance, isProductCountableInSales, PAYMENT_STATUS,
  getSaleRegistrantPhone, gregorianToJalaliStr, normalizeViewUserPhones, isMainAdmin,
  jalaliEndOfDayMs, getPaymentProfit
} from './utils.js'

let dashCharts = {}
/** @type {Set<string>|null} null = not initialized yet (treat as all) */
let selectedAdvisorPhones = null
let dashUsersCache = []
let dashUserDropdownInited = false
let salesChartDefaultsReady = false
/** True after user clicks «اعمال فیلتر» while a filter is active */
let dashFilterApplied = false
/** Cached aggregates for product chart metric toggle */
let productChartCache = { amounts: {}, counts: {} }

/** Safari/WebKit often lays out chart parents a frame late; force one resize after paint. */
function scheduleDashChartsResize() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      Object.values(dashCharts).forEach(chart => {
        try {
          if (chart && typeof chart.resize === 'function') chart.resize()
        } catch (_) { /* ignore */ }
      })
    })
  })
}

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

/** Sales metrics: match by who registered the payment (soldByPhone), not customer owner. */
function matchesSelectedSaleRegistrant({ customer, product, payment }) {
  if (!selectedAdvisorPhones || selectedAdvisorPhones.size === 0) return false
  const phone = getSaleRegistrantPhone(product, payment, customer)
  return !!(phone && selectedAdvisorPhones.has(phone))
}

/**
 * Overdue/soon follow-up tables:
 * - Group managers (viewUserPhones / team grants) → only members' customers
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
  } else if (selected === total) {
    el.textContent = '(همه)'
    if (allCb) allCb.checked = true
  } else if (selected === 0) {
    el.textContent = '(هیچ)'
    if (allCb) allCb.checked = false
  } else {
    el.textContent = `(${selected}/${total})`
    if (allCb) allCb.checked = false
  }
  syncDashGroupCheckboxes()
}

function syncDashGroupCheckboxes() {
  document.querySelectorAll('#dashUserCheckboxes .dash-group-block').forEach(block => {
    const groupCb = block.querySelector('.dash-group-cb')
    if (!groupCb) return
    const memberCbs = [...block.querySelectorAll('.dash-user-cb')]
    if (!memberCbs.length) {
      groupCb.checked = false
      groupCb.indeterminate = false
      return
    }
    const checkedCount = memberCbs.filter(cb => cb.checked).length
    groupCb.checked = checkedCount === memberCbs.length
    groupCb.indeterminate = checkedCount > 0 && checkedCount < memberCbs.length
  })
}

function buildDashGroupedUsersHtml(users) {
  const { groups, ungrouped } = organizeUsersByGroup(users)
  if (!groups.length && !ungrouped.length) {
    return '<div class="dash-user-empty">کارشناسی یافت نشد</div>'
  }

  const memberRow = (m) => {
    const phone = m.phone
    const checked = selectedAdvisorPhones?.has(phone) ? 'checked' : ''
    const name = userDisplayName(m.user) || phone
    return `<label class="dash-user-option dash-user-member">
      <input type="checkbox" class="dash-user-cb" value="${escapeAttr(phone)}" ${checked} onchange="app.toggleDashUser('${escapeAttr(phone)}', this.checked)">
      <span>${escapeHtml(name)}${m.isManager ? ' <span class="role-badge role-admin">مدیر</span>' : ''}</span>
    </label>`
  }

  const blocks = []
  for (const g of groups) {
    blocks.push(`
      <div class="dash-group-block" data-dash-group="${escapeAttr(g.id)}">
        <label class="dash-user-option dash-group-head">
          <input type="checkbox" class="dash-group-cb" data-group-id="${escapeAttr(g.id)}" onchange="app.toggleDashGroup('${escapeAttr(g.id)}', this.checked)">
          <span class="dash-group-title">${escapeHtml(g.name)}</span>
          <span class="dash-group-count">${g.members.length}</span>
        </label>
        <div class="dash-group-members">
          ${g.members.map(memberRow).join('')}
        </div>
      </div>`)
  }

  if (ungrouped.length) {
    blocks.push(`
      <div class="dash-group-block" data-dash-group="__none__">
        <label class="dash-user-option dash-group-head">
          <input type="checkbox" class="dash-group-cb" data-group-id="__none__" onchange="app.toggleDashGroup('__none__', this.checked)">
          <span class="dash-group-title">بدون گروه</span>
          <span class="dash-group-count">${ungrouped.length}</span>
        </label>
        <div class="dash-group-members">
          ${ungrouped.map(memberRow).join('')}
        </div>
      </div>`)
  }

  return blocks.join('')
}

async function ensureUserFilterUI() {
  const currentUser = getCurrentUser()
  const orgWide = canViewOrgWideData()
  const users = (await getUsersSafe()).filter(u => u.phone)
  const visiblePhones = getVisibleAdvisorPhones(currentUser)
  try { await loadGroupsData() } catch (_) { /* optional until migration */ }

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
    const { groups, ungrouped } = organizeUsersByGroup(dashUsersCache)
    const structureKey = [
      ...groups.map(g => `${g.id}:${g.members.map(m => m.phone).join(',')}`),
      `none:${ungrouped.map(m => m.phone).join(',')}`
    ].join('|')
    if (container.dataset.structureKey !== structureKey) {
      container.dataset.structureKey = structureKey
      container.innerHTML = buildDashGroupedUsersHtml(dashUsersCache)
    } else {
      container.querySelectorAll('.dash-user-cb').forEach(cb => {
        cb.checked = selectedAdvisorPhones.has(normalizePhone(cb.value))
      })
    }
  }

  const filterBtn = document.getElementById('dashUserFilterBtn')
  if (filterBtn) {
    filterBtn.innerHTML = `کارشناسان <span class="dash-user-filter-count" id="dashUserFilterCount"></span>`
  }
  const selectAllLabel = document.querySelector('#dashUserDropdown .dash-user-option-all span')
  if (selectAllLabel) selectAllLabel.textContent = 'همه کارشناسان'

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

export function toggleDashGroup(groupId, checked) {
  if (!selectedAdvisorPhones) selectedAdvisorPhones = new Set()
  const block = document.querySelector(`#dashUserCheckboxes .dash-group-block[data-dash-group="${groupId}"]`)
  if (!block) return
  block.querySelectorAll('.dash-user-cb').forEach(cb => {
    const p = normalizePhone(cb.value)
    cb.checked = !!checked
    if (checked) selectedAdvisorPhones.add(p)
    else selectedAdvisorPhones.delete(p)
  })
  updateUserFilterCount()
  renderDashboard()
}

export function toggleDashUsersAll(checked) {
  selectedAdvisorPhones = checked
    ? new Set(dashUsersCache.map(u => normalizePhone(u.phone)))
    : new Set()
  document.querySelectorAll('#dashUserCheckboxes .dash-user-cb, #dashUserCheckboxes .dash-group-cb').forEach(cb => {
    cb.checked = !!checked
    cb.indeterminate = false
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

function forEachDashSalePayment(matchPayment, hasDateFilter, inDateRange, onPayment, onProduct = null, statusFilter = PAYMENT_STATUS.approved) {
  const data = getData()
  data.customers.forEach(c => {
    if (c.id.startsWith('LD') && !hasPermission('customers_ld')) return
    if (c.id.startsWith('CS') && !hasPermission('customers_cs')) return
    ;(c.products || []).forEach(p => {
      ensureProductPayments(p)
      syncProductStatus(p)
      if (!isProductCountableInSales(p)) return

      const pays = getProductPayments(p).filter(pay => {
        const amount = parseFloat(pay.amount) || 0
        if (amount <= 0) return false
        if (getPaymentEntryStatus(pay) !== statusFilter) return false
        if (hasDateFilter && !inDateRange(jalaliDatePart(pay.soldAt))) return false
        if (matchPayment && !matchPayment({ customer: c, product: p, payment: pay })) return false
        return true
      })

      if (pays.length === 0) return

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

function computeDashSalesMetrics(hasDateFilter, inDateRange) {
  let salesCount = 0
  let totalCash = 0
  let totalDeposit = 0
  let totalBalance = 0
  let totalApproved = 0
  let totalPending = 0
  let totalNet = 0
  let totalGross = 0

  // Approved payments — attributed to registrant (soldByPhone)
  forEachDashSalePayment(matchesSelectedSaleRegistrant, hasDateFilter, inDateRange, ({ amount, product }) => {
    totalApproved += amount
    const split = getPaymentProfit(product, amount)
    totalNet += split.net
    totalGross += split.gross
  }, ({ product, paidInScope, balance }) => {
    salesCount++
    if (product.status === 'تکمیل') totalCash += paidInScope
    else {
      totalDeposit += paidInScope
      totalBalance += balance
    }
  })

  // Pending accounting approval amounts
  forEachDashSalePayment(
    matchesSelectedSaleRegistrant,
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
    totalPending,
    totalNet,
    totalGross
  }
}

function renderSalesTimelineChart(dateFromNum, dateToNum, currentUser) {
  const canvas = document.getElementById('chartSalesTimeline')
  if (!canvas || typeof Chart === 'undefined') return
  destroyDashChart('salesTimeline')
  destroyDashChart(canvas)
  if (!syncSalesChartTimeframeOptions()) return

  const from = document.getElementById('salesChartFrom').value.trim()
  const to = document.getElementById('salesChartTo').value.trim()
  const timeframe = document.getElementById('salesChartTimeframe').value || 'day'
  const buckets = buildSalesBuckets(from, to, timeframe)
  const totals = buckets.map(() => 0)
  const chartFromNum = jalaliToNum(from)
  const chartToNum = jalaliToNum(to)

  forEachDashSalePayment(
    matchesSelectedSaleRegistrant,
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
  scheduleDashChartsResize()
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
  const badgeEl = document.getElementById('dash-transfer-badge')
  if (badgeEl) badgeEl.textContent = String(transfers.length)

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
    if (from && selectedAdvisorPhones?.has(from)) {
      ensureRow(from, t.fromAdvisorName).out++
    }
    if (to && selectedAdvisorPhones?.has(to)) {
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
  const salesMetrics = computeDashSalesMetrics(hasDateFilter, inDateRange)

  document.getElementById('dash-sales-count').textContent = salesMetrics.salesCount
  document.getElementById('dash-sales-cash').textContent = formatNumber(salesMetrics.totalCash) + ' ریال'
  document.getElementById('dash-sales-deposit').textContent = formatNumber(salesMetrics.totalDeposit) + ' ریال'
  document.getElementById('dash-sales-balance').textContent = formatNumber(salesMetrics.totalBalance) + ' ریال'
  document.getElementById('dash-sales-total').textContent = formatNumber(salesMetrics.totalApproved) + ' ریال'
  const netEl = document.getElementById('dash-sales-net')
  if (netEl) netEl.textContent = formatNumber(salesMetrics.totalNet) + ' ریال'
  const grossEl = document.getElementById('dash-sales-gross')
  if (grossEl) grossEl.textContent = formatNumber(salesMetrics.totalGross) + ' ریال'
  const pendingEl = document.getElementById('dash-sales-pending')
  if (pendingEl) pendingEl.textContent = formatNumber(salesMetrics.totalPending) + ' ریال'

  const avgSale = salesMetrics.salesCount > 0
    ? Math.round(salesMetrics.totalApproved / salesMetrics.salesCount)
    : 0
  document.getElementById('dash-avg-sale').textContent = formatNumber(avgSale) + ' ریال'

  try {
    renderTransferMetrics(dateFromNum, dateToNum)
  } catch (e) {
    console.error('renderTransferMetrics error:', e)
  }

  const overdueBody = document.getElementById('dashOverdueBody')
  if (overdueBody) {
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
  }

  const soonBody = document.getElementById('dashSoonBody')
  if (soonBody) {
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
  }

  try {
    renderDashCharts(dateFromNum, dateToNum, currentUser)
  } catch (e) {
    console.error('renderDashCharts error:', e)
  }
}

function destroyDashChart(keyOrCanvas) {
  try {
    if (typeof keyOrCanvas === 'string') {
      const existing = dashCharts[keyOrCanvas]
      if (existing) {
        existing.destroy()
        delete dashCharts[keyOrCanvas]
      }
      return
    }
    if (keyOrCanvas && typeof Chart !== 'undefined' && typeof Chart.getChart === 'function') {
      const bound = Chart.getChart(keyOrCanvas)
      if (bound) bound.destroy()
    }
  } catch (_) { /* ignore */ }
}

function destroyAllDashCharts() {
  Object.keys(dashCharts).forEach(key => destroyDashChart(key))
  dashCharts = {}
  ;['chartCustomers', 'chartSalesStatus', 'chartProducts', 'chartAdvisorCompare', 'chartSalesTimeline']
    .forEach(id => {
      const canvas = document.getElementById(id)
      if (canvas) destroyDashChart(canvas)
    })
}

const CHART_FONT = { family: 'Vazirmatn', size: 11 }
const CHART_RESPONSIVE = { responsive: true, maintainAspectRatio: false }

function renderDashCharts(dateFromNum, dateToNum, currentUser) {
  destroyAllDashCharts()

  function inChartDateRange(dateStr) {
    if (!dateFromNum && (!dateToNum || dateToNum === 99999999)) return true
    if (!dateStr) return false
    const dNum = jalaliToNum(dateStr)
    return dNum >= (dateFromNum || 0) && dNum <= (dateToNum || 99999999)
  }

  function inUserScope(c) {
    return matchesSelectedUsers(c)
  }

  try {
    const data = getData()
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
    const custCanvas = document.getElementById('chartCustomers')
    if (custCanvas && typeof Chart !== 'undefined') {
      dashCharts.custStatus = new Chart(custCanvas, {
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
        options: {
          ...CHART_RESPONSIVE,
          plugins: { legend: { position: 'bottom', labels: { font: CHART_FONT } } }
        }
      })
    }
  } catch (e) {
    console.error('custStatus chart error:', e)
  }

  const salesStatus = { 'تکمیل': 0, 'بیعانه': 0 }
  const productSales = {}
  const productCounts = {}
  const hasDateFilter = dateFromNum > 0 || dateToNum < 99999999

  try {
    forEachDashSalePayment(
      matchesSelectedSaleRegistrant,
      hasDateFilter,
      inChartDateRange,
      () => {},
      ({ product, paidInScope }) => {
        const value = paidInScope
        const statusKey = product.status === 'تکمیل' ? 'تکمیل' : 'بیعانه'
        salesStatus[statusKey] = (salesStatus[statusKey] || 0) + value
        const name = coerceProductName(product.name) || '—'
        productSales[name] = (productSales[name] || 0) + value
        productCounts[name] = (productCounts[name] || 0) + 1
      }
    )

    const salesCanvas = document.getElementById('chartSalesStatus')
    if (salesCanvas && typeof Chart !== 'undefined') {
      dashCharts.salesStatus = new Chart(salesCanvas, {
        type: 'pie',
        data: {
          labels: Object.keys(salesStatus),
          datasets: [{ data: Object.values(salesStatus), backgroundColor: ['#198754', '#ffc107'], borderWidth: 2, borderColor: '#fff' }]
        },
        options: {
          ...CHART_RESPONSIVE,
          plugins: { legend: { position: 'bottom', labels: { font: CHART_FONT } } }
        }
      })
    }
  } catch (e) {
    console.error('salesStatus chart error:', e)
  }

  try {
    renderProductSalesChart(productSales, productCounts)
  } catch (e) {
    console.error('products chart error:', e)
  }

  try {
    renderAdvisorCompareChart(dateFromNum, dateToNum)
  } catch (e) {
    console.error('advisorCompare chart error:', e)
  }

  try {
    renderSalesTimelineChart(dateFromNum, dateToNum, currentUser)
  } catch (e) {
    console.error('salesTimeline chart error:', e)
  }

  try {
    renderDashTargetsProgress(dateFromNum, dateToNum)
  } catch (e) {
    console.error('targets progress error:', e)
  }

  scheduleDashChartsResize()
}

function targetDeadlineInfo(endDate) {
  if (!endDate) return null
  const today = getTodayJalaliStr()
  const daysLeft = jalaliDiffDays(today, endDate)
  if (daysLeft == null) return null
  if (daysLeft < 0) {
    return { text: 'مهلت گذشته', className: 'is-overdue', overdue: true, warning: false }
  }
  if (daysLeft === 0) {
    return { text: 'مهلت امروز', className: 'is-warning', overdue: false, warning: true }
  }
  if (daysLeft <= 3) {
    return { text: `${formatNumber(daysLeft)} روز مانده`, className: 'is-warning', overdue: false, warning: true }
  }
  return { text: `${formatNumber(daysLeft)} روز مانده`, className: '', overdue: false, warning: false }
}

function computeSalesTargetCurrent(target, dateFromNum, dateToNum, phoneSet = null) {
  const fromNum = target.startDate ? jalaliToNum(target.startDate) : (dateFromNum || 0)
  const toNum = target.endDate ? jalaliToNum(target.endDate) : (dateToNum || 99999999)
  const hasDateFilter = fromNum > 0 || toNum < 99999999
  function inRange(dateStr) {
    if (!hasDateFilter) return true
    if (!dateStr) return false
    const n = jalaliToNum(dateStr)
    return n >= fromNum && n <= toNum
  }

  const productSet = new Set(target.productNames || [])
  function productOk(name) {
    return productSet.size === 0 || productSet.has(name || '')
  }

  // Target progress ignores dashboard advisor checkboxes; scope via phoneSet when set.
  const matchPayment = phoneSet
    ? ({ customer, product, payment }) => {
        const phone = normalizePhone(getSaleRegistrantPhone(product, payment, customer) || '')
        return !!(phone && phoneSet.has(phone))
      }
    : () => true

  let current = 0
  if (target.metric === 'count') {
    forEachDashSalePayment(
      matchPayment,
      hasDateFilter,
      inRange,
      () => {},
      ({ product }) => {
        if (!productOk(product.name)) return
        current++
      }
    )
  } else {
    forEachDashSalePayment(
      matchPayment,
      hasDateFilter,
      inRange,
      ({ product, amount }) => {
        if (!productOk(product.name)) return
        current += amount
      }
    )
  }
  return current
}

function memberPhoneSetForUserGroup(userGroupId) {
  const phones = new Set()
  for (const m of getMembersOfGroup(userGroupId) || []) {
    const phone = normalizePhone(m.user_phone || '')
    if (phone) phones.add(phone)
  }
  return phones
}

function renderDashTargetBar(bar, dateFromNum, dateToNum, groupTitle, options = {}) {
  const goal = options.goalOverride != null ? Number(options.goalOverride) : (Number(bar.value) || 0)
  const current = computeSalesTargetCurrent(bar, dateFromNum, dateToNum, options.phoneSet || null)
  const pct = goal > 0 ? Math.min(100, Math.round((current / goal) * 1000) / 10) : 0
  const complete = goal > 0 && current >= goal
  const deadline = targetDeadlineInfo(bar.endDate)
  let fillClass = ''
  if (complete) fillClass = 'is-complete'
  else if (deadline?.overdue) fillClass = 'is-overdue'
  else if (deadline?.warning) fillClass = 'is-warning'

  const unit = bar.metric === 'count' ? 'فروش' : 'ریال'
  const currentLabel = `${formatNumber(current)} ${unit}`
  const goalLabel = `${formatNumber(goal)} ${unit}`
  const productsHint = (bar.productNames || []).length
    ? bar.productNames.join('، ')
    : 'همه محصولات'
  const metricHint = bar.metric === 'count' ? 'تعداد' : 'مبلغ تأییدشده'
  const ariaLabel = `${groupTitle} — ${metricHint} · ${productsHint}`

  return `
    <div class="dash-target-row">
      <div class="dash-target-values">
        <span>${currentLabel} / ${goalLabel}</span>
        <span class="dash-target-pct">${formatNumber(pct)}٪</span>
      </div>
      <div class="dash-target-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}" aria-label="${escapeAttr(ariaLabel)}">
        <div class="dash-target-bar-fill ${fillClass}" style="width:${pct}%;"></div>
      </div>
      ${deadline ? `<div class="dash-target-deadline ${deadline.className}">${escapeHtml(deadline.text)}${bar.endDate ? ` · تا ${escapeHtml(bar.endDate)}` : ''}</div>` : ''}
    </div>
  `
}

function buildDashTargetBlocks(targets, viewer) {
  const blocks = []
  const admin = isMainAdmin(viewer)
  const managerGroupId = viewer?.isGroupManager && viewer?.groupId ? viewer.groupId : null

  for (const target of targets || []) {
    const title = target.title || 'گروه تارگت'
    const items = target.items || []
    if (!items.length) continue

    if (admin) {
      blocks.push({
        key: `${target.id}-org`,
        scope: 'org',
        userGroupId: null,
        groupName: null,
        title,
        className: 'is-org',
        bars: items.map(bar => ({ bar, goalOverride: null, phoneSet: null }))
      })
    }

    for (const alloc of target.allocations || []) {
      if (!admin && (!managerGroupId || alloc.userGroupId !== managerGroupId)) continue
      const ug = getGroupById(alloc.userGroupId)
      const groupName = ug?.name || 'گروه'
      const phoneSet = memberPhoneSetForUserGroup(alloc.userGroupId)
      const shareMap = new Map((alloc.shares || []).map(s => [s.barId, Number(s.value)]))
      const bars = items
        .map(bar => {
          const shareVal = shareMap.get(bar.id)
          if (!(shareVal > 0)) return null
          return { bar, goalOverride: shareVal, phoneSet }
        })
        .filter(Boolean)
      if (!bars.length) continue
      blocks.push({
        key: `${target.id}-${alloc.userGroupId}`,
        scope: `group:${alloc.userGroupId}`,
        userGroupId: alloc.userGroupId,
        groupName,
        title,
        className: 'is-group-alloc',
        bars
      })
    }
  }

  return blocks
}

function buildDashTargetScopeOptions(blocks, viewer) {
  const options = []
  const admin = isMainAdmin(viewer)
  if (admin && blocks.some(b => b.scope === 'org')) {
    options.push({ value: 'org', label: 'تارگت کلی' })
  }
  const seen = new Set()
  for (const block of blocks) {
    if (!block.userGroupId || seen.has(block.userGroupId)) continue
    seen.add(block.userGroupId)
    options.push({
      value: `group:${block.userGroupId}`,
      label: block.groupName || 'گروه'
    })
  }
  return options
}

function syncDashTargetsScopeSelect(options) {
  const sel = document.getElementById('dashTargetsScope')
  if (!sel) return options[0]?.value || 'org'

  const prev = sel.value
  const preferred = options.some(o => o.value === prev)
    ? prev
    : (options.some(o => o.value === 'org') ? 'org' : (options[0]?.value || 'org'))

  sel.innerHTML = options.map(o =>
    `<option value="${escapeAttr(o.value)}">${escapeHtml(o.label)}</option>`
  ).join('')
  sel.value = preferred
  sel.hidden = options.length <= 1
  return preferred
}

let _lastDashTargetDates = { from: 0, to: 99999999 }

function syncDashTargetsCardTitle(viewer) {
  const titleEl = document.getElementById('dashTargetsCardTitle')
  if (!titleEl) return
  const groupName = (
    viewer?.isGroupManager && !isMainAdmin(viewer)
      ? (viewer.groupName || getGroupById(viewer.groupId)?.name || '')
      : ''
  ).trim()
  titleEl.textContent = groupName
    ? `پیشرفت تارگت فروش ${groupName}`
    : 'پیشرفت تارگت فروش'
}

function renderDashTargetsProgress(dateFromNum, dateToNum) {
  const el = document.getElementById('dashTargetsProgress')
  if (!el) return

  _lastDashTargetDates = {
    from: dateFromNum || 0,
    to: dateToNum || 99999999
  }

  const viewer = getCurrentUser()
  syncDashTargetsCardTitle(viewer)
  const canSee =
    isMainAdmin(viewer) ||
    !!(viewer?.isGroupManager && viewer?.groupId)

  const scopeSel = document.getElementById('dashTargetsScope')

  if (!canSee) {
    if (scopeSel) scopeSel.hidden = true
    el.innerHTML = '<div class="dash-targets-empty">تارگتی برای نقش شما تعریف نشده است.</div>'
    return
  }

  let targets = []
  try {
    targets = getSalesTargets()
  } catch (e) {
    console.error('getSalesTargets error:', e)
    if (scopeSel) scopeSel.hidden = true
    el.innerHTML = '<div class="dash-targets-empty">خطا در خواندن تارگت‌ها</div>'
    return
  }

  if (!targets.length) {
    if (scopeSel) scopeSel.hidden = true
    el.innerHTML = '<div class="dash-targets-empty">هنوز تارگتی تعریف نشده. از تنظیمات سیستم اضافه کنید.</div>'
    return
  }

  let blocks = []
  try {
    blocks = buildDashTargetBlocks(targets, viewer)
  } catch (e) {
    console.error('buildDashTargetBlocks error:', e)
    if (scopeSel) scopeSel.hidden = true
    el.innerHTML = '<div class="dash-targets-empty">خطا در آماده‌سازی تارگت‌ها</div>'
    return
  }

  if (!blocks.length) {
    if (scopeSel) scopeSel.hidden = true
    el.innerHTML = isMainAdmin(viewer)
      ? '<div class="dash-targets-empty">هنوز تارگتی تعریف نشده. از تنظیمات سیستم اضافه کنید.</div>'
      : '<div class="dash-targets-empty">سهمیه‌ای برای گروه شما تعریف نشده است.</div>'
    return
  }

  const options = buildDashTargetScopeOptions(blocks, viewer)
  const selectedScope = syncDashTargetsScopeSelect(options)
  const visibleBlocks = blocks.filter(b => b.scope === selectedScope)

  if (!visibleBlocks.length) {
    el.innerHTML = '<div class="dash-targets-empty">نواری برای نمایش نیست</div>'
    return
  }

  el.innerHTML = visibleBlocks.map(block => {
    try {
      const barsHtml = (block.bars || []).map(({ bar, goalOverride, phoneSet }) => {
        try {
          return renderDashTargetBar(bar, dateFromNum, dateToNum, block.title || '', {
            goalOverride,
            phoneSet
          })
        } catch (e) {
          console.error('renderDashTargetBar error:', e, bar)
          return ''
        }
      }).join('')
      return `
        <div class="dash-target-group ${escapeAttr(block.className || '')}">
          <div class="dash-target-group-title">${escapeHtml(block.title || 'گروه تارگت')}</div>
          <div class="dash-target-group-bars">${barsHtml || '<div class="dash-targets-empty">نواری برای نمایش نیست</div>'}</div>
        </div>
      `
    } catch (e) {
      console.error('renderDashTargets block error:', e, block)
      return ''
    }
  }).join('')
}

export function onDashTargetsScopeChange() {
  renderDashTargetsProgress(_lastDashTargetDates.from, _lastDashTargetDates.to)
}

function buildMemberTargetBlocks(targets, groupId) {
  if (!groupId) return []
  const blocks = []
  const phoneSet = memberPhoneSetForUserGroup(groupId)
  const ug = getGroupById(groupId)
  const groupName = ug?.name || 'گروه شما'

  for (const target of targets || []) {
    const items = target.items || []
    if (!items.length) continue
    const alloc = (target.allocations || []).find(a => a.userGroupId === groupId)
    if (!alloc) continue
    const shareMap = new Map((alloc.shares || []).map(s => [s.barId, Number(s.value)]))
    const bars = items
      .map(bar => {
        const shareVal = shareMap.get(bar.id)
        if (!(shareVal > 0)) return null
        return { bar, goalOverride: shareVal, phoneSet }
      })
      .filter(Boolean)
    if (!bars.length) continue
    blocks.push({
      key: `${target.id}-${groupId}`,
      title: target.title || 'تارگت فروش',
      groupName,
      bars
    })
  }
  return blocks
}

function salesTargetStage(pct, complete) {
  if (complete || pct >= 100) return 'is-done'
  if (pct >= 90) return 'is-near'
  if (pct >= 75) return 'is-push'
  if (pct >= 50) return 'is-mid'
  return 'is-start'
}

function salesTargetMotivationalCopy(pct, remainingLabel, complete, deadline) {
  if (complete) {
    return {
      message: 'عالی بود — <strong>تارگت محقق شد</strong>. همین ریتم را نگه دارید.',
      gap: 'هدف گروه تکمیل شد'
    }
  }
  if (deadline?.overdue) {
    return {
      message: 'مهلت گذشته، اما هنوز می‌توانید فاصله را کم کنید.',
      gap: remainingLabel ? `هنوز ${remainingLabel} مانده` : ''
    }
  }
  if (pct >= 90) {
    return {
      message: 'تقریباً تمام است — <strong>یک قدم دیگر تا تارگت</strong>.',
      gap: remainingLabel ? `فقط ${remainingLabel} مانده` : ''
    }
  }
  if (pct >= 75) {
    return {
      message: 'نزدیک هدف هستید — الان بهترین زمان برای فشار نهایی است.',
      gap: remainingLabel ? `هنوز ${remainingLabel} مانده` : ''
    }
  }
  if (pct >= 50) {
    return {
      message: 'نیمه راه را رد کردید — شتاب‌تان خوب است.',
      gap: remainingLabel ? `هنوز ${remainingLabel} مانده` : ''
    }
  }
  if (pct > 0) {
    return {
      message: 'شروع قوی — هر فروش شما را به هدف نزدیک‌تر می‌کند.',
      gap: remainingLabel ? `هنوز ${remainingLabel} مانده` : ''
    }
  }
  return {
    message: 'تارگت گروه آماده‌ است — اولین فروش، مسیر را باز می‌کند.',
    gap: remainingLabel ? `هدف: ${remainingLabel}` : ''
  }
}

function formatSalesTargetRemaining(bar, current, goal) {
  const left = Math.max(0, goal - current)
  if (left <= 0) return ''
  if (bar.metric === 'count') return `${formatNumber(left)} فروش`
  return `${formatNumber(left)} ریال`
}

function computeSalesTargetBarProgress(bar, goalOverride, phoneSet) {
  const goal = goalOverride != null ? Number(goalOverride) : (Number(bar.value) || 0)
  const current = computeSalesTargetCurrent(bar, 0, 99999999, phoneSet || null)
  const pctRaw = goal > 0 ? (current / goal) * 100 : 0
  const pct = goal > 0 ? Math.min(100, Math.round(pctRaw * 10) / 10) : 0
  const complete = goal > 0 && current >= goal
  const deadline = targetDeadlineInfo(bar.endDate)
  const unit = bar.metric === 'count' ? 'فروش' : 'ریال'
  return {
    goal,
    current,
    pct,
    complete,
    deadline,
    unit,
    remainingLabel: formatSalesTargetRemaining(bar, current, goal),
    currentLabel: `${formatNumber(current)} ${unit}`,
    goalLabel: `${formatNumber(goal)} ${unit}`
  }
}

function padTimerPart(n) {
  return String(Math.max(0, Math.floor(n))).padStart(2, '0')
}

function splitCountdownParts(remainingMs) {
  const totalSec = Math.max(0, Math.floor(remainingMs / 1000))
  const days = Math.floor(totalSec / 86400)
  const hours = Math.floor((totalSec % 86400) / 3600)
  const minutes = Math.floor((totalSec % 3600) / 60)
  const seconds = totalSec % 60
  return { days, hours, minutes, seconds, remainingMs }
}

function renderSalesTargetCountdownHtml(deadlineMs) {
  if (!deadlineMs) return ''
  const remainingMs = deadlineMs - Date.now()
  let urgency
  try {
    urgency = getDeadlineUrgency()
  } catch (_) {
    urgency = null
  }
  const color = colorForDeadlineRemaining(remainingMs, urgency)
  if (!(remainingMs > 0)) {
    return `
      <div class="sales-target-countdown is-overdue" style="--timer-color:${escapeAttr(color)}" data-deadline-ms="${escapeAttr(String(deadlineMs))}" role="timer" aria-live="polite">
        <span class="sales-target-countdown-ended">مهلت تمام شد</span>
      </div>
    `
  }
  const parts = splitCountdownParts(remainingMs)
  return `
    <div class="sales-target-countdown" style="--timer-color:${escapeAttr(color)}" data-deadline-ms="${escapeAttr(String(deadlineMs))}" role="timer" aria-live="off">
      <div class="sales-target-countdown-unit">
        <span class="sales-target-countdown-val" data-part="days">${padTimerPart(parts.days)}</span>
        <span class="sales-target-countdown-lbl">روز</span>
      </div>
      <span class="sales-target-countdown-sep" aria-hidden="true">:</span>
      <div class="sales-target-countdown-unit">
        <span class="sales-target-countdown-val" data-part="hours">${padTimerPart(parts.hours)}</span>
        <span class="sales-target-countdown-lbl">ساعت</span>
      </div>
      <span class="sales-target-countdown-sep" aria-hidden="true">:</span>
      <div class="sales-target-countdown-unit">
        <span class="sales-target-countdown-val" data-part="minutes">${padTimerPart(parts.minutes)}</span>
        <span class="sales-target-countdown-lbl">دقیقه</span>
      </div>
      <span class="sales-target-countdown-sep" aria-hidden="true">:</span>
      <div class="sales-target-countdown-unit is-seconds">
        <span class="sales-target-countdown-val" data-part="seconds">${padTimerPart(parts.seconds)}</span>
        <span class="sales-target-countdown-lbl">ثانیه</span>
      </div>
    </div>
  `
}

let _salesTargetCountdownTimer = null

function stopSalesTargetCountdown() {
  if (_salesTargetCountdownTimer) {
    clearInterval(_salesTargetCountdownTimer)
    _salesTargetCountdownTimer = null
  }
}

function tickSalesTargetCountdowns() {
  const wrap = document.getElementById('salesTargetBand')
  if (!wrap || wrap.hidden) {
    stopSalesTargetCountdown()
    return
  }
  let urgency
  try {
    urgency = getDeadlineUrgency()
  } catch (_) {
    urgency = null
  }
  const nodes = wrap.querySelectorAll('.sales-target-countdown[data-deadline-ms]')
  if (!nodes.length) {
    stopSalesTargetCountdown()
    return
  }
  nodes.forEach(node => {
    const deadlineMs = Number(node.getAttribute('data-deadline-ms'))
    if (!Number.isFinite(deadlineMs)) return
    const remainingMs = deadlineMs - Date.now()
    const color = colorForDeadlineRemaining(remainingMs, urgency)
    node.style.setProperty('--timer-color', color)

    if (!(remainingMs > 0)) {
      if (!node.classList.contains('is-overdue')) {
        node.classList.add('is-overdue')
        node.innerHTML = '<span class="sales-target-countdown-ended">مهلت تمام شد</span>'
      }
      return
    }

    const parts = splitCountdownParts(remainingMs)
    const setPart = (name, value) => {
      const el = node.querySelector(`[data-part="${name}"]`)
      if (el) el.textContent = padTimerPart(value)
    }
    setPart('days', parts.days)
    setPart('hours', parts.hours)
    setPart('minutes', parts.minutes)
    setPart('seconds', parts.seconds)
  })
}

function startSalesTargetCountdown() {
  stopSalesTargetCountdown()
  const wrap = document.getElementById('salesTargetBand')
  if (!wrap || wrap.hidden) return
  if (!wrap.querySelector('.sales-target-countdown[data-deadline-ms]')) return
  tickSalesTargetCountdowns()
  _salesTargetCountdownTimer = setInterval(tickSalesTargetCountdowns, 1000)
}

function pickSalesTargetDeadlineMs(progresses) {
  const candidates = (progresses || [])
    .filter(p => !p.complete && p.bar?.endDate)
    .map(p => ({ endDate: p.bar.endDate, ms: jalaliEndOfDayMs(p.bar.endDate) }))
    .filter(c => c.ms != null)
  if (!candidates.length) return null
  candidates.sort((a, b) => a.ms - b.ms)
  return candidates[0].ms
}

function renderSalesTargetCampaignHtml(block) {
  const progresses = (block.bars || []).map(({ bar, goalOverride, phoneSet }) => ({
    bar,
    ...computeSalesTargetBarProgress(bar, goalOverride, phoneSet)
  }))
  if (!progresses.length) return ''

  const incomplete = progresses.filter(p => !p.complete)
  const focus = incomplete.length
    ? incomplete.reduce((a, b) => (a.pct <= b.pct ? a : b))
    : progresses[0]
  const avgPct = progresses.reduce((s, p) => s + p.pct, 0) / progresses.length
  const allDone = progresses.every(p => p.complete)
  const stage = salesTargetStage(focus.pct, allDone)
  const copy = salesTargetMotivationalCopy(
    focus.pct,
    focus.remainingLabel,
    allDone,
    focus.deadline
  )

  const deadlineMs = allDone ? null : pickSalesTargetDeadlineMs(progresses)
  const deadlineChip = allDone
    ? `<span class="sales-target-deadline-chip is-done">تکمیل شد</span>`
    : (deadlineMs ? renderSalesTargetCountdownHtml(deadlineMs) : '')

  const ringPct = Math.round(allDone ? 100 : avgPct)
  const barsHtml = progresses.map(p => `
    <div class="sales-target-bar-row">
      <div class="sales-target-bar-meta">
        <span>${escapeHtml(p.currentLabel)} / ${escapeHtml(p.goalLabel)}</span>
        <span class="pct">${formatNumber(p.pct)}٪</span>
      </div>
      <div class="sales-target-bar-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(p.pct)}" aria-label="${escapeAttr(block.title || 'تارگت')}">
        <div class="sales-target-bar-fill" style="width:${p.pct}%;"></div>
      </div>
    </div>
  `).join('')

  return `
    <article class="sales-target-band ${stage}">
      <div class="sales-target-band-inner">
        <div class="sales-target-ring" style="--pct:${ringPct}" aria-hidden="true">
          <div class="sales-target-ring-inner">
            <span class="sales-target-ring-value">${formatNumber(ringPct)}٪</span>
            <span class="sales-target-ring-label">پیشرفت</span>
          </div>
        </div>
        <div class="sales-target-band-body">
          <div class="sales-target-band-head">
            <div>
              <div class="sales-target-eyebrow">تارگت ${escapeHtml(block.groupName || 'گروه')}</div>
              <h3 class="sales-target-title">${escapeHtml(block.title || 'تارگت فروش')}</h3>
            </div>
            ${deadlineChip}
          </div>
          <p class="sales-target-message">${copy.message}</p>
          ${copy.gap ? `<div class="sales-target-gap">${escapeHtml(copy.gap)}</div>` : ''}
          <div class="sales-target-bars">${barsHtml}</div>
        </div>
      </div>
    </article>
  `
}

/** Motivational group-target band for the Sales tab (members & group managers). */
export function renderSalesTargetBand() {
  const wrap = document.getElementById('salesTargetBand')
  if (!wrap) return

  stopSalesTargetCountdown()

  const viewer = getCurrentUser()
  const groupId = viewer?.groupId || null

  if (!groupId || isMainAdmin(viewer)) {
    wrap.hidden = true
    wrap.innerHTML = ''
    return
  }

  let targets = []
  try {
    targets = getSalesTargets()
  } catch (e) {
    console.error('renderSalesTargetBand getSalesTargets:', e)
    wrap.hidden = true
    wrap.innerHTML = ''
    return
  }

  let blocks = []
  try {
    blocks = buildMemberTargetBlocks(targets, groupId)
  } catch (e) {
    console.error('renderSalesTargetBand build blocks:', e)
    wrap.hidden = true
    wrap.innerHTML = ''
    return
  }

  if (!blocks.length) {
    wrap.hidden = true
    wrap.innerHTML = ''
    return
  }

  try {
    wrap.innerHTML = blocks.map(renderSalesTargetCampaignHtml).filter(Boolean).join('')
    wrap.hidden = !wrap.innerHTML.trim()
    if (!wrap.hidden) {
      const fills = [...wrap.querySelectorAll('.sales-target-bar-fill')]
      fills.forEach(el => {
        const w = el.style.width
        el.style.width = '0%'
        requestAnimationFrame(() => {
          requestAnimationFrame(() => { el.style.width = w })
        })
      })
      startSalesTargetCountdown()
    }
  } catch (e) {
    console.error('renderSalesTargetBand render:', e)
    wrap.hidden = true
    wrap.innerHTML = ''
  }
}

function renderProductSalesChart(productSales = null, productCounts = null) {
  if (productSales) productChartCache.amounts = productSales
  if (productCounts) productChartCache.counts = productCounts

  const metric = document.getElementById('productChartMetric')?.value === 'count' ? 'count' : 'amount'
  const source = metric === 'count' ? productChartCache.counts : productChartCache.amounts
  const labels = Object.keys(source || {})
  const values = Object.values(source || {})
  const label = metric === 'count' ? 'تعداد فروش' : 'مبلغ فروش'

  const canvas = document.getElementById('chartProducts')
  if (!canvas || typeof Chart === 'undefined') return

  destroyDashChart('products')
  destroyDashChart(canvas)

  dashCharts.products = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label, data: values, backgroundColor: '#0d6efd', borderRadius: 6 }]
    },
    options: {
      ...CHART_RESPONSIVE,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          ticks: {
            font: { family: 'Vazirmatn', size: 10 },
            maxRotation: 45,
            minRotation: 0
          }
        },
        y: {
          beginAtZero: true,
          ticks: {
            font: { family: 'monospace' },
            callback: v => (metric === 'count' && !Number.isInteger(v)) ? undefined : formatNumber(v)
          }
        }
      }
    }
  })
  scheduleDashChartsResize()
}

export function onProductChartMetricChange() {
  renderProductSalesChart()
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
    matchesSelectedSaleRegistrant,
    hasDateFilter,
    inChartDateRange,
    ({ customer, product, payment, amount }) => {
      const phone = getSaleRegistrantPhone(product, payment, customer)
      if (!phone || amount <= 0) return
      const net = getPaymentProfit(product, amount).net
      const prev = totals.get(phone) || {
        phone,
        label: advisorLabelForPhone(phone, customer.advisor),
        value: 0
      }
      prev.value += net
      if (!prev.label) prev.label = advisorLabelForPhone(phone, customer.advisor)
      totals.set(phone, prev)
    }
  )

  return [...totals.values()].sort((a, b) => b.value - a.value)
}

function renderAdvisorCompareChart(dateFromNum, dateToNum) {
  const canvas = document.getElementById('chartAdvisorCompare')
  if (!canvas || typeof Chart === 'undefined') return

  destroyDashChart('advisorCompare')
  destroyDashChart(canvas)

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
        ...CHART_RESPONSIVE,
        plugins: {
          legend: { position: 'bottom', labels: { font: CHART_FONT } },
          tooltip: moneyTooltip
        }
      }
    })
    scheduleDashChartsResize()
    return
  }

  dashCharts.advisorCompare = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'سود خالص',
        data: values,
        backgroundColor: colors,
        borderRadius: 6
      }]
    },
    options: {
      ...CHART_RESPONSIVE,
      plugins: {
        legend: { display: false },
        tooltip: moneyTooltip
      },
      scales: {
        x: { ticks: { font: CHART_FONT } },
        y: { ticks: { font: { family: 'monospace' }, callback: v => formatNumber(v) } }
      }
    }
  })
  scheduleDashChartsResize()
}

export function onAdvisorCompareTypeChange() {
  const dateFrom = document.getElementById('dashDateFrom')?.value.trim() || ''
  const dateTo = document.getElementById('dashDateTo')?.value.trim() || ''
  const dateFromNum = dateFrom ? jalaliToNum(dateFrom) : 0
  const dateToNum = dateTo ? jalaliToNum(dateTo) : 99999999
  renderAdvisorCompareChart(dateFromNum, dateToNum)
}

export function applyDashFilter() {
  dashFilterApplied = hasActiveDashFilter()
  updateDashClearFilterBtn()
  renderDashboard()
}

export function clearDashFilter() {
  document.getElementById('dashDateFrom').value = ''
  document.getElementById('dashDateTo').value = ''
  if (dashUsersCache.length) {
    selectedAdvisorPhones = new Set(dashUsersCache.map(u => normalizePhone(u.phone)))
    document.querySelectorAll('#dashUserCheckboxes .dash-user-cb, #dashUserCheckboxes .dash-group-cb').forEach(cb => {
      cb.checked = true
      cb.indeterminate = false
    })
    const selectAll = document.getElementById('dashUserSelectAll')
    if (selectAll) {
      selectAll.checked = true
      selectAll.indeterminate = false
    }
    updateUserFilterCount()
  }
  dashFilterApplied = false
  updateDashClearFilterBtn()
  renderDashboard()
}

function hasActiveDashFilter() {
  const dateFrom = document.getElementById('dashDateFrom')?.value.trim() || ''
  const dateTo = document.getElementById('dashDateTo')?.value.trim() || ''
  if (dateFrom || dateTo) return true
  if (dashUsersCache.length && selectedAdvisorPhones && selectedAdvisorPhones.size < dashUsersCache.length) {
    return true
  }
  return false
}

function updateDashClearFilterBtn() {
  const btn = document.getElementById('dashClearFilterBtn')
  if (!btn) return
  btn.hidden = !(dashFilterApplied && hasActiveDashFilter())
}
