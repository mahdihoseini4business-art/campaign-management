import { getData, saveCustomerToDB, deleteCustomerFromDB, saveFollowupToDB, deleteFollowupFromDB, updateFollowupsCustomerId, saveSetting, generateId, peekNextId } from './data.js'
import { getUsersSafe } from './auth.js'
import {
  toEnDigits, escapeHtml, escapeAttr, showToast, hasPermission, requirePermission,
  canViewCustomer, canManageCustomer, getCurrentUser, formatNumber, jalaliToNum,
  getTodayJalaliStr, getTodayJalaliNum, jalaliAddDays, toJalali, ownsCustomer,
  resolveAdvisor, normalizePhone, userDisplayName, PLATFORM_LABELS, PLATFORM_CLASSES,
  getPlatformUrl, getLastActivity, hasRecentActivityByOther, findCustomerByPhone,
  getNowJalaliDateTime
} from './utils.js'

const STATUS_LABELS = { new: 'جدید', contacted: 'تماس گرفته', chatting: 'در حال چت', interested: 'علاقه‌مند', sent: 'اطلاعات ارسال', followup_done: 'تکمیل پیگیری', converting: 'در حال تبدیل', purchased: 'خرید کرد', cancelled: 'منصرف شده' }
const STATUS_CLASSES = { new: 'status-new', contacted: 'status-contacted', chatting: 'status-chatting', interested: 'status-interested', sent: 'status-sent', followup_done: 'status-followup_done', converting: 'status-converting', purchased: 'status-purchased', cancelled: 'status-cancelled' }

