import { getData, saveCustomerToDB, deleteCustomerFromDB, saveFollowupToDB, deleteFollowupFromDB, updateFollowupsCustomerId, saveSetting, generateId } from './data.js'
import { getUsers } from './auth.js'
import { toEnDigits, escapeHtml, showToast, hasPermission, getCurrentUser, formatNumber, jalaliToNum, getTodayJalaliStr, getTodayJalaliNum, jalaliAddDays } from './utils.js'

const STATUS_LABELS = { new: 'جدید', contacted: 'تماس گرفته', chatting: 'در حال چت', interested: 'علاقه‌مند', sent: 'اطلاعات ارسال', followup_done: 'تکمیل پیگیری', converting: 'در حال تبدیل', purchased: 'خرید کرد', cancelled: 'منصرف شده' }
const PLATFORM_LABELS = { instagram: 'اینستاگرام', telegram: 'تلگرام', whatsapp: 'واتساپ' }
const PLATFORM_CLASSES = { instagram: 'platform-ig', telegram: 'platform-tg', whatsapp: 'platform-wa' }
const STATUS_CLASSES = { new: 'status-new', contacted: 'status-contacted', chatting: 'status-chatting', interested: 'status-interested', sent: 'status-sent', followup_done: 'status-followup_done', converting: 'status-converting', purchased: 'status-purchased', cancelled: 'status-cancelled' }

// ============================================
// Render Customers
// ============================================

export async function renderCustomers() {
  const data = getData()
  const tbody = document.getElementById('customerBody')
  if (!tbody) return
  const search = toEnDigits(document.getElementById('searchCustomers').value).toLowerCase()
  const advisorFilter = document.getElementById('filterAdvisor').value

  // Render customers immediately (don't wait for users)
  const filtered = data.customers.filter(c => {
    if (!c.id.toLowerCase().includes(search) &&
      !c.name.toLowerCase().includes(search) &&
      !(c.platformId || '').toLowerCase().includes(search) &&
      !(c.phone || '').includes(search)) return false
    const isCS = c.id.startsWith('CS')
    const isLD = c.id.startsWith('LD')
    if (isCS && !hasPermission('customers_cs')) return false
    if (isLD && !hasPermission('customers_ld')) return false
    if (advisorFilter && (c.advisor || '') !== advisorFilter) return false
    return true
  })

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="12">
        <div class="empty-state">
          <div class="icon">👤</div>
          <h3>مشتری‌ای یافت نشد</h3>
          <p>مشتری جدید اضافه کنید</p>
        </div>
      </td></tr>`
    updateStats()
    // Still update advisor dropdown in background
    updateAdvisorDropdown()
    return
  }

  tbody.innerHTML = filtered.map(c => {
    const idClass = c.id.startsWith('CS') ? 'id-cs' : 'id-ld'
    const platformClass = PLATFORM_CLASSES[c.platform] || ''
    const platformLabel = PLATFORM_LABELS[c.platform] || c.platform
    const statusClass = STATUS_CLASSES[c.status] || 'status-new'
    const statusLabel = STATUS_LABELS[c.status] || c.status

    const platformUrl = c.platform === 'instagram' ? `https://instagram.com/${encodeURIComponent(c.platformId)}`
      : c.platform === 'telegram' ? `https://telegram.me/${encodeURIComponent(c.platformId)}`
        : c.platform === 'whatsapp' ? `https://wa.me/${encodeURIComponent(c.phone || c.platformId)}`
          : ''
    const platformIdHtml = platformUrl
      ? `<a href="${platformUrl}" target="_blank" rel="noopener" style="font-family:monospace;font-size:13px;color:var(--accent);text-decoration:none;border-bottom:1px dashed var(--accent);">${escapeHtml(c.platformId)}</a>`
      : `<span style="font-family:monospace;font-size:13px;">${escapeHtml(c.platformId)}</span>`

    const followupCount = data.followups.filter(f => f.customerId === c.id).length
    let countClass = 'followup-none'
    if (followupCount >= 5) countClass = 'followup-high'
    else if (followupCount >= 3) countClass = 'followup-mid'
    else if (followupCount >= 1) countClass = 'followup-low'

    const customerFollowups = data.followups.filter(f => f.customerId === c.id)
    const lastDate = customerFollowups.length > 0
      ? customerFollowups[customerFollowups.length - 1].date
      : '—'
    const lastNote = customerFollowups.length > 0
      ? customerFollowups[customerFollowups.length - 1].notes
      : ''

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
        nextFollowupHtml = `<span style="font-family:monospace;font-size:13px;">${c.nextFollowupDate}</span>`
      }
    }

    return `<tr class="${nextFollowupClass}">
      <td><span class="id-badge ${idClass}">${escapeHtml(c.id)}</span></td>
      <td>${platformIdHtml}</td>
      <td><span class="platform-icon"><span class="platform-dot ${platformClass}"></span>${escapeHtml(platformLabel)}</span></td>
      <td>${escapeHtml(c.name) || '<span style="color:var(--text-muted)">—</span>'}</td>
      <td style="font-family: monospace; direction: ltr; text-align: right;">${escapeHtml(c.phone) || '<span style="color:var(--text-muted)">—</span>'}</td>
      <td><span class="status-badge ${statusClass}">${escapeHtml(statusLabel)}</span></td>
      <td style="font-size:12px;">${escapeHtml(c.advisor) || '<span style="color:var(--text-muted)">—</span>'}</td>
      <td style="text-align:center;"><span class="followup-count ${countClass}">${followupCount}</span></td>
      <td style="font-size:13px;color:var(--text-muted);">${escapeHtml(lastDate)}</td>
      <td style="font-size:12px;">${nextFollowupHtml}</td>
      <td class="notes-cell" title="${escapeHtml(lastNote || c.notes)}">${escapeHtml(lastNote || c.notes) || '<span style="color:var(--text-muted)">—</span>'}</td>
      <td>
        <div class="actions-cell">
          <button class="btn-icon" title="پنل مشتری" onclick="window.appOpenCustomerDetail('${c.id}')" style="color:var(--accent);">👤</button>
          <button class="btn-icon" title="ویرایش" onclick="window.appEditCustomer('${c.id}')">✏</button>
          <button class="btn-icon" title="حذف" onclick="window.appDeleteCustomer('${c.id}')">🗑</button>
        </div>
      </td>
    </tr>`
  }).join('')

  updateStats()
  // Update advisor dropdown in background (non-blocking)
  updateAdvisorDropdown()
}

