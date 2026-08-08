import {
  getData, saveCustomerToDB, saveRefundToDB, updateRefundInDB, getRefunds,
  coerceProductName
} from './data.js'
import {
  toEnDigits, formatNumber, escapeHtml, escapeAttr, showToast, hasPermission,
  requirePermission, getCurrentUser, normalizePhone, userDisplayName,
  ensureProductPayments, syncProductStatus, getProductPayments, getPaymentEntryStatus,
  PAYMENT_STATUS, getSaleRegistrantPhone, canViewScopedCustomer, matchesTabSearch,
  getCustomerPhones, getPrimaryPhone, jalaliDatePart, jalaliToNum,
  gregorianToJalaliStr, formatSoldAt24h,
  REFUND_STATUS, REFUND_STATUS_LABELS, REFUND_KANBAN_STATUSES,
  getPaymentRefundedAmount, applyCompletedRefundToProduct, removeCompletedRefundFromProduct,
  getProductRefundBadge
} from './utils.js'
import { getUsersSafe } from './auth.js'
import { renderProducts } from './customers.js'

let refundsView = 'kanban' // kanban | rejected
let dragRefundId = null
let rejectTargetId = null

const wizard = {
  step: 1,
  customerId: null,
  productIndex: null,
  paymentId: null,
  amount: 0,
  note: ''
}

function canManageRefunds() {
  return hasPermission('refunds_manage')
}

function resolveAdvisorName(phone) {
  const p = normalizePhone(phone)
  if (!p) return '—'
  const user = getUsersSafe().find(u => normalizePhone(u.phone) === p)
  return user ? (userDisplayName(user) || p) : p
}

function findProductAndPayment(customer, paymentId, productIndexHint) {
  if (!customer) return null
  const products = customer.products || []
  if (productIndexHint != null && products[productIndexHint]) {
    const product = products[productIndexHint]
    ensureProductPayments(product)
    const pay = getProductPayments(product).find(p => String(p.id) === String(paymentId))
    if (pay) return { product, productIndex: productIndexHint, payment: pay }
  }
  for (let i = 0; i < products.length; i++) {
    const product = products[i]
    ensureProductPayments(product)
    const pay = getProductPayments(product).find(p => String(p.id) === String(paymentId))
    if (pay) return { product, productIndex: i, payment: pay }
  }
  return null
}

/** Remaining refundable for a payment (approved − completed writeback − active requests). */
export function getPaymentRefundableRemaining(customerId, product, payment, excludeRefundId = null) {
  if (!payment || getPaymentEntryStatus(payment) !== PAYMENT_STATUS.approved) return 0
  const approved = parseFloat(payment.amount) || 0
  const completed = getPaymentRefundedAmount(product, payment.id)
  const active = getRefunds()
    .filter(r =>
      String(r.paymentId) === String(payment.id) &&
      (r.status === REFUND_STATUS.requested || r.status === REFUND_STATUS.awaiting) &&
      (excludeRefundId == null || String(r.id) !== String(excludeRefundId))
    )
    .reduce((s, r) => s + (parseFloat(r.amount) || 0), 0)
  return Math.max(0, Math.round(approved - completed - active))
}

function getVisibleRefunds() {
  const data = getData()
  const currentUser = getCurrentUser()
  const myPhone = normalizePhone(currentUser?.phone || '')
  return getRefunds().filter(r => {
    if (!r?.customerId) return false
    if (r.customerId.startsWith('LD') && !hasPermission('customers_ld')) return false
    if (r.customerId.startsWith('CS') && !hasPermission('customers_cs')) return false
    const customer = data.customers.find(c => c.id === r.customerId)
    const registeredByMe = !!(myPhone && normalizePhone(r.advisorPhone) === myPhone)
    if (!canViewScopedCustomer(customer, currentUser) && !registeredByMe && !hasPermission('refunds_manage')) {
      return false
    }
    return true
  })
}

function refundMatchesSearch(r, q) {
  if (!q) return true
  const customer = getData().customers.find(c => c.id === r.customerId)
  const phones = customer ? getCustomerPhones(customer).join(' ') : ''
  return matchesTabSearch(q, [
    r.customerName,
    r.customerId,
    r.productName,
    r.note,
    r.rejectReason,
    phones,
    resolveAdvisorName(r.advisorPhone),
    formatNumber(r.amount)
  ])
}

