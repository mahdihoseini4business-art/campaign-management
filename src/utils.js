// ============================================
// Utility Functions
// ============================================

/** Customer lead-source platforms (value → Persian label) */
export const PLATFORM_LABELS = {
  instagram: 'اینستاگرام',
  telegram: 'تلگرام',
  whatsapp: 'واتساپ',
  website: 'سایت',
  bale: 'بله',
  eitaa: 'ایتا',
  goftino: 'گفتینو',
  carno_leads: 'کارنو لیدز',
  rubika: 'روبیکا',
  referral: 'ارجاعی',
}

/** CSS class for platform color dots */
export const PLATFORM_CLASSES = {
  instagram: 'platform-ig',
  telegram: 'platform-tg',
  whatsapp: 'platform-wa',
  website: 'platform-web',
  bale: 'platform-bale',
  eitaa: 'platform-eitaa',
  goftino: 'platform-goftino',
  carno_leads: 'platform-carno',
  rubika: 'platform-rubika',
  referral: 'platform-referral',
}

/** Map Persian/English import aliases → canonical platform key */
export const PLATFORM_MAP_IMPORT = {
  'اینستاگرام': 'instagram', instagram: 'instagram', 'اینستا': 'instagram', insta: 'instagram',
  'تلگرام': 'telegram', telegram: 'telegram', tg: 'telegram',
  'واتساپ': 'whatsapp', whatsapp: 'whatsapp', wa: 'whatsapp',
  'سایت': 'website', website: 'website', site: 'website', web: 'website',
  'بله': 'bale', bale: 'bale',
  'ایتا': 'eitaa', eitaa: 'eitaa', eita: 'eitaa',
  'گفتینو': 'goftino', goftino: 'goftino',
  'کارنو لیدز': 'carno_leads', 'کارنولیدز': 'carno_leads', carno_leads: 'carno_leads', 'carno leads': 'carno_leads', carno: 'carno_leads',
  'روبیکا': 'rubika', rubika: 'rubika',
  'ارجاعی': 'referral', referral: 'referral', referred: 'referral',
}

