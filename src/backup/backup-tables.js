import {
  CUSTOMER_DETAIL_SELECT,
  FOLLOWUP_SELECT,
  REFUND_SELECT,
  OWNERSHIP_TRANSFER_SELECT,
  OWNERSHIP_ACK_SELECT
} from './backup-selects.js'

/**
 * Per-table export metadata for full backup.
 * @type {Record<string, { select: string, orderCol: string, ascending?: boolean, primaryKey: string | string[] }>}
 */
export const BACKUP_TABLE_CONFIG = Object.freeze({
  customers: {
    select: CUSTOMER_DETAIL_SELECT,
    orderCol: 'id',
    ascending: true,
    primaryKey: 'id'
  },
  followups: {
    select: FOLLOWUP_SELECT,
    orderCol: 'id',
    ascending: true,
    primaryKey: 'id'
  },
  refunds: {
    select: REFUND_SELECT,
    orderCol: 'id',
    ascending: true,
    primaryKey: 'id'
  },
  ownership_transfers: {
    select: OWNERSHIP_TRANSFER_SELECT,
    orderCol: 'id',
    ascending: true,
    primaryKey: 'id'
  },
  ownership_transfer_acks: {
    select: OWNERSHIP_ACK_SELECT,
    orderCol: 'id',
    ascending: true,
    primaryKey: 'id'
  },
  users: {
    select: '*',
    orderCol: 'username',
    ascending: true,
    primaryKey: 'username'
  },
  groups: {
    select: '*',
    orderCol: 'name',
    ascending: true,
    primaryKey: 'id'
  },
  group_members: {
    select: '*',
    orderCol: 'group_id',
    ascending: true,
    primaryKey: ['group_id', 'user_phone']
  },
  app_settings: {
    select: 'key,value',
    orderCol: 'key',
    ascending: true,
    primaryKey: 'key'
  },
  notifications: {
    select: '*',
    orderCol: 'id',
    ascending: true,
    primaryKey: 'id'
  },
  notification_reads: {
    select: '*',
    orderCol: 'user_phone',
    ascending: true,
    primaryKey: ['user_phone', 'notification_id']
  },
  dm_conversations: {
    select: '*',
    orderCol: 'id',
    ascending: true,
    primaryKey: 'id'
  },
  dm_messages: {
    select: '*',
    orderCol: 'id',
    ascending: true,
    primaryKey: 'id'
  },
  dm_reads: {
    select: '*',
    orderCol: 'conversation_id',
    ascending: true,
    primaryKey: ['conversation_id', 'user_phone']
  },
  dm_members: {
    select: '*',
    orderCol: 'conversation_id',
    ascending: true,
    primaryKey: ['conversation_id', 'user_phone']
  },
  dm_pins: {
    select: '*',
    orderCol: 'id',
    ascending: true,
    primaryKey: 'id'
  },
  dm_chat_time_daily: {
    select: '*',
    orderCol: 'day',
    ascending: true,
    primaryKey: ['day', 'user_phone', 'conversation_id']
  }
})

/**
 * @param {string} table
 * @returns {{ select: string, orderCol: string, ascending: boolean, primaryKey: string | string[] }}
 */
export function getBackupTableConfig(table) {
  const cfg = BACKUP_TABLE_CONFIG[table]
  if (!cfg) throw new Error(`جدول پشتیبان‌گیری ناشناخته: ${table}`)
  return { ascending: true, ...cfg }
}

/**
 * Stable string id for merge/dedup.
 * @param {string} table
 * @param {Record<string, unknown>} row
 */
export function recordKey(table, row) {
  if (!row || typeof row !== 'object') return ''
  const cfg = BACKUP_TABLE_CONFIG[table]
  if (!cfg) return ''
  const pk = cfg.primaryKey
  if (Array.isArray(pk)) {
    return pk.map(k => String(row[k] ?? '')).join('\0')
  }
  return String(row[pk] ?? '')
}

/**
 * Best-effort updated_at for merge (falls back to created_at / seen_at / read_at).
 * @param {string} table
 * @param {Record<string, unknown>} row
 */
export function recordUpdatedAt(table, row) {
  if (!row || typeof row !== 'object') return null
  const candidates = ['updated_at', 'created_at', 'seen_at', 'read_at', 'last_read_at', 'last_message_at', 'requested_at', 'completed_at']
  for (const col of candidates) {
    const v = row[col]
    if (v) return String(v)
  }
  if (table === 'app_settings') return null
  return null
}

/**
 * Index rows by primary key for fast merge lookups.
 * @param {string} table
 * @param {Record<string, unknown>[]} rows
 */
export function indexRowsByKey(table, rows) {
  /** @type {Map<string, Record<string, unknown>>} */
  const map = new Map()
  for (const row of rows || []) {
    const key = recordKey(table, row)
    if (key) map.set(key, row)
  }
  return map
}