export function setRefundsView(view) {
  if (view !== 'kanban' && view !== 'rejected') return
  refundsView = view
  document.querySelectorAll('.refunds-view-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view)
  })
  const kanban = document.getElementById('refundsKanban')
  const rejected = document.getElementById('refundsRejectedWrap')
  if (kanban) kanban.hidden = view !== 'kanban'
  if (rejected) rejected.hidden = view !== 'rejected'
  renderRefunds()
}

export function renderRefunds() {
  if (!hasPermission('refunds_view') && !hasPermission('refunds_manage')) return

  const search = toEnDigits(document.getElementById('searchRefunds')?.value || '').trim().toLowerCase()
  const all = getVisibleRefunds().filter(r => refundMatchesSearch(r, search))
  const canManage = canManageRefunds()

  const createBtn = document.getElementById('refundCreateBtn')
  if (createBtn) createBtn.style.display = canManage ? '' : 'none'

  const counts = {
    requested: 0,
    awaiting: 0,
    completed: 0,
    rejected: 0
  }
  all.forEach(r => {
    if (counts[r.status] != null) counts[r.status]++
  })
  const setStat = (id, n) => {
    const el = document.getElementById(id)
    if (el) el.textContent = formatNumber(n)
  }
  setStat('stat-refund-requested', counts.requested)
  setStat('stat-refund-awaiting', counts.awaiting)
  setStat('stat-refund-completed', counts.completed)
  setStat('stat-refund-rejected', counts.rejected)

  if (refundsView === 'rejected') {
    renderRejectedTable(all.filter(r => r.status === REFUND_STATUS.rejected))
    return
  }

  REFUND_KANBAN_STATUSES.forEach(status => {
    const col = document.getElementById(`refundCol-${status}`)
    if (!col) return
    const items = all.filter(r => r.status === status)
    const countEl = document.getElementById(`refundColCount-${status}`)
    if (countEl) countEl.textContent = formatNumber(items.length)
    col.innerHTML = items.length
      ? items.map(r => renderRefundCard(r, canManage)).join('')
      : `<div class="refund-col-empty">موردی نیست</div>`
  })
}

function renderRefundCard(r, canManage) {
  const draggable = canManage && r.status !== REFUND_STATUS.completed
  const rejectBtn = canManage && (r.status === REFUND_STATUS.requested || r.status === REFUND_STATUS.awaiting)
    ? `<button type="button" class="btn btn-sm btn-reject" onclick="event.stopPropagation();app.openRejectRefundModal(${Number(r.id)})">رد</button>`
    : ''
  return `
    <div class="refund-card${draggable ? ' is-draggable' : ''}"
      data-refund-id="${escapeAttr(String(r.id))}"
      draggable="${draggable ? 'true' : 'false'}"
      ondragstart="app.onRefundDragStart(event, ${Number(r.id)})"
      ondragend="app.onRefundDragEnd(event)">
      <div class="refund-card-title">${escapeHtml(r.customerName || r.customerId)}</div>
      <div class="refund-card-meta">${escapeHtml(r.productName || '—')}</div>
      <div class="refund-card-amount">${formatNumber(r.amount)} ریال</div>
      <div class="refund-card-meta">کارشناس: ${escapeHtml(resolveAdvisorName(r.advisorPhone))}</div>
      ${r.note ? `<div class="refund-card-note">${escapeHtml(r.note)}</div>` : ''}
      <div class="refund-card-actions">${rejectBtn}</div>
    </div>`
}

function renderRejectedTable(items) {
  const tbody = document.getElementById('refundsRejectedBody')
  if (!tbody) return
  if (!items.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--text-muted);">ردشده‌ای نیست</td></tr>`
    return
  }
  tbody.innerHTML = items.map(r => `
    <tr>
      <td>${escapeHtml(r.customerName || r.customerId)}</td>
      <td>${escapeHtml(r.productName || '—')}</td>
      <td style="direction:ltr;text-align:right;">${formatNumber(r.amount)} ریال</td>
      <td>${escapeHtml(resolveAdvisorName(r.advisorPhone))}</td>
      <td>${escapeHtml(r.rejectReason || '—')}</td>
      <td>${escapeHtml(r.createdByName || resolveAdvisorName(r.createdByPhone))}</td>
      <td style="font-size:12px;direction:ltr;">${escapeHtml(formatSoldAt24h(gregorianToJalaliStr(r.updatedAt) || '') || '—')}</td>
    </tr>
  `).join('')
}

