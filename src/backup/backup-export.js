import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'
import {
  BACKUP_MANIFEST_PATH,
  BACKUP_TABLES
} from './constants.js'
import {
  createManifest,
  validateManifest,
  tableDataPath,
  sanitizeTableForBackup,
  suggestBackupFilename,
  BackupFormatError
} from './backup-format.js'
import { BACKUP_TABLE_CONFIG } from './backup-tables.js'
import { fetchAllRows, fetchAllRowsWithFallback, fetchAppSettings } from './supabase-fetch.js'
import {
  CUSTOMER_DETAIL_SELECT,
  FOLLOWUP_SELECT,
  REFUND_SELECT,
  OWNERSHIP_TRANSFER_SELECT
} from '../data.js'

/**
 * @typedef {import('./backup-format.js').BackupManifest} BackupManifest
 */

/**
 * Load all business tables from Supabase for a full backup.
 * @param {object} [opts]
 * @param {import('./backup-format.js').BackupExportedBy} [opts.exportedBy]
 * @param {'online'|'offline'} [opts.source]
 * @param {Record<string, string[]>} [opts.deletions]
 * @param {(info: { table: string, done: number, total: number }) => void} [opts.onProgress]
 * @returns {Promise<{ manifest: BackupManifest, tables: Record<string, Record<string, unknown>[]> }>}
 */
export async function collectFullBackupFromSupabase(opts = {}) {
  /** @type {Record<string, Record<string, unknown>[]>} */
  const tables = {}
  const total = BACKUP_TABLES.length
  let done = 0

  const report = (table) => {
    done += 1
    opts.onProgress?.({ table, done, total })
  }

  const customersRes = await fetchAllRowsWithFallback(
    'customers',
    CUSTOMER_DETAIL_SELECT,
    'id',
    [/,?updated_at/, /,?customer_code/]
  )
  if (customersRes.error) throw new Error('مشتریان: ' + customersRes.error.message)
  tables.customers = customersRes.data
  report('customers')

  const followupsRes = await fetchAllRowsWithFallback(
    'followups',
    FOLLOWUP_SELECT,
    'id',
    [/,?updated_at/]
  )
  if (followupsRes.error) throw new Error('پیگیری‌ها: ' + followupsRes.error.message)
  tables.followups = followupsRes.data
  report('followups')

  const refundsRes = await fetchAllRowsWithFallback(
    'refunds',
    REFUND_SELECT,
    'id',
    [/,?updated_at/, /,?archived_at/]
  )
  if (refundsRes.error) throw new Error('عودت‌ها: ' + refundsRes.error.message)
  tables.refunds = refundsRes.data
  report('refunds')

  const transfersRes = await fetchAllRowsWithFallback(
    'ownership_transfers',
    OWNERSHIP_TRANSFER_SELECT,
    'id',
    [/,?updated_at/]
  )
  if (transfersRes.error && !/ownership_transfers|does not exist|relation/i.test(transfersRes.error.message || '')) {
    throw new Error('انتقال‌ها: ' + transfersRes.error.message)
  }
  tables.ownership_transfers = transfersRes.error ? [] : transfersRes.data
  report('ownership_transfers')

  const acksRes = await fetchAllRowsWithFallback(
    'ownership_transfer_acks',
    BACKUP_TABLE_CONFIG.ownership_transfer_acks.select,
    'id',
    [/,?updated_at/]
  )
  if (acksRes.error && !/ownership_transfer_acks|does not exist|relation/i.test(acksRes.error.message || '')) {
    throw new Error('تأیید انتقال‌ها: ' + acksRes.error.message)
  }
  tables.ownership_transfer_acks = acksRes.error ? [] : acksRes.data
  report('ownership_transfer_acks')

  const usersRes = await fetchAllRows('users', {
    select: BACKUP_TABLE_CONFIG.users.select,
    orderCol: 'username'
  })
  if (usersRes.error) throw new Error('کاربران: ' + usersRes.error.message)
  tables.users = sanitizeTableForBackup('users', usersRes.data)
  report('users')

  const groupsRes = await fetchAllRows('groups', {
    select: BACKUP_TABLE_CONFIG.groups.select,
    orderCol: 'name'
  })
  if (groupsRes.error && !/groups|does not exist|relation/i.test(groupsRes.error.message || '')) {
    throw new Error('گروه‌ها: ' + groupsRes.error.message)
  }
  tables.groups = groupsRes.error ? [] : groupsRes.data
  report('groups')

  const membersRes = await fetchAllRows('group_members', {
    select: BACKUP_TABLE_CONFIG.group_members.select,
    orderCol: 'group_id'
  })
  if (membersRes.error && !/group_members|does not exist|relation/i.test(membersRes.error.message || '')) {
    throw new Error('اعضای گروه: ' + membersRes.error.message)
  }
  tables.group_members = membersRes.error ? [] : membersRes.data
  report('group_members')

  const settingsRes = await fetchAppSettings()
  if (settingsRes.error) throw new Error('تنظیمات: ' + settingsRes.error.message)
  tables.app_settings = settingsRes.data
  report('app_settings')

  const notifRes = await fetchAllRows('notifications', {
    select: BACKUP_TABLE_CONFIG.notifications.select,
    orderCol: 'id'
  })
  if (notifRes.error && !/notifications|does not exist|relation/i.test(notifRes.error.message || '')) {
    throw new Error('اعلان‌ها: ' + notifRes.error.message)
  }
  tables.notifications = notifRes.error ? [] : notifRes.data
  report('notifications')

  const readsRes = await fetchAllRows('notification_reads', {
    select: BACKUP_TABLE_CONFIG.notification_reads.select,
    orderCol: 'user_phone'
  })
  if (readsRes.error && !/notification_reads|does not exist|relation/i.test(readsRes.error.message || '')) {
    throw new Error('خوانده‌شدن اعلان‌ها: ' + readsRes.error.message)
  }
  tables.notification_reads = readsRes.error ? [] : readsRes.data
  report('notification_reads')

  /** @type {Record<string, number>} */
  const tableCounts = {}
  for (const table of BACKUP_TABLES) {
    tableCounts[table] = (tables[table] || []).length
  }

  const manifest = createManifest({
    exportedBy: opts.exportedBy,
    source: opts.source || 'online',
    deletions: opts.deletions,
    tableCounts
  })

  return { manifest, tables }
}

