import {
  getData,
  getInPersonSessions,
  getActiveInPersonSessions,
  getInPersonCourseNames,
  saleHasInPersonSessionId,
  getSaleInPersonSessionIds,
  coerceProductName,
  formatInPersonSessionLabel,
  getEventMessageTypes,
  saveCustomerToDB,
  generateId,
  putCustomerInCache,
  assignInPersonSessionToSale,
  applySaleInPersonSessionMap,
  assertSaleCanUseInPersonSession,
  getEventCourseNamesForSellable,
  invalidateProductSalesCountCache
} from './data.js'
import {
  toEnDigits,
  formatNumber,
  escapeHtml,
  escapeAttr,
  hasPermission,
  jalaliToNum,
  getTodayJalaliNum,
  matchesTabSearch,
  canViewScopedCustomer,
  getPrimaryPhone,
  getCustomerPhones,
  normalizePhone,
  showToast,
  findCustomerByPhone,
  normalizeCustomerPhones,
  getCurrentUser,
  userDisplayName,
  getNowJalaliDateTime,
  canAddSaleOnCustomer,
  PAYMENT_STATUS,
  syncProductStatus
} from './utils.js'
import { paginateList, renderPaginationBar, getPage, setPage } from './pagination.js'
import { toggleSortField, sortRecords, syncSortHeaders } from './table-sort.js'
import { runWithSearchOverlay, SEARCH_HOST } from './search-overlay.js'
import { debouncedSearchInput } from './search-debounce.js'
import { shouldSkipTabRender, markTabRendered, tabPageKey } from './tab-cache.js'
import { canUseSmsKind, buildRecipientFromCustomer } from './sms-business.js'
import { openSmsComposeModal } from './sms-ui.js'

let eventsSortState = { field: 'sessionDate', asc: false }

/** @type {Set<string>} selected event product names; empty = all */
let selectedEventProductNames = new Set()
/** @type {string[]} */
let eventProductOptionsCache = []
let eventProductDropdownOpen = false
let eventProductOutsideClickBound = false
let eventProductSearchQuery = ''

/** @type {null | object} row pending message send */
let pendingEventMessageRow = null
/** @type {null | object[]} bulk rows when opened via openEventsBulkSendMessage */
let pendingEventBulkRows = null

// ============================================
// Data: attendees of in-person / event sessions
// ============================================

/**
 * One row per customer × session assignment for event (حضوری) products.
 * Automatically includes anyone whose sale is linked to an in-person session.
 */
export function collectEventAttendeeRows() {
  const data = getData()
  const sessionsById = new Map(getInPersonSessions().map(s => [s.id, s]))
  const rows = []
  const seen = new Set()

  for (const customer of data.customers || []) {
    if (!canViewScopedCustomer(customer, undefined, 'sales') && !canViewScopedCustomer(customer)) continue
    const products = Array.isArray(customer.products) ? customer.products : []
    products.forEach((product, productIndex) => {
      if (product?.historicalImport) return
      const ids = getSaleInPersonSessionIds(product)
      if (!ids.length) return
      for (const sessionId of ids) {
        const session = sessionsById.get(sessionId)
        if (!session) continue
        const key = `${customer.id}::${productIndex}::${sessionId}`
        if (seen.has(key)) continue
        seen.add(key)
        const phone = getPrimaryPhone(customer) || ''
        rows.push({
          rowKey: key,
          customerId: customer.id,
          productIndex,
          sessionId,
          name: customer.name || customer.platformId || customer.id,
          nameEn: customer.nameEn || '',
          phone,
          phones: getCustomerPhones(customer),
          productName: coerceProductName(product.name) || product.name || '—',
          courseName: session.courseName || coerceProductName(product.name) || product.name || '—',
          sessionDate: session.sessionDate || '',
          sessionLabel: formatInPersonSessionLabel(session),
          status: product.status || '—',
          advisor: customer.advisor || ''
        })
      }
    })
  }
  return rows
}

