import Chart from 'chart.js/auto'
import { getData, getStatuses, getPlatforms, getCustomerCodes, getSalesTargets, getDeadlineUrgency, colorForDeadlineRemaining, coerceProductName } from './data.js'
import { getUsersSafe } from './auth.js'
import { loadGroupsData, organizeUsersByGroup, getGroupById, getMembersOfGroup } from './groups.js'
import {
  hasPermission, getCurrentUser, formatNumber, jalaliToNum, getTodayJalaliNum,
  jalaliAddDays, getTodayJalaliStr, escapeHtml, escapeAttr, showToast,
  normalizePhone, userDisplayName, canViewOrgWideData, jalaliDiffDays, jalaliDatePart,
  getVisibleAdvisorPhones, getStatusLabels, getPlatformLabels, formatPhonesDisplay,
  ensureProductPayments, syncProductStatus, getProductPayments, getPaymentEntryStatus,
  getApprovedPaid, getProductBalance, isProductCountableInSales, PAYMENT_STATUS,
  getSaleRegistrantPhone, gregorianToJalaliStr, normalizeViewUserPhones, isMainAdmin,
  jalaliEndOfDayMs, getCompletedSaleEconomics, resolveProductCostConfig, isDealCancelled,
  getCurrentJalaliMonthInfo, isInJalaliMonth
} from './utils.js'
import { sumCompletedRefundsForDash, countPendingRefundsForDash } from './refunds.js'

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
      if (typeof onPayment === 'function') {
        pays.forEach(pay => {
          onPayment({
            customer: c,
            product: p,
            payment: pay,
            amount: parseFloat(pay.amount) || 0,
            date: jalaliDatePart(pay.soldAt)
          })
        })
      }
    })
  })
}

function computeDashSalesMetrics(hasDateFilter, inDateRange) {
  let salesCount = 0
  let totalDeposit = 0
  let totalBalance = 0
  let totalApproved = 0
  let totalPending = 0
  let completedGrossProfit = 0

  // جمع فروش‌های تأییدشده = مجموع همهٔ واریزهای تأییدشدهٔ حسابداری (بیعانه + تکمیل)
  forEachDashSalePayment(
    matchesSelectedSaleRegistrant,
    hasDateFilter,
    inDateRange,
    ({ amount }) => { totalApproved += amount },
    ({ product, paidInScope, balance }) => {
      salesCount++
      // کارت بیعانه / مانده فقط برای فاکتورهای باز (نه تکمیل، نه عودت‌شده)
      if (product.status === 'تکمیل' || isDealCancelled(product)) return
      totalDeposit += paidInScope
      totalBalance += balance
    }
  )

  // سود ناخالص فقط برای فاکتورهای تکمیل‌شده؛ فیلتر تاریخ روی تاریخ تکمیل است
  const data = getData()
  data.customers.forEach(customer => {
    if (customer.id.startsWith('LD') && !hasPermission('customers_ld')) return
    if (customer.id.startsWith('CS') && !hasPermission('customers_cs')) return
    ;(customer.products || []).forEach(product => {
      ensureProductPayments(product)
      syncProductStatus(product)
      if (product.status !== 'تکمیل') return

      const price = parseFloat(product.price) || 0
      let approvedTotal = 0
      const approvedPayments = getProductPayments(product)
        .filter(pay => getPaymentEntryStatus(pay) === PAYMENT_STATUS.approved && (parseFloat(pay.amount) || 0) > 0)
        .slice()
        .sort((a, b) => String(a.soldAt || '').localeCompare(String(b.soldAt || '')))
      const completionPayment = approvedPayments.find(pay => {
        approvedTotal += parseFloat(pay.amount) || 0
        return approvedTotal >= price
      })
      if (!completionPayment) return
      if (!matchesSelectedSaleRegistrant({ customer, product, payment: completionPayment })) return
      if (hasDateFilter && !inDateRange(jalaliDatePart(completionPayment.soldAt))) return

      const eco = getCompletedSaleEconomics(product)
      completedGrossProfit += eco.grossProfit
    })
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
    totalDeposit,
    totalBalance,
    totalApproved,
    totalPending,
    completedGrossProfit
  }
}

/**
 * تعداد / جمع تأییدشده / سود: بدون فیلتر کاربر → ماه جاری؛ با فیلتر → همان بازه.
 * بیعانه / مانده / در انتظار: بدون فیلتر → همه؛ با فیلتر → همان بازه.
 */
function resolveDashSalesMetrics(hasUserDateFilter, inDateRange) {
  const openMetrics = computeDashSalesMetrics(hasUserDateFilter, inDateRange)
  if (hasUserDateFilter) return { ...openMetrics, periodMetrics: openMetrics }

  const month = getCurrentJalaliMonthInfo()
  const inMonth = (dateStr) => isInJalaliMonth(dateStr, month.prefix)
  const periodMetrics = computeDashSalesMetrics(true, inMonth)
  return {
    ...openMetrics,
    salesCount: periodMetrics.salesCount,
    totalApproved: periodMetrics.totalApproved,
    completedGrossProfit: periodMetrics.completedGrossProfit,
    periodMetrics
  }
}

function movingAverageSeries(values, windowSize = 3) {
  const w = Math.max(1, Math.floor(windowSize) || 1)
  return values.map((_, i) => {
    if (i < w - 1) return null
    let sum = 0
    for (let j = i - w + 1; j <= i; j++) sum += Number(values[j]) || 0
    return Math.round(sum / w)
  })
}

function renderSalesTimelineChart(dateFromNum, dateToNum, currentUser) {
  const canvas = document.getElementById('chartSalesTimeline')
  if (!canvas) return
  destroyDashChart('salesTimeline')
  destroyDashChart(canvas)
  if (!syncSalesChartTimeframeOptions()) return

  const from = document.getElementById('salesChartFrom').value.trim()
  const to = document.getElementById('salesChartTo').value.trim()
  const timeframe = document.getElementById('salesChartTimeframe').value || 'day'
  const metric = document.getElementById('salesChartMetric')?.value === 'count' ? 'count' : 'amount'
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
      if (idx === -1) return
      totals[idx] += metric === 'count' ? 1 : amount
    }
  )

  const barLabel = metric === 'count' ? 'تعداد فروش' : 'مبلغ فروش'
  const valueSuffix = metric === 'count' ? '' : ' ریال'

  // MA3: for day view = 3-day MA of daily bars; for week/month = MA of last 3 buckets
  const showMa3 = !!document.getElementById('salesChartShowMa3')?.checked
  const datasets = [
    {
      type: 'bar',
      label: barLabel,
      data: totals,
      backgroundColor: '#0d6efd',
      borderRadius: 6,
      maxBarThickness: 48,
      order: 2
    }
  ]
  if (showMa3) {
    const maLabel = timeframe === 'day'
      ? 'میانگین متحرک ۳روزه'
      : 'میانگین متحرک ۳دوره'
    datasets.push({
      type: 'line',
      label: maLabel,
      data: movingAverageSeries(totals, 3),
      borderColor: '#dc3545',
      backgroundColor: 'transparent',
      borderWidth: 2.5,
      pointRadius: 3,
      pointHoverRadius: 5,
      pointBackgroundColor: '#dc3545',
      tension: 0.25,
      spanGaps: true,
      order: 1
    })
  }

  dashCharts.salesTimeline = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: buckets.map(b => b.label),
      datasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: showMa3,
          position: 'bottom',
          labels: { font: { family: 'Vazirmatn', size: 11 }, boxWidth: 12 }
        },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              if (ctx.raw == null) return `${ctx.dataset.label}: —`
              return `${ctx.dataset.label}: ${formatNumber(ctx.raw)}${valueSuffix}`
            }
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
          beginAtZero: true,
          ticks: {
            font: { family: 'Vazirmatn', size: 11 },
            callback: v => (metric === 'count' && !Number.isInteger(v)) ? undefined : formatNumber(v)
          }
        }
      }
    }
  })
  scheduleDashChartsResize()
}

