/**
 * Full backup module — shared between online app and future offline-app.
 *
 * Phase 1: format, export, parse, merge analysis.
 * Phase 2: admin UI + applyMergePlanToSupabase.
 */

export {
  BACKUP_FORMAT_VERSION,
  BACKUP_FORMAT_VERSION_MIN,
  BACKUP_FILE_EXTENSION,
  BACKUP_TABLES,
  BACKUP_SOURCES,
  BACKUP_KINDS,
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
  suggestBackupFilename,
  suggestDistributionFilename,
  isScopedBackupManifest
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
  listMergeConflicts,
  mergeCustomerNotes,
  tryAutoMergeCustomerRow,
  diffRowFields,
  formatDiffValue
} from './backup-merge.js'

export {
  previewBackupMergeFromFile,
  previewBackupMerge,
  buildMergedSnapshot
} from './backup-import.js'

export { applyMergePlanToSupabase } from './backup-apply.js'

export {
  resolveAdvisorPhones,
  resolveBackupScope,
  filterTablesForUser,
  countTableRows,
  canViewOrgWideDataForUser,
  customerVisibleToUser,
  normalizePhone as scopeNormalizePhone
} from './backup-scope.js'

export {
  buildSplitDistributionZip,
  exportSplitDistributionFromSupabase,
  downloadDistributionFile
} from './backup-split.js'
