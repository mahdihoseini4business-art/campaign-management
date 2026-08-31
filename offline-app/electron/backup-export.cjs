const fs = require('node:fs')
const path = require('node:path')
const { zipSync, strToU8 } = require('fflate')
const { BACKUP_TABLES } = require('./db.cjs')
const { fetchAllRows, logDeletion } = require('./storage.cjs')
const { getDatabase, persistDatabase, queryAll } = require('./db.cjs')
const { tableDataPath, suggestBackupFilename } = require('./backup-format-shared.cjs')

function createManifest(opts = {}) {
  const tableCounts = {}
  for (const table of BACKUP_TABLES) tableCounts[table] = 0
  return {
    formatVersion: 1,
    exportedAt: opts.exportedAt || new Date().toISOString(),
    exportedBy: opts.exportedBy || {},
    source: 'offline',
    tableCounts: { ...tableCounts, ...(opts.tableCounts || {}) },
    deletions: opts.deletions || emptyDeletions()
  }
}

function emptyDeletions() {
  const map = {}
  for (const table of BACKUP_TABLES) map[table] = []
  return map
}

function fetchPendingDeletions() {
  const rows = queryAll('SELECT table_name, record_id FROM deletion_log ORDER BY id')
  const deletions = emptyDeletions()
  for (const row of rows) {
    const t = String(row.table_name || '')
    const id = String(row.record_id || '')
    if (t && id && deletions[t]) deletions[t].push(id)
  }
  return deletions
}

function clearDeletionLog() {
  const db = getDatabase()
  db.run('DELETE FROM deletion_log')
  persistDatabase()
}

/**
 * @param {{ exportedBy?: object }} [opts]
 */
function buildOfflineBackupZip(opts = {}) {
  /** @type {Record<string, object[]>} */
  const tables = {}
  for (const table of BACKUP_TABLES) {
    tables[table] = fetchAllRows(table)
  }

  const tableCounts = {}
  for (const table of BACKUP_TABLES) {
    tableCounts[table] = (tables[table] || []).length
  }

  const deletions = fetchPendingDeletions()
  const manifest = createManifest({
    exportedBy: opts.exportedBy || {},
    tableCounts,
    deletions
  })

  /** @type {Record<string, Uint8Array>} */
  const entries = {
    'manifest.json': strToU8(JSON.stringify(manifest, null, 0))
  }
  for (const table of BACKUP_TABLES) {
    const rows = table === 'users'
      ? (tables[table] || []).map(r => {
        const copy = { ...r }
        delete copy.password_hash
        return copy
      })
      : (tables[table] || [])
    entries[tableDataPath(table)] = strToU8(JSON.stringify(rows))
  }

  const bytes = zipSync(entries, { level: 6 })
  const filename = suggestBackupFilename(manifest)
  return { bytes, manifest, filename, deletionCount: rowsDeletionCount(deletions) }
}

function rowsDeletionCount(deletions) {
  let n = 0
  for (const ids of Object.values(deletions || {})) n += (ids || []).length
  return n
}

/**
 * @param {string} defaultPath
 * @param {{ exportedBy?: object }} [opts]
 */
function exportBackupToFile(defaultPath, opts = {}) {
  const { bytes, filename, deletionCount } = buildOfflineBackupZip(opts)
  const target = defaultPath || path.join(path.dirname(defaultPath || '.'), filename)
  fs.writeFileSync(target, Buffer.from(bytes))
  clearDeletionLog()
  return { path: target, filename, deletionCount }
}

module.exports = {
  buildOfflineBackupZip,
  exportBackupToFile,
  fetchPendingDeletions,
  clearDeletionLog
}