function eventSortValue(row, field) {
  if (field === 'name') return { value: row.name || '', type: 'string' }
  if (field === 'nameEn') return { value: row.nameEn || '', type: 'string' }
  if (field === 'phone') return { value: row.phone || '', type: 'string' }
  if (field === 'courseName') return { value: row.courseName || '', type: 'string' }
  if (field === 'sessionDate') return { value: row.sessionDate || '', type: 'date' }
  if (field === 'productName') return { value: row.productName || '', type: 'string' }
  return { value: row.name || '', type: 'string' }
}

/** True when the user set از/تا تاریخ (not the default «today only» view). */
export function hasEventsDateFilter() {
  return !!(
    document.getElementById('filterEventsDateFrom')?.value?.trim()
    || document.getElementById('filterEventsDateTo')?.value?.trim()
  )
}

export function getFilteredEventRows() {
  const search = toEnDigits(document.getElementById('searchEvents')?.value || '').trim()
  const dateFrom = toEnDigits(document.getElementById('filterEventsDateFrom')?.value || '').trim()
  const dateTo = toEnDigits(document.getElementById('filterEventsDateTo')?.value || '').trim()
  const fromNum = dateFrom ? jalaliToNum(dateFrom) : 0
  const toNum = dateTo ? jalaliToNum(dateTo) : 0
  const hasUserDateFilter = !!(fromNum || toNum)
  const todayNum = getTodayJalaliNum()

  let rows = collectEventAttendeeRows()

  if (selectedEventProductNames.size > 0) {
    rows = rows.filter(r => {
      const course = String(r.courseName || '').trim()
      const product = String(r.productName || '').trim()
      return selectedEventProductNames.has(course) || selectedEventProductNames.has(product)
    })
  }

  rows = rows.filter(r => {
    const n = jalaliToNum(r.sessionDate)
    if (!n) return false
    if (hasUserDateFilter) {
      if (fromNum && n < fromNum) return false
      if (toNum && n > toNum) return false
      return true
    }
    // Default: only attendees whose session is today
    return n === todayNum
  })

  if (search) {
    rows = rows.filter(r => matchesTabSearch(search, [
      r.name, r.nameEn, r.phone, ...(r.phones || []),
      r.courseName, r.productName, r.sessionDate, r.advisor, r.sessionLabel
    ]))
  }

  return sortRecords(rows, eventsSortState, eventSortValue)
}

function eventsFilterSig() {
  const search = toEnDigits(document.getElementById('searchEvents')?.value || '').trim()
  const dateFrom = toEnDigits(document.getElementById('filterEventsDateFrom')?.value || '').trim()
  const dateTo = toEnDigits(document.getElementById('filterEventsDateTo')?.value || '').trim()
  const products = [...selectedEventProductNames].sort().join('|')
  // Include today so the default «today only» view refreshes across midnight
  return `${search}::${dateFrom}::${dateTo}::${products}::${eventsSortState.field}:${eventsSortState.asc ? 1 : 0}::${getTodayJalaliNum()}`
}

