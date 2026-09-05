const { unzipSync, strFromU8 } = require('fflate')

const BACKUP_FORMAT_VERSION = 2
const BACKUP_FORMAT_VERSION_MIN = 1
const BACKUP_KINDS = ['full', 'scoped']
const BACKUP_MANIFEST_PATH = 'manifest.json'
const BACKUP_DATA_PREFIX = 'data/'
const BACKUP_TABLES = [
  'customers', 'followups', 'refunds', 'ownership_transfers', 'ownership_transfer_acks',
  'users', 'groups', 'group_members', 'app_settings', 'notifications', 'notification_reads',
  'dm_conversations', 'dm_messages', 'dm_reads', 'dm_members', 'dm_pins', 'dm_chat_time_daily'
]

class BackupFormatError extends Error {
  constructor(message, code = 'INVALID_FORMAT') {
    super(message)
    this.name = 'BackupFormatError'
    this.code = code
  }
}

function emptyDeletionsMap() {
  const map = {}
  for (const table of BACKUP_TABLES) map[table] = []
  return map
}

function normalizeDeletions(deletions) {
  const base = emptyDeletionsMap()
  if (!deletions || typeof deletions !== 'object' || Array.isArray(deletions)) return base
  for (const table of BACKUP_TABLES) {
    const raw = deletions[table]
    if (!Array.isArray(raw)) continue
    base[table] = raw.map(id => String(id)).filter(Boolean)
  }
  return base
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new BackupFormatError('manifest.json نامعتبر است.')
  }
  const version = Number(manifest.formatVersion)
  if (!Number.isFinite(version) || version < BACKUP_FORMAT_VERSION_MIN || version > BACKUP_FORMAT_VERSION) {
    throw new BackupFormatError(
      `نسخه فرمت پشتیبان پشتیبانی نمی‌شود (نسخه فایل: ${manifest.formatVersion}).`,
      'UNSUPPORTED_VERSION'
    )
  }
  const backupKind = manifest.backupKind == null ? 'full' : String(manifest.backupKind)
  if (!BACKUP_KINDS.includes(backupKind)) {
    throw new BackupFormatError('فیلد backupKind در manifest نامعتبر است.')
  }
  manifest.backupKind = backupKind
  if (typeof manifest.exportedAt !== 'string' || !manifest.exportedAt) {
    throw new BackupFormatError('فیلد exportedAt در manifest وجود ندارد.')
  }
  if (!manifest.tableCounts || typeof manifest.tableCounts !== 'object') {
    throw new BackupFormatError('فیلد tableCounts در manifest وجود ندارد.')
  }
  manifest.deletions = normalizeDeletions(manifest.deletions)
  return manifest
}

function tableDataPath(table) {
  return `${BACKUP_DATA_PREFIX}${table}.json`
}

/**
 * @param {Uint8Array | Buffer} input
 * @returns {{ manifest: object, tables: Record<string, object[]> }}
 */
function parseBackupBytes(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (!bytes.length) throw new BackupFormatError('فایل پشتیبان خالی است.')

  let unzipped
  try {
    unzipped = unzipSync(bytes)
  } catch {
    throw new BackupFormatError('فایل ZIP نامعتبر است.')
  }

  const manifestRaw = unzipped[BACKUP_MANIFEST_PATH]
  if (!manifestRaw) throw new BackupFormatError('manifest.json در فایل پشتیبان یافت نشد.')

  let manifest
  try {
    manifest = validateManifest(JSON.parse(strFromU8(manifestRaw)))
  } catch (e) {
    if (e instanceof BackupFormatError) throw e
    throw new BackupFormatError('manifest.json قابل خواندن نیست.')
  }

  /** @type {Record<string, object[]>} */
  const tables = {}
  for (const table of BACKUP_TABLES) {
    const entryPath = tableDataPath(table)
    const raw = unzipped[entryPath]
    if (!raw) {
      tables[table] = []
      continue
    }
    try {
      const parsed = JSON.parse(strFromU8(raw))
      if (!Array.isArray(parsed)) {
        throw new BackupFormatError(`داده جدول ${table} باید آرایه باشد.`)
      }
      tables[table] = parsed
    } catch (e) {
      if (e instanceof BackupFormatError) throw e
      throw new BackupFormatError(`فایل ${entryPath} قابل خواندن نیست.`)
    }
  }

  return { manifest, tables }
}

module.exports = {
  BackupFormatError,
  BACKUP_TABLES,
  parseBackupBytes
}
