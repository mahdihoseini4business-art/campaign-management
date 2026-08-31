const SESSION_KEY = 'campaign_manager_session'
const SESSION_EXPIRY_HOURS = 24 * 7
const SESSION_SECRET = import.meta.env.VITE_HASH_SECRET || 'c4mp_m4n4g3r_s3cr3t_k3y_2024'

/** @type {object | null} */
let cachedUser = null

async function signPayload(payload) {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(JSON.stringify(payload)))
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
}

export function getCurrentUser() {
  return cachedUser
}

export async function restoreSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const envelope = JSON.parse(raw)
    if (!envelope?.payload || !envelope?.sig || !envelope?.expiresAt) {
      localStorage.removeItem(SESSION_KEY)
      return null
    }
    if (Date.now() > envelope.expiresAt) {
      localStorage.removeItem(SESSION_KEY)
      return null
    }
    const expected = await signPayload(envelope.payload)
    if (expected !== envelope.sig) {
      localStorage.removeItem(SESSION_KEY)
      return null
    }
    cachedUser = envelope.payload
    return cachedUser
  } catch {
    localStorage.removeItem(SESSION_KEY)
    return null
  }
}

export async function setCurrentUser(user) {
  const payload = {
    username: user.username,
    displayName: user.displayName,
    firstName: user.firstName,
    lastName: user.lastName,
    phone: user.phone,
    role: user.role,
    permissions: user.permissions,
    viewUserPhones: user.viewUserPhones || [],
    groupId: user.groupId || null,
    groupName: user.groupName || null,
    isGroupManager: !!user.isGroupManager
  }
  const expiresAt = Date.now() + (SESSION_EXPIRY_HOURS * 60 * 60 * 1000)
  const sig = await signPayload(payload)
  localStorage.setItem(SESSION_KEY, JSON.stringify({ payload, sig, expiresAt }))
  cachedUser = payload
  return payload
}

export function clearCurrentUser() {
  cachedUser = null
  localStorage.removeItem(SESSION_KEY)
}

export async function requireSession() {
  const user = await restoreSession()
  if (!user) {
    window.location.href = './login.html'
    return null
  }
  return user
}

export function toEnDigits(str) {
  return String(str || '')
    .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
}