/** Phone-field check while creating/editing: ok | incomplete | own | blocked | transferable | taken */
let phoneFieldState = { status: 'ok', customer: null, lastActivity: null }

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
  const currentUser = getCurrentUser()
  const isAdmin = currentUser && currentUser.role === 'admin'

  const filtered = data.customers.filter(c => {
    const matchesSearch = !search ||
      c.id.toLowerCase().includes(search) ||
      c.name.toLowerCase().includes(search) ||
      (c.platformId || '').toLowerCase().includes(search) ||
      (c.phone || '').includes(search) ||
      normalizePhone(c.phone).includes(search.replace(/\D/g, ''))

    if (!matchesSearch) return false

    const isCS = c.id.startsWith('CS')
    const isLD = c.id.startsWith('LD')
    if (isCS && !hasPermission('customers_cs')) return false
    if (isLD && !hasPermission('customers_ld')) return false

    // Empty search → only my customers (admin sees all). Active search → whole DB.
    if (!search && !isAdmin && !ownsCustomer(c, currentUser)) return false

    if (advisorFilter && normalizePhone(c.advisorPhone) !== normalizePhone(advisorFilter)) return false
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
    const canEdit = hasPermission('customers_add') && canManageCustomer(c, currentUser)
    const canDelete = hasPermission('customers_delete') && canManageCustomer(c, currentUser)
    const isMine = isAdmin || ownsCustomer(c, currentUser)

    const platformUrl = getPlatformUrl(c.platform, c.platformId, c.phone)
    const platformIdHtml = platformUrl
      ? `<a href="${platformUrl}" target="_blank" rel="noopener" style="font-family:'Vazirmatn',sans-serif;font-size:13px;color:var(--accent);text-decoration:none;border-bottom:1px dashed var(--accent);">${escapeHtml(c.platformId)}</a>`
      : `<span style="font-family:'Vazirmatn',sans-serif;font-size:13px;">${escapeHtml(c.platformId)}</span>`

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
        nextFollowupHtml = `<span style="font-family:'Vazirmatn',sans-serif;font-size:13px;">${c.nextFollowupDate}</span>`
      }
    }

    return `<tr class="${nextFollowupClass}${isMine ? '' : ' row-other-owner'}">
      <td>${canDelete ? `<input type="checkbox" data-id="${escapeAttr(c.id)}" onchange="app.toggleRowSelect('customers', '${escapeAttr(c.id)}', this.checked)">` : ''}</td>
      <td><span class="id-badge ${idClass}">${escapeHtml(c.id)}</span>${!isMine ? '<span class="owner-badge">همکار</span>' : ''}</td>
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
          <button class="btn-icon" title="پنل مشتری" onclick="app.openCustomerDetail('${escapeAttr(c.id)}')" style="color:var(--accent);">👤</button>
          ${canEdit ? `<button class="btn-icon" title="ویرایش" onclick="app.editCustomer('${escapeAttr(c.id)}')">✏</button>` : ''}
          ${canDelete ? `<button class="btn-icon" title="حذف" onclick="app.deleteCustomer('${escapeAttr(c.id)}')">🗑</button>` : ''}
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
  const users = await getUsersSafe()
  advisorSelect.innerHTML = '<option value="">همه کارشناسان</option>' + users
    .filter(u => u.phone)
    .map(u => `<option value="${escapeAttr(normalizePhone(u.phone))}">${escapeHtml(userDisplayName(u))}</option>`)
    .join('')
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
  if (!requirePermission('customers_add')) return
  clearPhoneFieldMessages()
  phoneFieldState = { status: 'ok', customer: null, lastActivity: null }
  const data = getData()
  const modal = document.getElementById('customerModal')
  const title = document.getElementById('customerModalTitle')
  const currentUser = getCurrentUser()
  const users = await getUsersSafe()
  const advisorSelect = document.getElementById('customerAdvisor')
  advisorSelect.innerHTML = users
    .filter(u => u.phone)
    .map(u => `<option value="${escapeAttr(normalizePhone(u.phone))}">${escapeHtml(userDisplayName(u))}</option>`)
    .join('')

  if (editId) {
    const c = data.customers.find(x => x.id === editId)
    if (!c) return
    if (!canManageCustomer(c)) {
      showToast('فقط کارشناس مسئول می‌تواند این مشتری را ویرایش کند')
      return
    }
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
    const selectedPhone = c.advisorPhone || (currentUser ? currentUser.phone : '')
    advisorSelect.value = normalizePhone(selectedPhone)
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
    advisorSelect.value = currentUser?.phone ? normalizePhone(currentUser.phone) : ''
    updatePreviewId()
  }

  modal.classList.add('active')
  document.getElementById('customerPlatformId').focus()
}

function clearPhoneFieldMessages() {
  const input = document.getElementById('customerPhone')
  const err = document.getElementById('customerPhoneError')
  const hint = document.getElementById('customerPhoneHint')
  if (input) input.classList.remove('is-invalid')
  if (err) { err.hidden = true; err.textContent = '' }
  if (hint) { hint.hidden = true; hint.textContent = ''; hint.className = 'form-hint' }
}

function setPhoneFieldError(message) {
  const input = document.getElementById('customerPhone')
  const err = document.getElementById('customerPhoneError')
  const hint = document.getElementById('customerPhoneHint')
  if (input) input.classList.add('is-invalid')
  if (hint) { hint.hidden = true; hint.textContent = '' }
  if (err) { err.hidden = false; err.textContent = message }
}

function setPhoneFieldHint(message, kind = 'info') {
  const input = document.getElementById('customerPhone')
  const err = document.getElementById('customerPhoneError')
  const hint = document.getElementById('customerPhoneHint')
  if (input) input.classList.remove('is-invalid')
  if (err) { err.hidden = true; err.textContent = '' }
  if (hint) {
    hint.hidden = false
    hint.textContent = message
    hint.className = `form-hint is-${kind}`
  }
}

function formatActivityLabel(act) {
  if (!act) return 'بدون فعالیت ثبت‌شده'
  return `${act.dateStr} (${act.label})`
}

/** Live validation for create/edit phone field */
export function onCustomerPhoneInput() {
  const data = getData()
  const currentUser = getCurrentUser()
  const editId = document.getElementById('editCustomerId')?.value || ''
  const raw = document.getElementById('customerPhone')?.value || ''
  const phone = normalizePhone(raw)

  clearPhoneFieldMessages()
  phoneFieldState = { status: 'ok', customer: null, lastActivity: null }

  if (!phone) {
    phoneFieldState.status = 'ok'
    return
  }

  if (!/^09\d{9}$/.test(phone)) {
    phoneFieldState.status = 'incomplete'
    if (phone.length >= 11 || (raw.trim().length >= 10 && !phone.startsWith('09'))) {
      setPhoneFieldError('فرمت شماره موبایل صحیح نیست (مثال: ۰۹۱۲۳۴۵۶۷۸۹)')
    }
    return
  }

  const existing = findCustomerByPhone(phone, data.customers, editId || null)
  if (!existing) {
    phoneFieldState.status = 'ok'
    return
  }

  const lastActivity = getLastActivity(existing, data.followups)
  phoneFieldState.customer = existing
  phoneFieldState.lastActivity = lastActivity

  if (editId) {
    phoneFieldState.status = 'taken'
    setPhoneFieldError(
      `این شماره از قبل برای مشتری ${existing.id} ثبت شده است` +
      (lastActivity ? ` — آخرین فعالیت: ${formatActivityLabel(lastActivity)}` : '')
    )
    return
  }

  if (ownsCustomer(existing, currentUser)) {
    phoneFieldState.status = 'own'
    setPhoneFieldError(
      `مشتری با این شماره از قبل متعلق به شماست (${existing.id})` +
      (lastActivity ? `. آخرین فعالیت: ${formatActivityLabel(lastActivity)}` : '')
    )
    return
  }

  const recentOther = hasRecentActivityByOther(existing, data.followups, currentUser?.phone, 30)
  if (recentOther) {
    phoneFieldState.status = 'blocked'
    setPhoneFieldError(
      `مشتری با این شماره از قبل وجود دارد و در ۳۰ روز اخیر توسط کارشناس دیگری روی آن فعالیت ثبت شده؛ امکان ثبت/انتقال نیست. آخرین فعالیت: ${formatActivityLabel(lastActivity)}`
    )
    return
  }

  phoneFieldState.status = 'transferable'
  setPhoneFieldHint(
    `مشتری با این شماره از قبل وجود دارد (کارشناس فعلی: ${existing.advisor || '—'}، ${existing.id}). ` +
    `آخرین فعالیت: ${formatActivityLabel(lastActivity)}. با ذخیره، مشتری و تمام گزارش‌ها به کارشناس انتخاب‌شده منتقل می‌شود.`,
    'warning'
  )
}

async function updatePreviewId() {
  if (document.getElementById('editCustomerId').value) return
  const phone = document.getElementById('customerPhone').value.trim()
  const type = phone ? 'CS' : 'LD'
  document.getElementById('customerIdDisplay').value = await peekNextId(type)
  document.getElementById('customerIdHint').textContent = phone
    ? 'شماره وارد شد → مشتری (CS)'
    : 'بدون شماره → لید (LD)'
}

export function closeCustomerModal() {
  document.getElementById('customerModal').classList.remove('active')
}

export async function saveCustomer() {
  if (!requirePermission('customers_add')) return
  const saveBtn = document.querySelector('#customerModal .btn-primary')
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'در حال ذخیره...' }

  try {
  const data = getData()
  const users = await getUsersSafe()
  const currentUser = getCurrentUser()
  const editId = document.getElementById('editCustomerId').value
  const platformId = document.getElementById('customerPlatformId').value.trim()
  const platform = document.getElementById('customerPlatform').value
  const name = document.getElementById('customerName').value.trim()
  const phoneRaw = document.getElementById('customerPhone').value.trim()
  const phone = phoneRaw ? normalizePhone(phoneRaw) : ''
  const status = document.getElementById('customerStatus').value
  const notes = document.getElementById('customerNotes').value.trim()
  const advisorSelectValue = document.getElementById('customerAdvisor').value
  const { advisor, advisorPhone } = resolveAdvisor(advisorSelectValue, users)

  // Re-run live validation
  onCustomerPhoneInput()

  if (phone && !/^09\d{9}$/.test(phone)) {
    setPhoneFieldError('فرمت شماره موبایل صحیح نیست (مثال: ۰۹۱۲۳۴۵۶۷۸۹)')
    document.getElementById('customerPhone')?.focus()
    return
  }

  if (!editId) {
    // === CREATE ===
    if (phoneFieldState.status === 'blocked' || phoneFieldState.status === 'taken') {
      document.getElementById('customerPhone')?.focus()
      return
    }
    if (phoneFieldState.status === 'own' && phoneFieldState.customer) {
      closeCustomerModal()
      openCustomerDetail(phoneFieldState.customer.id)
      showToast(`این مشتری از قبل متعلق به شماست — پنل ${phoneFieldState.customer.id} باز شد`)
      return
    }

    const existById = platformId && data.customers.find(c => c.platformId && c.platformId.toLowerCase() === platformId.toLowerCase())
    if (existById) {
      openCustomerDetail(existById.id)
      showToast(`این ایدی قبلاً ثبت شده — پنل مشتری ${existById.id} باز شد`)
      return
    }

    // Transfer existing customer when phone is free of recent activity
    if (phoneFieldState.status === 'transferable' && phoneFieldState.customer) {
      await transferCustomerOwnership(phoneFieldState.customer, {
        platformId, platform, name, phone, status, notes, advisor, advisorPhone
      }, users)
      return
    }

    const type = phone ? 'CS' : 'LD'
    const id = await generateId(type)
    const newCustomer = { id, platformId, platform, name, phone, status, notes, advisor, advisorPhone, nextFollowupDate: '', products: [] }
    await saveCustomerToDB(newCustomer)
    data.customers.push(newCustomer)
  } else {
    // === EDIT ===
    // Block changing phone to one that already exists on another customer
    const dupByPhone = phone && findCustomerByPhone(phone, data.customers, editId)
    if (dupByPhone) {
      setPhoneFieldError(`این شماره از قبل برای مشتری ${dupByPhone.id} ثبت شده و قابل تغییر نیست`)
      document.getElementById('customerPhone')?.focus()
      return
    }

    const dupById = platformId && data.customers.find(c => c.id !== editId && c.platformId && c.platformId.toLowerCase() === platformId.toLowerCase())
    if (dupById) { showToast(`این ایدی متعلق به مشتری ${dupById.id} است`); return }

    const idx = data.customers.findIndex(c => c.id === editId)
    if (idx !== -1) {
      const oldCustomer = data.customers[idx]
      if (!canManageCustomer(oldCustomer)) {
        showToast('فقط کارشناس مسئول می‌تواند این مشتری را ویرایش کند')
        return
      }
      const wasLD = oldCustomer.id.startsWith('LD')
      const nowHasPhone = phone && phone.length > 0
      const advisorFields = { advisor, advisorPhone }

      if (wasLD && nowHasPhone) {
        const newId = await generateId('CS')
        try {
          await saveCustomerToDB({ ...oldCustomer, id: newId, platformId, platform, name, phone, status, notes, ...advisorFields })
          await updateFollowupsCustomerId(oldCustomer.id, newId)
          await saveSetting('convertedCount', (data.convertedCount || 0) + 1)
          data.customers[idx] = { ...oldCustomer, id: newId, platformId, platform, name, phone, status, notes, ...advisorFields }
          data.followups.forEach(f => { if (f.customerId === oldCustomer.id) f.customerId = newId })
          data.convertedCount = (data.convertedCount || 0) + 1
          await renderCustomers()
          closeCustomerModal()
          showToast(`شماره ثبت شد — ${oldCustomer.id} تبدیل شد به ${newId}`)
        } catch (e) {
          console.error('LD→CS conversion error:', e)
          showToast('خطا در تبدیل مشتری')
        }
        return
      }

      if (!wasLD && !nowHasPhone && oldCustomer.id.startsWith('CS')) {
        const newId = await generateId('LD')
        try {
          await saveCustomerToDB({ ...oldCustomer, id: newId, platformId, platform, name, phone, status, notes, ...advisorFields })
          await updateFollowupsCustomerId(oldCustomer.id, newId)
          data.customers[idx] = { ...oldCustomer, id: newId, platformId, platform, name, phone, status, notes, ...advisorFields }
          data.followups.forEach(f => { if (f.customerId === oldCustomer.id) f.customerId = newId })
          await renderCustomers()
          closeCustomerModal()
          showToast(`شماره حذف شد — ${oldCustomer.id} تبدیل شد به ${newId}`)
        } catch (e) {
          console.error('CS→LD conversion error:', e)
          showToast('خطا در تبدیل مشتری')
        }
        return
      }

      const updated = { ...oldCustomer, platformId, platform, name, phone, status, notes, ...advisorFields }
      await saveCustomerToDB(updated)
      data.customers[idx] = updated
    }
  }

  await renderCustomers()
  closeCustomerModal()
  showToast(editId ? 'مشتری ویرایش شد' : 'مشتری جدید اضافه شد')
  } catch (e) {
    console.error('saveCustomer error:', e)
    showToast('خطا در ذخیره مشتری')
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'ذخیره' }
  }
}

async function transferCustomerOwnership(existing, fields, users) {
  const data = getData()
  const currentUser = getCurrentUser()
  const idx = data.customers.findIndex(c => c.id === existing.id)
  if (idx === -1) { showToast('مشتری یافت نشد'); return }

  if (hasRecentActivityByOther(existing, data.followups, currentUser?.phone, 30)) {
    onCustomerPhoneInput()
    showToast('امکان انتقال نیست؛ اخیراً توسط کارشناس دیگری فعالیت ثبت شده')
    return
  }

  const oldAdvisor = existing.advisor || '—'
  const { advisor, advisorPhone } = fields
  const updated = {
    ...existing,
    platformId: fields.platformId || existing.platformId,
    platform: fields.platform || existing.platform,
    name: fields.name || existing.name,
    phone: fields.phone || existing.phone,
    status: fields.status || existing.status,
    notes: fields.notes !== undefined && fields.notes !== '' ? fields.notes : existing.notes,
    advisor,
    advisorPhone
  }

  const { date, time } = getNowJalaliDateTime()
  const transferNote = {
    customerId: existing.id,
    date,
    type: 'سیستمی',
    result: 'انتقال کارشناس',
    nextDate: '',
    notes: `این مشتری در تاریخ ${date} ساعت ${time} از کارشناس ${oldAdvisor} به کارشناس ${advisor} منتقل شد.`,
    createdByPhone: normalizePhone(currentUser?.phone || advisorPhone)
  }

  try {
    await saveCustomerToDB(updated)
    data.customers[idx] = updated
    const fid = await saveFollowupToDB(transferNote)
    transferNote.id = fid
    data.followups.push(transferNote)
    await renderCustomers()
    closeCustomerModal()
    openCustomerDetail(existing.id)
    showToast(`مشتری ${existing.id} از ${oldAdvisor} به ${advisor} منتقل شد`)
  } catch (e) {
    console.error('transferCustomerOwnership error:', e)
    showToast('خطا در انتقال مشتری')
  }
}

export function editCustomer(id) {
  if (!requirePermission('customers_add')) return
  const data = getData()
  const c = data.customers.find(x => x.id === id)
  if (c && !canManageCustomer(c)) { showToast('فقط کارشناس مسئول می‌تواند این مشتری را ویرایش کند'); return }
  openCustomerModal(id)
}

export function deleteCustomer(id) {
  if (!requirePermission('customers_delete')) return
  const data = getData()
  const customer = data.customers.find(c => c.id === id)
  if (customer && !canManageCustomer(customer)) { showToast('فقط کارشناس مسئول می‌تواند این مشتری را حذف کند'); return }
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
  if (!canViewCustomer(c)) {
    showToast('شما به این مشتری دسترسی ندارید')
    return
  }

  const canEdit = hasPermission('customers_add')
  const canAddFollowup = hasPermission('followups_add')

  const customerFollowups = data.followups.filter(f => f.customerId === id)
  const idClass = c.id.startsWith('CS') ? 'id-cs' : 'id-ld'
  const platformLabel = PLATFORM_LABELS[c.platform] || c.platform
  const statusLabel = STATUS_LABELS[c.status] || c.status

  const detailUsers = await getUsersSafe()

  document.getElementById('detailTitle').textContent = `پنل مشتری — ${c.name || c.platformId}`

  const advisorHtml = canEdit
    ? `<select class="form-select" id="detailAdvisor" style="width:auto;display:inline-block;" onchange="app.updateCustomerAdvisor('${escapeAttr(c.id)}', this.value)">
            ${detailUsers.filter(u => u.phone).map(u => {
              const phone = normalizePhone(u.phone)
              const selected = phone === normalizePhone(c.advisorPhone) ? 'selected' : ''
              return `<option value="${escapeAttr(phone)}" ${selected}>${escapeHtml(userDisplayName(u))}</option>`
            }).join('')}
          </select>`
    : escapeHtml(c.advisor || '—')

  const followupDateControls = canEdit
    ? `<div style="display:flex;gap:6px;align-items:center;">
          <input type="text" id="detailFollowupDate" placeholder="تاریخ پیگیری" data-jdp style="padding:6px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;width:150px;">
          <button class="btn btn-sm btn-primary" onclick="app.setNextFollowup('${escapeAttr(c.id)}')">ذخیره</button>
          ${c.nextFollowupDate ? `<button class="btn btn-sm" onclick="app.clearNextFollowup('${escapeAttr(c.id)}')" style="color:var(--danger);">حذف</button>` : ''}
        </div>`
    : ''

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
        <span class="detail-value">${advisorHtml}</span>
      </div>
      <div class="detail-field">
        <span class="detail-label">ایدی پلتفرم</span>
        <span class="detail-value" style="font-family:'Vazirmatn',sans-serif;">${escapeHtml(c.platformId)}</span>
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
          <div style="font-size:13px;color:${c.nextFollowupDate ? 'var(--accent)' : 'var(--text-muted)'}; font-family:'Vazirmatn',sans-serif;">
            ${c.nextFollowupDate || 'تنظیم نشده'}
          </div>
        </div>
        ${followupDateControls}
      </div>
    </div>

    <div class="detail-products" style="margin-bottom:20px;">
      <div style="font-size:14px;font-weight:600;margin-bottom:12px;">محصولات</div>
      <div id="detailProductsList"></div>
      ${canEdit ? `<button class="btn btn-sm" style="margin-top:8px;" onclick="app.addProductRow('${escapeAttr(c.id)}')">+ افزودن محصول</button>` : ''}
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

  if (canAddFollowup) {
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
          <button class="btn btn-primary" style="width:100%;" onclick="app.addQuickNote('${escapeAttr(c.id)}')">ثبت</button>
        </div>
      </div>
    </div>
  `
  }

  document.getElementById('detailBody').innerHTML = html
  document.getElementById('detailModal').classList.add('active')
  renderProducts(c.id)
}

