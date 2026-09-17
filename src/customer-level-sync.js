/**
 * Keep customer.customerLevel in sync with auto-level rules and persist to DB.
 * Filter/sort/list read the stored field via resolveCustomerLevel (no recompute).
 */

import { getData, saveCustomerToDB, schedulePersistCoreCache } from './data.js'
import { getFollowupsByCustomerId, getReferralCountForCustomer } from './derived-cache.js'
import { syncCustomerLevel } from './utils.js'

/**
 * Recompute unlocked levels into memory. Returns customers whose level changed.
 */
export function resyncUnlockedCustomerLevelsInMemory() {
  const data = getData()
  const customers = data.customers || []
  const followupsByCustomer = getFollowupsByCustomerId()
  const dirty = []

  for (const c of customers) {
    if (!c?.id || c.customerLevelLocked) continue
    const before = c.customerLevel || ''
    const fus = followupsByCustomer.get(c.id) || []
    syncCustomerLevel(c, customers, fus, getReferralCountForCustomer(c.id))
    if ((c.customerLevel || '') !== before) dirty.push(c)
  }

  return dirty
}

/** Persist dirty customer_level rows (sequential to avoid flooding Supabase). */
export async function persistCustomerLevels(dirtyCustomers) {
  let updated = 0
  for (const c of dirtyCustomers || []) {
    if (!c?.id) continue
    try {
      await saveCustomerToDB(c)
      updated++
    } catch (e) {
      console.error('customer level persist failed', c.id, e)
    }
  }
  if (updated) schedulePersistCoreCache()
  return { updated }
}

/** In-memory resync + background persist of changed levels. */
export async function resyncAndPersistCustomerLevels() {
  const dirty = resyncUnlockedCustomerLevelsInMemory()
  if (!dirty.length) return { changed: 0, updated: 0 }
  const { updated } = await persistCustomerLevels(dirty)
  return { changed: dirty.length, updated }
}

/**
 * Sync levels into RAM immediately; persist diffs without blocking the caller.
 * @returns {{ changed: number }}
 */
export function scheduleCustomerLevelResync() {
  const dirty = resyncUnlockedCustomerLevelsInMemory()
  if (dirty.length) {
    persistCustomerLevels(dirty)
      .then(({ updated }) => {
        if (updated) console.log(`Persisted customer_level for ${updated} customers`)
      })
      .catch(e => console.error('customer level persist error:', e))
  }
  return { changed: dirty.length }
}