// ============================================
// AOV moving-average chart
// ============================================

function getAovDisplayWindowDays() {
  const raw = parseInt(document.getElementById('aovDisplayWindow')?.value || '15', 10)
  return [7, 15, 30, 60].includes(raw) ? raw : 15
}

function getAovMaWindowDays() {
  const raw = parseInt(document.getElementById('aovMaWindow')?.value || '7', 10)
  return [7, 15, 30].includes(raw) ? raw : 7
}

/** Completed sales with completion date + registrant phone (dashboard AOV rules). */
function collectCompletedSalePointsForAov() {
  const points = []
  const data = getData()
  data.customers.forEach(customer => {
    if (customer.id.startsWith('LD') && !hasPermission('customers_ld')) return
    if (customer.id.startsWith('CS') && !hasPermission('customers_cs')) return
    ;(customer.products || []).forEach(product => {
      ensureProductPayments(product)
      syncProductStatus(product)
      if (product.status !== 'تکمیل') return

      const price = parseFloat(product.price) || 0
      let approvedTotal = 0
      const approvedPayments = getProductPayments(product)
        .filter(pay => getPaymentEntryStatus(pay) === PAYMENT_STATUS.approved && (parseFloat(pay.amount) || 0) > 0)
        .slice()
        .sort((a, b) => String(a.soldAt || '').localeCompare(String(b.soldAt || '')))
      const completionPayment = approvedPayments.find(pay => {
        approvedTotal += parseFloat(pay.amount) || 0
        return approvedTotal >= price
      })
      if (!completionPayment) return
      if (!matchesSelectedSaleRegistrant({ customer, product, payment: completionPayment })) return

      const phone = getSaleRegistrantPhone(product, completionPayment, customer)
      if (!phone) return
      const dateStr = jalaliDatePart(completionPayment.soldAt)
      const dateNum = jalaliToNum(dateStr)
      if (!dateStr || dateNum === 99999999) return

      const eco = getCompletedSaleEconomics(product)
      points.push({ dateNum, price: eco.salesTotal, phone })
    })
  })
  return points
}

/** Stable color per advisor phone so filter toggles don't reshuffle colors. */
function colorForAdvisorPhone(phone) {
  const p = normalizePhone(phone) || ''
  let hash = 0
  for (let i = 0; i < p.length; i++) hash = ((hash << 5) - hash + p.charCodeAt(i)) | 0
  const idx = Math.abs(hash) % ADVISOR_CHART_COLORS.length
  return ADVISOR_CHART_COLORS[idx]
}

const AOV_OVERALL_LABEL = 'میانگین کل'
const AOV_OVERALL_COLOR = '#212529'
const AOV_DIM_OPACITY = 0.1

function colorWithAlpha(color, alpha) {
  if (!color || typeof color !== 'string') return color
  const rgbaMatch = color.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*[\d.]+\s*)?\)$/i)
  if (rgbaMatch) {
    return `rgba(${rgbaMatch[1]}, ${rgbaMatch[2]}, ${rgbaMatch[3]}, ${alpha})`
  }
  let hex = color.replace('#', '')
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('')
  if (hex.length !== 6) return color
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** Apply color to line + points. Chart.js caches shared point options; update('none') won't refresh them. */
function setAovDatasetDrawColor(chart, datasetIndex, color) {
  const ds = chart.data.datasets[datasetIndex]
  if (!ds) return
  ds.borderColor = color
  ds.pointBackgroundColor = color
  ds.pointBorderColor = color
  ds.pointHoverBackgroundColor = color
  ds.pointHoverBorderColor = color

  const meta = chart.getDatasetMeta(datasetIndex)
  if (meta?.controller) meta.controller._sharedOptions = undefined
  if (meta?.dataset?.options) {
    meta.dataset.options.borderColor = color
  }
  for (const pt of meta?.data || []) {
    if (!pt?.options) continue
    pt.options.backgroundColor = color
    pt.options.borderColor = color
  }
}

function applyAovLegendHoverFocus(chart, hoveredDatasetIndex) {
  if (!chart?.data?.datasets) return
  chart.data.datasets.forEach((ds, i) => {
    const base = ds._baseBorderColor || ds.borderColor || '#888'
    const keepFull = i === hoveredDatasetIndex || ds.label === AOV_OVERALL_LABEL
    setAovDatasetDrawColor(chart, i, keepFull ? base : colorWithAlpha(base, AOV_DIM_OPACITY))
  })
  chart.draw()
}

function clearAovLegendHoverFocus(chart) {
  if (!chart?.data?.datasets) return
  chart.data.datasets.forEach((ds, i) => {
    const base = ds._baseBorderColor || ds.borderColor || '#888'
    setAovDatasetDrawColor(chart, i, base)
  })
  chart.draw()
}

/**
 * Rolling AOV (SMA-style): for each display day D, AOV of completed sales in
 * [D - (maDays-1) .. D] inclusive — same formula as the dashboard card, over a window.
 */
function buildAovMaValues(points, dayNums, maDays) {
  const sorted = points.slice().sort((a, b) => a.dateNum - b.dateNum)
  let lo = 0
  let hi = 0
  let sum = 0
  let count = 0

  return dayNums.map(dayNum => {
    const fromStr = jalaliAddDaysStr(jalaliNumToStr(dayNum), -(maDays - 1))
    const fromNum = jalaliToNum(fromStr)
    if (!fromStr || fromNum === 99999999) return null

    while (hi < sorted.length && sorted[hi].dateNum <= dayNum) {
      sum += sorted[hi].price
      count++
      hi++
    }
    while (lo < hi && sorted[lo].dateNum < fromNum) {
      sum -= sorted[lo].price
      count--
      lo++
    }
    if (count <= 0) return null
    return Math.round(sum / count)
  })
}

function resolveAovDisplayDayRange(dateFromNum, dateToNum) {
  const displayDays = getAovDisplayWindowDays()
  const today = getTodayJalaliStr()
  let endStr = today
  if (dateToNum && dateToNum < 99999999) {
    const capped = jalaliNumToStr(dateToNum)
    if (capped && jalaliToNum(capped) < jalaliToNum(today)) endStr = capped
  }
  let startStr = jalaliAddDaysStr(endStr, -(displayDays - 1))
  if (dateFromNum > 0) {
    const filterStart = jalaliNumToStr(dateFromNum)
    if (filterStart && jalaliToNum(filterStart) > jalaliToNum(startStr)) {
      startStr = filterStart
    }
  }
  if (jalaliToNum(startStr) > jalaliToNum(endStr)) {
    startStr = endStr
  }
  return { startStr, endStr, buckets: buildSalesBuckets(startStr, endStr, 'day') }
}

