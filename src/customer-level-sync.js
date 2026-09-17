/**
 * Keep customer.customerLevel in sync with auto-level rules and persist to DB.
 * Filter/sort/list read the stored field via resolveCustomerLevel (no recompute).
 *
 * Hot paths (live-sync / incremental poll) must not scan all customers on the
 * main thread or full-upsert rows — that freezes UI until data "settles".
 */

import {
  getData,
  saveCustomerLevelFieldsToDB,
  schedulePersistCoreCache,
  noteLocalWriteNow,
  normalizeCustomerId
} from './data.js'
import {
  getFollowupsByCustomerId,
  getReferralCountForCustomer
} from './derived-cache.js'
import { syncCustomerLevel } from './utils.js'

const CHUNK_SIZE = 40
/** Debounce coalescing of idle full-scans scheduled from boot/hydrate. */
const IDLE_DEBOUNCE_MS = 250

let idleTimer = null
let idleCallbackId = null
let running = false
/** @type {Set<string>} */
let pendingIds = new Set()
let pendingFull = false

function yieldToMain() {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve())
    } else {
      setTimeout(resolve, 0)
    }
  })
}

function noteBatchLocalWrite(count) {
  const ms = Math.max(3000, (count || 1) * 800)
  noteLocalWriteNow(ms)
  import('./live-sync.js').then(m => m.noteLocalWrite(ms)).catch(() => {})
}

/**
 * Recompute unlocked levels for a subset (or all) into memory.
 * @param {Iterable<string>|null} [onlyIds] if set, only those customer ids
 * @returns {object[]} customers whose level changed
 */
export function resyncUnlockedCustomerLevelsInMemory(onlyIds = null) {
  const data = getData()
  const customers = data.customers || []
  const followupsByCustomer = getFollowupsByCustomerId()
  const dirty = []
  const idSet = onlyIds
    ? new Set([...onlyIds].map(id => normalizeCustomerId(id)).filter(Boolean))
    : null

  for (const c of customers) {
    if (!c?.id || c.customerLevelLocked) continue
    if (idSet && !idSet.has(normalizeCustomerId(c.id))) continue
    const before = c.customerLevel || ''
    const fus = followupsByCustomer.get(c.id) || []
    syncCustomerLevel(c, customers, fus, getReferralCountForCustomer(c.id))
    if ((c.customerLevel || '') !== before) dirty.push(c)
  }

  return dirty
}

/**
 * Chunked in-memory resync so large tenants do not block input/scroll.
 * @param {Iterable<string>|null} [onlyIds]
 */
async function resyncUnlockedCustomerLevelsChunked(onlyIds = null) {
  const data = getData()
  const customers = data.customers || []
  const followupsByCustomer = getFollowupsByCustomerId()
  const dirty = []
  const idSet = onlyIds
    ? new Set([...onlyIds].map(id => normalizeCustomerId(id)).filter(Boolean))
    : null

  const targets = []
  for (const c of customers) {
    if (!c?.id || c.customerLevelLocked) continue
    if (idSet && !idSet.has(normalizeCustomerId(c.id))) continue
    targets.push(c)
  }

  for (let i = 0; i < targets.length; i += CHUNK_SIZE) {
    const slice = targets.slice(i, i + CHUNK_SIZE)
    for (const c of slice) {
      const before = c.customerLevel || ''
      const fus = followupsByCustomer.get(c.id) || []
      syncCustomerLevel(c, customers, fus, getReferralCountForCustomer(c.id))
      if ((c.customerLevel || '') !== before) dirty.push(c)
    }
    if (i + CHUNK_SIZE < targets.length) await yieldToMain()
  }

  return dirty
}

/** Persist dirty customer_level rows (level columns only, sequential). */
export async function persistCustomerLevels(dirtyCustomers) {
  const list = (dirtyCustomers || []).filter(c => c?.id)
  if (!list.length) return { updated: 0 }

  noteBatchLocalWrite(list.length)
  let updated = 0
  for (const c of list) {
    try {
      await saveCustomerLevelFieldsToDB(c)
      updated++
    } catch (e) {
      console.error('customer level persist failed', c.id, e)
    }
  }
  if (updated) schedulePersistCoreCache()
  return { updated }
}

/** In-memory resync + persist (blocking) — import / explicit repair only. */
export async function resyncAndPersistCustomerLevels() {
  const dirty = resyncUnlockedCustomerLevelsInMemory()
  if (!dirty.length) return { changed: 0, updated: 0 }
  const { updated } = await persistCustomerLevels(dirty)
  return { changed: dirty.length, updated }
}

async function flushPendingResync() {
  if (running) return
  running = true
  try {
    while (pendingFull || pendingIds.size) {
      const doFull = pendingFull
      const ids = doFull ? null : [...pendingIds]
      pendingFull = false
      pendingIds = new Set()

      const dirty = await resyncUnlockedCustomerLevelsChunked(ids)
      if (dirty.length) {
        const { updated } = await persistCustomerLevels(dirty)
        if (updated) console.log(`Persisted customer_level for ${updated} customers`)
      }
    }
  } catch (e) {
    console.error('customer level resync error:', e)
  } finally {
    running = false
    if (pendingFull || pendingIds.size) scheduleFlush()
  }
}

function scheduleFlush() {
  if (idleTimer != null || idleCallbackId != null) return

  const start = () => {
    idleTimer = null
    idleCallbackId = null
    void flushPendingResync()
  }

  if (typeof requestIdleCallback === 'function') {
    idleCallbackId = requestIdleCallback(start, { timeout: 2000 })
  } else {
    idleTimer = setTimeout(start, IDLE_DEBOUNCE_MS)
  }
}

/**
 * Queue a background full resync (boot / hydrate). Never blocks the caller.
 * @returns {{ scheduled: true }}
 */
export function scheduleCustomerLevelResync() {
  pendingFull = true
  pendingIds = new Set()
  scheduleFlush()
  return { scheduled: true }
}

/**
 * Queue resync for specific customers only (incremental sync / mutations).
 * @param {Iterable<string>} ids
 */
export function scheduleCustomerLevelResyncForIds(ids) {
  if (pendingFull) {
    scheduleFlush()
    return { scheduled: true }
  }
  let added = 0
  for (const id of ids || []) {
    const nid = normalizeCustomerId(id)
    if (!nid) continue
    if (!pendingIds.has(nid)) {
      pendingIds.add(nid)
      added++
    }
  }
  if (added || pendingIds.size) scheduleFlush()
  return { scheduled: true, queued: pendingIds.size }
}