async function updateAdvisorDropdown() {
  const advisorSelect = document.getElementById('filterAdvisor')
  if (!advisorSelect) return
  const currentVal = advisorSelect.value
  let users = []
  try { users = await getUsers() } catch (e) { console.error('getUsers error:', e) }
  advisorSelect.innerHTML = '<option value="">همه کارشناسان</option>' + users.map(u => `<option value="${escapeHtml(u.display_name)}">${escapeHtml(u.display_name)}</option>`).join('')
  advisorSelect.value = currentVal
}

export function updateStats() {
  const data = getData()
  document.getElementById('stat-total').textContent = data.customers.filter(c => {
    if (c.id.startsWith('LD') && !hasPermission('customers_ld')) return false
    if (c.id.startsWith('CS') && !hasPermission('customers_cs')) return false
    return true
  }).length
  document.getElementById('stat-ld').textContent = data.customers.filter(c => c.id.startsWith('LD') && hasPermission('customers_ld')).length
  document.getElementById('stat-cs').textContent = data.customers.filter(c => c.id.startsWith('CS') && hasPermission('customers_cs')).length
  document.getElementById('stat-following').textContent = data.customers.filter(c => {
    if (c.id.startsWith('LD') && !hasPermission('customers_ld')) return false
    if (c.id.startsWith('CS') && !hasPermission('customers_cs')) return false
    return data.followups.some(f => f.customerId === c.id)
  }).length
  document.getElementById('stat-converted').textContent = data.convertedCount || 0

  let totalPaid = 0
  data.customers.forEach(c => {
    if (c.id.startsWith('LD') && !hasPermission('customers_ld')) return
    if (c.id.startsWith('CS') && !hasPermission('customers_cs')) return
    if (c.products) {
      c.products.forEach(p => {
        const price = parseFloat(p.price) || 0
        const deposit = parseFloat(p.deposit) || 0
        if (p.status === 'تکمیل') {
          totalPaid += price
        } else if (p.status === 'بیعانه') {
          totalPaid += deposit
        }
      })
    }
  })
  document.getElementById('stat-revenue').textContent = formatNumber(totalPaid) + ' ریال'
}

