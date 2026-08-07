import { getData, saveCustomerToDB, deleteCustomerFromDB, deleteCustomerRowOnly, saveFollowupToDB, deleteFollowupFromDB, updateFollowupsCustomerId, saveSetting, generateId, peekNextId, getDestinationBanks, getSellableNames, getBundleByName, coerceProductName, getPlatforms, getStatuses, saveOwnershipTransferToDB, generateTransferBatchId, isRecentTransferredIn, isRecentTransferredOut, isUnreadTransferredIn } from './data.js'
import { getUsersSafe } from './auth.js'
import { loadGroupsData, buildGroupedAdvisorSelectHtml, phonesMatchingAdvisorFilter } from './groups.js'
import { updateTransferInboxBadge } from './transfers.js'
import { broadcastSaleToast, buildSaleToastPayload } from './sale-toasts.js'
import {
  toEnDigits, escapeHtml, escapeAttr, showToast, hasPermission, requirePermission,
  canViewCustomer, canManageCustomer, canTransferCustomer, getCurrentUser, formatNumber, jalaliToNum,
  getTodayJalaliStr, getTodayJalaliNum, jalaliAddDays, toJalali, ownsCustomer, isAdmin, canViewOrgWideData,
  canViewScopedCustomer, canAddSaleOnCustomer, canAddNoteOnCustomer, canScheduleFollowupOnCustomer, matchesTabSearch, getCustomerSearchExtras,
  resolveAdvisor, normalizePhone, userDisplayName, getPlatformLabels, getPlatformClass,
  getPlatformUrl, getLastActivity, hasRecentActivityByOther, findCustomerByPhone,
  getCustomerPhones, normalizeCustomerPhones, getPrimaryPhone, formatPhonesDisplay,
  MAX_CUSTOMER_PHONES, MAX_CUSTOMER_ADDRESSES,
  getCustomerAddresses, normalizeCustomerAddresses, appendCustomerAddressIfNew,
  isPhysicalSaleLine,
  getStatusLabels, getStatusClass,
  getNowJalaliDateTime, PAYMENT_STATUS_LABELS, createPayment,
  formatTeamFilterLabel,
  ensureProductPayments, syncProductStatus, getApprovedPaid, getOperationalBalance,
  getProductPayments, getPaymentEntryStatus, getWorstPaymentStatus,
  isPaymentFilled, isPaymentPristineDraft, areProductPaymentsFilled, isProductPriceLocked, isInvoiceClosed, PAYMENT_STATUS,
  computeCustomerLrfm, isProductCountableInSales, soldAtTimePart, formatSoldAt24h, normalizeTimeTo24h,
  CUSTOMER_LEVELS, formatCustomerLevel, parseCustomerLevel, resolveCustomerLevel, syncCustomerLevel,
  applyProfitSnapshotToProduct
} from './utils.js'
import { paginateList, renderPaginationBar } from './pagination.js'

/** Newest Jalali date first; stable tie-break on id. */
function sortFollowupsNewestFirst(list) {
  return [...list].sort((a, b) => {
    const diff = jalaliToNum(b.date) - jalaliToNum(a.date)
    if (diff !== 0) return diff
    return String(b.id || '').localeCompare(String(a.id || ''), undefined, { numeric: true })
  })
}

function populatePlatformDropdown(select) {
  if (!select) return
  const val = select.value
  select.innerHTML = getPlatforms().map(p => `<option value="${escapeAttr(p.key)}">${escapeHtml(p.label)}</option>`).join('')
  if (val) select.value = val
}

function populateStatusDropdown(select) {
  if (!select) return
  const val = select.value
  select.innerHTML = getStatuses().map(s => `<option value="${escapeAttr(s.key)}">${escapeHtml(s.label)}</option>`).join('')
  if (val) select.value = val
}

export { populatePlatformDropdown, populateStatusDropdown }

/** Phone-field check while creating/editing: ok | incomplete | own | blocked | transferable | taken | mergeable | duplicate */
let phoneFieldState = { status: 'ok', customer: null, lastActivity: null, index: 0 }
/** Pending LD→phone-owner merge awaiting modal confirm. */
let pendingMerge = null
/** Visible phone input slots in the active phone form (1–3). */
let phoneSlots = ['']
/** Which phone form is active: always the customer detail panel. */
let phoneFormMode = 'detail'
/** Address slots in customer detail ({ text, postalCode }). */
let addressSlots = [{ text: '', postalCode: '' }]

function phoneForm() {
  return {
    listId: 'detailPhonesList',
    errorId: 'detailPhoneError',
    hintId: 'detailPhoneHint',
    getEditId: () => document.getElementById('detailEditCustomerId')?.value || ''
  }
}

// ============================================
// Render Customers
// ============================================

export function getFilteredCustomers() {
  const data = getData()
  const search = toEnDigits(document.getElementById('searchCustomers')?.value || '').toLowerCase()
  const advisorFilter = document.getElementById('filterAdvisor')?.value || ''
  const platformFilter = document.getElementById('filterPlatform')?.value || ''
  const statusFilter = document.getElementById('filterStatus')?.value || ''
  const levelFilter = document.getElementById('filterCustomerLevel')?.value || ''
  const transferFilter = document.getElementById('filterTransferIn')?.value || ''
  const currentUser = getCurrentUser()
  const advisorScopePhones = phonesMatchingAdvisorFilter(advisorFilter, currentUser)
  const myPhone = normalizePhone(currentUser?.phone)

  return data.customers.filter(c => {
    const extras = getCustomerSearchExtras(c)
    const phones = getCustomerPhones(c)
    const matchesSearch = matchesTabSearch(search, [
      c.id,
      c.name,
      ...phones,
      c.advisor,
      c.platformId,
      ...extras.products,
      ...extras.depositors
    ])

    if (!matchesSearch) return false

    const isCS = c.id.startsWith('CS')
    const isLD = c.id.startsWith('LD')
    if (isCS && !hasPermission('customers_cs')) return false
    if (isLD && !hasPermission('customers_ld')) return false

    const matchesTransferIn = (transferFilter === 'recent' || transferFilter === 'in')
      ? isRecentTransferredIn(c.id, myPhone, 7)
      : false
    const matchesTransferOut = transferFilter === 'out'
      ? isRecentTransferredOut(c.id, myPhone, 7)
      : false
    const matchesTransferFilter = transferFilter === 'out'
      ? matchesTransferOut
      : (transferFilter === 'recent' || transferFilter === 'in')
        ? matchesTransferIn
        : false

    // Normal scope, unless this row matches an active transfer filter (e.g. sender after handoff).
    if (!search && !canViewScopedCustomer(c, currentUser)) {
      if (!transferFilter || !matchesTransferFilter) return false
    }

    if (advisorScopePhones) {
      const owner = normalizePhone(c.advisorPhone)
      if (!owner || !advisorScopePhones.has(owner)) return false
    }
    if (platformFilter && c.platform !== platformFilter) return false
    if (statusFilter && c.status !== statusFilter) return false
    if (levelFilter) {
      const resolved = resolveCustomerLevel(c, data.customers, data.followups)
      if (resolved !== levelFilter) return false
    }
    if (transferFilter && !matchesTransferFilter) return false
    return true
  })
}

function populateCustomerFilterDropdowns() {
  const platformSelect = document.getElementById('filterPlatform')
  if (platformSelect) {
    const val = platformSelect.value
    platformSelect.innerHTML = '<option value="">همه پلتفرم‌ها</option>' +
      getPlatforms().map(p => `<option value="${escapeAttr(p.key)}">${escapeHtml(p.label)}</option>`).join('')
    platformSelect.value = val
  }
  const statusSelect = document.getElementById('filterStatus')
  if (statusSelect) {
    const val = statusSelect.value
    statusSelect.innerHTML = '<option value="">همه وضعیت‌ها</option>' +
      getStatuses().map(s => `<option value="${escapeAttr(s.key)}">${escapeHtml(s.label)}</option>`).join('')
    statusSelect.value = val
  }
  const levelSelect = document.getElementById('filterCustomerLevel')
  if (levelSelect) {
    const val = levelSelect.value
    levelSelect.innerHTML = '<option value="">همه سطوح</option>' +
      Object.values(CUSTOMER_LEVELS).map(l => `<option value="${escapeAttr(l.key)}">${l.emoji} ${escapeHtml(l.label)}</option>`).join('')
    levelSelect.value = val
  }
}

export async function renderCustomers() {
  const data = getData()
  const tbody = document.getElementById('customerBody')
  if (!tbody) return
  const search = toEnDigits(document.getElementById('searchCustomers').value).toLowerCase()
  const advisorFilter = document.getElementById('filterAdvisor').value
  const transferFilter = document.getElementById('filterTransferIn')?.value || ''

  populateCustomerFilterDropdowns()

  const currentUser = getCurrentUser()
  const myPhone = normalizePhone(currentUser?.phone)
  const filtered = getFilteredCustomers()

  const showSelectCol = hasPermission('customers_delete') || hasPermission('customers_transfer')
  const colCount = showSelectCol ? 11 : 10
  const selectTh = document.querySelector('#sheet-customers thead th.customer-select-col')
  if (selectTh) selectTh.style.display = showSelectCol ? '' : 'none'

  updateTransferInboxBadge()

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="${colCount}">
        <div class="empty-state">
          <div class="icon">👤</div>
          <h3>مشتری‌ای یافت نشد</h3>
          <p>مشتری جدید اضافه کنید</p>
        </div>
      </td></tr>`
    renderPaginationBar('customerPagination', 'customers', { total: 0, from: 0, to: 0, page: 1, totalPages: 1 })
    updateStats()
    // Still update advisor dropdown in background
    updateAdvisorDropdown()
    return
  }

  const filterSig = `${search}|${advisorFilter}|${transferFilter}`
  const page = paginateList('customers', filtered, filterSig)

  tbody.innerHTML = page.items.map(c => {
    const platformClass = getPlatformClass(c.platform)
    const platformLabel = getPlatformLabels()[c.platform] || c.platform
    const statusClass = getStatusClass(c.status)
    const statusLabel = getStatusLabels()[c.status] || c.status
    const canSelect = showSelectCol && (
      (hasPermission('customers_delete') && canManageCustomer(c, currentUser)) ||
      canTransferCustomer(c, currentUser)
    )
    const isMine = ownsCustomer(c, currentUser) || canViewOrgWideData()
    const transferredIn = isRecentTransferredIn(c.id, myPhone, 7)
    const transferredUnread = transferredIn && isUnreadTransferredIn(c.id, myPhone, 7)
    const transferredOut = isRecentTransferredOut(c.id, myPhone, 7) && !transferredIn
    const selectCell = showSelectCol
      ? `<td>${canSelect ? `<input type="checkbox" data-id="${escapeAttr(c.id)}" onchange="app.toggleRowSelect('customers', '${escapeAttr(c.id)}', this.checked)">` : ''}</td>`
      : ''

    const platformUrl = getPlatformUrl(c.platform, c.platformId, getPrimaryPhone(c))
    const platformIdHtml = platformUrl
      ? `<a href="${platformUrl}" target="_blank" rel="noopener" style="font-family:'Vazirmatn',sans-serif;font-size:13px;color:var(--accent);text-decoration:none;border-bottom:1px dashed var(--accent);">${escapeHtml(c.platformId)}</a>`
      : `<span style="font-family:'Vazirmatn',sans-serif;font-size:13px;">${escapeHtml(c.platformId)}</span>`

    const followupCount = data.followups.filter(f => f.customerId === c.id).length
    let countClass = 'followup-none'
    if (followupCount >= 5) countClass = 'followup-high'
    else if (followupCount >= 3) countClass = 'followup-mid'
    else if (followupCount >= 1) countClass = 'followup-low'

    const customerFollowups = sortFollowupsNewestFirst(
      data.followups.filter(f => f.customerId === c.id)
    )
    const lastDate = customerFollowups.length > 0 ? customerFollowups[0].date : '—'
    const lastNote = customerFollowups.length > 0 ? customerFollowups[0].notes : ''

    let nextFollowupHtml = '<span style="color:var(--text-muted)">—</span>'
    let nextFollowupClass = ''
    if (c.nextFollowupDate) {
      const todayN = getTodayJalaliNum()
      const dateN = jalaliToNum(c.nextFollowupDate)
      const in3N = jalaliAddDays(getTodayJalaliStr(), 3)
      if (dateN < todayN) {
        nextFollowupHtml = `<span class="settlement-badge settlement-overdue-badge">⚠ ${c.nextFollowupDate}</span>`
        nextFollowupClass = 'settlement-overdue'
      } else if (dateN <= in3N) {
        nextFollowupHtml = `<span class="settlement-badge settlement-soon-badge">${c.nextFollowupDate}</span>`
        nextFollowupClass = 'settlement-soon'
      } else {
        nextFollowupHtml = `<span style="font-family:'Vazirmatn',sans-serif;font-size:13px;">${c.nextFollowupDate}</span>`
      }
    }

    const nameBadges = [
      !isMine ? '<span class="owner-badge">همکار</span>' : '',
      transferredIn
        ? `<span class="transfer-in-badge${transferredUnread ? ' is-unread' : ''}" title="تازه‌منتقل‌شده به شما">منتقل‌شده</span>`
        : '',
      transferredOut
        ? '<span class="transfer-out-badge" title="تازه‌ارسال‌شده توسط شما">ارسال‌شده</span>'
        : ''
    ].join('')

    return `<tr class="clickable-row ${nextFollowupClass}${isMine ? '' : ' row-other-owner'}${transferredIn ? ' row-transferred-in' : ''}${transferredOut ? ' row-transferred-out' : ''}" onclick="app.onCustomerRowClick(event, '${escapeAttr(c.id)}')">
      ${selectCell}
      <td>${platformIdHtml}</td>
      <td><span class="platform-icon"><span class="platform-dot ${platformClass}"></span>${escapeHtml(platformLabel)}</span></td>
      <td>${escapeHtml(c.name) || '<span style="color:var(--text-muted)">—</span>'}${nameBadges}</td>
      <td style="font-family: monospace; direction: ltr; text-align: right;">${(() => {
        const disp = formatPhonesDisplay(c)
        if (!disp.text) return '<span style="color:var(--text-muted)">—</span>'
        const extra = disp.extra > 0
          ? ` <span style="color:var(--text-muted);font-size:11px;" title="${escapeAttr(disp.phones.slice(1).join('، '))}">+${disp.extra}</span>`
          : ''
        return `${escapeHtml(disp.text)}${extra}`
      })()}</td>
      <td><span class="status-badge ${statusClass}">${escapeHtml(statusLabel)}</span></td>
      <td style="font-size:12px;">${escapeHtml(c.advisor) || '<span style="color:var(--text-muted)">—</span>'}</td>
      <td style="text-align:center;"><span class="followup-count ${countClass}">${followupCount}</span></td>
      <td style="font-size:13px;color:var(--text-muted);">${escapeHtml(lastDate)}</td>
      <td style="font-size:12px;">${nextFollowupHtml}</td>
      <td class="notes-cell" title="${escapeHtml(lastNote || c.notes)}">${escapeHtml(lastNote || c.notes) || '<span style="color:var(--text-muted)">—</span>'}</td>
    </tr>`
  }).join('')

  renderPaginationBar('customerPagination', 'customers', page)
  updateStats()
  // Update advisor dropdown in background (non-blocking)
  updateAdvisorDropdown()
}

async function updateAdvisorDropdown() {
  const advisorSelect = document.getElementById('filterAdvisor')
  if (!advisorSelect) return
  const currentVal = advisorSelect.value
  const users = await getUsersSafe()
  const currentUser = getCurrentUser()
  try { await loadGroupsData() } catch (_) { /* optional until migration */ }
  advisorSelect.innerHTML = buildGroupedAdvisorSelectHtml({
    users,
    selectedValue: currentVal,
    teamLabel: formatTeamFilterLabel(currentUser)
  })
  if (![...advisorSelect.options].some(o => o.value === currentVal)) {
    advisorSelect.value = ''
  } else {
    advisorSelect.value = currentVal
  }
}

export function updateStats() {
  const data = getData()
  const currentUser = getCurrentUser()

  function inScope(c) {
    if (c.id.startsWith('LD') && !hasPermission('customers_ld')) return false
    if (c.id.startsWith('CS') && !hasPermission('customers_cs')) return false
    if (!canViewScopedCustomer(c, currentUser)) return false
    return true
  }

  function hasPurchase(c) {
    return (c.products || []).some(p => {
      ensureProductPayments(p)
      return isProductCountableInSales(p)
    })
  }

  const scoped = data.customers.filter(inScope)

  // کل مخاطبین = همه ثبت‌شده‌ها در اسکوپ
  document.getElementById('stat-total').textContent = scoped.length
  // کل مشتریان = کسانی که فروش/خرید ثبت‌شده دارند
  document.getElementById('stat-ld').textContent = scoped.filter(hasPurchase).length
  document.getElementById('stat-cs').textContent = scoped.filter(c => c.id.startsWith('CS')).length
  document.getElementById('stat-following').textContent = scoped.filter(c =>
    data.followups.some(f => f.customerId === c.id)
  ).length
  document.getElementById('stat-converted').textContent = canViewOrgWideData() ? (data.convertedCount || 0) : 0

  let totalPaid = 0
  scoped.forEach(c => {
    ;(c.products || []).forEach(p => {
      ensureProductPayments(p)
      syncProductStatus(p)
      totalPaid += getApprovedPaid(p)
    })
  })
  document.getElementById('stat-revenue').textContent = formatNumber(totalPaid) + ' ریال'
}

// ============================================
// Customer Modal
// ============================================

export async function openCustomerModal(editId) {
  if (editId) {
    openCustomerDetail(editId)
    return
  }
  if (!requirePermission('customers_add')) return
  openCustomerDetail(null)
}

function syncPhoneSlotsFromDom() {
  const { listId } = phoneForm()
  const inputs = document.querySelectorAll(`#${listId} .customer-phone-input`)
  if (!inputs.length) return
  phoneSlots = Array.from(inputs).map(el => el.value)
}

