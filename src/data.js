// ============================================
// Data Layer (Supabase)
// ============================================

import { supabase } from './supabase.js'

function toEnDigitsLocal(str) {
  return String(str || '').replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
}

function normalizePhoneLocal(phone) {
  let p = toEnDigitsLocal(String(phone || '').replace(/[\s\-()]/g, ''))
  if (p.startsWith('+98')) p = '0' + p.slice(3)
  else if (p.startsWith('98') && p.length >= 12) p = '0' + p.slice(2)
  else if (p.length === 10 && p.startsWith('9')) p = '0' + p
  return p
}

/** Local normalizer to avoid circular import with utils.js */
function normalizeCustomerPhonesLocal(source) {
  let raw = []
  if (Array.isArray(source)) raw = source
  else if (source && typeof source === 'object') {
    if (Array.isArray(source.phones) && source.phones.length) raw = source.phones
    else if (source.phone) raw = [source.phone]
  }
  const seen = new Set()
  const out = []
  for (const item of raw) {
    const n = normalizePhoneLocal(item)
    if (!n || !/^09\d{9}$/.test(n) || seen.has(n)) continue
    seen.add(n)
    out.push(n)
    if (out.length >= 3) break
  }
  return out
}

let data = { customers: [], followups: [], ownershipTransfers: [], convertedCount: 0, destinationBanks: [], platforms: [], statuses: [] }

const DEFAULT_PLATFORMS = [
  { key: 'instagram', label: 'اینستاگرام', color: '#E1306C', linkTemplate: 'https://instagram.com/{id}' },
  { key: 'telegram', label: 'تلگرام', color: '#0088cc', linkTemplate: 'https://telegram.me/{id}' },
  { key: 'whatsapp', label: 'واتساپ', color: '#25D366', linkTemplate: 'https://wa.me/{phone}' },
  { key: 'website', label: 'سایت', color: '#2563EB', linkTemplate: 'https://{id}' },
  { key: 'bale', label: 'بله', color: '#00A884', linkTemplate: 'https://ble.ir/{id}' },
  { key: 'eitaa', label: 'ایتا', color: '#F59E0B', linkTemplate: 'https://eitaa.com/{id}' },
  { key: 'goftino', label: 'گفتینو', color: '#6366F1', linkTemplate: '' },
  { key: 'carno_leads', label: 'کارنو لیدز', color: '#0155d2', linkTemplate: '' },
  { key: 'rubika', label: 'روبیکا', color: '#A855F7', linkTemplate: '' },
  { key: 'referral', label: 'ارجاعی', color: '#78716C', linkTemplate: '' },
]

const DEFAULT_STATUSES = [
  { key: 'new', label: 'جدید', bgColor: '#e9ecef', textColor: '#495057', order: 0 },
  { key: 'contacted', label: 'تماس گرفته', bgColor: '#cce5ff', textColor: '#084298', order: 1 },
  { key: 'chatting', label: 'در حال چت', bgColor: '#d0bfff', textColor: '#581c87', order: 2 },
  { key: 'interested', label: 'علاقه‌مند', bgColor: '#fff3cd', textColor: '#664d03', order: 3 },
  { key: 'sent', label: 'اطلاعات ارسال', bgColor: '#d1e7dd', textColor: '#0f5132', order: 4 },
  { key: 'followup_done', label: 'تکمیل پیگیری', bgColor: '#b6effb', textColor: '#055160', order: 5 },
  { key: 'converting', label: 'در حال تبدیل', bgColor: '#f8d7da', textColor: '#842029', order: 6 },
  { key: 'purchased', label: 'خرید کرد', bgColor: '#d1e7dd', textColor: '#0f5132', order: 7 },
  { key: 'cancelled', label: 'منصرف شده', bgColor: '#e9ecef', textColor: '#495057', order: 8 },
]

// ============================================
// Load all data from Supabase
// ============================================