// ============================================
// Customer Modal
// ============================================

export async function openCustomerModal(editId) {
  const data = getData()
  const modal = document.getElementById('customerModal')
  const title = document.getElementById('customerModalTitle')
  const currentUser = getCurrentUser()
  const users = await getUsers()
  const advisorSelect = document.getElementById('customerAdvisor')
  advisorSelect.innerHTML = users.map(u => `<option value="${escapeHtml(u.display_name)}">${escapeHtml(u.display_name)}</option>`).join('')

  if (editId) {
    const c = data.customers.find(x => x.id === editId)
    if (!c) return
    title.textContent = 'ویرایش مشتری'
    document.getElementById('editCustomerId').value = c.id
    document.getElementById('customerIdDisplay').value = c.id
    document.getElementById('customerIdHint').textContent = c.id.startsWith('CS') ? 'مشتری با شماره تماس' : 'لید بدون شماره تماس'
    document.getElementById('customerPlatformId').value = c.platformId
    document.getElementById('customerPlatform').value = c.platform
    document.getElementById('customerName').value = c.name
    document.getElementById('customerPhone').value = c.phone
    document.getElementById('customerStatus').value = c.status
    document.getElementById('customerNotes').value = c.notes
    advisorSelect.value = c.advisor || (currentUser ? currentUser.displayName : '')
  } else {
    title.textContent = 'مشتری جدید'
    document.getElementById('editCustomerId').value = ''
    document.getElementById('customerIdHint').textContent = 'خودکار — LD اگر شماره نداشته باشد، CS اگر داشته باشد'
    document.getElementById('customerPlatformId').value = ''
    document.getElementById('customerPlatform').value = 'instagram'
    document.getElementById('customerName').value = ''
    document.getElementById('customerPhone').value = ''
    document.getElementById('customerStatus').value = 'new'
    document.getElementById('customerNotes').value = ''
    advisorSelect.value = currentUser ? currentUser.displayName : ''
    updatePreviewId()
  }

  modal.classList.add('active')
  document.getElementById('customerPlatformId').focus()
}

function updatePreviewId() {
  if (document.getElementById('editCustomerId').value) return
  const phone = document.getElementById('customerPhone').value.trim()
  const type = phone ? 'CS' : 'LD'
  document.getElementById('customerIdDisplay').value = generateId(type)
  document.getElementById('customerIdHint').textContent = phone
    ? 'شماره وارد شد → مشتری (CS)'
    : 'بدون شماره → لید (LD)'
}

export function closeCustomerModal() {
  document.getElementById('customerModal').classList.remove('active')
}

