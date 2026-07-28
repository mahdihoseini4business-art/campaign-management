import { supabase } from './supabase.js'
import { ADMIN_PHONE } from './config.js'
import { toEnDigits, escapeHtml, escapeAttr, showToast, getCurrentUser, setCurrentUser, clearCurrentUser, restoreSession, hasPermission, requirePermission, getDefaultPermissions, ALL_PERMISSIONS, PERMISSION_GROUPS, normalizePhone, userDisplayName, isMainAdmin, requireMainAdmin } from './utils.js'
import { getDestinationBanks, saveDestinationBanks } from './data.js'

// ============================================
// Password Hashing (PBKDF2)
// ============================================

const HASH_SECRET = import.meta.env.VITE_HASH_SECRET || 'c4mp_m4n4g3r_s3cr3t_k3y_2024'

export async function hashPassword(pw, username) {
  const encoder = new TextEncoder()
  const data = encoder.encode(pw)
  // PBKDF2 with per-user salt derived from username + secret
  const salt = encoder.encode(HASH_SECRET + ':' + (username || 'default') + ':salt')
  const keyMaterial = await crypto.subtle.importKey('raw', data, 'PBKDF2', false, ['deriveBits'])
  const hash = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256
  )
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0')).join('')
}

// ============================================
// Debug Helper (for testing in browser console)
// ============================================

export async function debugListUsers() {
  let users = []
  try { users = await getUsers() } catch (e) { console.error(e); return [] }
  console.table(users.map(u => ({
    username: u.username,
    first_name: u.first_name,
    last_name: u.last_name,
    phone: u.phone,
    role: u.role,
    display_name: u.display_name
  })))
  return users
}

export async function debugCreateTestUser(phone = '09123456789', firstName = 'تست', lastName = 'کاربر') {
  phone = normalizePhone(phone)
  let users = []
  try { users = await getUsers() } catch (e) { console.error(e); return }
  if (users.find(u => normalizePhone(u.phone) === phone)) {
    console.log('کاربر با این شماره وجود دارد')
    return
  }

  await saveUser({
    username: `user_${phone}`,
    first_name: firstName,
    last_name: lastName,
    phone,
    display_name: `${firstName} ${lastName}`,
    role: 'user',
    permissions: getDefaultPermissions()
  })
  console.log(`کاربر تست با شماره ${phone} ایجاد شد`)
}

// ============================================
// User CRUD (Supabase)
// ============================================

export async function getUsers() {
  const { data, error } = await supabase.from('users').select('*')
  if (error) {
    console.error('getUsers error:', error)
    throw error
  }
  return data || []
}

/** Like getUsers but returns [] on error (for non-critical UI). */
export async function getUsersSafe() {
  try {
    return await getUsers()
  } catch {
    return []
  }
}

export async function saveUser(user) {
  const { error } = await supabase.from('users').upsert(user, { onConflict: 'username' })
  if (error) {
    console.error('saveUser error:', error)
    return false
  }
  return true
}

export async function deleteUserFromDB(username) {
  const { error } = await supabase.from('users').delete().eq('username', username)
  if (error) {
    console.error('deleteUser error:', error)
    throw error
  }
}

// ============================================
// Seed Admin
// ============================================

export async function seedAdmin() {
  // Never seed if we cannot read users (e.g. RLS/network) — empty [] used to
  // falsely trigger creating a new admin and orphaning ownership links.
  let users
  try {
    users = await getUsers()
  } catch (e) {
    console.error('seedAdmin skipped: cannot load users', e)
    return
  }

  const adminPhone = normalizePhone(ADMIN_PHONE)

  // Ensure a stable admin row keyed by username; do not wipe others
  const existingAdmin = users.find(u => u.username === 'admin')
  if (existingAdmin) {
    // Keep phone stable if missing
    if (!existingAdmin.phone && adminPhone) {
      await saveUser({ ...existingAdmin, phone: adminPhone })
    }
    return
  }

  if (users.length > 0) {
    // Table has users but no admin — create admin without touching others
    await saveUser({
      username: 'admin',
      first_name: 'مدیر',
      last_name: 'سیستم',
      phone: adminPhone,
      display_name: 'مدیر سیستم',
      role: 'admin',
      permissions: null
    })
    console.log('Admin user created with phone:', adminPhone)
    return
  }

  // Truly empty users table
  await saveUser({
    username: 'admin',
    first_name: 'مدیر',
    last_name: 'سیستم',
    phone: adminPhone,
    display_name: 'مدیر سیستم',
    role: 'admin',
    permissions: null
  })
  console.log('Default admin created. Phone:', adminPhone)
}

