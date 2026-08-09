import { getData, getPlatforms, coerceProductName, collapseDuplicateCustomersInCache } from './data.js'
import { getUsersSafe } from './auth.js'
import { loadGroupsData, buildGroupedAdvisorSelectHtml, phonesMatchingAdvisorFilter } from './groups.js'
import {
  toEnDigits, formatNumber, escapeHtml, escapeAttr, hasPermission, getCurrentUser,
  jalaliToNum, getTodayJalaliNum, jalaliAddDays, getTodayJalaliStr, jalaliDatePart,
  canViewScopedCustomer, canViewOrgWideData, getVisibleAdvisorPhones,
  formatSoldAt24h, matchesTabSearch, isAdmin,
  getPlatformLabels, getPlatformClass, PAYMENT_STATUS_LABELS, PAYMENT_STATUS,
  CUSTOMER_LEVELS, resolveCustomerLevel,
  ensureProductPayments, syncProductStatus, getApprovedPaid, getProductBalance,
  getWorstPaymentStatus, getLatestRejectReason, isProductCountableInSales,
  productHasRejectedPayment, getProductPayments, getPaymentEntryStatus,
  getCustomerPhones, getPrimaryPhone, getSaleRegistrantPhone,
  normalizePhone, userDisplayName, formatTeamFilterLabel,
  getCompletedSaleEconomics, isGiftSale, getProductRefundBadge
} from './utils.js'
import { paginateList, renderPaginationBar } from './pagination.js'
import { renderSalesTargetBand } from './dashboard.js'

// ============================================
// Sales Data
// ============================================

export function makeSaleRowKey(customerId, productIndex) {
  return `${customerId}::${productIndex}`
}

export function parseSaleRowKey(key) {
  const raw = String(key ?? '')
  const sep = raw.lastIndexOf('::')
  if (sep <= 0) return null
  const customerId = raw.slice(0, sep).trim()
  const productIndex = Number(raw.slice(sep + 2))
  if (!customerId || !Number.isInteger(productIndex) || productIndex < 0) return null
  return { customerId, productIndex }
}

export function getAllSales() {
  collapseDuplicateCustomersInCache()
  const data = getData()
  const sales = []
  const seenIds = new Set()
  data.customers.forEach(c => {
    const cid = String(c?.id || '').trim()
    if (!cid || seenIds.has(cid)) return
    seenIds.add(cid)
    if (c.products) {
      c.products.forEach((p, productIndex) => {
        ensureProductPayments(p)
        syncProductStatus(p)
        const price = parseFloat(p.price) || 0
        const deposit = getApprovedPaid(p)
        const balance = getProductBalance(p)
        const pays = getProductPayments(p)
        const lastPay = pays[pays.length - 1]
        const soldByPhone = getSaleRegistrantPhone(p, lastPay, c)
        sales.push({
          customerId: c.id,
          productIndex,
          customerName: c.name || c.platformId,
          customerPhone: getPrimaryPhone(c),
          customerPhones: getCustomerPhones(c),
          advisor: c.advisor || '',
          advisorPhone: soldByPhone,
          ownerAdvisor: c.advisor || '',
          ownerAdvisorPhone: normalizePhone(c.advisorPhone || ''),
          soldByPhone,
          platform: c.platform,
          productName: coerceProductName(p.name),
          status: p.status,
          price,
          deposit,
          balance,
          settlementDate: p.settlementDate || '',
          soldAt: lastPay?.soldAt || p.soldAt || '',
          depositorName: isGiftSale(p)
            ? 'هدیه'
            : (pays.length > 1
              ? `${pays.length} واریز`
              : (lastPay?.depositorName || p.depositorName || '')),
          paymentCount: pays.length,
          paymentStatus: getWorstPaymentStatus(p),
          paymentRejectReason: getLatestRejectReason(p),
          hasRejected: productHasRejectedPayment(p),
          countable: isProductCountableInSales(p),
          isGift: isGiftSale(p),
          refundBadge: getProductRefundBadge(p)
        })
      })
    }
  })
  return sales
}

// ============================================
// Render Sales
// ============================================

export function getSalesDateFilter() {
  const dateFrom = document.getElementById('filterSalesDateFrom')?.value.trim() || ''
  const dateTo = document.getElementById('filterSalesDateTo')?.value.trim() || ''
  return {
    dateFrom,
    dateTo,
    hasDateFilter: !!(dateFrom || dateTo),
    fromNum: dateFrom ? jalaliToNum(dateFrom) : 0,
    toNum: dateTo ? jalaliToNum(dateTo) : 99999999
  }
}

