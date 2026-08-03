import { supabase } from './supabase.js'
import { ADMIN_PHONE } from './config.js'
import { toEnDigits, escapeHtml, escapeAttr, showToast, getCurrentUser, setCurrentUser, clearCurrentUser, restoreSession, hasPermission, requirePermission, getDefaultPermissions, ALL_PERMISSIONS, PERMISSION_GROUPS, normalizePhone, userDisplayName, isMainAdmin, requireMainAdmin, applyAccountingPermissionBundle, ACCOUNTING_PERMISSION_BUNDLE, normalizeViewUserPhones, syncToolbarActionsMenus, formatNumber, jalaliToNum } from './utils.js'
import { getDestinationBanks, saveDestinationBanks, getProductCatalog, saveProductCatalog, getPlatforms, savePlatforms, getStatuses, saveStatuses, getSalesTargets, saveSalesTargets } from './data.js'

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
    permissions: user.permissions || null,
    viewUserPhones: user.permissions?.viewUserPhones
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
      permissions: user.permissions || null,
      viewUserPhones: user.permissions?.viewUserPhones
    })
  } catch (e) {
    console.error('refreshSessionFromServer error:', e)
    return null
  }
}

// ============================================
// Settings Shell
// ============================================

const SETTINGS_SECTIONS = [
  { id: 'users', label: 'کاربران و دسترسی‌ها', group: null, keywords: 'کاربر دسترسی permission user admin' },
  { id: 'banks', label: 'بانک‌های مقصد', group: 'داده‌های پایه', keywords: 'بانک واریز bank destination' },
  { id: 'products', label: 'کاتالوگ محصولات', group: 'داده‌های پایه', keywords: 'محصول product catalog' },
  { id: 'sales-targets', label: 'تارگت‌های فروش', group: 'داده‌های پایه', keywords: 'تارگت هدف فروش target goal quota' },
  { id: 'platforms', label: 'پلتفرم‌ها', group: 'داده‌های پایه', keywords: 'پلتفرم platform' },
  { id: 'statuses', label: 'وضعیت‌های مشتری', group: 'داده‌های پایه', keywords: 'وضعیت status' },
  { id: 'notif-compose', label: 'ارسال اعلان', group: 'اعلان‌ها', keywords: 'اعلان notification ارسال' },
  { id: 'notif-prefs', label: 'ترجیحات اعلان', group: 'اعلان‌ها', keywords: 'toast فروش زنده ترجیح' },
  { id: 'notif-history', label: 'تاریخچه اعلان‌ها', group: 'اعلان‌ها', keywords: 'تاریخچه ارسال‌شده' }
]

let _settingsSection = 'users'
let _settingsUsersCache = []
let _selectedSettingsUser = null
let _permissionsDirty = false
let _settingsEscapeBound = false
let _editingBankIdx = null
let _editingProductIdx = null
let _editingPlatformIdx = null
let _editingStatusIdx = null
let _editingSalesTargetId = null

function ensureSettingsEscapeHandler() {
  if (_settingsEscapeBound) return
  _settingsEscapeBound = true
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    const modal = document.getElementById('settingsModal')
    if (!modal?.classList.contains('active')) return
    if (document.getElementById('deleteModal')?.classList.contains('active')) return
    e.preventDefault()
    closeSettingsModal()
  })
}

export function renderSettingsNav(filterQuery = '') {
  const list = document.getElementById('settingsNavList')
  const select = document.getElementById('settingsNavSelect')
  if (!list || !select) return

  const q = toEnDigits(String(filterQuery || '')).trim().toLowerCase()
  const visible = SETTINGS_SECTIONS.filter(s => {
    if (!q) return true
    const hay = `${s.label} ${s.group || ''} ${s.keywords}`.toLowerCase()
    return hay.includes(q)
  })

  let html = ''
  let lastGroup = undefined
  visible.forEach(s => {
    if (s.group !== lastGroup) {
      lastGroup = s.group
      if (s.group) html += `<div class="settings-nav-group">${escapeHtml(s.group)}</div>`
    }
    html += `<button type="button" class="settings-nav-item${_settingsSection === s.id ? ' is-active' : ''}" data-settings-nav="${escapeAttr(s.id)}" onclick="app.switchSettingsSection('${escapeAttr(s.id)}')">${escapeHtml(s.label)}</button>`
  })
  list.innerHTML = html || '<div class="settings-nav-empty">بخشی یافت نشد</div>'

  select.innerHTML = SETTINGS_SECTIONS.map(s =>
    `<option value="${escapeAttr(s.id)}"${_settingsSection === s.id ? ' selected' : ''}>${s.group ? `${escapeHtml(s.group)} — ` : ''}${escapeHtml(s.label)}</option>`
  ).join('')
}

export function filterSettingsNav(query) {
  renderSettingsNav(query)
}

export function switchSettingsSection(sectionId) {
  if (!SETTINGS_SECTIONS.some(s => s.id === sectionId)) return
  if (_settingsSection === 'users' && sectionId !== 'users' && _permissionsDirty) {
    openSettingsConfirm(
      'تغییرات دسترسی ذخیره‌نشده دارید. ادامه می‌دهید؟',
      () => {
        _permissionsDirty = false
        applySettingsSection(sectionId)
      },
      'ادامه'
    )
    return
  }
  applySettingsSection(sectionId)
}

function applySettingsSection(sectionId) {
  _settingsSection = sectionId
  document.querySelectorAll('[data-settings-pane]').forEach(pane => {
    pane.hidden = pane.getAttribute('data-settings-pane') !== sectionId
  })
  document.querySelectorAll('[data-settings-nav]').forEach(btn => {
    btn.classList.toggle('is-active', btn.getAttribute('data-settings-nav') === sectionId)
  })
  const select = document.getElementById('settingsNavSelect')
  if (select && select.value !== sectionId) select.value = sectionId

  if (sectionId === 'banks') renderDestinationBanksSettings()
  else if (sectionId === 'products') renderProductCatalogSettings()
  else if (sectionId === 'sales-targets') renderSalesTargetsSettings()
  else if (sectionId === 'platforms') renderPlatformsSettings()
  else if (sectionId === 'statuses') renderStatusesSettings()
}

