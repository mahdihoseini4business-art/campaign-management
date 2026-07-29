import { getData, saveFollowupToDB, deleteFollowupFromDB, updateFollowupInDB, saveCustomerToDB } from './data.js'
import { toEnDigits, escapeHtml, escapeAttr, showToast, hasPermission, requirePermission, canViewCustomer, getCurrentUser, normalizePhone, canViewScopedCustomer, matchesTabSearch, getCustomerSearchExtras, getTodayJalaliStr, jalaliToNum, jalaliAddDays, getNowJalaliDateTime } from './utils.js'
import { paginateList, renderPaginationBar } from './pagination.js'

let followupFilter = 'waiting' // waiting | overdue | done

// ============================================
// Classification (based on customer.nextFollowupDate)
// ============================================

function classifyDate(dateStr) {
  if (!dateStr) return null
  const today = getTodayJalaliStr()
  const todayNum = jalaliToNum(today)
  // Normalize Persian digits / datetime strings like "1405/05/07 12:00"
  const dateNum = jalaliToNum(toEnDigits(String(dateStr)).trim().split(/\s+/)[0])
  if (dateNum === 99999999) return null
  if (dateNum < todayNum) return 'overdue'
  // jalaliAddDays already returns numeric YYYYMMDD — do NOT wrap with jalaliToNum
  const threeDaysNum = jalaliAddDays(today, 3)
  if (dateNum <= threeDaysNum) return 'waiting'
  return null
}

function isDoneFollowup(f) {
  if (f.status === 'done') return true
  return f.type === 'پیگیری انجام‌شده' || f.type === 'پیگیری معوقه انجام‌شده'
}

function canSeeCustomer(customer, currentUser) {
  if (!customer) return false
  if (customer.id.startsWith('LD') && !hasPermission('customers_ld')) return false
  if (customer.id.startsWith('CS') && !hasPermission('customers_cs')) return false
  if (!canViewScopedCustomer(customer, currentUser)) return false
  return true
}

/** Pending actionable items = customers with a nextFollowupDate */
function getPendingItems() {
  const data = getData()
  const currentUser = getCurrentUser()
  const search = toEnDigits(document.getElementById('searchFollowups')?.value || '').toLowerCase()

  return data.customers
    .filter(c => c.nextFollowupDate && canSeeCustomer(c, currentUser))
    .map(c => {
      const last = [...data.followups].reverse().find(f => f.customerId === c.id && !isDoneFollowup(f))
      return {
        kind: 'pending',
        customerId: c.id,
        customerName: c.name || c.platformId || c.id,
        date: last?.date || '',
        type: last?.type || '—',
        result: last?.result || '—',
        nextDate: c.nextFollowupDate,
        notes: last?.notes || '',
        category: classifyDate(c.nextFollowupDate)
      }
    })
    .filter(item => {
      if (!item.category) return false
      const extras = getCustomerSearchExtras(data.customers.find(c => c.id === item.customerId))
      return matchesTabSearch(search, [
        item.customerId,
        item.customerName,
        item.notes,
        item.type,
        item.result,
        item.date,
        item.nextDate,
        ...extras.products,
        ...extras.depositors
      ])
    })
}

/** Done items = followup notes marked as completed */
function getDoneItems() {
  const data = getData()
  const currentUser = getCurrentUser()
  const search = toEnDigits(document.getElementById('searchFollowups')?.value || '').toLowerCase()

  return data.followups
    .filter(f => {
      if (!isDoneFollowup(f)) return false
      const customer = data.customers.find(c => c.id === f.customerId)
      if (!canSeeCustomer(customer, currentUser)) return false
      const name = customer ? customer.name : ''
      const extras = getCustomerSearchExtras(customer)
      return matchesTabSearch(search, [
        f.customerId,
        name,
        customer?.phone,
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
    .map(f => {
      const customer = data.customers.find(c => c.id === f.customerId)
      return {
        kind: 'done',
        id: f.id,
        customerId: f.customerId,
        customerName: customer ? customer.name : '—',
        date: f.date,
        type: f.type,
        result: f.result,
        nextDate: f.nextDate || '',
        notes: f.notes || f.doneNote || '',
        wasOverdue: !!f.wasOverdue || f.type === 'پیگیری معوقه انجام‌شده',
        category: 'done'
      }
    })
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
      customer?.phone,
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

// ============================================
// Badge + Stats
// ============================================

export function updateFollowupBadge() {
  const today = getTodayJalaliStr()
  const count = getPendingItems().filter(i => i.nextDate === today).length
  const badge = document.getElementById('followupTabBadge')
  if (badge) {
    badge.textContent = count
    badge.style.display = count > 0 ? 'inline-flex' : 'none'
  }
}

function updateFollowupStats() {
  const pending = getPendingItems()
  const done = getDoneItems()
  const el = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v }
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

export function renderFollowups() {
  const tbody = document.getElementById('followupBody')
  if (!tbody) return

  try {
    updateFollowupStats()
    updateFollowupBadge()

    const pending = getPendingItems()
    const done = getDoneItems()
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
    const today = getTodayJalaliStr()
    const canEdit = hasPermission('followups_add')

    tbody.innerHTML = page.items.map((item) => {
      const selectCell = hasPermission('followups_delete')
        ? (showSelectCol
          ? `<td><input type="checkbox" data-id="${escapeAttr(String(item.id || ''))}" onchange="app.toggleRowSelect('followups', '${escapeAttr(String(item.id || ''))}', this.checked)"></td>`
          : '<td></td>')
        : ''

      const isToday = item.nextDate === today && item.kind === 'pending'
      const rowClass = isToday ? ' class="highlight-today"' : ''

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

      return `<tr${rowClass}>
        ${selectCell}
        <td><span class="id-badge ${item.customerId.startsWith('CS') ? 'id-cs' : 'id-ld'}" style="font-size:11px;cursor:pointer;" onclick="app.openCustomerDetail('${escapeAttr(item.customerId)}')">${escapeHtml(item.customerId)}</span></td>
        <td>${escapeHtml(item.customerName)}${overdueBadge}</td>
        <td style="font-family:'Vazirmatn',sans-serif;font-size:13px;">${escapeHtml(item.date) || '—'}</td>
        <td>${escapeHtml(item.type)}</td>
        <td>${escapeHtml(item.result)}</td>
        <td style="font-size:13px;">${escapeHtml(item.nextDate) || '—'}</td>
        <td class="notes-cell" title="${escapeHtml(item.notes)}">${escapeHtml(item.notes) || '—'}</td>
        <td><div class="actions-cell">${actionBtns}</div></td>
      </tr>`
    }).join('')

    renderPaginationBar('followupPagination', 'followups', page)
  } catch (e) {
    console.error('renderFollowups error:', e)
    tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state"><h3>خطا در نمایش فالوآپ‌ها</h3><p>${escapeHtml(e.message || String(e))}</p></div></td></tr>`
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

  if (!note) { showToast('یادداشت را وارد کنید'); return }

  const customer = data.customers.find(c => c.id === customerId)
  if (!customer) { showToast('مشتری یافت نشد'); return }

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
      nextDate: '',
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

    customer.nextFollowupDate = ''
    await saveCustomerToDB(customer)

    closeFollowupDoneModal()
    renderFollowups()
    showToast('پیگیری انجام شد')
  } catch (e) {
    console.error('confirmFollowupDone error:', e)
    showToast(e.message || 'خطا در ثبت انجام پیگیری')
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
    data.customers.filter(c => canViewCustomer(c)).map(c =>
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