function isPaymentInSalesDateRange(pay, dateFilter) {
  if (!dateFilter.hasDateFilter) return true
  const d = jalaliDatePart(pay.soldAt)
  if (!d) return false
  const n = jalaliToNum(d)
  return n >= dateFilter.fromNum && n <= dateFilter.toNum
}

function getApprovedPaymentsInRange(product, dateFilter) {
  return getProductPayments(product).filter(pay => {
    const amount = parseFloat(pay.amount) || 0
    if (amount <= 0) return false
    if (getPaymentEntryStatus(pay) !== PAYMENT_STATUS.approved) return false
    return isPaymentInSalesDateRange(pay, dateFilter)
  })
}

function sumPayments(pays) {
  return pays.reduce((sum, pay) => sum + (parseFloat(pay.amount) || 0), 0)
}

export function getFilteredSales() {
  const search = toEnDigits(document.getElementById('searchSales')?.value || '').toLowerCase()
  const platformFilter = document.getElementById('filterSalesPlatform')?.value || ''
  const advisorFilter = document.getElementById('filterSalesAdvisor')?.value || ''
  const levelFilter = document.getElementById('filterSalesLevel')?.value || ''
  const statusFilter = document.getElementById('filterSalesStatus')?.value || ''
  const payStatusFilter = document.getElementById('filterSalesPaymentStatus')?.value || ''
  const dateFilter = getSalesDateFilter()
  let allSales = getAllSales()

  const currentUser = getCurrentUser()
  const data = getData()

  if (search) {
    allSales = allSales.filter(s =>
      matchesTabSearch(search, [
        s.customerId,
        s.customerName,
        s.customerPhone,
        ...(s.customerPhones || []),
        s.advisor,
        s.productName,
        s.depositorName,
        s.status,
        s.settlementDate,
        s.soldAt
      ])
    )
  }

  allSales = allSales.filter(s => {
    if (s.customerId.startsWith('LD') && !hasPermission('customers_ld')) return false
    if (s.customerId.startsWith('CS') && !hasPermission('customers_cs')) return false
    const customer = data.customers.find(c => c.id === s.customerId)
    const product = customer?.products?.[s.productIndex]
    const myPhone = normalizePhone(currentUser?.phone || '')
    const registeredByMe = !!(myPhone && (
      s.soldByPhone === myPhone ||
      (product && getProductPayments(product).some(pay => normalizePhone(pay.soldByPhone) === myPhone))
    ))
    if (!canViewScopedCustomer(customer, currentUser) && !registeredByMe) return false
    if (platformFilter && s.platform !== platformFilter) return false
    if (statusFilter && s.status !== statusFilter) return false
    if (payStatusFilter === 'gift') {
      if (!s.isGift) return false
    } else if (payStatusFilter && s.paymentStatus !== payStatusFilter) return false
    if (levelFilter && customer) {
      const resolved = resolveCustomerLevel(customer, data.customers, data.followups)
      if (resolved !== levelFilter) return false
    }

    const advisorScopePhones = phonesMatchingAdvisorFilter(advisorFilter, currentUser)
    const matchesAdvisorPhone = (phone) => {
      if (!advisorScopePhones) return true
      const p = normalizePhone(phone)
      return !!(p && advisorScopePhones.has(p))
    }

    if (dateFilter.hasDateFilter) {
      if (!product) return false
      if (isGiftSale(product) || s.isGift) {
        const d = jalaliDatePart(product.soldAt || s.soldAt)
        if (!d) return false
        const n = jalaliToNum(d)
        if (n < dateFilter.fromNum || n > dateFilter.toNum) return false
        if (advisorScopePhones && !matchesAdvisorPhone(s.soldByPhone)) return false
        s.dateFiltered = true
        return true
      }
      ensureProductPayments(product)
      let paysInRange = getApprovedPaymentsInRange(product, dateFilter)
      if (advisorScopePhones) {
        paysInRange = paysInRange.filter(pay =>
          matchesAdvisorPhone(getSaleRegistrantPhone(product, pay, customer))
        )
      }
      if (!paysInRange.length) return false
      const paidInRange = sumPayments(paysInRange)
      const lastInRange = paysInRange[paysInRange.length - 1]
      s.deposit = paidInRange
      s.balance = Math.max(0, (parseFloat(product.price) || 0) - getApprovedPaid(product))
      s.soldAt = lastInRange?.soldAt || ''
      s.depositorName = paysInRange.length > 1
        ? `${paysInRange.length} واریز`
        : (lastInRange?.depositorName || '')
      s.paymentCount = paysInRange.length
      s.paymentStatus = getWorstPaymentStatus({ payments: paysInRange })
      s.hasRejected = productHasRejectedPayment({ payments: paysInRange })
      s.dateFiltered = true
      s.soldByPhone = getSaleRegistrantPhone(product, lastInRange, customer)
      s.advisorPhone = s.soldByPhone
    } else if (advisorScopePhones) {
      if (s.isGift) {
        if (!matchesAdvisorPhone(s.soldByPhone)) return false
      } else {
        const sellerMatch = matchesAdvisorPhone(s.soldByPhone) ||
          (product && getProductPayments(product).some(pay =>
            matchesAdvisorPhone(getSaleRegistrantPhone(product, pay, customer))
          ))
        if (!sellerMatch) return false
        if (product && advisorScopePhones.size === 1) {
          const only = [...advisorScopePhones][0]
          if (s.soldByPhone !== only) {
            s.soldByPhone = only
            s.advisorPhone = only
          }
        }
      }
    }

    return true
  })

  return allSales
}

