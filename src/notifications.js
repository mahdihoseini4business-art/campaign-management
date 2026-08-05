// ============================================
// Manual admin notifications (bell inbox + settings compose)
// ============================================

import { supabase } from './supabase.js'
import { getUsersSafe } from './auth.js'
import { loadGroupsData, buildGroupedRecipientListHtml } from './groups.js'
import {
  escapeHtml,
  escapeAttr,
  showToast,
  getCurrentUser,
  normalizePhone,
  userDisplayName,
  requireMainAdmin,
  isMainAdmin,
  toJalali,
  jalaliDateTimeToIso,
  toEnDigits,
  normalizeTimeTo24h
} from './utils.js'

let cachedNotifications = []
let cachedReads = new Set()

function myPhone() {
  return normalizePhone(getCurrentUser()?.phone)
}

function isNotificationSender(n, phone = myPhone()) {
  if (!n || !phone) return false
  return normalizePhone(n.created_by_phone) === phone
}

/** Relative time: only دقیقه / ساعت / روز */
export function formatNotificationAge(isoDate) {
  const t = new Date(isoDate).getTime()
  if (!Number.isFinite(t)) return ''
  const diffMs = Math.max(0, Date.now() - t)
  const mins = Math.floor(diffMs / 60000)
  if (mins < 60) {
    const n = Math.max(1, mins)
    return `${n} دقیقه پیش`
  }
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} ساعت پیش`
  const days = Math.floor(hours / 24)
  return `${days} روز پیش`
}

/** ISO → Jalali "YYYY/MM/DD HH:MM" in Asia/Tehran */
function formatNotificationDateTime(isoDate) {
  const d = new Date(isoDate)
  if (!Number.isFinite(d.getTime())) return '—'
  const tehran = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Tehran' }))
  const j = toJalali(tehran)
  const date = `${j.year}/${String(j.month).padStart(2, '0')}/${String(j.day).padStart(2, '0')}`
  const time = `${String(tehran.getHours()).padStart(2, '0')}:${String(tehran.getMinutes()).padStart(2, '0')}`
  return `${date} ${time}`
}

function notificationTitle(n) {
  const t = (n?.title || '').trim()
  if (t) return t
  const msg = (n?.message || '').trim()
  if (!msg) return 'بدون عنوان'
  return msg.length > 60 ? `${msg.slice(0, 60)}…` : msg
}

function recipientsOf(row) {
  const raw = row?.recipient_phones
  if (!Array.isArray(raw)) return []
  return raw.map(p => normalizePhone(p)).filter(Boolean)
}

function isExpired(n, nowMs = Date.now()) {
  if (!n?.expires_at) return false
  const t = new Date(n.expires_at).getTime()
  return Number.isFinite(t) && t <= nowMs
}

async function purgeExpiredNotifications() {
  const nowIso = new Date().toISOString()
  const { error } = await supabase
    .from('notifications')
    .delete()
    .not('expires_at', 'is', null)
    .lte('expires_at', nowIso)
  if (error) console.error('purgeExpiredNotifications error:', error)
}

async function fetchNotifications() {
  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) {
    console.error('fetchNotifications error:', error)
    throw error
  }
  const now = Date.now()
  return (data || []).filter(n => !isExpired(n, now))
}

async function fetchMyReads(phone) {
  if (!phone) return new Set()
  const { data, error } = await supabase
    .from('notification_reads')
    .select('notification_id')
    .eq('user_phone', phone)
  if (error) {
    console.error('fetchMyReads error:', error)
    return new Set()
  }
  return new Set((data || []).map(r => Number(r.notification_id)))
}

function myNotifications() {
  const phone = myPhone()
  if (!phone) return []
  return cachedNotifications.filter(n => recipientsOf(n).includes(phone))
}

function mySentNotifications() {
  const phone = myPhone()
  if (!phone) return []
  return cachedNotifications.filter(n => isNotificationSender(n, phone))
}

function unreadCount() {
  return myNotifications().filter(n => !cachedReads.has(Number(n.id))).length
}

export function updateNotificationBadge() {
  const badge = document.getElementById('notificationBadge')
  if (!badge) return
  const count = unreadCount()
  if (count > 0) {
    badge.textContent = count > 99 ? '99+' : String(count)
    badge.style.display = ''
  } else {
    badge.style.display = 'none'
  }
}

function renderNotificationList() {
  const list = document.getElementById('notificationList')
  if (!list) return

  const items = myNotifications()
  if (!items.length) {
    list.innerHTML = '<div class="notification-empty">اعلانی برای نمایش نیست</div>'
    return
  }

  list.innerHTML = items.map(n => {
    const unread = !cachedReads.has(Number(n.id))
    const title = notificationTitle(n)
    return `<button type="button" class="notification-item${unread ? ' is-unread' : ''}" role="listitem" onclick="app.openNotificationDetail(${Number(n.id)})">
      <div class="notification-item-title">${escapeHtml(title)}</div>
      <div class="notification-item-meta">${escapeHtml(formatNotificationAge(n.created_at))}</div>
    </button>`
  }).join('')
}

function renderSentNotificationsList() {
  const listEl = document.getElementById('notifSentList')
  if (!listEl) return

  const items = mySentNotifications()
  if (!items.length) {
    listEl.innerHTML = '<div style="font-size:12px;color:var(--text-muted);">اعلان ارسال‌شده‌ای ندارید</div>'
    return
  }

  listEl.innerHTML = items.map(n => {
    const expireLabel = n.expires_at
      ? `حذف خودکار: ${formatNotificationDateTime(n.expires_at)}`
      : 'بدون حذف خودکار'
    return `<div class="notif-sent-row">
      <div class="notif-sent-main">
        <div class="notif-sent-title">${escapeHtml(notificationTitle(n))}</div>
        <div class="notif-sent-meta">${escapeHtml(formatNotificationAge(n.created_at))} · ${escapeHtml(expireLabel)}</div>
      </div>
      <button type="button" class="btn btn-danger btn-sm" onclick="app.deleteNotification(${Number(n.id)})">حذف</button>
    </div>`
  }).join('')
}

async function markMyNotificationsRead() {
  const phone = myPhone()
  if (!phone) return
  const unread = myNotifications().filter(n => !cachedReads.has(Number(n.id)))
  if (!unread.length) return

  const rows = unread.map(n => ({
    user_phone: phone,
    notification_id: n.id,
    read_at: new Date().toISOString()
  }))

  const { error } = await supabase
    .from('notification_reads')
    .upsert(rows, { onConflict: 'user_phone,notification_id' })
  if (error) {
    console.error('markMyNotificationsRead error:', error)
    return
  }
  import('./live-sync.js').then(m => m.noteLocalWrite()).catch(() => {})
  for (const n of unread) cachedReads.add(Number(n.id))
  updateNotificationBadge()
}

export async function refreshNotifications() {
  try {
    await purgeExpiredNotifications()
    const phone = myPhone()
    const [rows, reads] = await Promise.all([
      fetchNotifications(),
      fetchMyReads(phone)
    ])
    cachedNotifications = rows
    cachedReads = reads
  } catch (e) {
    console.error('refreshNotifications error:', e)
    cachedNotifications = []
    cachedReads = new Set()
  }
  renderNotificationList()
  updateNotificationBadge()
  renderSentNotificationsList()
}

export function closeNotificationMenu() {
  const dropdown = document.getElementById('notificationDropdown')
  const btn = document.getElementById('notificationMenuBtn')
  if (!dropdown) return
  dropdown.classList.remove('active')
  dropdown.hidden = true
  btn?.setAttribute('aria-expanded', 'false')
}

export async function toggleNotificationMenu() {
  const dropdown = document.getElementById('notificationDropdown')
  const btn = document.getElementById('notificationMenuBtn')
  if (!dropdown) return

  const willOpen = !dropdown.classList.contains('active')

  document.getElementById('profileDropdown')?.classList.remove('active')
  const profileBtn = document.getElementById('profileMenuBtn')
  const profileDd = document.getElementById('profileDropdown')
  if (profileDd) profileDd.hidden = true
  profileBtn?.setAttribute('aria-expanded', 'false')

  dropdown.classList.toggle('active', willOpen)
  dropdown.hidden = !willOpen
  btn?.setAttribute('aria-expanded', willOpen ? 'true' : 'false')

  if (willOpen) {
    await refreshNotifications()
    renderNotificationList()
    await markMyNotificationsRead()
    renderNotificationList()
  } else {
    btn?.focus()
  }
}

export function openNotificationDetail(id) {
  const n = cachedNotifications.find(x => Number(x.id) === Number(id))
  if (!n) {
    showToast('اعلان پیدا نشد')
    return
  }

  const titleEl = document.getElementById('notifDetailTitle')
  const messageEl = document.getElementById('notifDetailMessage')
  const metaEl = document.getElementById('notifDetailMeta')
  const deleteBtn = document.getElementById('notifDetailDeleteBtn')
  const modal = document.getElementById('notificationDetailModal')
  if (!modal) return

  if (titleEl) titleEl.textContent = notificationTitle(n)
  if (messageEl) messageEl.textContent = n.message || ''
  if (metaEl) {
    const when = formatNotificationDateTime(n.created_at)
    const who = (n.created_by_name || '').trim() || 'نامشخص'
    const expireLine = n.expires_at
      ? `<div><span class="notif-detail-label">حذف خودکار:</span> ${escapeHtml(formatNotificationDateTime(n.expires_at))}</div>`
      : ''
    metaEl.innerHTML = `
      <div><span class="notif-detail-label">تاریخ و ساعت:</span> ${escapeHtml(when)}</div>
      <div><span class="notif-detail-label">فرستنده:</span> ${escapeHtml(who)}</div>
      ${expireLine}
    `
  }

  if (deleteBtn) {
    const canDelete = isNotificationSender(n)
    deleteBtn.style.display = canDelete ? '' : 'none'
    deleteBtn.onclick = canDelete ? () => deleteNotification(n.id) : null
  }

  closeNotificationMenu()
  modal.classList.add('active')
}

export function closeNotificationDetail() {
  document.getElementById('notificationDetailModal')?.classList.remove('active')
}

export function deleteNotification(id) {
  const n = cachedNotifications.find(x => Number(x.id) === Number(id))
  if (!n) {
    showToast('اعلان پیدا نشد')
    return
  }
  if (!isNotificationSender(n) && !isMainAdmin()) {
    showToast('فقط فرستنده می‌تواند اعلان را حذف کند')
    return
  }

  const msgEl = document.getElementById('deleteMessage')
  const confirmBtn = document.getElementById('deleteConfirmBtn')
  if (!msgEl || !confirmBtn) return

  msgEl.textContent = `آیا از حذف اعلان «${notificationTitle(n)}» مطمئن هستید؟`
  confirmBtn.onclick = async () => {
    try {
      const { error } = await supabase.from('notifications').delete().eq('id', n.id)
      if (error) throw error
      import('./live-sync.js').then(m => m.noteLocalWrite()).catch(() => {})
      document.getElementById('deleteModal')?.classList.remove('active')
      closeNotificationDetail()
      showToast('اعلان حذف شد')
      await refreshNotifications()
    } catch (e) {
      console.error('deleteNotification error:', e)
      showToast('خطا در حذف اعلان')
    }
  }
  document.getElementById('deleteModal')?.classList.add('active')
}

export function initNotificationMenu() {
  document.addEventListener('click', (e) => {
    const menu = document.querySelector('.notification-menu')
    if (menu && !menu.contains(e.target)) closeNotificationMenu()
  })
  document.querySelector('.notification-menu')?.addEventListener('click', e => e.stopPropagation())

  const btn = document.getElementById('notificationMenuBtn')
  btn?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeNotificationMenu()
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      toggleNotificationMenu()
    }
  })
}

// ============================================
// Admin compose (settings modal)
// ============================================

function clearComposeFields() {
  const titleEl = document.getElementById('notifTitle')
  const msgEl = document.getElementById('notifMessage')
  const searchEl = document.getElementById('notifRecipientSearch')
  const expireDateEl = document.getElementById('notifExpireDate')
  const expireTimeEl = document.getElementById('notifExpireTime')
  const selectAll = document.getElementById('notifSelectAll')
  if (titleEl) titleEl.value = ''
  if (msgEl) msgEl.value = ''
  if (searchEl) searchEl.value = ''
  if (expireDateEl) expireDateEl.value = ''
  if (expireTimeEl) expireTimeEl.value = ''
  if (selectAll) selectAll.checked = false
  document.querySelectorAll('#notifRecipientList .notif-recipient-cb').forEach(cb => { cb.checked = false })
  updateNotifRecipientCount()
}

export function updateNotifRecipientCount() {
  const el = document.getElementById('notifRecipientCount')
  if (!el) return
  const checked = document.querySelectorAll('#notifRecipientList .notif-recipient-cb:checked').length
  const total = document.querySelectorAll('#notifRecipientList .notif-recipient-cb').length
  el.textContent = checked === 0
    ? (total ? `۰ از ${total} نفر انتخاب شده` : 'گیرنده‌ای نیست')
    : `${checked} از ${total} نفر انتخاب شده`

  const selectAll = document.getElementById('notifSelectAll')
  if (selectAll && total) {
    const visible = [...document.querySelectorAll('#notifRecipientList .notif-member-row')]
      .filter(row => row.style.display !== 'none' && row.closest('.notif-group-block')?.style.display !== 'none')
    const visibleCbs = visible.map(row => row.querySelector('.notif-recipient-cb')).filter(Boolean)
    selectAll.checked = visibleCbs.length > 0 && visibleCbs.every(cb => cb.checked)
  }

  syncNotifGroupCheckboxes()
}

function syncNotifGroupCheckboxes() {
  document.querySelectorAll('#notifRecipientList .notif-group-block[data-group-block]').forEach(block => {
    const groupCb = block.querySelector('.notif-group-cb')
    if (!groupCb) return
    const memberCbs = [...block.querySelectorAll('.notif-recipient-cb')]
      .filter(cb => {
        const row = cb.closest('.notif-member-row')
        return row && row.style.display !== 'none'
      })
    if (!memberCbs.length) {
      groupCb.checked = false
      groupCb.indeterminate = false
      return
    }
    const checkedCount = memberCbs.filter(cb => cb.checked).length
    groupCb.checked = checkedCount === memberCbs.length
    groupCb.indeterminate = checkedCount > 0 && checkedCount < memberCbs.length
  })
}

export async function renderNotificationAdminSection() {
  const listEl = document.getElementById('notifRecipientList')
  if (!listEl) return

  if (!isMainAdmin()) return

  clearComposeFields()

  const users = (await getUsersSafe()).filter(u => u.phone)
  try { await loadGroupsData() } catch (_) { /* optional */ }
  listEl.innerHTML = buildGroupedRecipientListHtml(users)

  updateNotifRecipientCount()

  await refreshNotifications()
  if (window.jalaliDatepicker) {
    try { window.jalaliDatepicker.startWatch({ selector: 'input[data-jdp]', time: false, zIndex: 11000 }) } catch (_) { /* ignore */ }
  }
}

export function filterNotifRecipients(query) {
  const q = String(query || '').trim().toLowerCase()
  document.querySelectorAll('#notifRecipientList .notif-group-block').forEach(block => {
    const blockHay = (block.dataset.search || '').toLowerCase()
    let anyMemberVisible = false
    block.querySelectorAll('.notif-member-row').forEach(el => {
      const hay = (el.dataset.search || '').toLowerCase()
      const show = !q || hay.includes(q) || blockHay.includes(q)
      el.style.display = show ? '' : 'none'
      if (show) anyMemberVisible = true
    })
    // If query matches group name, show whole block; else only if a member matches
    const groupMatch = !q || blockHay.includes(q)
    block.style.display = (!q || groupMatch || anyMemberVisible) ? '' : 'none'
    if (groupMatch && q) {
      block.querySelectorAll('.notif-member-row').forEach(el => { el.style.display = '' })
    }
  })
  updateNotifRecipientCount()
}

export function toggleAllNotifRecipients(checked) {
  document.querySelectorAll('#notifRecipientList .notif-recipient-cb').forEach(cb => {
    const row = cb.closest('.notif-member-row')
    const block = cb.closest('.notif-group-block')
    if (row && row.style.display === 'none') return
    if (block && block.style.display === 'none') return
    cb.checked = !!checked
  })
  updateNotifRecipientCount()
}

export function toggleNotifGroup(groupId, checked) {
  const block = document.querySelector(`#notifRecipientList .notif-group-block[data-group-block="${groupId}"]`)
  if (!block) return
  block.querySelectorAll('.notif-recipient-cb').forEach(cb => {
    const row = cb.closest('.notif-member-row')
    if (row && row.style.display === 'none') return
    cb.checked = !!checked
  })
  updateNotifRecipientCount()
}

