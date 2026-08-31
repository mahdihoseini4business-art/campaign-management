import { BACKUP_TABLES } from './constants.js'
import {
  indexRowsByKey,
  recordKey,
  recordUpdatedAt
} from './backup-tables.js'

/**
 * @typedef {'insert'|'update'|'unchanged'|'conflict'|'keep_online'|'delete'|'delete_conflict'} MergeActionKind
 */

/**
 * @typedef {Object} MergeRecordPlan
 * @property {string} table
 * @property {string} key
 * @property {MergeActionKind} action
 * @property {Record<string, unknown>} [backupRow]
 * @property {Record<string, unknown>} [onlineRow]
 * @property {string} [reason]
 */

/**
 * @typedef {Object} MergeTableSummary
 * @property {number} inserts
 * @property {number} updates
 * @property {number} unchanged
 * @property {number} conflicts
 * @property {number} keepOnline
 * @property {number} deletes
 * @property {number} deleteConflicts
 */

/**
 * @typedef {Object} MergePlan
 * @property {MergeRecordPlan[]} records
 * @property {Record<string, MergeTableSummary>} byTable
 * @property {MergeTableSummary} totals
 */

export const MERGE_ORDER = [
  'users',
  'groups',
  'group_members',
  'app_settings',
  'customers',
  'followups',
  'refunds',
  'ownership_transfers',
  'ownership_transfer_acks',
  'notifications',
  'notification_reads'
]

function emptySummary() {
  return {
    inserts: 0,
    updates: 0,
    unchanged: 0,
    conflicts: 0,
    keepOnline: 0,
    deletes: 0,
    deleteConflicts: 0
  }
}

/**
 * Shallow-stable JSON compare for conflict detection.
 * @param {Record<string, unknown>} a
 * @param {Record<string, unknown>} b
 */
export function rowsEquivalent(a, b) {
  if (!a || !b) return false
  return JSON.stringify(sortKeysDeep(a)) === JSON.stringify(sortKeysDeep(b))
}

/**
 * @param {unknown} value
 */
function sortKeysDeep(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  const obj = /** @type {Record<string, unknown>} */ (value)
  const out = {}
  for (const key of Object.keys(obj).sort()) {
    out[key] = sortKeysDeep(obj[key])
  }
  return out
}

/**
 * Compare ISO timestamps; returns positive if a > b.
 * @param {string|null|undefined} a
 * @param {string|null|undefined} b
 */
function compareIso(a, b) {
  if (!a && !b) return 0
  if (!a) return -1
  if (!b) return 1
  if (a > b) return 1
  if (a < b) return -1
  return 0
}

/**
 * Build merge plan: apply backup onto an online snapshot (in-memory).
 * @param {object} opts
 * @param {Record<string, Record<string, unknown>[]>} opts.onlineTables
 * @param {import('./backup-format.js').BackupManifest} opts.backupManifest
 * @param {Record<string, Record<string, unknown>[]>} opts.backupTables
 */
