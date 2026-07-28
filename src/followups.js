import { getData, saveFollowupToDB, deleteFollowupFromDB, updateFollowupInDB } from './data.js'
import { toEnDigits, escapeHtml, escapeAttr, showToast, hasPermission, requirePermission, canViewCustomer, canManageCustomer, getCurrentUser, normalizePhone, canViewScopedCustomer, matchesTabSearch, getCustomerSearchExtras } from './utils.js'
import { paginateList, renderPaginationBar } from './pagination.js'
import { openCustomerDetail } from './customers.js'

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
  const search = toEnDigits(document.getElementById('searchFollowups').value).toLowerCase()
  const filtered = getFilteredFollowups()

  const showSelectCol = hasPermission('followups_delete')
  const colCount = showSelectCol ? 9 : 8

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="${colCount}">
        <div class="empty-state">
          <div class="icon">📋</div>
          <h3>پیگیری‌ای ثبت نشده</h3>
          <p>اولین پیگیری رو ثبت کنید</p>
        </div>
      </td></tr>`
    renderPaginationBar('followupPagination', 'followups', { total: 0, from: 0, to: 0, page: 1, totalPages: 1 })
    return
  }

  const page = paginateList('followups', filtered, search)

  tbody.innerHTML = page.items.map((f) => {
    const customer = data.customers.find(c => c.id === f.customerId)
    const name = customer ? customer.name : '—'
    const followupId = f.id || `idx_${data.followups.indexOf(f)}`
    const canEdit = hasPermission('followups_add')
    const canDelete = showSelectCol
    const selectCell = showSelectCol
      ? `<td><input type="checkbox" data-id="${escapeAttr(followupId)}" onchange="app.toggleRowSelect('followups', '${escapeAttr(followupId)}', this.checked)"></td>`
      : ''

    return `<tr>
      ${selectCell}
      <td><span class="id-badge ${f.customerId.startsWith('CS') ? 'id-cs' : 'id-ld'}" style="font-size:11px;cursor:pointer;" onclick="app.openCustomerDetail('${escapeAttr(f.customerId)}')">${escapeHtml(f.customerId)}</span></td>
      <td>${escapeHtml(name)}</td>
      <td style="font-family:'Vazirmatn',sans-serif;font-size:13px;">${escapeHtml(f.date)}</td>
      <td>${escapeHtml(f.type)}</td>
      <td>${escapeHtml(f.result)}</td>
      <td style="font-size:13px;">${escapeHtml(f.nextDate) || '—'}</td>
      <td class="notes-cell" title="${escapeHtml(f.notes)}">${escapeHtml(f.notes) || '—'}</td>
      <td>
        <div class="actions-cell">
          ${canEdit ? `<button class="btn-icon" title="ویرایش" onclick="app.editFollowup('${escapeAttr(followupId)}')">✏</button>` : ''}
          ${canDelete ? `<button class="btn-icon" title="حذف" onclick="app.deleteFollowup('${escapeAttr(followupId)}')">🗑</button>` : ''}
        </div>
      </td>
    </tr>`
  }).join('')

  renderPaginationBar('followupPagination', 'followups', page)
}

// ============================================
// Followup Modal
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
    const newFollowup = { customerId, date, nextDate, type, result, notes, createdByPhone: normalizePhone(getCurrentUser()?.phone || '') }
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
