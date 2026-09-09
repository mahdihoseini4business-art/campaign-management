/**
 * Phase 5: host → tenant subdomain resolution + helpers
 */
import { supabase } from './supabase.js'
import { canUseFeature } from './entitlements.js'
import { getStoredTenantId, setCurrentTenant } from './tenant.js'
import { extractSubdomainLabel, validateSubdomainLabel } from './subdomain-core.js'
import { PLATFORM_SETTING_DEFAULTS, coercePlatformSetting } from './platform/defaults.js'

export { extractSubdomainLabel, validateSubdomainLabel } from './subdomain-core.js'

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

export async function fetchRootDomain() {
  try {
    const { data } = await supabase
      .from('platform_settings')
      .select('value')
      .eq('key', 'root_domain')
      .maybeSingle()
    if (data && data.value != null) {
      return coercePlatformSetting('root_domain', data.value)
    }
  } catch {
    /* ignore */
  }
  return import.meta.env.VITE_ROOT_DOMAIN || PLATFORM_SETTING_DEFAULTS.root_domain
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