export function onNotifRecipientChange() {
  updateNotifRecipientCount()
}

function parseExpireAtFromForm() {
  const dateRaw = toEnDigits(document.getElementById('notifExpireDate')?.value || '').trim()
  const timeRaw = toEnDigits(document.getElementById('notifExpireTime')?.value || '').trim()

  if (!dateRaw && !timeRaw) return { ok: true, expiresAt: null }

  if (!dateRaw) {
    return { ok: false, error: 'برای حذف خودکار، تاریخ را وارد کنید' }
  }

  const time24 = timeRaw ? normalizeTimeTo24h(timeRaw) : '00:00'
  if (timeRaw && !time24) {
    return { ok: false, error: 'ساعت حذف خودکار معتبر نیست (مثلاً ۱۴:۳۰)' }
  }

  const expiresAt = jalaliDateTimeToIso(dateRaw, time24 || '00:00')
  if (!expiresAt) {
    return { ok: false, error: 'تاریخ حذف خودکار معتبر نیست' }
  }

  if (new Date(expiresAt).getTime() <= Date.now()) {
    return { ok: false, error: 'زمان حذف خودکار باید در آینده باشد' }
  }

  return { ok: true, expiresAt }
}

export async function sendNotification() {
  if (!requireMainAdmin()) return

  const titleEl = document.getElementById('notifTitle')
  const msgEl = document.getElementById('notifMessage')
  const title = (titleEl?.value || '').trim()
  const message = (msgEl?.value || '').trim()

  if (!title) {
    showToast('عنوان اعلان را وارد کنید')
    return
  }
  if (!message) {
    showToast('متن اعلان را وارد کنید')
    return
  }

  const phones = [...document.querySelectorAll('#notifRecipientList .notif-recipient-cb:checked')]
    .map(cb => normalizePhone(cb.value))
    .filter(Boolean)

  if (!phones.length) {
    showToast('حداقل یک عضو را انتخاب کنید')
    return
  }

  const expire = parseExpireAtFromForm()
  if (!expire.ok) {
    showToast(expire.error)
    return
  }

  const user = getCurrentUser()
  const row = {
    title,
    message,
    recipient_phones: phones,
    created_by_phone: normalizePhone(user?.phone) || null,
    created_by_name: userDisplayName(user) || user?.username || null,
    expires_at: expire.expiresAt
  }

  const btn = document.getElementById('notifSendBtn')
  if (btn) btn.disabled = true
  try {
    const { data: inserted, error } = await supabase.from('notifications').insert(row).select('id').single()
    if (error) throw error
    import('./live-sync.js').then(m => m.noteLocalWrite()).catch(() => {})
    try {
      const { broadcastManualNotifToast } = await import('./sale-toasts.js')
      await broadcastManualNotifToast({
        id: inserted?.id || null,
        title,
        message,
        senderName: row.created_by_name || '',
        recipientPhones: phones,
        at: Date.now()
      })
    } catch (e) {
      console.error('manual notif toast broadcast error:', e)
    }
    showToast(`اعلان برای ${phones.length} نفر ارسال شد`)
    clearComposeFields()
    await refreshNotifications()
  } catch (e) {
    console.error('sendNotification error:', e)
    showToast('خطا در ارسال اعلان')
  } finally {
    if (btn) btn.disabled = false
  }
}
