import { getData, saveCustomerToDB, coerceProductName, isGiftSaleLine, getDestinationBanks, collapseDuplicateCustomersInCache } from './data.js'
import { getUsersSafe } from './auth.js'
import {
  toEnDigits, formatNumber, escapeHtml, escapeAttr, showToast, hasPermission,
  requirePermission, getCurrentUser, normalizePhone, getNowJalaliDateTime,
  ensureProductPayments, syncProductStatus, getPaymentEntryStatus,
  PAYMENT_STATUS, PAYMENT_STATUS_LABELS, formatSoldAt24h, matchesTabSearch,
  getCustomerPhones, getPrimaryPhone, getSaleRegistrantPhone,
  isGiftSale, getGiftAccountingStatus, getShipmentStatus, SHIPMENT_STATUS,
  getCurrentJalaliMonthInfo, isInJalaliMonth, userDisplayName
} from './utils.js'
import { paginateList, renderPaginationBar } from './pagination.js'
import { toggleSortField, sortRecords, syncSortHeaders, sortSig } from './table-sort.js'
import { renderSales } from './sales.js'
import { renderProducts } from './customers.js'
import { broadcastPaymentRejectToast } from './sale-toasts.js'
import { runWithSearchOverlay, SEARCH_HOST } from './search-overlay.js'

let accountingFilter = 'pending' // pending | approved | rejected | gifts
let accountingSortState = { field: null, asc: true }
let rejectTarget = null // { customerId, productIndex, paymentIndex, isGift, mode }
/** Destination-bank balances accordion (collapsed by default). */
let bankBalancesExpanded = false

export const PRESET_REJECT_REASONS = [
  'رسید فیک',
  'ساعت و تاریخ اشتباه',
  'نام مشتری درست وارد نشده',
  'عدم وجود تراکنش در گردش حساب',
  'بانک مقصد اشتباه',
  'رسید مربوط به مشتری دیگری است',
  'مبلغ اشتباه',
  'نام کارت مبدا اشتباه'
]

export function getAllPayments() {
  collapseDuplicateCustomersInCache()
  const data = getData()
  const payments = []
  const seenIds = new Set()
  data.customers.forEach(c => {
    const cid = String(c?.id || '').trim()
    if (!cid || seenIds.has(cid)) return
    seenIds.add(cid)
    ;(c.products || []).forEach((product, productIndex) => {
      if (isGiftSale(product) || isGiftSaleLine(product)) {
        syncProductStatus(product)
        const giftStatus = getGiftAccountingStatus(product)
        const soldByPhone = getSaleRegistrantPhone(product, null, c)
        payments.push({
          customerId: c.id,
          productIndex,
          paymentIndex: -1,
          isGift: true,
          customerName: c.name || c.platformId || c.id,
          customerPhone: getPrimaryPhone(c),
          customerPhones: getCustomerPhones(c),
          advisor: c.advisor || '',
          advisorPhone: soldByPhone,
          soldByPhone,
          ownerAdvisor: c.advisor || '',
          productName: coerceProductName(product.name),
          productStatus: 'هدیه',
          amount: 0,
          soldAt: product.soldAt || '',
          depositorName: '',
          destinationBank: '',
          paymentStatus: giftStatus,
          paymentRejectReason: product.giftRejectReason || '',
          paymentReviewedAt: product.giftReviewedAt || '',
          paymentReviewedBy: product.giftReviewedBy || ''
        })
        return
      }
      ensureProductPayments(product)
      syncProductStatus(product)
      ;(product.payments || []).forEach((pay, paymentIndex) => {
        const amount = parseFloat(pay.amount) || 0
        if (amount <= 0) return
        const soldByPhone = getSaleRegistrantPhone(product, pay, c)
        payments.push({
          customerId: c.id,
          productIndex,
          paymentIndex,
          isGift: false,
          customerName: c.name || c.platformId || c.id,
          customerPhone: getPrimaryPhone(c),
          customerPhones: getCustomerPhones(c),
          advisor: c.advisor || '',
          advisorPhone: soldByPhone,
          soldByPhone,
          ownerAdvisor: c.advisor || '',
          productName: coerceProductName(product.name),
          productStatus: product.status || '',
          amount,
          soldAt: pay.soldAt || '',
          depositorName: pay.depositorName || '',
          destinationBank: pay.destinationBank || '',
          paymentStatus: getPaymentEntryStatus(pay),
          paymentRejectReason: pay.paymentRejectReason || '',
          paymentReviewedAt: pay.paymentReviewedAt || '',
          paymentReviewedBy: pay.paymentReviewedBy || ''
        })
      })
    })
  })
  return payments
}