function getFormPhonesRaw() {
  syncPhoneSlotsFromDom()
  return phoneSlots.map(v => String(v || '').trim()).filter(Boolean)
}

function getFormPhones() {
  return normalizeCustomerPhones(getFormPhonesRaw())
}

function renderPhoneFields() {
  const { listId } = phoneForm()
  const container = document.getElementById(listId)
  if (!container) return
  if (!phoneSlots.length) phoneSlots = ['']

  container.innerHTML = phoneSlots.map((val, i) => `
      <div class="phone-field-row" data-index="${i}">
        <input type="tel" inputmode="numeric" class="form-input customer-phone-input" data-index="${i}"
          placeholder="09123456789" dir="ltr" style="text-align:left;" autocomplete="tel" maxlength="11"
          value="${escapeAttr(val || '')}"
          oninput="app.onCustomerPhoneInput(${i})">
        <div class="phone-field-actions"></div>
      </div>
    `).join('')
  updatePhoneFieldActions()
}

/** Keep only digits; if starts with 9 prepend 0; cap at 11. */
function sanitizePhoneInput(raw) {
  let digits = toEnDigits(String(raw || '')).replace(/\D/g, '')
  if (digits.startsWith('9')) digits = '0' + digits
  if (digits.length > 11) digits = digits.slice(0, 11)
  return digits
}

function caretDigitOffset(value, caret) {
  const before = String(value || '').slice(0, Math.max(0, caret || 0))
  return toEnDigits(before).replace(/\D/g, '').length
}

function updatePhoneFieldActions() {
  const { listId } = phoneForm()
  const container = document.getElementById(listId)
  if (!container) return

  phoneSlots.forEach((val, i) => {
    const row = container.querySelector(`.phone-field-row[data-index="${i}"]`)
    const actions = row?.querySelector('.phone-field-actions')
    if (!actions) return
    const normalized = normalizePhone(val)
    const isValid = /^09\d{9}$/.test(normalized)
    const canAdd = i === phoneSlots.length - 1
      && phoneSlots.length < MAX_CUSTOMER_PHONES
      && isValid
    const canRemove = phoneSlots.length > 1
    actions.innerHTML = `
      ${canAdd ? `<button type="button" class="btn-icon" title="افزودن شماره" onclick="app.addCustomerPhoneSlot()">+</button>` : ''}
      ${canRemove ? `<button type="button" class="btn-icon is-danger" title="حذف شماره" onclick="app.removeCustomerPhoneSlot(${i})">×</button>` : ''}
    `
  })
}

export function addCustomerPhoneSlot() {
  syncPhoneSlotsFromDom()
  if (phoneSlots.length >= MAX_CUSTOMER_PHONES) return
  const last = normalizePhone(phoneSlots[phoneSlots.length - 1])
  if (!/^09\d{9}$/.test(last)) {
    showToast('ابتدا شماره فعلی را به‌درستی وارد کنید')
    return
  }
  phoneSlots.push('')
  renderPhoneFields()
  const { listId } = phoneForm()
  const inputs = document.querySelectorAll(`#${listId} .customer-phone-input`)
  inputs[inputs.length - 1]?.focus()
}

export function removeCustomerPhoneSlot(index) {
  syncPhoneSlotsFromDom()
  if (phoneSlots.length <= 1) return
  phoneSlots.splice(index, 1)
  renderPhoneFields()
  validateCustomerPhones()
  updatePreviewId()
}

function clearPhoneFieldMessages() {
  const { listId, errorId, hintId } = phoneForm()
  document.querySelectorAll(`#${listId} .customer-phone-input`).forEach(el => {
    el.classList.remove('is-invalid')
  })
  const err = document.getElementById(errorId)
  const hint = document.getElementById(hintId)
  if (err) { err.hidden = true; err.textContent = '' }
  if (hint) { hint.hidden = true; hint.textContent = ''; hint.className = 'form-hint' }
}

function setPhoneFieldError(message, index = null) {
  const { listId, errorId, hintId } = phoneForm()
  document.querySelectorAll(`#${listId} .customer-phone-input`).forEach(el => {
    el.classList.remove('is-invalid')
  })
  if (index != null) {
    const input = document.querySelector(`#${listId} .customer-phone-input[data-index="${index}"]`)
    if (input) input.classList.add('is-invalid')
  } else {
    document.querySelectorAll(`#${listId} .customer-phone-input`).forEach(el => {
      if (el.value.trim()) el.classList.add('is-invalid')
    })
  }
  const err = document.getElementById(errorId)
  const hint = document.getElementById(hintId)
  if (hint) { hint.hidden = true; hint.textContent = '' }
  if (err) { err.hidden = false; err.textContent = message }
}

function setPhoneFieldHint(message, kind = 'info') {
  const { listId, errorId, hintId } = phoneForm()
  document.querySelectorAll(`#${listId} .customer-phone-input`).forEach(el => {
    el.classList.remove('is-invalid')
  })
  const err = document.getElementById(errorId)
  const hint = document.getElementById(hintId)
  if (err) { err.hidden = true; err.textContent = '' }
  if (hint) {
    hint.hidden = false
    hint.textContent = message
    hint.className = `form-hint is-${kind}`
  }
}

function formatActivityLabel(act) {
  if (!act) return 'بدون فعالیت ثبت‌شده'
  return `${act.dateStr} (${act.label})`
}

/** Sanitize typed phone value in-place without rebuilding the field. */
export function onCustomerPhoneInput(index = 0) {
  const { listId } = phoneForm()
  const input = document.querySelector(`#${listId} .customer-phone-input[data-index="${index}"]`)
  if (input) {
    const prev = input.value
    const caret = input.selectionStart
    const digitsBefore = caretDigitOffset(prev, caret)
    const startedWithNine = toEnDigits(prev).replace(/\D/g, '').startsWith('9')
    const sanitized = sanitizePhoneInput(prev)
    if (sanitized !== prev) {
      input.value = sanitized
      let newCaret = digitsBefore
      if (startedWithNine && sanitized.startsWith('0')) newCaret = Math.min(sanitized.length, digitsBefore + 1)
      try { input.setSelectionRange(newCaret, newCaret) } catch (_) { /* ignore */ }
    }
    while (phoneSlots.length <= index) phoneSlots.push('')
    phoneSlots[index] = sanitized
  } else {
    syncPhoneSlotsFromDom()
  }

  updatePhoneFieldActions()
  validateCustomerPhones()
}

/** Live validation for create/edit phone fields (no DOM rebuild / no focus steal). */
function validateCustomerPhones() {
  const data = getData()
  const currentUser = getCurrentUser()
  const editId = phoneForm().getEditId()

  clearPhoneFieldMessages()
  phoneFieldState = { status: 'ok', customer: null, lastActivity: null, index: 0 }

  const rawSlots = phoneSlots.map(v => String(v || '').trim())
  const normalizedSlots = rawSlots.map(v => (v ? normalizePhone(v) : ''))

  // Intra-form duplicate check
  const seen = new Map()
  for (let i = 0; i < normalizedSlots.length; i++) {
    const phone = normalizedSlots[i]
    if (!phone) continue
    if (!/^09\d{9}$/.test(phone)) {
      phoneFieldState = { status: 'incomplete', customer: null, lastActivity: null, index: i }
      if (phone.length >= 11 || (rawSlots[i].length >= 10 && !phone.startsWith('09'))) {
        setPhoneFieldError('فرمت شماره موبایل صحیح نیست (مثال: ۰۹۱۲۳۴۵۶۷۸۹)', i)
      }
      updatePreviewId()
      return
    }
    if (seen.has(phone)) {
      phoneFieldState = { status: 'duplicate', customer: null, lastActivity: null, index: i }
      setPhoneFieldError('این شماره دوبار در همین فرم وارد شده است', i)
      updatePreviewId()
      return
    }
    seen.set(phone, i)
  }

  // Cross-customer checks — evaluate first conflict found
  for (let i = 0; i < normalizedSlots.length; i++) {
    const phone = normalizedSlots[i]
    if (!phone || !/^09\d{9}$/.test(phone)) continue

    const existing = findCustomerByPhone(phone, data.customers, editId || null)
    if (!existing) continue

    const lastActivity = getLastActivity(existing, data.followups)
    phoneFieldState.customer = existing
    phoneFieldState.lastActivity = lastActivity
    phoneFieldState.index = i

    if (editId) {
      // LD + phone owned by another customer → offer merge (not hard block)
      if (String(editId).startsWith('LD')) {
        phoneFieldState.status = 'mergeable'
        setPhoneFieldHint(
          `این شماره متعلق به مشتری ${existing.id} است. با ذخیره، ${editId} با آن ادغام می‌شود` +
          (lastActivity ? ` — آخرین فعالیت: ${formatActivityLabel(lastActivity)}` : ''),
          'warning'
        )
        updatePreviewId()
        return
      }
      phoneFieldState.status = 'taken'
      setPhoneFieldError(
        `این شماره از قبل برای مشتری ${existing.id} ثبت شده است` +
        (lastActivity ? ` — آخرین فعالیت: ${formatActivityLabel(lastActivity)}` : ''),
        i
      )
      updatePreviewId()
      return
    }

    if (ownsCustomer(existing, currentUser)) {
      phoneFieldState.status = 'own'
      setPhoneFieldError(
        `مشتری با این شماره از قبل متعلق به شماست (${existing.id})` +
        (lastActivity ? `. آخرین فعالیت: ${formatActivityLabel(lastActivity)}` : ''),
        i
      )
      updatePreviewId()
      return
    }

    const recentOther = hasRecentActivityByOther(existing, data.followups, currentUser?.phone, 30)
    if (recentOther) {
      phoneFieldState.status = 'blocked'
      setPhoneFieldError(
        `مشتری با این شماره از قبل وجود دارد و در ۳۰ روز اخیر توسط کارشناس دیگری روی آن فعالیت ثبت شده؛ امکان ثبت/انتقال نیست. آخرین فعالیت: ${formatActivityLabel(lastActivity)}`,
        i
      )
      updatePreviewId()
      return
    }

    phoneFieldState.status = 'transferable'
    setPhoneFieldHint(
      `مشتری با این شماره از قبل وجود دارد (کارشناس فعلی: ${existing.advisor || '—'}، ${existing.id}). ` +
      `آخرین فعالیت: ${formatActivityLabel(lastActivity)}. با ذخیره، مشتری و تمام گزارش‌ها به کارشناس انتخاب‌شده منتقل می‌شود.`,
      'warning'
    )
    updatePreviewId()
    return
  }

  phoneFieldState.status = 'ok'
  updatePreviewId()
}

async function updatePreviewId() {
  if (phoneForm().getEditId()) return
  const phones = getFormPhones()
  const type = phones.length ? 'CS' : 'LD'
  const display = document.getElementById('detailIdDisplay')
  const hint = document.getElementById('detailIdHint')
  if (!display || !hint) return
  display.value = await peekNextId(type)
  hint.textContent = phones.length
    ? 'شماره وارد شد → مشتری (CS)'
    : 'بدون شماره → لید (LD)'
}

export function closeCustomerModal() {
  closeDetailModal()
}

/** @deprecated Create/edit now happens in the detail panel via saveCustomerDetail. */
export async function saveCustomer() {
  return saveCustomerDetail(phoneForm().getEditId() || '')
}

/**
 * Persist edited customer fields (incl. LD↔CS conversion).
 * @returns {{ id: string, toast: string }}
 */
