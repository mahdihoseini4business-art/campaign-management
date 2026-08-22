import { getData, saveFollowupToDB, deleteFollowupFromDB, updateFollowupInDB, saveCustomerToDB } from './data.js'
import { getUsersSafe } from './auth.js'
import { toEnDigits, escapeHtml, escapeAttr, showToast, hasPermission, requirePermission, canViewCustomer, canAddNoteOnCustomer, getCurrentUser, normalizePhone, canViewScopedCustomer, canViewOrgWideData, matchesTabSearch, getCustomerSearchExtras, getTodayJalaliStr, jalaliToNum, jalaliAddDays, jalaliDiffDays, getNowJalaliDateTime, getCustomerPhones, formatPhonesDisplay, userDisplayName, getStatusLabels, getStatusClass, getPrimaryPhone, formatSoldAt24h, soldAtTimePart, jalaliDatePart, formatTeamFilterLabel, isPaymentFilled, isGiftSale, isProductPriceLocked, ensureProductPayments } from './utils.js'
import { loadGroupsData, buildGroupedAdvisorSelectHtml, phonesMatchingAdvisorFilter } from './groups.js'
import { paginateList, renderPaginationBar } from './pagination.js'
import { toggleSortField, sortRecords, syncSortHeaders, sortSig } from './table-sort.js'
import { runWithSearchOverlay, SEARCH_HOST } from './search-overlay.js'

let followupFilter = 'today' // today | waiting | overdue | done
let followupSortState = { field: null, asc: true }

function getFollowupAdvisorFilter() {
  return document.getElementById('filterFollowupAdvisor')?.value || ''
}

function matchesAdvisorScope(customer, scopePhones) {
  if (!scopePhones) return true
  const phone = normalizePhone(customer?.advisorPhone)
  return !!(phone && scopePhones.has(phone))
}

export async function updateFollowupAdvisorDropdown() {
  const select = document.getElementById('filterFollowupAdvisor')
  if (!select) return
  const currentUser = getCurrentUser()
  const isManager = !!(currentUser?.isGroupManager)
  const isOrgWide = canViewOrgWideData(currentUser)
  if (!isManager && !isOrgWide) {
    select.style.display = 'none'
    return
  }
  select.style.display = ''
  const currentVal = select.value
  const users = await getUsersSafe()
  try { await loadGroupsData() } catch (_) {}
  select.innerHTML = buildGroupedAdvisorSelectHtml({
    users,
    selectedValue: currentVal,
    teamLabel: isManager ? formatTeamFilterLabel(currentUser) : null
  })
  if (![...select.options].some(o => o.value === currentVal)) {
    select.value = ''
  } else {
    select.value = currentVal
  }
}

// ============================================
// Classification (based on customer.nextFollowupDate)
// ============================================

function normalizeJalaliDate(dateStr) {
  if (!dateStr) return ''
  return toEnDigits(String(dateStr)).trim().split(/\s+/)[0] || ''
}

function dateNum(dateStr) {
  return jalaliToNum(normalizeJalaliDate(dateStr))
}

/** today | waiting (فردا تا +۳ روز) | overdue | null */
function classifyDate(dateStr) {
  const num = dateNum(dateStr)
  if (num === 99999999) return null
  const today = getTodayJalaliStr()
  const todayN = jalaliToNum(today)
  if (num < todayN) return 'overdue'
  if (num === todayN) return 'today'
  const threeDaysNum = jalaliAddDays(today, 3)
  if (num <= threeDaysNum) return 'waiting'
  return null
}

function isDoneFollowup(f) {
  if (!f) return false
  if (f.status === 'done') return true
  const t = f.type || ''
  return t === 'پیگیری انجام‌شده' || t === 'پیگیری معوقه انجام‌شده'
}

function followupNoteText(f) {
  if (!f) return ''
  return String(f.notes || f.doneNote || '').trim()
}

/** Newest Jalali datetime first; stable tie-break on id. */
function sortFollowupsNewestFirst(list) {
  return [...list].sort((a, b) => {
    const ka = formatSoldAt24h(a.doneAt || a.date) || a.date || ''
    const kb = formatSoldAt24h(b.doneAt || b.date) || b.date || ''
    const diff = String(kb).localeCompare(String(ka))
    if (diff !== 0) return diff
    return String(b.id || '').localeCompare(String(a.id || ''), undefined, { numeric: true })
  })
}

function formatFollowupHistoryAt(f) {
  return formatSoldAt24h(f?.doneAt || f?.date) || f?.date || ''
}

/** Ensure history entries store "YYYY/MM/DD HH:MM"; keep prior time when editing date-only. */
function ensureFollowupDateTime(dateStr, previousDateStr = '') {
  const raw = toEnDigits(String(dateStr || '')).trim()
  if (!raw) return ''
  const date = jalaliDatePart(raw)
  if (!date) return raw
  const time = soldAtTimePart(raw) || soldAtTimePart(previousDateStr) || getNowJalaliDateTime().time
  return `${date} ${time}`
}

/** Latest non-empty note an expert registered for this customer. */
function getLatestCustomerNotes(customerId, followups) {
  if (!customerId) return ''
  const sorted = sortFollowupsNewestFirst(
    (followups || []).filter(f => f.customerId === customerId)
  )
  for (const f of sorted) {
    const note = followupNoteText(f)
    if (note) return note
  }
  return ''
}

