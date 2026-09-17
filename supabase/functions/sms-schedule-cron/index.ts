// Process due sms_schedules and drip/scheduled campaigns
// Auth: x-cron-secret == CRON_SECRET

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.8'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
}

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function normalizePhone(raw: unknown): string {
  const digits = String(raw || '').replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('09')) return digits
  if (digits.length === 10 && digits.startsWith('9')) return `0${digits}`
  if (digits.length === 12 && digits.startsWith('989')) return `0${digits.slice(2)}`
  return ''
}

function formatBalanceFa(n: number): string {
  try {
    return Math.max(0, Math.floor(n || 0)).toLocaleString('fa-IR')
  } catch (_) {
    return String(Math.max(0, Math.floor(n || 0)))
  }
}

function jalaliParts(dateStr: string): { y: number, m: number, d: number } | null {
  const m = String(dateStr || '').trim().match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return { y, m: mo, d }
}

function isJalaliLeap(y: number): boolean {
  const breaks = [1, 5, 9, 13, 17, 22, 26, 30]
  return breaks.includes(y % 33)
}

function jalaliDaySerial(dateStr: string): number | null {
  const p = jalaliParts(dateStr)
  if (!p) return null
  let days = 0
  for (let yy = 1; yy < p.y; yy++) days += isJalaliLeap(yy) ? 366 : 365
  const dim = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, isJalaliLeap(p.y) ? 30 : 29]
  for (let mm = 1; mm < p.m; mm++) days += dim[mm - 1]
  return days + p.d
}

function todayJalaliInTehran(): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    calendar: 'persian',
  })
  const parts = fmt.formatToParts(new Date())
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value || 0)
  const y = get('year')
  const m = get('month')
  const d = get('day')
  if (!y || !m || !d) return ''
  return `${y}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`
}

function buildSettlementDayVars(settlementDate: string): Record<string, string> {
  const date = String(settlementDate || '').trim()
  if (!date) return { settlement_date: '', days_to_settlement: '', days_to_settlement_text: '' }
  const today = todayJalaliInTehran()
  const a = jalaliDaySerial(today)
  const b = jalaliDaySerial(date)
  if (a == null || b == null) {
    return { settlement_date: date, days_to_settlement: '', days_to_settlement_text: '' }
  }
  const days = b - a
  let text = 'امروز'
  if (days > 0) text = `${formatBalanceFa(days)} روز مانده`
  else if (days < 0) text = `${formatBalanceFa(-days)} روز از موعد گذشته`
  return {
    settlement_date: date,
    days_to_settlement: String(days),
    days_to_settlement_text: text,
  }
}