async function applyCustomerEdit(editId, fields) {
  const { platformId, platform, name, phones, addresses, status, notes, advisor, advisorPhone } = fields
  const phoneFields = { phone: phones[0] || '', phones }
  const addressFields = { addresses: normalizeCustomerAddresses(addresses || []) }
  const advisorFields = { advisor, advisorPhone }
  const data = getData()

  for (const p of phones) {
    const dupByPhone = findCustomerByPhone(p, data.customers, editId)
    if (dupByPhone) {
      const err = new Error(`این شماره از قبل برای مشتری ${dupByPhone.id} ثبت شده و قابل تغییر نیست`)
      err.code = 'phone_taken'
      throw err
    }
  }

  const dupById = platformId && data.customers.find(c => c.id !== editId && c.platformId && c.platformId.toLowerCase() === platformId.toLowerCase())
  if (dupById) {
    const err = new Error(`این ایدی متعلق به مشتری ${dupById.id} است`)
    err.code = 'platform_taken'
    throw err
  }

  const idx = data.customers.findIndex(c => c.id === editId)
  if (idx === -1) throw new Error('مشتری یافت نشد')

  const oldCustomer = data.customers[idx]
  if (!canManageCustomer(oldCustomer)) {
    throw new Error('فقط کارشناس مسئول می‌تواند این مشتری را ویرایش کند')
  }

  const wasLD = oldCustomer.id.startsWith('LD')
  const nowHasPhone = phones.length > 0
  const advisorChanged = normalizePhone(oldCustomer.advisorPhone) !== normalizePhone(advisorPhone)
  // Keep previous owner until after conversion; reassign logs the handoff separately
  const baseFields = advisorChanged
    ? { platformId, platform, name, ...phoneFields, ...addressFields, status, notes, advisor: oldCustomer.advisor, advisorPhone: oldCustomer.advisorPhone }
    : { platformId, platform, name, ...phoneFields, ...addressFields, status, notes, ...advisorFields }

  let resultId = editId
  let toast = 'اطلاعات مشتری ذخیره شد'

  if (wasLD && nowHasPhone) {
    const newId = await generateId('CS')
    await saveCustomerToDB({ ...oldCustomer, id: newId, ...baseFields })
    await updateFollowupsCustomerId(oldCustomer.id, newId)
    await saveSetting('convertedCount', (data.convertedCount || 0) + 1)
    data.customers[idx] = { ...oldCustomer, id: newId, ...baseFields }
    data.followups.forEach(f => { if (f.customerId === oldCustomer.id) f.customerId = newId })
    data.convertedCount = (data.convertedCount || 0) + 1
    resultId = newId
    toast = `شماره ثبت شد — ${oldCustomer.id} تبدیل شد به ${newId}`
  } else if (!wasLD && !nowHasPhone && oldCustomer.id.startsWith('CS')) {
    const newId = await generateId('LD')
    await saveCustomerToDB({ ...oldCustomer, id: newId, ...baseFields })
    await updateFollowupsCustomerId(oldCustomer.id, newId)
    data.customers[idx] = { ...oldCustomer, id: newId, ...baseFields }
    data.followups.forEach(f => { if (f.customerId === oldCustomer.id) f.customerId = newId })
    resultId = newId
    toast = `شماره حذف شد — ${oldCustomer.id} تبدیل شد به ${newId}`
  } else if (!advisorChanged) {
    const updated = { ...oldCustomer, ...baseFields }
    await saveCustomerToDB(updated)
    data.customers[idx] = updated
  }

  if (advisorChanged) {
    const current = data.customers.find(c => c.id === resultId) || oldCustomer
    await reassignCustomerOwnership({
      customer: current,
      toAdvisor: advisor,
      toAdvisorPhone: advisorPhone,
      reason: 'handoff',
      fieldOverrides: { platformId, platform, name, ...phoneFields, ...addressFields, status, notes },
      skipPermissionCheck: true
    })
  }

  return { id: resultId, toast }
}

async function transferCustomerOwnership(existing, fields, users) {
  const data = getData()
  const currentUser = getCurrentUser()
  const idx = data.customers.findIndex(c => c.id === existing.id)
  if (idx === -1) { showToast('مشتری یافت نشد'); return }

  if (hasRecentActivityByOther(existing, data.followups, currentUser?.phone, 30)) {
    onCustomerPhoneInput()
    showToast('امکان انتقال نیست؛ اخیراً توسط کارشناس دیگری فعالیت ثبت شده')
    return
  }

  const { advisor, advisorPhone } = fields
  const phones = normalizeCustomerPhones(fields.phones || fields.phone || existing)
  const fieldOverrides = {
    platformId: fields.platformId || existing.platformId,
    platform: fields.platform || existing.platform,
    name: fields.name || existing.name,
    phones,
    phone: phones[0] || '',
    status: fields.status || existing.status,
    notes: fields.notes !== undefined && fields.notes !== '' ? fields.notes : existing.notes
  }

  try {
    await reassignCustomerOwnership({
      customer: existing,
      toAdvisor: advisor,
      toAdvisorPhone: advisorPhone,
      reason: 'reclaim',
      fieldOverrides,
      skipPermissionCheck: true
    })
    await renderCustomers()
    openCustomerDetail(existing.id)
    showToast(`مشتری ${existing.id} از ${existing.advisor || '—'} به ${advisor} منتقل شد`)
  } catch (e) {
    console.error('transferCustomerOwnership error:', e)
    showToast(e?.message || 'خطا در انتقال مشتری')
  }
}

/**
 * Central ownership reassignment: updates customer, writes ownership_transfers row,
 * and appends a systemic followup for the customer timeline.
 * @returns {Promise<{ customer: object, transfer: object }>}
 */
export async function reassignCustomerOwnership({
  customer,
  toAdvisor,
  toAdvisorPhone,
  toUser,
  actedBy = getCurrentUser(),
  reason = 'handoff',
  batchId = '',
  fieldOverrides = null,
  skipPermissionCheck = false,
  writeTimeline = true
}) {
  const data = getData()
  const idx = data.customers.findIndex(c => c.id === customer.id)
  if (idx === -1) throw new Error('مشتری یافت نشد')

  const existing = data.customers[idx]
  if (!skipPermissionCheck && !canTransferCustomer(existing, actedBy)) {
    throw new Error('شما مجاز به انتقال این مشتری نیستید')
  }

  let advisor = toAdvisor
  let advisorPhone = normalizePhone(toAdvisorPhone || '')
  if (toUser) {
    advisor = userDisplayName(toUser)
    advisorPhone = normalizePhone(toUser.phone)
  }
  if (!advisorPhone) throw new Error('کارشناس مقصد نامعتبر است')

  const fromPhone = normalizePhone(existing.advisorPhone)
  const fromName = existing.advisor || ''
  if (fromPhone && fromPhone === advisorPhone) {
    return { customer: existing, transfer: null, skipped: true }
  }

  const updated = {
    ...existing,
    ...(fieldOverrides || {}),
    advisor: advisor || '',
    advisorPhone
  }

  const transferPayload = {
    customerId: existing.id,
    customerPhone: getPrimaryPhone(existing) || existing.phone || '',
    fromAdvisorPhone: fromPhone,
    fromAdvisorName: fromName,
    toAdvisorPhone: advisorPhone,
    toAdvisorName: advisor || '',
    actedByPhone: normalizePhone(actedBy?.phone || ''),
    batchId: batchId || generateTransferBatchId(),
    reason: reason || 'handoff',
    customerStatusAtTransfer: existing.status || ''
  }

  await saveCustomerToDB(updated)
  data.customers[idx] = updated

  let savedTransfer = null
  try {
    savedTransfer = await saveOwnershipTransferToDB(transferPayload)
    if (!Array.isArray(data.ownershipTransfers)) data.ownershipTransfers = []
    data.ownershipTransfers.push(savedTransfer)
  } catch (e) {
    console.warn('ownership_transfers save skipped (migration 008?):', e?.message || e)
  }

  if (writeTimeline) {
    const { date, time } = getNowJalaliDateTime()
    const transferNote = {
      customerId: existing.id,
      date,
      type: 'سیستمی',
      result: 'انتقال کارشناس',
      nextDate: '',
      notes: `این مشتری در تاریخ ${date} ساعت ${time} از کارشناس ${fromName || '—'} به کارشناس ${advisor || '—'} منتقل شد.`,
      createdByPhone: normalizePhone(actedBy?.phone || advisorPhone)
    }
    try {
      const fid = await saveFollowupToDB(transferNote)
      transferNote.id = fid
      data.followups.push(transferNote)
    } catch (e) {
      console.warn('transfer timeline followup skipped:', e?.message || e)
    }
  }

  return { customer: updated, transfer: savedTransfer }
}

export function editCustomer(id) {
  openCustomerDetail(id)
}

export function deleteCustomer(id) {
  if (!requirePermission('customers_delete')) return
  const data = getData()
  const customer = data.customers.find(c => c.id === id)
  if (customer && !canManageCustomer(customer)) { showToast('فقط کارشناس مسئول می‌تواند این مشتری را حذف کند'); return }
  document.getElementById('deleteMessage').textContent =
    `آیا از حذف "${customer.name || customer.id}" مطمئن هستید؟ تمام پیگیری‌های مرتبط هم حذف می‌شوند.`
  document.getElementById('deleteConfirmBtn').onclick = async function () {
    try {
      await deleteCustomerFromDB(id)
      data.customers = data.customers.filter(c => c.id !== id)
      data.followups = data.followups.filter(f => f.customerId !== id)
      closeDetailModal()
      await renderCustomers()
      closeDeleteModal()
      showToast('مشتری حذف شد')
    } catch (e) {
      console.error('deleteCustomer error:', e)
      showToast('خطا در حذف مشتری')
    }
  }
  document.getElementById('deleteModal').classList.add('active')
}

export function closeDeleteModal() {
  document.getElementById('deleteModal').classList.remove('active')
}

function pickNonEmpty(primary, fallback) {
  const a = String(primary || '').trim()
  if (a) return a
  return String(fallback || '').trim()
}

function mergePhoneLists(...lists) {
  const out = []
  const seen = new Set()
  for (const list of lists) {
    for (const raw of list || []) {
      const n = normalizePhone(raw)
      if (!n || !/^09\d{9}$/.test(n) || seen.has(n)) continue
      seen.add(n)
      out.push(n)
      if (out.length >= MAX_CUSTOMER_PHONES) return out
    }
  }
  return out
}

/** Prefer earlier (sooner) non-empty follow-up date. */
function pickEarlierFollowupDate(a, b) {
  const da = String(a || '').trim()
  const db = String(b || '').trim()
  if (!da) return db
  if (!db) return da
  const na = jalaliToNum(da)
  const nb = jalaliToNum(db)
  if (na === 99999999) return db
  if (nb === 99999999) return da
  return na <= nb ? da : db
}

function openMergeCustomerModal({ sourceId, survivorId, fields }) {
  const data = getData()
  const source = data.customers.find(c => c.id === sourceId)
  const survivor = data.customers.find(c => c.id === survivorId)
  if (!source || !survivor) {
    showToast('مشتری برای ادغام یافت نشد')
    return
  }

  pendingMerge = { sourceId, survivorId, fields }

  const sourceProducts = (source.products || []).length
  const sourceFollowups = data.followups.filter(f => f.customerId === sourceId).length
  const survivorProducts = (survivor.products || []).length
  const survivorFollowups = data.followups.filter(f => f.customerId === survivorId).length

  const msg = document.getElementById('mergeCustomerMessage')
  if (msg) {
    msg.textContent =
      `لید ${sourceId} با مشتری ${survivorId} (صاحب شماره) ادغام می‌شود.`
  }
  const summary = document.getElementById('mergeCustomerSummary')
  if (summary) {
    summary.innerHTML = `
      <li>محصولات منتقل‌شونده از LD: ${sourceProducts}</li>
      <li>پیگیری/یادداشت منتقل‌شونده از LD: ${sourceFollowups}</li>
      <li>محصولات فعلی بازمانده: ${survivorProducts}</li>
      <li>پیگیری‌های فعلی بازمانده: ${survivorFollowups}</li>
      <li>کارشناس مسئول بازمانده: ${escapeHtml(survivor.advisor || '—')}</li>
    `
  }

  const btn = document.getElementById('mergeCustomerConfirmBtn')
  if (btn) { btn.disabled = false; btn.textContent = 'تأیید ادغام' }
  document.getElementById('mergeCustomerModal')?.classList.add('active')
}

export function closeMergeCustomerModal() {
  pendingMerge = null
  document.getElementById('mergeCustomerModal')?.classList.remove('active')
}

export async function confirmMergeCustomers() {
  if (!pendingMerge) {
    closeMergeCustomerModal()
    return
  }
  const { sourceId, survivorId, fields } = pendingMerge
  const btn = document.getElementById('mergeCustomerConfirmBtn')
  if (btn) { btn.disabled = true; btn.textContent = 'در حال ادغام...' }

  try {
    const resultId = await mergeLdIntoPhoneOwner({ sourceId, survivorId, fields })
    closeMergeCustomerModal()
    closeDetailModal()
    await renderCustomers()
    const survivor = getData().customers.find(c => c.id === resultId)
    if (survivor && canViewCustomer(survivor)) {
      await openCustomerDetail(resultId)
    }
    showToast(`ادغام انجام شد — ${sourceId} داخل ${resultId} ادغام شد`)
  } catch (e) {
    console.error('confirmMergeCustomers error:', e)
    showToast(e?.message || 'خطا در ادغام مشتریان')
    if (btn) { btn.disabled = false; btn.textContent = 'تأیید ادغام' }
  }
}

/**
 * Absorb LD source into the phone-owning survivor. Ownership of survivor is kept.
 * @returns {Promise<string>} final survivor id
 */