function canSeeCustomer(customer, currentUser) {
  if (!customer) return false
  if (customer.id.startsWith('LD') && !hasPermission('customers_ld')) return false
  if (customer.id.startsWith('CS') && !hasPermission('customers_cs')) return false
  // Own customers + team members (group managers via viewUserPhones).
  // Admin / accounting: org-wide via canViewScopedCustomer.
  return canViewScopedCustomer(customer, currentUser)
}

function safeSearchExtras(customer) {
  try {
    return getCustomerSearchExtras(customer)
  } catch (_) {
    return { products: [], depositors: [] }
  }
}

/** Pending actionable items = customers with a nextFollowupDate */
function getPendingItems(applySearch = true) {
  const data = getData()
  const currentUser = getCurrentUser()
  const search = applySearch
    ? toEnDigits(document.getElementById('searchFollowups')?.value || '').toLowerCase()
    : ''
  const advisorFilter = applySearch ? getFollowupAdvisorFilter() : ''
  const advisorScope = phonesMatchingAdvisorFilter(advisorFilter, currentUser)

  const items = []
  for (const c of data.customers) {
    if (!c.nextFollowupDate) continue
    if (!canSeeCustomer(c, currentUser)) continue
    if (!matchesAdvisorScope(c, advisorScope)) continue
    const category = classifyDate(c.nextFollowupDate)
    if (!category) continue

    const customerFollowups = data.followups.filter(f => f.customerId === c.id)
    const last = [...customerFollowups].reverse().find(f => !isDoneFollowup(f))
    const creatorPhone = normalizePhone(last?.createdByPhone)
    const ownerPhone = normalizePhone(c.advisorPhone)
    const setByOther = !!(creatorPhone && ownerPhone && creatorPhone !== ownerPhone)
    const phones = formatPhonesDisplay(c)
    const item = {
      kind: 'pending',
      customerId: c.id,
      customerName: c.name || c.platformId || c.id,
      customerPhone: phones.text || '',
      customerPhoneExtra: phones.extra,
      advisor: c.advisor || '',
      date: last?.date || '',
      type: last?.type || '—',
      result: last?.result || '—',
      nextDate: normalizeJalaliDate(c.nextFollowupDate),
      notes: getLatestCustomerNotes(c.id, customerFollowups),
      createdByPhone: creatorPhone,
      setByOther,
      category
    }

    if (search) {
      const extras = safeSearchExtras(c)
      if (!matchesTabSearch(search, [
        item.customerId,
        item.customerName,
        ...getCustomerPhones(c),
        c.advisor,
        item.notes,
        item.type,
        item.result,
        item.date,
        item.nextDate,
        ...extras.products,
        ...extras.depositors
      ])) continue
    }
    items.push(item)
  }
  items.sort((a, b) => {
    const d = dateNum(a.nextDate) - dateNum(b.nextDate)
    if (d !== 0) return d
    return String(a.customerId || '').localeCompare(String(b.customerId || ''), 'fa')
  })
  return items
}

/** Done items = followup notes marked as completed */
function getDoneItems(applySearch = true) {
  const data = getData()
  const currentUser = getCurrentUser()
  const search = applySearch
    ? toEnDigits(document.getElementById('searchFollowups')?.value || '').toLowerCase()
    : ''
  const advisorFilter = applySearch ? getFollowupAdvisorFilter() : ''
  const advisorScope = phonesMatchingAdvisorFilter(advisorFilter, currentUser)

  const items = []
  for (const f of data.followups) {
    if (!isDoneFollowup(f)) continue
    const customer = data.customers.find(c => c.id === f.customerId)
    if (!canSeeCustomer(customer, currentUser)) continue
    if (!matchesAdvisorScope(customer, advisorScope)) continue

    if (search) {
      const name = customer ? customer.name : ''
      const extras = safeSearchExtras(customer)
      if (!matchesTabSearch(search, [
        f.customerId,
        name,
        ...getCustomerPhones(customer),
        customer?.advisor,
        f.notes,
        f.type,
        f.result,
        f.date,
        f.nextDate,
        ...extras.products,
        ...extras.depositors
      ])) continue
    }

    const phones = customer ? formatPhonesDisplay(customer) : { text: '', extra: 0 }
    items.push({
      kind: 'done',
      id: f.id,
      customerId: f.customerId,
      customerName: customer ? (customer.name || customer.platformId || customer.id) : '—',
      customerPhone: phones.text || '',
      customerPhoneExtra: phones.extra,
      advisor: customer?.advisor || '',
      date: f.date,
      type: f.type,
      result: f.result,
      nextDate: f.nextDate || '',
      notes: f.notes || f.doneNote || '',
      createdByPhone: f.createdByPhone || '',
      wasOverdue: !!f.wasOverdue || f.type === 'پیگیری معوقه انجام‌شده',
      category: 'done'
    })
  }
  return items
}

function followupSortValue(item, field) {
  if (field === 'date') return { value: item.date || item.doneAt || '', type: 'datetime' }
  if (field === 'nextDate') return { value: item.nextDate || '', type: 'date' }
  if (field === 'notes') return { value: item.notes || '', type: 'text' }
  return { value: item[field] ?? '', type: 'text' }
}

