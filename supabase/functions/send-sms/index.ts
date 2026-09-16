// Business SMS send — Melipayamak/SmartSMS via platform SMS_* secrets
// Auth: Bearer JWT; gates: tenant membership + sms_features + permissions + daily quota

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.8'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
}

const DEFAULT_API_URL = 'https://rest.payamak-panel.com/api/SmartSMS/Send'
const BULK_MAX = 50

const KIND_FEATURE: Record<string, string> = {
  shipment_queued: 'shipment_queued',
  shipment_shipped: 'shipment_shipped',
  sale_single: 'sales_single',
  sale_group: 'sales_group_debtors',
  customer_single: 'customer_single',
  customer_campaign: 'customer_campaign',
  followup_schedule: 'followup_on_schedule',
  followup_bulk: 'followup_bulk',
}

const KIND_PERM: Record<string, string | null> = {
  shipment_queued: 'sms_shipment_queued',
  shipment_shipped: 'sms_shipment_shipped',
  sale_single: 'sms_sales_single',
  sale_group: 'sms_sales_group',
  customer_single: 'sms_customer_single',
  customer_campaign: 'sms_customer_campaign',
  followup_schedule: 'sms_followup_schedule',
  followup_bulk: 'sms_followup_bulk',
}

const DEFAULT_FEATURES: Record<string, boolean> = {
  shipment_queued: true,
  shipment_shipped: true,
  sales_single: true,
  sales_group_debtors: true,
  customer_single: true,
  customer_campaign: true,
  followup_on_schedule: true,
  followup_bulk: true,
  templates_edit: true,
  history_view: true,
}

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function loadSmsConfigFromEnv() {
  const username = Deno.env.get('SMS_USERNAME') || ''
  const password = Deno.env.get('SMS_PASSWORD') || ''
  const sender = Deno.env.get('SMS_SENDER') || ''
  const apiUrl = Deno.env.get('SMS_API_URL') || DEFAULT_API_URL
  if (!username || !password || !sender) return null
  return { username, password, sender, apiUrl }
}

function normalizePhone(raw: unknown): string {
  const digits = String(raw || '').replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('09')) return digits
  if (digits.length === 10 && digits.startsWith('9')) return `0${digits}`
  if (digits.length === 12 && digits.startsWith('989')) return `0${digits.slice(2)}`
  return ''
}