// ============================================
// Login / Logout
// ============================================

const LOGIN_ATTEMPTS_KEY = 'campaign_login_attempts'
const MAX_LOGIN_ATTEMPTS = 5
const LOCKOUT_DURATION_MS = 5 * 60 * 1000 // 5 minutes

function getLoginAttempts() {
  try {
    const raw = localStorage.getItem(LOGIN_ATTEMPTS_KEY)
    if (!raw) return { count: 0, lockedUntil: 0 }
    const data = JSON.parse(raw)
    if (data.lockedUntil && Date.now() > data.lockedUntil) {
      localStorage.removeItem(LOGIN_ATTEMPTS_KEY)
      return { count: 0, lockedUntil: 0 }
    }
    return data
  } catch { return { count: 0, lockedUntil: 0 } }
}

function recordFailedLogin() {
  const attempts = getLoginAttempts()
  attempts.count++
  if (attempts.count >= MAX_LOGIN_ATTEMPTS) {
    attempts.lockedUntil = Date.now() + LOCKOUT_DURATION_MS
  }
  localStorage.setItem(LOGIN_ATTEMPTS_KEY, JSON.stringify(attempts))
}

function resetLoginAttempts() {
  localStorage.removeItem(LOGIN_ATTEMPTS_KEY)
}

export async function doLogin() {
  const username = toEnDigits(document.getElementById('loginUsername').value.trim())
  const password = toEnDigits(document.getElementById('loginPassword').value)
  const errorEl = document.getElementById('loginError')

  const attempts = getLoginAttempts()
  if (attempts.lockedUntil && Date.now() < attempts.lockedUntil) {
    const remaining = Math.ceil((attempts.lockedUntil - Date.now()) / 60000)
    errorEl.textContent = `تعداد تلاش‌ها بیش از حد مجاز است. ${remaining} دقیقه صبر کنید`
    errorEl.classList.add('show')
    return
  }

  if (!username || !password) {
    errorEl.textContent = 'نام کاربری و رمز عبور را وارد کنید'
    errorEl.classList.add('show')
    document.getElementById('loginPassword').value = ''
    return
  }

  const hash = await hashPassword(password, username)
  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('username', username)
    .eq('password_hash', hash)
    .single()

  if (error || !user) {
    recordFailedLogin()
    const remaining = getLoginAttempts()
    const left = MAX_LOGIN_ATTEMPTS - remaining.count
    errorEl.textContent = left > 0
      ? `نام کاربری یا رمز عبور اشتباه است (${left} تلاش باقی‌مانده)`
      : 'تعداد تلاش‌ها بیش از حد مجاز است. ۵ دقیقه صبر کنید'
    errorEl.classList.add('show')
    document.getElementById('loginPassword').value = ''
    return
  }

  resetLoginAttempts()
  await setCurrentUser({
    username: user.username,
    displayName: user.display_name,
    firstName: user.first_name,
    lastName: user.last_name,
    phone: user.phone,
    role: user.role,
    permissions: user.permissions || null
  })
  window.location.href = '/index.html'
}

export function doLogout() {
  clearCurrentUser()
  window.location.href = '/login.html'
}

/**
 * Restore signed session, then revalidate role/permissions from Supabase (SEC-M1, SEC-M2).
 * Client session is never trusted as the source of truth for privileges.
 */
export async function checkSession() {
  const localUser = await restoreSession()
  if (!localUser) {
    window.location.href = '/login.html'
    return null
  }

  const refreshed = await refreshSessionFromServer(localUser)
  if (!refreshed) {
    clearCurrentUser()
    window.location.href = '/login.html'
    return null
  }

  return refreshed
}

/** Pull latest role/permissions from DB; reject deleted/unknown users. */
export async function refreshSessionFromServer(localUser) {
  try {
    let query = supabase.from('users').select('username, first_name, last_name, phone, display_name, role, permissions')

    if (localUser.username) {
      query = query.eq('username', localUser.username)
    } else if (localUser.phone) {
      query = query.eq('phone', localUser.phone)
    } else {
      return null
    }

    const { data: rows, error } = await query.limit(1)
    if (error || !rows || rows.length === 0) {
      console.error('refreshSessionFromServer: user not found', error)
      return null
    }

    const user = rows[0]
    return await setCurrentUser({
      username: user.username,
      displayName: user.display_name || `${user.first_name || ''} ${user.last_name || ''}`.trim(),
      firstName: user.first_name,
      lastName: user.last_name,
      phone: user.phone,
      role: user.role,
      permissions: user.permissions || null
    })
  } catch (e) {
    console.error('refreshSessionFromServer error:', e)
    return null
  }
}

