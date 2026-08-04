import { supabase } from './supabase.js'
import { ADMIN_PHONE } from './config.js'
import { toEnDigits, escapeHtml, escapeAttr, showToast, getCurrentUser, setCurrentUser, clearCurrentUser, restoreSession, hasPermission, requirePermission, getDefaultPermissions, ALL_PERMISSIONS, PERMISSION_GROUPS, normalizePhone, userDisplayName, isMainAdmin, requireMainAdmin, applyAccountingPermissionBundle, ACCOUNTING_PERMISSION_BUNDLE, normalizeViewUserPhones, syncToolbarActionsMenus, formatNumber, jalaliToNum, formatInput } from './utils.js'
import { getDestinationBanks, saveDestinationBanks, getProductCatalog, saveProductCatalog, getPlatforms, savePlatforms, getStatuses, saveStatuses, getSalesTargets, saveSalesTargets } from './data.js'
import {
  loadGroupsData,
  getGroupsCache,
  getMembershipByPhone,
  getMembersOfGroup,
  getManagedMemberPhonesFromCache,
  createGroup,
  renameGroup,
  deleteGroup,
  addGroupMember,
  removeGroupMember,
  setGroupManager,
  assignUserToGroup,
  migrateLegacyViewUserPhones,
  resolveGroupSessionInfo,
  resolveViewUserPhonesForSession,
  clearUserViewPhones
} from './groups.js'

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
  const users = await getUsersSafe()
  const target = users.find(u => u.username === username)
  if (target?.phone) {
    const phone = normalizePhone(target.phone)
    try {
      await loadGroupsData()
    } catch (_) { /* groups table may be missing */ }
    const membership = getMembershipByPhone(phone)
    if (membership) {
      try {
        await removeGroupMember(membership.group.id, phone)
      } catch (e) {
        console.error('deleteUserFromDB removeGroupMember:', e)
      }
    } else {
      try {
        await clearUserViewPhones(phone)
      } catch (_) { /* ignore */ }
    }
  }

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
  const groupInfo = await resolveGroupSessionInfo({
    phone: user.phone,
    role: user.role,
    permissions: user.permissions || null
  })
  const permissions = user.role === 'admin'
    ? null
    : { ...(user.permissions || {}), viewUserPhones: groupInfo.viewUserPhones }
  await setCurrentUser({
    username: user.username,
    displayName: user.display_name,
    firstName: user.first_name,
    lastName: user.last_name,
    phone: user.phone,
    role: user.role,
    permissions,
    viewUserPhones: groupInfo.viewUserPhones,
    groupId: groupInfo.groupId,
    groupName: groupInfo.groupName,
    isGroupManager: groupInfo.isGroupManager
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
    const groupInfo = await resolveGroupSessionInfo({
      phone: user.phone,
      role: user.role,
      permissions: user.permissions || null
    })
    const permissions = user.role === 'admin'
      ? null
      : { ...(user.permissions || {}), viewUserPhones: groupInfo.viewUserPhones }
    return await setCurrentUser({
      username: user.username,
      displayName: user.display_name || `${user.first_name || ''} ${user.last_name || ''}`.trim(),
      firstName: user.first_name,
      lastName: user.last_name,
      phone: user.phone,
      role: user.role,
      permissions,
      viewUserPhones: groupInfo.viewUserPhones,
      groupId: groupInfo.groupId,
      groupName: groupInfo.groupName,
      isGroupManager: groupInfo.isGroupManager
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
  { id: 'groups', label: 'گروه‌ها و اعضا', group: null, keywords: 'گروه تیم مدیر عضو group team manager' },
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
let _selectedSettingsGroup = null
let _permissionsDirty = false
let _settingsEscapeBound = false
let _editingBankIdx = null
let _editingProductIdx = null
let _editingPlatformIdx = null
let _editingStatusIdx = null
let _editingSalesTargetId = null
/** @type {Array<{id?: string, metric: string, value: number, productNames: string[], startDate: string, endDate: string, createdAt?: string}>} */
let _draftTargetBars = []
/** @type {Record<string, Record<string, number>>} userGroupId -> barId -> share value */
let _draftAllocations = {}

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

  if (sectionId === 'groups') renderGroupsSettings()
  else if (sectionId === 'banks') renderDestinationBanksSettings()
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
  _selectedSettingsGroup = null
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

  try {
    _settingsUsersCache = await getUsers()
  } catch (e) {
    console.error('openSettingsModal users error:', e)
    _settingsUsersCache = []
  }

  try {
    await loadGroupsData()
    const migration = await migrateLegacyViewUserPhones(_settingsUsersCache)
    if (!migration.skipped && migration.created > 0) {
      showToast(`${migration.created} گروه از زیرمجموعه‌های قبلی ساخته شد`)
    }
    if (migration.conflicts?.length) {
      console.warn('تداخل مهاجرت گروه:', migration.conflicts)
    }
    await loadGroupsData()
    _settingsUsersCache = await getUsers()
  } catch (e) {
    console.error('openSettingsModal groups error:', e)
  }

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

  try {
    await loadGroupsData()
  } catch (_) { /* groups optional until migration applied */ }

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
    const userDisplay = userDisplayName(u) || u.username
    const userPhone = u.phone || '—'
    const userRole = u.role === 'admin' ? 'مدیر' : 'کاربر'
    const selected = _selectedSettingsUser === u.username
    const membership = u.role === 'admin' ? null : getMembershipByPhone(u.phone)
    const groupBadge = membership
      ? ` · <span class="settings-view-count">${escapeHtml(membership.group.name)}${membership.isManager ? ' · مدیر' : ''}</span>`
      : ''

    return `
      <div class="settings-user-item${selected ? ' is-selected' : ''}" data-username="${escapeAttr(u.username)}">
        <button type="button" class="settings-user-item-main" onclick="app.selectSettingsUser('${escapeAttr(u.username)}')">
          <div class="user-info">
            <div class="user-name">${escapeHtml(userDisplay)}${isCurrentUser ? ' <span class="settings-you">(شما)</span>' : ''} <span class="settings-user-phone">${escapeHtml(userPhone)}</span></div>
            <div class="user-role"><span class="role-badge ${u.role === 'admin' ? 'role-admin' : 'role-user'}">${userRole}</span>${groupBadge}</div>
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
  const userDisplay = userDisplayName(u) || u.username
  const userPhone = u.phone || '—'
  const userRole = u.role === 'admin' ? 'مدیر' : 'کاربر'

  if (u.role === 'admin') {
    detail.innerHTML = `
      <div class="settings-detail-head">
        <div class="user-name">${escapeHtml(userDisplay)}${isCurrentUser ? ' <span class="settings-you">(شما)</span>' : ''}</div>
        <div class="user-role">${escapeHtml(userPhone)} · <span class="role-badge role-admin">${userRole}</span></div>
      </div>
      <div class="settings-admin-full">دسترسی کامل (مدیر سیستم) — خارج از گروه‌های کاربری</div>
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

  const membership = getMembershipByPhone(u.phone)
  const groups = getGroupsCache()
  const managedCount = membership?.isManager
    ? getManagedMemberPhonesFromCache(u.phone).length
    : 0
  const groupOptions = [
    `<option value="">بدون گروه</option>`,
    ...groups.map(g =>
      `<option value="${escapeAttr(g.id)}"${membership?.group.id === g.id ? ' selected' : ''}>${escapeHtml(g.name)}</option>`
    )
  ].join('')

  const groupHtml = `
    <div class="settings-user-group-block">
      <div class="settings-perm-group-head" style="margin-bottom:6px;">
        <span>گروه کاربری</span>
      </div>
      <p class="settings-pane-desc" style="margin-bottom:8px;">هر کاربر حداکثر در یک گروه عضو است. مدیر گروه به‌صورت خودکار داده‌های سایر اعضای گروه را می‌بیند (و با مجوز انتقال می‌تواند مالکیت را جابه‌جا کند). مدیریت اعضا و مدیر در بخش «گروه‌ها و اعضا».</p>
      <div class="form-row" style="gap:8px;align-items:flex-end;flex-wrap:wrap;">
        <div class="form-group" style="flex:1;min-width:160px;margin:0;">
          <label>گروه</label>
          <select class="form-select" id="settingsUserGroupSelect" onchange="app.changeUserGroupAssignment('${escapeAttr(u.username)}', this.value)">
            ${groupOptions}
          </select>
        </div>
      </div>
      <div class="settings-group-role-line" style="margin-top:8px;">
        ${membership
          ? `<span class="role-badge ${membership.isManager ? 'role-admin' : 'role-user'}">${membership.isManager ? 'مدیر گروه' : 'عضو گروه'}</span>
             <span class="settings-pane-desc">${escapeHtml(membership.group.name)}${membership.isManager && managedCount ? ` · مشاهده ${managedCount} عضو` : ''}</span>`
          : '<span class="settings-pane-desc">هنوز در گروهی عضو نیست</span>'}
      </div>
    </div>`

  detail.innerHTML = `
    <div class="settings-detail-head">
      <div class="user-name">${escapeHtml(userDisplay)}${isCurrentUser ? ' <span class="settings-you">(شما)</span>' : ''}</div>
      <div class="user-role">${escapeHtml(userPhone)} · <span class="role-badge role-user">${userRole}</span></div>
    </div>
    <div class="settings-user-perms">
      ${permsHtml}
      ${groupHtml}
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

export async function changeUserGroupAssignment(username, groupId) {
  if (!requireMainAdmin()) return
  const u = _settingsUsersCache.find(x => x.username === username)
  if (!u?.phone) {
    showToast('کاربر شماره موبایل ندارد')
    return
  }
  try {
    await assignUserToGroup(u.phone, groupId || null)
    await loadGroupsData()
    _settingsUsersCache = await getUsers()
    renderUsersListMaster()
    renderSelectedUserDetail(false)
    showToast(groupId ? 'عضویت گروه به‌روز شد' : 'کاربر از گروه خارج شد')
  } catch (e) {
    console.error('changeUserGroupAssignment error:', e)
    showToast(e.message || 'خطا در تغییر گروه')
    renderSelectedUserDetail(false)
  }
}

// ============================================
// Groups settings UI
// ============================================

function updateGroupsLayoutMode(showDetail) {
  const layout = document.getElementById('settingsGroupsLayout')
  if (!layout) return
  layout.classList.toggle('show-detail', !!showDetail)
  const back = document.getElementById('settingsGroupsBack')
  if (back) back.hidden = !showDetail
}

export function backToGroupsList() {
  updateGroupsLayoutMode(false)
}

export async function renderGroupsSettings() {
  try {
    if (!_settingsUsersCache.length) {
      _settingsUsersCache = await getUsers()
    }
    await loadGroupsData()
  } catch (e) {
    console.error('renderGroupsSettings error:', e)
    const list = document.getElementById('settingsGroupsList')
    if (list) {
      list.innerHTML = '<div class="settings-list-error">خطا در بارگذاری گروه‌ها — ابتدا migration جداول را اعمال کنید</div>'
    }
    return
  }
  renderGroupsListMaster()
  if (_selectedSettingsGroup && getGroupsCache().some(g => g.id === _selectedSettingsGroup)) {
    renderSelectedGroupDetail(false)
  } else {
    _selectedSettingsGroup = null
    const detail = document.getElementById('settingsGroupDetailBody')
    if (detail) detail.innerHTML = '<div class="settings-empty-detail">یک گروه را از لیست انتخاب کنید</div>'
    updateGroupsLayoutMode(false)
  }
}

function renderGroupsListMaster() {
  const container = document.getElementById('settingsGroupsList')
  if (!container) return
  const groups = getGroupsCache()
  if (groups.length === 0) {
    container.innerHTML = '<div class="settings-empty-detail">هنوز گروهی تعریف نشده</div>'
    return
  }

  container.innerHTML = groups.map(g => {
    const members = getMembersOfGroup(g.id)
    const manager = members.find(m => m.is_manager)
    const managerUser = manager
      ? _settingsUsersCache.find(u => normalizePhone(u.phone) === manager.user_phone)
      : null
    const managerLabel = managerUser
      ? userDisplayName(managerUser) || manager.user_phone
      : (manager?.user_phone || 'بدون مدیر')
    const selected = _selectedSettingsGroup === g.id
    return `
      <div class="settings-user-item${selected ? ' is-selected' : ''}" data-group-id="${escapeAttr(g.id)}">
        <button type="button" class="settings-user-item-main" onclick="app.selectSettingsGroup('${escapeAttr(g.id)}')">
          <div class="user-info">
            <div class="user-name">${escapeHtml(g.name)}</div>
            <div class="user-role">${members.length} عضو · ${escapeHtml(managerLabel)}</div>
          </div>
        </button>
        <button type="button" class="btn-icon settings-user-delete" title="حذف گروه" onclick="app.deleteSettingsGroup('${escapeAttr(g.id)}')" style="color:var(--danger);">🗑</button>
      </div>
    `
  }).join('')
}

export function selectSettingsGroup(groupId) {
  _selectedSettingsGroup = groupId
  renderGroupsListMaster()
  renderSelectedGroupDetail(true)
}

function renderSelectedGroupDetail(enterMobileDetail) {
  const detail = document.getElementById('settingsGroupDetailBody')
  if (!detail) return
  const group = getGroupsCache().find(g => g.id === _selectedSettingsGroup)
  if (!group) {
    detail.innerHTML = '<div class="settings-empty-detail">یک گروه را از لیست انتخاب کنید</div>'
    updateGroupsLayoutMode(false)
    return
  }
  if (enterMobileDetail) updateGroupsLayoutMode(true)

  const members = getMembersOfGroup(group.id)
  const availableUsers = _settingsUsersCache.filter(u =>
    u.role !== 'admin' &&
    u.username !== 'admin' &&
    u.phone &&
    !getMembershipByPhone(u.phone)
  )

  const membersHtml = members.length === 0
    ? '<div class="settings-empty-detail">عضوی در این گروه نیست</div>'
    : members.map(m => {
        const user = _settingsUsersCache.find(u => normalizePhone(u.phone) === m.user_phone)
        const name = user ? (userDisplayName(user) || user.username) : m.user_phone
        return `
          <div class="settings-group-member-row">
            <div class="settings-group-member-info">
              <span class="user-name">${escapeHtml(name)}</span>
              <span class="view-users-phone">${escapeHtml(m.user_phone)}</span>
              ${m.is_manager ? '<span class="role-badge role-admin">مدیر گروه</span>' : '<span class="role-badge role-user">عضو</span>'}
            </div>
            <div class="settings-group-member-actions">
              ${!m.is_manager ? `<button type="button" class="btn btn-sm" onclick="app.makeGroupManager('${escapeAttr(group.id)}', '${escapeAttr(m.user_phone)}')">انتخاب به‌عنوان مدیر</button>` : ''}
              <button type="button" class="btn btn-sm" style="color:var(--danger);" onclick="app.removeSettingsGroupMember('${escapeAttr(group.id)}', '${escapeAttr(m.user_phone)}')">حذف</button>
            </div>
          </div>`
      }).join('')

  const addOptions = availableUsers.length === 0
    ? '<option value="">کاربر آزاد برای افزودن نیست</option>'
    : `<option value="">انتخاب کاربر…</option>${availableUsers.map(u => {
        const phone = normalizePhone(u.phone)
        return `<option value="${escapeAttr(phone)}">${escapeHtml(userDisplayName(u) || u.username)} · ${escapeHtml(phone)}</option>`
      }).join('')}`

  detail.innerHTML = `
    <div class="settings-detail-head">
      <div class="user-name">${escapeHtml(group.name)}</div>
      <div class="user-role">${members.length} عضو · ${members.some(m => m.is_manager) ? 'دارای مدیر' : 'بدون مدیر'}</div>
    </div>
    <div class="form-row settings-add-row" style="margin-bottom:12px;">
      <div class="form-group" style="flex:1;margin:0;">
        <label>نام گروه</label>
        <input type="text" class="form-input" id="settingsGroupRenameInput" value="${escapeAttr(group.name)}">
      </div>
      <button type="button" class="btn btn-sm btn-primary" onclick="app.renameSettingsGroup('${escapeAttr(group.id)}')">ذخیره نام</button>
    </div>
    <div class="settings-perm-group-head" style="margin-bottom:8px;"><span>اعضا</span></div>
    <div class="settings-group-members">${membersHtml}</div>
    <div class="form-row settings-add-row" style="margin-top:14px;">
      <div class="form-group" style="flex:1;margin:0;">
        <label>افزودن عضو</label>
        <select class="form-select" id="settingsGroupAddMemberSelect">${addOptions}</select>
      </div>
      <button type="button" class="btn btn-sm btn-primary" onclick="app.addSettingsGroupMember('${escapeAttr(group.id)}')">افزودن</button>
    </div>
    <p class="settings-pane-desc" style="margin-top:10px;">مدیر گروه به‌صورت خودکار مشتریان سایر اعضا را می‌بیند. هر گروه باید یک مدیر از بین اعضا داشته باشد.</p>
  `
}

export async function createSettingsGroup() {
  if (!requireMainAdmin()) return
  const input = document.getElementById('newGroupName')
  const name = (input?.value || '').trim()
  if (!name) {
    showToast('نام گروه را وارد کنید')
    return
  }
  try {
    const group = await createGroup(name)
    if (input) input.value = ''
    const details = document.getElementById('settingsAddGroupDetails')
    if (details) details.open = false
    _selectedSettingsGroup = group.id
    await renderGroupsSettings()
    renderSelectedGroupDetail(true)
    showToast('گروه ایجاد شد')
  } catch (e) {
    console.error('createSettingsGroup error:', e)
    showToast(e.message?.includes('unique') || e.code === '23505' ? 'نام گروه تکراری است' : (e.message || 'خطا در ایجاد گروه'))
  }
}

export async function renameSettingsGroup(groupId) {
  if (!requireMainAdmin()) return
  const name = (document.getElementById('settingsGroupRenameInput')?.value || '').trim()
  if (!name) {
    showToast('نام گروه را وارد کنید')
    return
  }
  try {
    await renameGroup(groupId, name)
    await renderGroupsSettings()
    showToast('نام گروه ذخیره شد')
  } catch (e) {
    console.error('renameSettingsGroup error:', e)
    showToast(e.message?.includes('unique') || e.code === '23505' ? 'نام گروه تکراری است' : (e.message || 'خطا در ذخیره'))
  }
}

export function deleteSettingsGroup(groupId) {
  if (!requireMainAdmin()) return
  const group = getGroupsCache().find(g => g.id === groupId)
  const name = group?.name || 'گروه'
  const count = getMembersOfGroup(groupId).length
  document.getElementById('deleteMessage').textContent = count
    ? `گروه «${name}» و ${count} عضویت حذف می‌شود. ادامه؟`
    : `آیا از حذف گروه «${name}» مطمئن هستید؟`
  document.getElementById('deleteConfirmBtn').onclick = async function () {
    try {
      await deleteGroup(groupId)
      if (_selectedSettingsGroup === groupId) _selectedSettingsGroup = null
      _settingsUsersCache = await getUsers()
      document.getElementById('deleteModal').classList.remove('active')
      await renderGroupsSettings()
      showToast('گروه حذف شد')
    } catch (e) {
      console.error('deleteSettingsGroup error:', e)
      showToast('خطا در حذف گروه')
    }
  }
  document.getElementById('deleteModal').classList.add('active')
}

export async function addSettingsGroupMember(groupId) {
  if (!requireMainAdmin()) return
  const select = document.getElementById('settingsGroupAddMemberSelect')
  const phone = normalizePhone(select?.value || '')
  if (!phone) {
    showToast('کاربر را انتخاب کنید')
    return
  }
  try {
    const members = getMembersOfGroup(groupId)
    const asManager = members.length === 0
    await addGroupMember(groupId, phone, { asManager })
    _settingsUsersCache = await getUsers()
    await loadGroupsData()
    renderGroupsListMaster()
    renderSelectedGroupDetail(false)
    showToast(asManager ? 'عضو اضافه و به‌عنوان مدیر تنظیم شد' : 'عضو اضافه شد')
  } catch (e) {
    console.error('addSettingsGroupMember error:', e)
    showToast(e.message || 'خطا در افزودن عضو')
  }
}

export async function removeSettingsGroupMember(groupId, phone) {
  if (!requireMainAdmin()) return
  try {
    const member = getMembersOfGroup(groupId).find(m => m.user_phone === normalizePhone(phone))
    await removeGroupMember(groupId, phone)
    const remaining = getMembersOfGroup(groupId)
    if (member?.is_manager && remaining.length > 0 && !remaining.some(m => m.is_manager)) {
      await setGroupManager(groupId, remaining[0].user_phone)
      showToast('عضو حذف شد؛ مدیر جدید تعیین شد')
    } else {
      showToast('عضو حذف شد')
    }
    _settingsUsersCache = await getUsers()
    await loadGroupsData()
    renderGroupsListMaster()
    renderSelectedGroupDetail(false)
  } catch (e) {
    console.error('removeSettingsGroupMember error:', e)
    showToast(e.message || 'خطا در حذف عضو')
  }
}

export async function makeGroupManager(groupId, phone) {
  if (!requireMainAdmin()) return
  try {
    await setGroupManager(groupId, phone)
    _settingsUsersCache = await getUsers()
    await loadGroupsData()
    renderGroupsListMaster()
    renderSelectedGroupDetail(false)
    showToast('مدیر گروه تغییر کرد')
  } catch (e) {
    console.error('makeGroupManager error:', e)
    showToast(e.message || 'خطا در تعیین مدیر')
  }
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

function clearSalesTargetBarFields() {
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
}

function clearSalesTargetForm() {
  _editingSalesTargetId = null
  _draftTargetBars = []
  _draftAllocations = {}
  const idEl = document.getElementById('editSalesTargetId')
  if (idEl) idEl.value = ''
  const titleEl = document.getElementById('salesTargetTitle')
  if (titleEl) titleEl.value = ''
  clearSalesTargetBarFields()
  const allocBox = document.getElementById('salesTargetAllocations')
  if (allocBox) allocBox.innerHTML = ''
  const saveBtn = document.getElementById('salesTargetSaveBtn')
  if (saveBtn) saveBtn.textContent = 'ذخیره گروه'
  const cancelBtn = document.getElementById('salesTargetCancelBtn')
  if (cancelBtn) cancelBtn.hidden = true
  renderSalesTargetDraftBars()
}

function refreshDashboardTargets() {
  try {
    if (typeof window.app?.renderDashboard === 'function') {
      window.app.renderDashboard()
    }
  } catch (e) {
    console.error('refreshDashboardTargets error:', e)
  }
}

export function onSalesTargetMetricChange() {
  const metric = document.getElementById('salesTargetMetric')?.value === 'count' ? 'count' : 'amount'
  const label = document.getElementById('salesTargetValueLabel')
  const input = document.getElementById('salesTargetValue')
  if (label) label.textContent = metric === 'count' ? 'مقدار هدف (تعداد)' : 'مقدار هدف (ریال)'
  if (input) input.placeholder = metric === 'count' ? 'مثلاً ۵۰' : 'مثلاً ۱۰۰۰۰۰۰۰۰'
}

function salesTargetBarMetaText(bar) {
  const metricLabel = bar.metric === 'count' ? 'تعداد' : 'مبلغ'
  const valueLabel = bar.metric === 'count'
    ? `${formatNumber(bar.value)} فروش`
    : `${formatNumber(bar.value)} ریال`
  const products = (bar.productNames || []).length
    ? bar.productNames.join('، ')
    : 'همه محصولات'
  const rangeParts = []
  if (bar.startDate) rangeParts.push(`از ${bar.startDate}`)
  if (bar.endDate) rangeParts.push(`تا ${bar.endDate}`)
  const range = rangeParts.length ? rangeParts.join(' ') : 'بدون بازه زمانی'
  return `${metricLabel}: ${valueLabel} · ${products} · ${range}`
}

function salesTargetBarShortLabel(bar, index) {
  const unit = bar.metric === 'count' ? 'فروش' : 'ریال'
  return `نوار ${formatNumber(index + 1)} · ${formatNumber(bar.value)} ${unit}`
}

function syncAllocationsFromDom() {
  const box = document.getElementById('salesTargetAllocations')
  if (!box) return
  box.querySelectorAll('input[data-alloc-group][data-alloc-bar]').forEach(input => {
    const gid = input.getAttribute('data-alloc-group') || ''
    const bid = input.getAttribute('data-alloc-bar') || ''
    if (!gid || !bid) return
    const value = parseSalesTargetValueInput(input.value)
    if (!_draftAllocations[gid]) _draftAllocations[gid] = {}
    if (Number.isFinite(value) && value > 0) _draftAllocations[gid][bid] = value
    else delete _draftAllocations[gid][bid]
  })
}

function pruneDraftAllocations(barIds) {
  const idSet = new Set(barIds || [])
  for (const gid of Object.keys(_draftAllocations)) {
    const shares = _draftAllocations[gid] || {}
    for (const bid of Object.keys(shares)) {
      if (!idSet.has(bid)) delete shares[bid]
    }
    if (!Object.keys(shares).length) delete _draftAllocations[gid]
  }
}

function loadDraftAllocationsFromGroup(group) {
  _draftAllocations = {}
  const box = document.getElementById('salesTargetAllocations')
  if (box) box.innerHTML = ''
  for (const alloc of group?.allocations || []) {
    const gid = alloc.userGroupId
    if (!gid) continue
    _draftAllocations[gid] = {}
    for (const share of alloc.shares || []) {
      if (share?.barId && Number(share.value) > 0) {
        _draftAllocations[gid][share.barId] = Number(share.value)
      }
    }
  }
}

function collectDraftAllocations(items) {
  syncAllocationsFromDom()
  const barIds = new Set((items || []).map(bar => bar.id))
  pruneDraftAllocations([...barIds])
  const allocations = []
  for (const [userGroupId, sharesMap] of Object.entries(_draftAllocations)) {
    const shares = Object.entries(sharesMap || {})
      .filter(([barId, value]) => barIds.has(barId) && Number(value) > 0)
      .map(([barId, value]) => ({ barId, value: Number(value) }))
    if (shares.length) allocations.push({ userGroupId, shares })
  }
  return allocations
}

function validateAllocationsAgainstBars(items, allocations) {
  for (const bar of items || []) {
    let sum = 0
    for (const alloc of allocations || []) {
      const share = (alloc.shares || []).find(s => s.barId === bar.id)
      if (share) sum += Number(share.value) || 0
    }
    if (sum > Number(bar.value)) {
      return `جمع سهم‌های «${salesTargetBarShortLabel(bar, (items || []).indexOf(bar))}» از مقدار هدف بیشتر است`
    }
  }
  return null
}

function updateSalesTargetAllocSums() {
  const sumsEl = document.getElementById('salesTargetAllocSums')
  if (!sumsEl) return
  if (!_draftTargetBars.length) {
    sumsEl.innerHTML = ''
    return
  }
  syncAllocationsFromDom()
  sumsEl.innerHTML = _draftTargetBars.map((bar, idx) => {
    let sum = 0
    for (const sharesMap of Object.values(_draftAllocations)) {
      sum += Number(sharesMap?.[bar.id]) || 0
    }
    const over = sum > Number(bar.value)
    const unit = bar.metric === 'count' ? 'فروش' : 'ریال'
    return `
      <div class="settings-target-alloc-sum${over ? ' is-over' : ''}">
        ${escapeHtml(salesTargetBarShortLabel(bar, idx))}:
        جمع سهم ${formatNumber(sum)} / هدف ${formatNumber(bar.value)} ${unit}
        ${over ? ' — بیش از هدف' : ''}
      </div>
    `
  }).join('')
}

function renderSalesTargetAllocations() {
  const box = document.getElementById('salesTargetAllocations')
  if (!box) return
  syncAllocationsFromDom()
  pruneDraftAllocations(_draftTargetBars.map(b => b.id))

  const userGroups = getGroupsCache()
  if (!_draftTargetBars.length) {
    box.innerHTML = '<div class="settings-target-draft-empty">اول نوار اضافه کنید تا سهمیه‌بندی فعال شود</div>'
    updateSalesTargetAllocSums()
    return
  }
  if (!userGroups.length) {
    box.innerHTML = '<div class="settings-target-draft-empty">هنوز گروه کاربری تعریف نشده</div>'
    updateSalesTargetAllocSums()
    return
  }

  box.innerHTML = `
    <div class="settings-target-alloc-table-wrap">
      <table class="settings-target-alloc-table">
        <thead>
          <tr>
            <th>گروه کاربری</th>
            ${_draftTargetBars.map((bar, idx) => `<th>${escapeHtml(salesTargetBarShortLabel(bar, idx))}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${userGroups.map(g => `
            <tr>
              <td>${escapeHtml(g.name || 'گروه')}</td>
              ${_draftTargetBars.map(bar => {
                const val = _draftAllocations[g.id]?.[bar.id]
                const display = val != null && val > 0 ? formatNumber(val) : ''
                return `<td>
                  <input type="text" class="form-input settings-target-alloc-input"
                    data-alloc-group="${escapeAttr(g.id)}"
                    data-alloc-bar="${escapeAttr(bar.id)}"
                    value="${escapeAttr(display)}"
                    placeholder="۰"
                    dir="ltr"
                    oninput="app.onSalesTargetAllocationChange(this)">
                </td>`
              }).join('')}
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `
  updateSalesTargetAllocSums()
}

export function onSalesTargetAllocationChange(inputEl) {
  if (inputEl) formatInput(inputEl)
  syncAllocationsFromDom()
  updateSalesTargetAllocSums()
}

function renderSalesTargetDraftBars() {
  const box = document.getElementById('salesTargetDraftBars')
  if (!box) return
  if (!_draftTargetBars.length) {
    box.innerHTML = '<div class="settings-target-draft-empty">هنوز نواری به این گروه اضافه نشده</div>'
    renderSalesTargetAllocations()
    return
  }
  box.innerHTML = _draftTargetBars.map((bar, idx) => `
    <div class="settings-target-draft-row">
      <div class="settings-config-meta">${escapeHtml(salesTargetBarMetaText(bar))}</div>
      <button type="button" class="btn-icon" title="حذف نوار" onclick="app.removeSalesTargetBarFromDraft(${idx})" style="color:var(--danger);">🗑</button>
    </div>
  `).join('')
  renderSalesTargetAllocations()
}

function readSalesTargetBarFromForm() {
  const metric = document.getElementById('salesTargetMetric')?.value === 'count' ? 'count' : 'amount'
  const value = parseSalesTargetValueInput(document.getElementById('salesTargetValue')?.value)
  const startDate = toEnDigits((document.getElementById('salesTargetStart')?.value || '').trim())
  const endDate = toEnDigits((document.getElementById('salesTargetEnd')?.value || '').trim())
  const productNames = getSelectedSalesTargetProducts()
  const hasValueInput = String(document.getElementById('salesTargetValue')?.value || '').trim() !== ''

  if (!hasValueInput) return { empty: true }
  if (!Number.isFinite(value) || value <= 0) return { error: 'مقدار هدف باید عدد مثبت باشد' }
  if (startDate && endDate && jalaliToNum(startDate) > jalaliToNum(endDate)) {
    return { error: 'تاریخ شروع نمی‌تواند بعد از تاریخ پایان باشد' }
  }
  return {
    bar: {
      id: `tgt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      metric,
      value,
      productNames,
      startDate,
      endDate,
      createdAt: new Date().toISOString()
    }
  }
}

export function addSalesTargetBarToDraft() {
  if (!requireMainAdmin()) return
  const parsed = readSalesTargetBarFromForm()
  if (parsed.empty) { showToast('مقدار هدف را وارد کنید'); return }
  if (parsed.error) { showToast(parsed.error); return }

  _draftTargetBars.push(parsed.bar)
  clearSalesTargetBarFields()
  renderSalesTargetDraftBars()
  showToast('نوار به گروه اضافه شد')
}

export function removeSalesTargetBarFromDraft(index) {
  if (!requireMainAdmin()) return
  const idx = Number(index)
  if (!Number.isInteger(idx) || idx < 0 || idx >= _draftTargetBars.length) return
  const removed = _draftTargetBars[idx]
  _draftTargetBars.splice(idx, 1)
  if (removed?.id) {
    for (const gid of Object.keys(_draftAllocations)) {
      if (_draftAllocations[gid]) delete _draftAllocations[gid][removed.id]
    }
  }
  renderSalesTargetDraftBars()
}

export function renderSalesTargetsSettings() {
  renderSalesTargetProductChecks(getSelectedSalesTargetProducts())
  onSalesTargetMetricChange()
  renderSalesTargetDraftBars()

  const list = document.getElementById('settingsSalesTargetsList')
  if (!list) return
  const groups = getSalesTargets()
  if (groups.length === 0) {
    list.innerHTML = '<div class="settings-empty-detail">هنوز گروهی ثبت نشده</div>'
    return
  }
  const userGroupName = (id) => getGroupsCache().find(g => g.id === id)?.name || 'گروه'
  list.innerHTML = groups.map(group => {
    const allocCount = (group.allocations || []).length
    const allocMeta = allocCount
      ? `سهمیه: ${formatNumber(allocCount)} گروه — ${(group.allocations || []).map(a => userGroupName(a.userGroupId)).join('، ')}`
      : 'بدون سهمیه‌بندی گروهی'
    return `
    <div class="settings-config-row settings-target-row${_editingSalesTargetId === group.id ? ' is-editing' : ''}">
      <div class="settings-config-label">
        <div>${escapeHtml(group.title)}</div>
        <div class="settings-config-meta">${(group.items || []).length} نوار · ${escapeHtml(allocMeta)}</div>
        <div class="settings-target-group-bars">
          ${(group.items || []).map(bar => `<div class="settings-config-meta">${escapeHtml(salesTargetBarMetaText(bar))}</div>`).join('')}
        </div>
      </div>
      <button type="button" class="btn-icon" title="ویرایش گروه" onclick="app.startSalesTargetEdit('${escapeAttr(group.id)}')">✏️</button>
      <button type="button" class="btn-icon" title="حذف گروه" onclick="app.removeSalesTarget('${escapeAttr(group.id)}')" style="color:var(--danger);">🗑</button>
    </div>
  `
  }).join('')
}

export function startSalesTargetEdit(id) {
  if (!requireMainAdmin()) return
  const group = getSalesTargets().find(t => t.id === id)
  if (!group) return
  _editingSalesTargetId = id
  _draftTargetBars = (group.items || []).map(bar => ({
    ...bar,
    productNames: [...(bar.productNames || [])]
  }))
  loadDraftAllocationsFromGroup(group)
  const idEl = document.getElementById('editSalesTargetId')
  if (idEl) idEl.value = id
  const titleEl = document.getElementById('salesTargetTitle')
  if (titleEl) titleEl.value = group.title || ''
  clearSalesTargetBarFields()
  const saveBtn = document.getElementById('salesTargetSaveBtn')
  if (saveBtn) saveBtn.textContent = 'ذخیره تغییرات گروه'
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
  if (!title) { showToast('عنوان گروه را وارد کنید'); return }

  const pending = readSalesTargetBarFromForm()
  if (pending.error) { showToast(pending.error); return }

  const items = [
    ..._draftTargetBars.map(bar => ({
      ...bar,
      productNames: [...(bar.productNames || [])]
    })),
    ...(pending.bar ? [{ ...pending.bar, productNames: [...(pending.bar.productNames || [])] }] : [])
  ]

  if (!items.length) {
    showToast('حداقل یک نوار به گروه اضافه کنید')
    return
  }

  const allocations = collectDraftAllocations(items)
  const allocError = validateAllocationsAgainstBars(items, allocations)
  if (allocError) {
    showToast(allocError)
    return
  }

  const existing = getSalesTargets()
  const editingId = _editingSalesTargetId || document.getElementById('editSalesTargetId')?.value || ''
  let next
  if (editingId && existing.some(t => t.id === editingId)) {
    next = existing.map(t => t.id === editingId ? {
      ...t,
      title,
      items,
      allocations
    } : t)
  } else {
    next = [...existing, {
      id: `grp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      title,
      items,
      allocations,
      createdAt: new Date().toISOString()
    }]
  }

  try {
    await saveSalesTargets(next)
    clearSalesTargetForm()
    renderSalesTargetsSettings()
    refreshDashboardTargets()
    showToast(editingId ? 'گروه تارگت ذخیره شد' : 'گروه تارگت اضافه شد')
  } catch (e) {
    console.error('saveSalesTargetForm error:', e)
    showToast('خطا در ذخیره گروه تارگت')
  }
}

export async function removeSalesTarget(id) {
  if (!requireMainAdmin()) return
  const group = getSalesTargets().find(t => t.id === id)
  if (!group) return
  openSettingsConfirm(`حذف گروه «${group.title}» و تمام نوارهایش؟`, async () => {
    try {
      await saveSalesTargets(getSalesTargets().filter(t => t.id !== id))
      if (_editingSalesTargetId === id) clearSalesTargetForm()
      renderSalesTargetsSettings()
      refreshDashboardTargets()
      showToast('گروه تارگت حذف شد')
    } catch (e) {
      console.error('removeSalesTarget error:', e)
      showToast('خطا در حذف گروه تارگت')
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

  // Preserve group-derived viewUserPhones (not edited via boolean chips)
  const cached = _settingsUsersCache.find(u => u.username === username)
  const phone = normalizePhone(cached?.phone)
  const membership = phone ? getMembershipByPhone(phone) : null
  permissions.viewUserPhones = membership?.isManager
    ? getManagedMemberPhonesFromCache(phone)
    : []

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
      setCurrentUser({ ...current, permissions, viewUserPhones: permissions.viewUserPhones })
      applyPermissions()
    }
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
