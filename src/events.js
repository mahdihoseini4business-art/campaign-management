import {
  getData,
  getEventMessageTypes,
  getEventRosters,
  getEventRosterById,
  upsertEventRoster,
  archiveEventRoster,
  unarchiveEventRoster,
  deleteEventRoster,
  addAttendeeToEventRoster,
  listEventRosterDates,
  listEventRostersForDate,
  ensureEventNewStatus,
  EVENT_NEW_STATUS,
  generateId,
  saveCustomerToDB,
  putCustomerInCache
} from './data.js'
import {
  toEnDigits,
  formatNumber,
  escapeHtml,
  escapeAttr,
  hasPermission,
  matchesTabSearch,
  getCustomerPhones,
  normalizePhone,
  showToast,
  getCurrentUser,
  getStatusLabels
} from './utils.js'
import { paginateList, renderPaginationBar, getPage, setPage } from './pagination.js'
import { toggleSortField, sortRecords, syncSortHeaders } from './table-sort.js'
import { runWithSearchOverlay, SEARCH_HOST } from './search-overlay.js'
import { debouncedSearchInput } from './search-debounce.js'
import { shouldSkipTabRender, markTabRendered, tabPageKey } from './tab-cache.js'
import { canUseSmsKind, buildRecipientFromCustomer } from './sms-business.js'
import { openSmsComposeModal } from './sms-ui.js'
import { openAppConfirm } from './app-confirm.js'

let eventsSortState = { field: 'name', asc: true }
/** @type {string} selected roster id */
let selectedRosterId = ''
/** @type {string} selected date filter */
let selectedEventDate = ''
/** @type {'active'|'archived'|'all'} */
let eventsArchiveFilter = 'active'
/** @type {null | object} */
let pendingEventMessageRow = null
/** @type {null | object[]} */
let pendingEventBulkRows = null

// ============================================
// Selection helpers
// ============================================

export function getSelectedEventRoster() {
  if (selectedRosterId) {
    const r = getEventRosterById(selectedRosterId)
    if (r) return r
  }
  return null
}

function syncRosterSelectionUi() {
  const dateSel = document.getElementById('eventsDateSelect')
  const rosterSel = document.getElementById('eventsRosterSelect')
  const archiveSel = document.getElementById('eventsArchiveFilter')
  const meta = document.getElementById('eventsRosterMeta')
  const includeArchived = eventsArchiveFilter !== 'active'

  if (archiveSel && archiveSel.value !== eventsArchiveFilter) {
    archiveSel.value = eventsArchiveFilter
  }

  const dates = listEventRosterDates({ includeArchived })
  if (dateSel) {
    if (!selectedEventDate || !dates.includes(selectedEventDate)) {
      selectedEventDate = dates[0] || ''
    }
    dateSel.innerHTML = dates.length
      ? dates.map(d => `<option value="${escapeAttr(d)}"${d === selectedEventDate ? ' selected' : ''}>${escapeHtml(d)}</option>`).join('')
      : '<option value="">تاریخی نیست</option>'
  }

  const rosters = selectedEventDate
    ? listEventRostersForDate(selectedEventDate, { includeArchived }).filter(r => {
      if (eventsArchiveFilter === 'active') return r.status === 'active'
      if (eventsArchiveFilter === 'archived') return r.status === 'archived'
      return true
    })
    : []

  if (rosterSel) {
    if (!rosters.some(r => r.id === selectedRosterId)) {
      selectedRosterId = rosters[0]?.id || ''
    }
    if (!rosters.length) {
      rosterSel.innerHTML = '<option value="">رویدادی نیست</option>'
      rosterSel.disabled = true
    } else if (rosters.length === 1) {
      rosterSel.innerHTML = `<option value="${escapeAttr(rosters[0].id)}" selected>${escapeHtml(rosters[0].name)}${rosters[0].status === 'archived' ? ' (بایگانی)' : ''}</option>`
      rosterSel.disabled = false
      selectedRosterId = rosters[0].id
    } else {
      rosterSel.disabled = false
      rosterSel.innerHTML = rosters.map(r =>
        `<option value="${escapeAttr(r.id)}"${r.id === selectedRosterId ? ' selected' : ''}>${escapeHtml(r.name)}${r.status === 'archived' ? ' (بایگانی)' : ''}</option>`
      ).join('')
    }
  }

  const roster = getSelectedEventRoster()
  if (meta) {
    if (!roster) {
      meta.textContent = 'رویدادی انتخاب نشده — اکسل ایمپورت کنید یا رویداد بسازید'
    } else {
      const n = roster.attendees?.length || 0
      const neu = (roster.attendees || []).filter(a => a.isNewCustomer).length
      meta.textContent = `${roster.name} · ${roster.eventDate} · ${formatNumber(n)} نفر`
        + (neu ? ` · ${formatNumber(neu)} جدید` : '')
        + (roster.status === 'archived' ? ' · بایگانی‌شده' : '')
    }
  }

  const archiveBtn = document.getElementById('eventsArchiveBtn')
  const unarchiveBtn = document.getElementById('eventsUnarchiveBtn')
  if (archiveBtn) archiveBtn.hidden = !roster || roster.status === 'archived'
  if (unarchiveBtn) unarchiveBtn.hidden = !roster || roster.status !== 'archived'
}