export function analyzeMerge({ onlineTables, backupManifest, backupTables }) {
  /** @type {MergeRecordPlan[]} */
  const records = []
  /** @type {Record<string, MergeTableSummary>} */
  const byTable = {}
  for (const table of BACKUP_TABLES) {
    byTable[table] = emptySummary()
  }

  const exportedAt = backupManifest.exportedAt || ''

  for (const table of MERGE_ORDER) {
    const onlineMap = indexRowsByKey(table, onlineTables[table] || [])
    const backupRows = backupTables[table] || []
    const summary = byTable[table]

    for (const backupRow of backupRows) {
      const key = recordKey(table, backupRow)
      if (!key) continue

      const onlineRow = onlineMap.get(key)
      if (!onlineRow) {
        records.push({ table, key, action: 'insert', backupRow })
        summary.inserts += 1
        continue
      }

      const backupAt = recordUpdatedAt(table, backupRow)
      const onlineAt = recordUpdatedAt(table, onlineRow)

      if (rowsEquivalent(backupRow, onlineRow)) {
        records.push({ table, key, action: 'unchanged', backupRow, onlineRow })
        summary.unchanged += 1
        continue
      }

      const cmp = compareIso(backupAt, onlineAt)
      if (cmp > 0) {
        records.push({ table, key, action: 'update', backupRow, onlineRow, reason: 'backup_newer' })
        summary.updates += 1
      } else if (cmp < 0) {
        records.push({ table, key, action: 'keep_online', backupRow, onlineRow, reason: 'online_newer' })
        summary.keepOnline += 1
      } else {
        records.push({ table, key, action: 'conflict', backupRow, onlineRow, reason: 'same_timestamp_diff_content' })
        summary.conflicts += 1
      }
    }

    const deletions = backupManifest.deletions?.[table] || []
    for (const rawId of deletions) {
      const key = String(rawId)
      const onlineRow = onlineMap.get(key)
      if (!onlineRow) continue

      const onlineAt = recordUpdatedAt(table, onlineRow)
      const cmp = compareIso(onlineAt, exportedAt)
      if (cmp <= 0) {
        records.push({ table, key, action: 'delete', onlineRow, reason: 'backup_deletion' })
        summary.deletes += 1
      } else {
        records.push({ table, key, action: 'delete_conflict', onlineRow, backupRow: onlineRow, reason: 'online_changed_after_export' })
        summary.deleteConflicts += 1
      }
    }
  }

  const totals = emptySummary()
  for (const table of BACKUP_TABLES) {
    const s = byTable[table]
    totals.inserts += s.inserts
    totals.updates += s.updates
    totals.unchanged += s.unchanged
    totals.conflicts += s.conflicts
    totals.keepOnline += s.keepOnline
    totals.deletes += s.deletes
    totals.deleteConflicts += s.deleteConflicts
  }

  return { records, byTable, totals }
}

/**
 * Apply merge plan to an in-memory snapshot (returns new tables object).
 * Conflicts and keep_online rows retain the online version unless overridden.
 * @param {Record<string, Record<string, unknown>[]>} onlineTables
 * @param {MergePlan} plan
 * @param {Record<string, 'backup'|'online'>} [conflictResolutions] per `table\0key`
 */
export function applyMergePlanToSnapshot(onlineTables, plan, conflictResolutions = {}) {
  /** @type {Record<string, Map<string, Record<string, unknown>>>} */
  const maps = {}
  for (const table of BACKUP_TABLES) {
    maps[table] = indexRowsByKey(table, (onlineTables[table] || []).map(r => ({ ...r })))
  }

  for (const item of plan.records) {
    const map = maps[item.table]
    if (!map) continue
    const resolutionKey = `${item.table}\0${item.key}`
    const resolution = conflictResolutions[resolutionKey]

    switch (item.action) {
      case 'insert':
      case 'update':
        if (item.backupRow) map.set(item.key, { ...item.backupRow })
        break
      case 'delete':
        map.delete(item.key)
        break
      case 'conflict':
        if (resolution === 'backup' && item.backupRow) {
          map.set(item.key, { ...item.backupRow })
        }
        break
      case 'unchanged':
      case 'keep_online':
      case 'delete_conflict':
        break
      default:
        break
    }
  }

  /** @type {Record<string, Record<string, unknown>[]>} */
  const out = {}
  for (const table of BACKUP_TABLES) {
    out[table] = Array.from(maps[table].values())
  }
  return out
}

/**
 * Human-readable Persian summary lines for UI (phase 2).
 * @param {MergePlan} plan
 */
export function summarizeMergePlan(plan) {
  const t = plan.totals
  const lines = [
    `${t.inserts} رکورد جدید`,
    `${t.updates} به‌روزرسانی`,
    `${t.unchanged} بدون تغییر`,
    `${t.conflicts} تعارض`,
    `${t.keepOnline} نگه‌داری نسخه آنلاین (جدیدتر)`,
    `${t.deletes} حذف`,
    `${t.deleteConflicts} تعارض حذف`
  ]
  return lines.filter(Boolean)
}

/**
 * List conflict records for resolution UI.
 * @param {MergePlan} plan
 */
export function listMergeConflicts(plan) {
  return plan.records.filter(r => r.action === 'conflict' || r.action === 'delete_conflict')
}
