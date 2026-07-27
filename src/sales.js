import { getData } from './data.js'
import {
  toEnDigits, formatNumber, escapeHtml, escapeAttr, hasPermission, getCurrentUser,
  jalaliToNum, getTodayJalaliNum, jalaliAddDays, getTodayJalaliStr, ownsCustomer,
  PLATFORM_LABELS, PLATFORM_CLASSES, getPaymentAmount, getPaymentStatus, PAYMENT_STATUS_LABELS
} from './utils.js'

// ============================================
// Sales Data
// ============================================

export function getAllSales() {
  const data = getData()
  const sales = []
  data.customers.forEach(c => {
    if (c.products) {
      c.products.forEach((p, productIndex) => {
        const price = parseFloat(p.price) || 0
        const deposit = parseFloat(p.deposit) || 0
        const balance = price - deposit
        sales.push({
          customerId: c.id,
          productIndex,
          customerName: c.name || c.platformId,
          customerPhone: c.phone || '',
          platform: c.platform,
          productName: p.name,
          status: p.status,
          price,
          deposit,
          balance,
          settlementDate: p.settlementDate || '',
          soldAt: p.soldAt || '',
          depositorName: p.depositorName || '',
          paymentAmount: getPaymentAmount(p),
          paymentStatus: getPaymentStatus(p),
          paymentRejectReason: p.paymentRejectReason || ''
        })
      })
    }
  })
  return sales
}

// ============================================
// Render Sales
// ============================================

function getFilteredSales() {
  const search = toEnDigits(document.getElementById('searchSales').value || '').toLowerCase()
  let allSales = getAllSales()

  const currentUser = getCurrentUser()
  const isAdmin = currentUser && currentUser.role === 'admin'
  const data = getData()

  if (search) {
    allSales = allSales.filter(s =>
      s.customerId.toLowerCase().includes(search) ||
      s.customerName.toLowerCase().includes(search) ||
      s.customerPhone.includes(search) ||
      s.productName.toLowerCase().includes(search) ||
      (s.depositorName || '').toLowerCase().includes(search)
    )
  }

  allSales = allSales.filter(s => {
    if (s.customerId.startsWith('LD') && !hasPermission('customers_ld')) return false
    if (s.customerId.startsWith('CS') && !hasPermission('customers_cs')) return false
    const customer = data.customers.find(c => c.id === s.customerId)
    if (!isAdmin && customer && !ownsCustomer(customer, currentUser)) return false
    return true
  })

  return allSales
}

function renderSalesRows(allSales) {
  const todayNum = getTodayJalaliNum()
  const canBulkDelete = hasPermission('customers_add')
  return allSales.map(s => {
    const pClass = PLATFORM_CLASSES[s.platform] || ''
    const pLabel = PLATFORM_LABELS[s.platform] || s.platform
    const statusColor = s.status === 'تکمیل' ? 'var(--success)' : 'var(--warning)'
    const balanceClass = s.balance > 0 ? 'color:var(--danger);' : ''

    let settlementHtml = '—'
    let rowClass = ''
    if (s.settlementDate) {
      const dateNum = jalaliToNum(s.settlementDate)
      const in3DaysNum = jalaliAddDays(getTodayJalaliStr(), 3)
      if (dateNum < todayNum) {
        settlementHtml = `<span class="settlement-badge settlement-overdue-badge">⚠ ${s.settlementDate}</span>`
        rowClass = 'settlement-overdue'
      } else if (dateNum <= in3DaysNum) {
        settlementHtml = `<span class="settlement-badge settlement-soon-badge">${s.settlementDate}</span>`
        rowClass = 'settlement-soon'
      } else {
        settlementHtml = `<span style="font-family:'Vazirmatn',sans-serif;">${s.settlementDate}</span>`
      }
    }

    if (s.paymentStatus === 'rejected') {
      rowClass = (rowClass + ' payment-rejected-row').trim()
    }

    const payLabel = PAYMENT_STATUS_LABELS[s.paymentStatus] || s.paymentStatus
    let paymentHtml = `<span class="payment-badge payment-${s.paymentStatus}">${escapeHtml(payLabel)}</span>`
    if (s.paymentStatus === 'rejected' && s.paymentRejectReason) {
      paymentHtml += `<div class="payment-reject-reason" title="${escapeAttr(s.paymentRejectReason)}">${escapeHtml(s.paymentRejectReason)}</div>`
    }

    return `<tr class="${rowClass}">
      <td>${canBulkDelete ? `<input type="checkbox" data-id="${escapeAttr(s.customerId)}" onchange="app.toggleRowSelect('sales', '${escapeAttr(s.customerId)}', this.checked)">` : ''}</td>
      <td><span class="id-badge ${s.customerId.startsWith('CS') ? 'id-cs' : 'id-ld'}" style="cursor:pointer;" onclick="app.openCustomerDetail('${escapeAttr(s.customerId)}')">${escapeHtml(s.customerId)}</span></td>
      <td>${escapeHtml(s.customerName)}</td>
      <td style="direction:ltr;text-align:right;font-family:'Vazirmatn',sans-serif;font-size:13px;">${escapeHtml(s.customerPhone) || '—'}</td>
      <td><span class="platform-icon"><span class="platform-dot ${pClass}"></span>${escapeHtml(pLabel)}</span></td>
      <td>${escapeHtml(s.productName)}</td>
      <td><span style="color:${statusColor};font-weight:600;">${escapeHtml(s.status)}</span></td>
      <td style="direction:ltr;text-align:right;font-family:'Vazirmatn',sans-serif;">${s.price > 0 ? formatNumber(s.price) : '—'}</td>
      <td style="direction:ltr;text-align:right;font-family:'Vazirmatn',sans-serif;">${s.deposit > 0 ? formatNumber(s.deposit) : '—'}</td>
      <td style="direction:ltr;text-align:right;font-family:'Vazirmatn',sans-serif;font-weight:600;${balanceClass}">${s.status === 'بیعانه' ? formatNumber(s.balance) : '—'}</td>
      <td style="font-size:12px;">${settlementHtml}</td>
      <td style="font-family:'Vazirmatn',sans-serif;font-size:12px;direction:ltr;text-align:right;">${escapeHtml(s.soldAt) || '—'}</td>
      <td>${escapeHtml(s.depositorName) || '—'}</td>
      <td>${paymentHtml}</td>
    </tr>`
  }).join('')
}

