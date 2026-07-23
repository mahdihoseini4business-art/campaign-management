// ============================================
// Data Layer (Supabase)
// ============================================

import { supabase } from './supabase.js'

let data = { customers: [], followups: [], convertedCount: 0 }

// ============================================
// Load all data from Supabase
// ============================================

export async function loadData() {
  const [customersRes, followupsRes, settingsRes] = await Promise.all([
    supabase.from('customers').select('*'),
    supabase.from('followups').select('*'),
    supabase.from('app_settings').select('*')
  ])

  if (customersRes.error) console.error('Load customers error:', customersRes.error)
  if (followupsRes.error) console.error('Load followups error:', followupsRes.error)
  if (settingsRes.error) console.error('Load settings error:', settingsRes.error)

  // Map DB rows to app format
  data.customers = (customersRes.data || []).map(c => ({
    id: c.id,
    platformId: c.platform_id || '',
    platform: c.platform || 'instagram',
    name: c.name || '',
    phone: c.phone || '',
    status: c.status || 'new',
    notes: c.notes || '',
    advisor: c.advisor || '',
    nextFollowupDate: c.next_followup_date || '',
    products: c.products || []
  }))

  data.followups = (followupsRes.data || []).map(f => ({
    id: f.id,
    customerId: f.customer_id,
    date: f.date || '',
    type: f.type || '',
    result: f.result || '',
    nextDate: f.next_date || '',
    notes: f.notes || ''
  }))

  // Load settings (convertedCount)
  const settings = {}
  ;(settingsRes.data || []).forEach(s => { settings[s.key] = s.value })
  data.convertedCount = settings.convertedCount || 0

  return data
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
  const row = {
    id: customer.id,
    platform_id: customer.platformId || '',
    platform: customer.platform || 'instagram',
    name: customer.name || '',
    phone: customer.phone || '',
    status: customer.status || 'new',
    notes: customer.notes || '',
    advisor: customer.advisor || '',
    next_followup_date: customer.nextFollowupDate || '',
    products: customer.products || []
  }

  const { error } = await supabase.from('customers').upsert(row, { onConflict: 'id' })
  if (error) throw new Error('خطا در ذخیره مشتری: ' + error.message)
}

// ============================================
// Delete customer from Supabase
// ============================================

export async function deleteCustomerFromDB(id) {
  // Delete followups first
  await supabase.from('followups').delete().eq('customer_id', id)
  // Delete customer
  const { error } = await supabase.from('customers').delete().eq('id', id)
  if (error) throw new Error('خطا در حذف مشتری: ' + error.message)
}

// ============================================
// Save followup to Supabase
// ============================================

// followups don't have a stable primary key in the app,
// so we use customer_id + date + type as a soft key
export async function saveFollowupToDB(followup) {
  const { data: inserted, error } = await supabase.from('followups').insert({
    customer_id: followup.customerId,
    date: followup.date,
    type: followup.type,
    result: followup.result,
    next_date: followup.nextDate,
    notes: followup.notes
  }).select('id').single()
  if (error) throw new Error('خطا در درج پیگیری: ' + error.message)
  return inserted ? inserted.id : null
}

export async function updateFollowupInDB(followup) {
  if (!followup.id) return
  const { error } = await supabase.from('followups').update({
    customer_id: followup.customerId,
    date: followup.date,
    type: followup.type,
    result: followup.result,
    next_date: followup.nextDate,
    notes: followup.notes
  }).eq('id', followup.id)
  if (error) throw new Error('خطا در ویرایش پیگیری: ' + error.message)
}

// ============================================
// Delete followup from Supabase
// ============================================

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

export function generateId(type) {
  const prefix = type === 'CS' ? 'CS' : 'LD'
  const existingIds = data.customers
    .filter(c => c.id.startsWith(prefix))
    .map(c => parseInt(c.id.slice(2)))
    .filter(n => !isNaN(n))
  const nextNum = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 1
  return prefix + String(nextNum).padStart(4, '0')
}