async function mergeLdIntoPhoneOwner({ sourceId, survivorId, fields }) {
  const data = getData()
  const sourceIdx = data.customers.findIndex(c => c.id === sourceId)
  let survivorIdx = data.customers.findIndex(c => c.id === survivorId)
  if (sourceIdx === -1 || survivorIdx === -1) throw new Error('مشتری برای ادغام یافت نشد')

  const source = data.customers[sourceIdx]
  let survivor = data.customers[survivorIdx]
  let finalSurvivorId = survivorId

  if (!String(sourceId).startsWith('LD')) {
    throw new Error('فقط لید (LD) قابل ادغام به این شکل است')
  }
  if (!canManageCustomer(source)) {
    throw new Error('فقط کارشناس مسئول لید می‌تواند ادغام را انجام دهد')
  }

  const formPhones = normalizeCustomerPhones(fields?.phones || fields?.phone || [])
  const phoneOwnerMatch = formPhones.some(p => {
    const owner = findCustomerByPhone(p, data.customers, sourceId)
    return owner && owner.id === survivorId
  })
  if (!phoneOwnerMatch) {
    throw new Error('شماره دیگر متعلق به این مشتری نیست؛ دوباره ذخیره کنید')
  }

  // Legacy: survivor is LD but has the phone → convert to CS first
  if (survivor.id.startsWith('LD')) {
    const newId = await generateId('CS')
    const phones = normalizeCustomerPhones(survivor)
    const converted = {
      ...survivor,
      id: newId,
      phones,
      phone: phones[0] || ''
    }
    await saveCustomerToDB(converted)
    await updateFollowupsCustomerId(survivor.id, newId)
    data.followups.forEach(f => { if (f.customerId === survivor.id) f.customerId = newId })
    await deleteCustomerRowOnly(survivor.id)
    data.customers[survivorIdx] = converted
    survivor = converted
    finalSurvivorId = newId
  }

  const mergedPhones = mergePhoneLists(
    getCustomerPhones(survivor),
    formPhones,
    getCustomerPhones(source)
  )
  const sourceNotes = String(source.notes || '').trim()
  const survivorNotes = String(survivor.notes || '').trim()
  let mergedNotes = survivorNotes
  if (sourceNotes && survivorNotes && sourceNotes !== survivorNotes) {
    mergedNotes = `${survivorNotes}\n---\n${sourceNotes}`
  } else if (sourceNotes && !survivorNotes) {
    mergedNotes = sourceNotes
  }

  const sourceProducts = Array.isArray(source.products) ? [...source.products] : []
  const survivorProducts = Array.isArray(survivor.products) ? [...survivor.products] : []

  const merged = {
    ...survivor,
    id: finalSurvivorId,
    phones: mergedPhones,
    phone: mergedPhones[0] || '',
    name: pickNonEmpty(survivor.name, fields?.name || source.name),
    platformId: pickNonEmpty(survivor.platformId, fields?.platformId || source.platformId),
    platform: pickNonEmpty(survivor.platform, fields?.platform || source.platform) || survivor.platform || 'instagram',
    status: pickNonEmpty(survivor.status, fields?.status || source.status) || survivor.status || 'new',
    notes: mergedNotes,
    nextFollowupDate: pickEarlierFollowupDate(survivor.nextFollowupDate, source.nextFollowupDate),
    products: [...survivorProducts, ...sourceProducts],
    advisor: survivor.advisor,
    advisorPhone: survivor.advisorPhone
  }

  merged.products.forEach(p => {
    ensureProductPayments(p)
    syncProductStatus(p)
  })
  syncCustomerLevel(merged, data.customers, data.followups)

  await saveCustomerToDB(merged)
  // Re-find index in case array mutated
  survivorIdx = data.customers.findIndex(c => c.id === finalSurvivorId)
  if (survivorIdx === -1) throw new Error('مشتری بازمانده پس از ادغام یافت نشد')
  data.customers[survivorIdx] = merged

  await updateFollowupsCustomerId(sourceId, finalSurvivorId)
  data.followups.forEach(f => { if (f.customerId === sourceId) f.customerId = finalSurvivorId })

  await deleteCustomerRowOnly(sourceId)
  data.customers = data.customers.filter(c => c.id !== sourceId)

  await saveSetting('convertedCount', (data.convertedCount || 0) + 1)
  data.convertedCount = (data.convertedCount || 0) + 1

  return finalSurvivorId
}

// ============================================
// Customer Detail Panel
// ============================================

const DETAIL_TABS = ['info', 'sales', 'followups']
const DETAIL_TAB_LABELS = { info: 'اطلاعات', sales: 'فروش‌ها', followups: 'پیگیری‌ها' }

/** @type {{ customerId: string|null, tab: 'info'|'sales'|'followups', canEdit?: boolean, canDelete?: boolean }} */
let detailPanelState = { customerId: null, tab: 'info', canEdit: false, canDelete: false }

function normalizeDetailTab(tab) {
  return DETAIL_TABS.includes(tab) ? tab : 'info'
}

/** Infer which detail tab to open from the active app sheet. */
function inferDetailTabFromApp() {
  const sheet = document.querySelector('.sheet.active')
  const id = sheet?.id || ''
  if (id === 'sheet-sales' || id === 'sheet-accounting' || id === 'sheet-shipments') return 'sales'
  if (id === 'sheet-followups') return 'followups'
  return 'info'
}

function resolveDetailTab(customerId, options = {}) {
  if (options.tab) return normalizeDetailTab(options.tab)
  const modalOpen = document.getElementById('detailModal')?.classList.contains('active')
  const sameCustomer = modalOpen && detailPanelState.customerId != null && detailPanelState.customerId === customerId
  if (sameCustomer || options.preserveTab) return normalizeDetailTab(detailPanelState.tab)
  return inferDetailTabFromApp()
}

function applyDetailTab(tab) {
  const next = normalizeDetailTab(tab)
  detailPanelState.tab = next

  document.querySelectorAll('#detailBody .detail-tab').forEach(btn => {
    const active = btn.getAttribute('data-detail-tab') === next
    btn.classList.toggle('is-active', active)
    btn.setAttribute('aria-selected', active ? 'true' : 'false')
    btn.setAttribute('tabindex', active ? '0' : '-1')
  })

  document.querySelectorAll('#detailBody .detail-tab-panel').forEach(panel => {
    const match = panel.id === `detailTab-${next}`
    panel.hidden = !match
    panel.classList.toggle('is-active', match)
  })

  if (next === 'followups' && window.jalaliDatepicker) {
    try { window.jalaliDatepicker.startWatch({ time: false, zIndex: 11000 }) } catch (_) { /* ignore */ }
  }
  if (next === 'sales' && window.jalaliDatepicker) {
    try { window.jalaliDatepicker.startWatch({ time: false, zIndex: 11000 }) } catch (_) { /* ignore */ }
  }
}

/** Switch tab inside the open customer detail modal. */
export function switchDetailTab(tab) {
  if (!document.getElementById('detailModal')?.classList.contains('active')) return
  if (!document.getElementById(`detailTab-${normalizeDetailTab(tab)}`)) return
  applyDetailTab(tab)
  renderDetailFooter({
    isNew: false,
    canEdit: !!detailPanelState.canEdit,
    canDelete: !!detailPanelState.canDelete,
    customerId: detailPanelState.customerId,
    tab: detailPanelState.tab
  })
}

/** Open customer panel on row click, unless the click was on an interactive control. */
export function onCustomerRowClick(event, customerId) {
  if (!customerId) return
  const t = event?.target
  if (t?.closest?.('button, a, input, select, textarea, label, .actions-cell')) return
  openCustomerDetail(customerId)
}

function renderDetailFooter({ isNew, canEdit, canDelete, customerId, tab = 'info' }) {
  const footer = document.getElementById('detailFooter')
  if (!footer) return
  if (isNew) {
    footer.innerHTML = `
      <span></span>
      <div class="detail-footer-actions">
        <button type="button" class="btn btn-primary" onclick="app.saveCustomerDetail('')">ایجاد مشتری</button>
        <button type="button" class="btn" onclick="app.closeDetailModal()">انصراف</button>
      </div>
    `
    return
  }
  const id = escapeAttr(customerId)
  const onInfo = tab === 'info'
  footer.innerHTML = `
    ${canDelete && onInfo
      ? `<button type="button" class="btn btn-danger" onclick="app.deleteCustomer('${id}')">حذف مشتری</button>`
      : '<span></span>'}
    <div class="detail-footer-actions">
      ${canEdit && onInfo ? `<button type="button" class="btn btn-primary" onclick="app.saveCustomerDetail('${id}')">ذخیره اطلاعات مشتری</button>` : ''}
      <button type="button" class="btn" onclick="app.closeDetailModal()">بستن</button>
    </div>
  `
}

function readDetailFormFields(users, fallback = {}) {
  const platformId = document.getElementById('detailPlatformId')?.value.trim() || ''
  const platform = document.getElementById('detailPlatform')?.value || fallback.platform || 'instagram'
  const name = document.getElementById('detailName')?.value.trim() || ''
  const phones = getFormPhones()
  const addresses = getFormAddresses()
  const status = document.getElementById('detailStatus')?.value || fallback.status || 'new'
  const notes = fallback.notes || ''
  const advisorSelectValue = document.getElementById('detailAdvisor')?.value || fallback.advisorPhone || ''
  const { advisor, advisorPhone } = resolveAdvisor(advisorSelectValue, users)
  return { platformId, platform, name, phones, addresses, status, notes, advisor, advisorPhone }
}

function syncAddressSlotsFromDom() {
  const container = document.getElementById('detailAddressesList')
  if (!container) return
  const rows = container.querySelectorAll('.address-field-row')
  addressSlots = Array.from(rows).map(row => ({
    text: row.querySelector('.customer-address-text')?.value || '',
    postalCode: row.querySelector('.customer-address-postal')?.value || ''
  }))
  if (!addressSlots.length) addressSlots = [{ text: '', postalCode: '' }]
}

function getFormAddresses() {
  syncAddressSlotsFromDom()
  return normalizeCustomerAddresses(addressSlots)
}

function renderAddressFields() {
  const container = document.getElementById('detailAddressesList')
  if (!container) return
  if (!addressSlots.length) addressSlots = [{ text: '', postalCode: '' }]
  container.innerHTML = addressSlots.map((slot, i) => `
    <div class="address-field-row" data-index="${i}">
      <input type="text" class="form-input customer-address-text" data-index="${i}"
        placeholder="آدرس پستی" value="${escapeAttr(slot.text || '')}"
        oninput="app.onCustomerAddressInput()">
      <input type="text" class="form-input customer-address-postal" data-index="${i}"
        inputmode="numeric" placeholder="کد پستی" value="${escapeAttr(slot.postalCode || '')}"
        oninput="app.onCustomerAddressInput()" style="max-width:140px;">
      <div class="address-field-actions"></div>
    </div>
  `).join('')
  refreshAddressFieldActions()
}

function refreshAddressFieldActions() {
  const container = document.getElementById('detailAddressesList')
  if (!container) return
  addressSlots.forEach((_, i) => {
    const row = container.querySelector(`.address-field-row[data-index="${i}"]`)
    const actions = row?.querySelector('.address-field-actions')
    if (!actions) return
    const canAdd = i === addressSlots.length - 1
      && addressSlots.length < MAX_CUSTOMER_ADDRESSES
    const canRemove = addressSlots.length > 1
    actions.innerHTML = `
      ${canAdd ? `<button type="button" class="btn-icon" title="افزودن آدرس" onclick="app.addCustomerAddressSlot()">+</button>` : ''}
      ${canRemove ? `<button type="button" class="btn-icon is-danger" title="حذف آدرس" onclick="app.removeCustomerAddressSlot(${i})">×</button>` : ''}
    `
  })
}

export function onCustomerAddressInput() {
  syncAddressSlotsFromDom()
  refreshAddressFieldActions()
}

export function addCustomerAddressSlot() {
  syncAddressSlotsFromDom()
  if (addressSlots.length >= MAX_CUSTOMER_ADDRESSES) return
  const last = addressSlots[addressSlots.length - 1]
  if (!(last?.text || '').trim()) {
    showToast('ابتدا آدرس فعلی را وارد کنید')
    return
  }
  addressSlots.push({ text: '', postalCode: '' })
  renderAddressFields()
}

export function removeCustomerAddressSlot(index) {
  syncAddressSlotsFromDom()
  if (addressSlots.length <= 1) return
  addressSlots.splice(index, 1)
  renderAddressFields()
}

function validateDetailPhones() {
  const { listId } = phoneForm()
  onCustomerPhoneInput()

  for (let i = 0; i < phoneSlots.length; i++) {
    const raw = String(phoneSlots[i] || '').trim()
    if (!raw) continue
    const n = normalizePhone(raw)
    if (!/^09\d{9}$/.test(n)) {
      setPhoneFieldError('فرمت شماره موبایل صحیح نیست (مثال: ۰۹۱۲۳۴۵۶۷۸۹)', i)
      document.querySelector(`#${listId} .customer-phone-input[data-index="${i}"]`)?.focus()
      return false
    }
  }

  if (phoneFieldState.status === 'duplicate' || phoneFieldState.status === 'incomplete') {
    document.querySelector(`#${listId} .customer-phone-input[data-index="${phoneFieldState.index}"]`)?.focus()
    return false
  }
  return true
}

/**
 * Create customer from detail panel fields (incl. transfer / platformId merge).
 * @returns {Promise<string|null>} final customer id, or null if aborted/redirected
 */
async function createCustomerFromDetail(fields, users) {
  const data = getData()
  const { platformId, platform, name, phones, addresses, status, notes, advisor, advisorPhone } = fields
  const phoneFields = { phone: phones[0] || '', phones }
  const addressFields = { addresses: normalizeCustomerAddresses(addresses || []) }
  const { listId } = phoneForm()
  const focusPhoneIndex = (idx = 0) => {
    document.querySelector(`#${listId} .customer-phone-input[data-index="${idx}"]`)?.focus()
  }

  if (phoneFieldState.status === 'blocked' || phoneFieldState.status === 'taken') {
    focusPhoneIndex(phoneFieldState.index)
    return null
  }
  if (phoneFieldState.status === 'own' && phoneFieldState.customer) {
    await openCustomerDetail(phoneFieldState.customer.id)
    showToast(`این مشتری از قبل متعلق به شماست — پنل ${phoneFieldState.customer.id} باز شد`)
    return null
  }

  const existById = platformId && data.customers.find(c => c.platformId && c.platformId.toLowerCase() === platformId.toLowerCase())
  if (existById) {
    if (phones.length && !getCustomerPhones(existById).length) {
      const idx = data.customers.findIndex(c => c.id === existById.id)
      if (idx === -1) return null
      const wasLD = existById.id.startsWith('LD')
      const updatedFields = { platformId, platform, name, ...phoneFields, ...addressFields, status, notes, advisor, advisorPhone }

      if (wasLD) {
        const newId = await generateId('CS')
        await saveCustomerToDB({ ...existById, ...updatedFields, id: newId })
        await updateFollowupsCustomerId(existById.id, newId)
        await saveSetting('convertedCount', (data.convertedCount || 0) + 1)
        data.customers[idx] = { ...existById, ...updatedFields, id: newId }
        data.followups.forEach(f => { if (f.customerId === existById.id) f.customerId = newId })
        data.convertedCount = (data.convertedCount || 0) + 1
        await renderCustomers()
        await openCustomerDetail(newId)
        showToast(`شماره ثبت شد — ${existById.id} تبدیل شد به ${newId}`)
        return newId
      }

      const updated = { ...existById, ...updatedFields }
      await saveCustomerToDB(updated)
      data.customers[idx] = updated
      await renderCustomers()
      await openCustomerDetail(existById.id)
      showToast(`مشتری ${existById.id} با شماره جدید به‌روزرسانی شد`)
      return existById.id
    }
    await openCustomerDetail(existById.id)
    showToast(`این ایدی قبلاً ثبت شده — پنل مشتری ${existById.id} باز شد`)
    return null
  }

  if (phoneFieldState.status === 'transferable' && phoneFieldState.customer) {
    await transferCustomerOwnership(phoneFieldState.customer, {
      platformId, platform, name, ...phoneFields, ...addressFields, status, notes, advisor, advisorPhone
    }, users)
    return phoneFieldState.customer.id
  }

  const type = phones.length ? 'CS' : 'LD'
  const id = await generateId(type)
  const newCustomer = {
    id, platformId, platform, name, ...phoneFields, ...addressFields, status, notes, advisor, advisorPhone,
    nextFollowupDate: '', products: [], createdAt: new Date().toISOString(),
    customerLevel: '', customerLevelLocked: false, referredByPhone: ''
  }
  await saveCustomerToDB(newCustomer)
  data.customers.push(newCustomer)
  await renderCustomers()
  await openCustomerDetail(id, { tab: 'sales' })
  showToast('مشتری جدید اضافه شد — می‌توانید فروش ثبت کنید')
  return id
}

