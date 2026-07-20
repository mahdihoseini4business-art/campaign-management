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
  if (error) console.error('Save customer error:', error)
}

// ============================================
// Delete customer from Supabase
// ============================================

export async function deleteCustomerFromDB(id) {
  // Delete followups first
  await supabase.from('followups').delete().eq('customer_id', id)
  // Delete customer
  const { error } = await supabase.from('customers').delete().eq('id', id)
  if (error) console.error('Delete customer error:', error)
}

// ============================================
// Save followup to Supabase
// ============================================

// followups don't have a stable primary key in the app,
// so we use customer_id + date + type as a soft key
export async function saveFollowupToDB(followup, oldIndex) {
  // For new followups, just insert
  if (oldIndex === undefined || oldIndex === null) {
    const { error } = await supabase.from('followups').insert({
      customer_id: followup.customerId,
      date: followup.date,
      type: followup.type,
      result: followup.result,
      next_date: followup.nextDate,
      notes: followup.notes
    })
    if (error) console.error('Insert followup error:', error)
    return
  }

  // For edits: delete all followups for this customer and re-insert
  // (simple approach since followups don't have stable IDs)
  const customerId = followup.customerId
  await supabase.from('followups').delete().eq('customer_id', customerId)

  const allFollowups = data.followups.filter(f => f.customerId === customerId)
  const rows = allFollowups.map(f => ({
    customer_id: f.customerId,
    date: f.date,
    type: f.type,
    result: f.result,
    next_date: f.nextDate,
    notes: f.notes
  }))

  if (rows.length > 0) {
    const { error } = await supabase.from('followups').insert(rows)
    if (error) console.error('Re-insert followups error:', error)
  }
}

// ============================================
// Delete followup from Supabase
// ============================================

export async function deleteFollowupFromDB(customerId) {
  // Delete all followups for this customer and re-insert remaining
  await supabase.from('followups').delete().eq('customer_id', customerId)

  const remaining = data.followups.filter(f => f.customerId === customerId)
  if (remaining.length > 0) {
    const rows = remaining.map(f => ({
      customer_id: f.customerId,
      date: f.date,
      type: f.type,
      result: f.result,
      next_date: f.nextDate,
      notes: f.notes
    }))
    const { error } = await supabase.from('followups').insert(rows)
    if (error) console.error('Re-insert followups error:', error)
  }
}

// ============================================
// Update followups customer ID (for LD↔CS conversion)
// ============================================

export async function updateFollowupsCustomerId(oldId, newId) {
  // Delete old followups
  await supabase.from('followups').delete().eq('customer_id', oldId)

  // Re-insert with new ID
  const affected = data.followups.filter(f => f.customerId === newId)
  if (affected.length > 0) {
    const rows = affected.map(f => ({
      customer_id: newId,
      date: f.date,
      type: f.type,
      result: f.result,
      next_date: f.nextDate,
      notes: f.notes
    }))
    const { error } = await supabase.from('followups').insert(rows)
    if (error) console.error('Re-insert followups error:', error)
  }
}

// ============================================
// Save app setting
// ============================================

export async function saveSetting(key, value) {
  const { error } = await supabase.from('app_settings').upsert({ key, value }, { onConflict: 'key' })
  if (error) console.error('Save setting error:', error)
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