function renderSalesRows(allSales) {
  const todayNum = getTodayJalaliNum()
  const showSelectCol = hasPermission('customers_add')
  return allSales.map(s => {
    const pClass = getPlatformClass(s.platform)
    const pLabel = getPlatformLabels()[s.platform] || s.platform
    const statusColor = s.isGift
      ? 'var(--primary, #2563eb)'
      : (s.status === 'تکمیل' ? 'var(--success)' : 'var(--warning)')
    const balanceClass = s.balance > 0 ? 'color:var(--danger);' : ''
    const saleKey = makeSaleRowKey(s.customerId, s.productIndex)
    const selectCell = showSelectCol
      ? `<td><input type="checkbox" data-id="${escapeAttr(saleKey)}" onchange="app.toggleRowSelect('sales', '${escapeAttr(saleKey)}', this.checked)"></td>`
      : ''

    let settlementHtml = '—'
    let rowClass = s.isGift ? 'gift-row' : ''
    if (s.isGift) {
      settlementHtml = '<span class="gift-badge">هدیه</span>'
    } else if (s.status === 'تکمیل') {
      settlementHtml = '<span class="settlement-badge settlement-ok-badge">تسویه شد</span>'
    } else if (s.settlementDate) {
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

    if (s.hasRejected) {
      rowClass = (rowClass + ' payment-rejected-row').trim()
    }

    const payLabel = PAYMENT_STATUS_LABELS[s.paymentStatus] || s.paymentStatus
    let paymentHtml = `<span class="payment-badge payment-${s.paymentStatus}">${escapeHtml(payLabel)}</span>`
    if (s.isGift) {
      paymentHtml = `<span class="gift-badge">هدیه</span> ${paymentHtml}`
    } else if (s.paymentCount > 1) {
      paymentHtml += `<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${s.paymentCount} واریز</div>`
    }
    if (s.hasRejected && s.paymentRejectReason) {
      paymentHtml += `<div class="payment-reject-reason" title="${escapeAttr(s.paymentRejectReason)}">${escapeHtml(s.paymentRejectReason)}</div>`
    }
    if (s.refundBadge) {
      paymentHtml += ` <span class="refund-badge${s.refundBadge.kind === 'partial' ? ' is-partial' : ''}">${escapeHtml(s.refundBadge.label)}</span>`
    }

    return `<tr class="clickable-row ${rowClass}" onclick="app.onCustomerRowClick(event, '${escapeAttr(s.customerId)}')">
      ${selectCell}
      <td class="truncate-cell" title="${escapeAttr(s.customerName)}">${escapeHtml(s.customerName)}</td>
      <td style="direction:ltr;text-align:right;font-family:'Vazirmatn',sans-serif;font-size:13px;">${(() => {
        const phones = s.customerPhones || (s.customerPhone ? [s.customerPhone] : [])
        if (!phones.length) return '—'
        const extra = phones.length > 1
          ? ` <span style="color:var(--text-muted);font-size:11px;" title="${escapeAttr(phones.slice(1).join('، '))}">+${phones.length - 1}</span>`
          : ''
        return `${escapeHtml(phones[0])}${extra}`
      })()}</td>
      <td style="font-size:12px;">${escapeHtml(s.advisor) || '—'}</td>
      <td><span class="platform-icon"><span class="platform-dot ${pClass}"></span>${escapeHtml(pLabel)}</span></td>
      <td>${escapeHtml(s.productName)}${s.isGift ? ' <span class="gift-badge">هدیه</span>' : ''}${s.refundBadge ? ` <span class="refund-badge${s.refundBadge.kind === 'partial' ? ' is-partial' : ''}">${escapeHtml(s.refundBadge.label)}</span>` : ''}</td>
      <td><span style="color:${statusColor};font-weight:600;">${escapeHtml(s.status)}</span></td>
      <td style="direction:ltr;text-align:right;font-family:'Vazirmatn',sans-serif;">${s.isGift ? '<span class="gift-badge">۰</span>' : (s.price > 0 ? formatNumber(s.price) + ' ریال' : '—')}</td>
      <td style="direction:ltr;text-align:right;font-family:'Vazirmatn',sans-serif;">${s.isGift ? '—' : (s.deposit > 0 ? formatNumber(s.deposit) + ' ریال' : '—')}</td>
      <td style="direction:ltr;text-align:right;font-family:'Vazirmatn',sans-serif;font-weight:600;${balanceClass}">${s.isGift ? '—' : (s.status === 'بیعانه' ? formatNumber(s.balance) + ' ریال' : '—')}</td>
      <td style="font-size:12px;">${settlementHtml}</td>
      <td style="font-family:'Vazirmatn',sans-serif;font-size:12px;direction:ltr;text-align:right;">${escapeHtml(formatSoldAt24h(s.soldAt)) || '—'}</td>
      <td>${escapeHtml(s.depositorName) || '—'}</td>
      <td>${paymentHtml}</td>
    </tr>`
  }).join('')
}

function populateSalesFilterDropdowns() {
  const pSel = document.getElementById('filterSalesPlatform')
  if (pSel) {
    const val = pSel.value
    pSel.innerHTML = '<option value="">همه پلتفرم‌ها</option>' +
      getPlatforms().map(p => `<option value="${escapeAttr(p.key)}">${escapeHtml(p.label)}</option>`).join('')
    pSel.value = val
  }
  const lSel = document.getElementById('filterSalesLevel')
  if (lSel) {
    const val = lSel.value
    lSel.innerHTML = '<option value="">همه سطوح</option>' +
      Object.values(CUSTOMER_LEVELS).map(l => `<option value="${escapeAttr(l.key)}">${l.emoji} ${escapeHtml(l.label)}</option>`).join('')
    lSel.value = val
  }
  const statusSel = document.getElementById('filterSalesStatus')
  if (statusSel) {
    const val = statusSel.value
    statusSel.innerHTML = '<option value="">همه وضعیت‌ها</option>' +
      ['تکمیل', 'بیعانه', 'هدیه'].map(s => `<option value="${escapeAttr(s)}">${escapeHtml(s)}</option>`).join('')
    statusSel.value = val
  }
  const sSel = document.getElementById('filterSalesPaymentStatus')
  if (sSel) {
    const val = sSel.value
    sSel.innerHTML = '<option value="">همه وضعیت‌های واریزی</option>' +
      Object.entries(PAYMENT_STATUS_LABELS).map(([k, v]) => `<option value="${escapeAttr(k)}">${escapeHtml(v)}</option>`).join('') +
      '<option value="gift">فقط هدایا</option>'
    sSel.value = val
  }
  updateSalesAdvisorFilter()
}

async function updateSalesAdvisorFilter() {
  const sel = document.getElementById('filterSalesAdvisor')
  if (!sel) return

  const currentUser = getCurrentUser()
  const currentVal = sel.value
  const users = await getUsersSafe()
  try { await loadGroupsData() } catch (_) { /* optional */ }

  let allowedPhones = null
  if (!canViewOrgWideData(currentUser)) {
    const visible = getVisibleAdvisorPhones(currentUser)
    if (visible.size <= 1) {
      sel.style.display = 'none'
      sel.value = ''
      return
    }
    allowedPhones = visible
  }

  sel.style.display = ''
  sel.innerHTML = buildGroupedAdvisorSelectHtml({
    users,
    selectedValue: currentVal,
    teamLabel: canViewOrgWideData(currentUser) ? null : formatTeamFilterLabel(currentUser),
    allowedPhones
  })
  if (![...sel.options].some(o => o.value === currentVal)) sel.value = ''
  else sel.value = currentVal
}

export async function renderSales() {
  const tbody = document.getElementById('salesBody')
  const search = toEnDigits(document.getElementById('searchSales')?.value || '').toLowerCase()

  populateSalesFilterDropdowns()

  let allSales = getFilteredSales()

  try {
    const users = await getUsersSafe()
    const nameByPhone = new Map(
      users.filter(u => u.phone).map(u => [normalizePhone(u.phone), userDisplayName(u)])
    )
    allSales.forEach(s => {
      const phone = s.soldByPhone || s.advisorPhone
      s.advisor = nameByPhone.get(phone) || s.ownerAdvisor || s.advisor || '—'
    })
  } catch (_) { /* keep fallback advisor names */ }

  if (salesSortState.field) {
    allSales.sort((a, b) => {
      let va = a[salesSortState.field], vb = b[salesSortState.field]
      if (salesSortState.field === 'settlementDate') {
        va = jalaliToNum(va)
        vb = jalaliToNum(vb)
      }
      if (typeof va === 'number') return salesSortState.asc ? va - vb : vb - va
      return salesSortState.asc ? String(va).localeCompare(String(vb), 'fa') : String(vb).localeCompare(String(va), 'fa')
    })
  } else {
    // Newest payment/sale datetime first (Jalali date + 24h time)
    allSales.sort((a, b) => {
      const ka = formatSoldAt24h(a.soldAt) || ''
      const kb = formatSoldAt24h(b.soldAt) || ''
      if (!ka && !kb) return 0
      if (!ka) return 1
      if (!kb) return -1
      return kb.localeCompare(ka, 'en')
    })
  }

  const countable = allSales.filter(s => s.countable)
  const dateFilter = getSalesDateFilter()
  const cashSales = countable.filter(s => s.status === 'تکمیل')
  const depositSales = countable.filter(s => s.status === 'بیعانه')
  const data = getData()

  function grossProfitForCompleted(s) {
    const customer = data.customers.find(c => c.id === s.customerId)
    const product = customer?.products?.[s.productIndex]
    if (!product || product.status !== 'تکمیل') return 0
    if (dateFilter.hasDateFilter) {
      const pays = getApprovedPaymentsInRange(product, dateFilter)
      if (!pays.length) return 0
    }
    return getCompletedSaleEconomics(product).grossProfit
  }

  function depositAmountForSale(s) {
    const customer = data.customers.find(c => c.id === s.customerId)
    const product = customer?.products?.[s.productIndex]
    if (!product) return s.deposit || 0
    if (dateFilter.hasDateFilter) {
      return sumPayments(getApprovedPaymentsInRange(product, dateFilter))
    }
    return getApprovedPaid(product)
  }

  const totalCash = cashSales.reduce((sum, s) => sum + grossProfitForCompleted(s), 0)
  const totalDeposit = depositSales.reduce((sum, s) => sum + depositAmountForSale(s), 0)
  const totalBalance = depositSales.reduce((sum, s) => sum + (s.balance || 0), 0)
  const totalAll = totalCash + totalDeposit

  document.getElementById('stat-sales-count').textContent = countable.length
  document.getElementById('stat-sales-cash').textContent = formatNumber(totalCash) + ' ریال'
  document.getElementById('stat-sales-deposit').textContent = formatNumber(totalDeposit) + ' ریال'
  document.getElementById('stat-sales-balance').textContent = formatNumber(totalBalance) + ' ریال'
  document.getElementById('stat-sales-total').textContent = formatNumber(totalAll) + ' ریال'

  try { renderSalesTargetBand() } catch (e) { console.error('renderSalesTargetBand error:', e) }

  const startSaleBtn = document.getElementById('startSaleBtn')
  if (startSaleBtn) {
    const canStart = isAdmin() || hasPermission('customers_add') || hasPermission('sales_add_others')
    startSaleBtn.style.display = canStart ? '' : 'none'
  }

  if (allSales.length === 0) {
    const colCount = hasPermission('customers_add') ? 14 : 13
    tbody.innerHTML = `
      <tr><td colspan="${colCount}">
        <div class="empty-state">
          <div class="icon">🛒</div>
          <h3>فروشی ثبت نشده</h3>
          <p>با دکمه «+ ثبت فروش» یک فروش جدید ثبت کنید</p>
        </div>
      </td></tr>`
    renderPaginationBar('salesPagination', 'sales', { total: 0, from: 0, to: 0, page: 1, totalPages: 1 })
    return
  }

  const page = paginateList('sales', allSales, search)
  tbody.innerHTML = renderSalesRows(page.items)
  renderPaginationBar('salesPagination', 'sales', page)
}

let salesSortState = { field: null, asc: true }

export function sortSales(field) {
  if (salesSortState.field === field) salesSortState.asc = !salesSortState.asc
  else { salesSortState.field = field; salesSortState.asc = true }
  renderSales()
}