function applyFollowupSort(items) {
  if (followupSortState.field) {
    return sortRecords(items, followupSortState, followupSortValue)
  }
  if (followupFilter === 'done') {
    return sortRecords(items, { field: 'date', asc: false }, followupSortValue)
  }
  return items
}

export function sortFollowups(field) {
  toggleSortField(followupSortState, field)
  renderFollowups()
}

/** Same rows as the follow-ups table (category + search + advisor). */
export function getVisibleFollowupItems() {
  const pending = getPendingItems(true)
  const done = getDoneItems(true)
  const items = followupFilter === 'done'
    ? done
    : pending.filter(i => i.category === followupFilter)
  return applyFollowupSort(items)
}

export function getFilteredFollowups() {
  // Kept for import-export / bulk compatibility: all raw followups with scope
  const data = getData()
  const search = toEnDigits(document.getElementById('searchFollowups')?.value || '').toLowerCase()
  const currentUser = getCurrentUser()

  return data.followups.filter(f => {
    const customer = data.customers.find(c => c.id === f.customerId)
    const name = customer ? customer.name : ''
    if (customer && !canSeeCustomer(customer, currentUser)) return false
    const extras = getCustomerSearchExtras(customer)
    return matchesTabSearch(search, [
      f.customerId,
      name,
      ...getCustomerPhones(customer),
      customer?.advisor,
      f.notes,
      f.type,
      f.result,
      f.date,
      f.nextDate,
      ...extras.products,
      ...extras.depositors
    ])
  })
}

export function hasActiveFollowupExportFilter() {
  return !!(
    document.getElementById('searchFollowups')?.value?.trim()
    || getFollowupAdvisorFilter()
    || followupFilter
  )
}

/** Visible follow-up rows for CSV/Excel — matches current tab filters. */
export function getFollowupsForExport() {
  return getVisibleFollowupItems()
}

// ============================================
// Badge + Stats
// ============================================

export function updateFollowupBadge() {
  // Badges ignore search box — always show true pending counts
  const pending = getPendingItems(false)
  const todayN = jalaliToNum(getTodayJalaliStr())
  const todayCount = pending.filter(i => dateNum(i.nextDate) === todayN).length
  const overdueCount = pending.filter(i => i.category === 'overdue').length

  const tabBadge = document.getElementById('followupTabBadge')
  if (tabBadge) {
    tabBadge.textContent = todayCount
    tabBadge.style.display = todayCount > 0 ? 'inline-flex' : 'none'
  }

  const overdueBadge = document.getElementById('followupOverdueBadge')
  if (overdueBadge) {
    overdueBadge.textContent = overdueCount
    overdueBadge.style.display = overdueCount > 0 ? 'inline-flex' : 'none'
  }
}

function updateFollowupStats() {
  const pending = getPendingItems(false)
  const done = getDoneItems(false)
  const el = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v }
  el('stat-followup-today', pending.filter(i => i.category === 'today').length)
  el('stat-followup-waiting', pending.filter(i => i.category === 'waiting').length)
  el('stat-followup-overdue', pending.filter(i => i.category === 'overdue').length)
  el('stat-followup-done', done.length)
}

export function setFollowupFilter(filter) {
  followupFilter = filter
  document.querySelectorAll('.followup-filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter)
  })
  renderFollowups()
}

export function clearFollowupSearch() {
  const el = document.getElementById('searchFollowups')
  if (el) el.value = ''
  return runWithSearchOverlay(SEARCH_HOST.followups, () => renderFollowups())
}

export function onFollowupSearchInput() {
  return runWithSearchOverlay(SEARCH_HOST.followups, () => renderFollowups())
}

// ============================================
// Render
// ============================================

function buildFollowupEmptyHtml({ title, detail, actionsHtml }) {
  return `
    <div class="empty-state">
      <div class="icon">📋</div>
      <h3>${title}</h3>
      ${detail ? `<p>${detail}</p>` : ''}
      ${actionsHtml ? `<div class="empty-state-actions">${actionsHtml}</div>` : ''}
    </div>`
}

function followupDueMeta(item) {
  if (!item?.nextDate) return ''
  const today = getTodayJalaliStr()
  if (item.category === 'overdue') {
    const days = jalaliDiffDays(item.nextDate, today)
    if (days == null) return 'معوقه'
    if (days <= 0) return 'معوقه'
    return days === 1 ? '۱ روز تأخیر' : `${days} روز تأخیر`
  }
  if (item.category === 'today') return 'امروز'
  if (item.category === 'waiting') {
    const days = jalaliDiffDays(today, item.nextDate)
    if (days == null || days <= 0) return ''
    return days === 1 ? '۱ روز دیگر' : `${days} روز دیگر`
  }
  return ''
}

function followupCardBadge(item) {
  if (item.kind === 'pending' && item.category === 'overdue') {
    return '<span class="overdue-tag">معوقه</span>'
  }
  if (item.wasOverdue) return '<span class="overdue-tag">معوقه</span>'
  if (item.kind === 'pending' && item.category === 'today') {
    return '<span class="followup-card-badge is-today">امروز</span>'
  }
  return ''
}