export async function saveCustomer() {
  const data = getData()
  const editId = document.getElementById('editCustomerId').value
  const platformId = document.getElementById('customerPlatformId').value.trim()
  const platform = document.getElementById('customerPlatform').value
  const name = document.getElementById('customerName').value.trim()
  const phone = document.getElementById('customerPhone').value.trim()
  const status = document.getElementById('customerStatus').value
  const notes = document.getElementById('customerNotes').value.trim()
  const advisor = document.getElementById('customerAdvisor').value

  if (!editId) {
    const existById = platformId && data.customers.find(c => c.platformId && c.platformId.toLowerCase() === platformId.toLowerCase())
    const existByPhone = phone && data.customers.find(c => c.phone && c.phone === phone)

    if (existById) {
      openCustomerDetail(existById.id)
      showToast(`این ایدی قبلاً ثبت شده — پنل مشتری ${existById.id} باز شد`)
      return
    }
    if (existByPhone) {
      openCustomerDetail(existByPhone.id)
      showToast(`این شماره قبلاً ثبت شده — پنل مشتری ${existByPhone.id} باز شد`)
      return
    }

    const type = phone ? 'CS' : 'LD'
    const id = generateId(type)
    data.customers.push({ id, platformId, platform, name, phone, status, notes, advisor, products: [] })
  } else {
    const dupById = platformId && data.customers.find(c => c.id !== editId && c.platformId && c.platformId.toLowerCase() === platformId.toLowerCase())
    const dupByPhone = phone && data.customers.find(c => c.id !== editId && c.phone && c.phone === phone)

    if (dupById) { showToast(`این ایدی متعلق به مشتری ${dupById.id} است`); return }
    if (dupByPhone) { showToast(`این شماره متعلق به مشتری ${dupByPhone.id} است`); return }

    const idx = data.customers.findIndex(c => c.id === editId)
    if (idx !== -1) {
      const oldCustomer = data.customers[idx]
      const wasLD = oldCustomer.id.startsWith('LD')
      const nowHasPhone = phone && phone.length > 0

      if (wasLD && nowHasPhone) {
        const newId = generateId('CS')
        data.customers[idx] = { ...oldCustomer, id: newId, platformId, platform, name, phone, status, notes, advisor }
        data.followups.forEach(f => { if (f.customerId === oldCustomer.id) f.customerId = newId })
        data.convertedCount = (data.convertedCount || 0) + 1
        await saveCustomerToDB(data.customers[idx])
        await updateFollowupsCustomerId(oldCustomer.id, newId)
        await saveSetting('convertedCount', data.convertedCount)
        await renderCustomers()
        closeCustomerModal()
        showToast(`شماره ثبت شد — ${oldCustomer.id} تبدیل شد به ${newId}`)
        return
      }

      if (!wasLD && !nowHasPhone && oldCustomer.id.startsWith('CS')) {
        const newId = generateId('LD')
        data.customers[idx] = { ...oldCustomer, id: newId, platformId, platform, name, phone, status, notes, advisor }
        data.followups.forEach(f => { if (f.customerId === oldCustomer.id) f.customerId = newId })
        await saveCustomerToDB(data.customers[idx])
        await updateFollowupsCustomerId(oldCustomer.id, newId)
        renderCustomers()
        closeCustomerModal()
        showToast(`شماره حذف شد — ${oldCustomer.id} تبدیل شد به ${newId}`)
        return
      }

      data.customers[idx] = { ...oldCustomer, platformId, platform, name, phone, status, notes, advisor }
    }
  }

  const targetId = editId || data.customers[data.customers.length - 1].id
  const targetCustomer = data.customers.find(c => c.id === targetId)
  if (targetCustomer) {
    await saveCustomerToDB(targetCustomer)
  }
  await renderCustomers()
  closeCustomerModal()
  showToast(editId ? 'مشتری ویرایش شد' : 'مشتری جدید اضافه شد')
}

export function editCustomer(id) {
  openCustomerModal(id)
}