function openSettingsConfirm(message, onConfirm, confirmLabel = 'تأیید') {
  const msg = document.getElementById('deleteMessage')
  const btn = document.getElementById('deleteConfirmBtn')
  const header = document.querySelector('#deleteModal .modal-header h2')
  if (!msg || !btn) {
    if (confirm(message)) onConfirm()
    return
  }
  const prevLabel = btn.textContent
  const prevHeader = header?.textContent
  msg.textContent = message
  btn.textContent = confirmLabel
  if (header) header.textContent = 'تأیید'
  btn.onclick = () => {
    document.getElementById('deleteModal')?.classList.remove('active')
    btn.textContent = prevLabel
    if (header && prevHeader) header.textContent = prevHeader
    onConfirm()
  }
  const cancelRestore = () => {
    btn.textContent = prevLabel
    if (header && prevHeader) header.textContent = prevHeader
  }
  const cancelBtn = document.querySelector('#deleteModal .modal-footer .btn:not(.btn-danger)')
  const closeBtn = document.querySelector('#deleteModal .modal-close')
  if (cancelBtn) cancelBtn.addEventListener('click', cancelRestore, { once: true })
  if (closeBtn) closeBtn.addEventListener('click', cancelRestore, { once: true })
  document.getElementById('deleteModal')?.classList.add('active')
}

export async function openSettingsModal() {
  if (!requireMainAdmin()) return
  ensureSettingsEscapeHandler()
  _permissionsDirty = false
  _selectedSettingsUser = null
  _editingBankIdx = null
  _editingProductIdx = null
  _editingPlatformIdx = null
  _editingStatusIdx = null

  const fn = document.getElementById('newFirstName')
  const ln = document.getElementById('newLastName')
  const ph = document.getElementById('newPhone')
  const role = document.getElementById('newRole')
  if (fn) fn.value = ''
  if (ln) ln.value = ''
  if (ph) ph.value = ''
  if (role) role.value = 'user'

  const search = document.getElementById('settingsNavSearch')
  if (search) search.value = ''
  const usersSearch = document.getElementById('settingsUsersSearch')
  if (usersSearch) usersSearch.value = ''
  const roleFilter = document.getElementById('settingsUsersRoleFilter')
  if (roleFilter) roleFilter.value = 'all'

  renderSettingsNav()
  applySettingsSection('users')
  await renderUsersList()

  document.getElementById('settingsModal')?.classList.add('active')
  document.getElementById('profileDropdown')?.classList.remove('active')
  const profileDd = document.getElementById('profileDropdown')
  if (profileDd) profileDd.hidden = true
  document.getElementById('profileMenuBtn')?.setAttribute('aria-expanded', 'false')
  updateUsersLayoutMode(false)
}

export function closeSettingsModal() {
  if (_permissionsDirty) {
    openSettingsConfirm(
      'تغییرات دسترسی ذخیره‌نشده دارید. بدون ذخیره ببندید؟',
      () => {
        _permissionsDirty = false
        document.getElementById('settingsModal')?.classList.remove('active')
      },
      'بستن'
    )
    return
  }
  document.getElementById('settingsModal')?.classList.remove('active')
}