/** Build a profile/chat URL when the platform supports one; otherwise ''. */
export function getPlatformUrl(platform, platformId, phone) {
  const id = (platformId || '').trim()
  if (!id && platform !== 'whatsapp') return ''

  switch (platform) {
    case 'instagram':
      return `https://instagram.com/${encodeURIComponent(id.replace(/^@/, ''))}`
    case 'telegram':
      return `https://telegram.me/${encodeURIComponent(id.replace(/^@/, ''))}`
    case 'whatsapp': {
      const raw = String(phone || id).replace(/\D/g, '')
      if (!raw) return ''
      const intl = raw.startsWith('0') ? `98${raw.slice(1)}` : raw
      return `https://wa.me/${encodeURIComponent(intl)}`
    }
    case 'website':
      if (/^https?:\/\//i.test(id)) return id
      return `https://${id}`
    case 'bale':
      return `https://ble.ir/${encodeURIComponent(id.replace(/^@/, ''))}`
    case 'eitaa':
      return `https://eitaa.com/${encodeURIComponent(id.replace(/^@/, ''))}`
    default:
      return ''
  }
}

export function toEnDigits(str) {
  return String(str).replace(/[\u06F0-\u06F9\u0660-\u0669]/g, ch =>
    String.fromCharCode(ch.charCodeAt(0) + (ch >= '\u06F0' ? -1728 : -1584))
  )
}

export function formatNumber(n) {
  if (n === '' || n === null || n === undefined) return ''
  const num = typeof n === 'string' ? n.replace(/[^\d.-]/g, '') : n
  if (num === '' || isNaN(num)) return ''
  return Number(num).toLocaleString('en-US')
}

export function formatInput(el) {
  let raw = el.value.replace(/[^\d-]/g, '')
  // Handle negative sign at the beginning
  if (raw.startsWith('-')) {
    raw = '-' + raw.replace(/-/g, '')
  } else {
    raw = raw.replace(/-/g, '')
  }
  el.value = raw ? Number(raw).toLocaleString('en-US') : ''
}

export function unformatInput(el) {
  return el.value.replace(/[^\d-]/g, '')
}

export function escapeHtml(str) {
  if (!str) return ''
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/`/g, '&#96;')
}

export function escapeAttr(str) {
  if (str === null || str === undefined) return ''
  return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

let toastTimer = null

export function showToast(msg) {
  const t = document.getElementById('toast')
  if (!t) return
  if (toastTimer) clearTimeout(toastTimer)
  t.textContent = msg
  t.classList.remove('show')
  void t.offsetWidth // force reflow
  t.classList.add('show')
  toastTimer = setTimeout(() => t.classList.remove('show'), 2500)
}

// ============================================
// Jalali Date Utilities
// ============================================

export function toJalali(gregorian) {
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
  if (days > 365) {
    jy += Math.floor((days - 1) / 365)
    days = (days - 1) % 365
  }
  let jm, jd
  if (days < 186) {
    jm = 1 + Math.floor(days / 31)
    jd = 1 + (days % 31)
  } else {
    jm = 7 + Math.floor((days - 186) / 30)
    jd = 1 + ((days - 186) % 30)
  }
  return { year: jy, month: jm, day: jd }
}

// Returns a numeric representation of a Jalali date for comparison/sorting.
// Empty/invalid dates return 99999999 (sorts to end of list).
export function jalaliToNum(dateStr) {
  if (!dateStr) return 99999999
  const parts = dateStr.split('/')
  if (parts.length !== 3) return 99999999
  const y = parseInt(parts[0]) || 0
  const m = parseInt(parts[1]) || 0
  const d = parseInt(parts[2]) || 0
  return y * 10000 + m * 100 + d
}

export function getTodayJalaliStr() {
  // Use Asia/Tehran timezone for consistent Jalali dates
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tehran' }))
  const j = toJalali(now)
  return `${j.year}/${String(j.month).padStart(2, '0')}/${String(j.day).padStart(2, '0')}`
}

export function getTodayJalaliNum() {
  return jalaliToNum(getTodayJalaliStr())
}

export function jalaliAddDays(dateStr, days) {
  const parts = dateStr.split('/').map(Number)
  let y = parts[0], m = parts[1], d = parts[2] + days
  // Jalali leap year check: Esfand has 30 days in leap years
  const isLeap = ((y + 2346) % 33) % 4 === 1
  const daysInMonth = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, isLeap ? 30 : 29]
  while (d > daysInMonth[m - 1]) { d -= daysInMonth[m - 1]; m++; if (m > 12) { m = 1; y++; } }
  while (d <= 0) { m--; if (m < 1) { m = 12; y--; } d += daysInMonth[m - 1] }
  return y * 10000 + m * 100 + d
}

// ============================================
// Permission System
// ============================================

export const ALL_PERMISSIONS = {
  dashboard: 'مشاهده داشبورد',
  customers_view: 'مشاهده مشتریان',
  customers_ld: 'مشاهده لیدها (LD)',
  customers_cs: 'مشاهده مشتریان تماسی (CS)',
  customers_add: 'افزودن و ویرایش مشتری',
  customers_delete: 'حذف مشتری',
  customers_import: 'ایمپورت اکسل مشتریان',
  customers_export: 'خروجی مشتریان',
  followups_view: 'مشاهده پیگیری‌ها',
  followups_add: 'افزودن و ویرایش پیگیری',
  followups_delete: 'حذف پیگیری',
  followups_export: 'خروجی پیگیری‌ها',
  sales_view: 'مشاهده فروش‌ها',
  sales_import: 'ایمپورت فروش',
  sales_export: 'خروجی فروش‌ها',
  settings: 'مدیریت کاربران'
}

export const PERMISSION_GROUPS = [
  { label: 'داشبرد', keys: ['dashboard'] },
  { label: 'مشتریان', keys: ['customers_view', 'customers_ld', 'customers_cs', 'customers_add', 'customers_delete', 'customers_import', 'customers_export'] },
  { label: 'پیگیری‌ها', keys: ['followups_view', 'followups_add', 'followups_delete', 'followups_export'] },
  { label: 'فروش‌ها', keys: ['sales_view', 'sales_import', 'sales_export'] },
  { label: 'سیستم', keys: ['settings'] }
]

export function getDefaultPermissions() {
  const p = {}
  Object.keys(ALL_PERMISSIONS).forEach(k => p[k] = true)
  p.customers_delete = false
  p.followups_delete = false
  p.settings = false
  return p
}

export function hasPermission(key) {
  const user = getCurrentUser()
  if (!user) return false
  if (user.role === 'admin') return true
  return user.permissions && user.permissions[key] === true
}

/** Guard for actions — shows toast and returns false when denied. */
export function requirePermission(key) {
  if (hasPermission(key)) return true
  showToast('شما به این بخش دسترسی ندارید')
  return false
}

/** Normalize Iranian mobile to digits starting with 09… */
export function normalizePhone(phone) {
  let p = toEnDigits(String(phone || '').replace(/[\s\-()]/g, ''))
  if (p.startsWith('+98')) p = '0' + p.slice(3)
  else if (p.startsWith('98') && p.length >= 12) p = '0' + p.slice(2)
  else if (p.length === 10 && p.startsWith('9')) p = '0' + p
  return p
}

export function userDisplayName(u) {
  if (!u) return ''
  return u.display_name || u.displayName ||
    `${u.first_name || u.firstName || ''} ${u.last_name || u.lastName || ''}`.trim() ||
    u.username || ''
}

/**
 * Ownership is keyed by advisorPhone (stable). Falls back to display-name
 * match only for legacy rows not yet backfilled.
 */
export function ownsCustomer(customer, user = getCurrentUser()) {
  if (!user || !customer) return false
  if (user.role === 'admin') return true

  const myPhone = normalizePhone(user.phone)
  const ownerPhone = normalizePhone(customer.advisorPhone)
  if (myPhone && ownerPhone) return myPhone === ownerPhone

  const myName = (user.displayName || '').trim()
  const advisorName = (customer.advisor || '').trim()
  if (myName && advisorName) return myName === advisorName
  return false
}

/** Whether the current user may view this customer (LD/CS type + ownership). */
export function canAccessCustomer(customer, user = getCurrentUser()) {
  if (!user || !customer) return false
  if (customer.id.startsWith('LD') && !hasPermission('customers_ld')) return false
  if (customer.id.startsWith('CS') && !hasPermission('customers_cs')) return false
  if (user.role !== 'admin' && !ownsCustomer(customer, user)) return false
  return true
}

/** Resolve advisor display name + phone from a phone value and users list */
export function resolveAdvisor(advisorPhoneOrName, users = []) {
  const raw = String(advisorPhoneOrName || '').trim()
  const asPhone = normalizePhone(raw)
  let user = null
  if (asPhone && /^09\d{9}$/.test(asPhone)) {
    user = users.find(u => normalizePhone(u.phone) === asPhone)
  }
  if (!user && raw) {
    user = users.find(u => userDisplayName(u) === raw)
  }
  if (user) {
    return { advisorPhone: normalizePhone(user.phone), advisor: userDisplayName(user) }
  }
  if (asPhone && /^09\d{9}$/.test(asPhone)) {
    return { advisorPhone: asPhone, advisor: raw }
  }
  return { advisorPhone: '', advisor: raw }
}

// ============================================
// Session (signed localStorage + server revalidation)
// ============================================

const SESSION_KEY = 'campaign_manager_session'
const SESSION_EXPIRY_HOURS = 24
const SESSION_SECRET = import.meta.env.VITE_HASH_SECRET || 'c4mp_m4n4g3r_s3cr3t_k3y_2024'

let cachedUser = null

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
}

async function signSessionPayload(payload) {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(stableStringify(payload)))
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Sync read of verified in-memory session (call restoreSession first). */
export function getCurrentUser() {
  return cachedUser
}

/** Verify HMAC envelope from localStorage and hydrate cache (SEC-M2). */
export async function restoreSession() {
  cachedUser = null
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null

    const envelope = JSON.parse(raw)
    if (!envelope || !envelope.data || !envelope.sig || !envelope.expiresAt) {
      localStorage.removeItem(SESSION_KEY)
      return null
    }

    if (Date.now() > envelope.expiresAt) {
      localStorage.removeItem(SESSION_KEY)
      return null
    }

    const payload = { data: envelope.data, expiresAt: envelope.expiresAt }
    const expectedSig = await signSessionPayload(payload)
    if (envelope.sig !== expectedSig) {
      localStorage.removeItem(SESSION_KEY)
      return null
    }

    cachedUser = { ...envelope.data, expiresAt: envelope.expiresAt }
    return cachedUser
  } catch (e) {
    localStorage.removeItem(SESSION_KEY)
    cachedUser = null
    return null
  }
}

export async function setCurrentUser(user) {
  const data = {
    username: user.username,
    displayName: user.displayName,
    firstName: user.firstName || null,
    lastName: user.lastName || null,
    phone: user.phone || null,
    role: user.role,
    permissions: user.permissions || null
  }
  const expiresAt = Date.now() + (SESSION_EXPIRY_HOURS * 60 * 60 * 1000)
  const payload = { data, expiresAt }
  const sig = await signSessionPayload(payload)
  const envelope = { ...payload, sig }

  cachedUser = { ...data, expiresAt }
  localStorage.setItem(SESSION_KEY, JSON.stringify(envelope))
  return cachedUser
}

export function clearCurrentUser() {
  cachedUser = null
  localStorage.removeItem(SESSION_KEY)
}

export function isAdmin() {
  const user = getCurrentUser()
  return user && user.role === 'admin'
}

// ============================================
// Global digit conversion listener
// ============================================

export function initDigitConversion() {
  document.addEventListener('input', function (e) {
    const el = e.target
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const converted = toEnDigits(el.value)
      if (el.value !== converted) el.value = converted
    }
  })
}