export async function loadData() {
  const [customersRes, followupsRes, settingsRes, transfersRes] = await Promise.all([
    supabase.from('customers').select('*'),
    supabase.from('followups').select('*'),
    supabase.from('app_settings').select('*'),
    supabase.from('ownership_transfers').select('*').order('created_at', { ascending: true })
  ])

  const errors = []
  if (customersRes.error) errors.push('مشتریان: ' + customersRes.error.message)
  if (followupsRes.error) errors.push('پیگیری‌ها: ' + followupsRes.error.message)
  if (settingsRes.error) errors.push('تنظیمات: ' + settingsRes.error.message)
  // ownership_transfers may be missing before migration 008 — treat as empty
  if (transfersRes.error && !/ownership_transfers|does not exist|relation/i.test(transfersRes.error.message || '')) {
    errors.push('انتقال‌ها: ' + transfersRes.error.message)
  }

  if (errors.length > 0) {
    throw new Error('خطا در بارگذاری داده‌ها:\n' + errors.join('\n'))
  }

  // Map DB rows to app format
  data.customers = (customersRes.data || []).map(c => {
    const phones = normalizeCustomerPhonesLocal({
      phones: c.phones,
      phone: c.phone || ''
    })
    return {
      id: c.id,
      platformId: c.platform_id || '',
      platform: c.platform || 'instagram',
      name: c.name || '',
      phones,
      phone: phones[0] || '',
      status: c.status || 'new',
      notes: c.notes || '',
      advisor: c.advisor || '',
      advisorPhone: c.advisor_phone || '',
      nextFollowupDate: c.next_followup_date || '',
      products: c.products || [],
      createdAt: c.created_at || null,
      customerLevel: c.customer_level || '',
      customerLevelLocked: !!c.customer_level_locked,
      referredByPhone: c.referred_by_phone || ''
    }
  })

  data.followups = (followupsRes.data || []).map(f => ({
    id: f.id,
    customerId: f.customer_id,
    date: f.date || '',
    type: f.type || '',
    result: f.result || '',
    nextDate: f.next_date || '',
    notes: f.notes || '',
    createdByPhone: f.created_by_phone || '',
    status: f.status || 'pending',
    doneAt: f.done_at || '',
    doneByPhone: f.done_by_phone || '',
    doneNote: f.done_note || '',
    wasOverdue: !!f.was_overdue
  }))

  data.ownershipTransfers = (transfersRes.error || !transfersRes.data)
    ? []
    : transfersRes.data.map(mapOwnershipTransferRow)

  // Load settings (convertedCount, destination banks, …)
  const settings = {}
  ;(settingsRes.data || []).forEach(s => { settings[s.key] = s.value })
  data.convertedCount = settings.convertedCount || 0
  data.destinationBanks = normalizeDestinationBanks(settings.destination_banks)
  data.platforms = Array.isArray(settings.platforms) && settings.platforms.length > 0 ? settings.platforms : [...DEFAULT_PLATFORMS]
  data.statuses = Array.isArray(settings.statuses) && settings.statuses.length > 0
    ? [...settings.statuses].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    : [...DEFAULT_STATUSES]

  injectDynamicStyles()

  return data
}

function normalizeDestinationBanks(raw) {
  if (Array.isArray(raw)) {
    return raw.map(b => String(b || '').trim()).filter(Boolean)
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed.map(b => String(b || '').trim()).filter(Boolean)
    } catch (_) {
      return raw.split(/[\n,]/).map(b => b.trim()).filter(Boolean)
    }
  }
  return []
}

// ============================================
// Platforms & Statuses
// ============================================

export function getPlatforms() {
  return Array.isArray(data.platforms) && data.platforms.length > 0 ? data.platforms : DEFAULT_PLATFORMS
}

export async function savePlatforms(platforms) {
  data.platforms = platforms
  await saveSetting('platforms', platforms)
  injectDynamicStyles()
}

export function getStatuses() {
  return Array.isArray(data.statuses) && data.statuses.length > 0 ? data.statuses : DEFAULT_STATUSES
}

export async function saveStatuses(statuses) {
  data.statuses = statuses.map((s, i) => ({ ...s, order: i }))
  await saveSetting('statuses', data.statuses)
  injectDynamicStyles()
}

function injectDynamicStyles() {
  let styleEl = document.getElementById('dynamic-platform-status-styles')
  if (!styleEl) {
    styleEl = document.createElement('style')
    styleEl.id = 'dynamic-platform-status-styles'
    document.head.appendChild(styleEl)
  }
  const platforms = getPlatforms()
  const statuses = getStatuses()
  let css = ''
  for (const p of platforms) {
    css += `.platform-${p.key} { background: ${p.color}; }\n`
  }
  for (const s of statuses) {
    css += `.status-${s.key} { background: ${s.bgColor}; color: ${s.textColor};${s.key === 'cancelled' ? ' text-decoration: line-through;' : ''} }\n`
  }
  styleEl.textContent = css
}

// ============================================
// Destination Banks
// ============================================

export function getDestinationBanks() {
  return Array.isArray(data.destinationBanks) ? [...data.destinationBanks] : []
}

export async function saveDestinationBanks(banks) {
  const cleaned = [...new Set((banks || []).map(b => String(b || '').trim()).filter(Boolean))]
  data.destinationBanks = cleaned
  await saveSetting('destination_banks', cleaned)
  return cleaned
}

// ============================================
// Get in-memory data
// ============================================

export function getData() {
  return data
}

// ============================================
// Save customer to Supabase
// ============================================

