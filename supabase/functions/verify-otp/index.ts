// Edge Function: verify-otp
// Issues Supabase Auth session after OTP; links users.auth_user_id
// purpose: "tenant" | "platform"

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
  return base || `org-${Date.now().toString(36)}`
}

function phoneToAuthEmail(phone: string) {
  return `${phone}@otp.carno.local`
}

async function loadTrialDays(supabase: ReturnType<typeof createClient>) {
  const { data } = await supabase
    .from('platform_settings')
    .select('value')
    .eq('key', 'trial_days')
    .maybeSingle()
  const n = Number(data?.value)
  return Number.isFinite(n) && n > 0 ? n : 7
}

async function findAuthUserIdByEmail(
  supabaseUrl: string,
  serviceKey: string,
  email: string
): Promise<string | null> {
  const res = await fetch(
    `${supabaseUrl}/auth/v1/admin/users?page=1&per_page=50`,
    {
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
      },
    }
  )
  if (!res.ok) return null
  const payload = await res.json()
  const users = payload?.users || []
  const found = users.find((u: { email?: string }) => u.email === email)
  return found?.id ?? null
}

async function ensureAuthSession(
  supabaseUrl: string,
  serviceKey: string,
  anonKey: string,
  phone: string,
  knownAuthUserId: string | null = null
) {
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const email = phoneToAuthEmail(phone)
  const password = crypto.randomUUID() + crypto.randomUUID()

  let authUserId: string | null = knownAuthUserId

  if (authUserId) {
    const { error: updateError } = await admin.auth.admin.updateUserById(authUserId, {
      password,
      email,
      email_confirm: true,
      user_metadata: { phone },
    })
    if (updateError) {
      console.warn('updateUserById failed, will recreate path', updateError)
      authUserId = null
    }
  }

  if (!authUserId) {
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { phone },
    })

    if (!createError && created?.user?.id) {
      authUserId = created.user.id
    } else {
      authUserId = await findAuthUserIdByEmail(supabaseUrl, serviceKey, email)
      if (!authUserId) {
        console.error('createUser failed and lookup missed', createError)
        throw new Error('auth user missing')
      }
      const { error: updateError } = await admin.auth.admin.updateUserById(authUserId, {
        password,
        email_confirm: true,
        user_metadata: { phone },
      })
      if (updateError) throw updateError
    }
  }

  const tokenRes = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  })
  const tokenJson = await tokenRes.json()
  if (!tokenRes.ok) {
    console.error('token grant failed', tokenJson)
    throw new Error('failed to create session')
  }

  return {
    authUserId,
    session: {
      access_token: tokenJson.access_token as string,
      refresh_token: tokenJson.refresh_token as string,
      expires_in: tokenJson.expires_in as number | undefined,
      token_type: tokenJson.token_type as string | undefined,
    },
  }
}

