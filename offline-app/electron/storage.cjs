const { getDatabase, persistDatabase, BACKUP_TABLES, queryAll, queryOne } = require('./db.cjs')
const {
  IMPORT_ORDER,
  CLEAR_ORDER,
  TABLE_COLUMNS
} = require('./table-config.cjs')
const { serializeRow, deserializeRow, rowsFromExec } = require('./row-serialize.cjs')
const { parseBackupBytes } = require('./backup-parse.cjs')

function setMeta(key, value) {
  const db = getDatabase()
  db.run(`
    INSERT INTO app_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `, [key, String(value)])
}

function getMeta(key) {
  const row = queryOne('SELECT value FROM app_meta WHERE key = ?', [key])
  return row?.value ?? null
}

function clearBusinessTables() {
  const db = getDatabase()
  db.run('PRAGMA foreign_keys = OFF')
  for (const table of CLEAR_ORDER) {
    db.run(`DELETE FROM ${table}`)
  }
  db.run('DELETE FROM deletion_log')
  db.run('PRAGMA foreign_keys = ON')
}

/**
 * @param {string} table
 * @param {Record<string, unknown>} row
 */
function insertRow(table, row) {
  const db = getDatabase()
  const cols = TABLE_COLUMNS[table]
  if (!cols) throw new Error(`جدول ناشناخته: ${table}`)
  const values = serializeRow(table, row)
  const placeholders = cols.map(() => '?').join(', ')
  db.run(
    `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`,
    values
  )
}

/**
 * @param {string} table
 * @param {string} recordId
 * @param {string} [deletedByPhone]
 */
function logDeletion(table, recordId, deletedByPhone = '') {
  const db = getDatabase()
  db.run(
    `INSERT INTO deletion_log (table_name, record_id, deleted_at, deleted_by_phone)
     VALUES (?, ?, ?, ?)`,
    [table, recordId, new Date().toISOString(), deletedByPhone || null]
  )
}

/**
 * @param {Uint8Array | Buffer} bytes
 * @param {{ replace?: boolean }} [opts]
 */
function importBackupBytes(bytes, opts = {}) {
  const replace = opts.replace !== false
  const { manifest, tables } = parseBackupBytes(bytes)
  const db = getDatabase()

  db.run('BEGIN')
  try {
    if (replace) clearBusinessTables()

    for (const table of IMPORT_ORDER) {
      for (const row of tables[table] || []) {
        insertRow(table, row)
      }
    }

    for (const [table, ids] of Object.entries(manifest.deletions || {})) {
      if (!BACKUP_TABLES.includes(table)) continue
      for (const recordId of ids || []) {
        if (!recordId) continue
        logDeletion(table, String(recordId))
      }
    }

    setMeta('last_import_at', manifest.exportedAt)
    setMeta('last_import_source', manifest.source || 'online')
    setMeta('last_import_counts', JSON.stringify(manifest.tableCounts || {}))

    db.run('COMMIT')
    persistDatabase()
  } catch (err) {
    db.run('ROLLBACK')
    throw err
  }

  return {
    manifest,
    imported: manifest.tableCounts || {}
  }
}

/**
 * @param {string} table
 */
function fetchAllRows(table) {
  const db = getDatabase()
  const result = db.exec(`SELECT * FROM ${table}`)
  return rowsFromExec(result).map(row => deserializeRow(table, row))
}

function fetchAllTables() {
  /** @type {Record<string, unknown[]>} */
  const out = {}
  for (const table of BACKUP_TABLES) {
    out[table] = fetchAllRows(table)
  }
  return out
}

function countUsers() {
  const row = queryOne('SELECT COUNT(*) AS c FROM users')
  return Number(row?.c || 0)
}

function hasAnyData() {
  return countUsers() > 0
}

/**
 * @param {string} table
 * @param {Record<string, unknown>} row
 */
function upsertRow(table, row) {
  insertRow(table, row)
  persistDatabase()
}

/**
 * @param {string} table
 * @param {Record<string, string|number>} where
 */
function deleteRowsWhere(table, where) {
  const db = getDatabase()
  const keys = Object.keys(where)
  const sql = `DELETE FROM ${table} WHERE ${keys.map(k => `${k} = ?`).join(' AND ')}`
  db.run(sql, keys.map(k => where[k]))
  persistDatabase()
}

module.exports = {
  setMeta,
  getMeta,
  clearBusinessTables,
  insertRow,
  logDeletion,
  importBackupBytes,
  fetchAllRows,
  fetchAllTables,
  countUsers,
  hasAnyData,
  upsertRow,
  deleteRowsWhere
}