export function onRefundDragStart(event, id) {
  if (!canManageRefunds()) {
    event.preventDefault()
    return
  }
  dragRefundId = id
  event.dataTransfer?.setData('text/plain', String(id))
  event.dataTransfer.effectAllowed = 'move'
  event.currentTarget?.classList.add('is-dragging')
}

export function onRefundDragEnd(event) {
  event.currentTarget?.classList.remove('is-dragging')
  document.querySelectorAll('.refund-col').forEach(c => c.classList.remove('is-drop-target'))
  dragRefundId = null
}

export function onRefundDragOver(event) {
  if (!canManageRefunds()) return
  event.preventDefault()
  const col = event.currentTarget
  col?.classList.add('is-drop-target')
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
}

export function onRefundDragLeave(event) {
  event.currentTarget?.classList.remove('is-drop-target')
}

export async function onRefundDrop(event, status) {
  event.preventDefault()
  event.currentTarget?.classList.remove('is-drop-target')
  if (!requirePermission('refunds_manage')) return
  if (!REFUND_KANBAN_STATUSES.includes(status)) return
  const id = dragRefundId || Number(event.dataTransfer?.getData('text/plain'))
  dragRefundId = null
  if (!id) return
  await moveRefundStatus(id, status)
}

async function moveRefundStatus(id, nextStatus, extra = {}) {
  const refund = getRefunds().find(r => String(r.id) === String(id))
  if (!refund) {
    showToast('درخواست عودت پیدا نشد')
    return
  }
  if (refund.status === nextStatus && !extra.rejectReason) return
  if (refund.status === REFUND_STATUS.completed && nextStatus !== REFUND_STATUS.completed) {
    showToast('عودت انجام‌شده قابل جابجایی نیست')
    return
  }

  const user = getCurrentUser()
  const phone = normalizePhone(user?.phone || '')
  const patch = {
    status: nextStatus,
    updatedByPhone: phone,
    ...extra
  }

  if (nextStatus === REFUND_STATUS.completed) {
    patch.completedAt = new Date().toISOString()
    patch.completedByPhone = phone
  } else if (refund.status === REFUND_STATUS.completed) {
    patch.completedAt = null
    patch.completedByPhone = null
  }

  try {
    const updated = await updateRefundInDB(id, patch)
    if (nextStatus === REFUND_STATUS.completed) {
      await writebackCompletedRefund(updated)
    } else if (refund.status === REFUND_STATUS.completed) {
      await undoCompletedRefundWriteback(refund)
    }
    showToast(nextStatus === REFUND_STATUS.rejected ? 'درخواست رد شد' : 'وضعیت به‌روز شد')
    renderRefunds()
  } catch (e) {
    console.error(e)
    showToast(e.message || 'خطا در به‌روزرسانی')
  }
}

async function writebackCompletedRefund(refund) {
  const data = getData()
  const customer = data.customers.find(c => c.id === refund.customerId)
  if (!customer) return
  const found = findProductAndPayment(customer, refund.paymentId, refund.productIndex)
  if (!found) {
    showToast('محصول/واریز برای ثبت عودت پیدا نشد')
    return
  }
  applyCompletedRefundToProduct(found.product, refund)
  syncProductStatus(found.product)
  await saveCustomerToDB(customer)
  try { renderProducts(customer.id) } catch (_) { /* ignore */ }
}

async function undoCompletedRefundWriteback(refund) {
  const data = getData()
  const customer = data.customers.find(c => c.id === refund.customerId)
  if (!customer) return
  const found = findProductAndPayment(customer, refund.paymentId, refund.productIndex)
  if (!found) return
  removeCompletedRefundFromProduct(found.product, refund.id)
  await saveCustomerToDB(customer)
}

export function openRejectRefundModal(id) {
  if (!requirePermission('refunds_manage')) return
  rejectTargetId = id
  const modal = document.getElementById('rejectRefundModal')
  const input = document.getElementById('rejectRefundReason')
  if (input) input.value = ''
  if (modal) modal.classList.add('active')
}

export function closeRejectRefundModal() {
  rejectTargetId = null
  document.getElementById('rejectRefundModal')?.classList.remove('active')
}

