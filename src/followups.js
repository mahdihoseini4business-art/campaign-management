import { getData, saveFollowupToDB, deleteFollowupFromDB, updateFollowupInDB, markFollowupDoneInDB } from './data.js'
import { toEnDigits, escapeHtml, escapeAttr, showToast, hasPermission, requirePermission, canViewCustomer, canManageCustomer, getCurrentUser, normalizePhone, canViewScopedCustomer, matchesTabSearch, getCustomerSearchExtras, getTodayJalaliStr, jalaliToNum, jalaliAddDays, jalaliDiffDays, getNowJalaliDateTime } from './utils.js'
import { paginateList, renderPaginationBar } from './pagination.js'
import { openCustomerDetail } from './customers.js'

let followupFilter = 'waiting' // waiting | overdue | done

// ============================================
// Filter classification helpers
// ============================================

function classifyFollowup(f) {
  if (f.status === 'done') return 'done'
  const today = getTodayJalaliStr()
  const todayNum = jalaliToNum(today)
  const nextNum = jalaliToNum(f.nextDate)
  if (nextNum === 99999999) return 'waiting'
  const threeDaysLater = jalaliAddDays(today, 3)
  const threeDaysNum = jalaliToNum(threeDaysLater)
  if (nextNum < todayNum) return 'overdue'
  if (nextNum <= threeDaysNum) return 'waiting'
  return 'waiting'
}

function isFollowupToday(f) {
  return f.nextDate === getTodayJalaliStr()
}

// ============================================
// Badge
// ============================================

export function updateFollowupBadge() {
  const data = getData()
  const currentUser = getCurrentUser()
  const today = getTodayJalaliStr()
  const count = data.followups.filter(f => {
    if (f.status === 'done') return false
    if (f.nextDate !== today) return false
    const customer = data.customers.find(c => c.id === f.customerId)
    if (!customer) return false
    if (customer.id.startsWith('LD') && !hasPermission('customers_ld')) return false
    if (customer.id.startsWith('CS') && !hasPermission('customers_cs')) return false
    if (!canViewScopedCustomer(customer, currentUser)) return false
    return true
  }).length

  const badge = document.getElementById('followupTabBadge')
  if (badge) {
    badge.textContent = count
    badge.style.display = count > 0 ? 'inline-flex' : 'none'
  }
}

// ============================================
// Stats
// ============================================

function updateFollowupStats(filtered) {
  let waiting = 0, done = 0, overdue = 0
  filtered.forEach(f => {
    const cat = classifyFollowup(f)
    if (cat === 'waiting') waiting++
    else if (cat === 'done') done++
    else if (cat === 'overdue') overdue++
  })
  const el = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v }
  el('stat-followup-waiting', waiting)
  el('stat-followup-done', done)
  el('stat-followup-overdue', overdue)
}

// ============================================
// Filter
// ============================================

export function setFollowupFilter(filter) {
  followupFilter = filter
  document.querySelectorAll('.followup-filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter)
  })
  renderFollowups()
}

// ============================================
// Render Followups
// ============================================