export function onEventsDateSelectChange() {
  selectedEventDate = document.getElementById('eventsDateSelect')?.value || ''
  selectedRosterId = ''
  setPage(tabPageKey('events'), 1)
  renderEvents()
}

export function onEventsRosterSelectChange() {
  selectedRosterId = document.getElementById('eventsRosterSelect')?.value || ''
  setPage(tabPageKey('events'), 1)
  renderEvents()
}

export function onEventsArchiveFilterChange() {
  eventsArchiveFilter = document.getElementById('eventsArchiveFilter')?.value || 'active'
  selectedRosterId = ''
  setPage(tabPageKey('events'), 1)
  renderEvents()
}

// ============================================
// Rows from selected roster
// ============================================

export function collectSelectedRosterRows() {
  const roster = getSelectedEventRoster()
  if (!roster) return []
  return (roster.attendees || []).map(a => ({
    rowKey: `${roster.id}::${a.id}`,
    rosterId: roster.id,
    attendeeId: a.id,
    customerId: a.customerId || '',
    name: a.name || '',
    nameEn: a.nameEn || '',
    phone: a.phone || '',
    isNewCustomer: a.isNewCustomer === true,
    source: a.source || 'import',
    courseName: roster.productName || roster.name,
    sessionDate: roster.eventDate,
    sessionLabel: `${roster.name} — ${roster.eventDate}`,
    productName: roster.productName || roster.name,
    advisor: '',
    eventName: roster.name,
    eventDate: roster.eventDate
  }))
}

/** @deprecated compat for export — filtered rows of selected roster */
export function collectEventAttendeeRows() {
  return collectSelectedRosterRows()
}

function eventSortValue(row, field) {
  if (field === 'name') return { value: row.name || '', type: 'string' }
  if (field === 'nameEn') return { value: row.nameEn || '', type: 'string' }
  if (field === 'phone') return { value: row.phone || '', type: 'string' }
  if (field === 'isNewCustomer') return { value: row.isNewCustomer ? 1 : 0, type: 'number' }
  if (field === 'source') return { value: row.source || '', type: 'string' }
  return { value: row.name || '', type: 'string' }
}

export function getFilteredEventRows() {
  const search = toEnDigits(document.getElementById('searchEvents')?.value || '').trim()
  let rows = collectSelectedRosterRows()
  if (search) {
    rows = rows.filter(r => matchesTabSearch(search, [
      r.name, r.nameEn, r.phone, r.courseName, r.eventName, r.source
    ]))
  }
  return sortRecords(rows, eventsSortState, eventSortValue)
}

function eventsFilterSig() {
  const search = toEnDigits(document.getElementById('searchEvents')?.value || '').trim()
  return `${selectedEventDate}::${selectedRosterId}::${eventsArchiveFilter}::${search}::${eventsSortState.field}:${eventsSortState.asc ? 1 : 0}`
}