export async function setNextFollowup(customerId) {
  if (!requirePermission('customers_add')) return
  const data = getData()
  const input = document.getElementById('detailFollowupDate')
  const date = input.value.trim()
  if (!date) { showToast('تاریخ را وارد کنید'); return }
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(date)) { showToast('فرمت تاریخ صحیح نیست (1405/05/01)'); return }

  const idx = data.customers.findIndex(c => c.id === customerId)
  if (idx !== -1) {
    data.customers[idx].nextFollowupDate = date
    try {
      await saveCustomerToDB(data.customers[idx])
      await renderCustomers()
      openCustomerDetail(customerId)
      showToast('تاریخ پیگیری تنظیم شد')
    } catch (e) {
      console.error('setNextFollowup error:', e)
      showToast('خطا در ذخیره تاریخ پیگیری')
    }
  }
}

export async function clearNextFollowup(customerId) {
  if (!requirePermission('customers_add')) return
  const data = getData()
  const idx = data.customers.findIndex(c => c.id === customerId)
  if (idx !== -1) {
    data.customers[idx].nextFollowupDate = ''
    try {
      await saveCustomerToDB(data.customers[idx])
      await renderCustomers()
      openCustomerDetail(customerId)
      showToast('تاریخ پیگیری حذف شد')
    } catch (e) {
      console.error('clearNextFollowup error:', e)
      showToast('خطا در حذف تاریخ پیگیری')
    }
  }
}

