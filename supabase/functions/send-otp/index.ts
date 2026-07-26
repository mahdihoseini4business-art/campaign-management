// Edge Function برای ارسال OTP از طریق SmartSMS API
// مسیر: /functions/v1/send-otp

import { serve } from "https://deno.land/std@0.177.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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

    // ارسال پیامک از طریق SmartSMS API
    const smsUsername = Deno.env.get('SMS_USERNAME')
    const smsPassword = Deno.env.get('SMS_PASSWORD')
    const smsSender = Deno.env.get('SMS_SENDER')

    if (!smsUsername || !smsPassword || !smsSender) {
      console.error('Missing SMS credentials')
      return new Response(
        JSON.stringify({ success: false, error: 'تنظیمات SMS پیکربندی نشده' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const smsText = `کد تأیید شما: ${code}\n اعتبار: ۵ دقیقه`

    const smsResponse = await fetch('https://rest.payamak-panel.com/api/SmartSMS/Send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: smsUsername,
        password: smsPassword,
        from: smsSender,
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
