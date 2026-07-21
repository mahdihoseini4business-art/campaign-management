import { getData } from './data.js'
import { hasPermission, formatNumber, jalaliToNum, getTodayJalaliNum, jalaliAddDays, getTodayJalaliStr, escapeHtml } from './utils.js'
import { getAllSales } from './sales.js'

let dashCharts = {}

// ============================================
// Dashboard
// ============================================

export function toggleDashSection(section) {
  const body = document.getElementById(`dash-${section}-body`)
  const arrow = document.getElementById(`dash-arrow-${section}`)
  body.classList.toggle('open')
  arrow.classList.toggle('open')
}

export function renderDashboard() {
  const data = getData()
  const dateFrom = document.getElementById('dashDateFrom').value.trim()
  const dateTo = document.getElementById('dashDateTo').value.trim()
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

  // General stats
  document.getElementById('dash-total-customers').textContent = data.customers.filter(c => {
    if (c.id.startsWith('LD') && !hasPermission('customers_ld')) return false
    if (c.id.startsWith('CS') && !hasPermission('customers_cs')) return false
    return true
  }).length
  document.getElementById('dash-total-leads').textContent = data.customers.filter(c => c.id.startsWith('LD') && hasPermission('customers_ld')).length
  document.getElementById('dash-total-cs').textContent = data.customers.filter(c => c.id.startsWith('CS') && hasPermission('customers_cs')).length
  document.getElementById('dash-total-followups').textContent = data.followups.filter(f => {
    const customer = data.customers.find(c => c.id === f.customerId)
    if (customer) {
      if (customer.id.startsWith('LD') && !hasPermission('customers_ld')) return false
      if (customer.id.startsWith('CS') && !hasPermission('customers_cs')) return false
    }
    if (!inDateRange(f.date)) return false
    return true
  }).length

  // Followup stats
  let overdueList = []
  let soonList = []
  let setCount = 0
  let noSetCount = 0

  data.customers.forEach(c => {
    if (c.id.startsWith('LD') && !hasPermission('customers_ld')) return
    if (c.id.startsWith('CS') && !hasPermission('customers_cs')) return
    if (c.nextFollowupDate) {
      if (!inDateRange(c.nextFollowupDate)) return
      const dNum = jalaliToNum(c.nextFollowupDate)
      if (dNum < todayNum) overdueList.push(c)
      else if (dNum <= in3DaysNum) soonList.push(c)
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

  // Sales stats - include sales without settlement date when date filter is active
  const allSales = getAllSales().filter(s => {
    if (s.customerId.startsWith('LD') && !hasPermission('customers_ld')) return false
    if (s.customerId.startsWith('CS') && !hasPermission('customers_cs')) return false
    if ((dateFrom || dateTo) && s.settlementDate && !inDateRange(s.settlementDate)) return false
    return true
  })
  const cashSales = allSales.filter(s => s.status === 'تکمیل')
  const depositSales = allSales.filter(s => s.status === 'بیعانه')

  const totalCash = cashSales.reduce((sum, s) => sum + s.price, 0)
  const totalDeposit = depositSales.reduce((sum, s) => sum + s.deposit, 0)
  const totalBalance = depositSales.reduce((sum, s) => sum + s.balance, 0)
  const totalAll = allSales.reduce((sum, s) => sum + s.price, 0)

  document.getElementById('dash-sales-count').textContent = allSales.length
  document.getElementById('dash-sales-cash').textContent = formatNumber(totalCash) + ' ریال'
  document.getElementById('dash-sales-deposit').textContent = formatNumber(totalDeposit) + ' ریال'
  document.getElementById('dash-sales-balance').textContent = formatNumber(totalBalance) + ' ریال'
  document.getElementById('dash-sales-total').textContent = formatNumber(totalAll) + ' ریال'

  const activeCustomers = data.customers.filter(c => {
    if (c.id.startsWith('LD') && !hasPermission('customers_ld')) return false
    if (c.id.startsWith('CS') && !hasPermission('customers_cs')) return false
    return c.products && c.products.length > 0
  })
  document.getElementById('dash-active-customers').textContent = activeCustomers.length

  const avgSale = allSales.length > 0 ? Math.round(totalAll / allSales.length) : 0
  document.getElementById('dash-avg-sale').textContent = formatNumber(avgSale) + ' ریال'

  // Overdue list
  const overdueBody = document.getElementById('dashOverdueBody')
  if (overdueList.length === 0) {
    overdueBody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px;">پیگیری عقب افتاده‌ای وجود ندارد</td></tr>'
  } else {
    overdueBody.innerHTML = overdueList.map(c => `<tr style="background:#fff8f0;">
      <td><span class="id-badge ${c.id.startsWith('CS') ? 'id-cs' : 'id-ld'}" style="cursor:pointer;" onclick="window.appOpenCustomerDetail('${c.id}')">${escapeHtml(c.id)}</span></td>
      <td>${escapeHtml(c.name || c.platformId)}</td>
      <td style="direction:ltr;text-align:right;font-family:monospace;font-size:13px;">${escapeHtml(c.phone) || '—'}</td>
      <td><span class="settlement-badge settlement-overdue-badge">⚠ ${c.nextFollowupDate}</span></td>
      <td style="text-align:center;">${(c.products || []).length}</td>
    </tr>`).join('')
  }

  // Soon list
  const soonBody = document.getElementById('dashSoonBody')
  if (soonList.length === 0) {
    soonBody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px;">پیگیری نزدیکی وجود ندارد</td></tr>'
  } else {
    soonBody.innerHTML = soonList.map(c => `<tr style="background:#f0fff4;">
      <td><span class="id-badge ${c.id.startsWith('CS') ? 'id-cs' : 'id-ld'}" style="cursor:pointer;" onclick="window.appOpenCustomerDetail('${c.id}')">${escapeHtml(c.id)}</span></td>
      <td>${escapeHtml(c.name || c.platformId)}</td>
      <td style="direction:ltr;text-align:right;font-family:monospace;font-size:13px;">${escapeHtml(c.phone) || '—'}</td>
      <td><span class="settlement-badge settlement-soon-badge">${c.nextFollowupDate}</span></td>
      <td style="text-align:center;">${(c.products || []).length}</td>
    </tr>`).join('')
  }

  // Charts
  renderDashCharts(dateFromNum, dateToNum)
}

function renderDashCharts(dateFromNum, dateToNum) {
  const data = getData()
  Object.values(dashCharts).forEach(c => c.destroy())
  dashCharts = {}

  function inChartDateRange(dateStr) {
    if (!dateFromNum && (!dateToNum || dateToNum === 99999999)) return true
    if (!dateStr) return false
    const dNum = jalaliToNum(dateStr)
    return dNum >= (dateFromNum || 0) && dNum <= (dateToNum || 99999999)
  }

  const statusLabels = { new: 'جدید', contacted: 'تماس گرفته', chatting: 'در حال چت', interested: 'علاقه‌مند', sent: 'اطلاعات ارسال', followup_done: 'تکمیل پیگیری', converting: 'در حال تبدیل', purchased: 'خرید کرد', cancelled: 'منصرف شده' }
  const statusColors = { new: '#e9ecef', contacted: '#cce5ff', chatting: '#d0bfff', interested: '#fff3cd', sent: '#d1e7dd', followup_done: '#b6effb', converting: '#f8d7da', purchased: '#198754', cancelled: '#adb5bd' }

  const custStatusCounts = {}
  data.customers.forEach(c => {
    if (c.id.startsWith('LD') && !hasPermission('customers_ld')) return
    if (c.id.startsWith('CS') && !hasPermission('customers_cs')) return
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
  getAllSales().forEach(s => {
    if (s.customerId.startsWith('LD') && !hasPermission('customers_ld')) return
    if (s.customerId.startsWith('CS') && !hasPermission('customers_cs')) return
    if (!inChartDateRange(s.settlementDate)) return
    salesStatus[s.status] = (salesStatus[s.status] || 0) + s.price
  })
  dashCharts.salesStatus = new Chart(document.getElementById('chartSalesStatus'), {
    type: 'pie',
    data: {
      labels: Object.keys(salesStatus),
      datasets: [{ data: Object.values(salesStatus), backgroundColor: ['#198754', '#ffc107'], borderWidth: 2, borderColor: '#fff' }]
    },
    options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { font: { family: 'Vazirmatn', size: 11 } } } } }
  })

  const productSales = {}
  getAllSales().forEach(s => {
    if (s.customerId.startsWith('LD') && !hasPermission('customers_ld')) return
    if (s.customerId.startsWith('CS') && !hasPermission('customers_cs')) return
    if (!inChartDateRange(s.settlementDate)) return
    productSales[s.productName] = (productSales[s.productName] || 0) + s.price
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
}

export function clearDashFilter() {
  document.getElementById('dashDateFrom').value = ''
  document.getElementById('dashDateTo').value = ''
  renderDashboard()
}