function renderFollowupItemActions(item, { canEdit }) {
  let actionBtns = ''
  if (item.kind === 'pending') {
    actionBtns += `<button type="button" class="btn btn-sm btn-done" title="انجام شد" onclick="event.stopPropagation();app.openFollowupDoneModal('${escapeAttr(item.customerId)}')">✓ انجام شد</button>`
  } else {
    if (canEdit) {
      actionBtns += `<button type="button" class="btn-icon" title="ویرایش" onclick="event.stopPropagation();app.editFollowup('${escapeAttr(String(item.id))}')">✏</button>`
    }
    if (hasPermission('followups_delete')) {
      actionBtns += ` <button type="button" class="btn-icon" title="حذف" onclick="event.stopPropagation();app.deleteFollowup('${escapeAttr(String(item.id))}')">🗑</button>`
    }
  }
  return actionBtns
}

function renderFollowupCard(item, { canEdit, nameByPhone }) {
  const badge = followupCardBadge(item)
  const phoneHtml = renderFollowupPhoneCell(item.customerPhone, {
    extra: item.customerPhoneExtra || 0
  })
  const dueMeta = followupDueMeta(item)
  const dueLabel = item.kind === 'pending'
    ? `موعد: ${escapeHtml(item.nextDate || '—')}${dueMeta ? ` (${escapeHtml(dueMeta)})` : ''}`
    : `تاریخ: ${escapeHtml(formatFollowupHistoryAt(item) || '—')}`
  const setterName = item.setByOther ? (nameByPhone(item.createdByPhone) || item.createdByPhone) : ''
  const setterBadge = setterName
    ? `<div class="followup-card-from">از: ${escapeHtml(setterName)}</div>`
    : ''
  const notes = item.notes ? escapeHtml(item.notes) : '—'
  const metaDone = item.kind === 'done'
    ? `<div class="followup-card-meta">${escapeHtml(item.type || '—')} · ${escapeHtml(item.result || '—')}</div>`
    : ''
  const catClass = item.category ? ` is-${item.category}` : ''
  const actionBtns = renderFollowupItemActions(item, { canEdit })

  return `<article class="followup-card${catClass}" onclick="app.onCustomerRowClick(event, '${escapeAttr(item.customerId)}')">
    <div class="followup-card-header">
      <div class="followup-card-name">${escapeHtml(item.customerName)}</div>
      ${badge}
    </div>
    <div class="followup-card-phone">${phoneHtml}</div>
    <div class="followup-card-due">${dueLabel}</div>
    ${metaDone}
    <div class="followup-card-notes">${notes}</div>
    ${setterBadge}
    <div class="followup-card-actions actions-cell">${actionBtns}</div>
  </article>`
}

