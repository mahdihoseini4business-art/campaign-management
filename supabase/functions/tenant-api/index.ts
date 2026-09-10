// Tenant owner API — invite members, subscription info
// Requires Bearer JWT of a tenant owner (or platform admin)

import { serve } from "https://deno.land/std@0.177.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function parseAllowlist(): Set<string> {
  const raw = Deno.env.get('PLATFORM_ADMIN_PHONES') || ''
  return new Set(
    raw
      .split(',')
      .map((p) => p.trim())
      .filter((p) => /^09\d{9}$/.test(p))
  )
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

    const authUserId = userData.user.id
    const phoneMeta = String(userData.user.user_metadata?.phone || '').trim()
    const admin = createClient(supabaseUrl, serviceKey)
    const body = await req.json().catch(() => ({}))
    const action = String(body?.action || '')

    const { data: me } = await admin
      .from('users')
      .select('username, phone')
      .eq('auth_user_id', authUserId)
      .maybeSingle()

    if (!me?.username) {
      return json({ success: false, error: 'کاربر یافت نشد' }, 403)
    }

    const isPlatform = phoneMeta && parseAllowlist().has(phoneMeta)

    if (action === 'invite_member') {
      const tenantId = String(body?.tenant_id || '').trim()
      const invitePhone = String(body?.phone || '').trim()
      const firstName = String(body?.first_name || '').trim()
      const lastName = String(body?.last_name || '').trim()
      const role = body?.role === 'admin' ? 'admin' : 'user'
      const memberRole = role === 'admin' ? 'user' : 'user' // tenant_members: owner|user — invited admins stay "user" unless promoting owner later; app role admin is separate

      if (!tenantId) return json({ success: false, error: 'tenant_id لازم است' }, 400)
      if (!/^09\d{9}$/.test(invitePhone)) {
        return json({ success: false, error: 'شماره موبایل صحیح نیست' }, 400)
      }
      if (!firstName || !lastName) {
        return json({ success: false, error: 'نام و نام خانوادگی لازم است' }, 400)
      }

      const { data: membership } = await admin
        .from('tenant_members')
        .select('role')
        .eq('tenant_id', tenantId)
        .eq('username', me.username)
        .maybeSingle()

      // Gate on tenant_members.role only — users.role=admin is global and must not
      // authorize cross-tenant invites.
      if (!isPlatform && membership?.role !== 'owner') {
        return json({ success: false, error: 'فقط مالک سازمان می‌تواند دعوت کند' }, 403)
      }

      let username: string
      const { data: existing } = await admin
        .from('users')
        .select('username, phone')
        .eq('phone', invitePhone)
        .maybeSingle()

      if (existing?.username) {
        username = existing.username
        const { data: already } = await admin
          .from('tenant_members')
          .select('username')
          .eq('tenant_id', tenantId)
          .eq('username', username)
          .maybeSingle()
        if (already) {
          return json({ success: false, error: 'این کاربر هم‌اکنون عضو سازمان است' }, 409)
        }
      } else {
        username = `u_${invitePhone}`
        const { error: uErr } = await admin.from('users').upsert({
          username,
          phone: invitePhone,
          first_name: firstName,
          last_name: lastName,
          display_name: `${firstName} ${lastName}`.trim(),
          role,
          permissions: role === 'admin' ? null : {
            dashboard: true,
            customers_view: true,
            customers_add: true,
            followups_view: true,
            followups_add: true,
            sales_view: true
          },
        }, { onConflict: 'username' })
        if (uErr) return json({ success: false, error: uErr.message }, 500)
      }

      const { error: mErr } = await admin.from('tenant_members').upsert({
        tenant_id: tenantId,
        username,
        role: memberRole,
      })
      if (mErr) return json({ success: false, error: mErr.message }, 500)

      await admin.from('audit_log').insert({
        tenant_id: tenantId,
        actor_username: me.username,
        actor_auth_user_id: userData.user.id,
        action: 'tenant.invite_member',
        entity_type: 'user',
        entity_id: username,
        meta: { phone: invitePhone, role },
      })

      return json({
        success: true,
        member: { username, phone: invitePhone, role },
      })
    }

    if (action === 'subscription_status') {
      const tenantId = String(body?.tenant_id || '').trim()
      if (!tenantId) return json({ success: false, error: 'tenant_id لازم است' }, 400)

      const { data: membership } = await admin
        .from('tenant_members')
        .select('role')
        .eq('tenant_id', tenantId)
        .eq('username', me.username)
        .maybeSingle()

      if (!isPlatform && !membership) {
        return json({ success: false, error: 'دسترسی ندارید' }, 403)
      }

      const { data: tenant } = await admin
        .from('tenants')
        .select('id, name, slug, status, subdomain, archived_at')
        .eq('id', tenantId)
        .maybeSingle()
      const { data: sub } = await admin
        .from('subscriptions')
        .select('plan_id, status, trial_ends_at, ends_at, starts_at')
        .eq('tenant_id', tenantId)
        .maybeSingle()
      const { data: plan } = sub?.plan_id
        ? await admin.from('plans').select('id, name_fa, features').eq('id', sub.plan_id).maybeSingle()
        : { data: null }

      return json({
        success: true,
        tenant,
        subscription: sub,
        plan,
        member_role: membership?.role || null,
      })
    }

    if (action === 'list_payments') {
      const tenantId = String(body?.tenant_id || '').trim()
      if (!tenantId) return json({ success: false, error: 'tenant_id لازم است' }, 400)

      const { data: membership } = await admin
        .from('tenant_members')
        .select('role')
        .eq('tenant_id', tenantId)
        .eq('username', me.username)
        .maybeSingle()

      if (!isPlatform && !membership) {
        return json({ success: false, error: 'دسترسی ندارید' }, 403)
      }

      const { data, error } = await admin
        .from('billing_payments')
        .select('id, plan_id, period, amount_irr, status, ref_id, gateway, paid_at, created_at')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false })
        .limit(50)
      if (error) return json({ success: false, error: error.message }, 500)
      return json({ success: true, payments: data || [] })
    }

    return json({ success: false, error: 'action نامعتبر است' }, 400)
  } catch (error) {
    console.error('tenant-api error', error)
    return json({ success: false, error: 'خطای غیرمنتظره' }, 500)
  }
})