export async function addUser() {
  if (!requireMainAdmin()) return
  const firstName = document.getElementById('newFirstName').value.trim()
  const lastName = document.getElementById('newLastName').value.trim()
  const phone = normalizePhone(document.getElementById('newPhone').value.trim())
  const role = document.getElementById('newRole').value

  if (!firstName) { showToast('نام را وارد کنید'); return }
  if (!lastName) { showToast('نام خانوادگی را وارد کنید'); return }
  if (!phone || !/^09\d{9}$/.test(phone)) {
    showToast('شماره موبایل صحیح نیست (مثال: ۰۹۱۲۳۴۵۶۷۸۹)'); return
  }

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
    document.getElementById('newFirstName').value = ''
    document.getElementById('newLastName').value = ''
    document.getElementById('newPhone').value = ''
    document.getElementById('newRole').value = 'user'
    const details = document.getElementById('settingsAddUserDetails')
    if (details) details.open = false
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
      if (_selectedSettingsUser === username) {
        _selectedSettingsUser = null
        _permissionsDirty = false
      }
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

function getFilteredSettingsUsers() {
  const q = toEnDigits(document.getElementById('settingsUsersSearch')?.value || '').trim().toLowerCase()
  const role = document.getElementById('settingsUsersRoleFilter')?.value || 'all'
  return _settingsUsersCache.filter(u => {
    if (role !== 'all' && u.role !== role) return false
    if (!q) return true
    const hay = `${userDisplayName(u) || ''} ${u.username || ''} ${u.phone || ''}`.toLowerCase()
    return hay.includes(q)
  })
}

export function filterSettingsUsers() {
  renderUsersListMaster()
}

function updateUsersLayoutMode(showDetail) {
  const layout = document.getElementById('settingsUsersLayout')
  if (!layout) return
  layout.classList.toggle('show-detail', !!showDetail)
  const back = document.getElementById('settingsUsersBack')
  if (back) back.hidden = !showDetail
}

export function backToUsersList() {
  if (_permissionsDirty) {
    openSettingsConfirm(
      'تغییرات دسترسی ذخیره‌نشده دارید. ادامه می‌دهید؟',
      () => {
        _permissionsDirty = false
        updateUsersLayoutMode(false)
      },
      'ادامه'
    )
    return
  }
  updateUsersLayoutMode(false)
}

export async function renderUsersList() {
  const container = document.getElementById('settingsUsersList')
  if (!container) return
  try {
    _settingsUsersCache = await getUsers()
  } catch (e) {
    console.error('renderUsersList error:', e)
    container.innerHTML = '<div class="settings-list-error">خطا در بارگذاری کاربران</div>'
    return
  }

  const addDetails = document.getElementById('settingsAddUserDetails')
  if (addDetails && _settingsUsersCache.length > 0) addDetails.open = false

  renderUsersListMaster()

  if (_selectedSettingsUser && _settingsUsersCache.some(u => u.username === _selectedSettingsUser)) {
    renderSelectedUserDetail(false)
  } else {
    _selectedSettingsUser = null
    const detail = document.getElementById('settingsUserDetailBody')
    if (detail) detail.innerHTML = '<div class="settings-empty-detail">یک کاربر را از لیست انتخاب کنید</div>'
    updateUsersLayoutMode(false)
  }
}

function renderUsersListMaster() {
  const container = document.getElementById('settingsUsersList')
  if (!container) return
  const currentUser = getCurrentUser()
  const users = getFilteredSettingsUsers()

  if (users.length === 0) {
    container.innerHTML = '<div class="settings-empty-detail">کاربری یافت نشد</div>'
    return
  }

  container.innerHTML = users.map(u => {
    const isCurrentUser = u.username === currentUser?.username
    const isAdminUser = u.username === 'admin' || u.role === 'admin'
    const perms = u.permissions || getDefaultPermissions()
    const viewPhones = new Set(normalizeViewUserPhones(perms.viewUserPhones))
    const userDisplay = userDisplayName(u) || u.username
    const userPhone = u.phone || '—'
    const userRole = u.role === 'admin' ? 'مدیر' : 'کاربر'
    const selected = _selectedSettingsUser === u.username

    return `
      <div class="settings-user-item${selected ? ' is-selected' : ''}" data-username="${escapeAttr(u.username)}">
        <button type="button" class="settings-user-item-main" onclick="app.selectSettingsUser('${escapeAttr(u.username)}')">
          <div class="user-info">
            <div class="user-name">${escapeHtml(userDisplay)}${isCurrentUser ? ' <span class="settings-you">(شما)</span>' : ''}</div>
            <div class="user-role">${escapeHtml(userPhone)} · <span class="role-badge ${u.role === 'admin' ? 'role-admin' : 'role-user'}">${userRole}</span>${viewPhones.size ? ` · <span class="settings-view-count">مشاهده ${viewPhones.size}</span>` : ''}</div>
          </div>
        </button>
        ${!isAdminUser ? `<button type="button" class="btn-icon settings-user-delete" title="حذف" onclick="app.deleteUser('${escapeAttr(u.username)}')" style="color:var(--danger);">🗑</button>` : ''}
      </div>
    `
  }).join('')
}

export function selectSettingsUser(username) {
  if (_permissionsDirty && _selectedSettingsUser && _selectedSettingsUser !== username) {
    openSettingsConfirm(
      'تغییرات دسترسی ذخیره‌نشده دارید. ادامه می‌دهید؟',
      () => {
        _permissionsDirty = false
        _selectedSettingsUser = username
        renderUsersListMaster()
        renderSelectedUserDetail(true)
      },
      'ادامه'
    )
    return
  }
  _selectedSettingsUser = username
  _permissionsDirty = false
  renderUsersListMaster()
  renderSelectedUserDetail(true)
}

function renderSelectedUserDetail(enterMobileDetail) {
  const detail = document.getElementById('settingsUserDetailBody')
  if (!detail) return
  const u = _settingsUsersCache.find(x => x.username === _selectedSettingsUser)
  if (!u) {
    detail.innerHTML = '<div class="settings-empty-detail">یک کاربر را از لیست انتخاب کنید</div>'
    updateUsersLayoutMode(false)
    return
  }

  if (enterMobileDetail) updateUsersLayoutMode(true)

  const currentUser = getCurrentUser()
  const isCurrentUser = u.username === currentUser?.username
  const perms = u.permissions || getDefaultPermissions()
  const viewPhones = new Set(normalizeViewUserPhones(perms.viewUserPhones))
  const userDisplay = userDisplayName(u) || u.username
  const userPhone = u.phone || '—'
  const userRole = u.role === 'admin' ? 'مدیر' : 'کاربر'

  if (u.role === 'admin') {
    detail.innerHTML = `
      <div class="settings-detail-head">
        <div class="user-name">${escapeHtml(userDisplay)}${isCurrentUser ? ' <span class="settings-you">(شما)</span>' : ''}</div>
        <div class="user-role">${escapeHtml(userPhone)} · <span class="role-badge role-admin">${userRole}</span></div>
      </div>
      <div class="settings-admin-full">دسترسی کامل (مدیر)</div>
    `
    return
  }

  const permsHtml = PERMISSION_GROUPS.map(g => {
    const allChecked = g.keys.every(k => !!perms[k])
    return `
      <div class="settings-perm-group" data-perm-group="${escapeAttr(u.username)}:${escapeAttr(g.label)}">
        <div class="settings-perm-group-head">
          <span>${escapeHtml(g.label)}</span>
          <label class="settings-perm-all">
            <input type="checkbox" ${allChecked ? 'checked' : ''} onchange="app.togglePermGroup('${escapeAttr(u.username)}', '${escapeAttr(g.label)}', this.checked)">
            همه
          </label>
        </div>
        <div class="settings-perm-chips">
          ${g.keys.map(k => `
            <label class="settings-perm-chip${perms[k] ? ' is-on' : ''}">
              <input type="checkbox" data-perm-user="${escapeAttr(u.username)}" data-perm-key="${k}" ${perms[k] ? 'checked' : ''} onchange="app.togglePermCheckbox(this)">
              ${ALL_PERMISSIONS[k]}
            </label>
          `).join('')}
        </div>
      </div>
    `
  }).join('')

  const otherUsers = _settingsUsersCache.filter(x =>
    x.phone &&
    normalizePhone(x.phone) !== normalizePhone(u.phone) &&
    x.role !== 'admin' &&
    x.username !== 'admin'
  )

  const viewUsersHtml = `
    <div class="view-users-picker" data-view-user="${escapeAttr(u.username)}">
      <div class="settings-perm-group-head" style="margin-bottom:6px;">
        <span>زیرمجموعه / مشاهده و انتقال</span>
      </div>
      <p class="settings-pane-desc" style="margin-bottom:8px;">علاوه بر داده خودش، اطلاعات کاربران انتخاب‌شده را می‌بیند. با مجوز «انتقال مالکیت مشتری» می‌تواند مالکیت مشتریان آن‌ها را منتقل کند.</p>
      <input type="search" class="form-input view-users-search" placeholder="جستجوی نام یا شماره..." oninput="app.filterViewUserOptions('${escapeAttr(u.username)}', this.value)">
      <div class="view-users-options">
        ${otherUsers.length === 0
          ? '<div class="settings-empty-detail">کاربر دیگری برای انتخاب نیست</div>'
          : otherUsers.map(x => {
              const phone = normalizePhone(x.phone)
              const label = `${userDisplayName(x) || x.username} · ${phone}`
              const checked = viewPhones.has(phone) ? 'checked' : ''
              return `<label class="view-users-option" data-search="${escapeAttr(label.toLowerCase())}">
                <input type="checkbox" data-view-for="${escapeAttr(u.username)}" value="${escapeAttr(phone)}" ${checked} onchange="app.markPermissionsDirty()">
                <span>${escapeHtml(userDisplayName(x) || x.username)}</span>
                <span class="view-users-phone">${escapeHtml(phone)}</span>
              </label>`
            }).join('')}
      </div>
    </div>`

  detail.innerHTML = `
    <div class="settings-detail-head">
      <div class="user-name">${escapeHtml(userDisplay)}${isCurrentUser ? ' <span class="settings-you">(شما)</span>' : ''}</div>
      <div class="user-role">${escapeHtml(userPhone)} · <span class="role-badge role-user">${userRole}</span></div>
    </div>
    <div class="settings-user-perms">
      ${permsHtml}
      ${viewUsersHtml}
    </div>
    <div class="settings-perms-footer" id="settingsPermsFooter">
      <span class="settings-dirty-hint" id="settingsDirtyHint" hidden>تغییرات ذخیره‌نشده</span>
      <button type="button" class="btn btn-primary" id="settingsSavePermsBtn" disabled onclick="app.saveUserPermissions('${escapeAttr(u.username)}')">ذخیره دسترسی‌ها</button>
    </div>
  `
  syncPermissionsDirtyUi()
}

export function markPermissionsDirty() {
  _permissionsDirty = true
  syncPermissionsDirtyUi()
}

function syncPermissionsDirtyUi() {
  const hint = document.getElementById('settingsDirtyHint')
  const btn = document.getElementById('settingsSavePermsBtn')
  if (hint) hint.hidden = !_permissionsDirty
  if (btn) btn.disabled = !_permissionsDirty
}

export function togglePermGroup(username, groupLabel, checked) {
  const group = PERMISSION_GROUPS.find(g => g.label === groupLabel)
  if (!group) return
  group.keys.forEach(k => {
    const cb = document.querySelector(`input[data-perm-user="${username}"][data-perm-key="${k}"]`)
    if (!cb) return
    cb.checked = !!checked
    togglePermCheckbox(cb)
  })
  markPermissionsDirty()
}

export function filterViewUserOptions(username, query) {
  const picker = document.querySelector(`.view-users-picker[data-view-user="${username}"]`)
  if (!picker) return
  const q = toEnDigits(String(query || '')).trim().toLowerCase()
  picker.querySelectorAll('.view-users-option').forEach(el => {
    const hay = el.getAttribute('data-search') || ''
    el.style.display = !q || hay.includes(q) ? '' : 'none'
  })
}

export function toggleSettingsUserRow() {
  /* legacy no-op: accordion replaced by master-detail */
}

export function renderDestinationBanksSettings() {
  const list = document.getElementById('settingsBanksList')
  if (!list) return
  const banks = getDestinationBanks()
  _editingBankIdx = (_editingBankIdx != null && _editingBankIdx < banks.length) ? _editingBankIdx : null
  if (banks.length === 0) {
    list.innerHTML = '<div class="settings-empty-detail">هنوز بانکی ثبت نشده</div>'
    return
  }
  list.innerHTML = banks.map((bank, idx) => {
    if (_editingBankIdx === idx) {
      return `
        <div class="settings-config-row is-editing">
          <input type="text" class="form-input" id="editBankInput" value="${escapeAttr(bank)}" style="flex:1;">
          <button type="button" class="btn btn-sm btn-primary" onclick="app.saveDestinationBankEdit(${idx})">ذخیره</button>
          <button type="button" class="btn btn-sm" onclick="app.cancelDestinationBankEdit()">لغو</button>
        </div>`
    }
    return `
      <div class="settings-config-row">
        <span class="settings-config-label">${escapeHtml(bank)}</span>
        <button type="button" class="btn-icon" title="ویرایش" onclick="app.startDestinationBankEdit(${idx})">✏️</button>
        <button type="button" class="btn-icon" title="حذف" onclick="app.removeDestinationBank(${idx})" style="color:var(--danger);">🗑</button>
      </div>`
  }).join('')
  if (_editingBankIdx != null) {
    document.getElementById('editBankInput')?.focus()
  }
}

export function startDestinationBankEdit(index) {
  if (!requireMainAdmin()) return
  _editingBankIdx = index
  renderDestinationBanksSettings()
}

export function cancelDestinationBankEdit() {
  _editingBankIdx = null
  renderDestinationBanksSettings()
}

export async function saveDestinationBankEdit(index) {
  if (!requireMainAdmin()) return
  const input = document.getElementById('editBankInput')
  const name = (input?.value || '').trim()
  if (!name) { showToast('نام بانک را وارد کنید'); return }
  const banks = [...getDestinationBanks()]
  if (index < 0 || index >= banks.length) return
  if (banks.some((b, i) => i !== index && b.toLowerCase() === name.toLowerCase())) {
    showToast('این بانک قبلاً ثبت شده')
    return
  }
  banks[index] = name
  try {
    await saveDestinationBanks(banks)
    _editingBankIdx = null
    renderDestinationBanksSettings()
    showToast('ذخیره شد')
  } catch (e) {
    console.error('saveDestinationBankEdit error:', e)
    showToast('خطا در ذخیره بانک')
  }
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
  openSettingsConfirm(`حذف بانک «${banks[index]}»؟`, async () => {
    const next = [...getDestinationBanks()]
    next.splice(index, 1)
    try {
      await saveDestinationBanks(next)
      _editingBankIdx = null
      renderDestinationBanksSettings()
      showToast('بانک حذف شد')
    } catch (e) {
      console.error('removeDestinationBank error:', e)
      showToast('خطا در حذف بانک')
    }
  }, 'حذف')
}

// ============================================
// Product catalog Settings
// ============================================

export function renderProductCatalogSettings() {
  const list = document.getElementById('settingsProductsList')
  if (!list) return
  const products = getProductCatalog()
  _editingProductIdx = (_editingProductIdx != null && _editingProductIdx < products.length) ? _editingProductIdx : null
  if (products.length === 0) {
    list.innerHTML = '<div class="settings-empty-detail">هنوز محصولی ثبت نشده</div>'
    return
  }
  list.innerHTML = products.map((name, idx) => {
    if (_editingProductIdx === idx) {
      return `
        <div class="settings-config-row is-editing">
          <input type="text" class="form-input" id="editProductInput" value="${escapeAttr(name)}" style="flex:1;">
          <button type="button" class="btn btn-sm btn-primary" onclick="app.saveProductCatalogEdit(${idx})">ذخیره</button>
          <button type="button" class="btn btn-sm" onclick="app.cancelProductCatalogEdit()">لغو</button>
        </div>`
    }
    return `
      <div class="settings-config-row">
        <span class="settings-config-label">${escapeHtml(name)}</span>
        <button type="button" class="btn-icon" title="ویرایش" onclick="app.startProductCatalogEdit(${idx})">✏️</button>
        <button type="button" class="btn-icon" title="حذف" onclick="app.removeProductCatalogItem(${idx})" style="color:var(--danger);">🗑</button>
      </div>`
  }).join('')
  if (_editingProductIdx != null) document.getElementById('editProductInput')?.focus()
}

export function startProductCatalogEdit(index) {
  if (!requireMainAdmin()) return
  _editingProductIdx = index
  renderProductCatalogSettings()
}

export function cancelProductCatalogEdit() {
  _editingProductIdx = null
  renderProductCatalogSettings()
}

export async function saveProductCatalogEdit(index) {
  if (!requireMainAdmin()) return
  const input = document.getElementById('editProductInput')
  const name = (input?.value || '').trim()
  if (!name) { showToast('نام محصول را وارد کنید'); return }
  const products = [...getProductCatalog()]
  if (index < 0 || index >= products.length) return
  if (products.some((p, i) => i !== index && p.toLowerCase() === name.toLowerCase())) {
    showToast('این محصول قبلاً ثبت شده')
    return
  }
  products[index] = name
  try {
    await saveProductCatalog(products)
    _editingProductIdx = null
    renderProductCatalogSettings()
    showToast('ذخیره شد')
  } catch (e) {
    console.error('saveProductCatalogEdit error:', e)
    showToast('خطا در ذخیره محصول')
  }
}

export async function addProductCatalogItem() {
  if (!requireMainAdmin()) return
  const input = document.getElementById('newProductCatalogItem')
  const name = (input?.value || '').trim()
  if (!name) { showToast('نام محصول را وارد کنید'); return }
  const products = getProductCatalog()
  if (products.some(p => p.toLowerCase() === name.toLowerCase())) {
    showToast('این محصول قبلاً ثبت شده')
    return
  }
  try {
    await saveProductCatalog([...products, name])
    if (input) input.value = ''
    renderProductCatalogSettings()
    showToast('محصول اضافه شد')
  } catch (e) {
    console.error('addProductCatalogItem error:', e)
    showToast('خطا در ذخیره محصول')
  }
}

export async function removeProductCatalogItem(index) {
  if (!requireMainAdmin()) return
  const products = getProductCatalog()
  if (index < 0 || index >= products.length) return
  if (products.length <= 1) {
    showToast('حداقل یک محصول باید در کاتالوگ بماند')
    return
  }
  openSettingsConfirm(`حذف محصول «${products[index]}»؟`, async () => {
    const next = [...getProductCatalog()]
    if (next.length <= 1) {
      showToast('حداقل یک محصول باید در کاتالوگ بماند')
      return
    }
    next.splice(index, 1)
    try {
      await saveProductCatalog(next)
      _editingProductIdx = null
      renderProductCatalogSettings()
      showToast('محصول حذف شد')
    } catch (e) {
      console.error('removeProductCatalogItem error:', e)
      showToast('خطا در حذف محصول')
    }
  }, 'حذف')
}

// ============================================
// Sales targets Settings
// ============================================

function parseSalesTargetValueInput(raw) {
  const cleaned = toEnDigits(String(raw || '')).replace(/[^\d.-]/g, '')
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : NaN
}

function getSelectedSalesTargetProducts() {
  const box = document.getElementById('salesTargetProducts')
  if (!box) return []
  return [...box.querySelectorAll('input[type="checkbox"][data-product]:checked')]
    .map(el => el.getAttribute('data-product') || '')
    .filter(Boolean)
}

function renderSalesTargetProductChecks(selectedNames = []) {
  const box = document.getElementById('salesTargetProducts')
  if (!box) return
  const selected = new Set((selectedNames || []).map(String))
  const catalog = getProductCatalog()
  box.innerHTML = catalog.map(name => `
    <label class="settings-target-product-item">
      <input type="checkbox" data-product="${escapeAttr(name)}"${selected.has(name) ? ' checked' : ''}>
      <span>${escapeHtml(name)}</span>
    </label>
  `).join('')
}

function clearSalesTargetForm() {
  _editingSalesTargetId = null
  const idEl = document.getElementById('editSalesTargetId')
  if (idEl) idEl.value = ''
  const titleEl = document.getElementById('salesTargetTitle')
  if (titleEl) titleEl.value = ''
  const metricEl = document.getElementById('salesTargetMetric')
  if (metricEl) metricEl.value = 'amount'
  const valueEl = document.getElementById('salesTargetValue')
  if (valueEl) valueEl.value = ''
  const startEl = document.getElementById('salesTargetStart')
  if (startEl) startEl.value = ''
  const endEl = document.getElementById('salesTargetEnd')
  if (endEl) endEl.value = ''
  renderSalesTargetProductChecks([])
  onSalesTargetMetricChange()
  const saveBtn = document.getElementById('salesTargetSaveBtn')
  if (saveBtn) saveBtn.textContent = 'افزودن تارگت'
  const cancelBtn = document.getElementById('salesTargetCancelBtn')
  if (cancelBtn) cancelBtn.hidden = true
}

export function onSalesTargetMetricChange() {
  const metric = document.getElementById('salesTargetMetric')?.value === 'count' ? 'count' : 'amount'
  const label = document.getElementById('salesTargetValueLabel')
  const input = document.getElementById('salesTargetValue')
  if (label) label.textContent = metric === 'count' ? 'مقدار هدف (تعداد)' : 'مقدار هدف (ریال)'
  if (input) input.placeholder = metric === 'count' ? 'مثلاً ۵۰' : 'مثلاً ۱۰۰۰۰۰۰۰۰'
}

function salesTargetMetaText(t) {
  const metricLabel = t.metric === 'count' ? 'تعداد' : 'مبلغ'
  const valueLabel = t.metric === 'count'
    ? `${formatNumber(t.value)} فروش`
    : `${formatNumber(t.value)} ریال`
  const products = (t.productNames || []).length
    ? t.productNames.join('، ')
    : 'همه محصولات'
  const rangeParts = []
  if (t.startDate) rangeParts.push(`از ${t.startDate}`)
  if (t.endDate) rangeParts.push(`تا ${t.endDate}`)
  const range = rangeParts.length ? rangeParts.join(' ') : 'بدون بازه زمانی'
  return `${metricLabel}: ${valueLabel} · ${products} · ${range}`
}

export function renderSalesTargetsSettings() {
  renderSalesTargetProductChecks(
    _editingSalesTargetId
      ? (getSalesTargets().find(t => t.id === _editingSalesTargetId)?.productNames || [])
      : getSelectedSalesTargetProducts()
  )
  onSalesTargetMetricChange()

  const list = document.getElementById('settingsSalesTargetsList')
  if (!list) return
  const targets = getSalesTargets()
  if (targets.length === 0) {
    list.innerHTML = '<div class="settings-empty-detail">هنوز تارگتی ثبت نشده</div>'
    return
  }
  list.innerHTML = targets.map(t => `
    <div class="settings-config-row settings-target-row${_editingSalesTargetId === t.id ? ' is-editing' : ''}">
      <div class="settings-config-label">
        <div>${escapeHtml(t.title)}</div>
        <div class="settings-config-meta">${escapeHtml(salesTargetMetaText(t))}</div>
      </div>
      <button type="button" class="btn-icon" title="ویرایش" onclick="app.startSalesTargetEdit('${escapeAttr(t.id)}')">✏️</button>
      <button type="button" class="btn-icon" title="حذف" onclick="app.removeSalesTarget('${escapeAttr(t.id)}')" style="color:var(--danger);">🗑</button>
    </div>
  `).join('')
}

export function startSalesTargetEdit(id) {
  if (!requireMainAdmin()) return
  const target = getSalesTargets().find(t => t.id === id)
  if (!target) return
  _editingSalesTargetId = id
  const idEl = document.getElementById('editSalesTargetId')
  if (idEl) idEl.value = id
  const titleEl = document.getElementById('salesTargetTitle')
  if (titleEl) titleEl.value = target.title || ''
  const metricEl = document.getElementById('salesTargetMetric')
  if (metricEl) metricEl.value = target.metric === 'count' ? 'count' : 'amount'
  const valueEl = document.getElementById('salesTargetValue')
  if (valueEl) valueEl.value = formatNumber(target.value) || String(target.value)
  const startEl = document.getElementById('salesTargetStart')
  if (startEl) startEl.value = target.startDate || ''
  const endEl = document.getElementById('salesTargetEnd')
  if (endEl) endEl.value = target.endDate || ''
  renderSalesTargetProductChecks(target.productNames || [])
  onSalesTargetMetricChange()
  const saveBtn = document.getElementById('salesTargetSaveBtn')
  if (saveBtn) saveBtn.textContent = 'ذخیره تغییرات'
  const cancelBtn = document.getElementById('salesTargetCancelBtn')
  if (cancelBtn) cancelBtn.hidden = false
  renderSalesTargetsSettings()
  titleEl?.focus()
}

export function cancelSalesTargetEdit() {
  clearSalesTargetForm()
  renderSalesTargetsSettings()
}

export async function saveSalesTargetForm() {
  if (!requireMainAdmin()) return
  const title = (document.getElementById('salesTargetTitle')?.value || '').trim()
  const metric = document.getElementById('salesTargetMetric')?.value === 'count' ? 'count' : 'amount'
  const value = parseSalesTargetValueInput(document.getElementById('salesTargetValue')?.value)
  const startDate = toEnDigits((document.getElementById('salesTargetStart')?.value || '').trim())
  const endDate = toEnDigits((document.getElementById('salesTargetEnd')?.value || '').trim())
  const productNames = getSelectedSalesTargetProducts()

  if (!title) { showToast('عنوان تارگت را وارد کنید'); return }
  if (!Number.isFinite(value) || value <= 0) { showToast('مقدار هدف باید عدد مثبت باشد'); return }
  if (startDate && endDate) {
    if (jalaliToNum(startDate) > jalaliToNum(endDate)) {
      showToast('تاریخ شروع نمی‌تواند بعد از تاریخ پایان باشد')
      return
    }
  }

  const existing = getSalesTargets()
  const editingId = _editingSalesTargetId || document.getElementById('editSalesTargetId')?.value || ''
  let next
  if (editingId && existing.some(t => t.id === editingId)) {
    next = existing.map(t => t.id === editingId ? {
      ...t,
      title,
      metric,
      value,
      productNames,
      startDate,
      endDate
    } : t)
  } else {
    next = [...existing, {
      id: `tgt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      title,
      metric,
      value,
      productNames,
      startDate,
      endDate,
      createdAt: new Date().toISOString()
    }]
  }

  try {
    await saveSalesTargets(next)
    clearSalesTargetForm()
    renderSalesTargetsSettings()
    showToast(editingId ? 'تارگت ذخیره شد' : 'تارگت اضافه شد')
  } catch (e) {
    console.error('saveSalesTargetForm error:', e)
    showToast('خطا در ذخیره تارگت')
  }
}

export async function removeSalesTarget(id) {
  if (!requireMainAdmin()) return
  const target = getSalesTargets().find(t => t.id === id)
  if (!target) return
  openSettingsConfirm(`حذف تارگت «${target.title}»؟`, async () => {
    try {
      await saveSalesTargets(getSalesTargets().filter(t => t.id !== id))
      if (_editingSalesTargetId === id) clearSalesTargetForm()
      renderSalesTargetsSettings()
      showToast('تارگت حذف شد')
    } catch (e) {
      console.error('removeSalesTarget error:', e)
      showToast('خطا در حذف تارگت')
    }
  }, 'حذف')
}

// ============================================
// Platforms Settings
// ============================================

export function renderPlatformsSettings() {
  const list = document.getElementById('settingsPlatformsList')
  if (!list) return
  const platforms = getPlatforms()
  _editingPlatformIdx = (_editingPlatformIdx != null && _editingPlatformIdx < platforms.length) ? _editingPlatformIdx : null
  list.innerHTML = platforms.map((p, idx) => {
    if (_editingPlatformIdx === idx) {
      return `
        <div class="settings-config-row settings-config-edit-block is-editing">
          <div class="settings-inline-edit">
            <div class="form-group" style="margin-bottom:10px;">
              <label>نام نمایشی</label>
              <input type="text" class="form-input" id="editPlatformLabel" value="${escapeAttr(p.label)}">
            </div>
            <div class="form-group" style="margin-bottom:10px;">
              <label>قالب لینک</label>
              <input type="text" class="form-input" id="editPlatformLink" value="${escapeAttr(p.linkTemplate || '')}" placeholder="از {id} و {phone} استفاده کنید" dir="ltr" style="text-align:left;">
            </div>
            <div class="form-group" style="margin-bottom:10px;">
              <label>رنگ</label>
              <input type="color" id="editPlatformColor" value="${escapeAttr(p.color)}" style="width:40px;height:32px;border:none;cursor:pointer;padding:0;">
            </div>
            <div class="settings-inline-actions">
              <button type="button" class="btn btn-sm btn-primary" onclick="app.savePlatformEdit(${idx})">ذخیره</button>
              <button type="button" class="btn btn-sm" onclick="app.cancelPlatformEdit()">لغو</button>
            </div>
          </div>
        </div>`
    }
    return `
      <div class="settings-config-row" data-idx="${idx}">
        <span class="platform-dot platform-${escapeAttr(p.key)}" style="background:${escapeAttr(p.color)};"></span>
        <span class="settings-config-label">${escapeHtml(p.label)}</span>
        <span class="settings-config-meta">${escapeHtml(p.key)}</span>
        <input type="color" value="${escapeAttr(p.color)}" title="رنگ" style="width:28px;height:28px;border:none;cursor:pointer;padding:0;" onchange="app.updatePlatformField(${idx},'color',this.value)">
        <button type="button" class="btn-icon" title="ویرایش" onclick="app.editPlatform(${idx})">✏️</button>
        <button type="button" class="btn-icon" title="حذف" onclick="app.removePlatform(${idx})" style="color:var(--danger);">🗑</button>
      </div>`
  }).join('')
}

export async function addPlatform() {
  if (!requireMainAdmin()) return
  const keyInput = document.getElementById('newPlatformKey')
  const labelInput = document.getElementById('newPlatformLabel')
  const key = (keyInput?.value || '').trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
  const label = (labelInput?.value || '').trim()
  if (!key || !label) { showToast('کلید و نام پلتفرم الزامیست'); return }
  const platforms = getPlatforms()
  if (platforms.some(p => p.key === key)) { showToast('این کلید قبلاً وجود دارد'); return }
  try {
    await savePlatforms([...platforms, { key, label, color: '#888888', linkTemplate: '' }])
    if (keyInput) keyInput.value = ''
    if (labelInput) labelInput.value = ''
    renderPlatformsSettings()
    showToast('پلتفرم اضافه شد')
  } catch (e) {
    console.error('addPlatform error:', e)
    showToast('خطا در ذخیره پلتفرم')
  }
}

export async function removePlatform(index) {
  if (!requireMainAdmin()) return
  const platforms = [...getPlatforms()]
  if (index < 0 || index >= platforms.length) return
  openSettingsConfirm(`حذف پلتفرم «${platforms[index].label}»؟`, async () => {
    const next = [...getPlatforms()]
    next.splice(index, 1)
    try {
      await savePlatforms(next)
      _editingPlatformIdx = null
      renderPlatformsSettings()
      showToast('پلتفرم حذف شد')
    } catch (e) {
      showToast('خطا در حذف پلتفرم')
    }
  }, 'حذف')
}

export async function updatePlatformField(index, field, value) {
  if (!requireMainAdmin()) return
  const platforms = [...getPlatforms()]
  if (!platforms[index]) return
  platforms[index][field] = value
  try {
    await savePlatforms(platforms)
    renderPlatformsSettings()
    showToast('ذخیره شد')
  } catch (e) {
    showToast('خطا در ذخیره تغییرات')
  }
}

export function editPlatform(index) {
  if (!requireMainAdmin()) return
  _editingPlatformIdx = index
  renderPlatformsSettings()
}

export function cancelPlatformEdit() {
  _editingPlatformIdx = null
  renderPlatformsSettings()
}

export async function savePlatformEdit(index) {
  if (!requireMainAdmin()) return
  const platforms = [...getPlatforms()]
  const p = platforms[index]
  if (!p) return
  const label = (document.getElementById('editPlatformLabel')?.value || '').trim() || p.label
  const linkTemplate = (document.getElementById('editPlatformLink')?.value || '').trim()
  const color = document.getElementById('editPlatformColor')?.value || p.color
  platforms[index] = { ...p, label, linkTemplate, color }
  try {
    await savePlatforms(platforms)
    _editingPlatformIdx = null
    renderPlatformsSettings()
    showToast('پلتفرم ویرایش شد')
  } catch (e) {
    showToast('خطا در ذخیره')
  }
}

// ============================================
// Statuses Settings
// ============================================

export function renderStatusesSettings() {
  const list = document.getElementById('settingsStatusesList')
  if (!list) return
  const statuses = getStatuses()
  _editingStatusIdx = (_editingStatusIdx != null && _editingStatusIdx < statuses.length) ? _editingStatusIdx : null
  list.innerHTML = statuses.map((s, idx) => {
    if (_editingStatusIdx === idx) {
      return `
        <div class="settings-config-row is-editing">
          <input type="text" class="form-input" id="editStatusLabel" value="${escapeAttr(s.label)}" style="flex:1;">
          <button type="button" class="btn btn-sm btn-primary" onclick="app.saveStatusEdit(${idx})">ذخیره</button>
          <button type="button" class="btn btn-sm" onclick="app.cancelStatusEdit()">لغو</button>
        </div>`
    }
    return `
      <div class="settings-config-row" data-idx="${idx}" draggable="true" ondragstart="app.onStatusDragStart(event,${idx})" ondragover="app.onStatusDragOver(event)" ondrop="app.onStatusDrop(event,${idx})">
        <span class="drag-handle" title="جابجایی">☰</span>
        <span class="status-badge status-${escapeAttr(s.key)}" style="background:${escapeAttr(s.bgColor)};color:${escapeAttr(s.textColor)};">${escapeHtml(s.label)}</span>
        <span class="settings-config-meta">${escapeHtml(s.key)}</span>
        <span style="flex:1;"></span>
        <input type="color" value="${escapeAttr(s.bgColor)}" title="رنگ پس‌زمینه" style="width:28px;height:28px;border:none;cursor:pointer;padding:0;" onchange="app.updateStatusField(${idx},'bgColor',this.value)">
        <input type="color" value="${escapeAttr(s.textColor)}" title="رنگ متن" style="width:24px;height:24px;border:none;cursor:pointer;padding:0;" onchange="app.updateStatusField(${idx},'textColor',this.value)">
        <button type="button" class="btn-icon" title="ویرایش" onclick="app.editStatus(${idx})">✏️</button>
        <button type="button" class="btn-icon" title="حذف" onclick="app.removeStatus(${idx})" style="color:var(--danger);">🗑</button>
      </div>`
  }).join('')
}

let draggedStatusIdx = null
export function onStatusDragStart(e, idx) { draggedStatusIdx = idx; e.dataTransfer.effectAllowed = 'move' }
export function onStatusDragOver(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }
export async function onStatusDrop(e, targetIdx) {
  e.preventDefault()
  if (draggedStatusIdx === null || draggedStatusIdx === targetIdx) return
  const statuses = [...getStatuses()]
  const [moved] = statuses.splice(draggedStatusIdx, 1)
  statuses.splice(targetIdx, 0, moved)
  draggedStatusIdx = null
  try {
    await saveStatuses(statuses)
    renderStatusesSettings()
    showToast('ترتیب وضعیت‌ها ذخیره شد')
  } catch (e) { showToast('خطا در ذخیره ترتیب') }
}

export async function addStatus() {
  if (!requireMainAdmin()) return
  const keyInput = document.getElementById('newStatusKey')
  const labelInput = document.getElementById('newStatusLabel')
  const key = (keyInput?.value || '').trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
  const label = (labelInput?.value || '').trim()
  if (!key || !label) { showToast('کلید و نام وضعیت الزامیست'); return }
  const statuses = getStatuses()
  if (statuses.some(s => s.key === key)) { showToast('این کلید قبلاً وجود دارد'); return }
  try {
    await saveStatuses([...statuses, { key, label, bgColor: '#e9ecef', textColor: '#495057', order: statuses.length }])
    if (keyInput) keyInput.value = ''
    if (labelInput) labelInput.value = ''
    renderStatusesSettings()
    showToast('وضعیت اضافه شد')
  } catch (e) {
    showToast('خطا در ذخیره وضعیت')
  }
}

export async function removeStatus(index) {
  if (!requireMainAdmin()) return
  const statuses = [...getStatuses()]
  if (index < 0 || index >= statuses.length) return
  openSettingsConfirm(`حذف وضعیت «${statuses[index].label}»؟`, async () => {
    const next = [...getStatuses()]
    next.splice(index, 1)
    try {
      await saveStatuses(next)
      _editingStatusIdx = null
      renderStatusesSettings()
      showToast('وضعیت حذف شد')
    } catch (e) { showToast('خطا در حذف وضعیت') }
  }, 'حذف')
}

export async function updateStatusField(index, field, value) {
  if (!requireMainAdmin()) return
  const statuses = [...getStatuses()]
  if (!statuses[index]) return
  statuses[index][field] = value
  try {
    await saveStatuses(statuses)
    renderStatusesSettings()
    showToast('ذخیره شد')
  } catch (e) { showToast('خطا در ذخیره تغییرات') }
}

export function editStatus(index) {
  if (!requireMainAdmin()) return
  _editingStatusIdx = index
  renderStatusesSettings()
}

export function cancelStatusEdit() {
  _editingStatusIdx = null
  renderStatusesSettings()
}

export async function saveStatusEdit(index) {
  if (!requireMainAdmin()) return
  const statuses = [...getStatuses()]
  const s = statuses[index]
  if (!s) return
  const newLabel = (document.getElementById('editStatusLabel')?.value || '').trim()
  if (!newLabel) { showToast('نام وضعیت را وارد کنید'); return }
  statuses[index] = { ...s, label: newLabel }
  try {
    await saveStatuses(statuses)
    _editingStatusIdx = null
    renderStatusesSettings()
    showToast('وضعیت ویرایش شد')
  } catch (e) {
    showToast('خطا در ذخیره')
  }
}

export async function saveUserPermissions(username) {
  if (!requireMainAdmin()) return

  const checkboxes = document.querySelectorAll(`input[data-perm-user="${username}"]`)
  if (checkboxes.length === 0) {
    showToast('برای کاربر مدیر نمی‌توان دسترسی جزئی ذخیره کرد')
    return
  }
  let permissions = {}
  checkboxes.forEach(cb => {
    permissions[cb.dataset.permKey] = cb.checked
  })
  permissions = applyAccountingPermissionBundle(permissions)

  const viewPhones = [...document.querySelectorAll(`input[data-view-for="${username}"]:checked`)]
    .map(cb => normalizePhone(cb.value))
    .filter(Boolean)
  permissions.viewUserPhones = viewPhones

  checkboxes.forEach(cb => {
    const key = cb.dataset.permKey
    if (permissions[key] && !cb.checked) {
      cb.checked = true
      const label = cb.closest('label')
      if (label) label.classList.add('is-on')
    }
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
      setCurrentUser({ ...current, permissions, viewUserPhones: viewPhones })
      applyPermissions()
    }
    const cached = _settingsUsersCache.find(u => u.username === username)
    if (cached) cached.permissions = permissions
    _permissionsDirty = false
    syncPermissionsDirtyUi()
    renderUsersListMaster()
    showToast('دسترسی‌ها ذخیره شد')
  }
}

export function togglePermCheckbox(el) {
  const label = el.closest('label')
  if (label) {
    label.classList.toggle('is-on', el.checked)
  }

  if (el.dataset.permKey === 'accounting' && el.checked) {
    const username = el.dataset.permUser
    ACCOUNTING_PERMISSION_BUNDLE.forEach(key => {
      const cb = document.querySelector(`input[data-perm-user="${username}"][data-perm-key="${key}"]`)
      if (!cb) return
      cb.checked = true
      const lbl = cb.closest('label')
      if (lbl) lbl.classList.add('is-on')
    })
  }

  markPermissionsDirty()

  const username = el.dataset.permUser
  if (username) {
    PERMISSION_GROUPS.forEach(g => {
      if (!g.keys.includes(el.dataset.permKey)) return
      const allOn = g.keys.every(k => {
        const cb = document.querySelector(`input[data-perm-user="${username}"][data-perm-key="${k}"]`)
        return cb?.checked
      })
      const groupCb = document.querySelector(`.settings-perm-group[data-perm-group="${username}:${g.label}"] .settings-perm-all input`)
      if (groupCb) groupCb.checked = allOn
    })
  }
}

// ============================================
// Permissions UI
// ============================================

export function applyPermissions() {
  document.querySelectorAll('.tab').forEach(t => {
    const text = t.textContent.trim()
    let permKey = null
    if (t.id === 'tab-dashboard' || text === 'داشبورد') permKey = 'dashboard'
    else if (t.id === 'tab-customers' || text === 'لیست مشتریان') permKey = 'customers_view'
    else if (t.id === 'tab-followups' || text.startsWith('فالوآپ') || text === 'تاریخچه پیگیری') permKey = 'followups_view'
    else if (t.id === 'tab-sales' || text === 'فروش‌ها') permKey = 'sales_view'
    else if (t.id === 'tab-accounting' || text === 'حسابداری') permKey = 'accounting'
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

  syncToolbarActionsMenus()

  // Rebuild customer bulk actions (delete / transfer) for current permissions
  try {
    const actionEl = document.getElementById('bulkActionCustomers')
    if (actionEl) delete actionEl.dataset.optionsReady
  } catch (_) { /* ignore */ }

  const settingsItem = document.querySelector('.profile-dropdown-item[onclick*="openSettingsModal"]')
  if (settingsItem) {
    settingsItem.style.display = isMainAdmin() ? '' : 'none'
  }

  const activeTab = document.querySelector('.tab.active')
  if (activeTab && activeTab.style.display === 'none') {
    // RTL: first visible tab in DOM order is the rightmost accessible tab
    const firstVisible = [...document.querySelectorAll('.tab')].find(t => t.style.display !== 'none')
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

  // Close notification menu if open
  const notifDd = document.getElementById('notificationDropdown')
  if (notifDd) {
    notifDd.classList.remove('active')
    notifDd.hidden = true
  }
  document.getElementById('notificationMenuBtn')?.setAttribute('aria-expanded', 'false')

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
