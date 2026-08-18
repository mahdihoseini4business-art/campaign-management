// Edge Function برای تأیید OTP
// مسیر: /functions/v1/verify-otp

import { serve } from "https://deno.land/std@0.177.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"

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
    const { phone, code } = await req.json()

    // اعتبارسنجی ورودی‌ها
    if (!phone || !/^09\d{9}$/.test(phone)) {
      return new Response(
        JSON.stringify({ success: false, error: 'شماره موبایل صحیح نیست' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!code || code.length !== 4 || !/^\d{4}$/.test(code)) {
      return new Response(
        JSON.stringify({ success: false, error: 'کد تأیید باید ۴ رقمی باشد' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ایجاد اتصال به دیتابیس
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    if (!supabaseUrl || !supabaseServiceKey) {
      return new Response(
        JSON.stringify({ success: false, error: 'خطای سرور' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // پیدا کردن آخرین OTP برای این شماره
    const { data: otpSessions, error: fetchError } = await supabase
      .from('otp_sessions')
      .select('*')
      .eq('phone', phone)
      .eq('verified', false)
      .order('created_at', { ascending: false })
      .limit(1)

    if (fetchError) {
      console.error('Error fetching OTP:', fetchError)
      return new Response(
        JSON.stringify({ success: false, error: 'خطا در بررسی کد' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!otpSessions || otpSessions.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'کد تأیید یافت نشد. لطفاً کد جدید بگیرید' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const otpSession = otpSessions[0]

    // بررسی انقضا
    if (new Date(otpSession.expires_at) < new Date()) {
      return new Response(
        JSON.stringify({ success: false, error: 'کد تأیید منقضی شده. لطفاً کد جدید بگیرید' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // بررسی تعداد تلاش‌ها
    if (otpSession.attempts >= 3) {
      return new Response(
        JSON.stringify({ success: false, error: 'تعداد تلاش‌ها بیش از حد مجاز است', locked: true }),
        { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // بررسی کد
    if (otpSession.code !== code) {
      // افزایش تعداد تلاش
      await supabase
        .from('otp_sessions')
        .update({ attempts: otpSession.attempts + 1 })
        .eq('id', otpSession.id)

      const remainingAttempts = 3 - (otpSession.attempts + 1)
      return new Response(
        JSON.stringify({
          success: false,
          error: `کد تأیید نادرست است (${remainingAttempts} تلاش باقی‌مانده)`
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // کد صحیح است - علامت‌گذاری به عنوان تأیید شده
    await supabase
      .from('otp_sessions')
      .update({ verified: true })
      .eq('id', otpSession.id)

    // پیدا کردن اطلاعات کاربر
    const { data: users, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('phone', phone)
      .limit(1)

    if (userError || !users || users.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'کاربر یافت نشد' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const user = users[0]

    console.log(`OTP verified successfully for ${phone}`)

    return new Response(
      JSON.stringify({
        success: true,
        user: {
          id: user.id,
          username: user.username,
          first_name: user.first_name,
          last_name: user.last_name,
          phone: user.phone,
          display_name: user.display_name,
          role: user.role,
          permissions: user.permissions
        }
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Unexpected error:', error)
    return new Response(
      JSON.stringify({ success: false, error: 'خطای غیرمنتظره' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
