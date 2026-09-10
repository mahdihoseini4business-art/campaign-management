// Set/clear tenant subdomain + archive/unarchive tenant (platform or diamond owner)

import { serve } from "https://deno.land/std@0.177.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const RESERVED = new Set([
  'www', 'app', 'api', 'admin', 'platform', 'mail', 'ftp', 'cdn', 'static', 'dev', 'staging', 'signup', 'login',
])

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function parseAllowlist(): Set<string> {
  const raw = Deno.env.get('PLATFORM_ADMIN_PHONES') || ''
  return new Set(
    raw.split(',').map((p) => p.trim()).filter((p) => /^09\d{9}$/.test(p)),
  )
}

function normalizeLabel(raw: string) {
  return String(raw || '').trim().toLowerCase()
}

function validLabel(label: string) {
  if (label.length < 3 || label.length > 40) return false
  if (RESERVED.has(label)) return false
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)
}

async function writeAudit(
  admin: ReturnType<typeof createClient>,
  row: Record<string, unknown>,
) {
  await admin.from('audit_log').insert(row)
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SB_ANON_KEY') || ''
    if (!supabaseUrl || !serviceKey || !anonKey) {
      return json({ success: false, error: 'خطای سرور' }, 500)
    }

    const authHeader = req.headers.get('Authorization') || ''
    if (!authHeader.startsWith('Bearer ')) {
      return json({ success: false, error: 'احراز هویت لازم است' }, 401)
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const { data: userData, error: userErr } = await userClient.auth.getUser()
    if (userErr || !userData?.user) {
      return json({ success: false, error: 'نشست نامعتبر است' }, 401)
    }

    const admin = createClient(supabaseUrl, serviceKey)
    const phoneMeta = String(userData.user.user_metadata?.phone || '').trim()
    const isPlatform = phoneMeta && parseAllowlist().has(phoneMeta)

    const { data: me } = await admin
      .from('users')
      .select('username')
      .eq('auth_user_id', userData.user.id)
      .maybeSingle()
    if (!me?.username) return json({ success: false, error: 'کاربر یافت نشد' }, 403)

    const body = await req.json().catch(() => ({}))
    const action = String(body?.action || '')

    async function assertCanManageTenant(tenantId: string) {
      if (isPlatform) return { ok: true as const }
      const { data: membership } = await admin
        .from('tenant_members')
        .select('role')
        .eq('tenant_id', tenantId)
        .eq('username', me.username)
        .maybeSingle()
      // users.role=admin is global — never treat it as manage-any-tenant.
      if (membership?.role === 'owner') return { ok: true as const }
      return { ok: false as const, error: 'دسترسی ندارید' }
    }

    async function tenantHasSubdomainFeature(tenantId: string) {
      const { data: sub } = await admin
        .from('subscriptions')
        .select('plan_id, status')
        .eq('tenant_id', tenantId)
        .maybeSingle()
      if (!sub || !['trialing', 'active', 'grace'].includes(sub.status)) return false
      const { data: plan } = await admin
        .from('plans')
        .select('features')
        .eq('id', sub.plan_id)
        .maybeSingle()
      return plan?.features?.custom_subdomain === true
    }

    if (action === 'set_subdomain') {
      const tenantId = String(body?.tenant_id || '').trim()
      const label = normalizeLabel(body?.subdomain || '')
      if (!tenantId) return json({ success: false, error: 'tenant_id لازم است' }, 400)
      const gate = await assertCanManageTenant(tenantId)
      if (!gate.ok) return json({ success: false, error: gate.error }, 403)
      const hasFeature = await tenantHasSubdomainFeature(tenantId)
      if (!isPlatform && !hasFeature) {
        return json({ success: false, error: 'ساب‌دامین فقط در پلن الماسی فعال است' }, 403)
      }
      if (!validLabel(label)) {
        return json({ success: false, error: 'نام ساب‌دامین نامعتبر است' }, 400)
      }

      const { data: clash } = await admin
        .from('tenants')
        .select('id')
        .ilike('subdomain', label)
        .neq('id', tenantId)
        .maybeSingle()
      if (clash) return json({ success: false, error: 'این ساب‌دامین قبلاً گرفته شده' }, 409)

      const { error } = await admin.from('tenants').update({
        subdomain: label,
        updated_at: new Date().toISOString(),
      }).eq('id', tenantId)
      if (error) return json({ success: false, error: error.message }, 500)

      const entitlementOverride = !!(isPlatform && !hasFeature)
      await writeAudit(admin, {
        tenant_id: tenantId,
        actor_username: me.username,
        actor_auth_user_id: userData.user.id,
        action: 'tenant.subdomain_set',
        entity_type: 'tenant',
        entity_id: tenantId,
        meta: { subdomain: label, entitlement_override: entitlementOverride },
      })

      return json({ success: true, subdomain: label, entitlement_override: entitlementOverride })
    }

    if (action === 'clear_subdomain') {
      const tenantId = String(body?.tenant_id || '').trim()
      if (!tenantId) return json({ success: false, error: 'tenant_id لازم است' }, 400)
      const gate = await assertCanManageTenant(tenantId)
      if (!gate.ok) return json({ success: false, error: gate.error }, 403)

      const { error } = await admin.from('tenants').update({
        subdomain: null,
        updated_at: new Date().toISOString(),
      }).eq('id', tenantId)
      if (error) return json({ success: false, error: error.message }, 500)

      await writeAudit(admin, {
        tenant_id: tenantId,
        actor_username: me.username,
        actor_auth_user_id: userData.user.id,
        action: 'tenant.subdomain_clear',
        entity_type: 'tenant',
        entity_id: tenantId,
        meta: {},
      })
      return json({ success: true })
    }

    if (action === 'archive_tenant') {
      if (!isPlatform) return json({ success: false, error: 'فقط سوپرادمین' }, 403)
      const tenantId = String(body?.tenant_id || '').trim()
      if (!tenantId) return json({ success: false, error: 'tenant_id لازم است' }, 400)

      const { error } = await admin.from('tenants').update({
        status: 'suspended',
        archived_at: new Date().toISOString(),
        subdomain: null,
        updated_at: new Date().toISOString(),
      }).eq('id', tenantId)
      if (error) return json({ success: false, error: error.message }, 500)

      await admin.from('subscriptions').update({
        status: 'suspended',
        updated_at: new Date().toISOString(),
      }).eq('tenant_id', tenantId)

      await writeAudit(admin, {
        tenant_id: tenantId,
        actor_username: me.username,
        actor_auth_user_id: userData.user.id,
        action: 'tenant.archive',
        entity_type: 'tenant',
        entity_id: tenantId,
        meta: {},
      })
      return json({ success: true })
    }

    if (action === 'unarchive_tenant') {
      if (!isPlatform) return json({ success: false, error: 'فقط سوپرادمین' }, 403)
      const tenantId = String(body?.tenant_id || '').trim()
      if (!tenantId) return json({ success: false, error: 'tenant_id لازم است' }, 400)

      const { data: existing, error: exErr } = await admin
        .from('tenants')
        .select('id, archived_at')
        .eq('id', tenantId)
        .maybeSingle()
      if (exErr) return json({ success: false, error: exErr.message }, 500)
      if (!existing) return json({ success: false, error: 'سازمان یافت نشد' }, 404)
      if (!existing.archived_at) {
        return json({ success: false, error: 'این سازمان آرشیو نشده است' }, 400)
      }

      const { error } = await admin.from('tenants').update({
        status: 'active',
        archived_at: null,
        updated_at: new Date().toISOString(),
      }).eq('id', tenantId)
      if (error) return json({ success: false, error: error.message }, 500)

      const { data: sub } = await admin
        .from('subscriptions')
        .select('plan_id, status, ends_at, trial_ends_at')
        .eq('tenant_id', tenantId)
        .maybeSingle()

      let nextSubStatus = 'readonly'
      if (sub) {
        const now = Date.now()
        const endsAt = sub.ends_at ? new Date(sub.ends_at).getTime() : null
        const trialEnds = sub.trial_ends_at ? new Date(sub.trial_ends_at).getTime() : null
        if (sub.plan_id === 'trial' && trialEnds && trialEnds > now) {
          nextSubStatus = 'trialing'
        } else if (endsAt && endsAt > now) {
          nextSubStatus = 'active'
        } else if (!endsAt && sub.plan_id !== 'trial') {
          // legacy unpaid open-ended active — keep usable but admin should set ends_at
          nextSubStatus = 'active'
        }
        await admin.from('subscriptions').update({
          status: nextSubStatus,
          updated_at: new Date().toISOString(),
        }).eq('tenant_id', tenantId)
      }

      await writeAudit(admin, {
        tenant_id: tenantId,
        actor_username: me.username,
        actor_auth_user_id: userData.user.id,
        action: 'tenant.unarchive',
        entity_type: 'tenant',
        entity_id: tenantId,
        meta: { subscription_status: nextSubStatus },
      })
      return json({ success: true, subscription_status: nextSubStatus })
    }

    if (action === 'list_audit') {
      const tenantId = body?.tenant_id ? String(body.tenant_id) : ''
      if (!isPlatform) {
        if (!tenantId) return json({ success: false, error: 'tenant_id لازم است' }, 400)
        const gate = await assertCanManageTenant(tenantId)
        if (!gate.ok) return json({ success: false, error: gate.error }, 403)
      }
      let q = admin
        .from('audit_log')
        .select('id, tenant_id, actor_username, action, entity_type, entity_id, meta, created_at')
        .order('created_at', { ascending: false })
        .limit(100)
      if (tenantId) q = q.eq('tenant_id', tenantId)
      const { data, error } = await q
      if (error) return json({ success: false, error: error.message }, 500)
      return json({ success: true, logs: data || [] })
    }

    return json({ success: false, error: 'action نامعتبر است' }, 400)
  } catch (error) {
    console.error('tenant-ops error', error)
    return json({ success: false, error: 'خطای غیرمنتظره' }, 500)
  }
})