export async function confirmRejectRefund() {
  if (!requirePermission('refunds_manage')) return
  const reason = toEnDigits(document.getElementById('rejectRefundReason')?.value || '').trim()
  if (!reason) {
    showToast('دلیل رد را وارد کنید')
    return
  }
  const id = rejectTargetId
  closeRejectRefundModal()
  if (!id) return
  await moveRefundStatus(id, REFUND_STATUS.rejected, { rejectReason: reason })
}

// ============================================
// Wizard
// ============================================

export function openRefundWizard() {
  if (!requirePermission('refunds_manage')) return
  wizard.step = 1
  wizard.customerId = null
  wizard.productIndex = null
  wizard.paymentId = null
  wizard.amount = 0
  wizard.note = ''
  const search = document.getElementById('refundWizardCustomerSearch')
  if (search) search.value = ''
  document.getElementById('refundWizardModal')?.classList.add('active')
  renderRefundWizard()
}

export function closeRefundWizard() {
  document.getElementById('refundWizardModal')?.classList.remove('active')
}

function customersWithApprovedPayments() {
  const data = getData()
  const currentUser = getCurrentUser()
  return data.customers.filter(c => {
    if (c.id.startsWith('LD') && !hasPermission('customers_ld')) return false
    if (c.id.startsWith('CS') && !hasPermission('customers_cs')) return false
    if (!canViewScopedCustomer(c, currentUser) && !hasPermission('refunds_manage')) return false
    return (c.products || []).some(p => {
      ensureProductPayments(p)
      return getProductPayments(p).some(pay =>
        getPaymentEntryStatus(pay) === PAYMENT_STATUS.approved &&
        getPaymentRefundableRemaining(c.id, p, pay) > 0
      )
    })
  })
}

export function renderRefundWizard() {
  const step1 = document.getElementById('refundWizardStep1')
  const step2 = document.getElementById('refundWizardStep2')
  const step3 = document.getElementById('refundWizardStep3')
  if (step1) step1.hidden = wizard.step !== 1
  if (step2) step2.hidden = wizard.step !== 2
  if (step3) step3.hidden = wizard.step !== 3

  document.querySelectorAll('.refund-wizard-step-dot').forEach(el => {
    const s = Number(el.dataset.step)
    el.classList.toggle('active', s === wizard.step)
    el.classList.toggle('done', s < wizard.step)
  })

  const backBtn = document.getElementById('refundWizardBackBtn')
  const nextBtn = document.getElementById('refundWizardNextBtn')
  if (backBtn) backBtn.style.display = wizard.step > 1 ? '' : 'none'
  if (nextBtn) {
    nextBtn.textContent = wizard.step === 3 ? 'ثبت درخواست' : 'بعدی'
  }

  if (wizard.step === 1) renderWizardStep1()
  else if (wizard.step === 2) renderWizardStep2()
  else renderWizardStep3()
}

function renderWizardStep1() {
  const q = toEnDigits(document.getElementById('refundWizardCustomerSearch')?.value || '').trim().toLowerCase()
  const list = document.getElementById('refundWizardCustomerList')
  if (!list) return
  let customers = customersWithApprovedPayments()
  if (q) {
    customers = customers.filter(c => matchesTabSearch(q, [
      c.name, c.id, c.platformId, ...(getCustomerPhones(c) || []), c.advisor
    ]))
  }
  customers = customers.slice(0, 40)
  if (!customers.length) {
    list.innerHTML = `<div class="refund-wizard-empty">مشتری با واریز قابل عودت پیدا نشد</div>`
    return
  }
  list.innerHTML = customers.map(c => {
    const selected = wizard.customerId === c.id
    const phone = getPrimaryPhone(c) || '—'
    return `<button type="button" class="refund-wizard-pick${selected ? ' selected' : ''}"
      onclick="app.selectRefundWizardCustomer('${escapeAttr(c.id)}')">
      <strong>${escapeHtml(c.name || c.platformId || c.id)}</strong>
      <span dir="ltr">${escapeHtml(phone)}</span>
      <span class="refund-wizard-pick-meta">${escapeHtml(c.id)} · ${escapeHtml(c.advisor || '—')}</span>
    </button>`
  }).join('')
}

export function onRefundWizardCustomerSearch() {
  if (wizard.step === 1) renderWizardStep1()
}

export function selectRefundWizardCustomer(customerId) {
  wizard.customerId = customerId
  wizard.productIndex = null
  wizard.paymentId = null
  wizard.amount = 0
  renderRefundWizard()
}