// ============================================
// Settings Modal
// ============================================

export async function openSettingsModal() {
  if (!requireMainAdmin()) return
  document.getElementById('newFirstName').value = ''
  document.getElementById('newLastName').value = ''
  document.getElementById('newPhone').value = ''
  document.getElementById('newRole').value = 'user'
  await renderUsersList()
  renderDestinationBanksSettings()
  document.getElementById('settingsModal').classList.add('active')
  document.getElementById('profileDropdown').classList.remove('active')
}

export function closeSettingsModal() {
  document.getElementById('settingsModal').classList.remove('active')
}

export async function addUser() {
  if (!requireMainAdmin()) return
  const firstName = document.getElementById('newFirstName').value.trim()
  const lastName = document.getElementById('newLastName').value.trim()
  const phone = normalizePhone(document.getElementById('newPhone').value.trim())
  const role = document.getElementById('newRole').value

  // اعتبارسنجی
  if (!firstName) { showToast('نام را وارد کنید'); return }
  if (!lastName) { showToast('نام خانوادگی را وارد کنید'); return }
  if (!phone || !/^09\d{9}$/.test(phone)) {
    showToast('شماره موبایل صحیح نیست (مثال: ۰۹۱۲۳۴۵۶۷۸۹)'); return
  }

  // بررسی تکراری بودن شماره — phone is the stable identity
  let users
  try {
    users = await getUsers()
  } catch (e) {
    showToast('خطا در خواندن لیست کاربران')
    return
  }
  if (users.find(u => normalizePhone(u.phone) === phone)) {
    showToast('این شماره موبایل قبلاً ثبت شده')
    return
  }

  // ذخیره کاربر — username derived from phone so recreate keeps same key
  const displayName = `${firstName} ${lastName}`
  try {
    await saveUser({
      username: `user_${phone}`,
      first_name: firstName,
      last_name: lastName,
      phone,
      display_name: displayName,
      role,
      permissions: role === 'admin' ? null : getDefaultPermissions()
    })
    await renderUsersList()
    showToast('کاربر اضافه شد')
  } catch (e) {
    console.error('addUser error:', e)
    showToast('خطا در اضافه کردن کاربر')
  }
}

export async function deleteUser(username) {
  if (!requireMainAdmin()) return
  if (username === 'admin') { showToast('امکان حذف مدیر وجود ندارد'); return }
  const currentUser = getCurrentUser()
  if (currentUser && currentUser.username === username) { showToast('امکان حذف کاربر جاری وجود ندارد'); return }

  document.getElementById('deleteMessage').textContent = `آیا از حذف کاربر "${username}" مطمئن هستید؟`
  document.getElementById('deleteConfirmBtn').onclick = async function () {
    try {
      await deleteUserFromDB(username)
      await renderUsersList()
      document.getElementById('deleteModal').classList.remove('active')
      showToast('کاربر حذف شد')
    } catch (e) {
      console.error('deleteUser error:', e)
      showToast('خطا در حذف کاربر')
    }
  }
  document.getElementById('deleteModal').classList.add('active')
}