export function deleteCustomer(id) {
  const data = getData()
  const customer = data.customers.find(c => c.id === id)
  document.getElementById('deleteMessage').textContent =
    `آیا از حذف "${customer.name || customer.id}" مطمئن هستید؟ تمام پیگیری‌های مرتبط هم حذف می‌شوند.`
  document.getElementById('deleteConfirmBtn').onclick = async function () {
    try {
      await deleteCustomerFromDB(id)
      data.customers = data.customers.filter(c => c.id !== id)
      data.followups = data.followups.filter(f => f.customerId !== id)
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

// ============================================
// Customer Detail Panel
// ============================================

export async function openCustomerDetail(id) {
  const data = getData()
  const c = data.customers.find(x => x.id === id)
  if (!c) return

  const customerFollowups = data.followups.filter(f => f.customerId === id)
  const idClass = c.id.startsWith('CS') ? 'id-cs' : 'id-ld'
  const platformLabel = PLATFORM_LABELS[c.platform] || c.platform
  const statusLabel = STATUS_LABELS[c.status] || c.status

  const detailUsers = await getUsers()

  document.getElementById('detailTitle').textContent = `پنل مشتری — ${c.name || c.platformId}`

  let html = `
    <div class="detail-info">
      <div class="detail-field">
        <span class="detail-label">شناسه</span>
        <span class="detail-value"><span class="id-badge ${idClass}">${escapeHtml(c.id)}</span></span>
      </div>
      <div class="detail-field">
        <span class="detail-label">وضعیت</span>
        <span class="detail-value">${escapeHtml(statusLabel)}</span>
      </div>
      <div class="detail-field">
        <span class="detail-label">کارشناس مسئول</span>
        <span class="detail-value">
          <select class="form-select" id="detailAdvisor" style="width:auto;display:inline-block;" onchange="window.appUpdateCustomerAdvisor('${c.id}', this.value)">
            ${detailUsers.map(u => `<option value="${escapeHtml(u.display_name)}" ${u.display_name === c.advisor ? 'selected' : ''}>${escapeHtml(u.display_name)}</option>`).join('')}
          </select>
        </span>
      </div>
      <div class="detail-field">
        <span class="detail-label">ایدی پلتفرم</span>
        <span class="detail-value" style="font-family:monospace;">${escapeHtml(c.platformId)}</span>
      </div>
      <div class="detail-field">
        <span class="detail-label">پلتفرم</span>
        <span class="detail-value">${escapeHtml(platformLabel)}</span>
      </div>
      <div class="detail-field">
        <span class="detail-label">نام</span>
        <span class="detail-value">${escapeHtml(c.name) || '—'}</span>
      </div>
      <div class="detail-field">
        <span class="detail-label">شماره تماس</span>
        <span class="detail-value" style="direction:ltr;text-align:right;">${escapeHtml(c.phone) || '—'}</span>
      </div>
      <div class="detail-field full">
        <span class="detail-label">توضیحات</span>
        <span class="detail-value">${escapeHtml(c.notes) || '—'}</span>
      </div>
    </div>

    <div style="margin-bottom:20px;padding:12px 16px;background:#f8f9fa;border-radius:8px;border:1px solid var(--border);">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
        <div>
          <div style="font-size:13px;font-weight:600;margin-bottom:2px;">تاریخ پیگیری بعدی</div>
          <div style="font-size:13px;color:${c.nextFollowupDate ? 'var(--accent)' : 'var(--text-muted)'}; font-family:monospace;">
            ${c.nextFollowupDate || 'تنظیم نشده'}
          </div>
        </div>
        <div style="display:flex;gap:6px;align-items:center;">
          <input type="text" id="detailFollowupDate" placeholder="تاریخ پیگیری" data-jdp style="padding:6px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;width:150px;">
          <button class="btn btn-sm btn-primary" onclick="window.appSetNextFollowup('${c.id}')">ذخیره</button>
          ${c.nextFollowupDate ? `<button class="btn btn-sm" onclick="window.appClearNextFollowup('${c.id}')" style="color:var(--danger);">حذف</button>` : ''}
        </div>
      </div>
    </div>

    <div class="detail-products" style="margin-bottom:20px;">
      <div style="font-size:14px;font-weight:600;margin-bottom:12px;">محصولات</div>
      <div id="detailProductsList"></div>
      <button class="btn btn-sm" style="margin-top:8px;" onclick="window.appAddProductRow('${c.id}')">+ افزودن محصول</button>
    </div>

    <div class="detail-timeline-title">
      تاریخچه پیگیری <span class="count">${customerFollowups.length}</span>
    </div>
  `

  if (customerFollowups.length === 0) {
    html += `<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px;">پیگیری ثبت نشده</div>`
  } else {
    html += `<div class="timeline">`
    customerFollowups.forEach(f => {
      const nextHtml = f.nextDate ? `<div class="timeline-next">پیگیری بعدی: ${f.nextDate}</div>` : ''
      html += `
        <div class="timeline-item">
          <div class="timeline-header">
            <span class="timeline-date">${f.date}</span>
            <span class="timeline-type">${escapeHtml(f.type)}</span>
          </div>
          <div class="timeline-result">${escapeHtml(f.result)}</div>
          ${f.notes ? `<div class="timeline-notes">${escapeHtml(f.notes)}</div>` : ''}
          ${nextHtml}
        </div>
      `
    })
    html += `</div>`
  }

  html += `
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
          </select>
        </div>
        <div class="form-group" style="margin-bottom:0;">
          <button class="btn btn-primary" style="width:100%;" onclick="window.appAddQuickNote('${c.id}')">ثبت</button>
        </div>
      </div>
    </div>
  `

  document.getElementById('detailBody').innerHTML = html
  document.getElementById('detailModal').classList.add('active')
  renderProducts(c.id)
}

export async function setNextFollowup(customerId) {
  const data = getData()
  const input = document.getElementById('detailFollowupDate')
  const date = input.value.trim()
  if (!date) { showToast('تاریخ را وارد کنید'); return }
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(date)) { showToast('فرمت تاریخ صحیح نیست (1405/05/01)'); return }

  const idx = data.customers.findIndex(c => c.id === customerId)
  if (idx !== -1) {
    data.customers[idx].nextFollowupDate = date
    await saveCustomerToDB(data.customers[idx])
    await renderCustomers()
    openCustomerDetail(customerId)
    showToast('تاریخ پیگیری تنظیم شد')
  }
}

export async function clearNextFollowup(customerId) {
  const data = getData()
  const idx = data.customers.findIndex(c => c.id === customerId)
  if (idx !== -1) {
    data.customers[idx].nextFollowupDate = ''
    await saveCustomerToDB(data.customers[idx])
    await renderCustomers()
    openCustomerDetail(customerId)
    showToast('تاریخ پیگیری حذف شد')
  }
}

export function addQuickNote(customerId) {
  const data = getData()
  const textarea = document.getElementById('detailQuickNote')
  const notes = textarea.value.trim()
  const type = document.getElementById('detailQuickType').value
  const result = document.getElementById('detailQuickResult').value

  if (!notes) { showToast('توضیحات را وارد کنید'); return }

  const today = new Date()
  const jalali = toJalali(today)
  const dateStr = `${jalali.year}/${String(jalali.month).padStart(2, '0')}/${String(jalali.day).padStart(2, '0')}`

  data.followups.push({ customerId, date: dateStr, type, result, nextDate: '', notes })
  saveFollowupToDB({ customerId, date: dateStr, type, result, nextDate: '', notes })
  renderCustomers()
  openCustomerDetail(customerId)
  showToast('توضیحات ثبت شد')
}

function toJalali(gregorian) {
  const gy = gregorian.getFullYear()
  const gm = gregorian.getMonth() + 1
  const gd = gregorian.getDate()
  const g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]
  let gy2 = (gm > 2) ? (gy + 1) : gy
  let days = 355666 + (365 * gy) + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100) + Math.floor((gy2 + 399) / 400) + gd + g_d_m[gm - 1]
  let jy = -1595 + (33 * Math.floor(days / 12053))
  days %= 12053
  jy += 4 * Math.floor(days / 1461)
  days %= 1461
  if (days > 365) { jy += Math.floor((days - 1) / 365); days = (days - 1) % 365 }
  let jm, jd
  if (days < 186) { jm = 1 + Math.floor(days / 31); jd = 1 + (days % 31) }
  else { jm = 7 + Math.floor((days - 186) / 30); jd = 1 + ((days - 186) % 30) }
  return { year: jy, month: jm, day: jd }
}