export function renderEvents() {
  if (!hasPermission('events_view')) return

  populateEventProductFilterOptions()

  const body = document.getElementById('eventsBody')
  if (!body) return

  const filterSig = eventsFilterSig()
  const cacheKey = `${filterSig}|${tabPageKey('events', getPage('events'))}`
  if (shouldSkipTabRender('events', cacheKey)) return

  runWithSearchOverlay(SEARCH_HOST.events, () => {
    const all = getFilteredEventRows()
    const page = paginateList('events', all, filterSig)

    syncSortHeaders('#sheet-events', eventsSortState)

    const countEl = document.getElementById('eventsResultCount')
    if (countEl) {
      countEl.textContent = all.length
        ? `${formatNumber(all.length)} شرکت‌کننده`
        : 'شرکت‌کننده‌ای نیست'
    }

    const allowSms = !hasEventsDateFilter()
    const bulkBtn = document.getElementById('eventsBulkSmsBtn')
    if (bulkBtn) bulkBtn.hidden = !allowSms

    if (!all.length) {
      const emptyMsg = hasEventsDateFilter()
        ? 'شرکت‌کننده‌ای در بازه تاریخ انتخاب‌شده یافت نشد.'
        : 'شرکت‌کننده‌ای برای رویدادهای امروز یافت نشد. سانس حضوری را در تنظیمات تعریف و به فروش‌ها تخصیص دهید.'
      body.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);">${emptyMsg}</td></tr>`
      renderPaginationBar('eventsPagination', 'events', { total: 0, from: 0, to: 0, page: 1, totalPages: 1 })
    } else {
      const canSms = allowSms && canUseSmsKind('event_single')
      body.innerHTML = page.items.map(r => {
        let smsCell = '—'
        if (allowSms) {
          smsCell = canSms
            ? `<button type="button" class="btn btn-sm btn-primary" data-perm="sms_events" onclick="event.stopPropagation();app.openEventSendMessage('${escapeAttr(r.rowKey)}')">ارسال پیام</button>`
            : `<button type="button" class="btn btn-sm" disabled title="دسترسی پیامک رویداد فعال نیست">ارسال پیام</button>`
        }
        return `<tr class="clickable-row" onclick="app.onCustomerRowClick(event, '${escapeAttr(r.customerId)}')">
          <td>${escapeHtml(r.name || '—')}</td>
          <td style="direction:ltr;text-align:left;font-family:'Vazirmatn',sans-serif;">${escapeHtml(r.nameEn || '—')}</td>
          <td style="direction:ltr;text-align:right;font-family:'Vazirmatn',sans-serif;">${escapeHtml(r.phone || '—')}</td>
          <td>${escapeHtml(r.courseName || '—')}</td>
          <td style="font-family:'Vazirmatn',sans-serif;direction:ltr;">${escapeHtml(r.sessionDate || '—')}</td>
          <td onclick="event.stopPropagation()">${smsCell}</td>
        </tr>`
      }).join('')
      renderPaginationBar('eventsPagination', 'events', page)
    }

    markTabRendered('events', `${filterSig}|${tabPageKey('events', page.page)}`)
  })
}

export function onEventsDateFilterChange() {
  setPage('events', 1)
  renderEvents()
}

export function onEventsSearchInput() {
  debouncedSearchInput('events', () => {
    setPage('events', 1)
    renderEvents()
  }, SEARCH_HOST.events)
}

export function sortEventsHeader(field) {
  toggleSortField(eventsSortState, field)
  setPage('events', 1)
  renderEvents()
}

export function clearEventsFilters() {
  const search = document.getElementById('searchEvents')
  const from = document.getElementById('filterEventsDateFrom')
  const to = document.getElementById('filterEventsDateTo')
  if (search) search.value = ''
  if (from) from.value = ''
  if (to) to.value = ''
  selectedEventProductNames = new Set()
  syncEventProductFilterUi()
  setPage('events', 1)
  renderEvents()
}

// ============================================
// Product multi-select filter
// ============================================

function populateEventProductFilterOptions() {
  const names = getInPersonCourseNames()
  const sessionCourses = [...new Set(getActiveInPersonSessions().map(s => s.courseName).filter(Boolean))]
  const merged = [...new Set([...names, ...sessionCourses])].sort((a, b) => a.localeCompare(b, 'fa'))
  eventProductOptionsCache = merged
  syncEventProductFilterUi()
}

function syncEventProductFilterUi() {
  const countEl = document.getElementById('eventsProductFilterCount')
  const n = selectedEventProductNames.size
  if (countEl) countEl.textContent = n ? `(${formatNumber(n)})` : ''
  const clearBtn = document.getElementById('clearEventsFiltersBtn')
  const hasFilter = n > 0
    || !!document.getElementById('searchEvents')?.value?.trim()
    || !!document.getElementById('filterEventsDateFrom')?.value?.trim()
    || !!document.getElementById('filterEventsDateTo')?.value?.trim()
  if (clearBtn) clearBtn.hidden = !hasFilter
  renderEventProductDropdown()
}