export async function renderUsersList() {
  let users = []
  try {
    users = await getUsers()
  } catch (e) {
    console.error('renderUsersList error:', e)
    document.getElementById('settingsUsersList').innerHTML =
      '<div style="color:var(--danger);font-size:13px;">خطا در بارگذاری کاربران</div>'
    return
  }
  const container = document.getElementById('settingsUsersList')
  const currentUser = getCurrentUser()

  container.innerHTML = users.map(u => {
    const isCurrentUser = u.username === currentUser?.username
    const isAdminUser = u.username === 'admin' || u.role === 'admin'
    const perms = u.permissions || getDefaultPermissions()

    // نمایش نام کاربر
    const userDisplay = userDisplayName(u) || u.username
    const userPhone = u.phone || '—'
    const userRole = u.role === 'admin' ? 'مدیر' : 'کاربر'

    const permsHtml = (u.role === 'admin')
      ? '<div style="font-size:12px;color:var(--accent);margin-top:6px;">دسترسی کامل (مدیر)</div>'
      : PERMISSION_GROUPS.map(g => `
        <div style="margin-top:10px;">
          <div style="font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:4px;">${g.label}</div>
          <div style="display:flex;flex-wrap:wrap;gap:4px 12px;">
            ${g.keys.map(k => `
              <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;padding:3px 8px;border:1px solid var(--border);border-radius:4px;background:${perms[k] ? '#d1e7dd' : '#f8f9fa'};">
                <input type="checkbox" data-perm-user="${u.username}" data-perm-key="${k}" ${perms[k] ? 'checked' : ''} onchange="app.togglePermCheckbox(this)" style="width:14px;height:14px;">
                ${ALL_PERMISSIONS[k]}
              </label>
            `).join('')}
          </div>
        </div>
      `).join('')

    return `
      <div class="settings-user-row">
        <div class="settings-user-header" role="button" tabindex="0" aria-expanded="false" onclick="app.toggleSettingsUserRow(this)" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();app.toggleSettingsUserRow(this)}">
          <div class="user-info">
            <div class="user-name">${escapeHtml(userDisplay)} ${isCurrentUser ? '<span style="font-size:11px;color:var(--accent);">(شما)</span>' : ''}</div>
            <div class="user-role">📱 ${escapeHtml(userPhone)} · <span class="role-badge ${u.role === 'admin' ? 'role-admin' : 'role-user'}">${userRole}</span></div>
          </div>
          ${!isAdminUser ? `<button type="button" class="btn-icon" title="حذف" onclick="event.stopPropagation();app.deleteUser('${escapeAttr(u.username)}')" style="color:var(--danger);">🗑</button>` : ''}
          <span class="settings-user-chevron" aria-hidden="true">▾</span>
        </div>
        <div class="settings-user-body" hidden>
          ${u.role !== 'admin' ? `
          <div class="settings-user-perms">
            ${permsHtml}
            <button class="btn btn-sm btn-primary" style="margin-top:8px;" onclick="app.saveUserPermissions('${escapeAttr(u.username)}')">ذخیره دسترسی‌ها</button>
          </div>
          ` : `<div class="settings-user-perms">${permsHtml}</div>`}
        </div>
      </div>
    `
  }).join('')
}

export function toggleSettingsUserRow(headerEl) {
  if (!headerEl) return
  const row = headerEl.closest('.settings-user-row')
  if (!row) return
  const body = row.querySelector('.settings-user-body')
  if (!body) return
  const willOpen = body.hidden
  body.hidden = !willOpen
  row.classList.toggle('is-open', willOpen)
  headerEl.setAttribute('aria-expanded', willOpen ? 'true' : 'false')
}

export function renderDestinationBanksSettings() {
  const list = document.getElementById('settingsBanksList')
  if (!list) return
  const banks = getDestinationBanks()
  if (banks.length === 0) {
    list.innerHTML = '<div style="font-size:12px;color:var(--text-muted);padding:6px 0;">هنوز بانکی ثبت نشده</div>'
    return
  }
  list.innerHTML = banks.map((bank, idx) => `
    <div class="settings-bank-row">
      <span>${escapeHtml(bank)}</span>
      <button type="button" class="btn-icon" title="حذف" onclick="app.removeDestinationBank(${idx})" style="color:var(--danger);">🗑</button>
    </div>
  `).join('')
}

export async function addDestinationBank() {
  if (!requireMainAdmin()) return
  const input = document.getElementById('newDestinationBank')
  const name = (input?.value || '').trim()
  if (!name) { showToast('نام بانک را وارد کنید'); return }
  const banks = getDestinationBanks()
  if (banks.some(b => b.toLowerCase() === name.toLowerCase())) {
    showToast('این بانک قبلاً ثبت شده')
    return
  }
  try {
    await saveDestinationBanks([...banks, name])
    if (input) input.value = ''
    renderDestinationBanksSettings()
    showToast('بانک اضافه شد')
  } catch (e) {
    console.error('addDestinationBank error:', e)
    showToast('خطا در ذخیره بانک')
  }
}

export async function removeDestinationBank(index) {
  if (!requireMainAdmin()) return
  const banks = getDestinationBanks()
  if (index < 0 || index >= banks.length) return
  banks.splice(index, 1)
  try {
    await saveDestinationBanks(banks)
    renderDestinationBanksSettings()
    showToast('بانک حذف شد')
  } catch (e) {
    console.error('removeDestinationBank error:', e)
    showToast('خطا در حذف بانک')
  }
}