export function renderEvents() {
  if (!hasPermission('events_view')) return
  void ensureEventNewStatus().catch(() => {})

  syncRosterSelectionUi()

  const body = document.getElementById('eventsBody')
  if (!body) return

  const filterSig = eventsFilterSig()
  const pageKey = tabPageKey('events')
  const page = getPage(pageKey)

  if (shouldSkipTabRender('events', { filterSig, page })) return

  runWithSearchOverlay(SEARCH_HOST.events, () => {
    const all = getFilteredEventRows()
    const { items, totalPages, page: safePage } = paginateList(all, pageKey)
    if (safePage !== page) setPage(pageKey, safePage)

    syncSortHeaders('#sheet-events', eventsSortState)

    const countEl = document.getElementById('eventsResultCount')
    if (countEl) {
      countEl.textContent = all.length
        ? `${formatNumber(all.length)} شرکت‌کننده`
        : (getSelectedEventRoster() ? 'شرکت‌کننده‌ای نیست' : 'رویدادی انتخاب نشده')
    }

    const statusLabels = getStatusLabels()
    const newLabel = statusLabels[EVENT_NEW_STATUS.key] || EVENT_NEW_STATUS.label

    if (!getSelectedEventRoster()) {
      body.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);">برای شروع، اکسل رویداد را ایمپورت کنید یا رویداد جدید بسازید.</td></tr>`
    } else if (!all.length) {
      body.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);">ردیفی نیست — نفر جدید اضافه کنید یا اکسل ایمپورت کنید.</td></tr>`
    } else {
      const canSms = canUseSmsKind('event_single')
      body.innerHTML = items.map(r => {
        const badge = r.isNewCustomer
          ? `<span class="status-badge status-${escapeAttr(EVENT_NEW_STATUS.key)}" title="ثبت‌شده از ایمپورت رویداد">${escapeHtml(newLabel)}</span>`
          : (r.source === 'manual'
            ? `<span class="event-source-badge">دستی</span>`
            : '')
        const smsBtn = canSms
          ? `<button type="button" class="btn btn-sm btn-primary" data-perm="sms_events" onclick="event.stopPropagation();app.openEventSendMessage('${escapeAttr(r.rowKey)}')">ارسال پیام</button>`
          : `<button type="button" class="btn btn-sm" disabled title="دسترسی پیامک رویداد فعال نیست">ارسال پیام</button>`
        const click = r.customerId
          ? `class="clickable-row" onclick="app.onCustomerRowClick(event, '${escapeAttr(r.customerId)}')"`
          : ''
        return `<tr ${click}>
          <td>${escapeHtml(r.name || '—')} ${badge}</td>
          <td style="direction:ltr;text-align:left;font-family:'Vazirmatn',sans-serif;">${escapeHtml(r.nameEn || '—')}</td>
          <td style="direction:ltr;text-align:right;font-family:'Vazirmatn',sans-serif;">${escapeHtml(r.phone || '—')}</td>
          <td>${escapeHtml(r.courseName || '—')}</td>
          <td style="font-family:'Vazirmatn',sans-serif;direction:ltr;">${escapeHtml(r.sessionDate || '—')}</td>
          <td onclick="event.stopPropagation()" style="white-space:nowrap;">${smsBtn}</td>
        </tr>`
      }).join('')
    }

    renderPaginationBar('eventsPagination', pageKey, all.length, () => renderEvents())
    markTabRendered('events', { filterSig, page: safePage })
  })
}

export function onEventsSearchInput() {
  debouncedSearchInput('events', () => {
    setPage(tabPageKey('events'), 1)
    renderEvents()
  }, SEARCH_HOST.events)
}

export function sortEventsHeader(field) {
  toggleSortField(eventsSortState, field)
  setPage(tabPageKey('events'), 1)
  renderEvents()
}

export function clearEventsFilters() {
  const search = document.getElementById('searchEvents')
  if (search) search.value = ''
  setPage(tabPageKey('events'), 1)
  renderEvents()
}

// Compat stubs for removed product filter UI
export function toggleEventsProductDropdown() {}
export function toggleEventsProductFilter() {}
export function clearEventsProductFilter() {}
export function onEventsProductFilterSearch() {}

// ============================================
// Create customer from roster row
// ============================================

function findCustomerByPhoneLocal(phone) {
  const n = normalizePhone(phone)
  if (!n) return null
  for (const c of getData().customers || []) {
    for (const p of getCustomerPhones(c)) {
      if (normalizePhone(p) === n) return c
    }
  }
  return null
}

/**
 * Create CRM customer for an unknown phone (event import).
 * Sets orange «جدید از رویداد» status.
 */
