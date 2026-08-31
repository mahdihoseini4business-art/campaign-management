import { parseBackupFile, parseBackupZip, collectFullBackupFromSupabase } from './backup-export.js'
import { analyzeMerge, applyMergePlanToSnapshot, summarizeMergePlan, listMergeConflicts } from './backup-merge.js'
import { validateManifest } from './backup-format.js'
import { BACKUP_TABLES } from './constants.js'

/**
 * @typedef {import('./backup-format.js').BackupManifest} BackupManifest
 * @typedef {import('./backup-merge.js').MergePlan} MergePlan
 */

/**
 * Load backup file and compare against current online data from Supabase.
 * @param {File|Blob} backupFile
 * @param {object} [opts]
 * @param {(info: { table: string, done: number, total: number }) => void} [opts.onLoadProgress]
 */
export async function previewBackupMergeFromFile(backupFile, opts = {}) {
  const { manifest, tables: backupTables } = await parseBackupFile(backupFile)
  const { tables: onlineTables } = await collectFullBackupFromSupabase({
    onProgress: opts.onLoadProgress,
    source: 'online'
  })
  const plan = analyzeMerge({
    onlineTables,
    backupManifest: manifest,
    backupTables
  })
  return { manifest, backupTables, onlineTables, plan }
}

/**
 * Preview merge when both snapshots are already in memory.
 * @param {BackupManifest} backupManifest
 * @param {Record<string, Record<string, unknown>[]>} backupTables
 * @param {Record<string, Record<string, unknown>[]>} onlineTables
 */
export function previewBackupMerge(backupManifest, backupTables, onlineTables) {
  const manifest = validateManifest(backupManifest)
  const plan = analyzeMerge({
    onlineTables,
    backupManifest: manifest,
    backupTables
  })
  return { manifest, plan }
}

/**
 * Build merged in-memory snapshot after user resolves conflicts.
 * @param {Record<string, Record<string, unknown>[]>} onlineTables
 * @param {MergePlan} plan
 * @param {Record<string, 'backup'|'online'>} [conflictResolutions]
 */
export function buildMergedSnapshot(onlineTables, plan, conflictResolutions = {}) {
  return applyMergePlanToSnapshot(onlineTables, plan, conflictResolutions)
}

/**
 * Apply merge plan to Supabase — implemented in phase 2 (restore UI).
 * @param {MergePlan} _plan
 * @param {Record<string, 'backup'|'online'>} [_conflictResolutions]
 */
export async function applyMergePlanToSupabase(_plan, _conflictResolutions = {}) {
  throw new Error('بازیابی در پایگاه داده هنوز پیاده‌سازی نشده است (فاز ۲).')
}

export {
  parseBackupFile,
  parseBackupZip,
  analyzeMerge,
  summarizeMergePlan,
  listMergeConflicts,
  BACKUP_TABLES
}
