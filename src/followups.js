import { getData, saveData } from './data.js'
import { toEnDigits, escapeHtml, showToast, hasPermission } from './utils.js'
import { openCustomerDetail } from './customers.js'

// ============================================
// Render Followups
// ============================================

export function renderFollowups() {
  const data = getData()
  const tbody = document.getElementById('followupBody')
  const search = toEnDigits(document.getElementById('searchFollowups').value).toLowerCase()

  const filtered = data.followups.filter(f => {
    const customer = data.customers.find(c => c.id === f.customerId)
    const name = customer ? customer.name : ''
    if (customer) {
      if (customer.id.startsWith('LD') && !hasPermission('customers_ld')) return false
      if (customer.id.startsWith('CS') && !hasPermission('customers_cs')) return false
    }
    return f.customerId.toLowerCase().includes(search) ||
      name.toLowerCase().includes(search) ||
      f.notes.toLowerCase().includes(search)
  })

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="8">
        <div class="empty-state">
          <div class="icon">📋</div>
          <h3>پیگیری‌ای ثبت نشده</h3>
          <p>اولین پیگیری رو ثبت کنید</p>
        </div>
      </td></tr>`
    return
  }

  tbody.innerHTML = filtered.map((f) => {
    const realIndex = data.followups.indexOf(f)
    const customer = data.customers.find(c => c.id === f.customerId)
    const name = customer ? customer.name : '—'

    return `<tr>
      <td><span class="id-badge id-ld" style="font-size:11px;cursor:pointer;" onclick="window.appOpenCustomerDetail('${f.customerId}')">${f.customerId}</span></td>
      <td>${name}</td>
      <td style="font-family:monospace;font-size:13px;">${f.date}</td>
      <td>${f.type}</td>
      <td>${f.result}</td>
      <td style="font-size:13px;">${f.nextDate || '—'}</td>
      <td class="notes-cell" title="${escapeHtml(f.notes)}">${f.notes || '—'}</td>
      <td>
        <div class="actions-cell">
          <button class="btn-icon" title="ویرایش" onclick="window.appEditFollowup(${realIndex})">✏</button>
          <button class="btn-icon" title="حذف" onclick="window.appDeleteFollowup(${realIndex})">🗑</button>
        </div>
      </td>
    </tr>`
  }).join('')
}

// ============================================
// Followup Modal
// ============================================

export function openFollowupModal(editIndex) {
  const data = getData()
  const modal = document.getElementById('followupModal')
  const title = document.getElementById('followupModalTitle')
  const select = document.getElementById('followupCustomer')

  select.innerHTML = '<option value="">انتخاب کنید...</option>' +
    data.customers.map(c =>
      `<option value="${c.id}">${c.id} — ${c.name || c.platformId}</option>`
    ).join('')

  if (editIndex !== undefined) {
    const f = data.followups[editIndex]
    if (!f) return
    title.textContent = 'ویرایش پیگیری'
    document.getElementById('editFollowupIndex').value = editIndex
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

export function saveFollowup() {
  const data = getData()
  const editIndex = document.getElementById('editFollowupIndex').value
  const customerId = document.getElementById('followupCustomer').value
  const date = document.getElementById('followupDate').value.trim()
  const nextDate = document.getElementById('followupNextDate').value.trim()
  const type = document.getElementById('followupType').value
  const result = document.getElementById('followupResult').value
  const notes = document.getElementById('followupNotes').value.trim()

  if (!customerId) { showToast('مشتری را انتخاب کنید'); return }
  if (!date) { showToast('تاریخ پیگیری را وارد کنید'); return }

  if (editIndex !== '') {
    data.followups[parseInt(editIndex)] = { customerId, date, nextDate, type, result, notes }
  } else {
    data.followups.push({ customerId, date, nextDate, type, result, notes })
  }

  saveData()
  renderFollowups()
  closeFollowupModal()
  showToast(editIndex !== '' ? 'پیگیری ویرایش شد' : 'پیگیری جدید ثبت شد')
}

export function editFollowup(index) {
  openFollowupModal(index)
}

export function deleteFollowup(index) {
  const data = getData()
  const f = data.followups[index]
  document.getElementById('deleteMessage').textContent =
    `آیا از حذف پیگیری ${f.customerId} در تاریخ ${f.date} مطمئن هستید؟`
  document.getElementById('deleteConfirmBtn').onclick = function () {
    data.followups.splice(index, 1)
    saveData()
    renderFollowups()
    closeDeleteModal()
    showToast('پیگیری حذف شد')
  }
  document.getElementById('deleteModal').classList.add('active')
}

function closeDeleteModal() {
  document.getElementById('deleteModal').classList.remove('active')
}