function renderEventProductDropdown() {
  const dropdown = document.getElementById('eventsProductFilterDropdown')
  if (!dropdown) return
  const q = toEnDigits(eventProductSearchQuery).trim().toLowerCase()
  const options = eventProductOptionsCache.filter(name => {
    if (!q) return true
    return toEnDigits(name).toLowerCase().includes(q)
  })
  dropdown.innerHTML = `
    <div class="product-matrix-advisor-search">
      <input type="search" class="form-input" placeholder="جستجوی محصول…" value="${escapeAttr(eventProductSearchQuery)}"
        oninput="app.onEventsProductFilterSearch(this.value)" onclick="event.stopPropagation()" autocomplete="off">
    </div>
    <label class="product-matrix-advisor-option">
      <input type="checkbox" ${selectedEventProductNames.size === 0 ? 'checked' : ''} onchange="app.clearEventsProductFilter();event.stopPropagation()">
      <span>همه محصولات رویداد</span>
    </label>
    ${options.map(name => {
      const checked = selectedEventProductNames.has(name)
      return `<label class="product-matrix-advisor-option">
        <input type="checkbox" ${checked ? 'checked' : ''} onchange="app.toggleEventsProductFilter('${escapeAttr(name)}');event.stopPropagation()">
        <span>${escapeHtml(name)}</span>
      </label>`
    }).join('') || '<div class="settings-pane-desc" style="padding:8px;">محصولی نیست</div>'}
  `
}

export function toggleEventsProductDropdown(event) {
  event?.stopPropagation?.()
  const dropdown = document.getElementById('eventsProductFilterDropdown')
  if (!dropdown) return
  eventProductDropdownOpen = !eventProductDropdownOpen
  dropdown.hidden = !eventProductDropdownOpen
  if (eventProductDropdownOpen) {
    renderEventProductDropdown()
    if (!eventProductOutsideClickBound) {
      eventProductOutsideClickBound = true
      document.addEventListener('click', (e) => {
        const host = document.getElementById('eventsProductFilter')
        if (host && !host.contains(e.target)) {
          eventProductDropdownOpen = false
          dropdown.hidden = true
        }
      })
    }
  }
}

export function toggleEventsProductFilter(name) {
  const key = String(name || '').trim()
  if (!key) return
  if (selectedEventProductNames.has(key)) selectedEventProductNames.delete(key)
  else selectedEventProductNames.add(key)
  syncEventProductFilterUi()
  setPage('events', 1)
  renderEvents()
}

export function clearEventsProductFilter() {
  selectedEventProductNames = new Set()
  syncEventProductFilterUi()
  setPage('events', 1)
  renderEvents()
}

export function onEventsProductFilterSearch(value) {
  eventProductSearchQuery = String(value || '')
  renderEventProductDropdown()
}

// ============================================
// Send message (type picker → SMS compose)
// ============================================

function findEventRowByKey(rowKey) {
  return collectEventAttendeeRows().find(r => r.rowKey === rowKey) || null
}

export function openEventSendMessage(rowKey) {
  if (hasEventsDateFilter()) {
    showToast('ارسال پیام فقط برای شرکت‌کنندگان امروز (بدون فیلتر تاریخ) امکان‌پذیر است')
    return
  }
  if (!canUseSmsKind('event_single')) {
    showToast('ارسال پیام رویداد فعال نیست یا دسترسی ندارید')
    return
  }
  const row = findEventRowByKey(rowKey)
  if (!row) {
    showToast('ردیف رویداد یافت نشد')
    return
  }
  if (!row.phone) {
    showToast('شماره تماس برای این مشتری ثبت نشده')
    return
  }
  pendingEventMessageRow = row
  pendingEventBulkRows = null
  const types = getEventMessageTypes()
  const sel = document.getElementById('eventMessageTypeSelect')
  const preview = document.getElementById('eventMessageTypePreview')
  const meta = document.getElementById('eventMessageMeta')
  if (sel) {
    sel.innerHTML = types.map(t =>
      `<option value="${escapeAttr(t.id)}">${escapeHtml(t.name)}</option>`
    ).join('') || '<option value="">نوع پیامی تعریف نشده</option>'
  }
  if (meta) {
    meta.textContent = `${row.name || '—'} · ${row.phone} · ${row.sessionLabel || row.courseName}`
  }
  updateEventMessageTypePreview()
  if (preview) { /* filled by update */ }
  document.getElementById('eventMessageTypeModal')?.classList.add('active')
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
    event_name: row?.courseName || row?.productName || '',
    event_date: row?.sessionDate || '',
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
  if (preview) {
    preview.textContent = type
      ? renderEventTemplatePreview(type.body, pendingEventMessageRow)
      : 'نوع پیامی در تنظیمات رویدادها تعریف نشده است.'
  }
}

