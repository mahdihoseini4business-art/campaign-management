import { getData, getPlatforms, getCustomerCodes, coerceProductName, collapseDuplicateCustomersInCache } from './data.js'
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
  getCompletedSaleEconomics, isGiftSale, isHistoricalImportSale, getProductRefundBadge, isDealCancelled,
  getCurrentJalaliMonthDateRange, isEmptySaleProductDraft
} from './utils.js'
import { paginateList, renderPaginationBar } from './pagination.js'
import { toggleSortField, sortRecords, syncSortHeaders, sortSig, compareSortValues } from './table-sort.js'
import { renderSalesTargetBand } from './dashboard.js'
import { runWithSearchOverlay, SEARCH_HOST } from './search-overlay.js'
import { debouncedSearchInput } from './search-debounce.js'
import {
  getCustomersById,
  getAllSalesFromCache,
  setAllSalesCache,
  getReferralCountForCustomer
} from './derived-cache.js'
import { shouldSkipTabRender, markTabRendered, tabPageKey } from './tab-cache.js'
import { getPage } from './pagination.js'

let salesSortState = { field: null, asc: true }

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
  const cached = getAllSalesFromCache()
  if (cached) return cached

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
        if (isEmptySaleProductDraft(p)) return
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
          isHistorical: isHistoricalImportSale(p),
          refundBadge: getProductRefundBadge(p),
          customerCode: c.customerCode || ''
        })
      })
    }
  })
  setAllSalesCache(sales)
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

/** Stats default to current Jalali month unless the user set a date filter. */
export function getSalesStatsDateFilter() {
  const filter = getSalesDateFilter()
  if (filter.hasDateFilter) return filter
  const month = getCurrentJalaliMonthDateRange()
  return {
    dateFrom: month.from,
    dateTo: month.to,
    hasDateFilter: true,
    fromNum: month.fromNum,
    toNum: month.toNum,
    isDefaultMonth: true
  }
}

function isPaymentInSalesDateRange(pay, dateFilter) {
  if (!dateFilter.hasDateFilter) return true
  const d = jalaliDatePart(pay.soldAt)
  if (!d) return false
  const n = jalaliToNum(d)
  return n >= dateFilter.fromNum && n <= dateFilter.toNum
}

function getPaymentsInSalesDateRange(product, dateFilter) {
  return getProductPayments(product).filter(pay => {
    const amount = parseFloat(pay.amount) || 0
    if (amount <= 0) return false
    return isPaymentInSalesDateRange(pay, dateFilter)
  })
}

function getApprovedPaymentsInRange(product, dateFilter) {
  return getPaymentsInSalesDateRange(product, dateFilter).filter(pay =>
    getPaymentEntryStatus(pay) === PAYMENT_STATUS.approved
  )
}

function sumPayments(pays) {
  return pays.reduce((sum, pay) => sum + (parseFloat(pay.amount) || 0), 0)
}