export async function saveCustomerToDB(customer) {
  const phones = normalizeCustomerPhonesLocal(customer)
  const row = {
    id: customer.id,
    platform_id: customer.platformId || '',
    platform: customer.platform || 'instagram',
    name: customer.name || '',
    phone: phones[0] || '',
    phones,
    status: customer.status || 'new',
    notes: customer.notes || '',
    advisor: customer.advisor || '',
    advisor_phone: customer.advisorPhone || '',
    next_followup_date: customer.nextFollowupDate || '',
    products: customer.products || [],
    customer_level: customer.customerLevel || '',
    customer_level_locked: !!customer.customerLevelLocked,
    referred_by_phone: customer.referredByPhone || ''
  }

  let { error } = await supabase.from('customers').upsert(row, { onConflict: 'id' })
  // Graceful fallback before migration 007 is applied
  if (error && /phones/i.test(error.message || '')) {
    const { phones: _omit, ...legacy } = row
    ;({ error } = await supabase.from('customers').upsert(legacy, { onConflict: 'id' }))
  }
  if (error) throw new Error('خطا در ذخیره مشتری: ' + error.message)
}

// ============================================
// Delete customer from Supabase
// ============================================

export async function deleteCustomerFromDB(id) {
  // Delete followups first
  const { error: followupError } = await supabase.from('followups').delete().eq('customer_id', id)
  if (followupError) throw new Error('خطا در حذف پیگیری‌ها: ' + followupError.message)
  // Delete customer
  const { error } = await supabase.from('customers').delete().eq('id', id)
  if (error) throw new Error('خطا در حذف مشتری: ' + error.message)
}

function mapOwnershipTransferRow(t) {
  return {
    id: t.id,
    customerId: t.customer_id,
    fromAdvisorPhone: t.from_advisor_phone || '',
    fromAdvisorName: t.from_advisor_name || '',
    toAdvisorPhone: t.to_advisor_phone || '',
    toAdvisorName: t.to_advisor_name || '',
    actedByPhone: t.acted_by_phone || '',
    batchId: t.batch_id || '',
    reason: t.reason || '',
    customerStatusAtTransfer: t.customer_status_at_transfer || '',
    createdAt: t.created_at || null
  }
}

// ============================================
// Ownership transfers
// ============================================

export async function saveOwnershipTransferToDB(transfer) {
  const row = {
    customer_id: transfer.customerId,
    from_advisor_phone: transfer.fromAdvisorPhone || null,
    from_advisor_name: transfer.fromAdvisorName || null,
    to_advisor_phone: transfer.toAdvisorPhone || null,
    to_advisor_name: transfer.toAdvisorName || null,
    acted_by_phone: transfer.actedByPhone || null,
    batch_id: transfer.batchId || null,
    reason: transfer.reason || null,
    customer_status_at_transfer: transfer.customerStatusAtTransfer || null
  }
  const { data: inserted, error } = await supabase
    .from('ownership_transfers')
    .insert(row)
    .select('*')
    .single()
  if (error) throw new Error('خطا در ثبت انتقال: ' + error.message)
  return mapOwnershipTransferRow(inserted)
}

// ============================================
// Save followup to Supabase
// ============================================

// followups don't have a stable primary key in the app,
// so we use customer_id + date + type as a soft key
export async function saveFollowupToDB(followup) {
  const isDoneNote = followup.status === 'done' ||
    followup.type === 'پیگیری انجام‌شده' ||
    followup.type === 'پیگیری معوقه انجام‌شده'
  const isSystemNote = followup.type === 'سیستمی'

  // Done / system notes can repeat same day for same customer — skip soft-duplicate check
  if (!isDoneNote && !isSystemNote) {
    const { data: existing } = await supabase.from('followups')
      .select('id')
      .eq('customer_id', followup.customerId)
      .eq('date', followup.date)
      .eq('type', followup.type)
      .limit(1)

    if (existing && existing.length > 0) {
      throw new Error('پیگیری تکراری وجود دارد')
    }
  }

  const baseRow = {
    customer_id: followup.customerId,
    date: followup.date,
    type: followup.type,
    result: followup.result,
    next_date: followup.nextDate || '',
    notes: followup.notes,
    created_by_phone: followup.createdByPhone || null
  }

  // Prefer writing status/done columns when present; fall back on any schema error
  if (isDoneNote || followup.status || followup.doneAt || followup.wasOverdue) {
    const full = await supabase.from('followups').insert({
      ...baseRow,
      status: followup.status || 'pending',
      done_at: followup.doneAt || null,
      done_by_phone: followup.doneByPhone || null,
      done_note: followup.doneNote || null,
      was_overdue: !!followup.wasOverdue
    }).select('id').single()

    if (!full.error) return full.data ? full.data.id : null

    // Fallback without optional columns
    const fallback = await supabase.from('followups').insert(baseRow).select('id').single()
    if (fallback.error) throw new Error('خطا در درج پیگیری: ' + fallback.error.message)
    return fallback.data ? fallback.data.id : null
  }

  const { data: inserted, error } = await supabase.from('followups').insert(baseRow).select('id').single()
  if (error) throw new Error('خطا در درج پیگیری: ' + error.message)
  return inserted ? inserted.id : null
}

