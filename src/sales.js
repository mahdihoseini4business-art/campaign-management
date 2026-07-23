import { getData } from './data.js'
import { toEnDigits, formatNumber, escapeHtml, hasPermission, jalaliToNum, getTodayJalaliNum, jalaliAddDays, getTodayJalaliStr } from './utils.js'

const PLATFORM_LABELS = { instagram: 'اینستاگرام', telegram: 'تلگرام', whatsapp: 'واتساپ' }
const PLATFORM_CLASSES = { instagram: 'platform-ig', telegram: 'platform-tg', whatsapp: 'platform-wa' }

// ============================================
// Sales Data
// ============================================

export function getAllSales() {
  const data = getData()
  const sales = []
  data.customers.forEach(c => {
    if (c.products) {
      c.products.forEach(p => {
        const price = parseFloat(p.price) || 0
        const deposit = parseFloat(p.deposit) || 0
        const balance = price - deposit
        sales.push({
          customerId: c.id,
          customerName: c.name || c.platformId,
          customerPhone: c.phone || '',
          platform: c.platform,
          productName: p.name,
          status: p.status,
          price,
          deposit,
          balance,
          settlementDate: p.settlementDate || ''
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

  if (search) {
    allSales = allSales.filter(s =>
      s.customerId.toLowerCase().includes(search) ||
      s.customerName.toLowerCase().includes(search) ||
      s.customerPhone.includes(search) ||
      s.productName.toLowerCase().includes(search)
    )
  }

  allSales = allSales.filter(s => {
    if (s.customerId.startsWith('LD') && !hasPermission('customers_ld')) return false
    if (s.customerId.startsWith('CS') && !hasPermission('customers_cs')) return false
    return true
  })

  return allSales
}

function renderSalesRows(allSales) {
  const todayNum = getTodayJalaliNum()
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
        settlementHtml = `<span style="font-family:monospace;">${s.settlementDate}</span>`
      }
    }

    return `<tr class="${rowClass}">
      <td><span class="id-badge ${s.customerId.startsWith('CS') ? 'id-cs' : 'id-ld'}" style="cursor:pointer;" onclick="window.appOpenCustomerDetail('${s.customerId}')">${escapeHtml(s.customerId)}</span></td>
      <td>${escapeHtml(s.customerName)}</td>
      <td style="direction:ltr;text-align:right;font-family:monospace;font-size:13px;">${escapeHtml(s.customerPhone) || '—'}</td>
      <td><span class="platform-icon"><span class="platform-dot ${pClass}"></span>${escapeHtml(pLabel)}</span></td>
      <td>${escapeHtml(s.productName)}</td>
      <td><span style="color:${statusColor};font-weight:600;">${escapeHtml(s.status)}</span></td>
      <td style="direction:ltr;text-align:right;font-family:monospace;">${s.price > 0 ? formatNumber(s.price) : '—'}</td>
      <td style="direction:ltr;text-align:right;font-family:monospace;">${s.deposit > 0 ? formatNumber(s.deposit) : '—'}</td>
      <td style="direction:ltr;text-align:right;font-family:monospace;font-weight:600;${balanceClass}">${s.status === 'بیعانه' ? formatNumber(s.balance) : '—'}</td>
      <td style="font-size:12px;">${settlementHtml}</td>
    </tr>`
  }).join('')
}

export function renderSales() {
  const tbody = document.getElementById('salesBody')

  let allSales = getFilteredSales()

  allSales.sort((a, b) => {
    const aNum = a.settlementDate ? jalaliToNum(a.settlementDate) : 99999999
    const bNum = b.settlementDate ? jalaliToNum(b.settlementDate) : 99999999
    const aOverdue = aNum < getTodayJalaliNum() && a.settlementDate ? 0 : 1
    const bOverdue = bNum < getTodayJalaliNum() && b.settlementDate ? 0 : 1
    if (aOverdue !== bOverdue) return aOverdue - bOverdue
    return aNum - bNum
  })

  const totalSales = allSales
  const cashSales = totalSales.filter(s => s.status === 'تکمیل')
  const depositSales = totalSales.filter(s => s.status === 'بیعانه')

  const totalCash = cashSales.reduce((sum, s) => sum + s.price, 0)
  const totalDeposit = depositSales.reduce((sum, s) => sum + s.deposit, 0)
  const totalBalance = depositSales.reduce((sum, s) => sum + s.balance, 0)
  const totalAll = totalSales.reduce((sum, s) => sum + s.price, 0)

  document.getElementById('stat-sales-count').textContent = totalSales.length
  document.getElementById('stat-sales-cash').textContent = formatNumber(totalCash) + ' ریال'
  document.getElementById('stat-sales-deposit').textContent = formatNumber(totalDeposit) + ' ریال'
  document.getElementById('stat-sales-balance').textContent = formatNumber(totalBalance) + ' ریال'
  document.getElementById('stat-sales-total').textContent = formatNumber(totalAll) + ' ریال'

  if (allSales.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="10">
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
