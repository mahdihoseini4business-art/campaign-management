/**
 * Client-side ops digests: ensure today's morning/evening summary exists in the
 * notifications inbox even when the external ops-digest-cron has not run.
 */
import { supabase } from './supabase.js'
import { getData, getSalesTargets, getOpsDigestEnabled, saveOpsDigestEnabled, setOpsDigestEnabledLocal } from './data.js'
import { getCurrentUser, normalizePhone, normalizeViewUserPhones, userDisplayName, requireSettingsSection, showToast } from './utils.js'
import { getMembersCache } from './groups.js'
import { broadcastAppSetting } from './sale-toasts.js'
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
    id: c.id || '',
    name: c.name || '',
    advisor_phone: c.advisorPhone || c.advisor_phone || '',
    advisor: c.advisor || '',
    next_followup_date: c.nextFollowupDate || c.next_followup_date || '',
    platform: c.platform || '',
    platformId: c.platformId || c.platform_id || '',
    products: Array.isArray(c.products) ? c.products : [],
    created_at: c.createdAt || c.created_at || null,
    createdAt: c.createdAt || c.created_at || null
  }))
}

function mapFollowupsForMetrics(followups) {
  return (followups || []).map(f => ({
    assigned_to_phone: f.assignedToPhone || f.assigned_to_phone || '',
    next_date: f.nextDate || f.next_date || '',
    status: f.status || 'pending',
    type: f.type || '',
    date: f.date || '',
    done_at: f.doneAt || f.done_at || '',
    doneAt: f.doneAt || f.done_at || '',
    done_by_phone: f.doneByPhone || f.done_by_phone || '',
    doneByPhone: f.doneByPhone || f.done_by_phone || '',
    created_by_phone: f.createdByPhone || f.created_by_phone || '',
    createdByPhone: f.createdByPhone || f.created_by_phone || ''
  }))
}

function mapRefundsForMetrics(refunds) {
  return (refunds || []).map(r => ({
    status: r.status || '',
    advisor_phone: r.advisorPhone || r.advisor_phone || '',
    advisorPhone: r.advisorPhone || r.advisor_phone || ''
  }))
}

function buildClientPhoneNames(data, teamPhones = []) {
  const map = {}
  // Prefer advisor name hints from customers
  for (const c of data.customers || []) {
    const phone = normalizePhone(c.advisorPhone || c.advisor_phone)
    const name = String(c.advisor || '').trim()
    if (phone && name && !map[phone]) map[phone] = name
  }
  const me = getCurrentUser()
  if (me) {
    const myPhone = normalizePhone(me.phone)
    const myName = userDisplayName(me)
    if (myPhone && myName) map[myPhone] = myName
  }
  // Fill gaps from group member phones (no display names in cache — keep hints)
  for (const p of teamPhones) {
    const phone = normalizePhone(p)
    if (phone && !map[phone]) map[phone] = phone.slice(0, 4) + '…' + phone.slice(-4)
  }
  return map
}

function managerGroupIds(user) {
  const ids = new Set()
  if (user?.groupId) ids.add(user.groupId)
  const myPhone = normalizePhone(user?.phone)
  if (!myPhone) return [...ids]
  for (const m of getMembersCache() || []) {
    if (!m.is_manager) continue
    if (normalizePhone(m.user_phone) !== myPhone) continue
    if (m.group_id) ids.add(m.group_id)
  }
  return [...ids]
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

export function syncOpsDigestToggleUi() {
  const el = document.getElementById('opsDigestEnabled')
  if (el) el.checked = getOpsDigestEnabled()
}

export async function toggleOpsDigestSetting(enabled) {
  if (!requireSettingsSection('notif-prefs')) {
    syncOpsDigestToggleUi()
    return
  }
  const next = !!enabled
  try {
    await saveOpsDigestEnabled(next)
    syncOpsDigestToggleUi()
    await broadcastAppSetting('ops_digest_enabled', next)
    showToast(next ? 'گزارش روزانه فعال شد' : 'گزارش روزانه غیرفعال شد')
  } catch (e) {
    console.error('toggleOpsDigestSetting error:', e)
    syncOpsDigestToggleUi()
    showToast('خطا در ذخیره تنظیم گزارش روزانه')
  }
}

/**
 * Ensure today's digests exist for the signed-in user.
 * Morning: first open of the day when advisor has actionable metrics.
 * Evening: after 16:00 Tehran for group managers (always when team exists).
 * @param {{ force?: boolean }} [opts]
 */
export async function ensureOpsDigestsForCurrentUser(opts = {}) {
  if (!getOpsDigestEnabled()) return { skipped: true, reason: 'disabled' }

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
    const refunds = mapRefundsForMetrics(data.refunds)
    const salesTargets = typeof getSalesTargets === 'function' ? getSalesTargets() : (data.salesTargets || [])
    const expiresAt = expiresAtIso(36)
    let created = 0

    const phoneNames = buildClientPhoneNames(data)

    // Morning advisor digest (any time of day if missing)
    const morningCounts = countAdvisorMorningMetrics({
      phone,
      customers,
      followups,
      todayStr: digestDate,
      salesTargets,
      refunds,
      phoneNames
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

    // Evening manager digest (Tehran hour >= 16) — always send when team exists
    if (tehranHour() >= 16 && user?.isGroupManager) {
      const teamPhones = normalizeViewUserPhones(
        user.viewUserPhones ?? user.permissions?.viewUserPhones
      ).filter(p => p && p !== phone)
      if (teamPhones.length) {
        const eveningNames = buildClientPhoneNames(data, teamPhones)
        const eveningCounts = countManagerEveningMetrics({
          teamPhones,
          customers,
          followups,
          todayStr: digestDate,
          salesTargets,
          refunds,
          phoneNames: eveningNames,
          groupIds: managerGroupIds(user)
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
