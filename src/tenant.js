import { supabase } from './supabase.js'

const TENANT_KEY = 'carno_current_tenant_id'

export function getStoredTenantId() {
  try {
    return localStorage.getItem(TENANT_KEY) || null
  } catch {
    return null
  }
}

export function storeTenantId(tenantId) {
  try {
    if (tenantId) localStorage.setItem(TENANT_KEY, tenantId)
    else localStorage.removeItem(TENANT_KEY)
  } catch {
    /* ignore */
  }
}

/**
 * Apply Auth tokens from verify-otp Edge response.
 * @param {{ access_token: string, refresh_token: string }} session
 */
export async function applyAuthSession(session) {
  if (!session?.access_token || !session?.refresh_token) {
    throw new Error('session missing tokens')
  }
  const { error } = await supabase.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token
  })
  if (error) throw error
}

export async function clearAuthSession() {
  storeTenantId(null)
  try {
    await supabase.auth.signOut()
  } catch (e) {
    console.warn('signOut', e)
  }
}

/**
 * Set RLS tenant context on the server.
 * Clears local caches so a tenant switch cannot show another org's data.
 * @param {string} tenantId
 */
export async function setCurrentTenant(tenantId) {
  if (!tenantId) throw new Error('tenantId required')
  const prev = getStoredTenantId()
  const { data, error } = await supabase.rpc('set_current_tenant', {
    p_tenant_id: tenantId
  })
  if (error) throw error
  storeTenantId(tenantId)
  if (prev !== tenantId) {
    await clearTenantLocalCaches()
  }
  return data || tenantId
}

/** Invalidate process-local caches tied to the previous tenant context. */
async function clearTenantLocalCaches() {
  try {
    const { invalidateDerivedCache } = await import('./derived-cache.js')
    invalidateDerivedCache('all')
  } catch (e) {
    console.warn('clear derived-cache', e)
  }
  try {
    const { invalidateProductSalesCountCache } = await import('./data.js')
    invalidateProductSalesCountCache()
  } catch (e) {
    console.warn('clear product sales cache', e)
  }
  try {
    const { clearTabRenderCache } = await import('./tab-cache.js')
    clearTabRenderCache()
  } catch (e) {
    console.warn('clear tab-cache', e)
  }
  try {
    const { clearNotificationsCache } = await import('./notifications.js')
    clearNotificationsCache()
  } catch (e) {
    console.warn('clear notifications cache', e)
  }
  try {
    const { clearGroupsCache } = await import('./groups.js')
    clearGroupsCache()
  } catch (e) {
    console.warn('clear groups cache', e)
  }
  try {
    const { clearEntitlementsState } = await import('./entitlements.js')
    clearEntitlementsState()
  } catch (e) {
    console.warn('clear entitlements', e)
  }
}

export async function listMyTenants() {
  const { data, error } = await supabase.rpc('list_my_tenants')
  if (error) throw error
  return data || []
}

/**
 * After login: if one tenant, select it; if many, return list for UI picker.
 * @param {Array<{id: string}>} tenantsFromVerify
 */
export async function resolveTenantAfterLogin(tenantsFromVerify = []) {
  let tenants = Array.isArray(tenantsFromVerify) ? tenantsFromVerify : []
  if (!tenants.length) {
    try {
      tenants = await listMyTenants()
    } catch (e) {
      console.warn('listMyTenants', e)
    }
  }

  // Prefer custom-subdomain host hint when user is a member of that tenant
  try {
    const { preferHostTenantIfMember } = await import('./subdomain.js')
    const hostMatch = await preferHostTenantIfMember(tenants)
    if (hostMatch) {
      return { needsPicker: false, tenant: hostMatch, tenants }
    }
  } catch (e) {
    console.warn('host tenant prefer', e)
  }

  if (tenants.length === 1) {
    await setCurrentTenant(tenants[0].id)
    return { needsPicker: false, tenant: tenants[0], tenants }
  }
  if (tenants.length > 1) {
    const stored = getStoredTenantId()
    const match = stored && tenants.find((t) => t.id === stored)
    if (match) {
      await setCurrentTenant(match.id)
      return { needsPicker: false, tenant: match, tenants }
    }
    return { needsPicker: true, tenant: null, tenants }
  }
  return { needsPicker: false, tenant: null, tenants: [] }
}

/** Restore Auth + tenant context on app boot. */
export async function ensureTenantContextOnBoot() {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return { ok: false, reason: 'no_auth' }

  const stored = getStoredTenantId()
  if (stored) {
    try {
      await setCurrentTenant(stored)
      return { ok: true, tenantId: stored }
    } catch (e) {
      console.warn('restore tenant failed', e)
      storeTenantId(null)
    }
  }

  try {
    const tenants = await listMyTenants()
    if (tenants.length === 1) {
      await setCurrentTenant(tenants[0].id)
      return { ok: true, tenantId: tenants[0].id }
    }
    if (tenants.length > 1) {
      return { ok: false, reason: 'needs_picker', tenants }
    }
  } catch (e) {
    console.warn('ensureTenantContextOnBoot', e)
  }
  return { ok: false, reason: 'no_tenant' }
}
