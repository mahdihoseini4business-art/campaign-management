// Platform admin API — requires JWT of allowlisted platform admin
// Actions: list_tenants | create_tenant | get_settings | update_settings |
//          set_subscription | list_payments | record_manual_payment

import { serve } from "https://deno.land/std@0.177.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"

type AdminClient = ReturnType<typeof createClient>

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

/** Read a positive numeric platform_settings value (jsonb number or numeric string). */
async function readSettingNumber(
  admin: AdminClient,
  key: string,
  fallback: number,
): Promise<number> {
  const { data } = await admin.from('platform_settings').select('value').eq('key', key).maybeSingle()
  let raw: unknown = data?.value
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      /* keep string */
    }
  }
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function positiveDays(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
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
        .select('id, name, slug, status, subdomain, archived_at, created_at')
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

      const trialDays = await readSettingNumber(admin, 'trial_days', 7)
      const paidEndsDays = positiveDays(body?.ends_in_days, 30)
      const now = Date.now()
      let trialEnds: string | null = null
      let endsAt: string
      let subStatus: string
      if (planId === 'trial') {
        subStatus = 'trialing'
        trialEnds = new Date(now + trialDays * 86400000).toISOString()
        endsAt = trialEnds
      } else {
        subStatus = 'active'
        endsAt = new Date(now + paidEndsDays * 86400000).toISOString()
      }

      await admin.from('subscriptions').insert({
        tenant_id: tenant.id,
        plan_id: planId,
        status: subStatus,
        trial_ends_at: trialEnds,
        ends_at: endsAt,
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

      await admin.from('audit_log').insert({
        tenant_id: tenant.id,
        actor_username: phone,
        actor_auth_user_id: userData.user.id,
        action: 'platform.create_tenant',
        entity_type: 'tenant',
        entity_id: tenant.id,
        meta: {
          name,
          plan_id: planId,
          owner_phone: ownerPhone || null,
          ends_at: endsAt,
          trial_days: planId === 'trial' ? trialDays : null,
        },
      })

      return json({ success: true, tenant, ends_at: endsAt })
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
        'root_domain',
        'subdomain_min_length',
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

    if (action === 'set_subscription') {
      const tenantId = String(body?.tenant_id || '').trim()
      const planId = String(body?.plan_id || '').trim()
      const status = String(body?.status || '').trim()
      const allowedPlans = new Set(['trial', 'gold', 'diamond'])
      const allowedStatus = new Set(['trialing', 'active', 'grace', 'readonly', 'suspended'])
      if (!tenantId) return json({ success: false, error: 'tenant_id لازم است' }, 400)
      if (!allowedPlans.has(planId)) return json({ success: false, error: 'plan_id نامعتبر است' }, 400)
      if (!allowedStatus.has(status)) return json({ success: false, error: 'status نامعتبر است' }, 400)

      const trialDaysBody = Number(body?.trial_days)
      const trialDays = Number.isFinite(trialDaysBody) && trialDaysBody > 0
        ? trialDaysBody
        : await readSettingNumber(admin, 'trial_days', 7)
      const endsInDays = body?.ends_in_days != null && body?.ends_in_days !== ''
        ? Number(body.ends_in_days)
        : null
      const now = Date.now()
      const patch: Record<string, unknown> = {
        plan_id: planId,
        status,
        updated_at: new Date().toISOString(),
      }
      // Only trialing/active rewrite end dates. grace/readonly/suspended keep existing ends_at.
      if (status === 'trialing') {
        patch.trial_ends_at = new Date(now + trialDays * 86400000).toISOString()
        patch.ends_at = patch.trial_ends_at
      } else if (status === 'active') {
        patch.trial_ends_at = null
        if (endsInDays != null && Number.isFinite(endsInDays) && endsInDays > 0) {
          patch.ends_at = new Date(now + endsInDays * 86400000).toISOString()
        } else if (!body?.keep_ends_at) {
          patch.ends_at = new Date(now + 30 * 86400000).toISOString()
        }
      }

      const { data: existing } = await admin
        .from('subscriptions')
        .select('id')
        .eq('tenant_id', tenantId)
        .maybeSingle()

      if (existing?.id) {
        const { error } = await admin.from('subscriptions').update(patch).eq('tenant_id', tenantId)
        if (error) return json({ success: false, error: error.message }, 500)
      } else {
        const { error } = await admin.from('subscriptions').insert({
          tenant_id: tenantId,
          starts_at: new Date().toISOString(),
          ...patch,
        })
        if (error) return json({ success: false, error: error.message }, 500)
      }
      await admin.from('audit_log').insert({
        tenant_id: tenantId,
        actor_username: phone,
        actor_auth_user_id: userData.user.id,
        action: 'platform.set_subscription',
        entity_type: 'subscription',
        entity_id: tenantId,
        meta: { plan_id: planId, status, ends_in_days: endsInDays },
      })
      // Downgrade away from custom_subdomain entitlement: keep label but host resolve will fail
      return json({ success: true })
    }

    if (action === 'list_payments') {
      const tenantId = body?.tenant_id ? String(body.tenant_id) : ''
      let q = admin
        .from('billing_payments')
        .select('id, tenant_id, plan_id, period, amount_irr, status, ref_id, gateway, paid_at, created_at, authority')
        .order('created_at', { ascending: false })
        .limit(100)
      if (tenantId) q = q.eq('tenant_id', tenantId)
      const { data, error } = await q
      if (error) return json({ success: false, error: error.message }, 500)
      return json({ success: true, payments: data || [] })
    }

    if (action === 'record_manual_payment') {
      const tenantId = String(body?.tenant_id || '').trim()
      const planId = String(body?.plan_id || 'gold').trim()
      const period = body?.period === 'yearly' ? 'yearly' : 'monthly'
      const amount = Number(body?.amount_irr)
      const endsInDays = Number(body?.ends_in_days) || (period === 'yearly' ? 365 : 30)
      const note = String(body?.note || 'manual').trim()

      if (!tenantId) return json({ success: false, error: 'tenant_id لازم است' }, 400)
      if (!['gold', 'diamond'].includes(planId)) {
        return json({ success: false, error: 'plan_id نامعتبر' }, 400)
      }
      if (!Number.isFinite(amount) || amount <= 0) {
        return json({ success: false, error: 'مبلغ باید بزرگ‌تر از صفر باشد' }, 400)
      }

      const { data: payment, error: pErr } = await admin
        .from('billing_payments')
        .insert({
          tenant_id: tenantId,
          plan_id: planId,
          period,
          amount_irr: amount,
          status: 'manual',
          gateway: 'manual',
          ref_id: note.slice(0, 80),
          paid_at: new Date().toISOString(),
          metadata: { note },
        })
        .select('id')
        .single()
      if (pErr || !payment) return json({ success: false, error: pErr?.message || 'insert failed' }, 500)

      const invoiceNumber = `MAN-${Date.now().toString(36).toUpperCase()}`
      const { data: invoice } = await admin
        .from('billing_invoices')
        .insert({
          tenant_id: tenantId,
          payment_id: payment.id,
          number: invoiceNumber,
          plan_id: planId,
          period,
          amount_irr: amount,
          status: 'paid',
          payload: { manual: true, note },
        })
        .select('id')
        .single()

      await admin.from('billing_payments').update({ invoice_id: invoice?.id || null }).eq('id', payment.id)

      const now = Date.now()
      const { data: existing } = await admin
        .from('subscriptions')
        .select('id, ends_at')
        .eq('tenant_id', tenantId)
        .maybeSingle()
      let base = now
      if (existing?.ends_at) {
        const prev = new Date(existing.ends_at).getTime()
        if (prev > now) base = prev
      }
      const endsAt = new Date(base + endsInDays * 86400000).toISOString()
      const subPatch = {
        plan_id: planId,
        status: 'active',
        trial_ends_at: null,
        ends_at: endsAt,
        updated_at: new Date().toISOString(),
      }
      if (existing?.id) {
        await admin.from('subscriptions').update(subPatch).eq('tenant_id', tenantId)
      } else {
        await admin.from('subscriptions').insert({
          tenant_id: tenantId,
          starts_at: new Date().toISOString(),
          ...subPatch,
        })
      }

      await admin.from('audit_log').insert({
        tenant_id: tenantId,
        actor_username: phone,
        actor_auth_user_id: userData.user.id,
        action: 'platform.manual_payment',
        entity_type: 'payment',
        entity_id: payment.id,
        meta: { plan_id: planId, period, amount_irr: amount, ends_at: endsAt, note },
      })

      return json({ success: true, payment_id: payment.id, ends_at: endsAt })
    }

    return json({ success: false, error: 'action نامعتبر است' }, 400)
  } catch (error) {
    console.error('platform-api error', error)
    return json({ success: false, error: 'خطای غیرمنتظره' }, 500)
  }
})