export async function createCustomerFromEventAttendee({ name, nameEn, phone }) {
  await ensureEventNewStatus()
  const normalized = normalizePhone(phone)
  if (!normalized || !/^09\d{9}$/.test(normalized)) {
    throw new Error(`شماره نامعتبر: ${phone || '—'}`)
  }
  const existing = findCustomerByPhoneLocal(normalized)
  if (existing) return { customer: existing, created: false }

  const user = getCurrentUser()
  const id = await generateId('CS')
  const newCustomer = {
    id,
    platformId: '',
    platform: 'other',
    name: String(name || '').trim() || normalized,
    nameEn: String(nameEn || '').trim(),
    nationalId: '',
    birthDate: '',
    phone: normalized,
    phones: [normalized],
    addresses: [],
    status: EVENT_NEW_STATUS.key,
    notes: 'ثبت خودکار از ایمپورت رویداد',
    advisor: user?.display_name || user?.username || '',
    advisorPhone: normalizePhone(user?.phone || '') || '',
    nextFollowupDate: '',
    products: [],
    createdAt: new Date().toISOString(),
    customerLevel: '',
    customerLevelLocked: false,
    referredByPhone: '',
    customerCode: ''
  }
  await saveCustomerToDB(newCustomer)
  putCustomerInCache(newCustomer)
  return { customer: newCustomer, created: true }
}

// ============================================
// Import Excel → full roster display
// ============================================

/**
 * Build or merge an event roster from parsed Excel rows.
 * Shows ALL excel data; auto-creates missing CRM customers.
 * @returns {{ roster, createdCustomers, updatedCustomers, skipped, errors }}
 */
export async function importEventRosterFromRows(rows, { eventName, eventDate, productName } = {}) {
  await ensureEventNewStatus()
  const cleaned = (rows || []).map(r => ({
    name: String(r.name || '').trim(),
    nameEn: String(r.nameEn || '').trim(),
    phone: normalizePhone(r.phone) || String(r.phone || '').trim(),
    courseName: String(r.courseName || '').trim(),
    sessionDate: toEnDigits(String(r.sessionDate || '').trim())
  })).filter(r => r.phone || r.name)

  if (!cleaned.length) throw new Error('ردیفی برای ایمپورت نیست')

  // Infer event name/date from rows when not provided
  const nameGuess = eventName
    || cleaned.find(r => r.courseName)?.courseName
    || 'رویداد'
  const dateGuess = eventDate
    || cleaned.find(r => r.sessionDate)?.sessionDate
    || ''
  if (!dateGuess) throw new Error('تاریخ رویداد را وارد کنید (یا ستون تاریخ در اکسل باشد)')

  // Find existing active roster with same name+date to merge, else create
  let roster = getEventRosters().find(r =>
    r.status === 'active'
    && r.eventDate === dateGuess
    && r.name.toLowerCase() === String(nameGuess).toLowerCase()
  ) || null

  if (!roster) {
    roster = {
      id: '',
      name: nameGuess,
      eventDate: dateGuess,
      productName: productName || nameGuess,
      status: 'active',
      createdAt: new Date().toISOString(),
      archivedAt: null,
      attendees: []
    }
  }

  const byPhone = new Map()
  for (const a of roster.attendees || []) {
    const p = normalizePhone(a.phone)
    if (p) byPhone.set(p, a)
  }

  let createdCustomers = 0
  let updatedCustomers = 0
  let skipped = 0
  const errors = []

  for (let i = 0; i < cleaned.length; i++) {
    const r = cleaned[i]
    const phone = normalizePhone(r.phone)
    if (!phone) {
      skipped++
      errors.push(`ردیف ${i + 2}: شماره نامعتبر`)
      continue
    }

    let customer = findCustomerByPhoneLocal(phone)
    let isNew = false
    try {
      if (!customer) {
        const res = await createCustomerFromEventAttendee({
          name: r.name,
          nameEn: r.nameEn,
          phone
        })
        customer = res.customer
        if (res.created) {
          createdCustomers++
          isNew = true
        }
      } else {
        let dirty = false
        if (r.name && r.name !== customer.name) { customer.name = r.name; dirty = true }
        if (r.nameEn && r.nameEn !== (customer.nameEn || '')) { customer.nameEn = r.nameEn; dirty = true }
        if (dirty) {
          await saveCustomerToDB(customer)
          updatedCustomers++
        }
      }
    } catch (e) {
      errors.push(`ردیف ${i + 2}: ${e.message || 'خطا در ثبت مشتری'}`)
      skipped++
      continue
    }

    const existingAtt = byPhone.get(phone)
    if (existingAtt) {
      existingAtt.name = r.name || existingAtt.name
      existingAtt.nameEn = r.nameEn || existingAtt.nameEn
      existingAtt.customerId = customer.id
      if (isNew) existingAtt.isNewCustomer = true
    } else {
      const att = {
        id: `ea_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${i}`,
        name: r.name || customer.name || phone,
        nameEn: r.nameEn || customer.nameEn || '',
        phone,
        customerId: customer.id,
        isNewCustomer: isNew,
        source: 'import',
        addedAt: new Date().toISOString()
      }
      roster.attendees.push(att)
      byPhone.set(phone, att)
    }
  }

  const saved = await upsertEventRoster(roster)
  selectedEventDate = saved.eventDate
  selectedRosterId = saved.id
  eventsArchiveFilter = 'active'

  return { roster: saved, createdCustomers, updatedCustomers, skipped, errors }
}