function renderAovMaChart(dateFromNum, dateToNum) {
  const canvas = document.getElementById('chartAovMa')
  if (!canvas) return
  destroyDashChart('aovMa')
  destroyDashChart(canvas)

  const maDays = getAovMaWindowDays()
  const { buckets } = resolveAovDisplayDayRange(dateFromNum, dateToNum)
  const labels = buckets.map(b => b.label)
  const dayNums = buckets.map(b => b.fromNum)
  const allPoints = collectCompletedSalePointsForAov()

  const byPhone = new Map()
  for (const p of allPoints) {
    if (!byPhone.has(p.phone)) byPhone.set(p.phone, [])
    byPhone.get(p.phone).push(p)
  }

  const selectedPhones = [...(selectedAdvisorPhones || [])]
    .filter(Boolean)
    .map(p => normalizePhone(p))
    .filter(Boolean)
    .sort((a, b) => advisorLabelForPhone(a).localeCompare(advisorLabelForPhone(b), 'fa'))

  const datasets = []

  selectedPhones.forEach(phone => {
    const advisorPoints = byPhone.get(phone) || []
    const values = buildAovMaValues(advisorPoints, dayNums, maDays)
    if (!values.some(v => v != null)) return
    const color = colorForAdvisorPhone(phone)
    datasets.push({
      label: advisorLabelForPhone(phone),
      data: values,
      borderColor: color,
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      pointRadius: 2,
      pointHoverRadius: 4,
      pointBackgroundColor: color,
      pointBorderColor: color,
      pointHoverBackgroundColor: color,
      pointHoverBorderColor: color,
      tension: 0.25,
      spanGaps: true,
      fill: false,
      order: 1,
      _baseBorderColor: color
    })
  })

  // Overall MA for currently filtered advisors — drawn on top, thicker
  const totalValues = buildAovMaValues(allPoints, dayNums, maDays)
  datasets.push({
    label: AOV_OVERALL_LABEL,
    data: totalValues,
    borderColor: AOV_OVERALL_COLOR,
    backgroundColor: 'transparent',
    borderWidth: 3.5,
    pointRadius: 3,
    pointHoverRadius: 5,
    pointBackgroundColor: AOV_OVERALL_COLOR,
    pointBorderColor: AOV_OVERALL_COLOR,
    pointHoverBackgroundColor: AOV_OVERALL_COLOR,
    pointHoverBorderColor: AOV_OVERALL_COLOR,
    tension: 0.25,
    spanGaps: true,
    fill: false,
    order: 10,
    _baseBorderColor: AOV_OVERALL_COLOR
  })

  dashCharts.aovMa = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'bottom',
          labels: { font: { family: 'Vazirmatn', size: 11 }, boxWidth: 12 },
          onHover(evt, legendItem, legend) {
            const native = evt?.native
            if (native?.target) native.target.style.cursor = 'pointer'
            if (legendItem?.datasetIndex == null) return
            applyAovLegendHoverFocus(legend.chart, legendItem.datasetIndex)
          },
          onLeave(evt, _legendItem, legend) {
            const native = evt?.native
            if (native?.target) native.target.style.cursor = 'default'
            clearAovLegendHoverFocus(legend.chart)
          }
        },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              if (ctx.raw == null) return `${ctx.dataset.label}: —`
              return `${ctx.dataset.label}: ${formatNumber(ctx.raw)} ریال`
            }
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

export function onAovMaControlsChange() {
  const dateFrom = document.getElementById('dashDateFrom')?.value.trim() || ''
  const dateTo = document.getElementById('dashDateTo')?.value.trim() || ''
  const dateFromNum = dateFrom ? jalaliToNum(dateFrom) : 0
  const dateToNum = dateTo ? jalaliToNum(dateTo) : 99999999
  try {
    renderAovMaChart(dateFromNum, dateToNum)
  } catch (e) {
    console.error('onAovMaControlsChange error:', e)
  }
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

  const hasDateFilter = !!(dateFrom || dateTo)

  const scopedCustomers = data.customers.filter(c => {
    if (c.id.startsWith('LD') && !hasPermission('customers_ld')) return false
    if (c.id.startsWith('CS') && !hasPermission('customers_cs')) return false
    return inUserScope(c)
  })

  function customerCreatedInRange(c) {
    if (!hasDateFilter) return true
    return inDateRange(gregorianToJalaliStr(c.createdAt))
  }

  const datedCustomers = scopedCustomers.filter(customerCreatedInRange)

  document.getElementById('dash-total-customers').textContent = datedCustomers.length
  document.getElementById('dash-total-leads').textContent = datedCustomers.filter(c => c.id.startsWith('LD')).length
  document.getElementById('dash-total-cs').textContent = datedCustomers.filter(c => c.id.startsWith('CS')).length
  const visibleFollowups = data.followups.filter(f => {
    const customer = data.customers.find(c => c.id === f.customerId)
    if (!customer || !inUserScope(customer)) return false
    if (customer.id.startsWith('LD') && !hasPermission('customers_ld')) return false
    if (customer.id.startsWith('CS') && !hasPermission('customers_cs')) return false
    return true
  })
  const completedFollowups = visibleFollowups.filter(f => {
    const isDone = f.status === 'done' ||
      f.type === 'پیگیری انجام‌شده' ||
      f.type === 'پیگیری معوقه انجام‌شده'
    return isDone && inDateRange(jalaliDatePart(f.doneAt || f.date))
  }).length
  const upcomingFollowups = scopedCustomers.filter(c => {
    if (!c.nextFollowupDate) return false
    const nextDate = jalaliDatePart(c.nextFollowupDate)
    return jalaliToNum(nextDate) >= todayNum && inDateRange(nextDate)
  }).length
  document.getElementById('dash-followups-completed').textContent = completedFollowups
  document.getElementById('dash-followups-upcoming').textContent = upcomingFollowups

  let overdueList = []
  let soonList = []
  let setCount = 0
  let noSetCount = 0

  scopedCustomers.forEach(c => {
    if (c.nextFollowupDate) {
      const nextDate = jalaliDatePart(c.nextFollowupDate)
      if (hasDateFilter && !inDateRange(nextDate)) return
      const dNum = jalaliToNum(nextDate)
      // Overdue/soon lists: managers only see subordinates
      if (matchesFollowupMonitorScope(c)) {
        if (dNum < todayNum) overdueList.push(c)
        else if (dNum <= in3DaysNum) soonList.push(c)
      }
      setCount++
    } else if (customerCreatedInRange(c)) {
      noSetCount++
    }
  })

  document.getElementById('dash-overdue-followup').textContent = overdueList.length
  document.getElementById('dash-soon-followup').textContent = soonList.length
  document.getElementById('dash-set-followup').textContent = setCount
  document.getElementById('dash-no-followup').textContent = noSetCount
  document.getElementById('dash-overdue-badge').textContent = overdueList.length
  document.getElementById('dash-soon-badge').textContent = soonList.length

  const activeCustomers = datedCustomers.filter(c => c.products && c.products.length > 0)
  document.getElementById('dash-active-customers').textContent = activeCustomers.length

  const salesMetrics = resolveDashSalesMetrics(hasDateFilter, inDateRange)

  document.getElementById('dash-sales-count').textContent = salesMetrics.salesCount
  document.getElementById('dash-sales-deposit').textContent = formatNumber(salesMetrics.totalDeposit) + ' ریال'
  document.getElementById('dash-sales-balance').textContent = formatNumber(salesMetrics.totalBalance) + ' ریال'
  document.getElementById('dash-sales-total').textContent = formatNumber(salesMetrics.totalApproved) + ' ریال'
  const grossEl = document.getElementById('dash-sales-gross')
  if (grossEl) grossEl.textContent = formatNumber(salesMetrics.completedGrossProfit) + ' ریال'
  const pendingEl = document.getElementById('dash-sales-pending')
  if (pendingEl) pendingEl.textContent = formatNumber(salesMetrics.totalPending) + ' ریال'

  const avgSale = salesMetrics.salesCount > 0
    ? Math.round(salesMetrics.totalApproved / salesMetrics.salesCount)
    : 0
  document.getElementById('dash-avg-sale').textContent = formatNumber(avgSale) + ' ریال'

  try {
    const refundsTotal = sumCompletedRefundsForDash({
      dateFromNum,
      dateToNum,
      advisorPhones: selectedAdvisorPhones
    })
    const refundsEl = document.getElementById('dash-refunds-total')
    if (refundsEl) refundsEl.textContent = formatNumber(refundsTotal) + ' ریال'

    const pendingRefunds = countPendingRefundsForDash({
      dateFromNum,
      dateToNum,
      advisorPhones: selectedAdvisorPhones
    })
    const requestedEl = document.getElementById('dash-refunds-requested')
    const awaitingEl = document.getElementById('dash-refunds-awaiting')
    if (requestedEl) requestedEl.textContent = pendingRefunds.requested
    if (awaitingEl) awaitingEl.textContent = pendingRefunds.awaiting
  } catch (e) {
    console.error('dash refunds total error:', e)
  }

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
    if (keyOrCanvas && typeof Chart.getChart === 'function') {
      const bound = Chart.getChart(keyOrCanvas)
      if (bound) bound.destroy()
    }
  } catch (_) { /* ignore */ }
}

