// Edge Function برای ارسال OTP از طریق SmartSMS API
// مسیر: /functions/v1/send-otp
// تنظیمات پنل از app_settings.key = sms_panel خوانده می‌شود؛ در صورت نبود، از env

import { serve } from "https://deno.land/std@0.177.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const DEFAULT_API_URL = 'https://rest.payamak-panel.com/api/SmartSMS/Send'
const DEFAULT_MESSAGE_TEMPLATE = 'کد تأیید شما: {code}\n اعتبار: ۵ دقیقه'

function normalizeSmsPanel(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return {
    username: String(raw.username ?? '').trim(),
    password: String(raw.password ?? ''),
    sender: String(raw.sender ?? '').trim(),
    apiUrl: String(raw.apiUrl ?? '').trim(),
    messageTemplate: String(raw.messageTemplate ?? '').trim(),
  }
}

async function loadSmsPanelConfig(supabase) {
  let fromDb = {}
  try {
    const { data, error } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'sms_panel')
      .limit(1)
      .maybeSingle()

    if (!error && data?.value != null) {
      fromDb = normalizeSmsPanel(data.value)
    }
  } catch (e) {
    console.error('Failed to load sms_panel from app_settings:', e)
  }

  const username = fromDb.username || Deno.env.get('SMS_USERNAME') || ''
  const password = fromDb.password || Deno.env.get('SMS_PASSWORD') || ''
  const sender = fromDb.sender || Deno.env.get('SMS_SENDER') || ''
  const apiUrl = fromDb.apiUrl || Deno.env.get('SMS_API_URL') || DEFAULT_API_URL
  const messageTemplate = fromDb.messageTemplate || Deno.env.get('SMS_MESSAGE_TEMPLATE') || DEFAULT_MESSAGE_TEMPLATE

  if (!username || !password || !sender) return null

  return { username, password, sender, apiUrl, messageTemplate }
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { phone } = await req.json()

    // اعتبارسنجی شماره موبایل
    if (!phone || !/^09\d{9}$/.test(phone)) {
      return new Response(
        JSON.stringify({ success: false, error: 'شماره موبایل صحیح نیست' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ایجاد اتصال به دیتابیس با service role key
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
      return new Response(
        JSON.stringify({ success: false, error: 'خطای سرور' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // بررسی وجود کاربر با این شماره
    const { data: users, error: userError } = await supabase
      .from('users')
      .select('id, username, first_name, last_name')
      .eq('phone', phone)
      .limit(1)

    if (userError) {
      console.error('Error checking user:', userError)
      return new Response(
        JSON.stringify({ success: false, error: 'خطا در بررسی کاربر' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!users || users.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'شماره موبایل در سیستم ثبت نشده' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // تولید کد ۴ رقمی تصادفی
    const code = Math.floor(1000 + Math.random() * 9000).toString()

    // ذخیره OTP در دیتابیس
    const { error: insertError } = await supabase
      .from('otp_sessions')
      .insert({
        phone,
        code,
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(), // ۵ دقیقه
        attempts: 0,
        verified: false
      })

    if (insertError) {
      console.error('Error inserting OTP:', insertError)
      return new Response(
        JSON.stringify({ success: false, error: 'خطا در ذخیره کد' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const smsConfig = await loadSmsPanelConfig(supabase)
    if (!smsConfig) {
      console.error('Missing SMS credentials (app_settings.sms_panel or SMS_* env)')
      return new Response(
        JSON.stringify({ success: false, error: 'تنظیمات SMS پیکربندی نشده' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
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
        text: smsText
      })
    })

    const smsResult = await smsResponse.json()

    // بررسی نتیجه ارسال
    if (smsResult.RetStatus === 1) {
      console.log(`OTP sent successfully to ${phone}`)
      return new Response(
        JSON.stringify({ success: true, message: 'کد تأیید ارسال شد' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    } else {
      console.error('SMS send failed:', smsResult)
      return new Response(
        JSON.stringify({ success: false, error: 'خطا در ارسال پیامک' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

  } catch (error) {
    console.error('Unexpected error:', error)
    return new Response(
      JSON.stringify({ success: false, error: 'خطای غیرمنتظره' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
