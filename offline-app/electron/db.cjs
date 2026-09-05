const fs = require('node:fs')
const path = require('node:path')
const initSqlJs = require('sql.js')
const { schemaSqlPath, schemaVersionPath, sqlJsDistDir } = require('./paths.cjs')

const SCHEMA_VERSION = readSchemaVersion()
const BACKUP_TABLES = [
  'customers',
  'followups',
  'refunds',
  'ownership_transfers',
  'ownership_transfer_acks',
  'users',
  'groups',
  'group_members',
  'app_settings',
  'notifications',
  'notification_reads',
  'dm_conversations',
  'dm_messages',
  'dm_reads'
]

/** @type {import('sql.js').Database | null} */
let db = null
/** @type {string} */
let dbPath = ''

function readSchemaVersion() {
  try {
    const raw = fs.readFileSync(schemaVersionPath(), 'utf8')
    const n = parseInt(String(raw).trim(), 10)
    return Number.isFinite(n) ? n : 1
  } catch {
    return 1
  }
}

function defaultDbPath() {
  const { app } = require('electron')
  return path.join(app.getPath('userData'), 'carno-offline.db')
}

function persistDatabase() {
  if (!db || !dbPath) return
  const dir = path.dirname(dbPath)
  fs.mkdirSync(dir, { recursive: true })
  const data = db.export()
  fs.writeFileSync(dbPath, Buffer.from(data))
}

async function openDatabase(targetPath = defaultDbPath()) {
  if (db) return db
  dbPath = targetPath
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(sqlJsDistDir(), file)
  })

  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath)
    db = new SQL.Database(fileBuffer)
  } else {
    db = new SQL.Database()
  }

  db.run('PRAGMA foreign_keys = ON')
  return db
}

function getDatabase() {
  if (!db) throw new Error('Database is not open')
  return db
}

function closeDatabase() {
  if (!db) return
  persistDatabase()
  db.close()
  db = null
}

function initSchema() {
  const database = getDatabase()
  const schemaPath = schemaSqlPath()
  const sql = fs.readFileSync(schemaPath, 'utf8')
  database.run(sql)

  database.run(`
    INSERT INTO app_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `, ['schema_version', String(SCHEMA_VERSION)])

  database.run(`
    INSERT INTO app_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `, ['initialized_at', new Date().toISOString()])

  persistDatabase()
  return { schemaVersion: SCHEMA_VERSION }
}

function getTableCounts() {
  const database = getDatabase()
  /** @type {Record<string, number>} */
  const counts = {}
  for (const table of BACKUP_TABLES) {
    const result = database.exec(`SELECT COUNT(*) AS c FROM ${table}`)
    const value = result?.[0]?.values?.[0]?.[0]
    counts[table] = Number(value || 0)
  }
  const delResult = database.exec('SELECT COUNT(*) AS c FROM deletion_log')
  counts.deletion_log = Number(delResult?.[0]?.values?.[0]?.[0] || 0)
  return counts
}

function getAppInfo(resolvedPath = dbPath || defaultDbPath()) {
  const database = getDatabase()
  const rows = queryAll("SELECT value FROM app_meta WHERE key = 'schema_version'")
  const schemaValue = rows[0]?.value
  return {
    mode: 'offline',
    dbPath: resolvedPath,
    schemaVersion: Number(schemaValue || SCHEMA_VERSION),
    backupFormatVersion: 1,
    tables: BACKUP_TABLES,
    engine: 'sql.js'
  }
}

/**
 * @param {string} sql
 * @param {unknown[]} [params]
 */
function queryAll(sql, params = []) {
  const database = getDatabase()
  const stmt = database.prepare(sql)
  if (params.length) stmt.bind(params)
  /** @type {Record<string, unknown>[]} */
  const rows = []
  while (stmt.step()) {
    rows.push(stmt.getAsObject())
  }
  stmt.free()
  return rows
}

/**
 * @param {string} sql
 * @param {unknown[]} [params]
 */
function queryOne(sql, params = []) {
  const rows = queryAll(sql, params)
  return rows[0] || null
}

module.exports = {
  SCHEMA_VERSION,
  BACKUP_TABLES,
  defaultDbPath,
  openDatabase,
  getDatabase,
  closeDatabase,
  persistDatabase,
  initSchema,
  getTableCounts,
  getAppInfo,
  queryAll,
  queryOne
}