function renderTemplate(body: string, vars: Record<string, string>): string {
  let out = String(body || '')
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{${k}}`).join(v ?? '')
  }
  return out.trim()
}

function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10)
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

    const admin = createClient(supabaseUrl, serviceKey)
    const body = await req.json().catch(() => ({}))
    const cronSecret = Deno.env.get('CRON_SECRET') || ''
    const providedCron = req.headers.get('x-cron-secret') || ''
    const isCron = !!(cronSecret && providedCron && providedCron === cronSecret)

    let meUsername = 'system'
    let mePermissions: Record<string, boolean> = {}
    let tenantId = String(body?.tenant_id || '').trim()

    if (!isCron) {
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
      const { data: me } = await admin
        .from('users')
        .select('username, phone, permissions, role')
        .eq('auth_user_id', authUserId)
        .maybeSingle()
      if (!me?.username) return json({ success: false, error: 'کاربر یافت نشد' }, 403)
      meUsername = me.username
      mePermissions = (me.permissions && typeof me.permissions === 'object') ? me.permissions : {}
      if (me.role === 'admin') {
        for (const k of Object.values(KIND_PERM)) {
          if (k) mePermissions[k] = true
        }
        mePermissions.sms_manage = true
        mePermissions.sms_history = true
      }
      if (!tenantId) return json({ success: false, error: 'tenant_id لازم است' }, 400)
      const { data: membership } = await admin
        .from('tenant_members')
        .select('role')
        .eq('tenant_id', tenantId)
        .eq('username', me.username)
        .maybeSingle()
      if (!membership) return json({ success: false, error: 'عضویت سازمان یافت نشد' }, 403)
    } else if (!tenantId) {
      return json({ success: false, error: 'tenant_id لازم است' }, 400)
    }

    const mode = String(body?.mode || 'single')

    // Quota peek — no send, no kind/recipients required
    if (mode === 'quota') {
      const { data: sub } = await admin
        .from('subscriptions')
        .select('plan_id')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      const planId = String(sub?.plan_id || 'trial')
      const limitKey = `sms_daily_limit_${planId}`
      const { data: limitRow } = await admin
        .from('platform_settings')
        .select('value')
        .eq('key', limitKey)
        .maybeSingle()
      const dayLimit = Number(limitRow?.value)
      const effectiveLimit = Number.isFinite(dayLimit) && dayLimit > 0
        ? dayLimit
        : (planId === 'diamond' ? 200 : planId === 'gold' ? 50 : 20)
      const day = todayUtcDate()
      const { data: usage } = await admin
        .from('sms_usage_daily')
        .select('sent_count')
        .eq('tenant_id', tenantId)
        .eq('day', day)
        .maybeSingle()
      const used = Number(usage?.sent_count || 0)
      const remaining = Math.max(0, effectiveLimit - used)
      return json({
        success: true,
        limit: effectiveLimit,
        used,
        remaining,
        plan_id: planId,
        day,
      })
    }

    const kind = String(body?.kind || '')
    const featureKey = KIND_FEATURE[kind]
    if (!featureKey) return json({ success: false, error: 'نوع پیامک نامعتبر است' }, 400)

    const { data: featRow } = await admin
      .from('app_settings')
      .select('value')
      .eq('tenant_id', tenantId)
      .eq('key', 'sms_features')
      .maybeSingle()
    const features = {
      ...DEFAULT_FEATURES,
      ...(featRow?.value && typeof featRow.value === 'object' ? featRow.value : {}),
    }
    if (features[featureKey] !== true) {
      return json({ success: false, error: 'این قابلیت پیامک برای سازمان غیرفعال است' }, 403)
    }

    const auto = !!body?.auto || isCron
    const permKey = KIND_PERM[kind]
    if (!auto && !isCron) {
      if (permKey && mePermissions[permKey] !== true && mePermissions.sms_manage !== true) {
        return json({ success: false, error: 'دسترسی ارسال این نوع پیامک را ندارید' }, 403)
      }
    }

    // Resolve message body
    let templateKey = String(body?.template_key || '').trim()
    let bodyText = body?.body_override != null ? String(body.body_override) : ''
    if (!bodyText && templateKey) {
      const { data: tpl } = await admin
        .from('sms_templates')
        .select('body, enabled')
        .eq('tenant_id', tenantId)
        .eq('key', templateKey)
        .maybeSingle()
      if (!tpl) return json({ success: false, error: 'قالب یافت نشد' }, 404)
      if (tpl.enabled === false) return json({ success: false, error: 'قالب غیرفعال است' }, 403)
      bodyText = String(tpl.body || '')
    }
    if (!bodyText) return json({ success: false, error: 'متن پیام خالی است' }, 400)

    type Recipient = {
      phone: string
      customer_id?: string
      vars?: Record<string, string>
      meta?: Record<string, unknown>
    }

    let recipients: Recipient[] = Array.isArray(body?.recipients) ? body.recipients : []
    if (!recipients.length && body?.phone) {
      recipients = [{
        phone: String(body.phone),
        customer_id: body.customer_id ? String(body.customer_id) : undefined,
        vars: (body.vars && typeof body.vars === 'object') ? body.vars : {},
        meta: (body.meta && typeof body.meta === 'object') ? body.meta : {},
      }]
    }
    if (!recipients.length) return json({ success: false, error: 'گیرنده مشخص نشده' }, 400)
    if (recipients.length > BULK_MAX) {
      return json({ success: false, error: `حداکثر ${BULK_MAX} گیرنده در هر درخواست` }, 400)
    }

    if (mode === 'preview') {
      const sample = recipients[0]
      const phone = normalizePhone(sample.phone)
      const rendered = renderTemplate(bodyText, {
        phone: phone || String(sample.phone || ''),
        ...(sample.vars || {}),
      })
      return json({ success: true, preview: rendered, phone })
    }

    // Quota
    const { data: sub } = await admin
      .from('subscriptions')
      .select('plan_id')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const planId = String(sub?.plan_id || 'trial')
    const limitKey = `sms_daily_limit_${planId}`
    const { data: limitRow } = await admin
      .from('platform_settings')
      .select('value')
      .eq('key', limitKey)
      .maybeSingle()
    const dayLimit = Number(limitRow?.value)
    const effectiveLimit = Number.isFinite(dayLimit) && dayLimit > 0
      ? dayLimit
      : (planId === 'diamond' ? 200 : planId === 'gold' ? 50 : 20)

    const day = todayUtcDate()
    const { data: usage } = await admin
      .from('sms_usage_daily')
      .select('sent_count')
      .eq('tenant_id', tenantId)
      .eq('day', day)
      .maybeSingle()
    const alreadySent = Number(usage?.sent_count || 0)
    const remaining = Math.max(0, effectiveLimit - alreadySent)

    const smsConfig = loadSmsConfigFromEnv()
    if (!smsConfig) {
      return json({ success: false, error: 'تنظیمات SMS پیکربندی نشده' }, 500)
    }

    const results: Array<Record<string, unknown>> = []
    let sent = 0
    let failed = 0
    let skipped = 0

    for (const r of recipients) {
      const phone = normalizePhone(r.phone)
      const vars = { phone, ...(r.vars || {}) }
      const text = renderTemplate(bodyText, vars as Record<string, string>)

      if (!phone || !/^09\d{9}$/.test(phone)) {
        skipped += 1
        const { data: logRow } = await admin.from('sms_logs').insert({
          tenant_id: tenantId,
          kind,
          template_key: templateKey || null,
          customer_id: r.customer_id || null,
          to_phone: String(r.phone || ''),
          body: text,
          status: 'skipped',
          error: 'شماره نامعتبر',
          triggered_by: meUsername,
          meta: r.meta || {},
        }).select('id').maybeSingle()
        results.push({ phone: r.phone, status: 'skipped', error: 'شماره نامعتبر', log_id: logRow?.id })
        continue
      }

      if (sent >= remaining) {
        failed += 1
        const { data: logRow } = await admin.from('sms_logs').insert({
          tenant_id: tenantId,
          kind,
          template_key: templateKey || null,
          customer_id: r.customer_id || null,
          to_phone: phone,
          body: text,
          status: 'failed',
          error: 'سقف روزانه پیامک پر شده است',
          triggered_by: meUsername,
          meta: r.meta || {},
        }).select('id').maybeSingle()
        results.push({ phone, status: 'failed', error: 'سقف روزانه', log_id: logRow?.id })
        continue
      }

      try {
        const smsResponse = await fetch(smsConfig.apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: smsConfig.username,
            password: smsConfig.password,
            from: smsConfig.sender,
            to: phone,
            text,
          }),
        })
        const smsResult = await smsResponse.json().catch(() => ({}))
        const ok = smsResult?.RetStatus === 1
        if (ok) {
          sent += 1
          const { data: logRow } = await admin.from('sms_logs').insert({
            tenant_id: tenantId,
            kind,
            template_key: templateKey || null,
            customer_id: r.customer_id || null,
            to_phone: phone,
            body: text,
            status: 'sent',
            provider_ref: String(smsResult?.StrRetStatus || smsResult?.Value || ''),
            triggered_by: meUsername,
            meta: r.meta || {},
          }).select('id').maybeSingle()
          results.push({ phone, status: 'sent', log_id: logRow?.id })
        } else {
          failed += 1
          const { data: logRow } = await admin.from('sms_logs').insert({
            tenant_id: tenantId,
            kind,
            template_key: templateKey || null,
            customer_id: r.customer_id || null,
            to_phone: phone,
            body: text,
            status: 'failed',
            error: JSON.stringify(smsResult).slice(0, 500),
            triggered_by: meUsername,
            meta: r.meta || {},
          }).select('id').maybeSingle()
          results.push({ phone, status: 'failed', error: 'ارسال ناموفق', log_id: logRow?.id })
        }
      } catch (e) {
        failed += 1
        const { data: logRow } = await admin.from('sms_logs').insert({
          tenant_id: tenantId,
          kind,
          template_key: templateKey || null,
          customer_id: r.customer_id || null,
          to_phone: phone,
          body: text,
          status: 'failed',
          error: String(e)?.slice(0, 500),
          triggered_by: meUsername,
          meta: r.meta || {},
        }).select('id').maybeSingle()
        results.push({ phone, status: 'failed', error: 'خطای شبکه', log_id: logRow?.id })
      }
    }

    if (sent > 0) {
      const { data: cur } = await admin
        .from('sms_usage_daily')
        .select('sent_count')
        .eq('tenant_id', tenantId)
        .eq('day', day)
        .maybeSingle()
      const next = Number(cur?.sent_count || 0) + sent
      await admin.from('sms_usage_daily').upsert({
        tenant_id: tenantId,
        day,
        sent_count: next,
      }, { onConflict: 'tenant_id,day' })
    }

    return json({
      success: failed === 0 && skipped < recipients.length,
      sent,
      failed,
      skipped,
      remaining: Math.max(0, remaining - sent),
      results,
    })
  } catch (error) {
    console.error('send-sms error:', error)
    return json({ success: false, error: 'خطای غیرمنتظره' }, 500)
  }
})
