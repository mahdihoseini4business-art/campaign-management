// ============================================
// Manual admin notifications (bell inbox + settings compose)
// ============================================

import { supabase } from './supabase.js'
import { getUsersSafe } from './auth.js'
import {
  escapeHtml,
  escapeAttr,
  showToast,
  getCurrentUser,
  normalizePhone,
  userDisplayName,
  requireMainAdmin,
  isMainAdmin,
  toJalali
} from './utils.js'

let cachedNotifications = []
let cachedReads = new Set()

function myPhone() {
  return normalizePhone(getCurrentUser()?.phone)
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
  return data || []
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
  for (const n of unread) cachedReads.add(Number(n.id))
  updateNotificationBadge()
}

export async function refreshNotifications() {
  try {
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

  // Close profile menu if open
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
  const modal = document.getElementById('notificationDetailModal')
  if (!modal) return

  if (titleEl) titleEl.textContent = notificationTitle(n)
  if (messageEl) messageEl.textContent = n.message || ''
  if (metaEl) {
    const when = formatNotificationDateTime(n.created_at)
    const who = (n.created_by_name || '').trim() || 'نامشخص'
    metaEl.innerHTML = `
      <div><span class="notif-detail-label">تاریخ و ساعت:</span> ${escapeHtml(when)}</div>
      <div><span class="notif-detail-label">فرستنده:</span> ${escapeHtml(who)}</div>
    `
  }

  closeNotificationMenu()
  modal.classList.add('active')
}

export function closeNotificationDetail() {
  document.getElementById('notificationDetailModal')?.classList.remove('active')
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

export async function renderNotificationAdminSection() {
  const section = document.getElementById('settingsNotificationsSection')
  const listEl = document.getElementById('notifRecipientList')
  if (!section || !listEl) return

  if (!isMainAdmin()) {
    section.style.display = 'none'
    return
  }
  section.style.display = ''

  const titleEl = document.getElementById('notifTitle')
  const msgEl = document.getElementById('notifMessage')
  const searchEl = document.getElementById('notifRecipientSearch')
  if (titleEl) titleEl.value = ''
  if (msgEl) msgEl.value = ''
  if (searchEl) searchEl.value = ''

  const users = (await getUsersSafe()).filter(u => u.phone)
  listEl.innerHTML = users.map(u => {
    const phone = normalizePhone(u.phone)
    const name = userDisplayName(u) || u.username || phone
    const label = `${name} · ${phone}`
    return `<label class="view-users-option" data-search="${escapeAttr(label.toLowerCase())}">
      <input type="checkbox" value="${escapeAttr(phone)}" class="notif-recipient-cb">
      <span>${escapeHtml(name)}</span>
      <span class="view-users-phone">${escapeHtml(phone)}</span>
    </label>`
  }).join('') || '<div style="font-size:12px;color:var(--text-muted);">کاربری برای انتخاب نیست</div>'
}

export function filterNotifRecipients(query) {
  const q = String(query || '').trim().toLowerCase()
  document.querySelectorAll('#notifRecipientList .view-users-option').forEach(el => {
    const hay = (el.dataset.search || '').toLowerCase()
    el.style.display = !q || hay.includes(q) ? '' : 'none'
  })
}

export function toggleAllNotifRecipients(checked) {
  document.querySelectorAll('#notifRecipientList .notif-recipient-cb').forEach(cb => {
    const row = cb.closest('.view-users-option')
    if (row && row.style.display === 'none') return
    cb.checked = !!checked
  })
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

  const user = getCurrentUser()
  const row = {
    title,
    message,
    recipient_phones: phones,
    created_by_phone: normalizePhone(user?.phone) || null,
    created_by_name: userDisplayName(user) || user?.username || null
  }

  const btn = document.getElementById('notifSendBtn')
  if (btn) btn.disabled = true
  try {
    const { error } = await supabase.from('notifications').insert(row)
    if (error) throw error
    showToast(`اعلان برای ${phones.length} نفر ارسال شد`)
    if (titleEl) titleEl.value = ''
    if (msgEl) msgEl.value = ''
    document.querySelectorAll('#notifRecipientList .notif-recipient-cb').forEach(cb => { cb.checked = false })
    const selectAll = document.getElementById('notifSelectAll')
    if (selectAll) selectAll.checked = false
    await refreshNotifications()
  } catch (e) {
    console.error('sendNotification error:', e)
    showToast('خطا در ارسال اعلان')
  } finally {
    if (btn) btn.disabled = false
  }
}