/** Legacy helper used by older import path */
export async function applyEventRosterImport(rows, { dryRun = false } = {}) {
  if (dryRun) {
    let created = 0
    let updated = 0
    let skipped = 0
    const errors = []
    for (let i = 0; i < (rows || []).length; i++) {
      const phone = normalizePhone(rows[i].phone)
      if (!phone) { skipped++; errors.push(`ردیف ${i + 2}: شماره نامعتبر`); continue }
      const c = findCustomerByPhoneLocal(phone)
      if (!c) created++
      else updated++
    }
    return { updated, assigned: 0, created, skipped, errors }
  }
  const result = await importEventRosterFromRows(rows)
  return {
    updated: result.updatedCustomers,
    assigned: 0,
    created: result.createdCustomers,
    skipped: result.skipped,
    errors: result.errors
  }
}

// ============================================
// Manual add attendee
// ============================================

export function openAddEventAttendeeModal() {
  if (!getSelectedEventRoster()) {
    showToast('ابتدا یک رویداد انتخاب یا ایمپورت کنید')
    return
  }
  const nameEl = document.getElementById('addEventAttendeeName')
  const nameEnEl = document.getElementById('addEventAttendeeNameEn')
  const phoneEl = document.getElementById('addEventAttendeePhone')
  if (nameEl) nameEl.value = ''
  if (nameEnEl) nameEnEl.value = ''
  if (phoneEl) phoneEl.value = ''
  document.getElementById('addEventAttendeeModal')?.classList.add('active')
}

export function closeAddEventAttendeeModal() {
  document.getElementById('addEventAttendeeModal')?.classList.remove('active')
}

export async function submitAddEventAttendee() {
  const roster = getSelectedEventRoster()
  if (!roster) {
    showToast('رویداد انتخاب نشده')
    return
  }
  const name = document.getElementById('addEventAttendeeName')?.value || ''
  const nameEn = document.getElementById('addEventAttendeeNameEn')?.value || ''
  const phoneRaw = document.getElementById('addEventAttendeePhone')?.value || ''
  const phone = normalizePhone(phoneRaw)
  if (!phone || !/^09\d{9}$/.test(phone)) {
    showToast('شماره موبایل معتبر وارد کنید')
    return
  }
  try {
    let customer = findCustomerByPhoneLocal(phone)
    let isNew = false
    if (!customer) {
      const res = await createCustomerFromEventAttendee({ name, nameEn, phone })
      customer = res.customer
      isNew = res.created
    }
    await addAttendeeToEventRoster(roster.id, {
      name: name || customer.name,
      nameEn: nameEn || customer.nameEn || '',
      phone,
      customerId: customer.id,
      isNewCustomer: isNew,
      source: 'manual'
    })
    closeAddEventAttendeeModal()
    showToast(isNew ? 'نفر اضافه و در CRM ثبت شد (جدید از رویداد)' : 'نفر به لیست رویداد اضافه شد')
    renderEvents()
  } catch (e) {
    showToast(e.message || 'خطا در افزودن')
  }
}

// ============================================
// Archive
// ============================================

