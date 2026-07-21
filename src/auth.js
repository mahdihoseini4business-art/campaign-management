import { supabase } from './supabase.js'
import { toEnDigits, escapeHtml, showToast, getCurrentUser, setCurrentUser, clearCurrentUser, hasPermission, getDefaultPermissions, ALL_PERMISSIONS, PERMISSION_GROUPS } from './utils.js'

// ============================================
// Password Hashing (SHA-256)
// ============================================

export async function hashPassword(pw, username) {
  const encoder = new TextEncoder()
  const data = encoder.encode(pw)
  // Use PBKDF2 with per-user salt for better security
  const salt = encoder.encode('campaign_manager_' + (username || 'default') + '_salt')
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
  if (error) console.error('saveUser error:', error)
}

export async function deleteUserFromDB(username) {
  const { error } = await supabase.from('users').delete().eq('username', username)
  if (error) console.error('deleteUser error:', error)
}

// ============================================
// Seed Admin
// ============================================

export async function seedAdmin() {
  const users = await getUsers()
  if (users.length === 0) {
    // NOTE: Change this password in production! Default: admin123
    const hash = await hashPassword('admin123', 'admin')
    await saveUser({
      username: 'admin',
      password_hash: hash,
      display_name: 'مدیر سیستم',
      role: 'admin',
      permissions: null
    })
  }
}

// ============================================
// Login / Logout
// ============================================

export async function doLogin() {
  const username = toEnDigits(document.getElementById('loginUsername').value.trim())
  const password = toEnDigits(document.getElementById('loginPassword').value)
  const errorEl = document.getElementById('loginError')

  if (!username || !password) {
    errorEl.textContent = 'نام کاربری و رمز عبور را وارد کنید'
    errorEl.classList.add('show')
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
    errorEl.textContent = 'نام کاربری یا رمز عبور اشتباه است'
    errorEl.classList.add('show')
    document.getElementById('loginPassword').value = ''
    return
  }

  setCurrentUser({ username: user.username, displayName: user.display_name, role: user.role, permissions: user.permissions || null })
  document.getElementById('loginOverlay').classList.add('hidden')
  errorEl.classList.remove('show')
  applyPermissions()
}

export function doLogout() {
  clearCurrentUser()
  location.reload()
}

export function checkSession() {
  const user = getCurrentUser()
  if (user) {
    document.getElementById('loginOverlay').classList.add('hidden')
    return user
  }
  // No session - show login
  document.getElementById('loginOverlay').classList.remove('hidden')
  return null
}

// ============================================
// Settings Modal
// ============================================

export async function openSettingsModal() {
  document.getElementById('newUsername').value = ''
  document.getElementById('newPassword').value = ''
  document.getElementById('newDisplayName').value = ''
  document.getElementById('newRole').value = 'user'
  await renderUsersList()
  document.getElementById('settingsModal').classList.add('active')
  document.getElementById('profileDropdown').classList.remove('active')
}

export function closeSettingsModal() {
  document.getElementById('settingsModal').classList.remove('active')
}

export async function addUser() {
  const username = toEnDigits(document.getElementById('newUsername').value.trim())
  const password = toEnDigits(document.getElementById('newPassword').value)
  const displayName = document.getElementById('newDisplayName').value.trim()
  const role = document.getElementById('newRole').value

  if (!username) { showToast('نام کاربری را وارد کنید'); return }
  if (!password) { showToast('رمز عبور را وارد کنید'); return }

  const users = await getUsers()
  if (users.find(u => u.username === username)) {
    showToast('این نام کاربری قبلاً ثبت شده')
    return
  }

  const hash = await hashPassword(password, username)
  await saveUser({
    username,
    password_hash: hash,
    display_name: displayName || username,
    role,
    permissions: role === 'admin' ? null : getDefaultPermissions()
  })
  await renderUsersList()
  showToast('کاربر اضافه شد')
}

export async function deleteUser(username) {
  if (username === 'admin') { showToast('امکان حذف مدیر وجود ندارد'); return }
  const currentUser = getCurrentUser()
  if (currentUser && currentUser.username === username) { showToast('امکان حذف کاربر جاری وجود ندارد'); return }

  // Use consistent confirmation style
  if (!window.confirm('آیا از حذف این کاربر مطمئن هستید؟')) return

  await deleteUserFromDB(username)
  await renderUsersList()
  showToast('کاربر حذف شد')
}

export async function renderUsersList() {
  const users = await getUsers()
  const container = document.getElementById('settingsUsersList')
  const currentUser = getCurrentUser()

  container.innerHTML = users.map(u => {
    const isCurrentUser = u.username === currentUser?.username
    const isAdminUser = u.username === 'admin'
    const perms = u.permissions || getDefaultPermissions()

    const permsHtml = (u.role === 'admin')
      ? '<div style="font-size:12px;color:var(--accent);margin-top:6px;">دسترسی کامل (مدیر)</div>'
      : PERMISSION_GROUPS.map(g => `
        <div style="margin-top:10px;">
          <div style="font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:4px;">${g.label}</div>
          <div style="display:flex;flex-wrap:wrap;gap:4px 12px;">
            ${g.keys.map(k => `
              <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;padding:3px 8px;border:1px solid var(--border);border-radius:4px;background:${perms[k] ? '#d1e7dd' : '#f8f9fa'};">
                <input type="checkbox" data-perm-user="${u.username}" data-perm-key="${k}" ${perms[k] ? 'checked' : ''} onchange="window.appTogglePermCheckbox(this)" style="width:14px;height:14px;">
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
            <div class="user-name">${escapeHtml(u.display_name || u.username)} ${isCurrentUser ? '<span style="font-size:11px;color:var(--accent);">(شما)</span>' : ''}</div>
            <div class="user-role">@${u.username} · <span class="role-badge ${u.role === 'admin' ? 'role-admin' : 'role-user'}">${u.role === 'admin' ? 'مدیر' : 'کاربر'}</span></div>
          </div>
          ${!isAdminUser ? `<button class="btn-icon" title="حذف" onclick="window.appDeleteUser('${u.username}')" style="color:var(--danger);">🗑</button>` : ''}
        </div>
        ${!isAdminUser ? `
        <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);">
          ${permsHtml}
          <button class="btn btn-sm btn-primary" style="margin-top:8px;" onclick="window.appSaveUserPermissions('${u.username}')">ذخیره دسترسی‌ها</button>
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
  if (settingsItem && !hasPermission('settings')) {
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
  document.getElementById('profileDropdown').classList.toggle('active')
}

export function initProfileMenu() {
  document.addEventListener('click', function (e) {
    const menu = document.querySelector('.profile-menu')
    if (menu && !menu.contains(e.target)) {
      document.getElementById('profileDropdown').classList.remove('active')
    }
  })
}
