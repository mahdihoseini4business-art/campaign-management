/**
 * Ops digest cron: morning advisor + evening group-manager summaries → notifications inbox.
 * Auth: header x-cron-secret == CRON_SECRET (same pattern as subscription-cron).
 * Invoke: POST ?kind=morning|evening  (or JSON body { "kind": "morning" })
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.8'
import {
  DIGEST_KIND_EVENING,
  DIGEST_KIND_MORNING,
  SYSTEM_DIGEST_NAME,
  SYSTEM_DIGEST_PHONE,
  countAdvisorMorningMetrics,
  countManagerEveningMetrics,
  eveningHasWork,
  formatEveningMessage,
  formatEveningTitle,
  formatMorningMessage,
  formatMorningTitle,
  getTodayJalaliStr,
  morningHasWork,
  normalizePhone
} from '../_shared/digest-metrics.js'

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

async function parseKind(req: Request): Promise<'morning' | 'evening' | null> {
  const url = new URL(req.url)
  let raw = (url.searchParams.get('kind') || '').trim().toLowerCase()
  if (!raw && (req.method === 'POST' || req.method === 'PUT')) {
    try {
      const body = await req.json()
      raw = String(body?.kind || '').trim().toLowerCase()
    } catch {
      /* no body */
    }
  }
  if (raw === 'morning' || raw === 'evening') return raw
  return null
}

