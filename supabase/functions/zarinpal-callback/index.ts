// Zarinpal callback: verify payment, activate subscription, redirect to app

import { serve } from "https://deno.land/std@0.177.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"

function zarinpalVerifyUrl() {
  const sandbox = (Deno.env.get('ZARINPAL_SANDBOX') || 'true').toLowerCase() !== 'false'
  return sandbox
    ? 'https://sandbox.zarinpal.com/pg/v4/payment/verify.json'
    : 'https://api.zarinpal.com/pg/v4/payment/verify.json'
}

function periodDays(period: string) {
  return period === 'yearly' ? 365 : 30
}

function redirect(appUrl: string, params: Record<string, string>) {
  const q = new URLSearchParams(params).toString()
  return new Response(null, {
    status: 302,
    headers: { Location: `${appUrl}/payment-result.html?${q}` },
  })
}

async function activatePaidSubscription(
  admin: ReturnType<typeof createClient>,
  payment: {
    id: string
    tenant_id: string
    plan_id: string
    period: string
    amount_irr: number
  },
  refId: string | number
) {
  const days = periodDays(payment.period)
  const now = Date.now()
  const { data: existing } = await admin
    .from('subscriptions')
    .select('id, ends_at, status')
    .eq('tenant_id', payment.tenant_id)
    .maybeSingle()

  let base = now
  if (existing?.ends_at) {
    const prev = new Date(existing.ends_at).getTime()
    if (prev > now) base = prev
  }
  const endsAt = new Date(base + days * 86400000).toISOString()

  const subPatch = {
    plan_id: payment.plan_id,
    status: 'active',
    trial_ends_at: null,
    ends_at: endsAt,
    updated_at: new Date().toISOString(),
  }

  if (existing?.id) {
    await admin.from('subscriptions').update(subPatch).eq('tenant_id', payment.tenant_id)
  } else {
    await admin.from('subscriptions').insert({
      tenant_id: payment.tenant_id,
      starts_at: new Date().toISOString(),
      ...subPatch,
    })
  }

  const invoiceNumber = `INV-${Date.now().toString(36).toUpperCase()}`
  const { data: invoice } = await admin
    .from('billing_invoices')
    .insert({
      tenant_id: payment.tenant_id,
      payment_id: payment.id,
      number: invoiceNumber,
      plan_id: payment.plan_id,
      period: payment.period,
      amount_irr: payment.amount_irr,
      status: 'paid',
      payload: { ref_id: refId },
    })
    .select('id, number')
    .single()

  await admin.from('billing_payments').update({
    status: 'paid',
    ref_id: String(refId),
    invoice_id: invoice?.id || null,
    paid_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', payment.id)

  await admin.from('audit_log').insert({
    tenant_id: payment.tenant_id,
    actor_username: 'system:zarinpal',
    action: 'billing.payment_paid',
    entity_type: 'payment',
    entity_id: payment.id,
    meta: { plan_id: payment.plan_id, period: payment.period, ref_id: String(refId), ends_at: endsAt },
  })

  return { invoiceNumber: invoice?.number || invoiceNumber, endsAt }
}

serve(async (req) => {
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const merchantId = Deno.env.get('ZARINPAL_MERCHANT_ID') || ''
    const appUrl = (Deno.env.get('PUBLIC_APP_URL') || '').replace(/\/$/, '')

    if (!supabaseUrl || !serviceKey || !merchantId || !appUrl) {
      return new Response('misconfigured', { status: 500 })
    }

    const url = new URL(req.url)
    const status = String(url.searchParams.get('Status') || url.searchParams.get('status') || '')
    const authority = String(url.searchParams.get('Authority') || url.searchParams.get('authority') || '')
    const paymentId = String(url.searchParams.get('payment_id') || '')

    if (!paymentId) {
      return redirect(appUrl, { status: 'error', message: 'payment_id_missing' })
    }

    const admin = createClient(supabaseUrl, serviceKey)
    const { data: payment, error } = await admin
      .from('billing_payments')
      .select('*')
      .eq('id', paymentId)
      .maybeSingle()

    if (error || !payment) {
      return redirect(appUrl, { status: 'error', message: 'payment_not_found' })
    }

    // Idempotent success
    if (payment.status === 'paid') {
      return redirect(appUrl, {
        status: 'ok',
        ref: payment.ref_id || '',
        payment_id: payment.id,
        plan: payment.plan_id,
      })
    }

    if (status !== 'OK' || !authority) {
      await admin.from('billing_payments').update({
        status: 'cancelled',
        updated_at: new Date().toISOString(),
        metadata: { ...(payment.metadata || {}), callback_status: status },
      }).eq('id', payment.id)
      return redirect(appUrl, { status: 'cancelled', payment_id: payment.id })
    }

    if (payment.authority && payment.authority !== authority) {
      return redirect(appUrl, { status: 'error', message: 'authority_mismatch' })
    }

    const verifyRes = await fetch(zarinpalVerifyUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        merchant_id: merchantId,
        amount: payment.amount_irr,
        authority,
      }),
    })
    const verifyJson = await verifyRes.json()
    const code = verifyJson?.data?.code
    const refId = verifyJson?.data?.ref_id

    // 100 = first verify success, 101 = already verified
    if (code !== 100 && code !== 101) {
      console.error('verify failed', verifyJson)
      await admin.from('billing_payments').update({
        status: 'failed',
        updated_at: new Date().toISOString(),
        metadata: { ...(payment.metadata || {}), verify: verifyJson },
      }).eq('id', payment.id)
      return redirect(appUrl, { status: 'failed', payment_id: payment.id })
    }

    if (payment.status === 'paid' || code === 101) {
      // Ensure activation if somehow paid without activate
      if (payment.status !== 'paid') {
        await activatePaidSubscription(admin, payment, refId || payment.ref_id || authority)
      }
      return redirect(appUrl, {
        status: 'ok',
        ref: String(refId || payment.ref_id || ''),
        payment_id: payment.id,
        plan: payment.plan_id,
      })
    }

    const result = await activatePaidSubscription(admin, payment, refId)
    return redirect(appUrl, {
      status: 'ok',
      ref: String(refId),
      payment_id: payment.id,
      plan: payment.plan_id,
      ends_at: result.endsAt,
      invoice: result.invoiceNumber,
    })
  } catch (error) {
    console.error('zarinpal-callback error', error)
    const appUrl = (Deno.env.get('PUBLIC_APP_URL') || '').replace(/\/$/, '')
    if (appUrl) return redirect(appUrl, { status: 'error', message: 'unexpected' })
    return new Response('error', { status: 500 })
  }
})
