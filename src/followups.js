import { getData, saveFollowupToDB, deleteFollowupFromDB, updateFollowupInDB, saveCustomerToDB } from './data.js'
import { getUsersSafe } from './auth.js'
import { toEnDigits, escapeHtml, escapeAttr, showToast, hasPermission, requirePermission, canViewCustomer, canAddNoteOnCustomer, getCurrentUser, normalizePhone, ownsCustomer, canViewOrgWideData, matchesTabSearch, getCustomerSearchExtras, getTodayJalaliStr, jalaliToNum, jalaliAddDays, getNowJalaliDateTime, getCustomerPhones, formatPhonesDisplay, userDisplayName } from './utils.js'
import { paginateList, renderPaginationBar } from './pagination.js'

let followupFilter = 'today' // today | waiting | overdue | done

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

function canSeeCustomer(customer, currentUser) {
  if (!customer) return false
  if (customer.id.startsWith('LD') && !hasPermission('customers_ld')) return false
  if (customer.id.startsWith('CS') && !hasPermission('customers_cs')) return false
  // Follow-ups tab: only the current user's own customers (not subordinates).
  // Admin / accounting keep org-wide visibility.
  if (canViewOrgWideData(currentUser)) return true
  return ownsCustomer(customer, currentUser)
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

  const items = []
  for (const c of data.customers) {
    if (!c.nextFollowupDate) continue
    if (!canSeeCustomer(c, currentUser)) continue
    const category = classifyDate(c.nextFollowupDate)
    if (!category) continue

    const last = [...data.followups].reverse().find(f => f.customerId === c.id && !isDoneFollowup(f))
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
      notes: last?.notes || '',
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
  return items
}

/** Done items = followup notes marked as completed */
function getDoneItems(applySearch = true) {
  const data = getData()
  const currentUser = getCurrentUser()
  const search = applySearch
    ? toEnDigits(document.getElementById('searchFollowups')?.value || '').toLowerCase()
    : ''

  const items = []
  for (const f of data.followups) {
    if (!isDoneFollowup(f)) continue
    const customer = data.customers.find(c => c.id === f.customerId)
    if (!canSeeCustomer(customer, currentUser)) continue

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
      wasOverdue: !!f.wasOverdue || f.type === 'پیگیری معوقه انجام‌شده',
      category: 'done'
    })
  }
  return items
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

/** All in-scope followups for export (ignores search box so backup is complete). */
export function getFollowupsForExport() {
  const data = getData()
  const currentUser = getCurrentUser()
  return data.followups
    .filter(f => {
      const customer = data.customers.find(c => c.id === f.customerId)
      if (customer) return canSeeCustomer(customer, currentUser)
      // Orphan notes: include for org-wide roles only
      return canViewOrgWideData(currentUser)
    })
    .slice()
    .sort((a, b) => {
      const idCmp = String(a.customerId || '').localeCompare(String(b.customerId || ''))
      if (idCmp) return idCmp
      const dCmp = String(a.date || '').localeCompare(String(b.date || ''))
      if (dCmp) return dCmp
      return String(a.id || '').localeCompare(String(b.id || ''))
    })
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

// ============================================
// Render
// ============================================

export async function renderFollowups() {
  const tbody = document.getElementById('followupBody')
  if (!tbody) return

  try {
    updateFollowupStats()
    updateFollowupBadge()

    const pending = getPendingItems(true)
    const done = getDoneItems(true)
    const filtered = followupFilter === 'done'
      ? done
      : pending.filter(i => i.category === followupFilter)

    const showSelectCol = hasPermission('followups_delete') && followupFilter === 'done'
    const colCount = (hasPermission('followups_delete') ? 1 : 0) + 9

    if (filtered.length === 0) {
      tbody.innerHTML = `
        <tr><td colspan="${colCount}">
          <div class="empty-state">
            <div class="icon">📋</div>
            <h3>پیگیری‌ای یافت نشد</h3>
            <p>در این بخش پیگیری‌ای وجود ندارد</p>
          </div>
        </td></tr>`
      renderPaginationBar('followupPagination', 'followups', { total: 0, from: 0, to: 0, page: 1, totalPages: 1 })
      return
    }

    const search = toEnDigits(document.getElementById('searchFollowups')?.value || '').toLowerCase()
    const page = paginateList('followups', filtered, `${followupFilter}|${search}`)
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

      let actionBtns = ''
      if (item.kind === 'pending') {
        actionBtns += `<button class="btn btn-sm btn-done" title="انجام شد" onclick="app.openFollowupDoneModal('${escapeAttr(item.customerId)}')">✓ انجام شد</button>`
      } else {
        if (canEdit) {
          actionBtns += `<button class="btn-icon" title="ویرایش" onclick="app.editFollowup('${escapeAttr(String(item.id))}')">✏</button>`
        }
        if (hasPermission('followups_delete')) {
          actionBtns += ` <button class="btn-icon" title="حذف" onclick="app.deleteFollowup('${escapeAttr(String(item.id))}')">🗑</button>`
        }
      }

      const overdueBadge = item.wasOverdue ? ' <span class="overdue-tag">معوقه</span>' : ''
      const phoneExtra = item.customerPhoneExtra > 0
        ? ` <span style="color:var(--text-muted);font-size:11px;">+${item.customerPhoneExtra}</span>`
        : ''
      const phoneHtml = item.customerPhone
        ? `${escapeHtml(item.customerPhone)}${phoneExtra}`
        : '—'

      const setterName = item.setByOther ? (nameByPhone(item.createdByPhone) || item.createdByPhone) : ''
      const setterBadge = setterName
        ? ` <span style="display:inline-block;margin-top:2px;font-size:11px;color:var(--text-muted);">از: ${escapeHtml(setterName)}</span>`
        : ''
      const notesHtml = item.notes
        ? `${escapeHtml(item.notes)}${setterBadge}`
        : (setterBadge || '—')

      return `<tr class="clickable-row" onclick="app.onCustomerRowClick(event, '${escapeAttr(item.customerId)}')">
        ${selectCell}
        <td>${escapeHtml(item.customerName)}${overdueBadge}</td>
        <td style="direction:ltr;text-align:right;font-family:'Vazirmatn',sans-serif;font-size:13px;">${phoneHtml}</td>
        <td style="font-size:12px;">${escapeHtml(item.advisor) || '—'}</td>
        <td style="font-family:'Vazirmatn',sans-serif;font-size:13px;">${escapeHtml(item.date) || '—'}</td>
        <td>${escapeHtml(item.type)}</td>
        <td>${escapeHtml(item.result)}</td>
        <td style="font-size:13px;">${escapeHtml(item.nextDate) || '—'}</td>
        <td class="notes-cell" title="${escapeHtml(item.notes)}">${notesHtml}</td>
        <td><div class="actions-cell">${actionBtns}</div></td>
      </tr>`
    }).join('')

    renderPaginationBar('followupPagination', 'followups', page)
  } catch (e) {
    console.error('renderFollowups error:', e)
    tbody.innerHTML = `<tr><td colspan="10"><div class="empty-state"><h3>خطا در نمایش فالوآپ‌ها</h3><p>${escapeHtml(e.message || String(e))}</p></div></td></tr>`
  }
}