export async function addQuickNote(customerId) {
  if (!requirePermission('followups_add')) return
  const data = getData()
  const textarea = document.getElementById('detailQuickNote')
  const notes = textarea.value.trim()
  const type = document.getElementById('detailQuickType').value
  const result = document.getElementById('detailQuickResult').value

  if (!notes) { showToast('توضیحات را وارد کنید'); return }

  const today = new Date()
  const jalali = toJalali(today)
  const dateStr = `${jalali.year}/${String(jalali.month).padStart(2, '0')}/${String(jalali.day).padStart(2, '0')}`

  const newFollowup = { customerId, date: dateStr, type, result, nextDate: '', notes, createdByPhone: normalizePhone(getCurrentUser()?.phone || '') }
  const id = await saveFollowupToDB(newFollowup)
  newFollowup.id = id
  data.followups.push(newFollowup)
  await renderCustomers()
  openCustomerDetail(customerId)
  showToast('توضیحات ثبت شد')
}

export async function updateCustomerAdvisor(customerId, advisorPhoneValue) {
  if (!requirePermission('customers_add')) return
  const data = getData()
  const c = data.customers.find(x => x.id === customerId)
  if (!c) return
  if (!canViewCustomer(c)) { showToast('شما به این مشتری دسترسی ندارید'); return }
  const users = await getUsersSafe()
  const { advisor, advisorPhone } = resolveAdvisor(advisorPhoneValue, users)
  c.advisor = advisor
  c.advisorPhone = advisorPhone
  try {
    await saveCustomerToDB(c)
    await renderCustomers()
    showToast('کارشناس مسئول تغییر کرد')
  } catch (e) {
    console.error('updateCustomerAdvisor error:', e)
    showToast('خطا در ذخیره کارشناس')
  }
}

