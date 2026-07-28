import { getData, saveCustomerToDB, deleteCustomerFromDB, saveFollowupToDB, deleteFollowupFromDB, updateFollowupsCustomerId, saveSetting, generateId, peekNextId, getDestinationBanks } from './data.js'
import { getUsersSafe } from './auth.js'
import {
  toEnDigits, escapeHtml, escapeAttr, showToast, hasPermission, requirePermission,
  canViewCustomer, canManageCustomer, getCurrentUser, formatNumber, jalaliToNum,
  getTodayJalaliStr, getTodayJalaliNum, jalaliAddDays, toJalali, ownsCustomer, isAdmin,
  resolveAdvisor, normalizePhone, userDisplayName, PLATFORM_LABELS, PLATFORM_CLASSES,
  getPlatformUrl, getLastActivity, hasRecentActivityByOther, findCustomerByPhone,
  getNowJalaliDateTime, PAYMENT_STATUS_LABELS, createPayment,
  ensureProductPayments, syncProductStatus, getApprovedPaid, getOperationalBalance,
  getProductPayments, getPaymentEntryStatus, getWorstPaymentStatus,
  isPaymentFilled, areProductPaymentsFilled, isProductPriceLocked, isInvoiceClosed, PAYMENT_STATUS,
  computeCustomerLrfm, isProductCountableInSales
} from './utils.js'
import { paginateList, renderPaginationBar } from './pagination.js'

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
    renderPaginationBar('customerPagination', 'customers', { total: 0, from: 0, to: 0, page: 1, totalPages: 1 })
    updateStats()
    // Still update advisor dropdown in background
    updateAdvisorDropdown()
    return
  }

  const filterSig = `${search}|${advisorFilter}`
  const page = paginateList('customers', filtered, filterSig)

  tbody.innerHTML = page.items.map(c => {
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

  renderPaginationBar('customerPagination', 'customers', page)
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
  const currentUser = getCurrentUser()
  const admin = isAdmin()

  function inScope(c) {
    if (c.id.startsWith('LD') && !hasPermission('customers_ld')) return false
    if (c.id.startsWith('CS') && !hasPermission('customers_cs')) return false
    if (!admin && !ownsCustomer(c, currentUser)) return false
    return true
  }

  function hasPurchase(c) {
    return (c.products || []).some(p => {
      ensureProductPayments(p)
      return isProductCountableInSales(p)
    })
  }

  const scoped = data.customers.filter(inScope)

  // کل مخاطبین = همه ثبت‌شده‌ها در اسکوپ
  document.getElementById('stat-total').textContent = scoped.length
  // کل مشتریان = کسانی که فروش/خرید ثبت‌شده دارند
  document.getElementById('stat-ld').textContent = scoped.filter(hasPurchase).length
  document.getElementById('stat-cs').textContent = scoped.filter(c => c.id.startsWith('CS')).length
  document.getElementById('stat-following').textContent = scoped.filter(c =>
    data.followups.some(f => f.customerId === c.id)
  ).length
  document.getElementById('stat-converted').textContent = admin ? (data.convertedCount || 0) : 0

  let totalPaid = 0
  scoped.forEach(c => {
    ;(c.products || []).forEach(p => {
      ensureProductPayments(p)
      syncProductStatus(p)
      totalPaid += getApprovedPaid(p)
    })
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
    const newCustomer = { id, platformId, platform, name, phone, status, notes, advisor, advisorPhone, nextFollowupDate: '', products: [], createdAt: new Date().toISOString() }
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
  const lrfm = computeCustomerLrfm(c, data.followups)

  const detailUsers = await getUsersSafe()

  document.getElementById('detailTitle').textContent = `پنل مشتری — ${c.name || c.platformId}`

  const advisorHtml = isAdmin()
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

  const fmtDays = (n) => (n == null ? '—' : `${formatNumber(n)} روز`)
  const fmtMoney = (n) => `${formatNumber(n || 0)} ریال`

  let html = `
    <div class="detail-info">
      <div class="detail-field">
        <span class="detail-label">نام</span>
        <span class="detail-value">${escapeHtml(c.name) || '—'}</span>
      </div>
      <div class="detail-field">
        <span class="detail-label">شناسه</span>
        <span class="detail-value"><span class="id-badge ${idClass}">${escapeHtml(c.id)}</span></span>
      </div>
      <div class="detail-field">
        <span class="detail-label">شماره تماس</span>
        <span class="detail-value" style="direction:ltr;text-align:right;">${escapeHtml(c.phone) || '—'}</span>
      </div>
      <div class="detail-field">
        <span class="detail-label">کارشناس مسئول</span>
        <span class="detail-value">${advisorHtml}</span>
      </div>
      <div class="detail-field">
        <span class="detail-label">پلتفرم</span>
        <span class="detail-value">${escapeHtml(platformLabel)}</span>
      </div>
      <div class="detail-field">
        <span class="detail-label">ایدی پلتفرم</span>
        <span class="detail-value" style="font-family:'Vazirmatn',sans-serif;">${escapeHtml(c.platformId)}</span>
      </div>
    </div>

    <div class="detail-rfm">
      <div class="detail-rfm-title">شاخص‌های LRFM</div>
      <div class="rfm-table-wrap">
        <table class="rfm-table">
          <thead>
            <tr>
              <th title="Length — طول مدت ارتباط">L</th>
              <th title="Recency — آخرین پیگیری">R</th>
              <th title="Frequency — میانگین فاصله ارتباط">F</th>
              <th title="Monetary — مجموع پرداختی‌ها">M</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <span class="rfm-metric-label">طول مدت ارتباط</span>
                <span class="rfm-metric-value">${fmtDays(lrfm.L)}</span>
              </td>
              <td>
                <span class="rfm-metric-label">آخرین پیگیری</span>
                <span class="rfm-metric-value" style="font-family:'Vazirmatn',sans-serif;">${escapeHtml(lrfm.R) || '—'}</span>
              </td>
              <td>
                <span class="rfm-metric-label">میانگین فاصله ارتباط</span>
                <span class="rfm-metric-value">${fmtDays(lrfm.F)}</span>
              </td>
              <td>
                <span class="rfm-metric-label">مجموع پرداختی‌ها</span>
                <span class="rfm-metric-value">${fmtMoney(lrfm.M)}</span>
              </td>
            </tr>
          </tbody>
        </table>
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
      const authorName = resolveUserNameByPhone(f.createdByPhone, detailUsers)
      const authorHtml = authorName
        ? `<span class="record-author" title="ثبت‌کننده">👤 ${escapeHtml(authorName)}</span>`
        : ''
      html += `
        <div class="timeline-item">
          <div class="timeline-header">
            <span class="timeline-date">${f.date}</span>
            <span class="timeline-type">${escapeHtml(f.type)}</span>
            ${authorHtml}
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
  renderProducts(c.id, detailUsers)
}

function resolveUserNameByPhone(phone, users = []) {
  const p = normalizePhone(phone)
  if (!p) return ''
  const u = (users || []).find(x => normalizePhone(x.phone) === p)
  return u ? userDisplayName(u) : ''
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
  if (!isAdmin()) {
    showToast('فقط ادمین می‌تواند کارشناس مسئول را تغییر دهد')
    return
  }
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
const PRODUCT_STATUSES = ['تکمیل', 'بیعانه'] // kept for legacy references

export function getProducts(customerId) {
  const data = getData()
  const c = data.customers.find(x => x.id === customerId)
  if (!c || !c.products) return []
  c.products.forEach(p => {
    ensureProductPayments(p)
    syncProductStatus(p)
  })
  return c.products
}

export async function setProducts(customerId, products) {
  if (!requirePermission('customers_add')) return
  const data = getData()
  const idx = data.customers.findIndex(c => c.id === customerId)
  if (idx !== -1) {
    products.forEach(p => syncProductStatus(p))
    data.customers[idx].products = products
    await saveCustomerToDB(data.customers[idx])
  }
}
let detailUsersCache = []

export async function renderProducts(customerId, users = null) {
  const container = document.getElementById('detailProductsList')
  if (!container) return
  const products = getProducts(customerId)
  const canEdit = hasPermission('customers_add')
  if (users) detailUsersCache = users
  else if (!detailUsersCache.length) {
    try { detailUsersCache = await getUsersSafe() } catch (_) { detailUsersCache = [] }
  }
  const usersList = detailUsersCache

  if (products.length === 0) {
    container.innerHTML = '<div style="font-size:13px;color:var(--text-muted);padding:8px 0;">محصولی ثبت نشده</div>'
    return
  }

  container.innerHTML = products.map((p, i) => {
    const price = parseFloat(p.price) || 0
    const approved = getApprovedPaid(p)
    const balance = getOperationalBalance(p)
    const pays = getProductPayments(p)
    const worst = getWorstPaymentStatus(p)
    const closed = isInvoiceClosed(p)
    const priceLocked = isProductPriceLocked(p)
    const statusLabel = p.status || 'بیعانه'
    const statusColor = statusLabel === 'تکمیل' ? 'var(--success)' : 'var(--warning)'
    const blockClass = ['product-block', worst === 'rejected' ? 'is-rejected' : '', closed ? 'is-closed' : ''].filter(Boolean).join(' ')
    const closedBadge = closed ? '<span class="invoice-closed-badge">فاکتور بسته شده</span>' : ''

    const paymentsHtml = pays.map((pay, pi) => {
      const payStatus = getPaymentEntryStatus(pay)
      const payLabel = PAYMENT_STATUS_LABELS[payStatus] || payStatus
      const rejectHint = (payStatus === 'rejected' && pay.paymentRejectReason)
        ? `<span class="payment-reject-reason" title="${escapeAttr(pay.paymentRejectReason)}">${escapeHtml(pay.paymentRejectReason)}</span>`
        : ''
      const badge = `<span class="payment-badge payment-${payStatus}">${escapeHtml(payLabel)}</span>${rejectHint}`
      const canDeletePay = canEdit && payStatus !== PAYMENT_STATUS.approved
      const payEditable = canEdit && payStatus !== PAYMENT_STATUS.approved
      const incomplete = canEdit && !isPaymentFilled(pay)
      const sellerName = resolveUserNameByPhone(pay.soldByPhone || p.soldByPhone, usersList)
      const sellerHtml = sellerName
        ? `<span class="record-author" title="ثبت‌کننده فروش">👤 ${escapeHtml(sellerName)}</span>`
        : ''

      if (!payEditable) {
        return `
          <div class="product-row payment-row">
            <span class="payment-index">واریز ${pi + 1}${sellerHtml}</span>
            <span class="product-price" style="direction:ltr;">${pay.amount ? formatNumber(pay.amount) + ' ریال' : '—'}</span>
            <span class="product-settlement" style="direction:ltr;">${escapeHtml(pay.soldAt || '—')}</span>
            ${renderDestinationBankField(customerId, i, pi, pay, false)}
            <span style="font-size:13px;">${escapeHtml(pay.depositorName || '—')}</span>
            ${badge}
          </div>`
      }

      return `
        <div class="product-row payment-row${incomplete ? ' is-incomplete' : ''}">
          <span class="payment-index">واریز ${pi + 1}${sellerHtml}</span>
          <input type="text" inputmode="numeric" class="product-deposit num-input" placeholder="مبلغ واریز (ریال) *" value="${pay.amount ? formatNumber(pay.amount) : ''}" oninput="app.formatInput(this)" onblur="app.savePaymentField('${customerId}', ${i}, ${pi}, 'amount', app.unformatInput(this))" title="واحد: ریال">
          <input type="text" class="product-settlement" placeholder="تاریخ *" data-jdp value="${pay.soldAt ? pay.soldAt.split(' ')[0] : ''}" onchange="app.updatePaymentField('${customerId}', ${i}, ${pi}, 'soldAtDate', this.value)">
          <input type="time" class="product-settlement" value="${pay.soldAt && pay.soldAt.includes(' ') ? pay.soldAt.split(' ')[1] : ''}" onchange="app.updatePaymentField('${customerId}', ${i}, ${pi}, 'soldAtTime', this.value)">
          ${renderDestinationBankField(customerId, i, pi, pay, true)}
          <input type="text" class="product-settlement product-depositor" placeholder="نام واریزکننده *" value="${escapeAttr(pay.depositorName || '')}" onblur="app.updatePaymentField('${customerId}', ${i}, ${pi}, 'depositorName', this.value)">
          ${badge}
          ${canDeletePay ? `<button type="button" class="btn-remove-product" title="حذف واریز" onclick="app.removeProductPayment('${escapeAttr(customerId)}', ${i}, ${pi})">✕</button>` : ''}
        </div>`
    }).join('')

    let addPayBtn = ''
    if (canEdit && !closed) {
      const filled = areProductPaymentsFilled(p)
      const needsPrice = !price
      const disabled = !filled || needsPrice
      const title = needsPrice
        ? 'ابتدا قیمت کل را ثبت کنید'
        : (!filled ? 'ابتدا فیلدهای واریزهای فعلی را کامل کنید' : `مانده: ${formatNumber(balance)}`)
      addPayBtn = `<button type="button" class="btn btn-sm" style="margin-top:8px;" ${disabled ? 'disabled' : ''} title="${escapeAttr(title)}" onclick="app.addProductPayment('${escapeAttr(customerId)}', ${i})">+ ثبت واریز بعدی${balance > 0 ? ` (مانده: ${formatNumber(balance)})` : ''}</button>`
    }

    const priceHtml = (!canEdit || priceLocked)
      ? `<span class="product-price-locked" title="قیمت کل قفل شده">قیمت کل (ریال): <b style="font-family:'Vazirmatn',sans-serif;direction:ltr;">${price ? formatNumber(price) : '—'}</b></span>`
      : `<input type="text" inputmode="numeric" class="product-price num-input" placeholder="قیمت کل (ریال) *" value="${p.price ? formatNumber(p.price) : ''}" oninput="app.formatInput(this)" onblur="app.saveProductField('${customerId}', ${i}, 'price', app.unformatInput(this))" title="واحد: ریال">`

    const settlementHtml = canEdit && !closed
      ? `<input type="text" class="product-settlement" placeholder="تاریخ تسویه" data-jdp value="${p.settlementDate || ''}" onchange="app.updateProduct('${customerId}', ${i}, 'settlementDate', this.value)">`
      : (p.settlementDate ? `<span style="font-size:12px;color:var(--text-muted);">تسویه: ${escapeHtml(p.settlementDate)}</span>` : '')

    const nameHtml = canEdit && !closed
      ? `<select class="product-name" onchange="app.updateProduct('${customerId}', ${i}, 'name', this.value)">
            ${PRODUCTS.map(pr => `<option value="${pr}" ${p.name === pr ? 'selected' : ''}>${pr}</option>`).join('')}
          </select>`
      : `<span style="font-size:14px;font-weight:600;">${escapeHtml(p.name || '—')}</span>`

    return `
      <div class="${blockClass}">
        <div class="product-row product-head-row">
          ${nameHtml}
          <span class="product-status-label" style="color:${statusColor};">${escapeHtml(statusLabel)}</span>
          ${priceHtml}
          ${settlementHtml}
          <span class="product-meta">پرداخت‌شده: <b style="font-family:'Vazirmatn',sans-serif;direction:ltr;">${approved ? formatNumber(approved) : '۰'}</b></span>
          ${balance > 0 && !closed ? `<span class="product-balance negative">مانده: ${formatNumber(balance)}</span>` : ''}
          ${closedBadge}
        </div>
        <div class="payment-list">${paymentsHtml || '<div class="payment-empty">هنوز واریزی ثبت نشده</div>'}</div>
        ${addPayBtn}
      </div>`
  }).join('')

  if (window.jalaliDatepicker) {
    try { window.jalaliDatepicker.startWatch({ time: false }) } catch (_) { /* ignore */ }
  }
}

export async function addProductRow(customerId) {
  if (!requirePermission('customers_add')) return
  const products = getProducts(customerId)
  const user = getCurrentUser()
  const firstPay = createPayment({
    soldByPhone: normalizePhone(user?.phone || ''),
    depositorName: ''
  })
  products.push({
    name: PRODUCTS[0],
    status: 'بیعانه',
    price: '',
    priceLocked: false,
    deposit: '',
    settlementDate: '',
    soldByPhone: normalizePhone(user?.phone || ''),
    payments: [firstPay]
  })
  syncProductStatus(products[products.length - 1])
  await setProducts(customerId, products)
  renderProducts(customerId)
}

export async function addProductPayment(customerId, productIndex) {
  if (!requirePermission('customers_add')) return
  const products = getProducts(customerId)
  const product = products[productIndex]
  if (!product) return
  ensureProductPayments(product)
  syncProductStatus(product)

  if (isInvoiceClosed(product)) {
    showToast('فاکتور این محصول بسته شده و امکان ثبت واریز جدید نیست')
    return
  }
  if (!(parseFloat(product.price) || 0)) {
    showToast('ابتدا قیمت کل محصول را ثبت کنید')
    return
  }
  if (!areProductPaymentsFilled(product)) {
    showToast('ابتدا فیلدهای واریزهای فعلی را کامل کنید')
    return
  }

  const user = getCurrentUser()
  const balance = getOperationalBalance(product)
  const suggested = balance > 0 ? String(balance) : ''
  product.payments.push(createPayment({
    amount: suggested,
    soldByPhone: normalizePhone(user?.phone || ''),
    depositorName: ''
  }))
  syncProductStatus(product)
  await setProducts(customerId, products)
  renderProducts(customerId)
  showToast('واریز جدید اضافه شد — در انتظار تأیید حسابداری')
}

export async function removeProductPayment(customerId, productIndex, paymentIndex) {
  if (!requirePermission('customers_add')) return
  const products = getProducts(customerId)
  const product = products[productIndex]
  if (!product) return
  ensureProductPayments(product)
  const pay = product.payments[paymentIndex]
  if (!pay) return
  if (getPaymentEntryStatus(pay) === PAYMENT_STATUS.approved) {
    showToast('واریز تأییدشده قابل حذف نیست')
    return
  }
  if (!window.confirm('این واریز حذف شود؟')) return
  product.payments.splice(paymentIndex, 1)
  syncProductStatus(product)
  await setProducts(customerId, products)
  renderProducts(customerId)
  showToast('واریز حذف شد')
}

function resetPaymentEntry(pay) {
  pay.paymentStatus = 'pending'
  pay.paymentRejectReason = ''
  pay.paymentReviewedAt = ''
  pay.paymentReviewedBy = ''
}

export async function saveProductField(customerId, index, field, value) {
  const products = getProducts(customerId)
  const product = products[index]
  if (!product) return

  if (field === 'price') {
    if (isProductPriceLocked(product) && (parseFloat(product.price) || 0) > 0) {
      showToast('قیمت کل پس از ثبت قابل تغییر نیست')
      renderProducts(customerId)
      return
    }
    const num = parseFloat(value) || 0
    if (num <= 0) {
      showToast('قیمت کل را وارد کنید')
      return
    }
    product.price = String(num)
    product.priceLocked = true
  } else {
    product[field] = value
  }

  syncProductStatus(product)
  await setProducts(customerId, products)
  renderProducts(customerId)
}

export async function updateProduct(customerId, index, field, value) {
  const products = getProducts(customerId)
  const product = products[index]
  if (!product) return
  if (isInvoiceClosed(product) && field !== 'settlementDate') {
    showToast('فاکتور بسته شده و قابل ویرایش نیست')
    return
  }
  product[field] = value
  syncProductStatus(product)
  await setProducts(customerId, products)
  renderProducts(customerId)
}

export async function savePaymentField(customerId, productIndex, paymentIndex, field, value) {
  if (!requirePermission('customers_add')) return
  const products = getProducts(customerId)
  const product = products[productIndex]
  if (!product) return
  ensureProductPayments(product)
  const pay = product.payments[paymentIndex]
  if (!pay) return
  if (getPaymentEntryStatus(pay) === PAYMENT_STATUS.approved) {
    showToast('واریز تأییدشده قابل ویرایش نیست')
    return
  }
  pay[field] = value
  resetPaymentEntry(pay)
  syncProductStatus(product)
  await setProducts(customerId, products)
  renderProducts(customerId)
}

function renderDestinationBankField(customerId, productIndex, paymentIndex, pay, editable) {
  const banks = getDestinationBanks()
  const value = String(pay.destinationBank || '').trim()
  const inList = value && banks.some(b => b === value)
  const isCustom = !!(value && !inList)

  if (!editable) {
    return `<span style="font-size:13px;">${escapeHtml(value) || '—'}</span>`
  }

  const options = [
    `<option value="">بانک مقصد *</option>`,
    ...banks.map(b => `<option value="${escapeAttr(b)}" ${value === b ? 'selected' : ''}>${escapeHtml(b)}</option>`),
    `<option value="__custom__" ${isCustom ? 'selected' : ''}>سایر (ورود دستی)</option>`
  ].join('')

  return `
    <div class="product-bank-field">
      <select class="product-settlement" onchange="app.onDestinationBankSelect('${escapeAttr(customerId)}', ${productIndex}, ${paymentIndex}, this)">
        ${options}
      </select>
      <input type="text" class="product-settlement bank-custom-input" placeholder="نام بانک *" value="${isCustom ? escapeAttr(value) : ''}" style="${isCustom ? '' : 'display:none;'}" onblur="app.updatePaymentField('${escapeAttr(customerId)}', ${productIndex}, ${paymentIndex}, 'destinationBank', this.value)">
    </div>`
}

export function onDestinationBankSelect(customerId, productIndex, paymentIndex, selectEl) {
  const wrap = selectEl.closest('.product-bank-field')
  const customInput = wrap?.querySelector('.bank-custom-input')
  const val = selectEl.value
  if (val === '__custom__') {
    if (customInput) {
      customInput.style.display = ''
      customInput.focus()
    }
    return
  }
  if (customInput) {
    customInput.style.display = 'none'
    customInput.value = ''
  }
  updatePaymentField(customerId, productIndex, paymentIndex, 'destinationBank', val)
}

export async function updatePaymentField(customerId, productIndex, paymentIndex, field, value) {
  if (!requirePermission('customers_add')) return
  const products = getProducts(customerId)
  const product = products[productIndex]
  if (!product) return
  ensureProductPayments(product)
  const pay = product.payments[paymentIndex]
  if (!pay) return
  if (getPaymentEntryStatus(pay) === PAYMENT_STATUS.approved) {
    showToast('واریز تأییدشده قابل ویرایش نیست')
    return
  }

  if (field === 'soldAtDate') {
    const oldTime = (pay.soldAt || '').split(' ')[1] || ''
    pay.soldAt = oldTime ? `${value} ${oldTime}` : value
  } else if (field === 'soldAtTime') {
    const oldDate = (pay.soldAt || '').split(' ')[0] || ''
    pay.soldAt = oldDate ? `${oldDate} ${value}` : value
  } else {
    pay[field] = value
  }
  resetPaymentEntry(pay)
  syncProductStatus(product)
  await setProducts(customerId, products)
  renderProducts(customerId)
}

export async function removeProduct(customerId, index) {
  showToast('پس از ثبت محصول، امکان حذف وجود ندارد')
}