function destroyAllDashCharts() {
  Object.keys(dashCharts).forEach(key => destroyDashChart(key))
  dashCharts = {}
  ;['chartCustomers', 'chartSalesStatus', 'chartFollowupConversion', 'chartPlatforms', 'chartProducts', 'chartAdvisorCompare', 'chartSalesTimeline', 'chartAovMa']
    .forEach(id => {
      const canvas = document.getElementById(id)
      if (canvas) destroyDashChart(canvas)
    })
}

const CHART_FONT = { family: 'Vazirmatn', size: 11 }
const CHART_RESPONSIVE = { responsive: true, maintainAspectRatio: false }

function populateDashConversionCodeFilter() {
  const sel = document.getElementById('dashConversionCustomerCode')
  if (!sel) return
  const val = sel.value
  sel.innerHTML = '<option value="">همه کدها</option>' +
    getCustomerCodes().map(c => `<option value="${escapeAttr(c.key)}">${escapeHtml(c.label)}</option>`).join('')
  sel.value = val
}

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
    const statusOrder = {}
    getStatuses().forEach((s, i) => {
      statusColors[s.key] = s.textColor || s.bgColor
      statusOrder[s.key] = s.order != null ? s.order : i
    })

    const platformLabels = getPlatformLabels()
    const platformColors = {}
    getPlatforms().forEach(p => {
      platformColors[p.key] = p.color
    })

    const hasDateFilter = dateFromNum > 0 || dateToNum < 99999999
    const custStatusCounts = {}
    const platformCounts = {}
    data.customers.forEach(c => {
      if (c.id.startsWith('LD') && !hasPermission('customers_ld')) return
      if (c.id.startsWith('CS') && !hasPermission('customers_cs')) return
      if (!inUserScope(c)) return
      if (hasDateFilter && !inChartDateRange(gregorianToJalaliStr(c.createdAt))) return
      const statusKey = c.status || ''
      custStatusCounts[statusKey] = (custStatusCounts[statusKey] || 0) + 1
      const platformKey = c.platform || ''
      platformCounts[platformKey] = (platformCounts[platformKey] || 0) + 1
    })

    const totalCustomers = Object.values(custStatusCounts).reduce((s, n) => s + n, 0)
    const topStatuses = Object.entries(custStatusCounts)
      .map(([key, count]) => ({
        key,
        label: statusLabels[key] || key || '—',
        count,
        pct: totalCustomers > 0 ? Math.round((count / totalCustomers) * 100) : 0,
        color: statusColors[key] || '#dee2e6',
        order: statusOrder[key] != null ? statusOrder[key] : 999
      }))
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count
        if (b.pct !== a.pct) return b.pct - a.pct
        return a.order - b.order
      })
      .slice(0, 7)

    const custCanvas = document.getElementById('chartCustomers')
    if (custCanvas) {
      dashCharts.custStatus = new Chart(custCanvas, {
        type: 'doughnut',
        data: {
          labels: topStatuses.map(s => `${s.label} ${formatNumber(s.pct)}٪`),
          datasets: [{
            data: topStatuses.map(s => s.count),
            backgroundColor: topStatuses.map(s => s.color),
            borderWidth: 2,
            borderColor: '#fff'
          }]
        },
        options: {
          ...CHART_RESPONSIVE,
          plugins: {
            legend: {
              position: 'bottom',
              labels: {
                font: CHART_FONT,
                boxWidth: 12,
                padding: 10
              }
            },
            tooltip: {
              callbacks: {
                label(ctx) {
                  const item = topStatuses[ctx.dataIndex]
                  if (!item) return ''
                  return ` ${item.label}: ${formatNumber(item.count)} (${formatNumber(item.pct)}٪)`
                }
              }
            }
          }
        }
      })
    }

    const totalPlatformCustomers = Object.values(platformCounts).reduce((s, n) => s + n, 0)
    const platformEntries = Object.entries(platformCounts)
      .map(([key, count]) => {
        const exactPct = totalPlatformCustomers > 0 ? (count / totalPlatformCustomers) * 100 : 0
        return {
          key,
          label: platformLabels[key] || key || '—',
          count,
          exactPct,
          pct: Math.round(exactPct),
          color: platformColors[key] || '#dee2e6'
        }
      })
      .filter(p => p.exactPct >= 4)
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count
        return a.label.localeCompare(b.label, 'fa')
      })

    const platformCanvas = document.getElementById('chartPlatforms')
    if (platformCanvas) {
      dashCharts.platforms = new Chart(platformCanvas, {
        type: 'doughnut',
        data: {
          labels: platformEntries.map(p => `${p.label} ${formatNumber(p.pct)}٪`),
          datasets: [{
            data: platformEntries.map(p => p.count),
            backgroundColor: platformEntries.map(p => p.color),
            borderWidth: 2,
            borderColor: '#fff'
          }]
        },
        options: {
          ...CHART_RESPONSIVE,
          plugins: {
            legend: {
              position: 'bottom',
              labels: {
                font: CHART_FONT,
                boxWidth: 12,
                padding: 10
              }
            },
            tooltip: {
              callbacks: {
                label(ctx) {
                  const item = platformEntries[ctx.dataIndex]
                  if (!item) return ''
                  return ` ${item.label}: ${formatNumber(item.count)} (${formatNumber(item.pct)}٪)`
                }
              }
            }
          }
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
    if (salesCanvas) {
      const salesStatusEntries = [
        { label: 'تکمیل', value: salesStatus['تکمیل'] || 0, color: '#198754' },
        { label: 'بیعانه', value: salesStatus['بیعانه'] || 0, color: '#ffc107' }
      ]
      const salesStatusTotal = salesStatusEntries.reduce((s, e) => s + e.value, 0)
      const salesStatusWithPct = salesStatusEntries.map(e => ({
        ...e,
        pct: salesStatusTotal > 0 ? Math.round((e.value / salesStatusTotal) * 100) : 0
      }))
      dashCharts.salesStatus = new Chart(salesCanvas, {
        type: 'pie',
        data: {
          labels: salesStatusWithPct.map(e => `${e.label} ${formatNumber(e.pct)}٪`),
          datasets: [{
            data: salesStatusWithPct.map(e => e.value),
            backgroundColor: salesStatusWithPct.map(e => e.color),
            borderWidth: 2,
            borderColor: '#fff'
          }]
        },
        options: {
          ...CHART_RESPONSIVE,
          plugins: {
            legend: {
              position: 'bottom',
              labels: { font: CHART_FONT, boxWidth: 12, padding: 10 }
            },
            tooltip: {
              callbacks: {
                label(ctx) {
                  const item = salesStatusWithPct[ctx.dataIndex]
                  if (!item) return ''
                  return ` ${item.label}: ${formatNumber(item.value)} ریال (${formatNumber(item.pct)}٪)`
                }
              }
            }
          }
        }
      })
    }
  } catch (e) {
    console.error('salesStatus chart error:', e)
  }

  try {
    populateDashConversionCodeFilter()
    const codeFilter = document.getElementById('dashConversionCustomerCode')?.value || ''
    const data = getData()
    const customersWithActivity = new Set()
    data.followups.forEach(f => {
      const dateStr = jalaliDatePart(f.doneAt || f.date)
      if (!inChartDateRange(dateStr)) return
      if (!f.customerId) return
      customersWithActivity.add(f.customerId)
    })

    const customersWithSale = new Set()
    forEachDashSalePayment(
      matchesSelectedSaleRegistrant,
      hasDateFilter,
      inChartDateRange,
      () => {},
      ({ customer }) => {
        if (customer?.id) customersWithSale.add(customer.id)
      }
    )

    let withSale = 0
    let withoutSale = 0
    customersWithActivity.forEach(customerId => {
      const c = data.customers.find(x => x.id === customerId)
      if (!c) return
      if (c.id.startsWith('LD') && !hasPermission('customers_ld')) return
      if (c.id.startsWith('CS') && !hasPermission('customers_cs')) return
      if (!inUserScope(c)) return
      if (codeFilter && (c.customerCode || '') !== codeFilter) return
      if (customersWithSale.has(customerId)) withSale += 1
      else withoutSale += 1
    })

    const convCanvas = document.getElementById('chartFollowupConversion')
    if (convCanvas) {
      const total = withSale + withoutSale
      const convEntries = [
        {
          label: 'دارای فروش',
          value: withSale,
          color: '#198754',
          pct: total > 0 ? Math.round((withSale / total) * 100) : 0
        },
        {
          label: 'بدون فروش',
          value: withoutSale,
          color: '#adb5bd',
          pct: total > 0 ? Math.round((withoutSale / total) * 100) : 0
        }
      ]
      dashCharts.followupConversion = new Chart(convCanvas, {
        type: 'pie',
        data: {
          labels: convEntries.map(e => `${e.label} ${formatNumber(e.pct)}٪`),
          datasets: [{
            data: convEntries.map(e => e.value),
            backgroundColor: convEntries.map(e => e.color),
            borderWidth: 2,
            borderColor: '#fff'
          }]
        },
        options: {
          ...CHART_RESPONSIVE,
          plugins: {
            legend: {
              position: 'bottom',
              labels: { font: CHART_FONT, boxWidth: 12, padding: 10 }
            },
            tooltip: {
              callbacks: {
                label(ctx) {
                  const item = convEntries[ctx.dataIndex]
                  if (!item) return ''
                  return ` ${item.label}: ${formatNumber(item.value)} نفر (${formatNumber(item.pct)}٪)`
                }
              }
            }
          }
        }
      })
    }
  } catch (e) {
    console.error('followupConversion chart error:', e)
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
    renderAovMaChart(dateFromNum, dateToNum)
  } catch (e) {
    console.error('aovMa chart error:', e)
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

function salesTargetCountdownRoots() {
  return [
    document.getElementById('salesTargetHud'),
    document.getElementById('salesTargetBand')
  ].filter(el => el && !el.hidden)
}

function tickSalesTargetCountdowns() {
  const roots = salesTargetCountdownRoots()
  if (!roots.length) {
    stopSalesTargetCountdown()
    return
  }
  let urgency
  try {
    urgency = getDeadlineUrgency()
  } catch (_) {
    urgency = null
  }
  const nodes = roots.flatMap(root => [...root.querySelectorAll('.sales-target-countdown[data-deadline-ms]')])
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
  const roots = salesTargetCountdownRoots()
  if (!roots.length) return
  if (!roots.some(root => root.querySelector('.sales-target-countdown[data-deadline-ms]'))) return
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

function summarizeSalesTargetProgresses(progresses) {
  if (!progresses.length) return null
  const incomplete = progresses.filter(p => !p.complete)
  const focus = incomplete.length
    ? incomplete.reduce((a, b) => (a.pct <= b.pct ? a : b))
    : progresses[0]
  const avgPct = progresses.reduce((s, p) => s + p.pct, 0) / progresses.length
  const allDone = progresses.every(p => p.complete)
  const stage = salesTargetStage(focus.pct, allDone)
  const ringPct = Math.round(allDone ? 100 : avgPct)
  const deadlineMs = allDone ? null : pickSalesTargetDeadlineMs(progresses)
  return { focus, allDone, stage, ringPct, deadlineMs, progresses }
}

function blockProgresses(block) {
  return (block.bars || []).map(({ bar, goalOverride, phoneSet }) => ({
    bar,
    ...computeSalesTargetBarProgress(bar, goalOverride, phoneSet)
  }))
}

function renderSalesTargetRingHtml(ringPct) {
  return `
    <div class="sales-target-ring" style="--pct:${ringPct}" aria-hidden="true">
      <div class="sales-target-ring-inner">
        <span class="sales-target-ring-value">${formatNumber(ringPct)}٪</span>
        <span class="sales-target-ring-label">پیشرفت</span>
      </div>
    </div>
  `
}

function renderSalesTargetHudHtml({ stage, ringPct, deadlineMs }) {
  const timerHtml = deadlineMs ? renderSalesTargetCountdownHtml(deadlineMs) : ''
  return `
    <div class="sales-target-hud-card ${stage}" role="status" aria-label="پیشرفت تارگت فروش">
      ${renderSalesTargetRingHtml(ringPct)}
      ${timerHtml}
    </div>
  `
}

function hideSalesTargetHud() {
  const hud = document.getElementById('salesTargetHud')
  if (!hud) return
  hud.hidden = true
  hud.innerHTML = ''
}

function renderSalesTargetHudFromBlocks(blocks) {
  const hud = document.getElementById('salesTargetHud')
  if (!hud) return false

  const allProgresses = blocks.flatMap(block => blockProgresses(block)).filter(p => p)
  const summary = summarizeSalesTargetProgresses(allProgresses)
  if (!summary) {
    hideSalesTargetHud()
    return false
  }

  hud.innerHTML = renderSalesTargetHudHtml(summary)
  hud.hidden = false
  return !!summary.deadlineMs
}

function renderSalesTargetCampaignHtml(block) {
  const progresses = blockProgresses(block)
  if (!progresses.length) return ''

  const summary = summarizeSalesTargetProgresses(progresses)
  if (!summary) return ''

  const copy = salesTargetMotivationalCopy(
    summary.focus.pct,
    summary.focus.remainingLabel,
    summary.allDone,
    summary.focus.deadline
  )

  const deadlineChip = summary.allDone
    ? `<span class="sales-target-deadline-chip is-done">تکمیل شد</span>`
    : (summary.deadlineMs ? renderSalesTargetCountdownHtml(summary.deadlineMs) : '')

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
    <article class="sales-target-band ${summary.stage}">
      <div class="sales-target-band-inner">
        ${renderSalesTargetRingHtml(summary.ringPct)}
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

/** Motivational group-target band + fixed HUD for members & group managers. */
export function renderSalesTargetBand() {
  const wrap = document.getElementById('salesTargetBand')
  stopSalesTargetCountdown()

  const viewer = getCurrentUser()
  const groupId = viewer?.groupId || null

  const clearAll = () => {
    if (wrap) {
      wrap.hidden = true
      wrap.innerHTML = ''
    }
    hideSalesTargetHud()
  }

  if (!groupId || isMainAdmin(viewer)) {
    clearAll()
    return
  }

  let targets = []
  try {
    targets = getSalesTargets()
  } catch (e) {
    console.error('renderSalesTargetBand getSalesTargets:', e)
    clearAll()
    return
  }

  let blocks = []
  try {
    blocks = buildMemberTargetBlocks(targets, groupId)
  } catch (e) {
    console.error('renderSalesTargetBand build blocks:', e)
    clearAll()
    return
  }

  if (!blocks.length) {
    clearAll()
    return
  }

  try {
    renderSalesTargetHudFromBlocks(blocks)
  } catch (e) {
    console.error('renderSalesTargetHud error:', e)
    hideSalesTargetHud()
  }

  if (!wrap) {
    startSalesTargetCountdown()
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
    }
    startSalesTargetCountdown()
  } catch (e) {
    console.error('renderSalesTargetBand render:', e)
    wrap.hidden = true
    wrap.innerHTML = ''
    startSalesTargetCountdown()
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
  if (!canvas) return

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

function buildAdvisorCompareRows(dateFromNum, dateToNum, metric = 'net') {
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
      let value = amount
      if (metric === 'net') {
        const price = Math.max(0, parseFloat(product.price) || 0)
        const cost = Math.max(0, parseFloat(resolveProductCostConfig(product).costAmount) || 0)
        // Recognize physical-product cost in proportion to each approved payment.
        // This keeps partial deposits, date filters, and multi-advisor installments accurate.
        const allocatedCost = price > 0 ? amount * (cost / price) : 0
        value -= allocatedCost
      }
      const prev = totals.get(phone) || {
        phone,
        label: advisorLabelForPhone(phone, customer.advisor),
        value: 0
      }
      prev.value += value
      if (!prev.label) prev.label = advisorLabelForPhone(phone, customer.advisor)
      totals.set(phone, prev)
    }
  )

  return [...totals.values()].sort((a, b) => b.value - a.value)
}

function renderAdvisorCompareChart(dateFromNum, dateToNum) {
  const canvas = document.getElementById('chartAdvisorCompare')
  if (!canvas) return

  destroyDashChart('advisorCompare')
  destroyDashChart(canvas)

  const metric = document.getElementById('advisorCompareMetric')?.value === 'gross' ? 'gross' : 'net'
  const rows = buildAdvisorCompareRows(dateFromNum, dateToNum, metric)
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

  dashCharts.advisorCompare = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: metric === 'net' ? 'فروش خالص' : 'فروش ناخالص',
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

export function onAdvisorCompareMetricChange() {
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

// ============================================
// Dashboard JSON export for AI analysis
// ============================================

const DASHBOARD_AI_HINT =
  'این snapshot داشبورد کمپین است؛ فیلترها و کارت‌ها و سری نمودارها را تحلیل کن و روندها/ریسک‌ها را بگو.'

function mapFollowupTableRows(list) {
  return (list || []).map(c => {
    const phones = formatPhonesDisplay(c)
    return {
      customerId: c.id || '',
      name: c.name || c.platformId || '',
      phone: phones.text || '',
      advisor: advisorNameForCustomer(c),
      nextFollowupDate: c.nextFollowupDate || '',
      productCount: (c.products || []).length
    }
  })
}

function collectTransferMetricsForExport(dateFromNum, dateToNum) {
  const data = getData()
  const transfers = (data.ownershipTransfers || []).filter(t =>
    transferInDateRange(t, dateFromNum, dateToNum) && transferTouchesSelected(t)
  )
  const batches = new Set(transfers.map(t => t.batchId).filter(Boolean))

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
      if (!transfers.some(t => t.id === curr.id)) continue
      const to = normalizePhone(prev.toAdvisorPhone)
      if (selectedAdvisorPhones && to && !selectedAdvisorPhones.has(to)) continue
      const ms = new Date(curr.createdAt) - new Date(prev.createdAt)
      if (ms >= 0) dwellDays.push(ms / (1000 * 60 * 60 * 24))
    }
  }

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

  const stats = {}
  function ensureRow(phone, name) {
    const key = phone || name || '—'
    if (!stats[key]) stats[key] = { phone: phone || '', name: name || phone || '—', in: 0, out: 0 }
    return stats[key]
  }
  for (const t of transfers) {
    const from = normalizePhone(t.fromAdvisorPhone)
    const to = normalizePhone(t.toAdvisorPhone)
    if (from && selectedAdvisorPhones?.has(from)) ensureRow(from, t.fromAdvisorName).out++
    if (to && selectedAdvisorPhones?.has(to)) ensureRow(to, t.toAdvisorName).in++
  }

  return {
    count: transfers.length,
    batches: batches.size,
    avgDwellDays: dwellDays.length
      ? Math.round(dwellDays.reduce((a, b) => a + b, 0) / dwellDays.length)
      : null,
    conversion30d: {
      pct: convEligible ? Math.round((convHit / convEligible) * 100) : null,
      hits: convHit,
      eligible: convEligible
    },
    byAdvisor: Object.values(stats)
      .sort((a, b) => (b.in + b.out) - (a.in + a.out))
      .map(r => ({
        name: r.name || r.phone,
        phone: r.phone,
        in: r.in,
        out: r.out,
        net: r.in - r.out
      }))
  }
}

function collectSalesTargetsForExport(dateFromNum, dateToNum) {
  const viewer = getCurrentUser()
  const canSee = isMainAdmin(viewer) || !!(viewer?.isGroupManager && viewer?.groupId)
  if (!canSee) {
    return { visible: false, scope: null, rows: [] }
  }
  let targets = []
  try {
    targets = getSalesTargets()
  } catch (_) {
    return { visible: true, scope: null, rows: [], error: 'failed_to_load' }
  }
  if (!targets.length) return { visible: true, scope: null, rows: [] }

  let blocks = []
  try {
    blocks = buildDashTargetBlocks(targets, viewer)
  } catch (_) {
    return { visible: true, scope: null, rows: [], error: 'failed_to_build' }
  }
  if (!blocks.length) return { visible: true, scope: null, rows: [] }

  const options = buildDashTargetScopeOptions(blocks, viewer)
  const scopeSel = document.getElementById('dashTargetsScope')
  const selectedScope = (scopeSel?.value && options.some(o => o.value === scopeSel.value))
    ? scopeSel.value
    : (options.some(o => o.value === 'org') ? 'org' : (options[0]?.value || 'org'))

  const rows = []
  for (const block of blocks.filter(b => b.scope === selectedScope)) {
    for (const { bar, goalOverride, phoneSet } of (block.bars || [])) {
      const goal = goalOverride != null ? Number(goalOverride) : (Number(bar.value) || 0)
      const current = computeSalesTargetCurrent(bar, dateFromNum, dateToNum, phoneSet || null)
      const pct = goal > 0 ? Math.min(100, Math.round((current / goal) * 1000) / 10) : 0
      rows.push({
        groupTitle: block.title || '',
        metric: bar.metric === 'count' ? 'count' : 'amount',
        productNames: bar.productNames || [],
        current,
        goal,
        pct,
        startDate: bar.startDate || '',
        endDate: bar.endDate || ''
      })
    }
  }
  return { visible: true, scope: selectedScope, rows }
}

function collectSalesTimelineForExport() {
  ensureSalesChartDefaults()
  if (!syncSalesChartTimeframeOptions()) {
    return {
      from: '',
      to: '',
      timeframe: 'day',
      metric: 'amount',
      ma3: false,
      buckets: []
    }
  }
  const from = document.getElementById('salesChartFrom')?.value.trim() || ''
  const to = document.getElementById('salesChartTo')?.value.trim() || ''
  const timeframe = document.getElementById('salesChartTimeframe')?.value || 'day'
  const metric = document.getElementById('salesChartMetric')?.value === 'count' ? 'count' : 'amount'
  const showMa3 = !!document.getElementById('salesChartShowMa3')?.checked
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
      if (idx === -1) return
      totals[idx] += metric === 'count' ? 1 : amount
    }
  )
  const ma = showMa3 ? movingAverageSeries(totals, 3) : null
  return {
    from,
    to,
    timeframe,
    metric,
    ma3: showMa3,
    buckets: buckets.map((b, i) => ({
      label: b.label,
      from: jalaliNumToStr(b.fromNum) || '',
      to: jalaliNumToStr(b.toNum) || '',
      value: totals[i],
      ma3: ma ? ma[i] : null
    }))
  }
}

function collectAovMaForExport(dateFromNum, dateToNum) {
  const displayDays = getAovDisplayWindowDays()
  const maDays = getAovMaWindowDays()
  const { buckets } = resolveAovDisplayDayRange(dateFromNum, dateToNum)
  const labels = buckets.map(b => b.label)
  const dayNums = buckets.map(b => b.fromNum)
  const allPoints = collectCompletedSalePointsForAov()
  const byPhone = new Map()
  for (const p of allPoints) {
    if (!byPhone.has(p.phone)) byPhone.set(p.phone, [])
    byPhone.get(p.phone).push(p)
  }
  const selectedPhones = [...(selectedAdvisorPhones || [])]
    .filter(Boolean)
    .map(p => normalizePhone(p))
    .filter(Boolean)
    .sort((a, b) => advisorLabelForPhone(a).localeCompare(advisorLabelForPhone(b), 'fa'))

  const series = []
  selectedPhones.forEach(phone => {
    const advisorPoints = byPhone.get(phone) || []
    const values = buildAovMaValues(advisorPoints, dayNums, maDays)
    if (!values.some(v => v != null)) return
    series.push({ id: phone, label: advisorLabelForPhone(phone), values })
  })
  series.push({
    id: 'overall',
    label: 'میانگین کل',
    values: buildAovMaValues(allPoints, dayNums, maDays)
  })

  return { displayDays, maDays, labels, series }
}

/**
 * Build a machine-readable snapshot of the current dashboard (same numbers as UI).
 */
export async function buildDashboardExportPayload() {
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
  const hasDateFilter = !!(dateFrom || dateTo)

  function inDateRange(dateStr) {
    if (!dateFrom && !dateTo) return true
    if (!dateStr) return false
    const dNum = jalaliToNum(dateStr)
    return dNum >= dateFromNum && dNum <= dateToNum
  }

  function inUserScope(c) {
    return matchesSelectedUsers(c)
  }

  const scopedCustomers = data.customers.filter(c => {
    if (c.id.startsWith('LD') && !hasPermission('customers_ld')) return false
    if (c.id.startsWith('CS') && !hasPermission('customers_cs')) return false
    return inUserScope(c)
  })

  function customerCreatedInRange(c) {
    if (!hasDateFilter) return true
    return inDateRange(gregorianToJalaliStr(c.createdAt))
  }

  const datedCustomers = scopedCustomers.filter(customerCreatedInRange)

  const visibleFollowups = data.followups.filter(f => {
    const customer = data.customers.find(c => c.id === f.customerId)
    if (!customer || !inUserScope(customer)) return false
    if (customer.id.startsWith('LD') && !hasPermission('customers_ld')) return false
    if (customer.id.startsWith('CS') && !hasPermission('customers_cs')) return false
    return true
  })
  const followupsCompleted = visibleFollowups.filter(f => {
    const isDone = f.status === 'done' ||
      f.type === 'پیگیری انجام‌شده' ||
      f.type === 'پیگیری معوقه انجام‌شده'
    return isDone && inDateRange(jalaliDatePart(f.doneAt || f.date))
  }).length
  const followupsUpcoming = scopedCustomers.filter(c => {
    if (!c.nextFollowupDate) return false
    const nextDate = jalaliDatePart(c.nextFollowupDate)
    return jalaliToNum(nextDate) >= todayNum && inDateRange(nextDate)
  }).length

  let overdueList = []
  let soonList = []
  let setCount = 0
  let noSetCount = 0
  scopedCustomers.forEach(c => {
    if (c.nextFollowupDate) {
      const nextDate = jalaliDatePart(c.nextFollowupDate)
      if (hasDateFilter && !inDateRange(nextDate)) return
      const dNum = jalaliToNum(nextDate)
      if (matchesFollowupMonitorScope(c)) {
        if (dNum < todayNum) overdueList.push(c)
        else if (dNum <= in3DaysNum) soonList.push(c)
      }
      setCount++
    } else if (customerCreatedInRange(c)) {
      noSetCount++
    }
  })

  const salesMetrics = resolveDashSalesMetrics(hasDateFilter, inDateRange)
  const avgSale = salesMetrics.salesCount > 0
    ? Math.round(salesMetrics.totalApproved / salesMetrics.salesCount)
    : 0

  let refundsCompleted = 0
  let refundsRequested = 0
  let refundsAwaiting = 0
  try {
    refundsCompleted = sumCompletedRefundsForDash({
      dateFromNum,
      dateToNum,
      advisorPhones: selectedAdvisorPhones
    })
    const pendingRefunds = countPendingRefundsForDash({
      dateFromNum,
      dateToNum,
      advisorPhones: selectedAdvisorPhones
    })
    refundsRequested = pendingRefunds.requested
    refundsAwaiting = pendingRefunds.awaiting
  } catch (_) { /* ignore */ }

  const advisorList = [...(selectedAdvisorPhones || [])]
    .map(phone => {
      const p = normalizePhone(phone)
      return { phone: p, name: advisorLabelForPhone(p) }
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'fa'))

  const allAdvisorsSelected = !!(
    dashUsersCache.length &&
    selectedAdvisorPhones &&
    selectedAdvisorPhones.size >= dashUsersCache.length
  )

  // Charts (same rules as renderDashCharts)
  function inChartDateRange(dateStr) {
    if (!dateFromNum && (!dateToNum || dateToNum === 99999999)) return true
    if (!dateStr) return false
    const dNum = jalaliToNum(dateStr)
    return dNum >= (dateFromNum || 0) && dNum <= (dateToNum || 99999999)
  }

  const statusLabels = getStatusLabels()
  const statusOrder = {}
  getStatuses().forEach((s, i) => {
    statusOrder[s.key] = s.order != null ? s.order : i
  })
  const platformLabels = getPlatformLabels()
  const custStatusCounts = {}
  const platformCounts = {}
  data.customers.forEach(c => {
    if (c.id.startsWith('LD') && !hasPermission('customers_ld')) return
    if (c.id.startsWith('CS') && !hasPermission('customers_cs')) return
    if (!inUserScope(c)) return
    if (hasDateFilter && !inChartDateRange(gregorianToJalaliStr(c.createdAt))) return
    const statusKey = c.status || ''
    custStatusCounts[statusKey] = (custStatusCounts[statusKey] || 0) + 1
    const platformKey = c.platform || ''
    platformCounts[platformKey] = (platformCounts[platformKey] || 0) + 1
  })
  const totalCustomersForStatus = Object.values(custStatusCounts).reduce((s, n) => s + n, 0)
  const customerStatus = Object.entries(custStatusCounts)
    .map(([key, count]) => ({
      key,
      label: statusLabels[key] || key || '—',
      count,
      pct: totalCustomersForStatus > 0 ? Math.round((count / totalCustomersForStatus) * 100) : 0,
      order: statusOrder[key] != null ? statusOrder[key] : 999
    }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count
      if (b.pct !== a.pct) return b.pct - a.pct
      return a.order - b.order
    })
    .slice(0, 7)
    .map(({ key, label, count, pct }) => ({ key, label, count, pct }))

  const totalPlatformCustomers = Object.values(platformCounts).reduce((s, n) => s + n, 0)
  const platforms = Object.entries(platformCounts)
    .map(([key, count]) => {
      const exactPct = totalPlatformCustomers > 0 ? (count / totalPlatformCustomers) * 100 : 0
      return {
        key,
        label: platformLabels[key] || key || '—',
        count,
        exactPct,
        pct: Math.round(exactPct)
      }
    })
    .filter(p => p.exactPct >= 4)
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count
      return a.label.localeCompare(b.label, 'fa')
    })
    .map(({ key, label, count, pct }) => ({ key, label, count, pct }))

  const salesStatus = { 'تکمیل': 0, 'بیعانه': 0 }
  const productSales = {}
  const productCounts = {}
  forEachDashSalePayment(
    matchesSelectedSaleRegistrant,
    hasDateFilter,
    inChartDateRange,
    () => {},
    ({ product, paidInScope }) => {
      const statusKey = product.status === 'تکمیل' ? 'تکمیل' : 'بیعانه'
      salesStatus[statusKey] = (salesStatus[statusKey] || 0) + paidInScope
      const name = coerceProductName(product.name) || '—'
      productSales[name] = (productSales[name] || 0) + paidInScope
      productCounts[name] = (productCounts[name] || 0) + 1
    }
  )
  const salesStatusEntries = [
    { label: 'تکمیل', amount: salesStatus['تکمیل'] || 0 },
    { label: 'بیعانه', amount: salesStatus['بیعانه'] || 0 }
  ]
  const salesStatusTotal = salesStatusEntries.reduce((s, e) => s + e.amount, 0)
  const salesStatusChart = salesStatusEntries.map(e => ({
    label: e.label,
    amount: e.amount,
    pct: salesStatusTotal > 0 ? Math.round((e.amount / salesStatusTotal) * 100) : 0
  }))

  const codeFilter = document.getElementById('dashConversionCustomerCode')?.value || ''
  const customersWithActivity = new Set()
  data.followups.forEach(f => {
    const dateStr = jalaliDatePart(f.doneAt || f.date)
    if (!inDateRange(dateStr)) return
    if (!f.customerId) return
    customersWithActivity.add(f.customerId)
  })
  const customersWithSale = new Set()
  forEachDashSalePayment(
    matchesSelectedSaleRegistrant,
    hasDateFilter,
    inDateRange,
    () => {},
    ({ customer }) => {
      if (customer?.id) customersWithSale.add(customer.id)
    }
  )
  let convWithSale = 0
  let convWithoutSale = 0
  customersWithActivity.forEach(customerId => {
    const c = data.customers.find(x => x.id === customerId)
    if (!c) return
    if (c.id.startsWith('LD') && !hasPermission('customers_ld')) return
    if (c.id.startsWith('CS') && !hasPermission('customers_cs')) return
    if (!inUserScope(c)) return
    if (codeFilter && (c.customerCode || '') !== codeFilter) return
    if (customersWithSale.has(customerId)) convWithSale += 1
    else convWithoutSale += 1
  })
  const convTotal = convWithSale + convWithoutSale
  const followupConversionChart = {
    customerCodeFilter: codeFilter || null,
    rows: [
      {
        label: 'دارای فروش',
        count: convWithSale,
        pct: convTotal > 0 ? Math.round((convWithSale / convTotal) * 100) : 0
      },
      {
        label: 'بدون فروش',
        count: convWithoutSale,
        pct: convTotal > 0 ? Math.round((convWithoutSale / convTotal) * 100) : 0
      }
    ]
  }

  const productMetric = document.getElementById('productChartMetric')?.value === 'count' ? 'count' : 'amount'
  const productSource = productMetric === 'count' ? productCounts : productSales
  const productsChart = {
    metric: productMetric,
    rows: Object.keys(productSource || {})
      .map(name => ({ name, value: productSource[name] || 0 }))
      .sort((a, b) => b.value - a.value)
  }

  const advisorMetric = document.getElementById('advisorCompareMetric')?.value === 'gross' ? 'gross' : 'net'
  const advisorCompare = {
    metric: advisorMetric,
    rows: buildAdvisorCompareRows(dateFromNum, dateToNum, advisorMetric).map(r => ({
      phone: r.phone,
      label: r.label,
      value: Math.round(r.value)
    }))
  }

  return {
    meta: {
      exportedAt: new Date().toISOString(),
      currency: 'IRR',
      calendar: 'jalali',
      aiHint: DASHBOARD_AI_HINT
    },
    filters: {
      dateFrom,
      dateTo,
      advisors: advisorList,
      advisorSelection: allAdvisorsSelected ? 'all' : 'subset',
      notes: {
        customersScopedBy: 'customer.advisorPhone',
        salesScopedBy: 'saleRegistrantPhone',
        completedSalesDatedBy: 'completionPayment.soldAt'
      }
    },
    cards: {
      totalCustomers: datedCustomers.length,
      setFollowup: setCount,
      overdueFollowup: overdueList.length,
      noFollowup: noSetCount,
      soonFollowup: soonList.length,
      activeCustomers: datedCustomers.filter(c => c.products && c.products.length > 0).length,
      leads: datedCustomers.filter(c => c.id.startsWith('LD')).length,
      customersWithPhone: datedCustomers.filter(c => c.id.startsWith('CS')).length,
      followupsCompleted,
      followupsUpcoming,
      salesCountCompleted: salesMetrics.salesCount,
      deposits: salesMetrics.totalDeposit,
      balances: salesMetrics.totalBalance,
      approvedSalesTotal: salesMetrics.totalApproved,
      grossProfit: salesMetrics.completedGrossProfit,
      pendingAccounting: salesMetrics.totalPending,
      avgSale,
      refundsRequested,
      refundsAwaiting,
      refundsCompleted
    },
    transfers: collectTransferMetricsForExport(dateFromNum, dateToNum),
    charts: {
      customerStatus,
      salesStatus: salesStatusChart,
      followupConversion: followupConversionChart,
      platforms,
      products: productsChart,
      advisorCompare,
      salesTimeline: collectSalesTimelineForExport(),
      aovMa: collectAovMaForExport(dateFromNum, dateToNum),
      salesTargets: collectSalesTargetsForExport(dateFromNum, dateToNum)
    },
    tables: {
      overdueFollowups: mapFollowupTableRows(overdueList),
      soonFollowups: mapFollowupTableRows(soonList)
    }
  }
}

function downloadJsonFile(filename, obj) {
  const json = JSON.stringify(obj, null, 2)
  const blob = new Blob([json], { type: 'application/json;charset=utf-8;' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 2000)
}

export async function exportDashboardForAi() {
  try {
    const payload = await buildDashboardExportPayload()
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    downloadJsonFile(`dashboard-export-${day}.json`, payload)
    showToast('خروجی JSON داشبورد دانلود شد')
  } catch (e) {
    console.error('exportDashboardForAi error:', e)
    showToast('خطا در ساخت خروجی داشبورد')
  }
}

export async function copyDashboardExport() {
  try {
    const payload = await buildDashboardExportPayload()
    const text = JSON.stringify(payload, null, 2)
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.left = '-9999px'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    showToast('JSON داشبورد کپی شد')
  } catch (e) {
    console.error('copyDashboardExport error:', e)
    showToast('خطا در کپی خروجی داشبورد')
  }
}