export async function renderFollowups() {
  const tbody = document.getElementById('followupBody')
  const cards = document.getElementById('followupCards')
  if (!tbody) return

  try {
    updateFollowupAdvisorDropdown()
    updateFollowupStats()
    updateFollowupBadge()

    const filtered = getVisibleFollowupItems()

    const showSelectCol = hasPermission('followups_delete') && followupFilter === 'done'
    const colCount = (hasPermission('followups_delete') ? 1 : 0) + 9

    if (filtered.length === 0) {
      const searchRaw = (document.getElementById('searchFollowups')?.value || '').trim()
      const hasSearch = !!toEnDigits(searchRaw).toLowerCase()
      const overdueCount = hasSearch
        ? 0
        : getPendingItems(false).filter(i => i.category === 'overdue').length
      const distantHint = 'پیگیری‌های بعد از ۳ روز اینجا نیست؛ از پنل مشتری ببینید.'

      let title = 'پیگیری‌ای یافت نشد'
      let detail = ''
      let actionsHtml = ''

      if (hasSearch) {
        title = 'نتیجه‌ای یافت نشد'
        detail = `نتیجه‌ای برای «${escapeHtml(searchRaw)}» پیدا نشد`
        actionsHtml = `<button type="button" class="btn btn-sm" onclick="app.clearFollowupSearch()">پاک کردن سرچ</button>`
      } else if (followupFilter === 'today') {
        title = 'پیگیری برای امروز ندارید ✓'
        detail = distantHint
        if (overdueCount > 0) {
          actionsHtml = `<button type="button" class="btn btn-sm" onclick="app.setFollowupFilter('overdue')">مشاهده معوقه‌ها (${overdueCount})</button>`
        }
      } else if (followupFilter === 'overdue') {
        title = 'معوقه‌ای نیست'
        detail = distantHint
      } else if (followupFilter === 'waiting') {
        title = 'در ۲–۳ روز آینده موردی نیست'
        detail = distantHint
      } else if (followupFilter === 'done') {
        title = 'هنوز مورد تکمیل‌شده‌ای ثبت نشده'
        detail = ''
      }

      const emptyHtml = buildFollowupEmptyHtml({ title, detail, actionsHtml })
      tbody.innerHTML = `<tr><td colspan="${colCount}">${emptyHtml}</td></tr>`
      if (cards) cards.innerHTML = emptyHtml
      renderPaginationBar('followupPagination', 'followups', { total: 0, from: 0, to: 0, page: 1, totalPages: 1 })
      syncSortHeaders('#sheet-followups', followupSortState)
      return
    }

    const search = toEnDigits(document.getElementById('searchFollowups')?.value || '').toLowerCase()
    const page = paginateList('followups', filtered, `${followupFilter}|${search}|${sortSig(followupSortState)}`)
    const canEdit = hasPermission('followups_add')
    const users = await getUsersSafe()
    const nameByPhone = (phone) => {
      const p = normalizePhone(phone)
      if (!p) return ''
      const u = users.find(x => normalizePhone(x.phone) === p)
      return u ? userDisplayName(u) : ''
    }

    tbody.innerHTML = page.items.map((item) => {
      const selectCell = hasPermission('followups_delete')
        ? (showSelectCol
          ? `<td><input type="checkbox" data-id="${escapeAttr(String(item.id || ''))}" onchange="app.toggleRowSelect('followups', '${escapeAttr(String(item.id || ''))}', this.checked)"></td>`
          : '<td></td>')
        : ''

      const actionBtns = renderFollowupItemActions(item, { canEdit })
      const overdueBadge = item.wasOverdue ? ' <span class="overdue-tag">معوقه</span>' : ''
      const phoneHtml = renderFollowupPhoneCell(item.customerPhone, {
        extra: item.customerPhoneExtra || 0
      })

      const setterName = item.setByOther ? (nameByPhone(item.createdByPhone) || item.createdByPhone) : ''
      const setterBadge = setterName
        ? ` <span style="display:inline-block;margin-top:2px;font-size:11px;color:var(--text-muted);">از: ${escapeHtml(setterName)}</span>`
        : ''
      const notesHtml = item.notes
        ? `${escapeHtml(item.notes)}${setterBadge}`
        : (setterBadge || '—')

      return `<tr class="clickable-row" onclick="app.onCustomerRowClick(event, '${escapeAttr(item.customerId)}')">
        ${selectCell}
        <td class="followup-name-cell">${escapeHtml(item.customerName)}${overdueBadge}</td>
        <td class="followup-phone-td">${phoneHtml}</td>
        <td style="font-size:12px;">${escapeHtml(item.advisor) || '—'}</td>
        <td style="font-family:'Vazirmatn',sans-serif;font-size:13px;direction:ltr;text-align:right;">${escapeHtml(formatFollowupHistoryAt(item)) || '—'}</td>
        <td>${escapeHtml(item.type)}</td>
        <td>${escapeHtml(item.result)}</td>
        <td style="font-size:13px;">${escapeHtml(item.nextDate) || '—'}</td>
        <td class="notes-cell" title="${escapeHtml(item.notes)}">${notesHtml}</td>
        <td><div class="actions-cell">${actionBtns}</div></td>
      </tr>`
    }).join('')

    if (cards) {
      cards.innerHTML = page.items.map(item =>
        renderFollowupCard(item, { canEdit, nameByPhone })
      ).join('')
    }

    renderPaginationBar('followupPagination', 'followups', page)
    syncSortHeaders('#sheet-followups', followupSortState)
  } catch (e) {
    console.error('renderFollowups error:', e)
    const errHtml = `<div class="empty-state"><h3>خطا در نمایش فالوآپ‌ها</h3><p>${escapeHtml(e.message || String(e))}</p></div>`
    tbody.innerHTML = `<tr><td colspan="10">${errHtml}</td></tr>`
    if (cards) cards.innerHTML = errHtml
  }
}

// ============================================
// Done Modal (customerId-based)
// ============================================

function jalaliNumToDateStr(n) {
  if (!n || n === 99999999) return ''
  const y = Math.floor(n / 10000)
  const m = Math.floor((n % 10000) / 100)
  const d = n % 100
  return `${y}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`
}

function telHrefFromPhone(phone) {
  const digits = toEnDigits(String(phone || '')).replace(/\D/g, '')
  if (!digits) return ''
  if (/^09\d{9}$/.test(digits)) return `tel:+98${digits.slice(1)}`
  return `tel:${digits}`
}

/** Phone + copy + tel link; stops row click from opening the customer panel. */
function renderFollowupPhoneCell(phone, { extra = 0 } = {}) {
  const primary = String(phone || '').trim()
  if (!primary) return '—'
  const tel = telHrefFromPhone(primary)
  const extraHtml = extra > 0
    ? ` <span class="followup-phone-extra">+${extra}</span>`
    : ''
  const numberHtml = tel
    ? `<a class="followup-phone-tel" href="${escapeAttr(tel)}" title="تماس" dir="ltr">${escapeHtml(primary)}</a>`
    : `<span class="followup-phone-text" dir="ltr">${escapeHtml(primary)}</span>`
  return `<span class="followup-phone-cell" onclick="event.stopPropagation()">
    ${numberHtml}${extraHtml}
    <button type="button" class="btn-copy" title="کپی شماره" aria-label="کپی شماره"
      data-copy="${escapeAttr(primary)}"
      onclick="event.stopPropagation(); app.copyToClipboard(this.getAttribute('data-copy') || '')">⧉</button>
  </span>`
}

