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
  'notification_reads',
  'dm_conversations',
  'dm_members',
  'dm_messages',
  'dm_reads',
  'dm_pins',
  'dm_chat_time_daily'
]

/** Tables where existing online rows are never overwritten by backup. */
const INSERT_ONLY_TABLES = new Set(['notifications', 'notification_reads', 'dm_messages', 'dm_reads', 'dm_chat_time_daily'])

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
 * Append customer notes when both sides changed independently.
 * @param {unknown} onlineNotes
 * @param {unknown} backupNotes
 */
export function mergeCustomerNotes(onlineNotes, backupNotes) {
  const a = String(onlineNotes || '').trim()
  const b = String(backupNotes || '').trim()
  if (!a) return b
  if (!b) return a
  if (a === b) return a
  if (a.includes(b)) return a
  if (b.includes(a)) return b
  return `${a}\n---\n${b}`
}

/**
 * Auto-merge customer row when only notes differ (or notes can be appended).
 * @param {Record<string, unknown>} onlineRow
 * @param {Record<string, unknown>} backupRow
 * @returns {Record<string, unknown> | null}
 */
export function tryAutoMergeCustomerRow(onlineRow, backupRow) {
  const mergedNotes = mergeCustomerNotes(onlineRow.notes, backupRow.notes)
  const mergedRow = { ...backupRow, notes: mergedNotes }
  const onlineNormalized = { ...onlineRow, notes: mergedNotes }
  if (rowsEquivalent(onlineNormalized, mergedRow)) {
    return mergedRow
  }
  return null
}

/**
 * Field-level diff for conflict UI.
 * @param {Record<string, unknown>} [onlineRow]
 * @param {Record<string, unknown>} [backupRow]
 * @param {number} [maxFields]
 */
export function diffRowFields(onlineRow, backupRow, maxFields = 16) {
  /** @type {{ field: string, online: unknown, backup: unknown }[]} */
  const diffs = []
  const keys = new Set([
    ...Object.keys(onlineRow || {}),
    ...Object.keys(backupRow || {})
  ])
  for (const field of [...keys].sort()) {
    const onlineVal = onlineRow?.[field]
    const backupVal = backupRow?.[field]
    if (JSON.stringify(sortKeysDeep(onlineVal)) === JSON.stringify(sortKeysDeep(backupVal))) continue
    diffs.push({ field, online: onlineVal, backup: backupVal })
    if (diffs.length >= maxFields) break
  }
  return diffs
}

/**
 * Format a value for compact conflict preview.
 * @param {unknown} value
 * @param {number} [maxLen]
 */
export function formatDiffValue(value, maxLen = 120) {
  if (value == null || value === '') return '—'
  let text
  if (typeof value === 'object') {
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
  } else {
    text = String(value)
  }
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen)}…`
}

function recordInsertOnlyMatch(table, key, backupRow, onlineRow, records, summary) {
  records.push({
    table,
    key,
    action: 'unchanged',
    backupRow,
    onlineRow,
    reason: 'insert_only_table'
  })
  summary.unchanged += 1
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

      if (INSERT_ONLY_TABLES.has(table)) {
        recordInsertOnlyMatch(table, key, backupRow, onlineRow, records, summary)
        continue
      }

      const cmp = compareIso(backupAt, onlineAt)
      if (cmp > 0) {
        records.push({ table, key, action: 'update', backupRow, onlineRow, reason: 'backup_newer' })
        summary.updates += 1
      } else if (cmp < 0) {
        records.push({ table, key, action: 'keep_online', backupRow, onlineRow, reason: 'online_newer' })
        summary.keepOnline += 1
      } else if (table === 'customers') {
        const mergedRow = tryAutoMergeCustomerRow(onlineRow, backupRow)
        if (mergedRow) {
          records.push({
            table,
            key,
            action: 'update',
            backupRow: mergedRow,
            onlineRow,
            reason: 'notes_append'
          })
          summary.updates += 1
        } else {
          records.push({
            table,
            key,
            action: 'conflict',
            backupRow,
            onlineRow,
            reason: 'same_timestamp_diff_content'
          })
          summary.conflicts += 1
        }
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
        break
      case 'delete_conflict':
        if (resolution === 'backup') {
          map.delete(item.key)
        }
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