function renderWizardStep2() {
  const list = document.getElementById('refundWizardPaymentList')
  if (!list) return
  const customer = getData().customers.find(c => c.id === wizard.customerId)
  if (!customer) {
    list.innerHTML = `<div class="refund-wizard-empty">مشتری انتخاب نشده</div>`
    return
  }
  const rows = []
  ;(customer.products || []).forEach((product, productIndex) => {
    ensureProductPayments(product)
    syncProductStatus(product)
    getProductPayments(product).forEach(pay => {
      if (getPaymentEntryStatus(pay) !== PAYMENT_STATUS.approved) return
      const remaining = getPaymentRefundableRemaining(customer.id, product, pay)
      if (remaining <= 0) return
      rows.push({ product, productIndex, pay, remaining })
    })
  })
  if (!rows.length) {
    list.innerHTML = `<div class="refund-wizard-empty">واریز قابل عودتی باقی نمانده</div>`
    return
  }
  list.innerHTML = rows.map(({ product, productIndex, pay, remaining }) => {
    const selected = wizard.paymentId === pay.id
    return `<button type="button" class="refund-wizard-pick${selected ? ' selected' : ''}"
      onclick="app.selectRefundWizardPayment(${productIndex}, '${escapeAttr(pay.id)}')">
      <strong>${escapeHtml(coerceProductName(product.name) || '—')}</strong>
      <span>${formatNumber(pay.amount)} ریال تأییدشده · قابل عودت: ${formatNumber(remaining)}</span>
      <span class="refund-wizard-pick-meta">${escapeHtml(formatSoldAt24h(pay.soldAt) || '—')} · ${escapeHtml(pay.depositorName || '—')}</span>
    </button>`
  }).join('')

  const amountWrap = document.getElementById('refundWizardAmountWrap')
  if (amountWrap) amountWrap.hidden = !wizard.paymentId
  if (wizard.paymentId) {
    const row = rows.find(r => r.pay.id === wizard.paymentId)
    const max = row?.remaining || 0
    const amountEl = document.getElementById('refundWizardAmount')
    if (amountEl && !amountEl.value) {
      amountEl.value = formatNumber(wizard.amount || max)
    }
    const maxHint = document.getElementById('refundWizardAmountMax')
    if (maxHint) maxHint.textContent = `سقف قابل عودت: ${formatNumber(max)} ریال`
  }
}

export function selectRefundWizardPayment(productIndex, paymentId) {
  wizard.productIndex = productIndex
  wizard.paymentId = paymentId
  const customer = getData().customers.find(c => c.id === wizard.customerId)
  const product = customer?.products?.[productIndex]
  const pay = product && getProductPayments(product).find(p => p.id === paymentId)
  const remaining = product && pay ? getPaymentRefundableRemaining(customer.id, product, pay) : 0
  wizard.amount = remaining
  const amountEl = document.getElementById('refundWizardAmount')
  if (amountEl) amountEl.value = formatNumber(remaining)
  renderWizardStep2()
}

export function setRefundWizardFullAmount() {
  const customer = getData().customers.find(c => c.id === wizard.customerId)
  const product = customer?.products?.[wizard.productIndex]
  const pay = product && getProductPayments(product).find(p => p.id === wizard.paymentId)
  if (!product || !pay) return
  const remaining = getPaymentRefundableRemaining(customer.id, product, pay)
  wizard.amount = remaining
  const amountEl = document.getElementById('refundWizardAmount')
  if (amountEl) amountEl.value = formatNumber(remaining)
}

function parseAmountInput(raw) {
  const n = parseFloat(toEnDigits(String(raw || '')).replace(/[^\d.]/g, ''))
  return Number.isFinite(n) ? Math.round(n) : 0
}

function renderWizardStep3() {
  const box = document.getElementById('refundWizardSummary')
  if (!box) return
  const customer = getData().customers.find(c => c.id === wizard.customerId)
  const product = customer?.products?.[wizard.productIndex]
  const pay = product && getProductPayments(product).find(p => p.id === wizard.paymentId)
  const amountEl = document.getElementById('refundWizardAmount')
  if (amountEl) wizard.amount = parseAmountInput(amountEl.value)
  const noteEl = document.getElementById('refundWizardNote')
  wizard.note = noteEl ? noteEl.value.trim() : ''

  box.innerHTML = `
    <div><strong>مشتری:</strong> ${escapeHtml(customer?.name || wizard.customerId || '—')}</div>
    <div><strong>محصول:</strong> ${escapeHtml(coerceProductName(product?.name) || '—')}</div>
    <div><strong>مبلغ عودت:</strong> <span dir="ltr">${formatNumber(wizard.amount)} ریال</span></div>
    <div><strong>تاریخ واریز:</strong> ${escapeHtml(formatSoldAt24h(pay?.soldAt) || '—')}</div>
    ${wizard.note ? `<div><strong>یادداشت:</strong> ${escapeHtml(wizard.note)}</div>` : ''}
  `
}