export async function saveCustomerDetail(customerId) {
  if (!requirePermission('customers_add')) return
  const isNew = !customerId
  const data = getData()
  const customer = isNew ? null : data.customers.find(c => c.id === customerId)
  if (!isNew && (!customer || !canManageCustomer(customer))) {
    showToast('فقط کارشناس مسئول می‌تواند این مشتری را ویرایش کند')
    return
  }

  phoneFormMode = 'detail'
  const saveBtn = document.querySelector('#detailFooter .btn-primary')
  const saveLabel = isNew ? 'ایجاد مشتری' : 'ذخیره اطلاعات مشتری'
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'در حال ذخیره...' }

  try {
    const users = await getUsersSafe()
    if (!validateDetailPhones()) return

    const fields = readDetailFormFields(users, customer || {})
    const { listId } = phoneForm()

    if (isNew) {
      await createCustomerFromDetail(fields, users)
      return
    }

    if (phoneFieldState.status === 'mergeable' && phoneFieldState.customer) {
      openMergeCustomerModal({
        sourceId: customerId,
        survivorId: phoneFieldState.customer.id,
        fields
      })
      return
    }

    if (phoneFieldState.status === 'taken') {
      setPhoneFieldError(
        phoneFieldState.customer
          ? `این شماره از قبل برای مشتری ${phoneFieldState.customer.id} ثبت شده و قابل تغییر نیست`
          : 'این شماره از قبل برای مشتری دیگری ثبت شده است',
        phoneFieldState.index
      )
      document.querySelector(`#${listId} .customer-phone-input[data-index="${phoneFieldState.index}"]`)?.focus()
      return
    }

    const result = await applyCustomerEdit(customerId, fields)
    await renderCustomers()
  await openCustomerDetail(result.id, { tab: 'info' })
  showToast(result.toast)
  } catch (e) {
    console.error('saveCustomerDetail error:', e)
    if (e?.code === 'phone_taken') {
      setPhoneFieldError(e.message)
    } else {
      showToast(e?.message || 'خطا در ذخیره مشتری')
    }
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = saveLabel }
  }
}

export async function openCustomerDetail(id, options = {}) {
  const isNew = id == null || id === ''
  const data = getData()
  const currentUser = getCurrentUser()

  if (isNew) {
    if (!requirePermission('customers_add')) return
  } else {
    const existing = data.customers.find(x => x.id === id)
    if (!existing) return
    if (!canViewCustomer(existing)) {
      showToast('شما به این مشتری دسترسی ندارید')
      return
    }
  }

  const activeTab = isNew ? 'info' : resolveDetailTab(isNew ? null : id, options)

  const c = isNew
    ? {
        id: '',
        name: '',
        platformId: '',
        platform: 'instagram',
        status: 'new',
        notes: '',
        advisor: currentUser ? userDisplayName(currentUser) : '',
        advisorPhone: currentUser?.phone ? normalizePhone(currentUser.phone) : '',
        nextFollowupDate: '',
        products: [],
        customerLevel: '',
        customerLevelLocked: false
      }
    : data.customers.find(x => x.id === id)

  const canEdit = isNew || (hasPermission('customers_add') && canManageCustomer(c))
  const canTransfer = !isNew && canTransferCustomer(c)
  const canDelete = !isNew && hasPermission('customers_delete') && canManageCustomer(c)
  const canAddSale = !isNew && canAddSaleOnCustomer(c)
  const canAddFollowup = !isNew && canAddNoteOnCustomer(c)
  const canScheduleFollowup = !isNew && canScheduleFollowupOnCustomer(c)
  const canClearFollowupDate = canScheduleFollowup && canManageCustomer(c)
  const schedulingForOther = canScheduleFollowup && !canManageCustomer(c)

  const customerFollowups = isNew
    ? []
    : sortFollowupsNewestFirst(data.followups.filter(f => f.customerId === id))
  const idClass = !isNew && c.id.startsWith('CS') ? 'id-cs' : 'id-ld'
  const platformLabel = getPlatformLabels()[c.platform] || c.platform
  const statusClass = getStatusClass(c.status)
  const statusLabel = getStatusLabels()[c.status] || c.status
  const lrfm = isNew ? { L: null, R: '', F: null, M: 0 } : computeCustomerLrfm(c, data.followups)

  let levelKey = ''
  if (!isNew) {
    levelKey = resolveCustomerLevel(c, data.customers, data.followups)
    if (!c.customerLevelLocked) {
      const prev = c.customerLevel || ''
      levelKey = syncCustomerLevel(c, data.customers, data.followups)
      if ((c.customerLevel || '') !== prev) {
        try { await saveCustomerToDB(c) } catch (e) {
          console.warn('auto level save skipped:', e?.message || e)
        }
      }
    }
  }

  const detailUsers = await getUsersSafe()

  document.getElementById('detailTitle').textContent = isNew
    ? 'پنل مشتری — مشتری جدید'
    : `پنل مشتری — ${c.name || c.platformId || c.id}`

  const advisorOptions = detailUsers.filter(u => u.phone).map(u => {
    const phone = normalizePhone(u.phone)
    const selected = phone === normalizePhone(c.advisorPhone) ? 'selected' : ''
    return `<option value="${escapeAttr(phone)}" ${selected}>${escapeHtml(userDisplayName(u))}</option>`
  }).join('')

  // Editable when managing; transfer-only users get an immediate onchange select
  let advisorHtml
  if (canEdit) {
    advisorHtml = `<select class="form-select" id="detailAdvisor">${advisorOptions}</select>`
  } else if (canTransfer) {
    advisorHtml = `<select class="form-select" id="detailAdvisor" onchange="app.updateCustomerAdvisor('${escapeAttr(c.id)}', this.value)">${advisorOptions}</select>
      <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">با تغییر، مالکیت فوراً منتقل می‌شود</div>`
  } else {
    advisorHtml = escapeHtml(c.advisor || '—')
  }

  const levelDisplay = isNew ? '—' : formatCustomerLevel(levelKey)
  const levelHtml = (!isNew && isAdmin())
    ? `<select class="form-select" id="detailCustomerLevel" style="width:auto;display:inline-block;min-width:160px;" onchange="app.updateCustomerLevel('${escapeAttr(c.id)}', this.value)">
          <option value="auto" ${!c.customerLevelLocked ? 'selected' : ''}>خودکار (محاسبه سیستم)</option>
          ${Object.values(CUSTOMER_LEVELS).map(lv => `
            <option value="${lv.key}" ${c.customerLevelLocked && levelKey === lv.key ? 'selected' : ''}>${lv.emoji} ${lv.label}</option>
          `).join('')}
        </select>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">${c.customerLevelLocked ? 'سطح دستی — با انتخاب «خودکار» دوباره محاسبه می‌شود' : `فعلی: ${escapeHtml(levelDisplay)}`}</div>`
    : `<span class="customer-level-badge">${escapeHtml(levelDisplay)}</span>`

  const followupDateControls = canScheduleFollowup
    ? `<div style="display:flex;flex-direction:column;gap:8px;align-items:stretch;min-width:min(100%,280px);">
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
            <input type="text" id="detailFollowupDate" placeholder="تاریخ پیگیری" data-jdp style="padding:6px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;width:150px;">
            <button class="btn btn-sm btn-primary" onclick="app.setNextFollowup('${escapeAttr(c.id)}')">ذخیره</button>
            ${canClearFollowupDate && c.nextFollowupDate ? `<button class="btn btn-sm" onclick="app.clearNextFollowup('${escapeAttr(c.id)}')" style="color:var(--danger);">حذف</button>` : ''}
          </div>
          ${schedulingForOther ? `
            <textarea id="detailFollowupScheduleNote" class="form-textarea" placeholder="توضیحات برای کارشناس مسئول (اجباری)..." style="min-height:64px;font-size:13px;"></textarea>
            <div style="font-size:11px;color:var(--text-muted);">این پیگیری در صف فالوآپ‌های کارشناس مسئول (${escapeHtml(c.advisor || '—')}) ظاهر می‌شود.</div>
          ` : ''}
        </div>`
    : ''

  const fmtDays = (n) => (n == null ? '—' : `${formatNumber(n)} روز`)
  const fmtMoney = (n) => `${formatNumber(n || 0)} ریال`

  const phonesReadonly = (() => {
    const phones = getCustomerPhones(c)
    if (!phones.length) return '—'
    return phones.map(p => escapeHtml(p)).join('<br>')
  })()

  const addressesReadonly = (() => {
    const addrs = getCustomerAddresses(c)
    if (!addrs.length) return '—'
    return addrs.map(a => {
      const postal = a.postalCode ? ` <span style="color:var(--text-muted);font-size:12px;">(${escapeHtml(a.postalCode)})</span>` : ''
      return `<div>${escapeHtml(a.text)}${postal}</div>`
    }).join('')
  })()

  const idFieldHtml = isNew
    ? ''
    : `<div class="detail-field">
        <span class="detail-label">شناسه</span>
        <span class="detail-value"><span class="id-badge ${idClass}">${escapeHtml(c.id)}</span></span>
      </div>`

  const levelFieldHtml = isNew
    ? ''
    : `<div class="detail-field">
        <span class="detail-label">سطح مشتری</span>
        <span class="detail-value">${levelHtml}</span>
      </div>`

  const infoFields = canEdit
    ? `
      <input type="hidden" id="detailEditCustomerId" value="${escapeAttr(isNew ? '' : c.id)}">
      <div class="detail-field">
        <span class="detail-label">نام</span>
        <input type="text" class="form-input" id="detailName" value="${escapeAttr(c.name || '')}" placeholder="اختیاری">
      </div>
      ${idFieldHtml}
      ${levelFieldHtml}
      <div class="detail-field">
        <span class="detail-label">وضعیت</span>
        <select class="form-select" id="detailStatus"></select>
      </div>
      <div class="detail-field">
        <span class="detail-label">شماره تماس</span>
        <div id="detailPhonesList" class="phone-fields"></div>
        <div class="form-error" id="detailPhoneError" hidden></div>
        <div class="form-hint" id="detailPhoneHint" hidden></div>
      </div>
      <div class="detail-field">
        <span class="detail-label">آدرس پستی</span>
        <div id="detailAddressesList" class="address-fields"></div>
      </div>
      <div class="detail-field">
        <span class="detail-label">کارشناس مسئول</span>
        <span class="detail-value">${advisorHtml}</span>
      </div>
      <div class="detail-field">
        <span class="detail-label">پلتفرم</span>
        <select class="form-select" id="detailPlatform"></select>
      </div>
      <div class="detail-field">
        <span class="detail-label">ایدی پلتفرم</span>
        <input type="text" class="form-input" id="detailPlatformId" value="${escapeAttr(c.platformId || '')}" placeholder="اختیاری" style="font-family:'Vazirmatn',sans-serif;">
      </div>
    `
    : `
      <div class="detail-field">
        <span class="detail-label">نام</span>
        <span class="detail-value">${escapeHtml(c.name) || '—'}</span>
      </div>
      ${idFieldHtml}
      ${levelFieldHtml}
      <div class="detail-field">
        <span class="detail-label">وضعیت</span>
        <span class="detail-value"><span class="status-badge ${statusClass}">${escapeHtml(statusLabel)}</span></span>
      </div>
      <div class="detail-field">
        <span class="detail-label">شماره تماس</span>
        <span class="detail-value" style="direction:ltr;text-align:right;">${phonesReadonly}</span>
      </div>
      <div class="detail-field">
        <span class="detail-label">آدرس پستی</span>
        <span class="detail-value">${addressesReadonly}</span>
      </div>
      <div class="detail-field">
        <span class="detail-label">کارشناس مسئول</span>
        <span class="detail-value">${advisorHtml}</span>
      </div>
      <div class="detail-field">
        <span class="detail-label">پلتفرم</span>
        <span class="detail-value">${escapeHtml(platformLabel)}</span>
      </div>
      <div class="detail-field">
        <span class="detail-label">ایدی پلتفرم</span>
        <span class="detail-value" style="font-family:'Vazirmatn',sans-serif;">${escapeHtml(c.platformId) || '—'}</span>
      </div>
    `

  const infoPanelHtml = `
    <div class="detail-info">
      ${infoFields}
    </div>
    ${!isNew ? `
    <div class="detail-rfm">
      <div class="detail-rfm-title">شاخص‌های LRFM</div>
      <div class="rfm-table-wrap">
        <table class="rfm-table">
          <thead>
            <tr>
              <th title="Length — طول مدت ارتباط">L</th>
              <th title="Recency — آخرین پیگیری">R</th>
              <th title="Frequency — میانگین فاصله ارتباط">F</th>
              <th title="Monetary — مجموع پرداختی‌ها">M</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <span class="rfm-metric-label">طول مدت ارتباط</span>
                <span class="rfm-metric-value">${fmtDays(lrfm.L)}</span>
              </td>
              <td>
                <span class="rfm-metric-label">آخرین پیگیری</span>
                <span class="rfm-metric-value" style="font-family:'Vazirmatn',sans-serif;">${escapeHtml(lrfm.R) || '—'}</span>
              </td>
              <td>
                <span class="rfm-metric-label">میانگین فاصله ارتباط</span>
                <span class="rfm-metric-value">${fmtDays(lrfm.F)}</span>
              </td>
              <td>
                <span class="rfm-metric-label">مجموع پرداختی‌ها</span>
                <span class="rfm-metric-value">${fmtMoney(lrfm.M)}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>` : ''}
  `

  const salesCount = !isNew ? (c.products || []).length : 0
  const salesPanelHtml = `
    <div class="detail-products">
      <p class="detail-sales-hint">پس از تکمیل مبلغ، تاریخ، ساعت و بانک مقصد، دکمهٔ «ثبت فروش» یا «ثبت واریز» را بزنید تا برای تأیید به حسابداری برود.</p>
      <div id="detailProductsList"></div>
      ${canAddSale
        ? `<button class="btn btn-sm btn-primary" style="margin-top:8px;" onclick="app.addProductRow('${escapeAttr(c.id)}')">+ ثبت فروش</button>`
        : ''}
    </div>
  `

  let followupsPanelHtml = ''
  if (!isNew) {
    let timelineHtml = ''
    if (customerFollowups.length === 0) {
      timelineHtml = `<div class="detail-tab-empty">پیگیری ثبت نشده</div>`
    } else {
      const canEditNote = hasPermission('followups_add')
      const canDeleteNote = hasPermission('followups_delete')
      timelineHtml = `<div class="timeline">`
      customerFollowups.forEach(f => {
        const nextHtml = f.nextDate ? `<div class="timeline-next">پیگیری بعدی: ${f.nextDate}</div>` : ''
        const authorName = resolveUserNameByPhone(f.createdByPhone, detailUsers)
        const authorHtml = authorName
          ? `<span class="record-author" title="ثبت‌کننده">👤 ${escapeHtml(authorName)}</span>`
          : ''
        const isOverdoneNote = f.type === 'پیگیری معوقه انجام‌شده'
        const overdueTag = isOverdoneNote ? '<span class="overdue-tag">معوقه</span>' : ''
        const itemClass = isOverdoneNote ? ' timeline-item-overdue' : ''
        const followupKey = f.id != null ? String(f.id) : ''
        let actionsHtml = ''
        if (followupKey && (canEditNote || canDeleteNote)) {
          const editBtn = canEditNote
            ? `<button type="button" class="btn-icon" title="ویرایش" onclick="event.stopPropagation();app.editFollowup('${escapeAttr(followupKey)}')">✏</button>`
            : ''
          const deleteBtn = canDeleteNote
            ? `<button type="button" class="btn-icon" title="حذف" onclick="event.stopPropagation();app.deleteFollowup('${escapeAttr(followupKey)}')">🗑</button>`
            : ''
          actionsHtml = `<div class="timeline-actions">${editBtn}${deleteBtn}</div>`
        }
        timelineHtml += `
          <div class="timeline-item${itemClass}">
            <div class="timeline-header">
              <span class="timeline-date">${f.date}</span>
              <span class="timeline-type">${escapeHtml(f.type)}</span>
              ${overdueTag}
              ${authorHtml}
              ${actionsHtml}
            </div>
            <div class="timeline-result">${escapeHtml(f.result)}</div>
            ${f.notes ? `<div class="timeline-notes">${escapeHtml(f.notes)}</div>` : ''}
            ${nextHtml}
          </div>
        `
      })
      timelineHtml += `</div>`
    }

    const quickNoteHtml = canAddFollowup
      ? `
      <div class="detail-add-note" style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border);">
        <div style="font-size:13px;font-weight:600;margin-bottom:8px;">افزودن توضیحات جدید</div>
        <textarea class="form-textarea" id="detailQuickNote" placeholder="توضیحات جدید را اینجا بنویسید..." style="min-height:60px;margin-bottom:8px;"></textarea>
        <div class="form-row">
          <div class="form-group" style="margin-bottom:0;">
            <select class="form-select" id="detailQuickType" style="font-size:13px;padding:7px 10px;">
              <option value="دایرکت">دایرکت</option>
              <option value="تماس">تماس</option>
              <option value="کامنت">کامنت</option>
              <option value="پیام">پیام</option>
            </select>
          </div>
          <div class="form-group" style="margin-bottom:0;">
            <select class="form-select" id="detailQuickResult" style="font-size:13px;padding:7px 10px;">
              <option value="پاسخ داد">پاسخ داد</option>
              <option value="صحبت شد">صحبت شد</option>
              <option value="ارسال قیمت">ارسال قیمت</option>
              <option value="ارسال اطلاعات">ارسال اطلاعات</option>
              <option value="پیگیری">پیگیری</option>
              <option value="پاسخ نداد">پاسخ نداد</option>
              <option value="Happy Customer ❤️">Happy Customer ❤️</option>
            </select>
          </div>
          <div class="form-group" style="margin-bottom:0;">
            <button class="btn btn-primary" style="width:100%;" onclick="app.addQuickNote('${escapeAttr(c.id)}')">ثبت</button>
          </div>
        </div>
      </div>`
      : ''

    followupsPanelHtml = `
      <div class="detail-next-followup">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
          <div>
            <div style="font-size:13px;font-weight:600;margin-bottom:2px;">تاریخ پیگیری بعدی</div>
            <div style="font-size:13px;color:${c.nextFollowupDate ? 'var(--accent)' : 'var(--text-muted)'}; font-family:'Vazirmatn',sans-serif;">
              ${c.nextFollowupDate || 'تنظیم نشده'}
            </div>
          </div>
          ${followupDateControls}
        </div>
      </div>
      <div class="detail-timeline-title">
        تاریخچه پیگیری <span class="count">${customerFollowups.length}</span>
      </div>
      ${timelineHtml}
      ${quickNoteHtml}
    `
  }

  let html
  if (isNew) {
    html = `
      ${infoPanelHtml}
      <div class="detail-tab-empty" style="margin-top:8px;">پس از ایجاد مشتری، تب‌های فروش و پیگیری در دسترس خواهند بود.</div>
    `
  } else {
    const tabBtn = (key, count) => {
      const active = activeTab === key
      const countHtml = count != null
        ? `<span class="detail-tab-count">${formatNumber(count)}</span>`
        : ''
      return `<button type="button" class="detail-tab${active ? ' is-active' : ''}" role="tab"
        id="detailTabBtn-${key}" data-detail-tab="${key}"
        aria-selected="${active ? 'true' : 'false'}"
        aria-controls="detailTab-${key}"
        tabindex="${active ? '0' : '-1'}"
        onclick="app.switchDetailTab('${key}')">${DETAIL_TAB_LABELS[key]}${countHtml}</button>`
    }

    html = `
      <div class="detail-tabs" role="tablist" aria-label="بخش‌های پنل مشتری">
        ${tabBtn('info')}
        ${tabBtn('sales', salesCount)}
        ${tabBtn('followups', customerFollowups.length)}
      </div>
      <div class="detail-tab-panel${activeTab === 'info' ? ' is-active' : ''}" role="tabpanel" id="detailTab-info" aria-labelledby="detailTabBtn-info" ${activeTab === 'info' ? '' : 'hidden'}>
        ${infoPanelHtml}
      </div>
      <div class="detail-tab-panel${activeTab === 'sales' ? ' is-active' : ''}" role="tabpanel" id="detailTab-sales" aria-labelledby="detailTabBtn-sales" ${activeTab === 'sales' ? '' : 'hidden'}>
        ${salesPanelHtml}
      </div>
      <div class="detail-tab-panel${activeTab === 'followups' ? ' is-active' : ''}" role="tabpanel" id="detailTab-followups" aria-labelledby="detailTabBtn-followups" ${activeTab === 'followups' ? '' : 'hidden'}>
        ${followupsPanelHtml}
      </div>
    `
  }

  detailPanelState = {
    customerId: isNew ? null : c.id,
    tab: activeTab,
    canEdit,
    canDelete
  }

  document.getElementById('detailBody').innerHTML = html
  renderDetailFooter({ isNew, canEdit, canDelete, customerId: c.id, tab: activeTab })
  document.getElementById('detailModal').classList.add('active')

  if (canEdit) {
    phoneFormMode = 'detail'
    phoneFieldState = { status: 'ok', customer: null, lastActivity: null, index: 0 }
    const existingPhones = isNew ? [] : getCustomerPhones(c)
    phoneSlots = existingPhones.length ? [...existingPhones] : ['']
    const existingAddresses = isNew ? [] : getCustomerAddresses(c)
    addressSlots = existingAddresses.length
      ? existingAddresses.map(a => ({ text: a.text || '', postalCode: a.postalCode || '' }))
      : [{ text: '', postalCode: '' }]
    populatePlatformDropdown(document.getElementById('detailPlatform'))
    populateStatusDropdown(document.getElementById('detailStatus'))
    const platformEl = document.getElementById('detailPlatform')
    const statusEl = document.getElementById('detailStatus')
    if (platformEl) platformEl.value = c.platform || 'instagram'
    if (statusEl) statusEl.value = c.status || 'new'
    renderPhoneFields()
    renderAddressFields()
    if (activeTab === 'info') document.getElementById('detailPlatformId')?.focus()
  }

  if (!isNew) renderProducts(c.id, detailUsers)

  if ((activeTab === 'followups' || activeTab === 'sales') && window.jalaliDatepicker) {
    try { window.jalaliDatepicker.startWatch({ time: false, zIndex: 11000 }) } catch (_) { /* ignore */ }
  }
}