function expiresAtIso(hours = 36) {
  return new Date(Date.now() + hours * 3600 * 1000).toISOString()
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

    const kindParam = await parseKind(req)
    if (!kindParam) {
      return json({ success: false, error: 'kind must be morning or evening' }, 400)
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !serviceKey) return json({ success: false, error: 'server' }, 500)

    const admin = createClient(supabaseUrl, serviceKey)
    const digestDate = getTodayJalaliStr()
    const notifKind = kindParam === 'morning' ? DIGEST_KIND_MORNING : DIGEST_KIND_EVENING
    const expiresAt = expiresAtIso(36)

    let sent = 0
    let skippedEmpty = 0
    let skippedDup = 0
    let tenantsProcessed = 0
    let tenantsSkipped = 0

    const { data: tenants, error: tenantsErr } = await admin
      .from('tenants')
      .select('id, status, archived_at')
      .is('archived_at', null)
      .eq('status', 'active')

    if (tenantsErr) return json({ success: false, error: tenantsErr.message }, 500)

    for (const tenant of tenants || []) {
      const tenantId = tenant.id

      const { data: sub, error: subErr } = await admin
        .from('subscriptions')
        .select('status')
        .eq('tenant_id', tenantId)
        .maybeSingle()

      if (subErr) {
        console.error('ops-digest-cron subscription', tenantId, subErr)
        tenantsSkipped++
        continue
      }

      const subStatus = sub?.status || ''
      if (!['trialing', 'active', 'grace'].includes(subStatus)) {
        tenantsSkipped++
        continue
      }

      tenantsProcessed++

      const { data: members, error: memErr } = await admin
        .from('tenant_members')
        .select('username')
        .eq('tenant_id', tenantId)

      if (memErr) {
        console.error('ops-digest-cron members', tenantId, memErr)
        continue
      }

      const usernames = (members || []).map((m) => m.username).filter(Boolean)
      if (!usernames.length) continue

      const { data: users, error: usersErr } = await admin
        .from('users')
        .select('username, phone')
        .in('username', usernames)

      if (usersErr) {
        console.error('ops-digest-cron users', tenantId, usersErr)
        continue
      }

      const memberPhones = [...new Set(
        (users || []).map((u) => normalizePhone(u.phone)).filter(Boolean)
      )]
      if (!memberPhones.length) continue

      const { data: customers, error: custErr } = await admin
        .from('customers')
        .select('id, advisor_phone, next_followup_date')
        .eq('tenant_id', tenantId)

      if (custErr) {
        console.error('ops-digest-cron customers', tenantId, custErr)
        continue
      }

      const { data: followups, error: fuErr } = await admin
        .from('followups')
        .select('id, customer_id, type, status, next_date, assigned_to_phone')
        .eq('tenant_id', tenantId)

      if (fuErr) {
        console.error('ops-digest-cron followups', tenantId, fuErr)
        continue
      }

      const { data: existingDigests, error: digErr } = await admin
        .from('notifications')
        .select('id, recipient_phones, meta')
        .eq('tenant_id', tenantId)
        .eq('kind', notifKind)
        .eq('meta->>digest_date', digestDate)

      if (digErr) {
        console.error('ops-digest-cron existing digests', tenantId, digErr)
        continue
      }

      const alreadySent = new Set<string>()
      for (const row of existingDigests || []) {
        const raw = row.recipient_phones
        if (!Array.isArray(raw)) continue
        for (const p of raw) {
          const n = normalizePhone(p)
          if (n) alreadySent.add(n)
        }
      }

      if (kindParam === 'morning') {
        for (const phone of memberPhones) {
          if (alreadySent.has(phone)) {
            skippedDup++
            continue
          }
          const counts = countAdvisorMorningMetrics({
            phone,
            customers: customers || [],
            followups: followups || [],
            todayStr: digestDate,
          })
          if (!morningHasWork(counts)) {
            skippedEmpty++
            continue
          }
          const message = formatMorningMessage(counts)
          const { error: insErr } = await admin.from('notifications').insert({
            tenant_id: tenantId,
            title: formatMorningTitle(digestDate),
            message,
            recipient_phones: [phone],
            created_by_phone: SYSTEM_DIGEST_PHONE,
            created_by_name: SYSTEM_DIGEST_NAME,
            expires_at: expiresAt,
            kind: DIGEST_KIND_MORNING,
            meta: { digest_date: digestDate },
          })
          if (insErr) {
            console.error('ops-digest-cron insert morning', tenantId, phone, insErr)
            continue
          }
          sent++
          alreadySent.add(phone)
        }
      } else {
        const { data: groups, error: groupsErr } = await admin
          .from('groups')
          .select('id')
          .eq('tenant_id', tenantId)

        if (groupsErr) {
          console.error('ops-digest-cron groups', tenantId, groupsErr)
          continue
        }

        const groupIds = (groups || []).map((g) => g.id).filter(Boolean)
        if (!groupIds.length) continue

        const { data: groupMembers, error: gmErr } = await admin
          .from('group_members')
          .select('group_id, user_phone, is_manager')
          .in('group_id', groupIds)

        if (gmErr) {
          console.error('ops-digest-cron group_members', tenantId, gmErr)
          continue
        }

        /** managerPhone → set of subordinate phones across all groups they manage */
        const managerTeams = new Map<string, Set<string>>()
        const byGroup = new Map<string, { managers: string[], members: string[] }>()
        for (const row of groupMembers || []) {
          const gid = row.group_id
          if (!gid) continue
          if (!byGroup.has(gid)) byGroup.set(gid, { managers: [], members: [] })
          const phone = normalizePhone(row.user_phone)
          if (!phone) continue
          const bucket = byGroup.get(gid)!
          if (row.is_manager) bucket.managers.push(phone)
          else bucket.members.push(phone)
        }
        for (const [, bucket] of byGroup) {
          const teamPhones = [...new Set(bucket.members)]
          for (const managerPhone of [...new Set(bucket.managers)]) {
            if (!managerTeams.has(managerPhone)) managerTeams.set(managerPhone, new Set())
            const set = managerTeams.get(managerPhone)!
            for (const p of teamPhones) set.add(p)
          }
        }

        for (const [managerPhone, teamSet] of managerTeams) {
          if (!memberPhones.includes(managerPhone)) continue
          if (alreadySent.has(managerPhone)) {
            skippedDup++
            continue
          }
          const teamPhones = [...teamSet]
          if (!teamPhones.length) {
            skippedEmpty++
            continue
          }
          const counts = countManagerEveningMetrics({
            teamPhones,
            customers: customers || [],
            followups: followups || [],
            todayStr: digestDate,
          })
          if (!eveningHasWork(counts)) {
            skippedEmpty++
            continue
          }
          const { error: insErr } = await admin.from('notifications').insert({
            tenant_id: tenantId,
            title: formatEveningTitle(digestDate),
            message: formatEveningMessage(counts),
            recipient_phones: [managerPhone],
            created_by_phone: SYSTEM_DIGEST_PHONE,
            created_by_name: SYSTEM_DIGEST_NAME,
            expires_at: expiresAt,
            kind: DIGEST_KIND_EVENING,
            meta: { digest_date: digestDate },
          })
          if (insErr) {
            console.error('ops-digest-cron insert evening', tenantId, managerPhone, insErr)
            continue
          }
          sent++
          alreadySent.add(managerPhone)
        }
      }
    }

    return json({
      success: true,
      kind: kindParam,
      date: digestDate,
      sent,
      skipped_empty: skippedEmpty,
      skipped_dup: skippedDup,
      tenants_processed: tenantsProcessed,
      tenants_skipped: tenantsSkipped,
      at: new Date().toISOString(),
    })
  } catch (error) {
    console.error('ops-digest-cron', error)
    return json({ success: false, error: 'unexpected' }, 500)
  }
})