export function refundWizardBack() {
  if (wizard.step <= 1) return
  wizard.step -= 1
  renderRefundWizard()
}

export async function refundWizardNext() {
  if (wizard.step === 1) {
    if (!wizard.customerId) {
      showToast('مشتری را انتخاب کنید')
      return
    }
    wizard.step = 2
    renderRefundWizard()
    return
  }
  if (wizard.step === 2) {
    if (!wizard.paymentId) {
      showToast('واریز را انتخاب کنید')
      return
    }
    const amountEl = document.getElementById('refundWizardAmount')
    wizard.amount = parseAmountInput(amountEl?.value)
    const customer = getData().customers.find(c => c.id === wizard.customerId)
    const product = customer?.products?.[wizard.productIndex]
    const pay = product && getProductPayments(product).find(p => p.id === wizard.paymentId)
    const max = product && pay ? getPaymentRefundableRemaining(customer.id, product, pay) : 0
    if (wizard.amount <= 0) {
      showToast('مبلغ عودت نامعتبر است')
      return
    }
    if (wizard.amount > max) {
      showToast(`مبلغ نمی‌تواند بیشتر از ${formatNumber(max)} ریال باشد`)
      return
    }
    wizard.step = 3
    renderRefundWizard()
    return
  }

  await submitRefundWizard()
}

async function submitRefundWizard() {
  if (!requirePermission('refunds_manage')) return
  const customer = getData().customers.find(c => c.id === wizard.customerId)
  const product = customer?.products?.[wizard.productIndex]
  const pay = product && getProductPayments(product).find(p => p.id === wizard.paymentId)
  if (!customer || !product || !pay) {
    showToast('اطلاعات ناقص است')
    return
  }
  const max = getPaymentRefundableRemaining(customer.id, product, pay)
  const amount = wizard.amount
  if (amount <= 0 || amount > max) {
    showToast('مبلغ عودت نامعتبر است')
    return
  }
  const user = getCurrentUser()
  const phone = normalizePhone(user?.phone || '')
  const approved = parseFloat(pay.amount) || 0
  try {
    await saveRefundToDB({
      customerId: customer.id,
      productIndex: wizard.productIndex,
      productName: coerceProductName(product.name),
      paymentId: pay.id,
      amount,
      isFullPayment: amount >= approved - 0.5,
      status: REFUND_STATUS.requested,
      note: wizard.note || '',
      advisorPhone: getSaleRegistrantPhone(product, pay, customer),
      customerName: customer.name || customer.platformId || customer.id,
      createdByPhone: phone,
      createdByName: userDisplayName(user) || ''
    })
    closeRefundWizard()
    showToast('درخواست عودت ثبت شد')
    renderRefunds()
  } catch (e) {
    console.error(e)
    showToast(e.message || 'خطا در ثبت درخواست')
  }
}

/** Sum of completed refunds for dashboard card (date + advisor filters). */
export function sumCompletedRefundsForDash({ dateFromNum = 0, dateToNum = 99999999, advisorPhones = null } = {}) {
  let total = 0
  for (const r of getRefunds()) {
    if (r.status !== REFUND_STATUS.completed) continue
    if (advisorPhones instanceof Set) {
      const phone = normalizePhone(r.advisorPhone)
      if (!phone || !advisorPhones.has(phone)) continue
    }
    const jalali = r.completedAt ? gregorianToJalaliStr(r.completedAt) : ''
    const d = jalali ? jalaliToNum(jalaliDatePart(jalali)) : 0
    if (d && (d < dateFromNum || d > dateToNum)) continue
    if (!d && (dateFromNum > 0 || dateToNum < 99999999)) continue
    total += parseFloat(r.amount) || 0
  }
  return Math.round(total)
}

export { getProductRefundBadge }