export function closeDetailModal() {
  document.getElementById('detailModal').classList.remove('active')
}

// ============================================
// Product Management
// ============================================

const PRODUCTS = ['آنلاین چینی', 'حضوری چینی', 'کتاب', 'کره ای حضوری', 'کره ای آنلاین', 'حضوری فرمان', 'آنلاین فرمان', 'دوره زبان فنی', 'دوره GDS', 'آنلاین داخلی', 'تنظیم موتور', 'دیاگ لانچ', 'دیاگ I700', 'دیاگ blu', 'دیاگ newlite', 'تست باکس شبکه']
const PRODUCT_STATUSES = ['تکمیل', 'بیعانه']

export function getProducts(customerId) {
  const data = getData()
  const c = data.customers.find(x => x.id === customerId)
  return (c && c.products) ? c.products : []
}

export async function setProducts(customerId, products) {
  if (!requirePermission('customers_add')) return
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
  const canEdit = hasPermission('customers_add')

  if (products.length === 0) {
    container.innerHTML = '<div style="font-size:13px;color:var(--text-muted);padding:8px 0;">محصولی ثبت نشده</div>'
    return
  }

  container.innerHTML = products.map((p, i) => {
    const isCompleted = p.status === 'تکمیل'
    const price = parseFloat(p.price) || 0
    const deposit = parseFloat(p.deposit) || 0

    if (!canEdit) {
      let balanceHtml = ''
      if (p.status === 'بیعانه' && price > 0) {
        const bal = price - deposit
        balanceHtml = `<span class="product-balance ${bal > 0 ? 'negative' : ''}">مانده: ${formatNumber(bal)}</span>`
      }
      return `
        <div class="product-row" style="opacity:0.95;">
          <span style="font-size:13px;min-width:120px;">${escapeHtml(p.name || '—')}</span>
          <span style="font-size:13px;">${escapeHtml(p.status || '—')}</span>
          <span style="font-size:13px;">${p.price ? formatNumber(p.price) : '—'}</span>
          ${p.status === 'بیعانه' ? `<span style="font-size:13px;">بیعانه: ${p.deposit ? formatNumber(p.deposit) : '—'}</span>` : ''}
          ${p.settlementDate ? `<span style="font-size:12px;color:var(--text-muted);">${escapeHtml(p.settlementDate)}</span>` : ''}
          ${balanceHtml}
          ${p.soldAt ? `<span style="font-size:11px;color:var(--text-muted);">ثبت: ${escapeHtml(p.soldAt)}</span>` : ''}
          ${p.depositorName ? `<span style="font-size:11px;color:var(--text-muted);">واریزکننده: ${escapeHtml(p.depositorName)}</span>` : ''}
        </div>
      `
    }

    let priceHtml = ''
    if (isCompleted) {
      priceHtml = `<input type="text" inputmode="numeric" class="product-price num-input" placeholder="قیمت" value="${p.price ? formatNumber(p.price) : ''}" oninput="app.formatInput(this)" onblur="app.saveProductField('${customerId}', ${i}, 'price', app.unformatInput(this))">`
    } else if (p.status === 'بیعانه') {
      priceHtml = `
        <input type="text" inputmode="numeric" class="product-deposit num-input" placeholder="بیعانه" value="${p.deposit ? formatNumber(p.deposit) : ''}" oninput="app.formatInput(this)" onblur="app.saveProductField('${customerId}', ${i}, 'deposit', app.unformatInput(this))">
        <input type="text" inputmode="numeric" class="product-price num-input" placeholder="قیمت کل" value="${p.price ? formatNumber(p.price) : ''}" oninput="app.formatInput(this)" onblur="app.saveProductField('${customerId}', ${i}, 'price', app.unformatInput(this))">
        <input type="text" class="product-settlement" placeholder="تاریخ تسویه" data-jdp value="${p.settlementDate || ''}" onchange="app.updateProduct('${customerId}', ${i}, 'settlementDate', this.value)">
      `
    }

    let balanceHtml = ''
    if (p.status === 'بیعانه' && price > 0) {
      const bal = price - deposit
      balanceHtml = `<span class="product-balance ${bal > 0 ? 'negative' : ''}">مانده: ${formatNumber(bal)}</span>`
    }

    return `
      <div class="product-row">
        <select class="product-name" onchange="app.updateProduct('${customerId}', ${i}, 'name', this.value)">
          ${PRODUCTS.map(pr => `<option value="${pr}" ${p.name === pr ? 'selected' : ''}>${pr}</option>`).join('')}
        </select>
        <select class="product-status" onchange="app.updateProduct('${customerId}', ${i}, 'status', this.value)">
          ${PRODUCT_STATUSES.map(s => `<option value="${s}" ${p.status === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
        ${priceHtml}
        ${balanceHtml}
        <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;">
          <input type="text" class="product-settlement" placeholder="تاریخ فروش" data-jdp value="${p.soldAt ? p.soldAt.split(' ')[0] : ''}" onchange="app.updateProduct('${customerId}', ${i}, 'soldAtDate', this.value)" style="max-width:110px;font-size:12px;">
          <input type="time" class="product-settlement" value="${p.soldAt && p.soldAt.includes(' ') ? p.soldAt.split(' ')[1] : ''}" onchange="app.updateProduct('${customerId}', ${i}, 'soldAtTime', this.value)" style="max-width:80px;font-size:12px;">
          <input type="text" class="product-settlement" placeholder="نام واریزکننده" value="${escapeAttr(p.depositorName || '')}" onblur="app.updateProduct('${customerId}', ${i}, 'depositorName', this.value)" style="min-width:120px;font-size:12px;">
        </div>
        <button class="btn-remove-product" onclick="app.removeProduct('${escapeAttr(customerId)}', ${i})" title="حذف">✕</button>
      </div>
    `
  }).join('')
}

export async function addProductRow(customerId) {
  if (!requirePermission('customers_add')) return
  const products = getProducts(customerId)
  const { dateTime } = getNowJalaliDateTime()
  const user = getCurrentUser()
  products.push({
    name: PRODUCTS[0], status: PRODUCT_STATUSES[0], price: '', deposit: '', settlementDate: '',
    soldAt: dateTime,
    soldByPhone: normalizePhone(user?.phone || ''),
    depositorName: '',
    paymentStatus: 'pending',
    paymentRejectReason: '',
    paymentReviewedAt: '',
    paymentReviewedBy: ''
  })
  await setProducts(customerId, products)
  renderProducts(customerId)
}

function resetPaymentForReview(product) {
  product.paymentStatus = 'pending'
  product.paymentRejectReason = ''
  product.paymentReviewedAt = ''
  product.paymentReviewedBy = ''
}

const PAYMENT_SENSITIVE_FIELDS = new Set(['price', 'deposit', 'status', 'soldAtDate', 'soldAtTime', 'depositorName', 'soldAt'])

export async function saveProductField(customerId, index, field, value) {
  const products = getProducts(customerId)
  if (products[index]) {
    products[index][field] = value
    if (PAYMENT_SENSITIVE_FIELDS.has(field)) resetPaymentForReview(products[index])
    await setProducts(customerId, products)
  }
}

export async function updateProduct(customerId, index, field, value) {
  const products = getProducts(customerId)
  if (products[index]) {
    if (field === 'soldAtDate') {
      const oldTime = (products[index].soldAt || '').split(' ')[1] || ''
      products[index].soldAt = oldTime ? `${value} ${oldTime}` : value
    } else if (field === 'soldAtTime') {
      const oldDate = (products[index].soldAt || '').split(' ')[0] || ''
      products[index].soldAt = oldDate ? `${oldDate} ${value}` : value
    } else {
      products[index][field] = value
    }
    if (field === 'status' && value === 'تکمیل') {
      products[index].deposit = ''
    }
    if (PAYMENT_SENSITIVE_FIELDS.has(field)) resetPaymentForReview(products[index])
    await setProducts(customerId, products)
    renderProducts(customerId)
  }
}

export async function removeProduct(customerId, index) {
  if (!requirePermission('customers_add')) return
  if (!window.confirm('آیا از حذف این محصول مطمئن هستید؟')) return
  const products = getProducts(customerId)
  products.splice(index, 1)
  await setProducts(customerId, products)
  renderProducts(customerId)
}
