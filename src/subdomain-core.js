/**
 * Pure subdomain label helpers (no network).
 */

const RESERVED = new Set([
  'www', 'app', 'api', 'admin', 'platform', 'mail', 'ftp', 'cdn', 'static', 'dev', 'staging', 'signup', 'login'
])

/**
 * Extract subdomain label from hostname given root domain.
 * e.g. host=acme.carno.ir, root=carno.ir → "acme"
 */
export function extractSubdomainLabel(hostname, rootDomain) {
  const host = String(hostname || '').toLowerCase().split(':')[0]
  const root = String(rootDomain || '').toLowerCase().replace(/^\./, '')
  if (!host || !root) return null
  if (host === root || host === `www.${root}`) return null
  if (!host.endsWith(`.${root}`)) return null
  const label = host.slice(0, -(root.length + 1))
  if (!label || label.includes('.') || RESERVED.has(label)) return null
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) return null
  return label
}

export function validateSubdomainLabel(raw) {
  const label = String(raw || '').trim().toLowerCase()
  if (label.length < 3) return { ok: false, error: 'حداقل ۳ کاراکتر' }
  if (label.length > 40) return { ok: false, error: 'حداکثر ۴۰ کاراکتر' }
  if (RESERVED.has(label)) return { ok: false, error: 'این نام رزرو شده است' }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) {
    return { ok: false, error: 'فقط حروف انگلیسی کوچک، عدد و خط تیره' }
  }
  return { ok: true, label }
}

export { RESERVED as SUBDOMAIN_RESERVED }
