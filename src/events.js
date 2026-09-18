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
  saveCustomerToDB
} from './data.js'
import {
  toEnDigits,
  formatNumber,
  escapeHtml,
  escapeAttr,
  hasPermission,
  jalaliToNum,
  matchesTabSearch,
  canViewScopedCustomer,
  getPrimaryPhone,
  getCustomerPhones,
  normalizePhone,
  showToast
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

export function getFilteredEventRows() {
  const search = toEnDigits(document.getElementById('searchEvents')?.value || '').trim()
  const dateFrom = toEnDigits(document.getElementById('filterEventsDateFrom')?.value || '').trim()
  const dateTo = toEnDigits(document.getElementById('filterEventsDateTo')?.value || '').trim()
  const fromNum = dateFrom ? jalaliToNum(dateFrom) : 0
  const toNum = dateTo ? jalaliToNum(dateTo) : 0

  let rows = collectEventAttendeeRows()

  if (selectedEventProductNames.size > 0) {
    rows = rows.filter(r => {
      const course = String(r.courseName || '').trim()
      const product = String(r.productName || '').trim()
      return selectedEventProductNames.has(course) || selectedEventProductNames.has(product)
    })
  }

  if (fromNum || toNum) {
    rows = rows.filter(r => {
      const n = jalaliToNum(r.sessionDate)
      if (!n) return false
      if (fromNum && n < fromNum) return false
      if (toNum && n > toNum) return false
      return true
    })
  }

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
  return `${search}::${dateFrom}::${dateTo}::${products}::${eventsSortState.field}:${eventsSortState.asc ? 1 : 0}`
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

    if (!all.length) {
      body.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);">شرکت‌کننده‌ای برای رویدادهای تعریف‌شده یافت نشد. سانس حضوری را در تنظیمات تعریف و به فروش‌ها تخصیص دهید.</td></tr>`
      renderPaginationBar('eventsPagination', 'events', { total: 0, from: 0, to: 0, page: 1, totalPages: 1 })
    } else {
      const canSms = canUseSmsKind('event_single')
      body.innerHTML = page.items.map(r => {
        const smsBtn = canSms
          ? `<button type="button" class="btn btn-sm btn-primary" data-perm="sms_events" onclick="event.stopPropagation();app.openEventSendMessage('${escapeAttr(r.rowKey)}')">ارسال پیام</button>`
          : `<button type="button" class="btn btn-sm" disabled title="دسترسی پیامک رویداد فعال نیست">ارسال پیام</button>`
        return `<tr class="clickable-row" onclick="app.onCustomerRowClick(event, '${escapeAttr(r.customerId)}')">
          <td>${escapeHtml(r.name || '—')}</td>
          <td style="direction:ltr;text-align:left;font-family:'Vazirmatn',sans-serif;">${escapeHtml(r.nameEn || '—')}</td>
          <td style="direction:ltr;text-align:right;font-family:'Vazirmatn',sans-serif;">${escapeHtml(r.phone || '—')}</td>
          <td>${escapeHtml(r.courseName || '—')}</td>
          <td style="font-family:'Vazirmatn',sans-serif;direction:ltr;">${escapeHtml(r.sessionDate || '—')}</td>
          <td onclick="event.stopPropagation()">${smsBtn}</td>
        </tr>`
      }).join('')
      renderPaginationBar('eventsPagination', 'events', page)
    }

    markTabRendered('events', `${filterSig}|${tabPageKey('events', page.page)}`)
  })
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
    const r = rows[i]
    const phone = normalizePhone(r.phone)
    if (!phone) {
      skipped++
      errors.push(`ردیف ${i + 2}: شماره نامعتبر`)
      continue
    }
    const customer = byPhone.get(phone)
    if (!customer) {
      skipped++
      errors.push(`ردیف ${i + 2}: مشتری با شماره ${phone} یافت نشد`)
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
    let didAssign = false
    if (course && sessionDate) {
      const session = sessions.find(s =>
        s.courseName.toLowerCase() === course.toLowerCase() &&
        s.sessionDate === sessionDate
      )
      if (session) {
        const products = Array.isArray(customer.products) ? customer.products : []
        for (let pi = 0; pi < products.length; pi++) {
          const p = products[pi]
          if (p?.historicalImport) continue
          const pname = coerceProductName(p.name) || p.name || ''
          const eventCourses = getEventCourseNamesForSellable(pname)
          const isEventSale = eventCourses.some(c => c.toLowerCase() === course.toLowerCase())
            || pname.toLowerCase() === course.toLowerCase()
          if (!isEventSale) continue
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
              errors.push(`ردیف ${i + 2}: ${e.message || 'خطا در تخصیص سانس'}`)
            }
          } else {
            didAssign = true
            assigned++
          }
          break
        }
      }
    }

    if (dirty) {
      updated++
      if (!dryRun) {
        try {
          await saveCustomerToDB(customer)
        } catch (e) {
          errors.push(`ردیف ${i + 2}: ${e.message || 'خطا در ذخیره مشتری'}`)
        }
      }
    } else if (!didAssign) {
      skipped++
    }
  }

  return { updated, assigned, skipped, errors }
}
