import { getData, saveCustomerToDB } from './data.js'
import {
  toEnDigits, formatNumber, escapeHtml, escapeAttr, showToast, hasPermission,
  requirePermission, getCurrentUser, normalizePhone, getNowJalaliDateTime,
  getPaymentAmount, getPaymentStatus, PAYMENT_STATUS, PAYMENT_STATUS_LABELS
} from './utils.js'
import { renderSales } from './sales.js'

let accountingFilter = 'pending' // pending | approved | rejected
let rejectTarget = null // { customerId, productIndex }

export function getAllPayments() {
  const data = getData()
  const payments = []
  data.customers.forEach(c => {
    ;(c.products || []).forEach((p, productIndex) => {
      const amount = getPaymentAmount(p)
      if (amount <= 0) return
      payments.push({
        customerId: c.id,
        productIndex,
        customerName: c.name || c.platformId || c.id,
        customerPhone: c.phone || '',
        advisor: c.advisor || '',
        advisorPhone: c.advisorPhone || '',
        productName: p.name || '',
        productStatus: p.status || '',
        amount,
        soldAt: p.soldAt || '',
        depositorName: p.depositorName || '',
        paymentStatus: getPaymentStatus(p),
        paymentRejectReason: p.paymentRejectReason || '',
        paymentReviewedAt: p.paymentReviewedAt || '',
        paymentReviewedBy: p.paymentReviewedBy || ''
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
    tbody.innerHTML = `<tr><td colspan="10"><div class="empty-state"><h3>دسترسی ندارید</h3></div></td></tr>`
    return
  }

  const search = toEnDigits(document.getElementById('searchAccounting')?.value || '').toLowerCase()
  let payments = getAllPayments().filter(p => p.paymentStatus === accountingFilter)

  if (search) {
    payments = payments.filter(p =>
      p.customerId.toLowerCase().includes(search) ||
      p.customerName.toLowerCase().includes(search) ||
      p.customerPhone.includes(search) ||
      (p.depositorName || '').toLowerCase().includes(search) ||
      (p.productName || '').toLowerCase().includes(search) ||
      (p.advisor || '').toLowerCase().includes(search)
    )
  }

  // Newest soldAt first (string compare works for Jalali YYYY/MM/DD HH:mm)
  payments.sort((a, b) => String(b.soldAt || '').localeCompare(String(a.soldAt || ''), 'fa'))

  const all = getAllPayments()
  const setStat = (id, n) => {
    const el = document.getElementById(id)
    if (el) el.textContent = String(n)
  }
  setStat('stat-acc-pending', all.filter(p => p.paymentStatus === 'pending').length)
  setStat('stat-acc-approved', all.filter(p => p.paymentStatus === 'approved').length)
  setStat('stat-acc-rejected', all.filter(p => p.paymentStatus === 'rejected').length)

  if (payments.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="10">
        <div class="empty-state">
          <div class="icon">💳</div>
          <h3>واریزی‌ای در این وضعیت نیست</h3>
          <p>فیلتر یا جستجو را تغییر دهید</p>
        </div>
      </td></tr>`
    return
  }

  tbody.innerHTML = payments.map(p => {
    const statusLabel = PAYMENT_STATUS_LABELS[p.paymentStatus] || p.paymentStatus
    const actions = p.paymentStatus === 'pending'
      ? `<button class="btn btn-sm btn-approve" onclick="app.approvePayment('${escapeAttr(p.customerId)}', ${p.productIndex})">تأیید</button>
         <button class="btn btn-sm btn-reject" onclick="app.openRejectPaymentModal('${escapeAttr(p.customerId)}', ${p.productIndex})">رد</button>`
      : (p.paymentStatus === 'rejected'
        ? `<span style="font-size:12px;color:var(--danger);">${escapeHtml(p.paymentRejectReason || '—')}</span>`
        : `<span style="font-size:12px;color:var(--text-muted);">${escapeHtml(p.paymentReviewedAt || '—')}</span>`)

    return `<tr>
      <td><span class="id-badge ${p.customerId.startsWith('CS') ? 'id-cs' : 'id-ld'}" style="cursor:pointer;" onclick="app.openCustomerDetail('${escapeAttr(p.customerId)}')">${escapeHtml(p.customerId)}</span></td>
      <td>${escapeHtml(p.customerName)}</td>
      <td style="direction:ltr;text-align:right;font-family:'Vazirmatn',sans-serif;font-size:13px;">${escapeHtml(p.customerPhone) || '—'}</td>
      <td>${escapeHtml(p.advisor) || '—'}</td>
      <td>${escapeHtml(p.productName)}</td>
      <td>${escapeHtml(p.productStatus)}</td>
      <td style="direction:ltr;text-align:right;font-family:'Vazirmatn',sans-serif;font-weight:600;">${formatNumber(p.amount)}</td>
      <td style="font-family:'Vazirmatn',sans-serif;font-size:13px;direction:ltr;text-align:right;">${escapeHtml(p.soldAt) || '—'}</td>
      <td>${escapeHtml(p.depositorName) || '—'}</td>
      <td><span class="payment-badge payment-${p.paymentStatus}">${escapeHtml(statusLabel)}</span>
        <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">${actions}</div>
      </td>
    </tr>`
  }).join('')
}

async function updatePaymentFields(customerId, productIndex, patch) {
  const data = getData()
  const customer = data.customers.find(c => c.id === customerId)
  if (!customer || !customer.products || !customer.products[productIndex]) {
    showToast('واریزی یافت نشد')
    return false
  }
  Object.assign(customer.products[productIndex], patch)
  await saveCustomerToDB(customer)
  return true
}

export async function approvePayment(customerId, productIndex) {
  if (!requirePermission('accounting')) return
  const user = getCurrentUser()
  const { dateTime } = getNowJalaliDateTime()
  try {
    const ok = await updatePaymentFields(customerId, productIndex, {
      paymentStatus: PAYMENT_STATUS.approved,
      paymentRejectReason: '',
      paymentReviewedAt: dateTime,
      paymentReviewedBy: normalizePhone(user?.phone || '')
    })
    if (!ok) return
    showToast('واریزی تأیید شد')
    renderAccounting()
    renderSales()
  } catch (e) {
    console.error('approvePayment error:', e)
    showToast('خطا در تأیید واریزی')
  }
}

export function openRejectPaymentModal(customerId, productIndex) {
  if (!requirePermission('accounting')) return
  rejectTarget = { customerId, productIndex }
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
  const { customerId, productIndex } = rejectTarget
  try {
    const ok = await updatePaymentFields(customerId, productIndex, {
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
  } catch (e) {
    console.error('confirmRejectPayment error:', e)
    showToast('خطا در رد واریزی')
  }
}
