// Edge Function: send-otp
// SMS credentials: SMS_* env only (not client-readable app_settings)
// Supports purpose: "tenant" (default) | "platform"

import { serve } from "https://deno.land/std@0.177.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const DEFAULT_API_URL = 'https://rest.payamak-panel.com/api/SmartSMS/Send'
const DEFAULT_MESSAGE_TEMPLATE = 'کد تأیید شما: {code}\n اعتبار: ۵ دقیقه'
const OTP_RATE_LIMIT_PER_HOUR = 5

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

function loadSmsConfigFromEnv() {
  const username = Deno.env.get('SMS_USERNAME') || ''
  const password = Deno.env.get('SMS_PASSWORD') || ''
  const sender = Deno.env.get('SMS_SENDER') || ''
  const apiUrl = Deno.env.get('SMS_API_URL') || DEFAULT_API_URL
  const messageTemplate = Deno.env.get('SMS_MESSAGE_TEMPLATE') || DEFAULT_MESSAGE_TEMPLATE
  if (!username || !password || !sender) return null
  return { username, password, sender, apiUrl, messageTemplate }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const body = await req.json()
    const phone = String(body?.phone || '').trim()
    const purpose = body?.purpose === 'platform' ? 'platform' : 'tenant'

    if (!phone || !/^09\d{9}$/.test(phone)) {
      return json({ success: false, error: 'شماره موبایل صحیح نیست' }, 400)
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !supabaseServiceKey) {
      return json({ success: false, error: 'خطای سرور' }, 500)
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    if (purpose === 'platform') {
      const allow = parseAllowlist()
      if (!allow.has(phone)) {
        // Do not reveal whether phone is allowlisted
        return json({ success: false, error: 'دسترسی مجاز نیست' }, 403)
      }
    } else {
      const { data: users, error: userError } = await supabase
        .from('users')
        .select('id, username')
        .eq('phone', phone)
        .limit(1)

      if (userError) {
        console.error('Error checking user:', userError)
        return json({ success: false, error: 'خطا در بررسی کاربر' }, 500)
      }
      if (!users?.length) {
        return json({ success: false, error: 'شماره موبایل در سیستم ثبت نشده' }, 404)
      }
    }

    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const { count, error: countError } = await supabase
      .from('otp_sessions')
      .select('id', { count: 'exact', head: true })
      .eq('phone', phone)
      .gte('created_at', since)

    if (countError) {
      console.error('OTP rate limit check failed:', countError)
    } else if ((count ?? 0) >= OTP_RATE_LIMIT_PER_HOUR) {
      return json({ success: false, error: 'تعداد درخواست کد بیش از حد مجاز است. بعداً تلاش کنید' }, 429)
    }

    const code = Math.floor(1000 + Math.random() * 9000).toString()
    const { error: insertError } = await supabase.from('otp_sessions').insert({
      phone,
      code,
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      attempts: 0,
      verified: false,
    })

    if (insertError) {
      console.error('Error inserting OTP:', insertError)
      return json({ success: false, error: 'خطا در ذخیره کد' }, 500)
    }

    const smsConfig = loadSmsConfigFromEnv()
    if (!smsConfig) {
      console.error('Missing SMS_* env credentials')
      return json({ success: false, error: 'تنظیمات SMS پیکربندی نشده' }, 500)
    }

    const smsText = smsConfig.messageTemplate.includes('{code}')
      ? smsConfig.messageTemplate.split('{code}').join(code)
      : `${smsConfig.messageTemplate}\n${code}`

    const smsResponse = await fetch(smsConfig.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: smsConfig.username,
        password: smsConfig.password,
        from: smsConfig.sender,
        to: phone,
        text: smsText,
      }),
    })

    const smsResult = await smsResponse.json()
    if (smsResult.RetStatus === 1) {
      return json({ success: true, message: 'کد تأیید ارسال شد' })
    }

    console.error('SMS send failed:', smsResult)
    return json({ success: false, error: 'خطا در ارسال پیامک' }, 500)
  } catch (error) {
    console.error('Unexpected error:', error)
    return json({ success: false, error: 'خطای غیرمنتظره' }, 500)
  }
})
