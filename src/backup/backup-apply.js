import { supabase } from '../supabase.js'
import { BACKUP_TABLE_CONFIG } from './backup-tables.js'
import { MERGE_ORDER } from './backup-merge.js'
import { sanitizeTableForBackup } from './backup-format.js'

const UPSERT_CHUNK = 150

/** @type {Record<string, string>} */
const UPSERT_ON_CONFLICT = {
  users: 'username',
  groups: 'id',
  group_members: 'group_id,user_phone',
  app_settings: 'key',
  customers: 'id',
  followups: 'id',
  refunds: 'id',
  ownership_transfers: 'id',
  ownership_transfer_acks: 'id',
  notifications: 'id',
  notification_reads: 'user_phone,notification_id'
}

const DELETE_ORDER = [...MERGE_ORDER].reverse()

/**
 * @param {import('./backup-merge.js').MergePlan} plan
 * @param {Record<string, 'backup'|'online'>} [conflictResolutions]
 * @param {(info: { phase: string, done: number, total: number, detail?: string }) => void} [onProgress]
 */
export async function applyMergePlanToSupabase(plan, conflictResolutions = {}, onProgress) {
  const items = collectApplicableItems(plan, conflictResolutions)
  const deletes = items.filter(i => i.action === 'delete')
  const writes = items.filter(i => i.action === 'insert' || i.action === 'update')

  const totalSteps = deletes.length + writes.length
  if (!totalSteps) return { appliedDeletes: 0, appliedWrites: 0 }

  let done = 0
  const tick = (phase, detail) => {
    done += 1
    onProgress?.({ phase, done, total: totalSteps, detail })
  }

  for (const table of DELETE_ORDER) {
    const tableDeletes = deletes.filter(d => d.table === table)
    for (const item of tableDeletes) {
      const { error } = await deleteBackupRow(table, item.key, item.onlineRow)
      if (error) throw new Error(`حذف ${tableLabel(table)} (${item.key}): ${error.message}`)
      tick('delete', table)
    }
  }

  for (const table of MERGE_ORDER) {
    const rows = writes
      .filter(w => w.table === table && w.backupRow)
      .map(w => w.backupRow)
    if (!rows.length) continue

    const sanitized = sanitizeTableForBackup(table, rows)
    await upsertRowsBatched(table, sanitized, (detail) => tick('upsert', detail))
  }

  return { appliedDeletes: deletes.length, appliedWrites: writes.length }
}

/**
 * @param {import('./backup-merge.js').MergePlan} plan
 * @param {Record<string, 'backup'|'online'>} conflictResolutions
 */
function collectApplicableItems(plan, conflictResolutions) {
  /** @type {import('./backup-merge.js').MergeRecordPlan[]} */
  const out = []

  for (const item of plan.records) {
    const resKey = `${item.table}\0${item.key}`

    switch (item.action) {
      case 'unchanged':
      case 'keep_online':
        break
      case 'conflict':
        if (conflictResolutions[resKey] === 'backup' && item.backupRow) {
          out.push({ ...item, action: 'update' })
        }
        break
      case 'delete_conflict':
        if (conflictResolutions[resKey] === 'backup') {
          out.push({ ...item, action: 'delete' })
        }
        break
      default:
        out.push(item)
        break
    }
  }

  return out
}

/**
 * @param {string} table
 * @param {Record<string, unknown>[]} rows
 * @param {(detail: string) => void} [onChunk]
 */
async function upsertRowsBatched(table, rows, onChunk) {
  const onConflict = UPSERT_ON_CONFLICT[table]
  if (!onConflict) throw new Error(`upsert برای جدول ${table} پشتیبانی نمی‌شود`)

  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK)
    const { error } = await supabase.from(table).upsert(chunk, { onConflict })
    if (error) throw new Error(`ذخیره ${tableLabel(table)}: ${error.message}`)
    onChunk?.(table)
  }
}

/**
 * @param {string} table
 * @param {string} key
 * @param {Record<string, unknown>} [row]
 */
async function deleteBackupRow(table, key, row) {
  if (table === 'group_members') {
    const parts = key.split('\0')
    const groupId = parts[0] || row?.group_id
    const phone = parts[1] || row?.user_phone
    return supabase.from(table).delete().eq('group_id', groupId).eq('user_phone', phone)
  }

  if (table === 'notification_reads') {
    const parts = key.split('\0')
    const phone = parts[0] || row?.user_phone
    const notifId = parts[1] ?? row?.notification_id
    const nid = /^\d+$/.test(String(notifId)) ? Number(notifId) : notifId
    return supabase.from(table).delete().eq('user_phone', phone).eq('notification_id', nid)
  }

  const cfg = BACKUP_TABLE_CONFIG[table]
  const pk = cfg?.primaryKey
  if (!pk || Array.isArray(pk)) {
    return { error: { message: 'کلید حذف نامشخص' } }
  }

  let value = key
  if (pk === 'id' && /^\d+$/.test(key)) value = Number(key)

  return supabase.from(table).delete().eq(pk, value)
}

function tableLabel(table) {
  const labels = {
    customers: 'مشتریان',
    followups: 'پیگیری‌ها',
    refunds: 'عودت‌ها',
    ownership_transfers: 'انتقال‌ها',
    ownership_transfer_acks: 'تأیید انتقال',
    users: 'کاربران',
    groups: 'گروه‌ها',
    group_members: 'اعضای گروه',
    app_settings: 'تنظیمات',
    notifications: 'اعلان‌ها',
    notification_reads: 'خوانده‌شدن اعلان'
  }
  return labels[table] || table
}
