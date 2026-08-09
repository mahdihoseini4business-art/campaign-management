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
let rejectTargetId = null
let completeTargetId = null
let wizardBusy = false
let rejectBusy = false
let completeBusy = false
const movingRefundIds = new Set()

const REFUND_DRAG_THRESHOLD = 8
let refundDrag = null

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

function resolveAdvisorName(phone, users = []) {
  const p = normalizePhone(phone)
  if (!p) return '—'
  const list = Array.isArray(users) ? users : []
  const user = list.find(u => normalizePhone(u.phone) === p)
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
      String(r.customerId) === String(customerId) &&
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

function refundMatchesSearch(r, q, users = []) {
  if (!q) return true
  const customer = getData().customers.find(c => c.id === r.customerId)
  const phones = customer ? getCustomerPhones(customer).join(' ') : ''
  return matchesTabSearch(q, [
    r.customerName,
    r.customerId,
    r.productName,
    r.note,
    r.rejectReason,
    r.accountInfo,
    r.accountHolderName,
    r.sheba,
    r.cardNumber,
    phones,
    resolveAdvisorName(r.advisorPhone, users),
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

export async function renderRefunds() {
  if (!hasPermission('refunds_view') && !hasPermission('refunds_manage')) return
  if (refundDrag?.active) return

  let users = []
  try {
    users = await getUsersSafe()
  } catch (_) {
    users = []
  }

  const search = toEnDigits(document.getElementById('searchRefunds')?.value || '').trim().toLowerCase()
  const all = getVisibleRefunds().filter(r => refundMatchesSearch(r, search, users))
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
    renderRejectedTable(all.filter(r => r.status === REFUND_STATUS.rejected), users)
    return
  }

  REFUND_KANBAN_STATUSES.forEach(status => {
    const col = document.getElementById(`refundCol-${status}`)
    if (!col) return
    const items = all.filter(r => r.status === status)
    const countEl = document.getElementById(`refundColCount-${status}`)
    if (countEl) countEl.textContent = formatNumber(items.length)
    try {
      col.innerHTML = items.length
        ? items.map(r => renderRefundCard(r, canManage, users)).join('')
        : `<div class="refund-col-empty">موردی نیست</div>`
    } catch (e) {
      console.error('renderRefundCard error:', e)
      col.innerHTML = `<div class="refund-col-empty">خطا در نمایش کارت‌ها</div>`
    }
  })
}

function renderRefundCard(r, canManage, users = []) {
  const draggable = canManage && r.status !== REFUND_STATUS.completed
  const rejectBtn = canManage && (r.status === REFUND_STATUS.requested || r.status === REFUND_STATUS.awaiting)
    ? `<button type="button" class="btn btn-sm btn-reject" onclick="event.stopPropagation();app.openRejectRefundModal(${Number(r.id)})">رد</button>`
    : ''
  const statusSelect = canManage && r.status !== REFUND_STATUS.completed
    ? `<select class="refund-status-select" aria-label="تغییر وضعیت"
        onclick="event.stopPropagation()"
        onchange="app.onRefundStatusSelect(event, ${Number(r.id)})">
        ${REFUND_KANBAN_STATUSES.map(st =>
          `<option value="${st}"${r.status === st ? ' selected' : ''}>${escapeHtml(REFUND_STATUS_LABELS[st] || st)}</option>`
        ).join('')}
      </select>`
    : ''
  return `
    <div class="refund-card${draggable ? ' is-draggable' : ''}"
      data-refund-id="${escapeAttr(String(r.id))}"
      ${draggable ? `onpointerdown="app.onRefundCardPointerDown(event, ${Number(r.id)})"` : ''}>
      <div class="refund-card-title">${escapeHtml(r.customerName || r.customerId)}</div>
      <div class="refund-card-meta">${escapeHtml(r.productName || '—')}</div>
      <div class="refund-card-amount">${formatNumber(r.amount)} ریال</div>
      <div class="refund-card-meta">کارشناس: ${escapeHtml(resolveAdvisorName(r.advisorPhone, users))}</div>
      ${r.note ? `<div class="refund-card-note">${escapeHtml(r.note)}</div>` : ''}
      ${renderPayoutBlock(r)}
      <div class="refund-card-actions">${statusSelect}${rejectBtn}</div>
    </div>`
}

function onlyEnDigits(raw, max) {
  return toEnDigits(String(raw || '')).replace(/\D/g, '').slice(0, max)
}

function shebaDigits(raw) {
  let s = toEnDigits(String(raw || '')).replace(/[\s-]/g, '').toUpperCase()
  if (s.startsWith('IR')) s = s.slice(2)
  return s.replace(/\D/g, '').slice(0, 24)
}

function normalizeSheba(raw) {
  const digits = shebaDigits(raw)
  return digits ? ('IR' + digits) : ''
}

function normalizeCardNumber(raw) {
  return onlyEnDigits(raw, 16)
}

function restoreDigitCaret(el, prevValue, prevStart) {
  if (prevStart == null) return
  const diff = String(prevValue || '').length - el.value.length
  const next = Math.max(0, Math.min(el.value.length, prevStart - diff))
  try { el.setSelectionRange(next, next) } catch (_) { /* ignore */ }
}

const REFUND_DIGIT_NAV_KEYS = new Set([
  'Backspace', 'Delete', 'Tab', 'Enter', 'Escape',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'
])

export function onRefundDigitFieldKeydown(event, maxDigits) {
  if (event.ctrlKey || event.metaKey || event.altKey) return
  if (REFUND_DIGIT_NAV_KEYS.has(event.key)) return
  if (!/^[0-9\u06F0-\u06F9\u0660-\u0669]$/.test(event.key)) {
    event.preventDefault()
    return
  }
  const el = event.target
  if (!el) return
  const selected = Math.max(0, (el.selectionEnd ?? 0) - (el.selectionStart ?? 0))
  const digits = onlyEnDigits(el.value, maxDigits)
  if (selected <= 0 && digits.length >= maxDigits) event.preventDefault()
}

export function onRefundShebaInput(el) {
  if (!el) return
  const start = el.selectionStart
  const prev = el.value
  el.value = shebaDigits(el.value)
  restoreDigitCaret(el, prev, start)
}

export function onRefundCardInput(el) {
  if (!el) return
  const start = el.selectionStart
  const prev = el.value
  el.value = onlyEnDigits(el.value, 16)
  restoreDigitCaret(el, prev, start)
}

function formatCardDisplay(raw) {
  const digits = normalizeCardNumber(raw)
  return digits.replace(/(\d{4})(?=\d)/g, '$1 ').trim() || String(raw || '')
}

function isValidSheba(sheba) {
  return /^IR\d{24}$/i.test(sheba || '')
}

function isValidCardNumber(card) {
  return /^\d{16}$/.test(card || '')
}

const PAYOUT_FIELD_IDS = {
  wizard: {
    holder: 'refundWizardHolder',
    sheba: 'refundWizardSheba',
    card: 'refundWizardCard'
  },
  complete: {
    holder: 'completeRefundHolder',
    sheba: 'completeRefundSheba',
    card: 'completeRefundCard'
  }
}

function hasCompletePayoutFields(fields) {
  return !!(
    fields?.accountHolderName &&
    isValidSheba(fields?.sheba) &&
    isValidCardNumber(fields?.cardNumber)
  )
}

function readPayoutFields(ids) {
  const shebaEl = document.getElementById(ids.sheba)
  const cardEl = document.getElementById(ids.card)
  if (shebaEl) onRefundShebaInput(shebaEl)
  if (cardEl) onRefundCardInput(cardEl)
  return {
    accountHolderName: String(document.getElementById(ids.holder)?.value || '').trim(),
    sheba: normalizeSheba(shebaEl?.value),
    cardNumber: normalizeCardNumber(cardEl?.value)
  }
}

function clearPayoutFields(ids) {
  const holderEl = document.getElementById(ids.holder)
  const shebaEl = document.getElementById(ids.sheba)
  const cardEl = document.getElementById(ids.card)
  if (holderEl) holderEl.value = ''
  if (shebaEl) shebaEl.value = ''
  if (cardEl) cardEl.value = ''
}

function validatePayoutFields(payout, ids) {
  if (!payout.accountHolderName) {
    showToast('نام صاحب حساب را وارد کنید')
    document.getElementById(ids.holder)?.focus()
    return false
  }
  if (!payout.sheba) {
    showToast('شماره شبا را وارد کنید')
    document.getElementById(ids.sheba)?.focus()
    return false
  }
  if (!isValidSheba(payout.sheba)) {
    showToast('شماره شبا نامعتبر است')
    document.getElementById(ids.sheba)?.focus()
    return false
  }
  if (!payout.cardNumber) {
    showToast('شماره کارت را وارد کنید')
    document.getElementById(ids.card)?.focus()
    return false
  }
  if (!isValidCardNumber(payout.cardNumber)) {
    showToast('شماره کارت باید ۱۶ رقم باشد')
    document.getElementById(ids.card)?.focus()
    return false
  }
  return true
}

function composeAccountInfo(payout) {
  return [payout?.accountHolderName, payout?.sheba, payout?.cardNumber].filter(Boolean).join(' | ')
}

function resolvePayoutFields(refund, extra = {}) {
  return {
    accountHolderName: extra.accountHolderName != null
      ? String(extra.accountHolderName).trim()
      : String(refund?.accountHolderName || '').trim(),
    sheba: extra.sheba != null
      ? normalizeSheba(extra.sheba)
      : normalizeSheba(refund?.sheba || ''),
    cardNumber: extra.cardNumber != null
      ? normalizeCardNumber(extra.cardNumber)
      : normalizeCardNumber(refund?.cardNumber || '')
  }
}

function renderPayoutBlock(r) {
  if (r.accountHolderName || r.sheba || r.cardNumber) {
    return `<div class="refund-card-account">
      ${r.accountHolderName ? `<div><strong>صاحب حساب:</strong> ${escapeHtml(r.accountHolderName)}</div>` : ''}
      ${r.sheba ? `<div dir="ltr"><strong>شبا:</strong> ${escapeHtml(r.sheba)}</div>` : ''}
      ${r.cardNumber ? `<div dir="ltr"><strong>کارت:</strong> ${escapeHtml(formatCardDisplay(r.cardNumber))}</div>` : ''}
    </div>`
  }
  if (r.accountInfo) {
    return `<div class="refund-card-account"><strong>حساب:</strong> ${escapeHtml(r.accountInfo)}</div>`
  }
  return ''
}

function renderRejectedTable(items, users = []) {
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
      <td>${escapeHtml(resolveAdvisorName(r.advisorPhone, users))}</td>
      <td>${escapeHtml(r.rejectReason || '—')}</td>
      <td>${escapeHtml(r.createdByName || resolveAdvisorName(r.createdByPhone, users))}</td>
      <td style="font-size:12px;direction:ltr;">${escapeHtml(gregorianToJalaliStr(r.updatedAt) || '—')}</td>
    </tr>
  `).join('')
}

function setKanbanDragging(on) {
  document.getElementById('refundsKanban')?.classList.toggle('is-dragging-refund', !!on)
  document.body.classList.toggle('is-refund-dragging', !!on)
}

function statusFromRefundCol(el) {
  const wrap = el?.closest?.('.refund-col-wrap')
  const col = wrap?.querySelector?.('.refund-col') || el?.closest?.('.refund-col')
  const status = col?.id?.replace(/^refundCol-/, '') || ''
  return REFUND_KANBAN_STATUSES.includes(status) ? status : null
}

function highlightRefundDropCol(status) {
  document.querySelectorAll('.refund-col-wrap').forEach(wrap => {
    const col = wrap.querySelector('.refund-col')
    const colStatus = col?.id?.replace(/^refundCol-/, '')
    const on = !!status && colStatus === status
    wrap.classList.toggle('is-drop-target', on)
    col?.classList.toggle('is-drop-target', on)
  })
}

function cleanupRefundDrag() {
  window.removeEventListener('pointermove', onRefundPointerMove)
  window.removeEventListener('pointerup', onRefundPointerUp)
  window.removeEventListener('pointercancel', onRefundPointerUp)
  if (refundDrag?.ghost) refundDrag.ghost.remove()
  refundDrag?.card?.classList.remove('is-drag-placeholder')
  highlightRefundDropCol(null)
  setKanbanDragging(false)
  refundDrag = null
}

function beginRefundDragVisual(event) {
  const card = refundDrag.card
  const rect = card.getBoundingClientRect()
  refundDrag.offsetX = event.clientX - rect.left
  refundDrag.offsetY = event.clientY - rect.top
  refundDrag.active = true

  const ghost = card.cloneNode(true)
  ghost.classList.add('refund-card-ghost')
  ghost.classList.remove('is-draggable', 'is-drag-placeholder')
  ghost.removeAttribute('onpointerdown')
  ghost.querySelectorAll('select, button, textarea, input').forEach(el => {
    el.disabled = true
    el.removeAttribute('onchange')
    el.removeAttribute('onclick')
  })
  ghost.style.width = `${rect.width}px`
  ghost.style.left = `${rect.left}px`
  ghost.style.top = `${rect.top}px`
  document.body.appendChild(ghost)
  refundDrag.ghost = ghost

  card.classList.add('is-drag-placeholder')
  setKanbanDragging(true)
  try { card.setPointerCapture?.(event.pointerId) } catch (_) { /* ignore */ }
}

function updateRefundDragGhost(event) {
  if (!refundDrag?.ghost) return
  refundDrag.ghost.style.left = `${event.clientX - refundDrag.offsetX}px`
  refundDrag.ghost.style.top = `${event.clientY - refundDrag.offsetY}px`
}

function updateRefundDropTarget(event) {
  const status = statusFromRefundCol(document.elementFromPoint(event.clientX, event.clientY))
  refundDrag.overStatus = status
  highlightRefundDropCol(status)
}

function onRefundPointerMove(event) {
  if (!refundDrag) return
  if (refundDrag.pointerId != null && event.pointerId !== refundDrag.pointerId) return
  const dx = event.clientX - refundDrag.startX
  const dy = event.clientY - refundDrag.startY
  if (!refundDrag.active) {
    if (Math.hypot(dx, dy) < REFUND_DRAG_THRESHOLD) return
    beginRefundDragVisual(event)
  }
  event.preventDefault()
  updateRefundDragGhost(event)
  updateRefundDropTarget(event)
}

async function onRefundPointerUp(event) {
  if (!refundDrag) return
  if (refundDrag.pointerId != null && event.pointerId !== refundDrag.pointerId) return
  const wasActive = refundDrag.active
  const id = refundDrag.id
  const status = refundDrag.overStatus
  cleanupRefundDrag()
  if (!wasActive || !status) return
  await moveRefundStatus(id, status)
}

export function onRefundCardPointerDown(event, id) {
  if (!canManageRefunds()) return
  if (event.button != null && event.button !== 0) return
  if (event.target.closest('select, button, input, textarea, a, label')) return
  const card = event.currentTarget
  if (!card?.classList.contains('is-draggable')) return
  if (refundDrag) cleanupRefundDrag()

  refundDrag = {
    id,
    card,
    startX: event.clientX,
    startY: event.clientY,
    offsetX: 0,
    offsetY: 0,
    pointerId: event.pointerId,
    active: false,
    ghost: null,
    overStatus: null
  }
  window.addEventListener('pointermove', onRefundPointerMove, { passive: false })
  window.addEventListener('pointerup', onRefundPointerUp)
  window.addEventListener('pointercancel', onRefundPointerUp)
}

export async function onRefundStatusSelect(event, id) {
  if (!requirePermission('refunds_manage')) {
    await renderRefunds()
    return
  }
  const status = event.target?.value
  if (!REFUND_KANBAN_STATUSES.includes(status)) {
    await renderRefunds()
    return
  }
  const ok = await moveRefundStatus(id, status)
  if (!ok) await renderRefunds()
}

async function moveRefundStatus(id, nextStatus, extra = {}) {
  const key = String(id)
  if (movingRefundIds.has(key)) return false
  const refund = getRefunds().find(r => String(r.id) === key)
  if (!refund) {
    showToast('درخواست عودت پیدا نشد')
    return false
  }
  if (refund.status === nextStatus && !extra.rejectReason && extra.accountHolderName == null && extra.sheba == null && extra.cardNumber == null) return true
  if (refund.status === REFUND_STATUS.completed && nextStatus !== REFUND_STATUS.completed) {
    showToast('عودت انجام‌شده قابل جابجایی نیست')
    return false
  }

  if (nextStatus === REFUND_STATUS.completed && refund.status !== REFUND_STATUS.completed) {
    const payout = resolvePayoutFields(refund, extra)
    if (!hasCompletePayoutFields(payout)) {
      openCompleteRefundModal(id)
      return false
    }
    extra = { ...extra, ...payout, accountInfo: extra.accountInfo || composeAccountInfo(payout) }
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

  movingRefundIds.add(key)
  let wroteBack = false
  try {
    if (nextStatus === REFUND_STATUS.completed) {
      await writebackCompletedRefund({ ...refund, ...patch })
      wroteBack = true
    }
    await updateRefundInDB(id, patch)
    if (refund.status === REFUND_STATUS.completed && nextStatus !== REFUND_STATUS.completed) {
      await undoCompletedRefundWriteback(refund)
    }
    showToast(nextStatus === REFUND_STATUS.rejected ? 'درخواست رد شد' : 'وضعیت به‌روز شد')
    await renderRefunds()
    return true
  } catch (e) {
    console.error(e)
    if (wroteBack) {
      try { await undoCompletedRefundWriteback(refund) } catch (_) { /* ignore */ }
    }
    showToast(e.message || 'خطا در به‌روزرسانی')
    await renderRefunds()
    return false
  } finally {
    movingRefundIds.delete(key)
  }
}

async function writebackCompletedRefund(refund) {
  const data = getData()
  const customer = data.customers.find(c => c.id === refund.customerId)
  if (!customer) throw new Error('مشتری برای ثبت عودت پیدا نشد')
  const found = findProductAndPayment(customer, refund.paymentId, refund.productIndex)
  if (!found) throw new Error('محصول/واریز برای ثبت عودت پیدا نشد')
  const remaining = getPaymentRefundableRemaining(customer.id, found.product, found.payment, refund.id)
  const amount = parseFloat(refund.amount) || 0
  if (amount > remaining + 0.5) {
    throw new Error(`مبلغ عودت از سقف قابل عودت (${formatNumber(remaining)} ریال) بیشتر است`)
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
  syncProductStatus(found.product)
  await saveCustomerToDB(customer)
  try { renderProducts(customer.id) } catch (_) { /* ignore */ }
}

export function openCompleteRefundModal(id) {
  if (!requirePermission('refunds_manage')) return
  const refund = getRefunds().find(r => String(r.id) === String(id))
  if (!refund) {
    showToast('درخواست عودت پیدا نشد')
    return
  }
  completeTargetId = id
  const summary = document.getElementById('completeRefundSummary')
  if (summary) {
    summary.innerHTML = `
      <div><strong>مشتری:</strong> ${escapeHtml(refund.customerName || refund.customerId || '—')}</div>
      <div><strong>محصول:</strong> ${escapeHtml(refund.productName || '—')}</div>
      <div><strong>مبلغ عودت:</strong> <span dir="ltr">${formatNumber(refund.amount)} ریال</span></div>
    `
  }
  const holderEl = document.getElementById('completeRefundHolder')
  const shebaEl = document.getElementById('completeRefundSheba')
  const cardEl = document.getElementById('completeRefundCard')
  if (holderEl) holderEl.value = refund.accountHolderName || ''
  if (shebaEl) shebaEl.value = shebaDigits(refund.sheba)
  if (cardEl) cardEl.value = normalizeCardNumber(refund.cardNumber)
  holderEl?.focus()
  document.getElementById('completeRefundModal')?.classList.add('active')
}

export function closeCompleteRefundModal() {
  completeTargetId = null
  document.getElementById('completeRefundModal')?.classList.remove('active')
}

export async function confirmCompleteRefund() {
  if (completeBusy) return
  if (!requirePermission('refunds_manage')) return
  const payout = readPayoutFields(PAYOUT_FIELD_IDS.complete)
  if (!validatePayoutFields(payout, PAYOUT_FIELD_IDS.complete)) return
  const id = completeTargetId
  closeCompleteRefundModal()
  if (!id) return
  completeBusy = true
  const confirmBtn = document.getElementById('completeRefundConfirmBtn')
  if (confirmBtn) confirmBtn.disabled = true
  try {
    await moveRefundStatus(id, REFUND_STATUS.completed, {
      ...payout,
      accountInfo: composeAccountInfo(payout)
    })
  } finally {
    completeBusy = false
    if (confirmBtn) confirmBtn.disabled = false
  }
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
  if (rejectBusy) return
  if (!requirePermission('refunds_manage')) return
  const reason = toEnDigits(document.getElementById('rejectRefundReason')?.value || '').trim()
  if (!reason) {
    showToast('دلیل رد را وارد کنید')
    return
  }
  const id = rejectTargetId
  closeRejectRefundModal()
  if (!id) return
  rejectBusy = true
  try {
    await moveRefundStatus(id, REFUND_STATUS.rejected, { rejectReason: reason })
  } finally {
    rejectBusy = false
  }
}

// ============================================
// Wizard
// ============================================

export function openRefundWizard() {
  if (!requirePermission('refunds_manage')) return
  wizardBusy = false
  wizard.step = 1
  wizard.customerId = null
  wizard.productIndex = null
  wizard.paymentId = null
  wizard.amount = 0
  wizard.note = ''
  const search = document.getElementById('refundWizardCustomerSearch')
  if (search) search.value = ''
  const amountEl = document.getElementById('refundWizardAmount')
  if (amountEl) amountEl.value = ''
  const noteEl = document.getElementById('refundWizardNote')
  if (noteEl) noteEl.value = ''
  clearPayoutFields(PAYOUT_FIELD_IDS.wizard)
  const nextBtn = document.getElementById('refundWizardNextBtn')
  if (nextBtn) nextBtn.disabled = false
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
    const selected = String(wizard.paymentId) === String(pay.id)
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
    const row = rows.find(r => String(r.pay.id) === String(wizard.paymentId))
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
  const pay = product && getProductPayments(product).find(p => String(p.id) === String(paymentId))
  const remaining = product && pay ? getPaymentRefundableRemaining(customer.id, product, pay) : 0
  wizard.amount = remaining
  const amountEl = document.getElementById('refundWizardAmount')
  if (amountEl) amountEl.value = formatNumber(remaining)
  renderWizardStep2()
}

export function setRefundWizardFullAmount() {
  const customer = getData().customers.find(c => c.id === wizard.customerId)
  const product = customer?.products?.[wizard.productIndex]
  const pay = product && getProductPayments(product).find(p => String(p.id) === String(wizard.paymentId))
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
  const pay = product && getProductPayments(product).find(p => String(p.id) === String(wizard.paymentId))
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
  if (wizardBusy) return
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
    const pay = product && getProductPayments(product).find(p => String(p.id) === String(wizard.paymentId))
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
    document.getElementById('refundWizardHolder')?.focus()
    return
  }

  await submitRefundWizard()
}

function setWizardBusyUi(busy) {
  const nextBtn = document.getElementById('refundWizardNextBtn')
  if (nextBtn) nextBtn.disabled = !!busy
}

async function submitRefundWizard() {
  if (!requirePermission('refunds_manage')) return
  const customer = getData().customers.find(c => c.id === wizard.customerId)
  const product = customer?.products?.[wizard.productIndex]
  const pay = product && getProductPayments(product).find(p => String(p.id) === String(wizard.paymentId))
  if (!customer || !product || !pay) {
    showToast('اطلاعات ناقص است')
    return
  }
  const amountEl = document.getElementById('refundWizardAmount')
  if (amountEl) wizard.amount = parseAmountInput(amountEl.value)
  const noteEl = document.getElementById('refundWizardNote')
  wizard.note = noteEl ? noteEl.value.trim() : (wizard.note || '')
  const payout = readPayoutFields(PAYOUT_FIELD_IDS.wizard)
  if (!validatePayoutFields(payout, PAYOUT_FIELD_IDS.wizard)) return
  const max = getPaymentRefundableRemaining(customer.id, product, pay)
  const amount = wizard.amount
  if (amount <= 0 || amount > max) {
    showToast('مبلغ عودت نامعتبر است')
    return
  }
  const user = getCurrentUser()
  const phone = normalizePhone(user?.phone || '')
  const approved = parseFloat(pay.amount) || 0
  const alreadyRefunded = getPaymentRefundedAmount(product, pay.id)
  wizardBusy = true
  setWizardBusyUi(true)
  try {
    await saveRefundToDB({
      customerId: customer.id,
      productIndex: wizard.productIndex,
      productName: coerceProductName(product.name),
      paymentId: pay.id,
      amount,
      isFullPayment: (alreadyRefunded + amount) >= approved - 0.5,
      status: REFUND_STATUS.requested,
      note: wizard.note || '',
      accountHolderName: payout.accountHolderName,
      sheba: payout.sheba,
      cardNumber: payout.cardNumber,
      accountInfo: composeAccountInfo(payout),
      advisorPhone: getSaleRegistrantPhone(product, pay, customer),
      customerName: customer.name || customer.platformId || customer.id,
      createdByPhone: phone,
      createdByName: userDisplayName(user) || ''
    })
    closeRefundWizard()
    showToast('درخواست عودت ثبت شد')
    try {
      await renderRefunds()
    } catch (renderErr) {
      console.error('renderRefunds after create:', renderErr)
    }
  } catch (e) {
    console.error(e)
    showToast(e.message || 'خطا در ثبت درخواست')
  } finally {
    wizardBusy = false
    setWizardBusyUi(false)
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