export async function updateCustomerAdvisor(customerId, advisor) {
  const data = getData()
  const c = data.customers.find(x => x.id === customerId)
  if (c) {
    c.advisor = advisor
    await saveCustomerToDB(c)
    await renderCustomers()
    showToast('کارشناس مسئول تغییر کرد')
  }
}

export function closeDetailModal() {
  document.getElementById('detailModal').classList.remove('active')
}

// ============================================
// Product Management
// ============================================

const PRODUCTS = ['آنلاین چینی', 'حضوری چینی', 'کتاب']
const PRODUCT_STATUSES = ['تکمیل', 'بیعانه']

export function getProducts(customerId) {
  const data = getData()
  const c = data.customers.find(x => x.id === customerId)
  return (c && c.products) ? c.products : []
}

export async function setProducts(customerId, products) {
  const data = getData()
  const idx = data.customers.findIndex(c => c.id === customerId)
  if (idx !== -1) {
    data.customers[idx].products = products
    await saveCustomerToDB(data.customers[idx])
  }
}

export function renderProducts(customerId) {
  const container = document.getElementById('detailProductsList')
  if (!container) return
  const products = getProducts(customerId)

  if (products.length === 0) {
    container.innerHTML = '<div style="font-size:13px;color:var(--text-muted);padding:8px 0;">محصولی ثبت نشده</div>'
    return
  }

  container.innerHTML = products.map((p, i) => {
    const isCompleted = p.status === 'تکمیل'
    const price = parseFloat(p.price) || 0
    const deposit = parseFloat(p.deposit) || 0

    let priceHtml = ''
    if (isCompleted) {
      priceHtml = `<input type="text" inputmode="numeric" class="product-price num-input" placeholder="قیمت" value="${p.price ? formatNumber(p.price) : ''}" oninput="window.appFormatInput(this)" onblur="window.appSaveProductField('${customerId}', ${i}, 'price', window.appUnformatInput(this))">`
    } else if (p.status === 'بیعانه') {
      priceHtml = `
        <input type="text" inputmode="numeric" class="product-deposit num-input" placeholder="بیعانه" value="${p.deposit ? formatNumber(p.deposit) : ''}" oninput="window.appFormatInput(this)" onblur="window.appSaveProductField('${customerId}', ${i}, 'deposit', window.appUnformatInput(this))">
        <input type="text" inputmode="numeric" class="product-price num-input" placeholder="قیمت کل" value="${p.price ? formatNumber(p.price) : ''}" oninput="window.appFormatInput(this)" onblur="window.appSaveProductField('${customerId}', ${i}, 'price', window.appUnformatInput(this))">
        <input type="text" class="product-settlement" placeholder="تاریخ تسویه" data-jdp value="${p.settlementDate || ''}" onchange="window.appUpdateProduct('${customerId}', ${i}, 'settlementDate', this.value)">
      `
    }

    let balanceHtml = ''
    if (p.status === 'بیعانه' && price > 0) {
      const bal = price - deposit
      balanceHtml = `<span class="product-balance ${bal > 0 ? 'negative' : ''}">مانده: ${formatNumber(bal)}</span>`
    }

    return `
      <div class="product-row">
        <select class="product-name" onchange="window.appUpdateProduct('${customerId}', ${i}, 'name', this.value)">
          ${PRODUCTS.map(pr => `<option value="${pr}" ${p.name === pr ? 'selected' : ''}>${pr}</option>`).join('')}
        </select>
        <select class="product-status" onchange="window.appUpdateProduct('${customerId}', ${i}, 'status', this.value)">
          ${PRODUCT_STATUSES.map(s => `<option value="${s}" ${p.status === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
        ${priceHtml}
        ${balanceHtml}
        <button class="btn-remove-product" onclick="window.appRemoveProduct('${customerId}', ${i})" title="حذف">✕</button>
      </div>
    `
  }).join('')
}

export function addProductRow(customerId) {
  const products = getProducts(customerId)
  products.push({ name: PRODUCTS[0], status: PRODUCT_STATUSES[0], price: '', deposit: '', settlementDate: '' })
  setProducts(customerId, products)
  renderProducts(customerId)
}

export function saveProductField(customerId, index, field, value) {
  const products = getProducts(customerId)
  if (products[index]) {
    products[index][field] = value
    setProducts(customerId, products)
  }
}

export function updateProduct(customerId, index, field, value) {
  const products = getProducts(customerId)
  if (products[index]) {
    products[index][field] = value
    if (field === 'status' && value === 'تکمیل') {
      products[index].deposit = ''
    }
    setProducts(customerId, products)
    renderProducts(customerId)
  }
}

export function removeProduct(customerId, index) {
  const products = getProducts(customerId)
  products.splice(index, 1)
  setProducts(customerId, products)
  renderProducts(customerId)
}