export async function updateFollowupInDB(followup) {
  if (!followup.id) return
  const row = {
    customer_id: followup.customerId,
    date: followup.date,
    type: followup.type,
    result: followup.result,
    next_date: followup.nextDate,
    notes: followup.notes
  }
  if (followup.createdByPhone !== undefined) {
    row.created_by_phone = followup.createdByPhone || null
  }
  const { error } = await supabase.from('followups').update(row).eq('id', followup.id)
  if (error) throw new Error('خطا در ویرایش پیگیری: ' + error.message)
}

// ============================================
// Delete followup from Supabase
// ============================================

export async function markFollowupDoneInDB(id, { doneAt, doneByPhone, doneNote, wasOverdue }) {
  const { error } = await supabase.from('followups').update({
    status: 'done',
    done_at: doneAt,
    done_by_phone: doneByPhone,
    done_note: doneNote,
    was_overdue: !!wasOverdue
  }).eq('id', id)
  if (error) throw new Error('خطا در ثبت انجام پیگیری: ' + error.message)
}

export async function deleteFollowupFromDB(id) {
  const { error } = await supabase.from('followups').delete().eq('id', id)
  if (error) throw new Error('خطا در حذف پیگیری: ' + error.message)
}

// ============================================
// Update followups customer ID (for LD↔CS conversion)
// ============================================

export async function updateFollowupsCustomerId(oldId, newId) {
  // Update customer_id directly instead of delete+re-insert
  const { error } = await supabase.from('followups').update({ customer_id: newId }).eq('customer_id', oldId)
  if (error) throw new Error('خطا در بروزرسانی پیگیری‌ها: ' + error.message)
}

// ============================================
// Save app setting
// ============================================

export async function saveSetting(key, value) {
  const { error } = await supabase.from('app_settings').upsert({ key, value }, { onConflict: 'key' })
  if (error) throw new Error('خطا در ذخیره تنظیمات: ' + error.message)
}

// ============================================
// Generate next ID
// ============================================

// High-water mark so deleted IDs are never reused (DATA-H3)
async function getNextIdNumber(prefix) {
  const counterKey = `id_counter_${prefix}`

  const [{ data: settingsRows }, { data: rows }] = await Promise.all([
    supabase.from('app_settings').select('value').eq('key', counterKey).limit(1),
    supabase.from('customers').select('id').like('id', prefix + '%')
  ])

  const stored = settingsRows?.[0]?.value != null ? parseInt(settingsRows[0].value, 10) : 0
  const existingIds = (rows || [])
    .map(c => parseInt(c.id.slice(2), 10))
    .filter(n => !isNaN(n))
  const maxExisting = existingIds.length > 0 ? Math.max(...existingIds) : 0

  // Never go below the highest ID ever issued or still present
  return Math.max(stored || 0, maxExisting) + 1
}

/** Preview next ID without consuming it */
export async function peekNextId(type) {
  const prefix = type === 'CS' ? 'CS' : 'LD'
  const nextNum = await getNextIdNumber(prefix)
  return prefix + String(nextNum).padStart(4, '0')
}

export async function generateId(type) {
  const prefix = type === 'CS' ? 'CS' : 'LD'
  const nextNum = await getNextIdNumber(prefix)
  await saveSetting(`id_counter_${prefix}`, nextNum)
  return prefix + String(nextNum).padStart(4, '0')
}

/**
 * Fill missing advisorPhone from users.display_name match (legacy rows).
 * Persists updates so ownership survives user recreation by phone.
 */
export async function backfillAdvisorPhones(users) {
  if (!users || !users.length) return { updated: 0 }

  const byName = new Map()
  users.forEach(u => {
    const name = (u.display_name || `${u.first_name || ''} ${u.last_name || ''}`.trim() || '').trim()
    const phone = (u.phone || '').trim()
    if (name && phone) byName.set(name, phone)
  })

  let updated = 0
  for (const c of data.customers) {
    if (c.advisorPhone) continue
    if (!c.advisor) continue
    const phone = byName.get(c.advisor.trim())
    if (!phone) continue
    c.advisorPhone = phone
    try {
      await saveCustomerToDB(c)
      updated++
    } catch (e) {
      console.error('backfillAdvisorPhones error for', c.id, e)
    }
  }
  return { updated }
}