export function getFilteredFollowups() {
  const data = getData()
  const search = toEnDigits(document.getElementById('searchFollowups')?.value || '').toLowerCase()
  const currentUser = getCurrentUser()

  return data.followups.filter(f => {
    const customer = data.customers.find(c => c.id === f.customerId)
    const name = customer ? customer.name : ''
    if (customer) {
      if (customer.id.startsWith('LD') && !hasPermission('customers_ld')) return false
      if (customer.id.startsWith('CS') && !hasPermission('customers_cs')) return false
      if (!canViewScopedCustomer(customer, currentUser)) return false
    }
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

export function renderFollowups() {
  const data = getData()
  const tbody = document.getElementById('followupBody')
  const allFiltered = getFilteredFollowups()

  updateFollowupStats(allFiltered)
  updateFollowupBadge()

  const filtered = allFiltered.filter(f => classifyFollowup(f) === followupFilter)

  const showSelectCol = hasPermission('followups_delete')
  const colCount = showSelectCol ? 10 : 9

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

  const search = toEnDigits(document.getElementById('searchFollowups').value).toLowerCase()
  const page = paginateList('followups', filtered, search)
  const today = getTodayJalaliStr()

  tbody.innerHTML = page.items.map((f) => {
    const customer = data.customers.find(c => c.id === f.customerId)
    const name = customer ? customer.name : '—'
    const followupId = f.id || `idx_${data.followups.indexOf(f)}`
    const canEdit = hasPermission('followups_add')
    const canDelete = showSelectCol
    const selectCell = showSelectCol
      ? `<td><input type="checkbox" data-id="${escapeAttr(followupId)}" onchange="app.toggleRowSelect('followups', '${escapeAttr(followupId)}', this.checked)"></td>`
      : ''

    const isToday = f.nextDate === today
    const rowClass = (isToday && f.status !== 'done') ? ' class="highlight-today"' : ''
    const isDone = f.status === 'done'

    let actionBtns = ''
    if (!isDone) {
      actionBtns += `<button class="btn btn-sm btn-done" title="انجام شد" onclick="app.openFollowupDoneModal('${escapeAttr(followupId)}')">✓ انجام شد</button>`
    }
    if (canEdit && !isDone) {
      actionBtns += ` <button class="btn-icon" title="ویرایش" onclick="app.editFollowup('${escapeAttr(followupId)}')">✏</button>`
    }
    if (canDelete) {
      actionBtns += ` <button class="btn-icon" title="حذف" onclick="app.deleteFollowup('${escapeAttr(followupId)}')">🗑</button>`
    }

    return `<tr${rowClass}>
      ${selectCell}
      <td><span class="id-badge ${f.customerId.startsWith('CS') ? 'id-cs' : 'id-ld'}" style="font-size:11px;cursor:pointer;" onclick="app.openCustomerDetail('${escapeAttr(f.customerId)}')">${escapeHtml(f.customerId)}</span></td>
      <td>${escapeHtml(name)}</td>
      <td style="font-family:'Vazirmatn',sans-serif;font-size:13px;">${escapeHtml(f.date)}</td>
      <td>${escapeHtml(f.type)}</td>
      <td>${escapeHtml(f.result)}</td>
      <td style="font-size:13px;">${escapeHtml(f.nextDate) || '—'}</td>
      <td class="notes-cell" title="${escapeHtml(f.notes)}">${escapeHtml(f.notes) || '—'}</td>
      <td>
        <div class="actions-cell">${actionBtns}</div>
      </td>
    </tr>`
  }).join('')

  renderPaginationBar('followupPagination', 'followups', page)
}

// ============================================
// Done Modal
// ============================================

export function openFollowupDoneModal(followupId) {
  if (!requirePermission('followups_add')) return
  const data = getData()
  const f = data.followups.find(x => String(x.id) === String(followupId) || `idx_${data.followups.indexOf(x)}` === followupId)
  if (!f) { showToast('پیگیری یافت نشد'); return }

  const customer = data.customers.find(c => c.id === f.customerId)
  const name = customer ? customer.name : f.customerId
  const cat = classifyFollowup(f)

  document.getElementById('followupDoneId').value = followupId
  document.getElementById('followupDoneNote').value = ''
  document.getElementById('followupDoneInfo').innerHTML = `
    <div><strong>مشتری:</strong> ${escapeHtml(name)} (${escapeHtml(f.customerId)})</div>
    <div><strong>تاریخ پیگیری:</strong> ${escapeHtml(f.nextDate || f.date)}</div>
    <div><strong>نوع:</strong> ${escapeHtml(f.type)}</div>
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
  const followupId = document.getElementById('followupDoneId').value
  const note = document.getElementById('followupDoneNote').value.trim()

  if (!note) { showToast('یادداشت را وارد کنید'); return }

  const f = data.followups.find(x => String(x.id) === String(followupId) || `idx_${data.followups.indexOf(x)}` === followupId)
  if (!f) { showToast('پیگیری یافت نشد'); return }

  const cat = classifyFollowup(f)
  const wasOverdue = cat === 'overdue'
  const { dateTime } = getNowJalaliDateTime()
  const currentUser = getCurrentUser()
  const doneByPhone = normalizePhone(currentUser?.phone || '')

  try {
    await markFollowupDoneInDB(f.id, { doneAt: dateTime, doneByPhone, doneNote: note, wasOverdue })

    f.status = 'done'
    f.doneAt = dateTime
    f.doneByPhone = doneByPhone
    f.doneNote = note
    f.wasOverdue = wasOverdue

    const noteType = wasOverdue ? 'پیگیری معوقه انجام‌شده' : 'پیگیری انجام‌شده'
    const today = getTodayJalaliStr()
    const noteFollowup = {
      customerId: f.customerId,
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

    closeFollowupDoneModal()
    renderFollowups()
    showToast('پیگیری انجام شد')
  } catch (e) {
    console.error('confirmFollowupDone error:', e)
    showToast('خطا در ثبت انجام پیگیری')
  }
}

// ============================================
// Followup Modal (Add/Edit)
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
      showToast('خطا در ذخیره پیگیری')
      return
    }
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