function renderFollowupDonePhoneActions(customer) {
  const primary = getPrimaryPhone(customer)
  if (!primary) return '—'
  const tel = telHrefFromPhone(primary)
  const telBtn = tel
    ? `<a class="btn btn-sm" href="${escapeAttr(tel)}" onclick="event.stopPropagation()">تماس</a>`
    : ''
  return `<span class="followup-done-phone">
    <span dir="ltr" style="font-family:'Vazirmatn',sans-serif;">${escapeHtml(primary)}</span>
    <button type="button" class="btn-copy" title="کپی شماره" aria-label="کپی شماره"
      data-copy="${escapeAttr(primary)}"
      onclick="event.stopPropagation(); app.copyToClipboard(this.getAttribute('data-copy') || '')">⧉</button>
    ${telBtn}
  </span>`
}

/** True when done-modal note has unsaved typed content (guards accidental overlay close). */
export function isFollowupDoneNoteDirty() {
  const modal = document.getElementById('followupDoneModal')
  if (!modal?.classList.contains('active')) return false
  const note = document.getElementById('followupDoneNote')?.value || ''
  return note.trim().length > 0
}

export function openFollowupDoneModal(customerId) {
  if (!requirePermission('followups_add')) return
  const data = getData()
  const customer = data.customers.find(c => c.id === customerId)
  if (!customer) { showToast('مشتری یافت نشد'); return }

  const cat = classifyDate(customer.nextFollowupDate)
  const name = customer.name || customer.platformId || customerId
  const statusKey = customer.status || ''
  const statusLabel = getStatusLabels()[statusKey] || statusKey || '—'
  const statusClass = getStatusClass(statusKey)
  const lastNotes = getLatestCustomerNotes(customerId, data.followups)

  document.getElementById('followupDoneId').value = customerId
  document.getElementById('followupDoneNote').value = ''
  const nextDateEl = document.getElementById('followupDoneNextDate')
  if (nextDateEl) nextDateEl.value = ''

  document.getElementById('followupDoneInfo').innerHTML = `
    <div>
      <strong>مشتری:</strong> ${escapeHtml(name)}
      <span style="color:var(--text-muted);">(${escapeHtml(customerId)})</span>
      <span class="status-badge ${escapeAttr(statusClass)}">${escapeHtml(statusLabel)}</span>
    </div>
    <div><strong>شماره:</strong> ${renderFollowupDonePhoneActions(customer)}</div>
    <div><strong>تاریخ پیگیری:</strong> ${escapeHtml(customer.nextFollowupDate || '—')}</div>
    ${cat === 'overdue' ? '<div style="color:var(--danger);font-weight:600;">⚠ این پیگیری معوقه است</div>' : ''}
  `

  const prevEl = document.getElementById('followupDonePrevNote')
  if (prevEl) {
    if (lastNotes) {
      prevEl.hidden = false
      prevEl.innerHTML = `
        <div class="followup-done-prev-label">آخرین توضیح قبلی</div>
        <div class="followup-done-prev-text">${escapeHtml(lastNotes)}</div>
      `
    } else {
      prevEl.hidden = true
      prevEl.innerHTML = ''
    }
  }

  const nextLabel = document.querySelector('label[for="followupDoneNextDate"]')
  if (nextLabel) {
    // For "done" we should never force scheduling a next follow-up forever.
    // User can mark completion and optionally schedule the next date.
    nextLabel.innerHTML = 'پیگیری بعدی <span class="settings-optional">(اختیاری)</span>'
  }

  document.getElementById('followupDoneModal').classList.add('active')
  document.getElementById('followupDoneNote').focus()
}

export function setFollowupDoneNextShortcut(days) {
  const n = Number(days)
  if (!Number.isFinite(n) || n < 1) return
  const nextDateEl = document.getElementById('followupDoneNextDate')
  if (!nextDateEl) return
  nextDateEl.value = jalaliNumToDateStr(jalaliAddDays(getTodayJalaliStr(), n))
  nextDateEl.focus()
}

export function closeFollowupDoneModal() {
  document.getElementById('followupDoneModal').classList.remove('active')
}

/** @type {{ id: string, label: string, search: string }[]} */
let followupDonePickOptions = []

const DONE_PICK_CAT_LABEL = {
  overdue: 'معوقه',
  today: 'امروز',
  waiting: 'نزدیک'
}

function renderFollowupDonePickOptions(query) {
  const select = document.getElementById('followupDonePickCustomer')
  if (!select) return
  const q = toEnDigits(query || '').toLowerCase().trim()
  const list = q
    ? followupDonePickOptions.filter(o => o.search.includes(q))
    : followupDonePickOptions
  if (!list.length) {
    select.innerHTML = '<option value="">مشتری‌ای در صف یافت نشد</option>'
    return
  }
  select.innerHTML = list.map(o =>
    `<option value="${escapeAttr(o.id)}">${escapeHtml(o.label)}</option>`
  ).join('')
  if (list.length === 1) select.value = list[0].id
}