export function setAccountingFilter(filter) {
  if (!requirePermission('accounting')) return
  accountingFilter = filter
  document.querySelectorAll('.accounting-filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter)
  })
  renderAccounting()
}

/** Monthly approved deposits per destination bank (resets each Jalali month). */
function renderAccountingBankBalances(allPayments) {
  const wrap = document.getElementById('accountingBankBalances')
  if (!wrap) return

  const month = getCurrentJalaliMonthInfo()
  const configured = getDestinationBanks()
  const totals = new Map()
  for (const bank of configured) totals.set(bank, 0)

  for (const p of allPayments || []) {
    if (p.isGift) continue
    if (p.paymentStatus !== PAYMENT_STATUS.approved) continue
    const amount = parseFloat(p.amount) || 0
    if (amount <= 0) continue
    if (!isInJalaliMonth(p.soldAt, month.prefix)) continue
    const bank = String(p.destinationBank || '').trim() || 'نامشخص'
    totals.set(bank, (totals.get(bank) || 0) + amount)
  }

  const rows = []
  const seen = new Set()
  for (const bank of configured) {
    rows.push({ bank, amount: totals.get(bank) || 0 })
    seen.add(bank)
  }
  for (const [bank, amount] of totals.entries()) {
    if (seen.has(bank)) continue
    rows.push({ bank, amount })
  }

  const monthTotal = rows.reduce((s, r) => s + (r.amount || 0), 0)
  const collapsed = !bankBalancesExpanded
  const bodyInner = !rows.length
    ? `<div class="accounting-bank-balances-empty">بانک مقصدی در تنظیمات تعریف نشده است</div>`
    : `<div class="accounting-bank-balances-grid">
        ${rows.map(r => `
          <div class="stat-card accounting-bank-card">
            <div class="label">${escapeHtml(r.bank)}</div>
            <div class="value" style="color:var(--accent);font-size:18px;direction:ltr;">${formatNumber(r.amount)} <span style="font-size:12px;font-weight:600;">ریال</span></div>
          </div>
        `).join('')}
      </div>`

  wrap.classList.toggle('is-collapsed', collapsed)
  wrap.innerHTML = `
    <button type="button" class="accounting-bank-balances-toggle" onclick="app.toggleAccountingBankBalances()" aria-expanded="${collapsed ? 'false' : 'true'}">
      <span class="accounting-bank-balances-chevron" aria-hidden="true">▼</span>
      <span class="accounting-bank-balances-toggle-main">
        <span class="accounting-bank-balances-title">بانک‌های مقصد · ${escapeHtml(month.label)}</span>
        <span class="accounting-bank-balances-note">واریزهای تأییدشده این ماه · از اول ماه شمسی صفر می‌شود</span>
      </span>
      <span class="accounting-bank-balances-toggle-meta" style="direction:ltr;">${formatNumber(monthTotal)} ریال</span>
    </button>
    <div class="accounting-bank-balances-body">
      <div class="accounting-bank-balances-body-inner">${bodyInner}</div>
    </div>`
}

export function toggleAccountingBankBalances() {
  bankBalancesExpanded = !bankBalancesExpanded
  const wrap = document.getElementById('accountingBankBalances')
  if (!wrap) return
  wrap.classList.toggle('is-collapsed', !bankBalancesExpanded)
  const btn = wrap.querySelector('.accounting-bank-balances-toggle')
  if (btn) btn.setAttribute('aria-expanded', bankBalancesExpanded ? 'true' : 'false')
}

export function onAccountingSearchInput() {
  return runWithSearchOverlay(SEARCH_HOST.accounting, () => renderAccounting())
}

