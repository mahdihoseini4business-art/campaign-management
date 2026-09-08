// Subscription lifecycle cron: trial end → readonly, paid end → grace → readonly
// Secure with header X-Cron-Secret == CRON_SECRET

import { serve } from "https://deno.land/std@0.177.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"

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

    let graceDays = 3
    const { data: graceRow } = await admin
      .from('platform_settings')
      .select('value')
      .eq('key', 'grace_days')
      .maybeSingle()
    if (graceRow?.value != null) graceDays = Number(graceRow.value) || 3

    const { data: subs, error } = await admin
      .from('subscriptions')
      .select('id, tenant_id, plan_id, status, trial_ends_at, ends_at')
      .in('status', ['trialing', 'active', 'grace'])

    if (error) return json({ success: false, error: error.message }, 500)

    let trialToReadonly = 0
    let activeToGrace = 0
    let graceToReadonly = 0
    const now = Date.now()

    for (const sub of subs || []) {
      if (sub.status === 'trialing' && sub.trial_ends_at && new Date(sub.trial_ends_at).getTime() < now) {
        await admin.from('subscriptions').update({
          status: 'readonly',
          updated_at: nowIso,
        }).eq('id', sub.id)
        trialToReadonly++
        continue
      }

      if (sub.status === 'active' && sub.ends_at && new Date(sub.ends_at).getTime() < now) {
        await admin.from('subscriptions').update({
          status: 'grace',
          updated_at: nowIso,
        }).eq('id', sub.id)
        activeToGrace++
        continue
      }

      if (sub.status === 'grace' && sub.ends_at) {
        const graceEnd = new Date(sub.ends_at).getTime() + graceDays * 86400000
        if (graceEnd < now) {
          await admin.from('subscriptions').update({
            status: 'readonly',
            updated_at: nowIso,
          }).eq('id', sub.id)
          graceToReadonly++
        }
      }
    }

    return json({
      success: true,
      at: nowIso,
      grace_days: graceDays,
      trial_to_readonly: trialToReadonly,
      active_to_grace: activeToGrace,
      grace_to_readonly: graceToReadonly,
    })
  } catch (error) {
    console.error('subscription-cron', error)
    return json({ success: false, error: 'unexpected' }, 500)
  }
})