export async function saveUserPermissions(username) {
  if (!requireMainAdmin()) return

  const checkboxes = document.querySelectorAll(`input[data-perm-user="${username}"]`)
  if (checkboxes.length === 0) {
    showToast('برای کاربر مدیر نمی‌توان دسترسی جزئی ذخیره کرد')
    return
  }
  const permissions = {}
  checkboxes.forEach(cb => {
    permissions[cb.dataset.permKey] = cb.checked
  })

  const { error } = await supabase
    .from('users')
    .update({ permissions })
    .eq('username', username)

  if (error) {
    console.error('saveUserPermissions error:', error)
    showToast('خطا در ذخیره دسترسی‌ها')
  } else {
    const current = getCurrentUser()
    if (current && current.username === username && current.role !== 'admin') {
      setCurrentUser({ ...current, permissions })
      applyPermissions()
    }
    showToast('دسترسی‌ها ذخیره شد')
  }
}

export function togglePermCheckbox(el) {
  const label = el.closest('label')
  if (label) {
    label.style.background = el.checked ? '#d1e7dd' : '#f8f9fa'
  }
}

// ============================================
// Permissions UI
// ============================================

export function applyPermissions() {
  document.querySelectorAll('.tab').forEach(t => {
    const text = t.textContent.trim()
    let permKey = null
    if (text === 'داشبورد') permKey = 'dashboard'
    else if (text === 'لیست مشتریان') permKey = 'customers_view'
    else if (text === 'تاریخچه پیگیری') permKey = 'followups_view'
    else if (text === 'فروش‌ها') permKey = 'sales_view'
    else if (text === 'حسابداری') permKey = 'accounting'
    if (permKey && !hasPermission(permKey)) {
      t.style.display = 'none'
    } else {
      t.style.display = ''
    }
  })

  document.querySelectorAll('[data-perm]').forEach(el => {
    const key = el.getAttribute('data-perm')
    if (!key) return
    el.style.display = hasPermission(key) ? '' : 'none'
  })

  const settingsItem = document.querySelector('.profile-dropdown-item[onclick*="openSettingsModal"]')
  if (settingsItem) {
    settingsItem.style.display = isMainAdmin() ? '' : 'none'
  }

  const activeTab = document.querySelector('.tab.active')
  if (activeTab && activeTab.style.display === 'none') {
    const firstVisible = document.querySelector('.tab:not([style*="display: none"])')
    if (firstVisible) firstVisible.click()
  }
}

// ============================================
// Profile Menu
// ============================================

export function toggleProfileMenu() {
  const dropdown = document.getElementById('profileDropdown')
  const btn = document.getElementById('profileMenuBtn')
  if (!dropdown) return

  const willOpen = !dropdown.classList.contains('active')
  dropdown.classList.toggle('active', willOpen)
  dropdown.hidden = !willOpen
  btn?.setAttribute('aria-expanded', willOpen ? 'true' : 'false')

  if (willOpen) {
    const items = dropdown.querySelectorAll('[role="menuitem"]')
    items.forEach(item => { item.tabIndex = -1 })
    if (items[0]) {
      items[0].tabIndex = 0
      items[0].focus()
    }
  } else {
    btn?.focus()
  }
}

function closeProfileMenu() {
  const dropdown = document.getElementById('profileDropdown')
  const btn = document.getElementById('profileMenuBtn')
  if (!dropdown) return
  dropdown.classList.remove('active')
  dropdown.hidden = true
  btn?.setAttribute('aria-expanded', 'false')
}

export function initProfileMenu() {
  document.addEventListener('click', function (e) {
    const menu = document.querySelector('.profile-menu')
    if (menu && !menu.contains(e.target)) {
      closeProfileMenu()
    }
  })

  document.querySelector('.profile-menu')?.addEventListener('click', e => e.stopPropagation())

  const btn = document.getElementById('profileMenuBtn')
  const dropdown = document.getElementById('profileDropdown')
  if (!btn || !dropdown) return

  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (!dropdown.classList.contains('active')) toggleProfileMenu()
      else dropdown.querySelector('[role="menuitem"]')?.focus()
    }
    if (e.key === 'Escape') closeProfileMenu()
  })

  dropdown.addEventListener('keydown', (e) => {
    const items = [...dropdown.querySelectorAll('[role="menuitem"]')]
    const idx = items.indexOf(document.activeElement)

    if (e.key === 'Escape') {
      e.preventDefault()
      closeProfileMenu()
      btn.focus()
      return
    }

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!items.length) return
      const next = e.key === 'ArrowDown'
        ? items[(idx + 1) % items.length]
        : items[(idx - 1 + items.length) % items.length]
      items.forEach(item => { item.tabIndex = -1 })
      next.tabIndex = 0
      next.focus()
      return
    }

    if ((e.key === 'Enter' || e.key === ' ') && idx >= 0) {
      e.preventDefault()
      items[idx].click()
      closeProfileMenu()
    }
  })
}