/** Toolbar CTA: pick a queued customer, then open the done modal. */
export function openFollowupDonePicker() {
  if (!requirePermission('followups_add')) return
  const pending = getPendingItems(false)
  const catOrder = { overdue: 0, today: 1, waiting: 2 }
  followupDonePickOptions = pending
    .slice()
    .sort((a, b) => {
      const c = (catOrder[a.category] ?? 9) - (catOrder[b.category] ?? 9)
      if (c !== 0) return c
      return dateNum(a.nextDate) - dateNum(b.nextDate)
    })
    .map(item => {
      const catLabel = DONE_PICK_CAT_LABEL[item.category] || ''
      const label = `${catLabel} · ${item.nextDate || '—'} — ${item.customerId} — ${item.customerName}`
      return {
        id: item.customerId,
        label,
        search: toEnDigits(`${item.customerId} ${item.customerName} ${item.customerPhone} ${item.nextDate} ${catLabel}`).toLowerCase()
      }
    })

  if (!followupDonePickOptions.length) {
    showToast('مشتری‌ای در صف پیگیری نیست')
    return
  }

  const search = document.getElementById('followupDonePickSearch')
  if (search) search.value = ''
  renderFollowupDonePickOptions('')
  document.getElementById('followupDonePickModal')?.classList.add('active')
  search?.focus()
}

export function filterFollowupDonePick(query) {
  renderFollowupDonePickOptions(query)
}

export function closeFollowupDonePicker() {
  document.getElementById('followupDonePickModal')?.classList.remove('active')
}

export function confirmFollowupDonePick() {
  const customerId = document.getElementById('followupDonePickCustomer')?.value
  if (!customerId) {
    showToast('مشتری را انتخاب کنید')
    return
  }
  closeFollowupDonePicker()
  openFollowupDoneModal(customerId)
}

export async function confirmFollowupDone() {
  if (!requirePermission('followups_add')) return
  const data = getData()
  const customerId = document.getElementById('followupDoneId').value
  const note = document.getElementById('followupDoneNote').value.trim()
  const nextDate = toEnDigits(
    document.getElementById('followupDoneNextDate')?.value || ''
  ).trim()

  if (!note) { showToast('یادداشت را وارد کنید'); return }
  // Do not require "next follow-up date" here.
  // Clearing `nextFollowupDate` is the correct way to stop further follow-ups.
  if (nextDate && !/^\d{4}\/\d{2}\/\d{2}$/.test(nextDate)) {
    showToast('فرمت تاریخ پیگیری بعدی صحیح نیست (1405/05/01)')
    return
  }

  const idx = data.customers.findIndex(c => c.id === customerId)
  if (idx === -1) { showToast('مشتری یافت نشد'); return }
  const customer = data.customers[idx]

  const cat = classifyDate(customer.nextFollowupDate)
  const wasOverdue = cat === 'overdue'
  const { dateTime } = getNowJalaliDateTime()
  const doneByPhone = normalizePhone(getCurrentUser()?.phone || '')
  const noteType = wasOverdue ? 'پیگیری معوقه انجام‌شده' : 'پیگیری انجام‌شده'

  try {
    const noteFollowup = {
      customerId,
      date: dateTime,
      type: noteType,
      result: 'انجام شد',
      nextDate: nextDate || '',
      notes: note,
      createdByPhone: doneByPhone,
      status: 'done',
      doneAt: dateTime,
      doneByPhone,
      doneNote: note,
      wasOverdue
    }
    const noteId = await saveFollowupToDB(noteFollowup)
    noteFollowup.id = noteId
    data.followups.push(noteFollowup)

    // Set optional next follow-up, otherwise clear the schedule
    data.customers[idx].nextFollowupDate = nextDate || ''
    await saveCustomerToDB(data.customers[idx])

    closeFollowupDoneModal()
    renderFollowups()
    const remainingToday = getPendingItems(false).filter(i => i.category === 'today').length
    const base = nextDate
      ? 'ثبت شد و پیگیری بعدی تنظیم شد'
      : 'ثبت شد'
    showToast(`${base} — ${remainingToday} پیگیری امروز مانده`)
  } catch (e) {
    console.error('confirmFollowupDone error:', e)
    showToast(e.message || 'خطا در ثبت انجام پیگیری')
    try { renderFollowups() } catch (_) {}
  }
}

// ============================================
// Followup Modal (Add/Edit) — history records
// ============================================

export function openFollowupModal(editFollowupId) {
  if (!requirePermission('followups_add')) return
  const data = getData()
  const modal = document.getElementById('followupModal')
  const title = document.getElementById('followupModalTitle')
  const select = document.getElementById('followupCustomer')
  const guide = document.getElementById('followupModalGuide')
  const saveBtn = document.getElementById('followupModalSaveBtn')

  select.innerHTML = '<option value="">انتخاب کنید...</option>' +
    data.customers.filter(c => canAddNoteOnCustomer(c)).map(c =>
      `<option value="${c.id}">${c.id} — ${escapeHtml(c.name || c.platformId)}</option>`
    ).join('')

  if (editFollowupId) {
    const f = data.followups.find(x => String(x.id) === String(editFollowupId) || `idx_${data.followups.indexOf(x)}` === editFollowupId)
    if (!f) return
    title.textContent = 'ویرایش یادداشت'
    document.getElementById('editFollowupIndex').value = editFollowupId
    select.value = f.customerId
    document.getElementById('followupDate').value = formatFollowupHistoryAt(f) || f.date
    document.getElementById('followupNextDate').value = f.nextDate
    document.getElementById('followupType').value = f.type
    document.getElementById('followupResult').value = f.result
    document.getElementById('followupNotes').value = f.notes
    if (guide) guide.hidden = true
    if (saveBtn) saveBtn.textContent = 'ذخیره تغییرات'
  } else {
    title.textContent = 'ثبت یادداشت'
    document.getElementById('editFollowupIndex').value = ''
    select.value = ''
    document.getElementById('followupDate').value = getNowJalaliDateTime().dateTime
    document.getElementById('followupNextDate').value = ''
    document.getElementById('followupType').value = 'دایرکت'
    document.getElementById('followupResult').value = 'پاسخ داد'
    document.getElementById('followupNotes').value = ''
    if (guide) guide.hidden = false
    if (saveBtn) saveBtn.textContent = 'ثبت یادداشت'
  }

  modal.classList.add('active')
  select.focus()
}

