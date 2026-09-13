/** IndexedDB snapshot of core CRM data + incremental-sync watermarks. */

export const CACHE_SCHEMA_VERSION = 1

const DB_NAME = 'carno-core-cache'
const DB_VERSION = 1
const STORE = 'snapshots'

export function isOfflineApp() {
  return typeof window !== 'undefined' && !!window.__CARNO_OFFLINE__
}

/** Stable permission fingerprint — role change must invalidate the snapshot. */
export function buildPermSig(user) {
  const permissions = user?.permissions && typeof user.permissions === 'object'
    ? stableJson(user.permissions)
    : '{}'
  const phones = Array.isArray(user?.viewUserPhones)
    ? [...user.viewUserPhones].map(String).sort()
    : []
  return JSON.stringify({
    role: String(user?.role || ''),
    permissions,
    viewUserPhones: phones
  })
}

function stableJson(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`
}

export function snapshotKey(tenantId, userPhone) {
  return `${CACHE_SCHEMA_VERSION}:${tenantId}:${userPhone}`
}

function isValidPayload(payload) {
  return !!(
    payload
    && typeof payload === 'object'
    && Array.isArray(payload.customers)
    && Array.isArray(payload.followups)
    && Array.isArray(payload.refunds)
  )
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexedDB unavailable'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex('userPhone', 'userPhone', { unique: false })
        store.createIndex('tenantId', 'tenantId', { unique: false })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error || new Error('indexedDB open failed'))
  })
}

function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(key)
    req.onsuccess = () => resolve(req.result || null)
    req.onerror = () => reject(req.error)
  })
}

function idbPut(db, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error || new Error('aborted'))
    tx.objectStore(STORE).put(value)
  })
}

function idbGetAll(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).getAll()
    req.onsuccess = () => resolve(req.result || [])
    req.onerror = () => reject(req.error)
  })
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error || new Error('aborted'))
  })
}

/**
 * @param {{ tenantId: string, userPhone: string, permSig: string }} opts
 * @returns {Promise<object|null>}
 */
export async function readCoreSnapshot({ tenantId, userPhone, permSig }) {
  if (isOfflineApp()) return null
  if (!tenantId || !userPhone) return null
  let db
  try {
    db = await openDb()
    const row = await idbGet(db, snapshotKey(tenantId, userPhone))
    if (!row) return null
    if (row.schemaVersion !== CACHE_SCHEMA_VERSION) return null
    if (row.tenantId !== tenantId || row.userPhone !== userPhone) return null
    if (row.permSig !== permSig) return null
    if (!isValidPayload(row.payload) || !row.syncMeta || typeof row.syncMeta !== 'object') return null
    return row
  } catch (e) {
    console.warn('readCoreSnapshot', e)
    return null
  } finally {
    try { db?.close() } catch (_) { /* ignore */ }
  }
}

/**
 * @param {{ tenantId: string, userPhone: string, permSig: string, syncMeta: object, payload: object }} opts
 */
export async function writeCoreSnapshot({ tenantId, userPhone, permSig, syncMeta, payload }) {
  if (isOfflineApp()) return false
  if (!tenantId || !userPhone || !payload || !syncMeta) return false
  let db
  try {
    db = await openDb()
    await idbPut(db, {
      id: snapshotKey(tenantId, userPhone),
      schemaVersion: CACHE_SCHEMA_VERSION,
      tenantId,
      userPhone,
      permSig: permSig || '',
      savedAt: new Date().toISOString(),
      syncMeta,
      payload
    })
    return true
  } catch (e) {
    console.warn('writeCoreSnapshot', e)
    return false
  } finally {
    try { db?.close() } catch (_) { /* ignore */ }
  }
}

export async function clearCoreSnapshotsForUser(userPhone) {
  if (!userPhone) {
    await clearAllCoreSnapshots()
    return
  }
  let db
  try {
    db = await openDb()
    const rows = await idbGetAll(db)
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    for (const row of rows) {
      if (row.userPhone === userPhone) store.delete(row.id)
    }
    await txDone(tx)
  } catch (e) {
    console.warn('clearCoreSnapshotsForUser', e)
    await clearAllCoreSnapshots()
  } finally {
    try { db?.close() } catch (_) { /* ignore */ }
  }
}

export async function clearCoreSnapshotsForTenant(tenantId) {
  if (!tenantId) return
  let db
  try {
    db = await openDb()
    const rows = await idbGetAll(db)
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    for (const row of rows) {
      if (row.tenantId === tenantId) store.delete(row.id)
    }
    await txDone(tx)
  } catch (e) {
    console.warn('clearCoreSnapshotsForTenant', e)
  } finally {
    try { db?.close() } catch (_) { /* ignore */ }
  }
}

export async function clearAllCoreSnapshots() {
  let db
  try {
    db = await openDb()
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).clear()
    await txDone(tx)
  } catch (e) {
    console.warn('clearAllCoreSnapshots', e)
  } finally {
    try { db?.close() } catch (_) { /* ignore */ }
  }
}
