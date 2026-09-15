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
      let followupDate = ''
      if (sch.customer_id) {
        const { data: cust } = await admin
          .from('customers')
          .select('id, name, phone, phones, advisor, next_followup_date')
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
          followupDate = String(cust.next_followup_date || '')
        }
      }
      const meta = sch.meta && typeof sch.meta === 'object' ? sch.meta : {}
      const kind = String(sch.kind || 'followup_schedule')
      const invokeBody = {
        tenant_id: tenantId,
        mode: 'single',
        kind,
        auto: true,
        template_key: sch.template_key || (kind === 'followup_bulk' ? 'followup_bulk' : 'followup_due'),
        body_override: sch.body_override || null,
        recipients: [{
          phone,
          customer_id: sch.customer_id,
          vars: {
            customer_name: customerName,
            advisor,
            followup_date: followupDate || String(meta.followup_date || ''),
            org_name: String(meta.org_name || 'آکادمی کارنو'),
            ...(meta.vars || {}),
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