export function getFilteredSales(dateFilterOverride = null) {
  const search = toEnDigits(document.getElementById('searchSales')?.value || '').toLowerCase()
  const platformFilter = document.getElementById('filterSalesPlatform')?.value || ''
  const advisorFilter = document.getElementById('filterSalesAdvisor')?.value || ''
  const levelFilter = document.getElementById('filterSalesLevel')?.value || ''
  const codeFilter = document.getElementById('filterSalesCustomerCode')?.value || ''
  const statusFilter = document.getElementById('filterSalesStatus')?.value || ''
  const payStatusFilter = document.getElementById('filterSalesPaymentStatus')?.value || ''
  const dateFilter = dateFilterOverride || getSalesDateFilter()
  let allSales = getAllSales()

  const currentUser = getCurrentUser()
  const customersById = getCustomersById()
  const advisorScopePhones = advisorFilter
    ? phonesMatchingAdvisorFilter(advisorFilter, currentUser)
    : null

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
    const customer = customersById.get(s.customerId)
    const product = customer?.products?.[s.productIndex]
    const myPhone = normalizePhone(currentUser?.phone || '')
    const registeredByMe = !!(myPhone && (
      s.soldByPhone === myPhone ||
      (product && getProductPayments(product).some(pay => normalizePhone(pay.soldByPhone) === myPhone))
    ))
    if (!canViewScopedCustomer(customer, currentUser, 'sales') && !registeredByMe) return false
    if (platformFilter && s.platform !== platformFilter) return false
    if (statusFilter && s.status !== statusFilter) return false
    // Without a date scope, match product-level worst payment status.
    // With a date scope, status is applied to payments inside the range (below).
    if (payStatusFilter === 'gift') {
      if (!s.isGift) return false
    } else if (payStatusFilter && !dateFilter.hasDateFilter && s.paymentStatus !== payStatusFilter) {
      return false
    }
    if (levelFilter && customer) {
      const resolved = resolveCustomerLevel(
        customer,
        null,
        getData().followups,
        getReferralCountForCustomer(customer.id)
      )
      if (resolved !== levelFilter) return false
    }
    if (codeFilter) {
      const code = (customer?.customerCode || s.customerCode || '')
      if (code !== codeFilter) return false
    }

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
        if (payStatusFilter && payStatusFilter !== 'gift' && s.paymentStatus !== payStatusFilter) {
          return false
        }
        s.dateFiltered = true
        return true
      }
      ensureProductPayments(product)
      let paysInRange = getPaymentsInSalesDateRange(product, dateFilter)
      if (advisorScopePhones) {
        paysInRange = paysInRange.filter(pay =>
          matchesAdvisorPhone(getSaleRegistrantPhone(product, pay, customer))
        )
      }
      if (payStatusFilter && payStatusFilter !== 'gift') {
        paysInRange = paysInRange.filter(pay => getPaymentEntryStatus(pay) === payStatusFilter)
      } else {
        // Default date view = revenue: only approved deposits in range
        paysInRange = paysInRange.filter(pay => getPaymentEntryStatus(pay) === PAYMENT_STATUS.approved)
      }
      if (!paysInRange.length) return false
      const paidInRange = sumPayments(paysInRange)
      const lastInRange = paysInRange[paysInRange.length - 1]
      s.deposit = paidInRange
      s.balance = isDealCancelled(product)
        ? 0
        : Math.max(0, (parseFloat(product.price) || 0) - getApprovedPaid(product))
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
      if (dateNum > 0 && dateNum < todayNum) {
        settlementHtml = `<span class="settlement-badge settlement-overdue-badge">⚠ ${s.settlementDate}</span>`
        rowClass = 'settlement-overdue'
      } else if (dateNum === todayNum) {
        // Today due: same light-yellow row as overdue so it stands out in the list
        settlementHtml = `<span class="settlement-badge settlement-today-badge">${s.settlementDate}</span>`
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
      <td>${escapeHtml(s.productName)}${s.isGift ? ' <span class="gift-badge">هدیه</span>' : ''}${s.isHistorical ? ' <span class="historical-badge">تاریخی</span>' : ''}${s.refundBadge ? ` <span class="refund-badge${s.refundBadge.kind === 'partial' ? ' is-partial' : ''}">${escapeHtml(s.refundBadge.label)}</span>` : ''}</td>
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
  const codeSel = document.getElementById('filterSalesCustomerCode')
  if (codeSel) {
    const val = codeSel.value
    codeSel.innerHTML = '<option value="">همه کدها</option>' +
      getCustomerCodes().map(c => `<option value="${escapeAttr(c.key)}">${escapeHtml(c.label)}</option>`).join('')
    codeSel.value = val
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
  if (!canViewOrgWideData('sales', currentUser)) {
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
    teamLabel: canViewOrgWideData('sales', currentUser) ? null : formatTeamFilterLabel(currentUser),
    allowedPhones
  })
  if (![...sel.options].some(o => o.value === currentVal)) sel.value = ''
  else sel.value = currentVal
}

export function onSalesSearchInput() {
  debouncedSearchInput(SEARCH_HOST.sales, () => renderSales())
}