export async function confirmEventMessageTypeAndCompose() {
  const types = getEventMessageTypes()
  const id = document.getElementById('eventMessageTypeSelect')?.value || ''
  const type = types.find(t => t.id === id)
  if (!type) {
    showToast('یک نوع پیام انتخاب کنید. در تنظیمات رویدادها الگوها را تعریف کنید.')
    return
  }
  const data = getData()
  const bulk = pendingEventBulkRows
  if (bulk?.length) {
    const recipients = []
    for (const row of bulk) {
      const customer = data.customers.find(c => c.id === row.customerId)
      if (!customer) continue
      recipients.push(buildRecipientFromCustomer(customer, {
        name_en: customer.nameEn || row.nameEn || '',
        product_name: row.productName || '',
        event_name: row.courseName || row.productName || '',
        event_date: row.sessionDate || ''
      }, { productIndex: row.productIndex, sessionId: row.sessionId, event_message_type: type.id }))
    }
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
  const customer = data.customers.find(c => c.id === row.customerId)
  if (!customer) {
    showToast('مشتری یافت نشد')
    return
  }
  const recipient = buildRecipientFromCustomer(customer, {
    name_en: customer.nameEn || row.nameEn || '',
    product_name: row.productName || '',
    event_name: row.courseName || row.productName || '',
    event_date: row.sessionDate || ''
  }, { productIndex: row.productIndex, sessionId: row.sessionId, event_message_type: type.id })

  closeEventMessageTypeModal()
  await openSmsComposeModal({
    kind: 'event_single',
    title: `ارسال پیام رویداد — ${type.name}`,
    templateKey: '',
    body: type.body || '',
    recipients: [recipient]
  })
}

/** Bulk: send same message type to all filtered attendees with phones. */
export async function openEventsBulkSendMessage() {
  if (hasEventsDateFilter()) {
    showToast('ارسال پیام فقط برای شرکت‌کنندگان امروز (بدون فیلتر تاریخ) امکان‌پذیر است')
    return
  }
  if (!canUseSmsKind('event_single')) {
    showToast('ارسال پیام رویداد فعال نیست یا دسترسی ندارید')
    return
  }
  const rows = getFilteredEventRows().filter(r => r.phone)
  if (!rows.length) {
    showToast('گیرنده‌ای در لیست فیلترشده نیست')
    return
  }
  pendingEventMessageRow = rows[0]
  pendingEventBulkRows = rows
  const types = getEventMessageTypes()
  const sel = document.getElementById('eventMessageTypeSelect')
  const meta = document.getElementById('eventMessageMeta')
  if (sel) {
    sel.innerHTML = types.map(t =>
      `<option value="${escapeAttr(t.id)}">${escapeHtml(t.name)}</option>`
    ).join('') || '<option value="">نوع پیامی تعریف نشده</option>'
  }
  if (meta) meta.textContent = `${formatNumber(rows.length)} گیرنده از لیست فیلترشده`
  updateEventMessageTypePreview()
  document.getElementById('eventMessageTypeModal')?.classList.add('active')
}

// ============================================
// Import helpers (called from import-export)
// ============================================

/** Compare event labels (course names) ignoring ZWNJ / extra spaces / case. */
function normalizeEventLabel(value) {
  return toEnDigits(String(value || ''))
    .replace(/\u200c/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** True when both values are valid Jalali dates with the same Y/M/D (padding-insensitive). */
function eventDatesEqual(a, b) {
  const na = jalaliToNum(a)
  const nb = jalaliToNum(b)
  return na !== 99999999 && nb !== 99999999 && na === nb
}

/**
 * Apply imported event roster rows: match by phone, update name/nameEn.
 * If course+date match a session and customer has that event sale without that session, assign.
 * @returns {{ updated: number, assigned: number, skipped: number, errors: string[] }}
 */
export async function applyEventRosterImport(rows, { dryRun = false } = {}) {
  const {
    assignInPersonSessionToSale,
    getActiveInPersonSessions: getSessions,
    getEventCourseNamesForSellable
  } = await import('./data.js')
  const data = getData()
  const sessions = getSessions()
  const byPhone = new Map()
  for (const c of data.customers || []) {
    for (const p of getCustomerPhones(c)) {
      const n = normalizePhone(p)
      if (n) byPhone.set(n, c)
    }
  }

  let updated = 0
  let assigned = 0
  let skipped = 0
  const errors = []

  for (let i = 0; i < (rows || []).length; i++) {
    const rowNum = i + 2
    const r = rows[i]
    const phone = normalizePhone(r.phone)
    if (!phone) {
      skipped++
      errors.push(`ردیف ${rowNum}: شماره نامعتبر`)
      continue
    }
    const customer = byPhone.get(phone)
    if (!customer) {
      skipped++
      errors.push(`ردیف ${rowNum}: مشتری با شماره ${phone} یافت نشد`)
      continue
    }
    let dirty = false
    const name = String(r.name || '').trim()
    const nameEn = String(r.nameEn || '').trim()
    if (name && name !== customer.name) {
      customer.name = name
      dirty = true
    }
    if (nameEn && nameEn !== (customer.nameEn || '')) {
      customer.nameEn = nameEn
      dirty = true
    }

    const course = String(r.courseName || '').trim()
    const sessionDate = toEnDigits(String(r.sessionDate || '').trim())
    const courseNorm = normalizeEventLabel(course)
    let didAssign = false
    if (course && sessionDate) {
      const session = sessions.find(s =>
        normalizeEventLabel(s.courseName) === courseNorm &&
        eventDatesEqual(s.sessionDate, sessionDate)
      )
      if (!session) {
        const sameCourse = sessions.filter(s => normalizeEventLabel(s.courseName) === courseNorm)
        if (!sameCourse.length) {
          errors.push(`ردیف ${rowNum}: سانس فعالی با نام دوره «${course}» یافت نشد`)
        } else {
          const dates = sameCourse.map(s => s.sessionDate).join('، ')
          errors.push(`ردیف ${rowNum}: تاریخ «${sessionDate}» با سانس‌های «${course}» یکی نیست (موجود: ${dates})`)
        }
      } else {
        const products = Array.isArray(customer.products) ? customer.products : []
        let foundEventSale = false
        for (let pi = 0; pi < products.length; pi++) {
          const p = products[pi]
          if (p?.historicalImport) continue
          const pname = coerceProductName(p.name) || p.name || ''
          const eventCourses = getEventCourseNamesForSellable(pname)
          const isEventSale = eventCourses.some(c => normalizeEventLabel(c) === courseNorm)
            || normalizeEventLabel(pname) === courseNorm
          if (!isEventSale) continue
          foundEventSale = true
          if (saleHasInPersonSessionId(p, session.id)) {
            didAssign = true
            break
          }
          if (!dryRun) {
            try {
              await assignInPersonSessionToSale(customer.id, pi, session.id)
              didAssign = true
              assigned++
            } catch (e) {
              errors.push(`ردیف ${rowNum}: ${e.message || 'خطا در تخصیص سانس'}`)
            }
          } else {
            didAssign = true
            assigned++
          }
          break
        }
        if (!didAssign && !foundEventSale) {
          errors.push(`ردیف ${rowNum}: مشتری هست ولی فروش رویداد هم‌خوان برای «${course}» ندارد`)
        }
      }
    }

    if (dirty) {
      updated++
      if (!dryRun) {
        try {
          await saveCustomerToDB(customer)
        } catch (e) {
          errors.push(`ردیف ${rowNum}: ${e.message || 'خطا در ذخیره مشتری'}`)
        }
      }
    } else if (!didAssign) {
      skipped++
    }
  }

  return { updated, assigned, skipped, errors }
}

// ============================================
// Walk-in / ثبت دستی (today's session)
// ============================================

/** Active sessions whose date is today; respects product multi-filter when set. */
export function getTodayWalkInSessions() {
  const todayNum = getTodayJalaliNum()
  let sessions = getActiveInPersonSessions().filter(s => jalaliToNum(s.sessionDate) === todayNum)
  if (selectedEventProductNames.size > 0) {
    sessions = sessions.filter(s => {
      const course = String(s.courseName || '').trim()
      return selectedEventProductNames.has(course)
    })
  }
  return sessions
}

function buildWalkInGiftProduct(session, user) {
  const { dateTime } = getNowJalaliDateTime()
  const courseName = coerceProductName(session.courseName) || session.courseName
  const product = {
    name: courseName,
    saleType: 'gift',
    price: '0',
    priceLocked: true,
    status: 'هدیه',
    payments: [],
    deposit: '',
    settlementDate: '',
    giftAccountingStatus: PAYMENT_STATUS.pending,
    giftRejectReason: '',
    giftReviewedAt: '',
    giftReviewedBy: '',
    soldByPhone: normalizePhone(user?.phone || ''),
    soldAt: dateTime,
    depositorName: ''
  }
  applySaleInPersonSessionMap(product, { [courseName]: session.id })
  syncProductStatus(product)
  return product
}

function findMatchingEventSaleIndex(customer, courseNorm) {
  const products = Array.isArray(customer.products) ? customer.products : []
  for (let pi = 0; pi < products.length; pi++) {
    const p = products[pi]
    if (p?.historicalImport) continue
    const pname = coerceProductName(p.name) || p.name || ''
    const eventCourses = getEventCourseNamesForSellable(pname)
    const isEventSale = eventCourses.some(c => normalizeEventLabel(c) === courseNorm)
      || normalizeEventLabel(pname) === courseNorm
    if (isEventSale) return pi
  }
  return -1
}

export function openEventsWalkInModal() {
  if (!hasPermission('events_view')) {
    showToast('دسترسی مشاهده رویدادها ندارید')
    return
  }
  const sessions = getTodayWalkInSessions()
  if (!sessions.length) {
    showToast(selectedEventProductNames.size
      ? 'سانس فعالی برای امروز با فیلتر محصول فعلی نیست'
      : 'سانس فعالی برای امروز تعریف نشده است')
    return
  }

  const meta = document.getElementById('eventsWalkInSessionMeta')
  const group = document.getElementById('eventsWalkInSessionGroup')
  const sel = document.getElementById('eventsWalkInSessionSelect')
  const nameEl = document.getElementById('eventsWalkInName')
  const phoneEl = document.getElementById('eventsWalkInPhone')

  if (sessions.length === 1) {
    if (group) group.hidden = true
    if (sel) {
      sel.innerHTML = `<option value="${escapeAttr(sessions[0].id)}">${escapeHtml(formatInPersonSessionLabel(sessions[0]))}</option>`
      sel.value = sessions[0].id
    }
    if (meta) meta.textContent = formatInPersonSessionLabel(sessions[0])
  } else {
    if (group) group.hidden = false
    if (sel) {
      sel.innerHTML = sessions.map(s =>
        `<option value="${escapeAttr(s.id)}">${escapeHtml(formatInPersonSessionLabel(s))}</option>`
      ).join('')
    }
    if (meta) meta.textContent = `${formatNumber(sessions.length)} سانس امروز — یکی را انتخاب کنید`
  }

  if (nameEl) nameEl.value = ''
  if (phoneEl) phoneEl.value = ''
  document.getElementById('eventsWalkInModal')?.classList.add('active')
  setTimeout(() => nameEl?.focus(), 50)
}

export function closeEventsWalkInModal() {
  document.getElementById('eventsWalkInModal')?.classList.remove('active')
}

export async function submitEventsWalkIn() {
  if (!hasPermission('events_view')) {
    showToast('دسترسی مشاهده رویدادها ندارید')
    return
  }

  const name = String(document.getElementById('eventsWalkInName')?.value || '').trim()
  const phoneRaw = document.getElementById('eventsWalkInPhone')?.value || ''
  const phone = normalizePhone(phoneRaw)
  const sessionId = document.getElementById('eventsWalkInSessionSelect')?.value || ''
  const sessions = getTodayWalkInSessions()
  const session = sessions.find(s => s.id === sessionId) || (sessions.length === 1 ? sessions[0] : null)

  if (!name) {
    showToast('نام را وارد کنید')
    document.getElementById('eventsWalkInName')?.focus()
    return
  }
  if (!phone) {
    showToast('شماره تماس معتبر وارد کنید')
    document.getElementById('eventsWalkInPhone')?.focus()
    return
  }
  if (!session) {
    showToast('سانس امروز را انتخاب کنید')
    return
  }

  const btn = document.getElementById('eventsWalkInSubmitBtn')
  const prevLabel = btn?.textContent
  if (btn) {
    btn.disabled = true
    btn.textContent = 'در حال ثبت…'
  }

  try {
    const data = getData()
    const user = getCurrentUser()
    const courseNorm = normalizeEventLabel(session.courseName)
    let customer = findCustomerByPhone(phone, data.customers || [])
    let created = false

    if (!customer) {
      if (!hasPermission('customers_add')) {
        showToast('دسترسی افزودن مشتری ندارید')
        return
      }
      const id = await generateId('CS')
      const phones = normalizeCustomerPhones([phone])
      const advisor = userDisplayName(user).trim() || ''
      const advisorPhone = normalizePhone(user?.phone || '')
      customer = {
        id,
        platformId: '',
        platform: 'instagram',
        name,
        nameEn: 'همراه',
        phone: phones[0] || phone,
        phones,
        status: 'purchased',
        notes: 'ثبت دستی از تب رویدادها',
        advisor,
        advisorPhone,
        nextFollowupDate: '',
        products: [],
        createdAt: new Date().toISOString(),
        customerLevel: '',
        customerLevelLocked: false
      }
      created = true
    } else if (!canAddSaleOnCustomer(customer)) {
      showToast('دسترسی ثبت فروش برای این مشتری را ندارید')
      return
    }

    if (!Array.isArray(customer.products)) customer.products = []

    // Already on this session?
    for (const p of customer.products) {
      if (p?.historicalImport) continue
      if (saleHasInPersonSessionId(p, session.id)) {
        showToast('این شماره قبلاً برای این سانس ثبت شده است')
        return
      }
    }

    const matchIdx = findMatchingEventSaleIndex(customer, courseNorm)
    if (matchIdx >= 0) {
      if (saleHasInPersonSessionId(customer.products[matchIdx], session.id)) {
        showToast('این شماره قبلاً برای این سانس ثبت شده است')
        return
      }
      if (!created) {
        await assignInPersonSessionToSale(customer.id, matchIdx, session.id)
        showToast('به سانس امروز وصل شد')
        afterWalkInSuccess()
        return
      }
    }

    // New gift sale line + session (bypass catalog allowGift)
    const productIndex = customer.products.length
    assertSaleCanUseInPersonSession(session.id, customer.id, productIndex)
    const product = buildWalkInGiftProduct(session, user)
    customer.products.push(product)
    customer._productsLoaded = true
    customer.productCount = customer.products.length
    invalidateProductSalesCountCache()

    if (created) {
      putCustomerInCache(customer)
      await saveCustomerToDB(customer)
      showToast('مشتری همراه ثبت و به سانس وصل شد')
    } else {
      const idx = data.customers.findIndex(c => c.id === customer.id)
      if (idx >= 0) data.customers[idx] = customer
      await saveCustomerToDB(customer)
      showToast('فروش رویداد ثبت و به سانس وصل شد')
    }

    afterWalkInSuccess()
  } catch (e) {
    console.error('submitEventsWalkIn error:', e)
    showToast(e.message || 'خطا در ثبت دستی')
  } finally {
    if (btn) {
      btn.disabled = false
      if (prevLabel) btn.textContent = prevLabel
    }
  }
}

function afterWalkInSuccess() {
  const nameEl = document.getElementById('eventsWalkInName')
  const phoneEl = document.getElementById('eventsWalkInPhone')
  if (nameEl) nameEl.value = ''
  if (phoneEl) phoneEl.value = ''
  try { renderEvents() } catch (_) {}
  setTimeout(() => nameEl?.focus(), 50)
}