/** Recompute operational balance for a product line (approved + pending, not rejected). */
function operationalBalance(product: Record<string, unknown> | null | undefined): number {
  if (!product) return 0
  const price = Number(product.price) || 0
  const payments = Array.isArray(product.payments) ? product.payments : []
  let paid = 0
  for (const pay of payments) {
    const p = pay && typeof pay === 'object' ? pay as Record<string, unknown> : null
    if (!p) continue
    const status = String(p.paymentStatus || 'approved')
    if (status === 'rejected') continue
    paid += Number(p.amount) || 0
  }
  return Math.max(0, price - paid)
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const cronSecret = Deno.env.get('CRON_SECRET') || ''
    const provided = req.headers.get('x-cron-secret') || ''
    if (!cronSecret || provided !== cronSecret) {
      return json({ success: false, error: 'unauthorized' }, 401)
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !serviceKey) return json({ success: false, error: 'server' }, 500)

    const admin = createClient(supabaseUrl, serviceKey)
    const nowIso = new Date().toISOString()
    let schedulesProcessed = 0
    let campaignsProcessed = 0

    const { data: dueSchedules } = await admin
      .from('sms_schedules')
      .select('*')
      .eq('status', 'pending')
      .lte('send_at', nowIso)
      .order('send_at', { ascending: true })
      .limit(100)

    for (const sch of dueSchedules || []) {
      const tenantId = sch.tenant_id
      let phone = ''
      let customerName = ''
      let advisor = ''
      let advisorPhone = ''
      let followupDate = ''
      let products: unknown[] = []
      if (sch.customer_id) {
        const { data: cust } = await admin
          .from('customers')
          .select('id, name, phone, phones, advisor, advisor_phone, next_followup_date, products')
          .eq('tenant_id', tenantId)
          .eq('id', sch.customer_id)
          .maybeSingle()
        if (cust) {
          phone = normalizePhone(cust.phone)
          if (!phone && Array.isArray(cust.phones) && cust.phones[0]) {
            phone = normalizePhone(cust.phones[0])
          }
          customerName = String(cust.name || '')
          advisor = String(cust.advisor || '')
          advisorPhone = String(cust.advisor_phone || '')
          followupDate = String(cust.next_followup_date || '')
          products = Array.isArray(cust.products) ? cust.products : []
        }
      }
      const meta = sch.meta && typeof sch.meta === 'object' ? sch.meta as Record<string, unknown> : {}
      const kind = String(sch.kind || 'followup_schedule')

      // Settlement-due: refresh balance; skip if already paid / completed / gift / already sent today
      let settlementVars: Record<string, string> = {}
      if (kind === 'sale_settlement_due') {
        const productIndex = Number(meta.productIndex)
        const product = Number.isFinite(productIndex) ? products[productIndex] as Record<string, unknown> | undefined : undefined
        const status = String(product?.status || '')
        const balance = operationalBalance(product)
        const settlementDate = String(product?.settlementDate || meta.settlementDate || '')
        if (!product || status === 'تکمیل' || status === 'هدیه' || balance <= 0 || !settlementDate) {
          await admin.from('sms_schedules').update({
            status: 'cancelled',
            updated_at: nowIso,
            meta: { ...meta, skip_reason: 'no_balance_or_settled' },
          }).eq('id', sch.id)
          schedulesProcessed += 1
          continue
        }

        // At most one settlement SMS per customer+product per Tehran day
        if (sch.customer_id && Number.isFinite(productIndex)) {
          const day = todayJalaliInTehran()
          // Convert Jalali day bounds via Gregorian of schedule send day is hard; use ISO day in Tehran
          const dayIso = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Tehran',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          }).format(new Date())
          const dayStart = new Date(`${dayIso}T00:00:00+03:30`).toISOString()
          const dayEnd = new Date(`${dayIso}T23:59:59.999+03:30`).toISOString()
          const { data: already } = await admin
            .from('sms_logs')
            .select('id, meta')
            .eq('tenant_id', tenantId)
            .eq('kind', 'sale_settlement_due')
            .eq('status', 'sent')
            .eq('customer_id', sch.customer_id)
            .gte('created_at', dayStart)
            .lte('created_at', dayEnd)
            .limit(50)
          const dup = (already || []).some((row) => {
            const m = row.meta && typeof row.meta === 'object' ? row.meta as Record<string, unknown> : {}
            return Number(m.productIndex) === productIndex
          })
          if (dup) {
            await admin.from('sms_schedules').update({
              status: 'cancelled',
              updated_at: nowIso,
              meta: { ...meta, skip_reason: 'already_sent_today', day },
            }).eq('id', sch.id)
            schedulesProcessed += 1
            continue
          }
        }

        settlementVars = {
          product_name: String(product.name || meta.product_name || ''),
          balance: formatBalanceFa(balance),
          total_balance: formatBalanceFa(balance),
          ...buildSettlementDayVars(settlementDate),
        }
      }

      const invokeBody = {
        tenant_id: tenantId,
        mode: 'single',
        kind,
        auto: true,
        template_key: sch.template_key || (
          kind === 'sale_settlement_due'
            ? 'sale_settlement_due'
            : (kind === 'followup_bulk' ? 'followup_bulk' : 'followup_due')
        ),
        body_override: sch.body_override || null,
        recipients: [{
          phone,
          customer_id: sch.customer_id,
          vars: {
            followup_date: followupDate || String(meta.followup_date || ''),
            org_name: String(meta.org_name || 'آکادمی کارنو'),
            ...((meta.vars && typeof meta.vars === 'object') ? meta.vars as Record<string, string> : {}),
            ...settlementVars,
            customer_name: customerName || String((meta.vars as Record<string, string> | undefined)?.customer_name || ''),
            advisor,
            advisor_phone: advisorPhone,
          },
          meta: { schedule_id: sch.id, ...meta },
        }],
      }

      const fnUrl = `${supabaseUrl}/functions/v1/send-sms`
      const res = await fetch(fnUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-cron-secret': cronSecret,
          Authorization: `Bearer ${serviceKey}`,
        },
        body: JSON.stringify(invokeBody),
      })
      const result = await res.json().catch(() => ({}))
      const ok = result?.sent > 0
      await admin.from('sms_schedules').update({
        status: ok ? 'sent' : 'failed',
        updated_at: nowIso,
        meta: { ...meta, last_result: result },
      }).eq('id', sch.id)
      schedulesProcessed += 1
    }

    // Drip / scheduled campaigns due for a batch
    const { data: campaigns } = await admin
      .from('sms_campaigns')
      .select('*')
      .eq('status', 'sending')
      .limit(20)

    for (const camp of campaigns || []) {
      const mode = camp.mode
      const ready =
        (mode === 'scheduled' && camp.send_at && camp.send_at <= nowIso && camp.sent === 0) ||
        (mode === 'drip' && (!camp.next_batch_at || camp.next_batch_at <= nowIso)) ||
        (mode === 'immediate')
      if (!ready) continue

      const recipients = Array.isArray(camp.filter?.recipients) ? camp.filter.recipients : []
      const offset = Number(camp.sent || 0) + Number(camp.failed || 0)
      const batchSize = mode === 'drip'
        ? Math.max(1, Number(camp.drip_batch_size || 20))
        : 50
      const slice = recipients.slice(offset, offset + batchSize)
      if (!slice.length) {
        await admin.from('sms_campaigns').update({
          status: 'done',
          updated_at: nowIso,
        }).eq('id', camp.id)
        continue
      }

      const invokeBody = {
        tenant_id: camp.tenant_id,
        mode: 'bulk',
        kind: 'customer_campaign',
        auto: true,
        template_key: camp.template_key || 'customer_campaign',
        body_override: camp.body || null,
        recipients: slice,
      }
      const fnUrl = `${supabaseUrl}/functions/v1/send-sms`
      const res = await fetch(fnUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-cron-secret': cronSecret,
          Authorization: `Bearer ${serviceKey}`,
        },
        body: JSON.stringify(invokeBody),
      })
      const result = await res.json().catch(() => ({}))
      const sentAdd = Number(result?.sent || 0)
      const failAdd = Number(result?.failed || 0) + Number(result?.skipped || 0)
      const newSent = Number(camp.sent || 0) + sentAdd
      const newFailed = Number(camp.failed || 0) + failAdd
      const processed = newSent + newFailed
      const done = processed >= Number(camp.total || recipients.length)
      const intervalMin = Math.max(1, Number(camp.drip_interval_min || 5))
      const nextBatch = mode === 'drip' && !done
        ? new Date(Date.now() + intervalMin * 60_000).toISOString()
        : null

      await admin.from('sms_campaigns').update({
        sent: newSent,
        failed: newFailed,
        status: done ? 'done' : 'sending',
        next_batch_at: nextBatch,
        updated_at: nowIso,
      }).eq('id', camp.id)
      campaignsProcessed += 1
    }

    return json({
      success: true,
      schedulesProcessed,
      campaignsProcessed,
    })
  } catch (error) {
    console.error('sms-schedule-cron error:', error)
    return json({ success: false, error: 'unexpected' }, 500)
  }
})
