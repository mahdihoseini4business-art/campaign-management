/**
 * Phase 5: host → tenant subdomain resolution + helpers
 */
import { supabase } from './supabase.js'
import { canUseFeature } from './entitlements.js'
import { getStoredTenantId, setCurrentTenant, listMyTenants } from './tenant.js'

const RESERVED = new Set([
  'www', 'app', 'api', 'admin', 'platform', 'mail', 'ftp', 'cdn', 'static', 'dev', 'staging', 'signup', 'login'
])

/**
 * Extract subdomain label from hostname given root domain.
 * e.g. host=acme.carno.ir, root=carno.ir → "acme"
 * @param {string} hostname
 * @param {string} rootDomain
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

export async function fetchRootDomain() {
  try {
    const { data } = await supabase
      .from('platform_settings')
      .select('value')
      .eq('key', 'root_domain')
      .maybeSingle()
    const v = data?.value
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (v && typeof v === 'object' && typeof v.toString === 'function') {
      const s = String(v).replace(/^"|"$/g, '')
      if (s) return s
    }
  } catch {
    /* ignore */
  }
  return import.meta.env.VITE_ROOT_DOMAIN || 'carno.ir'
}

/**
 * Resolve tenant publicly by subdomain label (no tenant list leak).
 * @param {string} label
 */
export async function resolveTenantBySubdomain(label) {
  const { data, error } = await supabase.rpc('resolve_tenant_by_subdomain', {
    p_subdomain: label
  })
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : data
  return row || null
}

/**
 * On app boot: if visiting custom subdomain, pin that tenant when user is a member.
 * Does not auto-login; only constrains tenant selection after auth.
 */
export async function applyHostTenantHint() {
  const root = await fetchRootDomain()
  const label = extractSubdomainLabel(window.location.hostname, root)
  if (!label) return { matched: false }

  let remote = null
  try {
    remote = await resolveTenantBySubdomain(label)
  } catch (e) {
    console.warn('resolve subdomain', e)
    return { matched: false, error: e }
  }
  if (!remote?.id) return { matched: false, label }

  try {
    sessionStorage.setItem('carno_host_tenant_id', remote.id)
    sessionStorage.setItem('carno_host_tenant_label', label)
  } catch {
    /* ignore */
  }

  return { matched: true, tenant: remote, label }
}

export function getHostTenantHintId() {
  try {
    return sessionStorage.getItem('carno_host_tenant_id')
  } catch {
    return null
  }
}

/**
 * After login: prefer host-hint tenant if user is a member.
 */
export async function preferHostTenantIfMember(tenants = []) {
  const hint = getHostTenantHintId()
  if (!hint || !tenants?.length) return null
  const match = tenants.find((t) => t.id === hint)
  if (!match) return null
  await setCurrentTenant(match.id)
  return match
}

/**
 * Validate subdomain label client-side.
 */
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

export function canManageSubdomain() {
  return canUseFeature('custom_subdomain')
}

export async function writeAudit(action, { tenantId, entityType, entityId, meta } = {}) {
  const tid = tenantId || getStoredTenantId()
  try {
    await supabase.rpc('write_audit_log', {
      p_tenant_id: tid,
      p_action: action,
      p_entity_type: entityType || null,
      p_entity_id: entityId ? String(entityId) : null,
      p_meta: meta || {}
    })
  } catch (e) {
    console.warn('audit log', e)
  }
}
