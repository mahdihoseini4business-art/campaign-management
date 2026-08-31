import {
  BACKUP_FORMAT_VERSION,
  BACKUP_FORMAT_VERSION_MIN,
  BACKUP_KINDS,
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
 * @typedef {Object} BackupScope
 * @property {string} username
 * @property {string} phone
 * @property {string[]} advisorPhones
 * @property {boolean} [includesTeam]
 */

/**
 * @typedef {Object} BackupManifest
 * @property {number} formatVersion
 * @property {string} exportedAt
 * @property {BackupExportedBy} exportedBy
 * @property {'online'|'offline'} source
 * @property {Record<string, number>} tableCounts
 * @property {Record<string, string[]>} deletions
 * @property {'full'|'scoped'} [backupKind]
 * @property {BackupScope} [scope]
 * @property {string} [parentExportId]
 */

/**
 * @param {Partial<BackupManifest> & { exportedBy?: BackupExportedBy, source?: string, backupKind?: string, scope?: BackupScope, parentExportId?: string }} opts
 * @returns {BackupManifest}
 */
export function createManifest(opts = {}) {
  const tableCounts = {}
  for (const table of BACKUP_TABLES) {
    tableCounts[table] = 0
  }

  const backupKind = opts.backupKind === 'scoped' ? 'scoped' : 'full'
  /** @type {BackupManifest} */
  const manifest = {
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
    deletions: normalizeDeletions(opts.deletions),
    backupKind
  }

  if (backupKind === 'scoped' && opts.scope) {
    manifest.scope = {
      username: opts.scope.username || '',
      phone: opts.scope.phone || '',
      advisorPhones: Array.isArray(opts.scope.advisorPhones)
        ? opts.scope.advisorPhones.map(p => String(p)).filter(Boolean)
        : [],
      includesTeam: !!opts.scope.includesTeam
    }
  }
  if (opts.parentExportId) {
    manifest.parentExportId = String(opts.parentExportId)
  }

  return manifest
}

/**
 * @param {unknown} manifest
 * @returns {boolean}
 */
export function isScopedBackupManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return false
  return /** @type {BackupManifest} */ (manifest).backupKind === 'scoped'
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

  const version = Number(m.formatVersion)
  if (!Number.isFinite(version) || version < BACKUP_FORMAT_VERSION_MIN || version > BACKUP_FORMAT_VERSION) {
    throw new BackupFormatError(
      `نسخه فرمت پشتیبان پشتیبانی نمی‌شود (نسخه فایل: ${m.formatVersion}، نسخه برنامه: ${BACKUP_FORMAT_VERSION}).`,
      'UNSUPPORTED_VERSION'
    )
  }

  const backupKind = m.backupKind == null ? 'full' : String(m.backupKind)
  if (!BACKUP_KINDS.includes(/** @type {'full'|'scoped'} */ (backupKind))) {
    throw new BackupFormatError('فیلد backupKind در manifest نامعتبر است.')
  }
  m.backupKind = backupKind

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
  if (manifest.backupKind === 'scoped' && manifest.scope?.username) {
    const user = String(manifest.scope.username).replace(/[^\w.-]+/g, '_')
    return `carno-backup-scoped-${user}-${ts}.carno-backup`
  }
  return `carno-backup-${source}-${ts}.carno-backup`
}

/**
 * @param {string} [exportedAt]
 */
export function suggestDistributionFilename(exportedAt) {
  const ts = (exportedAt || new Date().toISOString())
    .replace(/[:.]/g, '-')
    .slice(0, 19)
  return `carno-offline-distribution-${ts}.zip`
}
