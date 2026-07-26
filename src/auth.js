import { supabase } from './supabase.js'
import { toEnDigits, escapeHtml, escapeAttr, showToast, getCurrentUser, setCurrentUser, clearCurrentUser, hasPermission, getDefaultPermissions, ALL_PERMISSIONS, PERMISSION_GROUPS } from './utils.js'

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
  const users = await getUsers()
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
  const users = await getUsers()
  if (users.find(u => u.phone === phone)) {
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
    return []
  }
  return data || []
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
  const users = await getUsers()

  if (users.length === 0) {
    // Create default admin user with phone for OTP login
    // NOTE: Change the phone number in production!
    await saveUser({
      username: 'admin',
      first_name: 'مدیر',
      last_name: 'سیستم',
      phone: '09123456789',
      display_name: 'مدیر سیستم',
      role: 'admin',
      permissions: null
    })
    console.log('Default admin created. Phone: 09123456789')
  }
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
  await setCurrentUser({ username: user.username, displayName: user.display_name, role: user.role, permissions: user.permissions || null })
  window.location.href = '/index.html'
}

export function doLogout() {
  clearCurrentUser()
  window.location.href = '/login.html'
}

export function checkSession() {
  const user = getCurrentUser()
  if (user) {
    return user
  }
  // No session - redirect to login
  window.location.href = '/login.html'
  return null
}

// ============================================
// Settings Modal
// ============================================

export async function openSettingsModal() {
  const currentUser = getCurrentUser()
  if (!currentUser || currentUser.role !== 'admin') {
    showToast('فقط مدیر سیستم به تنظیمات دسترسی دارد')
    return
  }
  document.getElementById('newFirstName').value = ''
  document.getElementById('newLastName').value = ''
  document.getElementById('newPhone').value = ''
  document.getElementById('newRole').value = 'user'
  await renderUsersList()
  document.getElementById('settingsModal').classList.add('active')
  document.getElementById('profileDropdown').classList.remove('active')
}

export function closeSettingsModal() {
  document.getElementById('settingsModal').classList.remove('active')
}

export async function addUser() {
  const firstName = document.getElementById('newFirstName').value.trim()
  const lastName = document.getElementById('newLastName').value.trim()
  const phone = toEnDigits(document.getElementById('newPhone').value.trim())
  const role = document.getElementById('newRole').value

  // اعتبارسنجی
  if (!firstName) { showToast('نام را وارد کنید'); return }
  if (!lastName) { showToast('نام خانوادگی را وارد کنید'); return }
  if (!phone || !/^09\d{9}$/.test(phone)) {
    showToast('شماره موبایل صحیح نیست (مثال: ۰۹۱۲۳۴۵۶۷۸۹)'); return
  }

  // بررسی تکراری بودن شماره
  const users = await getUsers()
  if (users.find(u => u.phone === phone)) {
    showToast('این شماره موبایل قبلاً ثبت شده')
    return
  }

  // ذخیره کاربر
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
  const users = await getUsers()
  const container = document.getElementById('settingsUsersList')
  const currentUser = getCurrentUser()

  container.innerHTML = users.map(u => {
    const isCurrentUser = u.username === currentUser?.username
    const isAdminUser = u.username === 'admin'
    const perms = u.permissions || getDefaultPermissions()

    // نمایش نام کاربر
    const userDisplayName = u.display_name || `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.username
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
      <div class="settings-user-row" style="flex-direction:column;align-items:stretch;">
        <div style="display:flex;align-items:center;gap:10px;">
          <div class="user-info">
            <div class="user-name">${escapeHtml(userDisplayName)} ${isCurrentUser ? '<span style="font-size:11px;color:var(--accent);">(شما)</span>' : ''}</div>
            <div class="user-role">📱 ${escapeHtml(userPhone)} · <span class="role-badge ${u.role === 'admin' ? 'role-admin' : 'role-user'}">${userRole}</span></div>
          </div>
          ${!isAdminUser ? `<button class="btn-icon" title="حذف" onclick="app.deleteUser('${escapeAttr(u.username)}')" style="color:var(--danger);">🗑</button>` : ''}
        </div>
        ${!isAdminUser ? `
        <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);">
          ${permsHtml}
          <button class="btn btn-sm btn-primary" style="margin-top:8px;" onclick="app.saveUserPermissions('${escapeAttr(u.username)}')">ذخیره دسترسی‌ها</button>
        </div>
        ` : ''}
      </div>
    `
  }).join('')
}

export async function saveUserPermissions(username) {
  const checkboxes = document.querySelectorAll(`input[data-perm-user="${username}"]`)
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
    if (text === 'داشبرد') permKey = 'dashboard'
    else if (text === 'لیست مشتریان') permKey = 'customers_view'
    else if (text === 'تاریخچه پیگیری') permKey = 'followups_view'
    else if (text === 'فروش‌ها') permKey = 'sales_view'
    if (permKey && !hasPermission(permKey)) {
      t.style.display = 'none'
    } else {
      t.style.display = ''
    }
  })

  const settingsItem = document.querySelector('.profile-dropdown-item[onclick*="openSettingsModal"]')
  const currentUser = getCurrentUser()
  if (settingsItem && (!currentUser || currentUser.role !== 'admin')) {
    settingsItem.style.display = 'none'
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