export async function renderSales() {
  const tbody = document.getElementById('salesBody')
  const search = toEnDigits(document.getElementById('searchSales')?.value || '').toLowerCase()
  const cacheKey = `${search}|${sortSig(salesSortState)}|${tabPageKey('sales', getPage('sales'))}`
  if (shouldSkipTabRender('sales', cacheKey)) return

  populateSalesFilterDropdowns()

  let allSales = getFilteredSales()
  const customersById = getCustomersById()

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
    allSales = sortRecords(allSales, salesSortState, salesSortValue)
  } else {
    // Default: rejected → due settlement (past then today) → newest sales
    const todayNum = getTodayJalaliNum()
    allSales = [...allSales].sort((a, b) => compareDefaultSalesOrder(a, b, todayNum))
  }

  const userDateFilter = getSalesDateFilter()
  const statsDateFilter = getSalesStatsDateFilter()
  // Stats: current month by default; table stays unscoped until user sets a date filter
  const statsSales = userDateFilter.hasDateFilter
    ? allSales
    : getFilteredSales(statsDateFilter)

  const countable = statsSales.filter(s => s.countable)
  const cashSales = countable.filter(s => s.status === 'تکمیل')

  function productForSale(s) {
    return customersById.get(s.customerId)?.products?.[s.productIndex]
  }

  // Open deposits only — refund-cancelled deals are locked and must not inflate بیعانه/مانده
  const depositSales = countable.filter(s => {
    if (s.status !== 'بیعانه') return false
    const product = productForSale(s)
    return !product || !isDealCancelled(product)
  })

  function grossProfitForCompleted(s) {
    const product = productForSale(s)
    if (!product || product.status !== 'تکمیل') return 0
    if (statsDateFilter.hasDateFilter) {
      const pays = getApprovedPaymentsInRange(product, statsDateFilter)
      if (!pays.length) return 0
    }
    return getCompletedSaleEconomics(product).grossProfit
  }

  function depositAmountForSale(s) {
    const product = productForSale(s)
    if (!product) return s.deposit || 0
    if (statsDateFilter.hasDateFilter) {
      return sumPayments(getApprovedPaymentsInRange(product, statsDateFilter))
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
    syncSortHeaders('#sheet-sales', salesSortState)
    return
  }

  const page = paginateList('sales', allSales, `${search}|${sortSig(salesSortState)}`)
  tbody.innerHTML = renderSalesRows(page.items)
  renderPaginationBar('salesPagination', 'sales', page)
  syncSortHeaders('#sheet-sales', salesSortState)
  markTabRendered('sales', cacheKey)
}

function salesSortValue(s, field) {
  if (field === 'settlementDate') return { value: s.settlementDate || '', type: 'date' }
  if (field === 'soldAt') return { value: s.soldAt || '', type: 'datetime' }
  if (field === 'price' || field === 'deposit' || field === 'balance') {
    return { value: s[field] || 0, type: 'number' }
  }
  return { value: s[field] ?? '', type: 'text' }
}

/** 0 = rejected, 1 = settlement due (today or past), 2 = normal */
function salesAttentionTier(s, todayNum = getTodayJalaliNum()) {
  if (s.hasRejected) return 0
  if (s.status === 'بیعانه' && s.settlementDate) {
    const n = jalaliToNum(s.settlementDate)
    if (n > 0 && n <= todayNum) return 1
  }
  return 2
}

function compareSoldAtDesc(a, b) {
  return compareSortValues(a.soldAt || '', b.soldAt || '', 'datetime') * -1
}

/**
 * Default sales order (when no column sort is active):
 * 1) accounting-rejected payments
 * 2) بیعانه with settlement today or past (past dates before today)
 * 3) remaining sales, newest payment/sale first
 */
function compareDefaultSalesOrder(a, b, todayNum = getTodayJalaliNum()) {
  const tierA = salesAttentionTier(a, todayNum)
  const tierB = salesAttentionTier(b, todayNum)
  if (tierA !== tierB) return tierA - tierB

  if (tierA === 1) {
    const dateA = jalaliToNum(a.settlementDate)
    const dateB = jalaliToNum(b.settlementDate)
    if (dateA !== dateB) return dateA - dateB
  }

  return compareSoldAtDesc(a, b)
}

export function sortSales(field) {
  toggleSortField(salesSortState, field)
  renderSales()
}