/**
 * Build a `.carno-backup` ZIP from manifest + table payloads.
 * @param {BackupManifest} manifest
 * @param {Record<string, Record<string, unknown>[]>} tables
 * @returns {Uint8Array}
 */
export function buildBackupZip(manifest, tables) {
  /** @type {Record<string, Uint8Array>} */
  const files = {}

  files[BACKUP_MANIFEST_PATH] = strToU8(JSON.stringify(manifest))

  for (const table of BACKUP_TABLES) {
    const rows = sanitizeTableForBackup(table, tables[table] || [])
    files[tableDataPath(table)] = strToU8(JSON.stringify(rows))
  }

  return zipSync(files, { level: 6 })
}

/**
 * @param {BackupManifest} manifest
 * @param {Record<string, Record<string, unknown>[]>} tables
 * @returns {{ bytes: Uint8Array, filename: string }}
 */
export function packFullBackup(manifest, tables) {
  const validated = validateManifest(manifest)
  const bytes = buildBackupZip(validated, tables)
  return {
    bytes,
    filename: suggestBackupFilename(validated)
  }
}

/**
 * Export full backup from Supabase and return ZIP bytes + filename.
 * @param {object} [opts] same as collectFullBackupFromSupabase
 */
export async function exportFullBackupFromSupabase(opts = {}) {
  const { manifest, tables } = await collectFullBackupFromSupabase(opts)
  return packFullBackup(manifest, tables)
}

/**
 * Trigger browser download of backup ZIP.
 * @param {Uint8Array} bytes
 * @param {string} filename
 */
export function downloadBackupFile(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.endsWith('.carno-backup') ? filename : `${filename}.carno-backup`
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

/**
 * Parse in-memory backup (for tests or restore preview).
 * @param {Uint8Array} bytes
 * @returns {{ manifest: BackupManifest, tables: Record<string, Record<string, unknown>[]> }}
 */
export function parseBackupZip(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new BackupFormatError('فایل پشتیبان خالی است.')
  }

  let unzipped
  try {
    unzipped = unzipSync(bytes)
  } catch {
    throw new BackupFormatError('فایل ZIP نامعتبر است.')
  }

  const manifestRaw = unzipped[BACKUP_MANIFEST_PATH]
  if (!manifestRaw) {
    throw new BackupFormatError('manifest.json در فایل پشتیبان یافت نشد.')
  }

  let manifest
  try {
    manifest = validateManifest(JSON.parse(strFromU8(manifestRaw)))
  } catch (e) {
    if (e instanceof BackupFormatError) throw e
    throw new BackupFormatError('manifest.json قابل خواندن نیست.')
  }

  /** @type {Record<string, Record<string, unknown>[]>} */
  const tables = {}
  for (const table of BACKUP_TABLES) {
    const path = tableDataPath(table)
    const raw = unzipped[path]
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
      throw new BackupFormatError(`فایل ${path} قابل خواندن نیست.`)
    }
  }

  return { manifest, tables }
}

/**
 * @param {File|Blob} file
 */
export async function parseBackupFile(file) {
  const buf = await file.arrayBuffer()
  return parseBackupZip(new Uint8Array(buf))
}
