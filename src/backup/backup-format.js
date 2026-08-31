import {
  BACKUP_FORMAT_VERSION,
  BACKUP_SOURCES,
  BACKUP_TABLES,
  BACKUP_DATA_PREFIX,
  emptyDeletionsMap
} from './constants.js'

export class BackupFormatError extends Error {
  /**
   * @param {string} message
   * @param {string} [code]
   */
  constructor(message, code = 'INVALID_FORMAT') {
    super(message)
    this.name = 'BackupFormatError'
    this.code = code
  }
}

/**
 * @typedef {Object} BackupExportedBy
 * @property {string} [phone]
 * @property {string} [role]
 * @property {string} [displayName]
 * @property {string} [username]
 */

/**
 * @typedef {Object} BackupManifest
 * @property {number} formatVersion
 * @property {string} exportedAt
 * @property {BackupExportedBy} exportedBy
 * @property {'online'|'offline'} source
 * @property {Record<string, number>} tableCounts
 * @property {Record<string, string[]>} deletions
 */

/**
 * @param {Partial<BackupManifest> & { exportedBy?: BackupExportedBy, source?: string }} opts
 * @returns {BackupManifest}
 */
export function createManifest(opts = {}) {
  const tableCounts = {}
  for (const table of BACKUP_TABLES) {
    tableCounts[table] = 0
  }

  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedAt: opts.exportedAt || new Date().toISOString(),
    exportedBy: {
      phone: opts.exportedBy?.phone || '',
      role: opts.exportedBy?.role || '',
      displayName: opts.exportedBy?.displayName || '',
      username: opts.exportedBy?.username || ''
    },
    source: opts.source === 'offline' ? 'offline' : 'online',
    tableCounts: { ...tableCounts, ...(opts.tableCounts || {}) },
    deletions: normalizeDeletions(opts.deletions)
  }
}

/**
 * @param {unknown} deletions
 * @returns {Record<string, string[]>}
 */
export function normalizeDeletions(deletions) {
  const base = emptyDeletionsMap()
  if (!deletions || typeof deletions !== 'object' || Array.isArray(deletions)) {
    return base
  }
  for (const table of BACKUP_TABLES) {
    const raw = /** @type {Record<string, unknown>} */ (deletions)[table]
    if (!Array.isArray(raw)) continue
    base[table] = raw.map(id => String(id)).filter(Boolean)
  }
  return base
}

/**
 * @param {unknown} manifest
 * @returns {BackupManifest}
 */
export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new BackupFormatError('manifest.json نامعتبر است.')
  }

  const m = /** @type {Record<string, unknown>} */ (manifest)

  if (m.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new BackupFormatError(
      `نسخه فرمت پشتیبان پشتیبانی نمی‌شود (نسخه فایل: ${m.formatVersion}، نسخه برنامه: ${BACKUP_FORMAT_VERSION}).`,
      'UNSUPPORTED_VERSION'
    )
  }

  if (typeof m.exportedAt !== 'string' || !m.exportedAt) {
    throw new BackupFormatError('فیلد exportedAt در manifest وجود ندارد.')
  }

  if (!BACKUP_SOURCES.includes(/** @type {string} */ (m.source))) {
    throw new BackupFormatError('فیلد source در manifest نامعتبر است.')
  }

  if (!m.tableCounts || typeof m.tableCounts !== 'object') {
    throw new BackupFormatError('فیلد tableCounts در manifest وجود ندارد.')
  }

  m.deletions = normalizeDeletions(m.deletions)

  return /** @type {BackupManifest} */ (m)
}

/**
 * Path inside ZIP for a table payload.
 * @param {string} table
 */
export function tableDataPath(table) {
  if (!BACKUP_TABLES.includes(table)) {
    throw new BackupFormatError(`جدول نامعتبر: ${table}`)
  }
  return `${BACKUP_DATA_PREFIX}${table}.json`
}

/**
 * @param {Record<string, unknown>[]} rows
 */
export function sanitizeUsersForBackup(rows) {
  return (rows || []).map(row => {
    const copy = { ...row }
    delete copy.password_hash
    delete copy.password
    return copy
  })
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {string} table
 */
export function sanitizeTableForBackup(table, rows) {
  if (table === 'users') return sanitizeUsersForBackup(rows)
  return rows || []
}

/**
 * Default download filename for a backup.
 * @param {BackupManifest} manifest
 */
export function suggestBackupFilename(manifest) {
  const ts = (manifest.exportedAt || new Date().toISOString())
    .replace(/[:.]/g, '-')
    .slice(0, 19)
  const source = manifest.source === 'offline' ? 'offline' : 'online'
  return `carno-backup-${source}-${ts}.carno-backup`
}