export async function renderAccounting() {
  const tbody = document.getElementById('accountingBody')
  if (!tbody) return
  if (!hasPermission('accounting')) {
    tbody.innerHTML = `<tr><td colspan="10"><div class="empty-state"><h3>دسترسی ندارید</h3></div></td></tr>`
    const wrap = document.getElementById('accountingBankBalances')
    if (wrap) wrap.innerHTML = ''
    return
  }

  const search = toEnDigits(document.getElementById('searchAccounting')?.value || '').toLowerCase()
  const allPayments = getAllPayments()

  try {
    const users = await getUsersSafe()
    const nameByPhone = new Map(
      users.filter(u => u.phone).map(u => [normalizePhone(u.phone), userDisplayName(u)])
    )
    allPayments.forEach(p => {
      const phone = p.soldByPhone || p.advisorPhone
      p.advisor = nameByPhone.get(phone) || p.ownerAdvisor || p.advisor || '—'
    })
  } catch (_) { /* keep fallback advisor names */ }

  let payments = allPayments.filter(p => {
    if (accountingFilter === 'gifts') return !!p.isGift
    return p.paymentStatus === accountingFilter
  })

  if (search) {
    payments = payments.filter(p =>
      matchesTabSearch(search, [
        p.customerId,
        p.customerName,
        p.customerPhone,
        ...(p.customerPhones || []),
        p.depositorName,
        p.productName,
        p.advisor,
        p.destinationBank,
        p.soldAt,
        p.productStatus,
        p.isGift ? 'هدیه' : ''
      ])
    )
  }

  if (accountingSortState.field) {
    payments = sortRecords(payments, accountingSortState, accountingSortValue)
  } else {
    payments.sort((a, b) => String(b.soldAt || '').localeCompare(String(a.soldAt || ''), 'fa'))
  }

  const setStat = (id, n) => {
    const el = document.getElementById(id)
    if (el) el.textContent = String(n)
  }
  const pendingPayments = allPayments.filter(p => p.paymentStatus === 'pending')
  setStat('stat-acc-pending', pendingPayments.length)
  setStat('stat-acc-approved', allPayments.filter(p => p.paymentStatus === 'approved').length)
  setStat('stat-acc-rejected', allPayments.filter(p => p.paymentStatus === 'rejected').length)

  const pendingAmountEl = document.getElementById('stat-acc-pending-amount')
  if (pendingAmountEl) {
    const pendingAmount = pendingPayments.reduce((sum, p) => sum + (p.isGift ? 0 : (p.amount || 0)), 0)
    pendingAmountEl.textContent = formatNumber(pendingAmount) + ' ریال'
  }

  renderAccountingBankBalances(allPayments)

  if (payments.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="10">
        <div class="empty-state">
          <div class="icon">💳</div>
          <h3>${accountingFilter === 'gifts' ? 'هدیه‌ای در صف نیست' : 'واریزی‌ای در این وضعیت نیست'}</h3>
          <p>فیلتر یا جستجو را تغییر دهید</p>
        </div>
      </td></tr>`
    renderPaginationBar('accountingPagination', 'accounting', { total: 0, from: 0, to: 0, page: 1, totalPages: 1 })
    syncSortHeaders('#sheet-accounting', accountingSortState)
    return
  }

  const filterSig = `${accountingFilter}|${search}|${sortSig(accountingSortState)}`
  const page = paginateList('accounting', payments, filterSig)

  tbody.innerHTML = page.items.map(p => {
    const statusLabel = PAYMENT_STATUS_LABELS[p.paymentStatus] || p.paymentStatus
    const typeLabel = p.isGift
      ? `<span class="gift-badge">هدیه</span>`
      : escapeHtml(p.productStatus || '—')
    const amountHtml = p.isGift
      ? `<span class="gift-badge">۰ · هدیه</span>`
      : `${formatNumber(p.amount)} ریال`

    let actions = ''
    if (p.paymentStatus === 'pending') {
      if (p.isGift) {
        actions = `<button class="btn btn-sm btn-approve" onclick="app.approveGiftSale('${escapeAttr(p.customerId)}', ${p.productIndex})">تأیید</button>
         <button class="btn btn-sm btn-reject" onclick="app.openRejectPaymentModal('${escapeAttr(p.customerId)}', ${p.productIndex}, -1, true)">رد</button>`
      } else {
        actions = `<button class="btn btn-sm btn-approve" onclick="app.approvePayment('${escapeAttr(p.customerId)}', ${p.productIndex}, ${p.paymentIndex})">تأیید</button>
         <button class="btn btn-sm btn-reject" onclick="app.openRejectPaymentModal('${escapeAttr(p.customerId)}', ${p.productIndex}, ${p.paymentIndex})">رد</button>`
      }
    } else if (p.paymentStatus === 'rejected') {
      const editArgs = p.isGift
        ? `'${escapeAttr(p.customerId)}', ${p.productIndex}, -1, true`
        : `'${escapeAttr(p.customerId)}', ${p.productIndex}, ${p.paymentIndex}`
      actions = `<span style="font-size:12px;color:var(--danger);">${escapeHtml(p.paymentRejectReason || '—')}</span>
        <button type="button" class="btn btn-sm btn-edit-reason" title="اصلاح دلیل رد" onclick="app.openEditRejectReasonModal(${editArgs})">اصلاح دلیل</button>`
    } else {
      actions = `<span style="font-size:12px;color:var(--text-muted);">${escapeHtml(formatSoldAt24h(p.paymentReviewedAt) || p.paymentReviewedAt || '—')}</span>`
    }

    return `<tr class="clickable-row${p.isGift ? ' gift-row' : ''}" onclick="app.onCustomerRowClick(event, '${escapeAttr(p.customerId)}')">
      <td>${escapeHtml(p.customerName)}</td>
      <td style="direction:ltr;text-align:right;font-family:'Vazirmatn',sans-serif;font-size:13px;">${(() => {
        const phones = p.customerPhones || (p.customerPhone ? [p.customerPhone] : [])
        if (!phones.length) return '—'
        const extra = phones.length > 1
          ? ` <span style="color:var(--text-muted);font-size:11px;" title="${escapeAttr(phones.slice(1).join('، '))}">+${phones.length - 1}</span>`
          : ''
        return `${escapeHtml(phones[0])}${extra}`
      })()}</td>
      <td>${escapeHtml(p.advisor) || '—'}</td>
      <td>${escapeHtml(p.productName)}${p.isGift ? ' <span class="gift-badge">هدیه</span>' : ''}</td>
      <td>${typeLabel}</td>
      <td style="direction:ltr;text-align:right;font-family:'Vazirmatn',sans-serif;font-weight:600;">${amountHtml}</td>
      <td style="font-family:'Vazirmatn',sans-serif;font-size:13px;direction:ltr;text-align:right;">${escapeHtml(formatSoldAt24h(p.soldAt)) || '—'}</td>
      <td>${p.isGift ? '—' : (escapeHtml(p.destinationBank) || '—')}</td>
      <td>${p.isGift ? '—' : (escapeHtml(p.depositorName) || '—')}</td>
      <td><span class="payment-badge payment-${p.paymentStatus}">${escapeHtml(statusLabel)}</span>
        <div class="actions-cell" style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">${actions}</div>
      </td>
    </tr>`
  }).join('')

  renderPaginationBar('accountingPagination', 'accounting', page)
  syncSortHeaders('#sheet-accounting', accountingSortState)
}

function accountingSortValue(p, field) {
  if (field === 'amount') return { value: p.amount || 0, type: 'number' }
  if (field === 'soldAt') return { value: p.soldAt || '', type: 'datetime' }
  if (field === 'payType') return { value: p.isGift ? 'هدیه' : (p.productStatus || ''), type: 'text' }
  if (field === 'customerPhone') return { value: p.customerPhone || '', type: 'text' }
  return { value: p[field] ?? '', type: 'text' }
}

export function sortAccounting(field) {
  toggleSortField(accountingSortState, field)
  renderAccounting()
}

async function updatePaymentEntry(customerId, productIndex, paymentIndex, patch) {
  const data = getData()
  const customer = data.customers.find(c => c.id === customerId)
  if (!customer || !customer.products || !customer.products[productIndex]) {
    showToast('واریزی یافت نشد')
    return false
  }
  const product = customer.products[productIndex]
  ensureProductPayments(product)
  if (!product.payments[paymentIndex]) {
    showToast('واریزی یافت نشد')
    return false
  }
  Object.assign(product.payments[paymentIndex], patch)
  syncProductStatus(product)
  await saveCustomerToDB(customer)
  return true
}

async function updateGiftSale(customerId, productIndex, patch) {
  const data = getData()
  const customer = data.customers.find(c => c.id === customerId)
  if (!customer || !customer.products || !customer.products[productIndex]) {
    showToast('هدیه یافت نشد')
    return false
  }
  const product = customer.products[productIndex]
  if (!isGiftSale(product)) {
    showToast('این ردیف هدیه نیست')
    return false
  }
  Object.assign(product, patch)
  syncProductStatus(product)
  await saveCustomerToDB(customer)
  return true
}

export async function approvePayment(customerId, productIndex, paymentIndex) {
  if (!requirePermission('accounting')) return
  const user = getCurrentUser()
  const { dateTime } = getNowJalaliDateTime()
  try {
    const ok = await updatePaymentEntry(customerId, productIndex, paymentIndex, {
      paymentStatus: PAYMENT_STATUS.approved,
      paymentRejectReason: '',
      paymentReviewedAt: dateTime,
      paymentReviewedBy: normalizePhone(user?.phone || '')
    })
    if (!ok) return
    showToast('واریزی تأیید شد')
    renderAccounting()
    renderSales()
    try { renderProducts(customerId) } catch (_) { /* detail panel may be closed */ }
  } catch (e) {
    console.error('approvePayment error:', e)
    showToast('خطا در تأیید واریزی')
  }
}

export async function approveGiftSale(customerId, productIndex) {
  if (!requirePermission('accounting')) return
  const user = getCurrentUser()
  const { dateTime } = getNowJalaliDateTime()
  try {
    const ok = await updateGiftSale(customerId, productIndex, {
      giftAccountingStatus: PAYMENT_STATUS.approved,
      giftRejectReason: '',
      giftReviewedAt: dateTime,
      giftReviewedBy: normalizePhone(user?.phone || '')
    })
    if (!ok) return
    showToast('هدیه تأیید شد — مالکیت محصول ثبت شد')
    renderAccounting()
    renderSales()
    try { renderProducts(customerId) } catch (_) { /* detail panel may be closed */ }
  } catch (e) {
    console.error('approveGiftSale error:', e)
    showToast('خطا در تأیید هدیه')
  }
}

function openAccountingConfirm(message, onConfirm, confirmLabel = 'تأیید') {
  const msg = document.getElementById('deleteMessage')
  const btn = document.getElementById('deleteConfirmBtn')
  const header = document.querySelector('#deleteModal .modal-header h2')
  const modal = document.getElementById('deleteModal')
  if (!msg || !btn || !modal) {
    if (window.confirm(message)) onConfirm()
    return
  }
  const prevLabel = btn.textContent
  const prevHeader = header?.textContent
  msg.textContent = message
  btn.textContent = confirmLabel
  if (header) header.textContent = 'تأیید'
  const restore = () => {
    btn.textContent = prevLabel
    if (header && prevHeader) header.textContent = prevHeader
  }
  btn.onclick = () => {
    modal.classList.remove('active')
    restore()
    onConfirm()
  }
  const cancelBtn = document.querySelector('#deleteModal .modal-footer .btn:not(.btn-danger)')
  const closeBtn = document.querySelector('#deleteModal .modal-close')
  if (cancelBtn) cancelBtn.addEventListener('click', restore, { once: true })
  if (closeBtn) closeBtn.addEventListener('click', restore, { once: true })
  modal.classList.add('active')
}

function productShippedWarning(product) {
  if (getShipmentStatus(product) !== SHIPMENT_STATUS.shipped) return ''
  return ' توجه: این محصول قبلاً ارسال شده و وضعیت ارسال تغییر نمی‌کند.'
}

export function requestUnapprovePayment(customerId, productIndex, paymentIndex) {
  if (!requirePermission('accounting')) return
  const data = getData()
  const customer = data.customers.find(c => c.id === customerId)
  const product = customer?.products?.[productIndex]
  if (!product) {
    showToast('واریزی یافت نشد')
    return
  }
  ensureProductPayments(product)
  const pay = product.payments?.[paymentIndex]
  if (!pay || getPaymentEntryStatus(pay) !== PAYMENT_STATUS.approved) {
    showToast('این واریز تأییدشده نیست')
    return
  }
  const message =
    'این واریز از حالت تأیید خارج شود؟ کارشناس می‌تواند دوباره اطلاعات را ویرایش کند.' +
    productShippedWarning(product)
  openAccountingConfirm(message, () => {
    unapprovePayment(customerId, productIndex, paymentIndex)
  }, 'لغو تأیید')
}

export function requestUnapproveGiftSale(customerId, productIndex) {
  if (!requirePermission('accounting')) return
  const data = getData()
  const customer = data.customers.find(c => c.id === customerId)
  const product = customer?.products?.[productIndex]
  if (!product || !isGiftSale(product)) {
    showToast('هدیه یافت نشد')
    return
  }
  if (getGiftAccountingStatus(product) !== PAYMENT_STATUS.approved) {
    showToast('این هدیه تأییدشده نیست')
    return
  }
  const message =
    'این هدیه از حالت تأیید خارج شود؟ دوباره در صف حسابداری قرار می‌گیرد.' +
    productShippedWarning(product)
  openAccountingConfirm(message, () => {
    unapproveGiftSale(customerId, productIndex)
  }, 'لغو تأیید')
}

export async function unapprovePayment(customerId, productIndex, paymentIndex) {
  if (!requirePermission('accounting')) return
  try {
    const data = getData()
    const customer = data.customers.find(c => c.id === customerId)
    const product = customer?.products?.[productIndex]
    if (!product) {
      showToast('واریزی یافت نشد')
      return
    }
    ensureProductPayments(product)
    const pay = product.payments?.[paymentIndex]
    if (!pay || getPaymentEntryStatus(pay) !== PAYMENT_STATUS.approved) {
      showToast('این واریز تأییدشده نیست')
      return
    }
    const ok = await updatePaymentEntry(customerId, productIndex, paymentIndex, {
      paymentStatus: PAYMENT_STATUS.pending,
      paymentRejectReason: '',
      paymentReviewedAt: '',
      paymentReviewedBy: ''
    })
    if (!ok) return
    showToast('تأیید واریز لغو شد — قابل ویرایش است')
    renderAccounting()
    renderSales()
    try { renderProducts(customerId) } catch (_) { /* detail panel may be closed */ }
  } catch (e) {
    console.error('unapprovePayment error:', e)
    showToast('خطا در لغو تأیید واریزی')
  }
}

export async function unapproveGiftSale(customerId, productIndex) {
  if (!requirePermission('accounting')) return
  try {
    const data = getData()
    const customer = data.customers.find(c => c.id === customerId)
    const product = customer?.products?.[productIndex]
    if (!product || !isGiftSale(product)) {
      showToast('هدیه یافت نشد')
      return
    }
    if (getGiftAccountingStatus(product) !== PAYMENT_STATUS.approved) {
      showToast('این هدیه تأییدشده نیست')
      return
    }
    const ok = await updateGiftSale(customerId, productIndex, {
      giftAccountingStatus: PAYMENT_STATUS.pending,
      giftRejectReason: '',
      giftReviewedAt: '',
      giftReviewedBy: ''
    })
    if (!ok) return
    showToast('تأیید هدیه لغو شد')
    renderAccounting()
    renderSales()
    try { renderProducts(customerId) } catch (_) { /* detail panel may be closed */ }
  } catch (e) {
    console.error('unapproveGiftSale error:', e)
    showToast('خطا در لغو تأیید هدیه')
  }
}

function renderRejectReasonPresets() {
  const wrap = document.getElementById('rejectReasonPresets')
  if (!wrap || wrap.dataset.ready === '1') return
  wrap.innerHTML = PRESET_REJECT_REASONS.map(reason =>
    `<button type="button" class="reject-reason-preset" data-reason="${escapeHtml(reason)}">${escapeHtml(reason)}</button>`
  ).join('')
  wrap.dataset.ready = '1'
}

function syncRejectReasonPresetSelection(current) {
  const wrap = document.getElementById('rejectReasonPresets')
  if (!wrap) return
  const value = (current ?? document.getElementById('rejectPaymentReason')?.value ?? '').trim()
  wrap.querySelectorAll('.reject-reason-preset').forEach(btn => {
    btn.classList.toggle('is-selected', (btn.dataset.reason || '').trim() === value)
  })
}

export function onRejectReasonPresetClick(event) {
  const btn = event?.target?.closest?.('.reject-reason-preset')
  if (!btn) return
  const reason = (btn.dataset.reason || '').trim()
  if (!reason) return
  const el = document.getElementById('rejectPaymentReason')
  if (el) el.value = reason
  syncRejectReasonPresetSelection(reason)
}

export function onRejectReasonInput() {
  syncRejectReasonPresetSelection()
}

function applyRejectModalMode(mode, existingReason = '') {
  const title = document.getElementById('rejectPaymentModalTitle')
  const confirmBtn = document.getElementById('rejectPaymentConfirmBtn')
  const reason = document.getElementById('rejectPaymentReason')
  const isEdit = mode === 'editReason'
  if (title) title.textContent = isEdit ? 'اصلاح دلیل رد' : 'رد واریزی'
  if (confirmBtn) {
    confirmBtn.textContent = isEdit ? 'ذخیره دلیل' : 'رد واریزی'
    confirmBtn.classList.toggle('btn-danger', !isEdit)
    confirmBtn.classList.toggle('btn-primary', isEdit)
  }
  if (reason) reason.value = existingReason || ''
  renderRejectReasonPresets()
  syncRejectReasonPresetSelection(existingReason || '')
}

export function openRejectPaymentModal(customerId, productIndex, paymentIndex, isGift = false) {
  if (!requirePermission('accounting')) return
  rejectTarget = { customerId, productIndex, paymentIndex, isGift: !!isGift || paymentIndex === -1, mode: 'reject' }
  applyRejectModalMode('reject')
  document.getElementById('rejectPaymentModal')?.classList.add('active')
  document.getElementById('rejectPaymentReason')?.focus()
}

export function openEditRejectReasonModal(customerId, productIndex, paymentIndex = -1, isGift = false) {
  if (!requirePermission('accounting')) return
  const gift = !!isGift || paymentIndex === -1
  const data = getData()
  const customer = data.customers.find(c => c.id === customerId)
  const product = customer?.products?.[productIndex]
  if (!product) {
    showToast(gift ? 'هدیه یافت نشد' : 'واریزی یافت نشد')
    return
  }
  let existing = ''
  if (gift) {
    if (!isGiftSale(product)) {
      showToast('این ردیف هدیه نیست')
      return
    }
    if (getGiftAccountingStatus(product) !== PAYMENT_STATUS.rejected) {
      showToast('این هدیه رد نشده است')
      return
    }
    existing = product.giftRejectReason || ''
  } else {
    ensureProductPayments(product)
    const pay = product.payments?.[paymentIndex]
    if (!pay) {
      showToast('واریزی یافت نشد')
      return
    }
    if (getPaymentEntryStatus(pay) !== PAYMENT_STATUS.rejected) {
      showToast('این واریز رد نشده است')
      return
    }
    existing = pay.paymentRejectReason || ''
  }
  rejectTarget = { customerId, productIndex, paymentIndex, isGift: gift, mode: 'editReason' }
  applyRejectModalMode('editReason', existing)
  document.getElementById('rejectPaymentModal')?.classList.add('active')
  document.getElementById('rejectPaymentReason')?.focus()
}

export function closeRejectPaymentModal() {
  rejectTarget = null
  applyRejectModalMode('reject')
  document.getElementById('rejectPaymentModal')?.classList.remove('active')
}

async function saveEditedRejectReason(reason) {
  const { customerId, productIndex, paymentIndex, isGift } = rejectTarget
  try {
    if (isGift) {
      const data = getData()
      const product = data.customers.find(c => c.id === customerId)?.products?.[productIndex]
      if (!product || getGiftAccountingStatus(product) !== PAYMENT_STATUS.rejected) {
        showToast('این هدیه رد نشده است')
        return
      }
      if ((product.giftRejectReason || '').trim() === reason) {
        closeRejectPaymentModal()
        showToast('دلیل رد تغییری نکرد')
        return
      }
      const ok = await updateGiftSale(customerId, productIndex, { giftRejectReason: reason })
      if (!ok) return
    } else {
      const data = getData()
      const product = data.customers.find(c => c.id === customerId)?.products?.[productIndex]
      if (product) ensureProductPayments(product)
      const payment = product?.payments?.[paymentIndex]
      if (!payment || getPaymentEntryStatus(payment) !== PAYMENT_STATUS.rejected) {
        showToast('این واریز رد نشده است')
        return
      }
      if ((payment.paymentRejectReason || '').trim() === reason) {
        closeRejectPaymentModal()
        showToast('دلیل رد تغییری نکرد')
        return
      }
      const ok = await updatePaymentEntry(customerId, productIndex, paymentIndex, {
        paymentRejectReason: reason
      })
      if (!ok) return
    }
    closeRejectPaymentModal()
    showToast('دلیل رد به‌روز شد')
    renderAccounting()
    renderSales()
    try { renderProducts(customerId) } catch (_) { /* detail panel may be closed */ }
  } catch (e) {
    console.error('saveEditedRejectReason error:', e)
    showToast('خطا در ذخیره دلیل رد')
  }
}

export async function confirmRejectPayment() {
  if (!requirePermission('accounting')) return
  if (!rejectTarget) return
  const reason = (document.getElementById('rejectPaymentReason')?.value || '').trim()
  if (!reason) {
    showToast('دلیل رد را وارد کنید')
    return
  }
  if (rejectTarget.mode === 'editReason') {
    await saveEditedRejectReason(reason)
    return
  }
  const user = getCurrentUser()
  const { dateTime } = getNowJalaliDateTime()
  const { customerId, productIndex, paymentIndex, isGift } = rejectTarget
  try {
    if (isGift) {
      const ok = await updateGiftSale(customerId, productIndex, {
        giftAccountingStatus: PAYMENT_STATUS.rejected,
        giftRejectReason: reason,
        giftReviewedAt: dateTime,
        giftReviewedBy: normalizePhone(user?.phone || '')
      })
      if (!ok) return
      closeRejectPaymentModal()
      showToast('هدیه رد شد')
      renderAccounting()
      renderSales()
      try { renderProducts(customerId) } catch (_) { /* ignore */ }
      return
    }

    const data = getData()
    const customer = data.customers.find(c => c.id === customerId)
    const product = customer?.products?.[productIndex]
    if (product) ensureProductPayments(product)
    const payment = product?.payments?.[paymentIndex]
    const sellerPhone = getSaleRegistrantPhone(product, payment, customer)

    const ok = await updatePaymentEntry(customerId, productIndex, paymentIndex, {
      paymentStatus: PAYMENT_STATUS.rejected,
      paymentRejectReason: reason,
      paymentReviewedAt: dateTime,
      paymentReviewedBy: normalizePhone(user?.phone || '')
    })
    if (!ok) return
    closeRejectPaymentModal()
    showToast('واریزی رد شد')
    if (sellerPhone) {
      try {
        await broadcastPaymentRejectToast({
          paymentId: payment?.id || '',
          sellerPhone,
          customerId,
          customerName: customer?.name || customer?.platformId || customerId || '',
          productName: coerceProductName(product?.name),
          amount: payment?.amount || '',
          reason,
          at: Date.now()
        })
      } catch (e) {
        console.error('payment reject toast error:', e)
      }
    }
    renderAccounting()
    renderSales()
    try { renderProducts(customerId) } catch (_) { /* detail panel may be closed */ }
  } catch (e) {
    console.error('confirmRejectPayment error:', e)
    showToast('خطا در رد واریزی')
  }
}