export async function archiveSelectedEventRoster() {
  const roster = getSelectedEventRoster()
  if (!roster) return
  const ok = await openAppConfirm(`رویداد «${roster.name}» بایگانی شود؟ در تاریخچه می‌ماند.`)
  if (!ok) return
  try {
    await archiveEventRoster(roster.id)
    showToast('رویداد بایگانی شد')
    eventsArchiveFilter = 'archived'
    renderEvents()
  } catch (e) {
    showToast(e.message || 'خطا در بایگانی')
  }
}

export async function unarchiveSelectedEventRoster() {
  const roster = getSelectedEventRoster()
  if (!roster) return
  try {
    await unarchiveEventRoster(roster.id)
    showToast('از بایگانی خارج شد')
    eventsArchiveFilter = 'active'
    renderEvents()
  } catch (e) {
    showToast(e.message || 'خطا')
  }
}

export async function deleteSelectedEventRoster() {
  const roster = getSelectedEventRoster()
  if (!roster) return
  const ok = await openAppConfirm(`رویداد «${roster.name}» و لیست شرکت‌کنندگان برای همیشه حذف شود؟`)
  if (!ok) return
  try {
    await deleteEventRoster(roster.id)
    selectedRosterId = ''
    showToast('رویداد حذف شد')
    renderEvents()
  } catch (e) {
    showToast(e.message || 'خطا در حذف')
  }
}

// ============================================
// New empty event (without excel)
// ============================================

export function openNewEventRosterModal() {
  const nameEl = document.getElementById('newEventRosterName')
  const dateEl = document.getElementById('newEventRosterDate')
  if (nameEl) nameEl.value = ''
  if (dateEl) dateEl.value = ''
  document.getElementById('newEventRosterModal')?.classList.add('active')
}

export function closeNewEventRosterModal() {
  document.getElementById('newEventRosterModal')?.classList.remove('active')
}

export async function submitNewEventRoster() {
  const name = document.getElementById('newEventRosterName')?.value?.trim() || ''
  const eventDate = toEnDigits(document.getElementById('newEventRosterDate')?.value || '').trim()
  if (!name || !eventDate) {
    showToast('نام و تاریخ رویداد الزامی است')
    return
  }
  try {
    const saved = await upsertEventRoster({
      name,
      eventDate,
      productName: name,
      status: 'active',
      attendees: []
    })
    selectedEventDate = saved.eventDate
    selectedRosterId = saved.id
    eventsArchiveFilter = 'active'
    closeNewEventRosterModal()
    showToast('رویداد ساخته شد — نفرات را اضافه یا اکسل ایمپورت کنید')
    renderEvents()
  } catch (e) {
    showToast(e.message || 'خطا در ساخت رویداد')
  }
}

// ============================================
// Send message
// ============================================

function findEventRowByKey(rowKey) {
  return collectSelectedRosterRows().find(r => r.rowKey === rowKey) || null
}

function buildRecipientForRow(row) {
  const data = getData()
  let customer = row.customerId
    ? data.customers.find(c => c.id === row.customerId)
    : findCustomerByPhoneLocal(row.phone)
  if (!customer) {
    customer = {
      id: row.customerId || null,
      name: row.name,
      nameEn: row.nameEn,
      phone: row.phone,
      phones: [row.phone],
      advisor: '',
      advisorPhone: '',
      nextFollowupDate: ''
    }
  }
  return buildRecipientFromCustomer(customer, {
    name_en: row.nameEn || customer.nameEn || '',
    product_name: row.productName || '',
    event_name: row.eventName || row.courseName || '',
    event_date: row.eventDate || row.sessionDate || ''
  }, {
    rosterId: row.rosterId,
    attendeeId: row.attendeeId,
    event_message: true
  })
}

export function openEventSendMessage(rowKey) {
  if (!canUseSmsKind('event_single')) {
    showToast('ارسال پیام رویداد فعال نیست یا دسترسی ندارید')
    return
  }
  const row = findEventRowByKey(rowKey)
  if (!row) {
    showToast('ردیف یافت نشد')
    return
  }
  if (!row.phone) {
    showToast('شماره تماس ثبت نشده')
    return
  }
  pendingEventMessageRow = row
  pendingEventBulkRows = null
  populateMessageTypeSelect(row.isNewCustomer ? 'club_register' : 'welcome')
  const meta = document.getElementById('eventMessageMeta')
  if (meta) meta.textContent = `${row.name || '—'} · ${row.phone} · ${row.sessionLabel || ''}`
  updateEventMessageTypePreview()
  document.getElementById('eventMessageTypeModal')?.classList.add('active')
}

