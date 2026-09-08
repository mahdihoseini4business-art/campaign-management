// Platform admin API — requires JWT of allowlisted platform admin
// Actions: list_tenants | create_tenant | get_settings | update_settings

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

function slugify(name: string) {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\u0600-\u06ff-]/gi, '')
    .slice(0, 40)
  return base || `t-${Date.now().toString(36)}`
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

    const phone = String(userData.user.user_metadata?.phone || '').trim()
    const allow = parseAllowlist()
    if (!phone || !allow.has(phone)) {
      return json({ success: false, error: 'دسترسی مجاز نیست' }, 403)
    }

    const admin = createClient(supabaseUrl, serviceKey)
    const body = await req.json().catch(() => ({}))
    const action = String(body?.action || '')

    if (action === 'list_tenants') {
      const { data: tenants, error } = await admin
        .from('tenants')
        .select('id, name, slug, status, created_at')
        .order('created_at', { ascending: false })
      if (error) return json({ success: false, error: error.message }, 500)

      const { data: subs } = await admin.from('subscriptions').select('tenant_id, plan_id, status, trial_ends_at, ends_at')
      const subByTenant = new Map((subs || []).map((s) => [s.tenant_id, s]))
      const rows = (tenants || []).map((t) => ({
        ...t,
        subscription: subByTenant.get(t.id) || null,
      }))
      return json({ success: true, tenants: rows })
    }

    if (action === 'create_tenant') {
      const name = String(body?.name || '').trim()
      const ownerPhone = String(body?.owner_phone || '').trim()
      const planId = ['gold', 'diamond', 'trial'].includes(body?.plan_id) ? body.plan_id : 'trial'
      if (!name) return json({ success: false, error: 'نام سازمان لازم است' }, 400)
      if (ownerPhone && !/^09\d{9}$/.test(ownerPhone)) {
        return json({ success: false, error: 'شماره مالک معتبر نیست' }, 400)
      }

      const slug = `${slugify(name)}-${Date.now().toString(36)}`
      const { data: tenant, error: tErr } = await admin
        .from('tenants')
        .insert({ name, slug, status: 'active' })
        .select('id, name, slug, status')
        .single()
      if (tErr || !tenant) return json({ success: false, error: tErr?.message || 'ساخت سازمان ناموفق' }, 500)

      const trialDays = 7
      const trialEnds = planId === 'trial'
        ? new Date(Date.now() + trialDays * 86400000).toISOString()
        : null

      await admin.from('subscriptions').insert({
        tenant_id: tenant.id,
        plan_id: planId,
        status: planId === 'trial' ? 'trialing' : 'active',
        trial_ends_at: trialEnds,
        ends_at: trialEnds,
      })

      if (ownerPhone) {
        const { data: owner } = await admin
          .from('users')
          .select('username, role')
          .eq('phone', ownerPhone)
          .maybeSingle()

        let username = owner?.username
        if (!username) {
          username = `u_${ownerPhone}`
          await admin.from('users').upsert({
            username,
            phone: ownerPhone,
            first_name: '',
            last_name: '',
            display_name: ownerPhone,
            role: 'admin',
            permissions: null,
          }, { onConflict: 'username' })
        }

        await admin.from('tenant_members').upsert({
          tenant_id: tenant.id,
          username,
          role: 'owner',
        })
      }

      return json({ success: true, tenant })
    }

    if (action === 'get_settings') {
      const { data, error } = await admin.from('platform_settings').select('key, value')
      if (error) return json({ success: false, error: error.message }, 500)
      const settings: Record<string, unknown> = {}
      for (const row of data || []) settings[row.key] = row.value
      return json({ success: true, settings })
    }

    if (action === 'update_settings') {
      const entries = body?.settings
      if (!entries || typeof entries !== 'object') {
        return json({ success: false, error: 'settings نامعتبر است' }, 400)
      }
      const allowed = new Set([
        'grace_days',
        'trial_days',
        'sms_daily_limit_trial',
        'sms_daily_limit_gold',
        'sms_daily_limit_diamond',
      ])
      for (const [key, value] of Object.entries(entries)) {
        if (!allowed.has(key)) continue
        await admin.from('platform_settings').upsert({
          key,
          value,
          updated_at: new Date().toISOString(),
        })
      }
      return json({ success: true })
    }

    return json({ success: false, error: 'action نامعتبر است' }, 400)
  } catch (error) {
    console.error('platform-api error', error)
    return json({ success: false, error: 'خطای غیرمنتظره' }, 500)
  }
})