export function closeFollowupModal() {
  document.getElementById('followupModal').classList.remove('active')
}

export async function saveFollowup() {
  if (!requirePermission('followups_add')) return
  const data = getData()
  const editFollowupId = document.getElementById('editFollowupIndex').value
  const customerId = document.getElementById('followupCustomer').value
  const nextDate = document.getElementById('followupNextDate').value.trim()
  const type = document.getElementById('followupType').value
  const result = document.getElementById('followupResult').value
  const notes = document.getElementById('followupNotes').value.trim()
  let date = toEnDigits(document.getElementById('followupDate').value.trim())

  if (!customerId) { showToast('مشتری را انتخاب کنید'); return }
  if (!date) { showToast('تاریخ تماس را وارد کنید'); return }

  const customer = data.customers.find(c => c.id === customerId)
  if (!customer || !canViewCustomer(customer)) {
    showToast('شما به این مشتری دسترسی ندارید')
    return
  }
  if (!canAddNoteOnCustomer(customer)) {
    showToast('شما دسترسی ثبت یادداشت برای این مشتری را ندارید')
    return
  }

  if (editFollowupId) {
    const existing = data.followups.find(x => String(x.id) === String(editFollowupId) || `idx_${data.followups.indexOf(x)}` === editFollowupId)
    if (!existing) { showToast('پیگیری یافت نشد'); return }
    date = ensureFollowupDateTime(date, existing.doneAt || existing.date)
    const updated = { ...existing, customerId, date, nextDate, type, result, notes }
    try {
      await updateFollowupInDB(updated)
      const idx = data.followups.indexOf(existing)
      if (idx !== -1) data.followups[idx] = updated
    } catch (e) {
      console.error('saveFollowup error:', e)
      showToast('خطا در ذخیره پیگیری')
      return
    }
  } else {
    date = ensureFollowupDateTime(date)
    const newFollowup = { customerId, date, nextDate, type, result, notes, createdByPhone: normalizePhone(getCurrentUser()?.phone || ''), status: 'pending' }
    try {
      const id = await saveFollowupToDB(newFollowup)
      newFollowup.id = id
      data.followups.push(newFollowup)
    } catch (e) {
      console.error('saveFollowup error:', e)
      showToast(e.message || 'خطا در ذخیره پیگیری')
      return
    }
  }

  if (nextDate) {
    customer.nextFollowupDate = nextDate
    try { await saveCustomerToDB(customer) } catch (_) {}
  }

  renderFollowups()
  closeFollowupModal()
  await refreshOpenCustomerDetail(customerId)
  showToast(editFollowupId ? 'یادداشت ویرایش شد' : 'یادداشت ثبت شد')
}

export function editFollowup(followupId) {
  if (!requirePermission('followups_add')) return
  openFollowupModal(followupId)
}

export async function deleteFollowup(followupId) {
  if (!requirePermission('followups_delete')) return
  const data = getData()
  const f = data.followups.find(x => String(x.id) === String(followupId) || `idx_${data.followups.indexOf(x)}` === followupId)
  if (!f) { showToast('پیگیری یافت نشد'); return }

  document.getElementById('deleteMessage').textContent =
    `آیا از حذف پیگیری ${f.customerId} در تاریخ ${f.date} مطمئن هستید؟`
  document.getElementById('deleteConfirmBtn').onclick = async function () {
    try {
      if (f.id) {
        await deleteFollowupFromDB(f.id)
      } else {
        showToast('خطا: پیگیری شناسه دیتابیس ندارد')
        return
      }
      const idx = data.followups.indexOf(f)
      if (idx !== -1) data.followups.splice(idx, 1)
      renderFollowups()
      closeDeleteModal()
      await refreshOpenCustomerDetail(f.customerId)
      showToast('پیگیری حذف شد')
    } catch (e) {
      console.error('deleteFollowup error:', e)
      showToast('خطا در حذف پیگیری')
    }
  }
  document.getElementById('deleteModal').classList.add('active')
}

function closeDeleteModal() {
  document.getElementById('deleteModal').classList.remove('active')
}

/** If پنل مشتری is open for this customer, re-render it after followup changes. */
async function refreshOpenCustomerDetail(customerId) {
  if (!customerId) return
  const modal = document.getElementById('detailModal')
  if (!modal?.classList.contains('active')) return
  const { openCustomerDetail } = await import('./customers.js')
  await openCustomerDetail(customerId)
}
