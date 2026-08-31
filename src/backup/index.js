/**
 * Full backup module — shared between online app and future offline-app.
 *
 * Phase 1: format, export, parse, merge analysis.
 * Phase 2: admin UI + applyMergePlanToSupabase.
 */

export {
  BACKUP_FORMAT_VERSION,
  BACKUP_FILE_EXTENSION,
  BACKUP_TABLES,
  BACKUP_SOURCES,
  emptyDeletionsMap
} from './constants.js'

export {
  BACKUP_TABLE_CONFIG,
  getBackupTableConfig,
  recordKey,
  recordUpdatedAt,
  indexRowsByKey
} from './backup-tables.js'

export {
  BackupFormatError,
  createManifest,
  validateManifest,
  normalizeDeletions,
  tableDataPath,
  sanitizeUsersForBackup,
  sanitizeTableForBackup,
  suggestBackupFilename
} from './backup-format.js'

export {
  fetchAllRows,
  fetchAppSettings,
  fetchAllRowsWithFallback
} from './supabase-fetch.js'

export {
  fetchPendingDeletions,
  clearDeletionLogEntries,
  countPendingDeletions
} from './deletion-log.js'

export {
  collectFullBackupFromSupabase,
  buildBackupZip,
  packFullBackup,
  exportFullBackupFromSupabase,
  downloadBackupFile,
  parseBackupZip,
  parseBackupFile
} from './backup-export.js'

export {
  rowsEquivalent,
  analyzeMerge,
  applyMergePlanToSnapshot,
  summarizeMergePlan,
  listMergeConflicts
} from './backup-merge.js'

export {
  previewBackupMergeFromFile,
  previewBackupMerge,
  buildMergedSnapshot
} from './backup-import.js'

export { applyMergePlanToSupabase } from './backup-apply.js'