async function loadTenantsForUsername(supabase: ReturnType<typeof createClient>, username: string) {
  const tenants: Array<Record<string, unknown>> = []
  const { data: mem } = await supabase
    .from('tenant_members')
    .select('tenant_id, role')
    .eq('username', username)

  for (const m of mem || []) {
    const { data: t } = await supabase
      .from('tenants')
      .select('id, name, slug, status')
      .eq('id', m.tenant_id)
      .maybeSingle()
    const { data: sub } = await supabase
      .from('subscriptions')
      .select('plan_id, status')
      .eq('tenant_id', m.tenant_id)
      .maybeSingle()
    if (t) {
      tenants.push({
        id: t.id,
        name: t.name,
        slug: t.slug,
        status: t.status,
        member_role: m.role,
        plan_id: sub?.plan_id ?? null,
        subscription_status: sub?.status ?? null,
      })
    }
  }
  return tenants
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const body = await req.json()
    const phone = String(body?.phone || '').trim()
    const code = String(body?.code || '').trim()
    const purposeRaw = String(body?.purpose || 'tenant')
    const purpose = ['platform', 'register'].includes(purposeRaw) ? purposeRaw : 'tenant'

    if (!phone || !/^09\d{9}$/.test(phone)) {
      return json({ success: false, error: 'شماره موبایل صحیح نیست' }, 400)
    }
    if (!code || !/^\d{4}$/.test(code)) {
      return json({ success: false, error: 'کد تأیید باید ۴ رقمی باشد' }, 400)
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SB_ANON_KEY') || ''
    if (!supabaseUrl || !supabaseServiceKey || !anonKey) {
      console.error('Missing SUPABASE_URL / SERVICE_ROLE / ANON')
      return json({ success: false, error: 'خطای سرور' }, 500)
    }

    if (purpose === 'platform' && !parseAllowlist().has(phone)) {
      return json({ success: false, error: 'دسترسی مجاز نیست' }, 403)
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    const { data: otpSessions, error: fetchError } = await supabase
      .from('otp_sessions')
      .select('*')
      .eq('phone', phone)
      .eq('verified', false)
      .order('created_at', { ascending: false })
      .limit(1)

    if (fetchError) {
      console.error('Error fetching OTP:', fetchError)
      return json({ success: false, error: 'خطا در بررسی کد' }, 500)
    }
    if (!otpSessions?.length) {
      return json({ success: false, error: 'کد تأیید یافت نشد. لطفاً کد جدید بگیرید' }, 404)
    }

    const otpSession = otpSessions[0]
    if (new Date(otpSession.expires_at) < new Date()) {
      return json({ success: false, error: 'کد تأیید منقضی شده. لطفاً کد جدید بگیرید' }, 400)
    }
    if (otpSession.attempts >= 3) {
      return json({ success: false, error: 'تعداد تلاش‌ها بیش از حد مجاز است', locked: true }, 429)
    }
    if (otpSession.code !== code) {
      await supabase
        .from('otp_sessions')
        .update({ attempts: otpSession.attempts + 1 })
        .eq('id', otpSession.id)
      const remainingAttempts = 3 - (otpSession.attempts + 1)
      return json({
        success: false,
        error: `کد تأیید نادرست است (${remainingAttempts} تلاش باقی‌مانده)`,
      }, 400)
    }

    await supabase.from('otp_sessions').update({ verified: true }).eq('id', otpSession.id)

    if (purpose === 'platform') {
      await supabase.from('platform_admins').upsert({ phone, note: 'env-allowlist' })

      const { data: existing } = await supabase
        .from('users')
        .select('username, auth_user_id')
        .eq('phone', phone)
        .limit(1)
        .maybeSingle()

      const { authUserId, session } = await ensureAuthSession(
        supabaseUrl,
        supabaseServiceKey,
        anonKey,
        phone,
        existing?.auth_user_id || null
      )

      const username = existing?.username || `platform_${phone}`
      if (!existing) {
        await supabase.from('users').upsert({
          username,
          phone,
          first_name: 'Platform',
          last_name: 'Admin',
          display_name: 'Platform Admin',
          role: 'admin',
          permissions: null,
          auth_user_id: authUserId,
        }, { onConflict: 'username' })
      } else {
        await supabase.from('users').update({ auth_user_id: authUserId }).eq('username', username)
      }

      return json({
        success: true,
        purpose: 'platform',
        session,
        user: { phone, username, role: 'platform_admin' },
      })
    }

    if (purpose === 'register') {
      const orgName = String(body?.org_name || '').trim()
      const firstName = String(body?.first_name || '').trim()
      const lastName = String(body?.last_name || '').trim()
      if (!orgName || orgName.length < 2) {
        return json({ success: false, error: 'نام سازمان لازم است' }, 400)
      }
      if (!firstName || !lastName) {
        return json({ success: false, error: 'نام و نام خانوادگی لازم است' }, 400)
      }

      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const { count: dayCount } = await supabase
        .from('org_registration_log')
        .select('id', { count: 'exact', head: true })
        .eq('phone', phone)
        .gte('created_at', dayAgo)
      if ((dayCount ?? 0) >= 1) {
        return json({ success: false, error: 'امروز یک سازمان با این شماره ساخته‌اید' }, 429)
      }

      const { data: existingUser } = await supabase
        .from('users')
        .select('*')
        .eq('phone', phone)
        .limit(1)
        .maybeSingle()

      const { authUserId, session } = await ensureAuthSession(
        supabaseUrl,
        supabaseServiceKey,
        anonKey,
        phone,
        existingUser?.auth_user_id || null
      )

      const username = existingUser?.username || `u_${phone}`
      const displayName = `${firstName} ${lastName}`.trim()
      await supabase.from('users').upsert({
        username,
        phone,
        first_name: firstName,
        last_name: lastName,
        display_name: displayName,
        role: 'admin',
        permissions: null,
        auth_user_id: authUserId,
      }, { onConflict: 'username' })

      const slug = `${slugify(orgName)}-${Date.now().toString(36)}`
      const { data: tenant, error: tErr } = await supabase
        .from('tenants')
        .insert({ name: orgName, slug, status: 'active' })
        .select('id, name, slug, status')
        .single()
      if (tErr || !tenant) {
        console.error('create tenant', tErr)
        return json({ success: false, error: 'ساخت سازمان ناموفق بود' }, 500)
      }

      const trialDays = await loadTrialDays(supabase)
      const trialEnds = new Date(Date.now() + trialDays * 86400000).toISOString()
      await supabase.from('subscriptions').insert({
        tenant_id: tenant.id,
        plan_id: 'trial',
        status: 'trialing',
        trial_ends_at: trialEnds,
        ends_at: trialEnds,
      })

      await supabase.from('tenant_members').upsert({
        tenant_id: tenant.id,
        username,
        role: 'owner',
      })

      await supabase.from('org_registration_log').insert({
        phone,
        tenant_id: tenant.id,
        org_name: orgName,
      })

      const tenants = [{
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        status: tenant.status,
        member_role: 'owner',
        plan_id: 'trial',
        subscription_status: 'trialing',
      }]

      return json({
        success: true,
        purpose: 'register',
        session,
        tenants,
        user: {
          username,
          first_name: firstName,
          last_name: lastName,
          phone,
          display_name: displayName,
          role: 'admin',
          permissions: null,
          auth_user_id: authUserId,
        },
      })
    }

    const { data: users, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('phone', phone)
      .limit(1)

    if (userError || !users?.length) {
      return json({ success: false, error: 'کاربر یافت نشد' }, 404)
    }

    const user = users[0]
    const { authUserId, session } = await ensureAuthSession(
      supabaseUrl,
      supabaseServiceKey,
      anonKey,
      phone,
      user.auth_user_id || null
    )
    await supabase.from('users').update({ auth_user_id: authUserId }).eq('username', user.username)

    const { data: memberships } = await supabase
      .from('tenant_members')
      .select('tenant_id, role')
      .eq('username', user.username)

    if (!memberships?.length) {
      const { data: defaultTenant } = await supabase
        .from('tenants')
        .select('id')
        .eq('slug', 'default')
        .maybeSingle()
      if (defaultTenant?.id) {
        await supabase.from('tenant_members').upsert({
          tenant_id: defaultTenant.id,
          username: user.username,
          role: user.role === 'admin' || user.username === 'admin' ? 'owner' : 'user',
        })
      }
    }

    const tenants = await loadTenantsForUsername(supabase, user.username)

    return json({
      success: true,
      purpose: 'tenant',
      session,
      tenants,
      user: {
        id: user.id,
        username: user.username,
        first_name: user.first_name,
        last_name: user.last_name,
        phone: user.phone,
        display_name: user.display_name,
        role: user.role,
        permissions: user.permissions,
        auth_user_id: authUserId,
      },
    })
  } catch (error) {
    console.error('Unexpected error:', error)
    return json({ success: false, error: 'خطای غیرمنتظره' }, 500)
  }
})