function resolveUserNameByPhone(phone, users = []) {
  const p = normalizePhone(phone)
  if (!p) return ''
  const u = (users || []).find(x => normalizePhone(x.phone) === p)
  return u ? userDisplayName(u) : ''
}

export async function setNextFollowup(customerId) {
  const data = getData()
  const customer = data.customers.find(c => c.id === customerId)
  if (!customer || !canScheduleFollowupOnCustomer(customer)) {
    showToast('شما دسترسی تنظیم تاریخ پیگیری برای این مشتری را ندارید')
    return
  }
  const input = document.getElementById('detailFollowupDate')
  const date = input?.value.trim() || ''
  if (!date) { showToast('تاریخ را وارد کنید'); return }
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(date)) { showToast('فرمت تاریخ صحیح نیست (1405/05/01)'); return }

  const isOwner = canManageCustomer(customer)
  let scheduleNote = ''
  if (!isOwner) {
    scheduleNote = document.getElementById('detailFollowupScheduleNote')?.value.trim() || ''
    if (!scheduleNote) {
      showToast('توضیحات برای کارشناس مسئول الزامی است')
      return
    }
  }

  const idx = data.customers.findIndex(c => c.id === customerId)
  if (idx === -1) return

  data.customers[idx].nextFollowupDate = date
  try {
    if (!isOwner) {
      const today = getTodayJalaliStr()
      const newFollowup = {
        customerId,
        date: today,
        type: 'سیستمی',
        result: 'درخواست پیگیری',
        nextDate: date,
        notes: scheduleNote,
        createdByPhone: normalizePhone(getCurrentUser()?.phone || ''),
        status: 'pending'
      }
      const id = await saveFollowupToDB(newFollowup)
      newFollowup.id = id
      data.followups.push(newFollowup)
    }
    await saveCustomerToDB(data.customers[idx])
    await renderCustomers()
    openCustomerDetail(customerId)
    showToast(isOwner ? 'تاریخ پیگیری تنظیم شد' : 'پیگیری برای کارشناس مسئول ثبت شد')
  } catch (e) {
    console.error('setNextFollowup error:', e)
    showToast('خطا در ذخیره تاریخ پیگیری')
  }
}

export async function clearNextFollowup(customerId) {
  if (!requirePermission('customers_add')) return
  const data = getData()
  const customer = data.customers.find(c => c.id === customerId)
  if (!canManageCustomer(customer)) {
    showToast('فقط کارشناس مسئول می‌تواند تاریخ پیگیری را حذف کند')
    return
  }
  const idx = data.customers.findIndex(c => c.id === customerId)
  if (idx !== -1) {
    data.customers[idx].nextFollowupDate = ''
    try {
      await saveCustomerToDB(data.customers[idx])
      await renderCustomers()
      openCustomerDetail(customerId)
      showToast('تاریخ پیگیری حذف شد')
    } catch (e) {
      console.error('clearNextFollowup error:', e)
      showToast('خطا در حذف تاریخ پیگیری')
    }
  }
}

export async function addQuickNote(customerId) {
  if (!requirePermission('followups_add')) return
  const data = getData()
  const customer = data.customers.find(c => c.id === customerId)
  if (!canAddNoteOnCustomer(customer)) {
    showToast('شما دسترسی ثبت یادداشت برای این مشتری را ندارید')
    return
  }
  const textarea = document.getElementById('detailQuickNote')
  const notes = textarea.value.trim()
  const type = document.getElementById('detailQuickType').value
  const result = document.getElementById('detailQuickResult').value

  if (!notes) { showToast('توضیحات را وارد کنید'); return }

  const today = new Date()
  const jalali = toJalali(today)
  const dateStr = `${jalali.year}/${String(jalali.month).padStart(2, '0')}/${String(jalali.day).padStart(2, '0')}`

  const newFollowup = { customerId, date: dateStr, type, result, nextDate: '', notes, createdByPhone: normalizePhone(getCurrentUser()?.phone || '') }
  try {
    const id = await saveFollowupToDB(newFollowup)
    newFollowup.id = id
    data.followups.push(newFollowup)
    await renderCustomers()
    openCustomerDetail(customerId)
    showToast('توضیحات ثبت شد')
  } catch (e) {
    console.error('addQuickNote error:', e)
    showToast(e.message || 'خطا در ذخیره توضیحات')
  }
}

export async function updateCustomerAdvisor(customerId, advisorPhoneValue) {
  const data = getData()
  const c = data.customers.find(x => x.id === customerId)
  if (!c) return
  if (!canViewCustomer(c)) { showToast('شما به این مشتری دسترسی ندارید'); return }
  if (!canTransferCustomer(c)) {
    showToast('شما مجاز به انتقال این مشتری نیستید')
    return
  }
  const users = await getUsersSafe()
  const { advisor, advisorPhone } = resolveAdvisor(advisorPhoneValue, users)
  if (!advisorPhone) {
    showToast('کارشناس مقصد نامعتبر است')
    return
  }
  try {
    const result = await reassignCustomerOwnership({
      customer: c,
      toAdvisor: advisor,
      toAdvisorPhone: advisorPhone,
      reason: 'handoff'
    })
    await renderCustomers()
    updateTransferInboxBadge()
    if (result.skipped) showToast('کارشناس مسئول تغییری نکرد')
    else showToast('کارشناس مسئول تغییر کرد')
    if (document.getElementById('detailBody') && document.getElementById('detailModal')?.classList.contains('active')) {
      await openCustomerDetail(customerId)
    }
  } catch (e) {
    console.error('updateCustomerAdvisor error:', e)
    showToast(e?.message || 'خطا در ذخیره کارشناس')
  }
}

export async function updateCustomerLevel(customerId, levelValue) {
  if (!isAdmin()) {
    showToast('فقط مدیر می‌تواند سطح مشتری را تغییر دهد')
    return
  }
  const data = getData()
  const c = data.customers.find(x => x.id === customerId)
  if (!c) return

  if (levelValue === 'auto') {
    c.customerLevelLocked = false
    syncCustomerLevel(c, data.customers, data.followups)
  } else {
    const level = parseCustomerLevel(levelValue)
    if (!level || !CUSTOMER_LEVELS[level]) {
      showToast('سطح نامعتبر است')
      return
    }
    c.customerLevel = level
    c.customerLevelLocked = true
  }

  try {
    await saveCustomerToDB(c)
    await renderCustomers()
    openCustomerDetail(customerId)
    showToast('سطح مشتری ذخیره شد')
  } catch (e) {
    console.error('updateCustomerLevel error:', e)
    showToast('خطا در ذخیره سطح مشتری')
  }
}

export function closeDetailModal() {
  document.getElementById('detailModal').classList.remove('active')
  phoneFormMode = 'detail'
  detailPanelState = { customerId: null, tab: 'info', canEdit: false, canDelete: false }
}

// ============================================
// Product Management
// ============================================

const PRODUCT_STATUSES = ['تکمیل', 'بیعانه'] // kept for legacy references
// Product / bundle names come from settings: getSellableNames()

export function getProducts(customerId) {
  const data = getData()
  const c = data.customers.find(x => x.id === customerId)
  if (!c || !c.products) return []
  c.products.forEach(p => {
    ensureProductPayments(p)
    syncProductStatus(p)
  })
  return c.products
}

export async function setProducts(customerId, products) {
  const data = getData()
  const idx = data.customers.findIndex(c => c.id === customerId)
  if (idx === -1) return
  if (!canAddSaleOnCustomer(data.customers[idx])) {
    showToast('شما دسترسی ثبت فروش برای این مشتری را ندارید')
    return
  }
  products.forEach(p => syncProductStatus(p))
  data.customers[idx].products = products
  syncCustomerLevel(data.customers[idx], data.customers, data.followups)
  await saveCustomerToDB(data.customers[idx])
}
let detailUsersCache = []