export function renderSales() {
  const tbody = document.getElementById('salesBody')

  let allSales = getFilteredSales()

  // Rejected payments first (for advisor follow-up), then overdue settlement, then date
  allSales.sort((a, b) => {
    const aRej = a.paymentStatus === 'rejected' ? 0 : 1
    const bRej = b.paymentStatus === 'rejected' ? 0 : 1
    if (aRej !== bRej) return aRej - bRej

    const aNum = a.settlementDate ? jalaliToNum(a.settlementDate) : 99999999
    const bNum = b.settlementDate ? jalaliToNum(b.settlementDate) : 99999999
    const aOverdue = aNum < getTodayJalaliNum() && a.settlementDate ? 0 : 1
    const bOverdue = bNum < getTodayJalaliNum() && b.settlementDate ? 0 : 1
    if (aOverdue !== bOverdue) return aOverdue - bOverdue
    return aNum - bNum
  })

  // Stats exclude accounting-rejected payments (still shown in the table for follow-up)
  const countable = allSales.filter(s => s.paymentStatus !== 'rejected')
  const cashSales = countable.filter(s => s.status === 'تکمیل')
  const depositSales = countable.filter(s => s.status === 'بیعانه')

  const totalCash = cashSales.reduce((sum, s) => sum + s.price, 0)
  const totalDeposit = depositSales.reduce((sum, s) => sum + s.deposit, 0)
  const totalBalance = depositSales.reduce((sum, s) => sum + s.balance, 0)
  const totalAll = countable.reduce((sum, s) => sum + s.price, 0)

  document.getElementById('stat-sales-count').textContent = countable.length
  document.getElementById('stat-sales-cash').textContent = formatNumber(totalCash) + ' ریال'
  document.getElementById('stat-sales-deposit').textContent = formatNumber(totalDeposit) + ' ریال'
  document.getElementById('stat-sales-balance').textContent = formatNumber(totalBalance) + ' ریال'
  document.getElementById('stat-sales-total').textContent = formatNumber(totalAll) + ' ریال'

  if (allSales.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="14">
        <div class="empty-state">
          <div class="icon">🛒</div>
          <h3>فروشی ثبت نشده</h3>
          <p>از پنل مشتریان محصول اضافه کنید</p>
        </div>
      </td></tr>`
    return
  }

  tbody.innerHTML = renderSalesRows(allSales)
}

// ============================================
// Sales Sort
// ============================================

let salesSortState = { field: null, asc: true }

export function sortSales(field) {
  if (salesSortState.field === field) salesSortState.asc = !salesSortState.asc
  else { salesSortState.field = field; salesSortState.asc = true }

  const allSales = getFilteredSales()
  allSales.sort((a, b) => {
    let va = a[field], vb = b[field]
    if (field === 'settlementDate') {
      va = jalaliToNum(va)
      vb = jalaliToNum(vb)
    }
    if (typeof va === 'number') return salesSortState.asc ? va - vb : vb - va
    return salesSortState.asc ? String(va).localeCompare(String(vb), 'fa') : String(vb).localeCompare(String(va), 'fa')
  })

  const tbody = document.getElementById('salesBody')
  tbody.innerHTML = renderSalesRows(allSales)
}
