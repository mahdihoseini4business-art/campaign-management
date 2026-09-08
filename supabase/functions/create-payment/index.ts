// Create Zarinpal payment request for plan upgrade/renewal
// Requires Bearer JWT of tenant owner/admin

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

function zarinpalBase() {
  const sandbox = (Deno.env.get('ZARINPAL_SANDBOX') || 'true').toLowerCase() !== 'false'
  return {
    sandbox,
    requestUrl: sandbox
      ? 'https://sandbox.zarinpal.com/pg/v4/payment/request.json'
      : 'https://api.zarinpal.com/pg/v4/payment/request.json',
    startPay: sandbox
      ? 'https://sandbox.zarinpal.com/pg/StartPay/'
      : 'https://www.zarinpal.com/pg/StartPay/',
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SB_ANON_KEY') || ''
    const merchantId = Deno.env.get('ZARINPAL_MERCHANT_ID') || ''
    const appUrl = (Deno.env.get('PUBLIC_APP_URL') || '').replace(/\/$/, '')
    const callbackUrl = Deno.env.get('ZARINPAL_CALLBACK_URL')
      || `${supabaseUrl}/functions/v1/zarinpal-callback`

    if (!supabaseUrl || !serviceKey || !anonKey) {
      return json({ success: false, error: 'خطای سرور' }, 500)
    }
    if (!merchantId) {
      return json({ success: false, error: 'ZARINPAL_MERCHANT_ID تنظیم نشده' }, 500)
    }
    if (!appUrl) {
      return json({ success: false, error: 'PUBLIC_APP_URL تنظیم نشده' }, 500)
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
    const body = await req.json().catch(() => ({}))
    const tenantId = String(body?.tenant_id || '').trim()
    const planId = String(body?.plan_id || '').trim()
    const period = body?.period === 'yearly' ? 'yearly' : 'monthly'

    if (!tenantId) return json({ success: false, error: 'tenant_id لازم است' }, 400)
    if (!['gold', 'diamond'].includes(planId)) {
      return json({ success: false, error: 'فقط پلن طلایی یا الماسی قابل خرید است' }, 400)
    }

    const { data: me } = await admin
      .from('users')
      .select('username, role')
      .eq('auth_user_id', userData.user.id)
      .maybeSingle()
    if (!me?.username) return json({ success: false, error: 'کاربر یافت نشد' }, 403)

    const { data: membership } = await admin
      .from('tenant_members')
      .select('role')
      .eq('tenant_id', tenantId)
      .eq('username', me.username)
      .maybeSingle()

    if (!membership || (membership.role !== 'owner' && me.role !== 'admin')) {
      return json({ success: false, error: 'فقط مالک/ادمین سازمان می‌تواند پرداخت کند' }, 403)
    }

    const { data: plan } = await admin
      .from('plans')
      .select('id, name_fa, price_monthly_irr, price_yearly_irr')
      .eq('id', planId)
      .maybeSingle()
    if (!plan) return json({ success: false, error: 'پلن یافت نشد' }, 404)

    const amount = Number(period === 'yearly' ? plan.price_yearly_irr : plan.price_monthly_irr)
    if (!amount || amount < 1000) {
      return json({ success: false, error: 'مبلغ پلن نامعتبر است' }, 400)
    }

    const { data: payment, error: pErr } = await admin
      .from('billing_payments')
      .insert({
        tenant_id: tenantId,
        plan_id: planId,
        period,
        amount_irr: amount,
        status: 'pending',
        gateway: 'zarinpal',
        created_by_username: me.username,
        metadata: { app_url: appUrl },
      })
      .select('id')
      .single()
    if (pErr || !payment) {
      console.error(pErr)
      return json({ success: false, error: 'ثبت پرداخت ناموفق' }, 500)
    }

    const zp = zarinpalBase()
    const description = `اشتراک ${plan.name_fa || planId} (${period === 'yearly' ? 'سالانه' : 'ماهانه'})`
    const zpRes = await fetch(zp.requestUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        merchant_id: merchantId,
        amount,
        callback_url: `${callbackUrl}?payment_id=${payment.id}`,
        description,
        metadata: {
          mobile: userData.user.user_metadata?.phone || undefined,
          order_id: payment.id,
        },
      }),
    })
    const zpJson = await zpRes.json()
    const code = zpJson?.data?.code
    const authority = zpJson?.data?.authority
    if (code !== 100 || !authority) {
      console.error('zarinpal request failed', zpJson)
      await admin.from('billing_payments').update({
        status: 'failed',
        metadata: { zarinpal_error: zpJson },
        updated_at: new Date().toISOString(),
      }).eq('id', payment.id)
      return json({
        success: false,
        error: zpJson?.errors?.message || 'خطا در اتصال به زرین‌پال',
        zarinpal: zpJson,
      }, 502)
    }

    await admin.from('billing_payments').update({
      authority,
      updated_at: new Date().toISOString(),
    }).eq('id', payment.id)

    return json({
      success: true,
      payment_id: payment.id,
      authority,
      amount_irr: amount,
      redirect_url: `${zp.startPay}${authority}`,
      sandbox: zp.sandbox,
    })
  } catch (error) {
    console.error('create-payment error', error)
    return json({ success: false, error: 'خطای غیرمنتظره' }, 500)
  }
})
