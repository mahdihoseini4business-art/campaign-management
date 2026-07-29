import { getData, saveCustomerToDB } from './data.js'
import {
  toEnDigits, formatNumber, escapeHtml, escapeAttr, showToast, hasPermission,
  requirePermission, getCurrentUser, normalizePhone, getNowJalaliDateTime,
  ensureProductPayments, syncProductStatus, getPaymentEntryStatus,
  PAYMENT_STATUS, PAYMENT_STATUS_LABELS, formatSoldAt24h, matchesTabSearch,
  getCustomerPhones, getPrimaryPhone
} from './utils.js'
import { paginateList, renderPaginationBar } from './pagination.js'
import { renderSales } from './sales.js'
import { renderProducts } from './customers.js'

let accountingFilter = 'pending' // pending | approved | rejected
let rejectTarget = null // { customerId, productIndex, paymentIndex }

export function getAllPayments() {
  const data = getData()
  const payments = []
  data.customers.forEach(c => {
    ;(c.products || []).forEach((product, productIndex) => {
      ensureProductPayments(product)
      syncProductStatus(product)
      ;(product.payments || []).forEach((pay, paymentIndex) => {
        const amount = parseFloat(pay.amount) || 0
        if (amount <= 0) return
        payments.push({
          customerId: c.id,
          productIndex,
          paymentIndex,
          customerName: c.name || c.platformId || c.id,
          customerPhone: getPrimaryPhone(c),
          customerPhones: getCustomerPhones(c),
          advisor: c.advisor || '',
          advisorPhone: c.advisorPhone || '',
          productName: product.name || '',
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

export function renderAccounting() {
  const tbody = document.getElementById('accountingBody')
  if (!tbody) return
  if (!hasPermission('accounting')) {
    tbody.innerHTML = `<tr><td colspan="11"><div class="empty-state"><h3>دسترسی ندارید</h3></div></td></tr>`
    return
  }

  const search = toEnDigits(document.getElementById('searchAccounting')?.value || '').toLowerCase()
  // Accounting is a global review queue — anyone with this permission sees all payments
  const allPayments = getAllPayments()
  let payments = allPayments.filter(p => p.paymentStatus === accountingFilter)

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
        p.productStatus
      ])
    )
  }

  payments.sort((a, b) => String(b.soldAt || '').localeCompare(String(a.soldAt || ''), 'fa'))

  const setStat = (id, n) => {
    const el = document.getElementById(id)
    if (el) el.textContent = String(n)
  }
  setStat('stat-acc-pending', allPayments.filter(p => p.paymentStatus === 'pending').length)
  setStat('stat-acc-approved', allPayments.filter(p => p.paymentStatus === 'approved').length)
  setStat('stat-acc-rejected', allPayments.filter(p => p.paymentStatus === 'rejected').length)

  if (payments.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="11">
        <div class="empty-state">
          <div class="icon">💳</div>
          <h3>واریزی‌ای در این وضعیت نیست</h3>
          <p>فیلتر یا جستجو را تغییر دهید</p>
        </div>
      </td></tr>`
    renderPaginationBar('accountingPagination', 'accounting', { total: 0, from: 0, to: 0, page: 1, totalPages: 1 })
    return
  }

  const filterSig = `${accountingFilter}|${search}`
  const page = paginateList('accounting', payments, filterSig)

  tbody.innerHTML = page.items.map(p => {
    const statusLabel = PAYMENT_STATUS_LABELS[p.paymentStatus] || p.paymentStatus
    const actions = p.paymentStatus === 'pending'
      ? `<button class="btn btn-sm btn-approve" onclick="app.approvePayment('${escapeAttr(p.customerId)}', ${p.productIndex}, ${p.paymentIndex})">تأیید</button>
         <button class="btn btn-sm btn-reject" onclick="app.openRejectPaymentModal('${escapeAttr(p.customerId)}', ${p.productIndex}, ${p.paymentIndex})">رد</button>`
      : (p.paymentStatus === 'rejected'
        ? `<span style="font-size:12px;color:var(--danger);">${escapeHtml(p.paymentRejectReason || '—')}</span>`
        : `<span style="font-size:12px;color:var(--text-muted);">${escapeHtml(formatSoldAt24h(p.paymentReviewedAt) || p.paymentReviewedAt || '—')}</span>`)

    return `<tr>
      <td><span class="id-badge ${p.customerId.startsWith('CS') ? 'id-cs' : 'id-ld'}" style="cursor:pointer;" onclick="app.openCustomerDetail('${escapeAttr(p.customerId)}')">${escapeHtml(p.customerId)}</span></td>
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
      <td>${escapeHtml(p.productName)}</td>
      <td>${escapeHtml(p.productStatus)}</td>
      <td style="direction:ltr;text-align:right;font-family:'Vazirmatn',sans-serif;font-weight:600;">${formatNumber(p.amount)} ریال</td>
      <td style="font-family:'Vazirmatn',sans-serif;font-size:13px;direction:ltr;text-align:right;">${escapeHtml(formatSoldAt24h(p.soldAt)) || '—'}</td>
      <td>${escapeHtml(p.destinationBank) || '—'}</td>
      <td>${escapeHtml(p.depositorName) || '—'}</td>
      <td><span class="payment-badge payment-${p.paymentStatus}">${escapeHtml(statusLabel)}</span>
        <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">${actions}</div>
      </td>
    </tr>`
  }).join('')

  renderPaginationBar('accountingPagination', 'accounting', page)
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

export function openRejectPaymentModal(customerId, productIndex, paymentIndex) {
  if (!requirePermission('accounting')) return
  rejectTarget = { customerId, productIndex, paymentIndex }
  const modal = document.getElementById('rejectPaymentModal')
  const reason = document.getElementById('rejectPaymentReason')
  if (reason) reason.value = ''
  if (modal) modal.classList.add('active')
  reason?.focus()
}

export function closeRejectPaymentModal() {
  rejectTarget = null
  document.getElementById('rejectPaymentModal')?.classList.remove('active')
}

export async function confirmRejectPayment() {
  if (!requirePermission('accounting')) return
  if (!rejectTarget) return
  const reason = (document.getElementById('rejectPaymentReason')?.value || '').trim()
  if (!reason) {
    showToast('دلیل رد را وارد کنید')
    return
  }
  const user = getCurrentUser()
  const { dateTime } = getNowJalaliDateTime()
  const { customerId, productIndex, paymentIndex } = rejectTarget
  try {
    const ok = await updatePaymentEntry(customerId, productIndex, paymentIndex, {
      paymentStatus: PAYMENT_STATUS.rejected,
      paymentRejectReason: reason,
      paymentReviewedAt: dateTime,
      paymentReviewedBy: normalizePhone(user?.phone || '')
    })
    if (!ok) return
    closeRejectPaymentModal()
    showToast('واریزی رد شد')
    renderAccounting()
    renderSales()
    try { renderProducts(customerId) } catch (_) { /* detail panel may be closed */ }
  } catch (e) {
    console.error('confirmRejectPayment error:', e)
    showToast('خطا در رد واریزی')
  }
}
