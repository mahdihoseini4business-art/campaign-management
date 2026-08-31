import { supabase } from '../supabase.js'
import { BACKUP_TABLES, emptyDeletionsMap } from './constants.js'
import { fetchAllRows } from './supabase-fetch.js'

const CLEAR_CHUNK = 200

/**
 * Load pending deletions from deletion_log (since last cleared export).
 * @returns {Promise<{ deletions: Record<string, string[]>, logIds: number[], available: boolean }>}
 */
export async function fetchPendingDeletions() {
  const res = await fetchAllRows('deletion_log', {
    select: 'id,table_name,record_id',
    orderCol: 'id',
    ascending: true
  })

  if (res.error) {
    const msg = res.error.message || ''
    if (/deletion_log|does not exist|relation|schema cache/i.test(msg)) {
      return { deletions: emptyDeletionsMap(), logIds: [], available: false }
    }
    throw res.error
  }

  /** @type {Record<string, Set<string>>} */
  const sets = {}
  for (const table of BACKUP_TABLES) {
    sets[table] = new Set()
  }

  /** @type {number[]} */
  const logIds = []

  for (const row of res.data || []) {
    const table = row.table_name
    const recordId = row.record_id != null ? String(row.record_id) : ''
    if (!recordId || !sets[table]) continue
    sets[table].add(recordId)
    if (row.id != null) logIds.push(Number(row.id))
  }

  /** @type {Record<string, string[]>} */
  const deletions = emptyDeletionsMap()
  for (const table of BACKUP_TABLES) {
    deletions[table] = [...sets[table]]
  }

  return { deletions, logIds, available: true }
}

/**
 * Remove exported deletion_log rows after a successful backup download.
 * @param {number[]} logIds
 */
export async function clearDeletionLogEntries(logIds) {
  const ids = [...new Set((logIds || []).filter(id => Number.isFinite(id)))]
  if (!ids.length) return

  for (let i = 0; i < ids.length; i += CLEAR_CHUNK) {
    const chunk = ids.slice(i, i + CLEAR_CHUNK)
    const { error } = await supabase.from('deletion_log').delete().in('id', chunk)
    if (error) {
      const msg = error.message || ''
      if (/deletion_log|does not exist|relation/i.test(msg)) return
      throw error
    }
  }
}

/**
 * Count total pending deletions (for UI summary).
 * @param {Record<string, string[]>} deletions
 */
export function countPendingDeletions(deletions) {
  let n = 0
  for (const table of BACKUP_TABLES) {
    n += (deletions[table] || []).length
  }
  return n
}