// ============================================
// Done Modal (customerId-based)
// ============================================

export function openFollowupDoneModal(customerId) {
  if (!requirePermission('followups_add')) return
  const data = getData()
  const customer = data.customers.find(c => c.id === customerId)
  if (!customer) { showToast('مشتری یافت نشد'); return }

  const cat = classifyDate(customer.nextFollowupDate)
  const name = customer.name || customer.platformId || customerId

  document.getElementById('followupDoneId').value = customerId
  document.getElementById('followupDoneNote').value = ''
  const nextDateEl = document.getElementById('followupDoneNextDate')
  if (nextDateEl) nextDateEl.value = ''
  document.getElementById('followupDoneInfo').innerHTML = `
    <div><strong>مشتری:</strong> ${escapeHtml(name)} (${escapeHtml(customerId)})</div>
    <div><strong>تاریخ پیگیری:</strong> ${escapeHtml(customer.nextFollowupDate || '—')}</div>
    ${cat === 'overdue' ? '<div style="color:var(--danger);font-weight:600;">⚠ این پیگیری معوقه است</div>' : ''}
  `
  document.getElementById('followupDoneModal').classList.add('active')
  document.getElementById('followupDoneNote').focus()
}

export function closeFollowupDoneModal() {
  document.getElementById('followupDoneModal').classList.remove('active')
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
  const today = getTodayJalaliStr()
  const noteType = wasOverdue ? 'پیگیری معوقه انجام‌شده' : 'پیگیری انجام‌شده'

  try {
    const noteFollowup = {
      customerId,
      date: today,
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
    showToast(nextDate ? 'پیگیری انجام شد و پیگیری بعدی تنظیم شد' : 'پیگیری انجام شد')
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

  select.innerHTML = '<option value="">انتخاب کنید...</option>' +
    data.customers.filter(c => canAddNoteOnCustomer(c)).map(c =>
      `<option value="${c.id}">${c.id} — ${escapeHtml(c.name || c.platformId)}</option>`
    ).join('')

  if (editFollowupId) {
    const f = data.followups.find(x => String(x.id) === String(editFollowupId) || `idx_${data.followups.indexOf(x)}` === editFollowupId)
    if (!f) return
    title.textContent = 'ویرایش پیگیری'
    document.getElementById('editFollowupIndex').value = editFollowupId
    select.value = f.customerId
    document.getElementById('followupDate').value = f.date
    document.getElementById('followupNextDate').value = f.nextDate
    document.getElementById('followupType').value = f.type
    document.getElementById('followupResult').value = f.result
    document.getElementById('followupNotes').value = f.notes
  } else {
    title.textContent = 'پیگیری جدید'
    document.getElementById('editFollowupIndex').value = ''
    select.value = ''
    document.getElementById('followupDate').value = ''
    document.getElementById('followupNextDate').value = ''
    document.getElementById('followupType').value = 'دایرکت'
    document.getElementById('followupResult').value = 'پاسخ داد'
    document.getElementById('followupNotes').value = ''
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
  const date = document.getElementById('followupDate').value.trim()
  const nextDate = document.getElementById('followupNextDate').value.trim()
  const type = document.getElementById('followupType').value
  const result = document.getElementById('followupResult').value
  const notes = document.getElementById('followupNotes').value.trim()

  if (!customerId) { showToast('مشتری را انتخاب کنید'); return }
  if (!date) { showToast('تاریخ پیگیری را وارد کنید'); return }

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
  showToast(editFollowupId ? 'پیگیری ویرایش شد' : 'پیگیری جدید ثبت شد')
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