function populateMessageTypeSelect(preferredId) {
  const types = getEventMessageTypes()
  const sel = document.getElementById('eventMessageTypeSelect')
  if (!sel) return
  const pref = types.some(t => t.id === preferredId) ? preferredId : (types[0]?.id || '')
  sel.innerHTML = types.map(t =>
    `<option value="${escapeAttr(t.id)}"${t.id === pref ? ' selected' : ''}>${escapeHtml(t.name)}</option>`
  ).join('') || '<option value="">نوع پیامی تعریف نشده</option>'
}

export function closeEventMessageTypeModal() {
  pendingEventMessageRow = null
  pendingEventBulkRows = null
  document.getElementById('eventMessageTypeModal')?.classList.remove('active')
}

function renderEventTemplatePreview(body, row) {
  const vars = {
    customer_name: row?.name || '',
    name_en: row?.nameEn || '',
    phone: row?.phone || '',
    product_name: row?.productName || '',
    event_name: row?.eventName || row?.courseName || '',
    event_date: row?.eventDate || row?.sessionDate || '',
    advisor: row?.advisor || '',
    org_name: 'آکادمی کارنو'
  }
  let out = String(body || '')
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{${k}}`).join(String(v ?? ''))
  }
  return out
}

export function updateEventMessageTypePreview() {
  const types = getEventMessageTypes()
  const id = document.getElementById('eventMessageTypeSelect')?.value || ''
  const type = types.find(t => t.id === id) || types[0]
  const preview = document.getElementById('eventMessageTypePreview')
  const sample = pendingEventBulkRows?.[0] || pendingEventMessageRow
  if (preview) {
    preview.textContent = type
      ? renderEventTemplatePreview(type.body, sample)
      : 'نوع پیامی در تنظیمات رویدادها تعریف نشده است.'
  }
}

export async function confirmEventMessageTypeAndCompose() {
  const types = getEventMessageTypes()
  const id = document.getElementById('eventMessageTypeSelect')?.value || ''
  const type = types.find(t => t.id === id)
  if (!type) {
    showToast('یک نوع پیام انتخاب کنید')
    return
  }
  const bulk = pendingEventBulkRows
  if (bulk?.length) {
    const recipients = bulk.filter(r => r.phone).map(buildRecipientForRow)
    if (!recipients.length) {
      showToast('گیرنده‌ای نیست')
      return
    }
    closeEventMessageTypeModal()
    await openSmsComposeModal({
      kind: 'event_single',
      title: `پیام گروهی رویداد — ${type.name}`,
      templateKey: '',
      body: type.body || '',
      recipients
    })
    return
  }
  const row = pendingEventMessageRow
  if (!row) return
  closeEventMessageTypeModal()
  await openSmsComposeModal({
    kind: 'event_single',
    title: `ارسال پیام رویداد — ${type.name}`,
    templateKey: '',
    body: type.body || '',
    recipients: [buildRecipientForRow(row)]
  })
}

export async function openEventsBulkSendMessage() {
  if (!canUseSmsKind('event_single')) {
    showToast('ارسال پیام رویداد فعال نیست یا دسترسی ندارید')
    return
  }
  const rows = getFilteredEventRows().filter(r => r.phone)
  if (!rows.length) {
    showToast('گیرنده‌ای در لیست نیست')
    return
  }
  pendingEventMessageRow = rows[0]
  pendingEventBulkRows = rows
  populateMessageTypeSelect('welcome')
  const meta = document.getElementById('eventMessageMeta')
  if (meta) meta.textContent = `${formatNumber(rows.length)} گیرنده از لیست رویداد`
  updateEventMessageTypePreview()
  document.getElementById('eventMessageTypeModal')?.classList.add('active')
}

/** Select roster after import (used by import-export) */
export function selectEventRoster(rosterId) {
  const r = getEventRosterById(rosterId)
  if (!r) return
  selectedEventDate = r.eventDate
  selectedRosterId = r.id
  eventsArchiveFilter = r.status === 'archived' ? 'archived' : 'active'
}
