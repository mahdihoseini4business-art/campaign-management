/**
 * Client-side ops digests: ensure today's morning/evening summary exists in the
 * notifications inbox even when the external ops-digest-cron has not run.
 */
import { supabase } from './supabase.js'
import { getData } from './data.js'
import { getCurrentUser, normalizePhone, normalizeViewUserPhones } from './utils.js'
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
  morningHasWork
} from '../supabase/functions/_shared/digest-metrics.js'

let _ensureInFlight = null
let _ensureDoneKey = ''

function tehranHour(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tehran',
    hour: 'numeric',
    hour12: false
  }).formatToParts(now)
  const hour = Number(parts.find(p => p.type === 'hour')?.value)
  return Number.isFinite(hour) ? hour % 24 : 0
}

function expiresAtIso(hours = 36) {
  return new Date(Date.now() + hours * 3600 * 1000).toISOString()
}

function mapCustomersForMetrics(customers) {
  return (customers || []).map(c => ({
    advisor_phone: c.advisorPhone || c.advisor_phone || '',
    next_followup_date: c.nextFollowupDate || c.next_followup_date || ''
  }))
}

function mapFollowupsForMetrics(followups) {
  return (followups || []).map(f => ({
    assigned_to_phone: f.assignedToPhone || f.assigned_to_phone || '',
    next_date: f.nextDate || f.next_date || '',
    status: f.status || 'pending',
    type: f.type || ''
  }))
}

async function alreadyHasDigest({ phone, kind, digestDate }) {
  const { data, error } = await supabase
    .from('notifications')
    .select('id, recipient_phones, kind, meta, title, created_by_phone')
    .order('created_at', { ascending: false })
    .limit(80)

  if (error) {
    // Migration 040 missing: fall back to title + system sender match
    if (/kind|meta/i.test(error.message || '')) {
      const { data: legacy, error: legErr } = await supabase
        .from('notifications')
        .select('id, recipient_phones, title, created_by_phone')
        .order('created_at', { ascending: false })
        .limit(80)
      if (legErr) throw legErr
      const titlePrefix = kind === DIGEST_KIND_MORNING
        ? `خلاصه صبح — ${digestDate}`
        : `خلاصه عصر تیم — ${digestDate}`
      return (legacy || []).some(n => {
        if (String(n.created_by_phone || '') !== SYSTEM_DIGEST_PHONE) return false
        if (String(n.title || '') !== titlePrefix) return false
        const raw = n.recipient_phones
        if (!Array.isArray(raw)) return false
        return raw.map(p => normalizePhone(p)).includes(phone)
      })
    }
    throw error
  }

  return (data || []).some(n => {
    if (n.kind && n.kind !== kind) return false
    if (!n.kind && String(n.created_by_phone || '') !== SYSTEM_DIGEST_PHONE) return false
    const metaDate = n.meta && typeof n.meta === 'object' ? n.meta.digest_date : null
    if (metaDate && metaDate !== digestDate) return false
    if (!metaDate) {
      const titlePrefix = kind === DIGEST_KIND_MORNING
        ? `خلاصه صبح — ${digestDate}`
        : `خلاصه عصر تیم — ${digestDate}`
      if (String(n.title || '') !== titlePrefix) return false
    }
    const raw = n.recipient_phones
    if (!Array.isArray(raw)) return false
    return raw.map(p => normalizePhone(p)).includes(phone)
  })
}

async function insertDigestRow(row) {
  let { error } = await supabase.from('notifications').insert(row)
  if (error && /kind|meta/i.test(error.message || '')) {
    const { kind: _k, meta: _m, ...legacy } = row
    ;({ error } = await supabase.from('notifications').insert(legacy))
  }
  if (error) throw error
}

/**
 * Ensure today's digests exist for the signed-in user.
 * Morning: first open of the day when advisor has overdue/today/assigned work.
 * Evening: after 16:00 Tehran for group managers with team work.
 * @param {{ force?: boolean }} [opts]
 */
export async function ensureOpsDigestsForCurrentUser(opts = {}) {
  const user = getCurrentUser()
  const phone = normalizePhone(user?.phone)
  if (!phone) return { skipped: true, reason: 'no_phone' }

  const digestDate = getTodayJalaliStr()
  const dedupeKey = `${phone}|${digestDate}|${tehranHour() >= 16 ? 'e' : 'm'}`
  if (!opts.force && _ensureDoneKey === dedupeKey) return { skipped: true, reason: 'already_ran' }
  if (_ensureInFlight) {
    if (!opts.force) return _ensureInFlight
    await _ensureInFlight.catch(() => {})
  }

  _ensureInFlight = (async () => {
    const data = getData()
    const customers = mapCustomersForMetrics(data.customers)
    const followups = mapFollowupsForMetrics(data.followups)
    const expiresAt = expiresAtIso(36)
    let created = 0

    // Morning advisor digest (any time of day if missing)
    const morningCounts = countAdvisorMorningMetrics({
      phone,
      customers,
      followups,
      todayStr: digestDate
    })
    if (morningHasWork(morningCounts)) {
      const has = await alreadyHasDigest({ phone, kind: DIGEST_KIND_MORNING, digestDate })
      if (!has) {
        await insertDigestRow({
          title: formatMorningTitle(digestDate),
          message: formatMorningMessage(morningCounts),
          recipient_phones: [phone],
          created_by_phone: SYSTEM_DIGEST_PHONE,
          created_by_name: SYSTEM_DIGEST_NAME,
          expires_at: expiresAt,
          kind: DIGEST_KIND_MORNING,
          meta: { digest_date: digestDate, source: 'client' }
        })
        created++
      }
    }

    // Evening manager digest (Tehran hour >= 16)
    if (tehranHour() >= 16 && user?.isGroupManager) {
      const teamPhones = normalizeViewUserPhones(
        user.viewUserPhones ?? user.permissions?.viewUserPhones
      ).filter(p => p && p !== phone)
      const eveningCounts = countManagerEveningMetrics({
        teamPhones,
        customers,
        followups,
        todayStr: digestDate
      })
      if (eveningHasWork(eveningCounts)) {
        const has = await alreadyHasDigest({ phone, kind: DIGEST_KIND_EVENING, digestDate })
        if (!has) {
          await insertDigestRow({
            title: formatEveningTitle(digestDate),
            message: formatEveningMessage(eveningCounts),
            recipient_phones: [phone],
            created_by_phone: SYSTEM_DIGEST_PHONE,
            created_by_name: SYSTEM_DIGEST_NAME,
            expires_at: expiresAt,
            kind: DIGEST_KIND_EVENING,
            meta: { digest_date: digestDate, source: 'client' }
          })
          created++
        }
      }
    }

    _ensureDoneKey = dedupeKey
    return { created, date: digestDate }
  })()

  try {
    return await _ensureInFlight
  } finally {
    _ensureInFlight = null
  }
}