function syncDetailTabCount(tabKey, count) {
  const btn = document.querySelector(`#detailBody .detail-tab[data-detail-tab="${tabKey}"] .detail-tab-count`)
  if (btn) btn.textContent = formatNumber(count)
}

function saleFieldHtml(label, controlHtml, { required = false, optional = false, className = '', full = false } = {}) {
  const req = required ? ' <span class="sale-field-req" aria-hidden="true">*</span>' : ''
  const opt = optional ? ' <span class="sale-field-opt">اختیاری</span>' : ''
  const cls = ['sale-field', full ? 'sale-field--full' : '', className].filter(Boolean).join(' ')
  return `<div class="${cls}">
    <label class="sale-field-label">${label}${req}${opt}</label>
    <div class="sale-field-control">${controlHtml}</div>
  </div>`
}

export async function renderProducts(customerId, users = null) {
  const container = document.getElementById('detailProductsList')
  if (!container) return
  const products = getProducts(customerId)
  syncDetailTabCount('sales', products.length)
  const data = getData()
  const customer = data.customers.find(c => c.id === customerId)
  const canEdit = canAddSaleOnCustomer(customer)
  if (users) detailUsersCache = users
  else if (!detailUsersCache.length) {
    try { detailUsersCache = await getUsersSafe() } catch (_) { detailUsersCache = [] }
  }
  const usersList = detailUsersCache

  if (products.length === 0) {
    container.innerHTML = '<div class="detail-tab-empty">فروشی ثبت نشده</div>'
    return
  }

  container.innerHTML = products.map((p, i) => {
    const price = parseFloat(p.price) || 0
    const approved = getApprovedPaid(p)
    const balance = getOperationalBalance(p)
    const pays = getProductPayments(p)
    const worst = getWorstPaymentStatus(p)
    const closed = isInvoiceClosed(p)
    const priceLocked = isProductPriceLocked(p)
    const statusLabel = p.status || 'بیعانه'
    const statusColor = statusLabel === 'تکمیل' ? 'var(--success)' : 'var(--warning)'
    const blockClass = ['product-block', worst === 'rejected' ? 'is-rejected' : '', closed ? 'is-closed' : ''].filter(Boolean).join(' ')
    const closedBadge = closed ? '<span class="invoice-closed-badge">فاکتور بسته شده</span>' : ''

    const paymentsHtml = pays.map((pay, pi) => {
      const payStatus = getPaymentEntryStatus(pay)
      const payLabel = PAYMENT_STATUS_LABELS[payStatus] || payStatus
      const rejectHint = (payStatus === 'rejected' && pay.paymentRejectReason)
        ? `<span class="payment-reject-reason" title="${escapeAttr(pay.paymentRejectReason)}">${escapeHtml(pay.paymentRejectReason)}</span>`
        : ''
      const canDeletePay = canEdit && payStatus !== PAYMENT_STATUS.approved
      const payEditable = canEdit && payStatus !== PAYMENT_STATUS.approved
      const filled = isPaymentFilled(pay)
      const pristineDraft = payEditable && isPaymentPristineDraft(pay)
      const incomplete = payEditable && !filled && !pristineDraft
      const badge = pristineDraft
        ? `<span class="payment-badge payment-draft">در حال تکمیل…</span>`
        : `<span class="payment-badge payment-${payStatus}">${escapeHtml(payLabel)}</span>${rejectHint}`
      const sellerName = resolveUserNameByPhone(pay.soldByPhone || p.soldByPhone, usersList)
      const sellerHtml = sellerName
        ? `<span class="record-author" title="ثبت‌کننده فروش">👤 ${escapeHtml(sellerName)}</span>`
        : ''
      const head = `
        <div class="sale-payment-head">
          <span class="payment-index">واریز ${pi + 1}${sellerHtml}</span>
          <div class="sale-payment-head-actions">
            ${badge}
            ${canDeletePay ? `<button type="button" class="btn-remove-product" title="حذف واریز" onclick="app.removeProductPayment('${escapeAttr(customerId)}', ${i}, ${pi})">✕</button>` : ''}
          </div>
        </div>`

      if (!payEditable) {
        const bankVal = String(pay.destinationBank || '').trim()
        return `
          <div class="sale-payment payment-row is-readonly" data-payment-index="${pi}">
            ${head}
            <div class="sale-fields">
              ${saleFieldHtml('مبلغ', `<span class="sale-readonly-value" style="direction:ltr;">${pay.amount ? formatNumber(pay.amount) + ' ریال' : '—'}</span>`)}
              ${saleFieldHtml('تاریخ و ساعت', `<span class="sale-readonly-value" style="direction:ltr;">${escapeHtml(formatSoldAt24h(pay.soldAt) || '—')}</span>`)}
              ${saleFieldHtml('بانک مقصد', `<span class="sale-readonly-value">${escapeHtml(bankVal) || '—'}</span>`)}
              ${saleFieldHtml('واریزکننده', `<span class="sale-readonly-value">${escapeHtml(pay.depositorName || '—')}</span>`, { optional: true })}
            </div>
          </div>`
      }

      const rowStateClass = pristineDraft ? ' is-draft' : (incomplete ? ' is-incomplete' : '')
      const submitLabel = (!priceLocked && pi === 0) ? 'ثبت فروش' : 'ثبت واریز'
      return `
        <div class="sale-payment payment-row${rowStateClass}" data-payment-index="${pi}">
          ${head}
          <div class="sale-fields">
            ${saleFieldHtml('مبلغ (ریال)', `<input type="text" inputmode="numeric" class="product-deposit num-input" data-pay-field="amount" placeholder="مثلاً ۵٬۰۰۰٬۰۰۰" value="${pay.amount ? formatNumber(pay.amount) : ''}" oninput="app.formatInput(this);app.markSalePaymentTouched(this)" title="واحد: ریال">`, { required: true })}
            ${saleFieldHtml('تاریخ', `<input type="text" class="product-settlement" data-pay-field="soldAtDate" placeholder="انتخاب تاریخ" data-jdp value="${pay.soldAt ? pay.soldAt.split(' ')[0] : ''}" onchange="app.markSalePaymentTouched(this)">`, { required: true })}
            ${saleFieldHtml('ساعت', `<input type="text" class="product-settlement product-time" data-pay-field="soldAtTime" inputmode="numeric" placeholder="۱۴:۳۰" maxlength="5" value="${escapeAttr(soldAtTimePart(pay.soldAt))}" oninput="app.markSalePaymentTouched(this)" title="ساعت ۲۴ ساعته، مثلاً ۱۴:۳۰">`, { required: true })}
            ${saleFieldHtml('بانک مقصد', renderDestinationBankField(customerId, i, pi, pay, true), { required: true, className: 'sale-field--bank' })}
            ${saleFieldHtml('نام واریزکننده', `<input type="text" class="product-settlement product-depositor" data-pay-field="depositorName" placeholder="در صورت نیاز" value="${escapeAttr(pay.depositorName || '')}" oninput="app.markSalePaymentTouched(this)">`, { optional: true, full: true })}
          </div>
          <div class="sale-payment-actions">
            <button type="button" class="btn btn-sm btn-primary sale-submit-btn" data-sale-submit onclick="app.commitSalePayment('${escapeAttr(customerId)}', ${i}, ${pi})">${submitLabel}</button>
          </div>
        </div>`
    }).join('')

    let addPayBtn = ''
    if (canEdit && !closed) {
      const filled = areProductPaymentsFilled(p)
      const needsPrice = !price
      const disabled = !filled || needsPrice
      const title = needsPrice
        ? 'ابتدا فروش را با دکمه ثبت ذخیره کنید'
        : (!filled ? 'ابتدا واریزهای فعلی را با دکمه ثبت ذخیره کنید' : `مانده: ${formatNumber(balance)}`)
      addPayBtn = `<button type="button" class="btn btn-sm sale-add-pay-btn" ${disabled ? 'disabled' : ''} title="${escapeAttr(title)}" onclick="app.addProductPayment('${escapeAttr(customerId)}', ${i})">+ افزودن واریز${balance > 0 ? ` (مانده: ${formatNumber(balance)})` : ''}</button>`
    }

    const priceControl = (!canEdit || priceLocked)
      ? `<span class="product-price-locked sale-readonly-value" title="قیمت کل قفل شده"><b style="font-family:'Vazirmatn',sans-serif;direction:ltr;">${price ? formatNumber(price) : '—'}</b> ریال</span>`
      : `<input type="text" inputmode="numeric" class="product-price num-input" data-sale-field="price" placeholder="مثلاً ۱۰٬۰۰۰٬۰۰۰" value="${p.price ? formatNumber(p.price) : ''}" oninput="app.formatInput(this)" title="واحد: ریال">`

    const settlementControl = canEdit && !closed
      ? `<input type="text" class="product-settlement" data-sale-field="settlementDate" placeholder="انتخاب تاریخ" data-jdp value="${p.settlementDate || ''}">`
      : (p.settlementDate
        ? `<span class="sale-readonly-value">${escapeHtml(p.settlementDate)}</span>`
        : `<span class="sale-readonly-value sale-readonly-empty">—</span>`)

    const catalog = getSellableNames()
    const displayName = coerceProductName(p.name)
    const nameOptions = catalog.slice()
    if (displayName && !nameOptions.includes(displayName)) nameOptions.unshift(displayName)
    const bundle = getBundleByName(displayName)
    const bundleHint = bundle
      ? `<span class="product-bundle-hint" data-bundle-hint>شامل: ${escapeHtml((bundle.productNames || []).join('، '))}</span>`
      : `<span class="product-bundle-hint" data-bundle-hint hidden></span>`
    const nameControl = canEdit && !closed
      ? `<select class="product-name" data-sale-field="name" onchange="app.onSaleProductNameChange(this)">
            ${nameOptions.map(pr => `<option value="${escapeAttr(pr)}" ${displayName === pr ? 'selected' : ''}>${escapeHtml(pr)}</option>`).join('')}
          </select>${bundleHint}`
      : `<span class="sale-readonly-value" style="font-weight:600;">${escapeHtml(displayName || '—')}</span>${bundleHint}`

    const isPhysical = isPhysicalSaleLine(p)
    let shippingFields = ''
    if (canEdit && !closed) {
      shippingFields = `<div class="sale-shipping-fields sale-fields" data-shipping-fields ${isPhysical ? '' : 'hidden'}>
          ${saleFieldHtml('آدرس گیرنده', `<input type="text" class="product-settlement product-shipping-address" data-sale-field="shippingAddress" placeholder="آدرس کامل" value="${escapeAttr(p.shippingAddress || '')}">`, { optional: true, full: true })}
          ${saleFieldHtml('کد پستی', `<input type="text" class="product-settlement product-shipping-postal" data-sale-field="shippingPostalCode" inputmode="numeric" placeholder="۱۰ رقم" value="${escapeAttr(p.shippingPostalCode || '')}">`, { optional: true })}
        </div>`
    } else if (isPhysical && (p.shippingAddress || p.shippingPostalCode)) {
      shippingFields = `
          ${saleFieldHtml('آدرس گیرنده', `<span class="sale-readonly-value">${escapeHtml(p.shippingAddress || '—')}</span>`, { optional: true, full: true })}
          ${p.shippingPostalCode ? saleFieldHtml('کد پستی', `<span class="sale-readonly-value">${escapeHtml(p.shippingPostalCode)}</span>`, { optional: true }) : ''}`
    }

    const hasEditablePay = canEdit && pays.some(pay => getPaymentEntryStatus(pay) !== PAYMENT_STATUS.approved)
    const productDetailsBtn = (canEdit && !closed && !hasEditablePay)
      ? `<button type="button" class="btn btn-sm sale-product-save-btn" onclick="app.commitSaleProductDetails('${escapeAttr(customerId)}', ${i})">ذخیره جزئیات محصول</button>`
      : ''

    const summaryHtml = `
      <div class="sale-summary" aria-label="خلاصه مالی">
        <span class="product-status-label" style="color:${statusColor};">${escapeHtml(statusLabel)}</span>
        <span class="product-meta">پرداخت‌شده: <b style="font-family:'Vazirmatn',sans-serif;direction:ltr;">${approved ? formatNumber(approved) : '۰'}</b></span>
        ${balance > 0 && !closed ? `<span class="product-balance negative">مانده: ${formatNumber(balance)}</span>` : `<span class="product-meta">مانده: <b style="font-family:'Vazirmatn',sans-serif;direction:ltr;">۰</b></span>`}
        ${closedBadge}
      </div>`

    return `
      <div class="${blockClass}" data-product-index="${i}">
        <section class="sale-step sale-step-product">
          <h4 class="sale-step-title">۱. محصول</h4>
          <div class="sale-fields">
            ${saleFieldHtml('محصول', nameControl, { required: true, full: true, className: 'sale-field--name' })}
            ${saleFieldHtml('قیمت کل (ریال)', priceControl, { required: true })}
            ${saleFieldHtml('تاریخ تسویه', settlementControl, { optional: true })}
          </div>
          ${shippingFields}
          ${summaryHtml}
          ${productDetailsBtn}
        </section>
        <section class="sale-step sale-step-payments">
          <h4 class="sale-step-title">۲. واریزها</h4>
          <div class="payment-list">${paymentsHtml || '<div class="payment-empty">هنوز واریزی ثبت نشده</div>'}</div>
          ${addPayBtn}
        </section>
      </div>`
  }).join('')

  if (window.jalaliDatepicker) {
    try { window.jalaliDatepicker.startWatch({ time: false, zIndex: 11000 }) } catch (_) { /* ignore */ }
  }
}

export async function addProductRow(customerId) {
  const data = getData()
  const customer = data.customers.find(c => c.id === customerId)
  if (!canAddSaleOnCustomer(customer)) {
    showToast('شما دسترسی ثبت فروش برای این مشتری را ندارید')
    return
  }
  const products = getProducts(customerId)
  const user = getCurrentUser()
  const firstPay = createPayment({
    soldByPhone: normalizePhone(user?.phone || ''),
    depositorName: ''
  })
  const catalog = getSellableNames()
  if (!catalog.length) {
    showToast('ابتدا از تنظیمات، کاتالوگ محصولات را تعریف کنید')
    return
  }
  products.push({
    name: coerceProductName(catalog[0]) || catalog[0],
    status: 'بیعانه',
    price: '',
    priceLocked: false,
    deposit: '',
    settlementDate: '',
    soldByPhone: normalizePhone(user?.phone || ''),
    payments: [firstPay]
  })
  const line = products[products.length - 1]
  applyProfitSnapshotToProduct(line)
  syncProductStatus(line)
  await setProducts(customerId, products)
  renderProducts(customerId)
}

