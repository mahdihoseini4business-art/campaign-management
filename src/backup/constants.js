/** Current `.carno-backup` format version (bump when schema changes). */
export const BACKUP_FORMAT_VERSION = 2

/** Minimum supported format version for import. */
export const BACKUP_FORMAT_VERSION_MIN = 1

/** Allowed backupKind values in manifest. */
export const BACKUP_KINDS = Object.freeze(['full', 'scoped'])

/** File extension for full backups (ZIP archive). */
export const BACKUP_FILE_EXTENSION = '.carno-backup'

/** Entry inside the ZIP archive. */
export const BACKUP_MANIFEST_PATH = 'manifest.json'

/** Prefix for per-table JSON payloads inside the ZIP. */
export const BACKUP_DATA_PREFIX = 'data/'

/** Allowed `source` values in manifest. */
export const BACKUP_SOURCES = Object.freeze(['online', 'offline'])

/**
 * Tables included in a full backup (DB snake_case names).
 * `otp_sessions` is intentionally excluded (ephemeral / security).
 */
export const BACKUP_TABLES = Object.freeze([
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
  'notification_reads'
])

/** Default empty deletions map (filled when deletion_log exists — phase 3). */
export function emptyDeletionsMap() {
  /** @type {Record<string, string[]>} */
  const map = {}
  for (const table of BACKUP_TABLES) {
    map[table] = []
  }
  return map
}