export async function addProductPayment(customerId, productIndex) {
  const _cust = getData().customers.find(c => c.id === customerId)
  if (!canAddSaleOnCustomer(_cust)) {
    showToast('شما دسترسی ثبت فروش برای این مشتری را ندارید')
    return
  }
  const products = getProducts(customerId)
  const product = products[productIndex]
  if (!product) return
  ensureProductPayments(product)
  syncProductStatus(product)

  if (isInvoiceClosed(product)) {
    showToast('فاکتور این محصول بسته شده و امکان ثبت واریز جدید نیست')
    return
  }
  if (!(parseFloat(product.price) || 0)) {
    showToast('ابتدا فروش را با دکمه ثبت ذخیره کنید')
    return
  }
  if (!areProductPaymentsFilled(product)) {
    showToast('ابتدا واریزهای فعلی را با دکمه ثبت ذخیره کنید')
    return
  }

  const user = getCurrentUser()
  const balance = getOperationalBalance(product)
  const suggested = balance > 0 ? String(balance) : ''
  product.payments.push(createPayment({
    amount: suggested,
    soldByPhone: normalizePhone(user?.phone || ''),
    depositorName: ''
  }))
  syncProductStatus(product)
  await setProducts(customerId, products)
  renderProducts(customerId)
}

export async function removeProductPayment(customerId, productIndex, paymentIndex) {
  const _cust = getData().customers.find(c => c.id === customerId)
  if (!canAddSaleOnCustomer(_cust)) {
    showToast('شما دسترسی ثبت فروش برای این مشتری را ندارید')
    return
  }
  const products = getProducts(customerId)
  const product = products[productIndex]
  if (!product) return
  ensureProductPayments(product)
  const pay = product.payments[paymentIndex]
  if (!pay) return
  if (getPaymentEntryStatus(pay) === PAYMENT_STATUS.approved) {
    showToast('واریز تأییدشده قابل حذف نیست')
    return
  }
  if (!window.confirm('این واریز حذف شود؟')) return
  product.payments.splice(paymentIndex, 1)
  syncProductStatus(product)
  await setProducts(customerId, products)
  renderProducts(customerId)
  showToast('واریز حذف شد')
}

function resetPaymentEntry(pay) {
  pay.paymentStatus = 'pending'
  pay.paymentRejectReason = ''
  pay.paymentReviewedAt = ''
  pay.paymentReviewedBy = ''
}

function unformatSaleNumber(el) {
  if (!el) return ''
  return String(el.value || '').replace(/[^\d]/g, '')
}

function markSaleFieldInvalid(el, invalid) {
  const field = el?.closest?.('.sale-field')
  if (field) field.classList.toggle('is-invalid', !!invalid)
  if (el) el.classList.toggle('is-invalid', !!invalid)
}

function clearSaleBlockInvalid(blockEl) {
  blockEl?.querySelectorAll('.is-invalid').forEach(el => el.classList.remove('is-invalid'))
}

function readSaleProductDraft(blockEl) {
  const nameEl = blockEl.querySelector('[data-sale-field="name"]')
  const priceEl = blockEl.querySelector('[data-sale-field="price"]')
  const settlementEl = blockEl.querySelector('[data-sale-field="settlementDate"]')
  const addressEl = blockEl.querySelector('[data-sale-field="shippingAddress"]')
  const postalEl = blockEl.querySelector('[data-sale-field="shippingPostalCode"]')
  return {
    name: nameEl ? nameEl.value : null,
    price: priceEl ? unformatSaleNumber(priceEl) : null,
    settlementDate: settlementEl ? String(settlementEl.value || '').trim() : null,
    shippingAddress: addressEl ? String(addressEl.value || '').trim().replace(/\s+/g, ' ') : null,
    shippingPostalCode: postalEl ? toEnDigits(String(postalEl.value || '')).trim().replace(/\s+/g, '') : null,
    priceEl,
    nameEl
  }
}

function readSalePaymentDraft(payEl) {
  const amountEl = payEl.querySelector('[data-pay-field="amount"]')
  const dateEl = payEl.querySelector('[data-pay-field="soldAtDate"]')
  const timeEl = payEl.querySelector('[data-pay-field="soldAtTime"]')
  const bankSelect = payEl.querySelector('[data-pay-field="destinationBank"]')
  const customBank = payEl.querySelector('.bank-custom-input')
  const depositorEl = payEl.querySelector('[data-pay-field="depositorName"]')
  let destinationBank = bankSelect ? String(bankSelect.value || '').trim() : ''
  if (destinationBank === '__custom__') {
    destinationBank = customBank ? String(customBank.value || '').trim() : ''
  }
  return {
    amount: unformatSaleNumber(amountEl),
    soldAtDate: dateEl ? toEnDigits(String(dateEl.value || '')).trim() : '',
    soldAtTime: timeEl ? String(timeEl.value || '').trim() : '',
    destinationBank,
    depositorName: depositorEl ? String(depositorEl.value || '').trim() : '',
    amountEl,
    dateEl,
    timeEl,
    bankSelect,
    customBank
  }
}

function applySaleProductDraft(product, draft, { lockPrice = false } = {}) {
  if (draft.name != null) {
    product.name = coerceProductName(draft.name) || draft.name
    applyProfitSnapshotToProduct(product)
  }
  if (draft.settlementDate != null) {
    product.settlementDate = draft.settlementDate
  }
  if (draft.price != null && draft.price !== '') {
    const num = parseFloat(draft.price) || 0
    if (num > 0) {
      if (!isProductPriceLocked(product) || !(parseFloat(product.price) || 0)) {
        product.price = String(num)
        if (lockPrice) product.priceLocked = true
        applyProfitSnapshotToProduct(product)
      }
    }
  }
  if (isPhysicalSaleLine(product)) {
    if (draft.shippingAddress != null) product.shippingAddress = draft.shippingAddress
    if (draft.shippingPostalCode != null) product.shippingPostalCode = draft.shippingPostalCode
  } else {
    product.shippingAddress = ''
    product.shippingPostalCode = ''
  }
}

export function onSaleProductNameChange(selectEl) {
  const block = selectEl?.closest('.product-block')
  if (!block) return
  const name = selectEl.value
  const shipping = block.querySelector('[data-shipping-fields]')
  if (shipping) shipping.hidden = !isPhysicalSaleLine({ name })
  const hint = block.querySelector('[data-bundle-hint]')
  if (hint) {
    const bundle = getBundleByName(coerceProductName(name) || name)
    if (bundle?.productNames?.length) {
      hint.hidden = false
      hint.textContent = `شامل: ${(bundle.productNames || []).join('، ')}`
    } else {
      hint.hidden = true
      hint.textContent = ''
    }
  }
}

/** Switch calm draft state → yellow incomplete once the user starts editing. */
export function markSalePaymentTouched(el) {
  const payEl = el?.closest?.('.sale-payment')
  if (!payEl || !payEl.classList.contains('is-draft')) return
  payEl.classList.remove('is-draft')
  payEl.classList.add('is-incomplete')
  const badge = payEl.querySelector('.payment-badge.payment-draft')
  if (badge) {
    badge.className = 'payment-badge payment-pending'
    badge.textContent = PAYMENT_STATUS_LABELS.pending || 'در انتظار تأیید'
  }
}

export async function commitSaleProductDetails(customerId, productIndex) {
  const customer = getData().customers.find(c => c.id === customerId)
  if (!canAddSaleOnCustomer(customer)) {
    showToast('شما دسترسی ثبت فروش برای این مشتری را ندارید')
    return
  }
  const block = document.querySelector(`#detailProductsList .product-block[data-product-index="${productIndex}"]`)
  if (!block) return
  const products = getProducts(customerId)
  const product = products[productIndex]
  if (!product) return
  if (isInvoiceClosed(product)) {
    showToast('فاکتور بسته شده و قابل ویرایش نیست')
    return
  }

  const btn = block.querySelector('.sale-product-save-btn')
  const prevLabel = btn?.textContent
  if (btn) {
    btn.disabled = true
    btn.textContent = 'در حال ذخیره…'
  }

  try {
    const draft = readSaleProductDraft(block)
    clearSaleBlockInvalid(block)
    if (draft.nameEl && !String(draft.name || '').trim()) {
      markSaleFieldInvalid(draft.nameEl, true)
      showToast('محصول را انتخاب کنید')
      return
    }
    applySaleProductDraft(product, draft, { lockPrice: false })
    if (product.shippingAddress) {
      appendCustomerAddressIfNew(customer, {
        text: product.shippingAddress,
        postalCode: product.shippingPostalCode || ''
      })
    }
    syncProductStatus(product)
    await setProducts(customerId, products)
    showToast('جزئیات محصول ذخیره شد')
    renderProducts(customerId)
  } catch (e) {
    console.error('commitSaleProductDetails error:', e)
    showToast('خطا در ذخیره جزئیات محصول')
  } finally {
    if (btn) {
      btn.disabled = false
      if (prevLabel) btn.textContent = prevLabel
    }
  }
}

export async function commitSalePayment(customerId, productIndex, paymentIndex) {
  const customer = getData().customers.find(c => c.id === customerId)
  if (!canAddSaleOnCustomer(customer)) {
    showToast('شما دسترسی ثبت فروش برای این مشتری را ندارید')
    return
  }

  const block = document.querySelector(`#detailProductsList .product-block[data-product-index="${productIndex}"]`)
  const payEl = block?.querySelector(`.sale-payment[data-payment-index="${paymentIndex}"]`)
  if (!block || !payEl) return

  const products = getProducts(customerId)
  const product = products[productIndex]
  if (!product) return
  ensureProductPayments(product)
  const pay = product.payments[paymentIndex]
  if (!pay) return
  if (getPaymentEntryStatus(pay) === PAYMENT_STATUS.approved) {
    showToast('واریز تأییدشده قابل ویرایش نیست')
    return
  }
  if (isInvoiceClosed(product)) {
    showToast('فاکتور بسته شده و قابل ویرایش نیست')
    return
  }

  const productDraft = readSaleProductDraft(block)
  const paymentDraft = readSalePaymentDraft(payEl)
  clearSaleBlockInvalid(block)

  let hasError = false
  const priceLocked = isProductPriceLocked(product)
  if (!priceLocked) {
    const priceNum = parseFloat(productDraft.price) || 0
    if (priceNum <= 0) {
      markSaleFieldInvalid(productDraft.priceEl, true)
      hasError = true
    }
  }
  if (productDraft.nameEl && !String(productDraft.name || '').trim()) {
    markSaleFieldInvalid(productDraft.nameEl, true)
    hasError = true
  }

  const amountNum = parseFloat(paymentDraft.amount) || 0
  if (amountNum <= 0) {
    markSaleFieldInvalid(paymentDraft.amountEl, true)
    hasError = true
  }
  if (!paymentDraft.soldAtDate || paymentDraft.soldAtDate.split('/').length !== 3) {
    markSaleFieldInvalid(paymentDraft.dateEl, true)
    hasError = true
  }
  const time24 = normalizeTimeTo24h(paymentDraft.soldAtTime)
  if (!paymentDraft.soldAtTime || !time24) {
    markSaleFieldInvalid(paymentDraft.timeEl, true)
    hasError = true
  }
  if (!paymentDraft.destinationBank) {
    markSaleFieldInvalid(paymentDraft.bankSelect || paymentDraft.customBank, true)
    if (paymentDraft.customBank) markSaleFieldInvalid(paymentDraft.customBank, true)
    hasError = true
  }

  if (hasError) {
    payEl.classList.remove('is-draft')
    payEl.classList.add('is-incomplete')
    const draftBadge = payEl.querySelector('.payment-badge.payment-draft')
    if (draftBadge) {
      draftBadge.className = 'payment-badge payment-pending'
      draftBadge.textContent = PAYMENT_STATUS_LABELS.pending || 'در انتظار تأیید'
    }
    showToast('فیلدهای الزامی را کامل کنید')
    return
  }

  const btn = payEl.querySelector('[data-sale-submit]')
  const prevLabel = btn?.textContent
  if (btn) {
    btn.disabled = true
    btn.textContent = 'در حال ثبت…'
  }

  try {
    const wasFilled = isPaymentFilled(pay)
    applySaleProductDraft(product, productDraft, { lockPrice: true })

    if (product.shippingAddress) {
      appendCustomerAddressIfNew(customer, {
        text: product.shippingAddress,
        postalCode: product.shippingPostalCode || ''
      })
    }

    pay.amount = String(amountNum)
    pay.soldAt = `${paymentDraft.soldAtDate} ${time24}`
    pay.destinationBank = paymentDraft.destinationBank
    pay.depositorName = paymentDraft.depositorName
    resetPaymentEntry(pay)
    syncProductStatus(product)

    await setProducts(customerId, products)
    showToast(`واریز ${paymentIndex + 1} ثبت شد — در انتظار تأیید حسابداری`)
    maybeBroadcastSaleToast(customer, product, pay, wasFilled)
    renderProducts(customerId)
  } catch (e) {
    console.error('commitSalePayment error:', e)
    showToast('خطا در ثبت فروش')
    if (btn) {
      btn.disabled = false
      if (prevLabel) btn.textContent = prevLabel
    }
  }
}

async function maybeBroadcastSaleToast(customer, product, payment, wasFilled) {
  if (wasFilled || !isPaymentFilled(payment)) return
  if (payment._saleToastSent) return
  payment._saleToastSent = true
  try {
    await broadcastSaleToast(buildSaleToastPayload({ customer, product, payment }))
  } catch (e) {
    payment._saleToastSent = false
    console.error('sale toast broadcast error:', e)
  }
}

function renderDestinationBankField(customerId, productIndex, paymentIndex, pay, editable) {
  const banks = getDestinationBanks()
  const value = String(pay.destinationBank || '').trim()
  const inList = value && banks.some(b => b === value)
  const isCustom = !!(value && !inList)

  if (!editable) {
    return `<span style="font-size:13px;">${escapeHtml(value) || '—'}</span>`
  }

  const options = [
    `<option value="">انتخاب کنید</option>`,
    ...banks.map(b => `<option value="${escapeAttr(b)}" ${value === b ? 'selected' : ''}>${escapeHtml(b)}</option>`),
    `<option value="__custom__" ${isCustom ? 'selected' : ''}>سایر (ورود دستی)</option>`
  ].join('')

  return `
    <div class="product-bank-field">
      <select class="product-settlement" data-pay-field="destinationBank" onchange="app.onDestinationBankSelect(this)">
        ${options}
      </select>
      <input type="text" class="product-settlement bank-custom-input" placeholder="نام بانک" value="${isCustom ? escapeAttr(value) : ''}" style="${isCustom ? '' : 'display:none;'}" oninput="app.markSalePaymentTouched(this)">
    </div>`
}

export function onDestinationBankSelect(selectEl) {
  const wrap = selectEl.closest('.product-bank-field')
  const customInput = wrap?.querySelector('.bank-custom-input')
  const val = selectEl.value
  if (val === '__custom__') {
    if (customInput) {
      customInput.style.display = ''
      customInput.focus()
    }
    markSalePaymentTouched(selectEl)
    return
  }
  if (customInput) {
    customInput.style.display = 'none'
    customInput.value = ''
  }
  markSalePaymentTouched(selectEl)
}

export async function removeProduct(customerId, index) {
  showToast('پس از ثبت محصول، امکان حذف وجود ندارد')
}

