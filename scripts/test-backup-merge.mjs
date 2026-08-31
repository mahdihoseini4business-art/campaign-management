/**
 * Phase 7 — merge engine smoke tests (no Supabase/network).
 * Run: node scripts/test-backup-merge.mjs
 */
import {
  analyzeMerge,
  applyMergePlanToSnapshot,
  mergeCustomerNotes,
  tryAutoMergeCustomerRow,
  listMergeConflicts,
  rowsEquivalent
} from '../src/backup/backup-merge.js'
import { createManifest } from '../src/backup/backup-format.js'
import { buildBackupZip, parseBackupZip } from '../src/backup/backup-zip.js'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const ts = '2026-08-31T10:00:00.000Z'
const tsNewer = '2026-08-31T12:00:00.000Z'

// --- unit: notes append ---
{
  const merged = mergeCustomerNotes('یادداشت آنلاین', 'یادداشت آفلاین')
  assert(merged.includes('یادداشت آنلاین') && merged.includes('یادداشت آفلاین'), 'notes append')
  assert(mergeCustomerNotes('abc', 'abc') === 'abc', 'identical notes')
}

// --- unit: auto-merge customer ---
{
  const online = { id: 'C1', name: 'علی', notes: 'آنلاین', updated_at: ts }
  const backup = { id: 'C1', name: 'علی', notes: 'آفلاین', updated_at: ts }
  const merged = tryAutoMergeCustomerRow(online, backup)
  assert(merged && merged.notes.includes('آنلاین') && merged.notes.includes('آفلاین'), 'auto merge customer')
}

// --- LWW: backup newer → update ---
{
  const manifest = createManifest({ source: 'offline', exportedAt: tsNewer })
  const onlineTables = {
    customers: [{ id: 'C2', name: 'قدیمی', updated_at: ts }],
    followups: [],
    refunds: [],
    ownership_transfers: [],
    ownership_transfer_acks: [],
    users: [],
    groups: [],
    group_members: [],
    app_settings: [],
    notifications: [],
    notification_reads: []
  }
  const backupTables = {
    ...onlineTables,
    customers: [{ id: 'C2', name: 'جدید', updated_at: tsNewer }]
  }
  const plan = analyzeMerge({ onlineTables, backupManifest: manifest, backupTables })
  assert(plan.totals.updates === 1, 'backup newer → update')
}

// --- LWW: online newer → keep ---
{
  const manifest = createManifest({ source: 'offline', exportedAt: ts })
  const onlineTables = {
    customers: [{ id: 'C3', name: 'آنلاین', updated_at: tsNewer }],
    followups: [],
    refunds: [],
    ownership_transfers: [],
    ownership_transfer_acks: [],
    users: [],
    groups: [],
    group_members: [],
    app_settings: [],
    notifications: [],
    notification_reads: []
  }
  const backupTables = {
    ...onlineTables,
    customers: [{ id: 'C3', name: 'بکاپ', updated_at: ts }]
  }
  const plan = analyzeMerge({ onlineTables, backupManifest: manifest, backupTables })
  assert(plan.totals.keepOnline === 1, 'online newer → keep')
}

// --- insert-only: notifications ---
{
  const manifest = createManifest({ source: 'offline', exportedAt: tsNewer })
  const onlineTables = {
    customers: [],
    followups: [],
    refunds: [],
    ownership_transfers: [],
    ownership_transfer_acks: [],
    users: [],
    groups: [],
    group_members: [],
    app_settings: [],
    notifications: [{ id: 1, title: 'آنلاین', created_at: ts }],
    notification_reads: []
  }
  const backupTables = {
    ...onlineTables,
    notifications: [{ id: 1, title: 'بکاپ', created_at: tsNewer }]
  }
  const plan = analyzeMerge({ onlineTables, backupManifest: manifest, backupTables })
  assert(plan.totals.unchanged === 1 && plan.totals.updates === 0, 'notifications insert-only')
}

// --- deletion from backup ---
{
  const manifest = createManifest({
    source: 'offline',
    exportedAt: tsNewer,
    deletions: { customers: ['C-DEL'] }
  })
  const onlineTables = {
    customers: [{ id: 'C-DEL', name: 'حذف‌شونده', updated_at: ts }],
    followups: [],
    refunds: [],
    ownership_transfers: [],
    ownership_transfer_acks: [],
    users: [],
    groups: [],
    group_members: [],
    app_settings: [],
    notifications: [],
    notification_reads: []
  }
  const backupTables = { ...onlineTables, customers: [] }
  const plan = analyzeMerge({ onlineTables, backupManifest: manifest, backupTables })
  assert(plan.totals.deletes === 1, 'backup deletion applied')
}

// --- delete conflict ---
{
  const manifest = createManifest({
    source: 'offline',
    exportedAt: ts,
    deletions: { customers: ['C-DC'] }
  })
  const onlineTables = {
    customers: [{ id: 'C-DC', name: 'تغییر بعد export', updated_at: tsNewer }],
    followups: [],
    refunds: [],
    ownership_transfers: [],
    ownership_transfer_acks: [],
    users: [],
    groups: [],
    group_members: [],
    app_settings: [],
    notifications: [],
    notification_reads: []
  }
  const backupTables = { ...onlineTables, customers: [] }
  const plan = analyzeMerge({ onlineTables, backupManifest: manifest, backupTables })
  assert(plan.totals.deleteConflicts === 1, 'delete conflict detected')
  const conflicts = listMergeConflicts(plan)
  assert(conflicts.length === 1, 'delete conflict listed')
}

// --- end-to-end: apply snapshot after conflict resolution ---
{
  const manifest = createManifest({ source: 'offline', exportedAt: ts })
  const onlineTables = {
    customers: [
      { id: 'C-CONF', name: 'آنلاین', notes: '', updated_at: ts },
      { id: 'C-NEW', name: 'فقط آنلاین', updated_at: ts }
    ],
    followups: [],
    refunds: [],
    ownership_transfers: [],
    ownership_transfer_acks: [],
    users: [],
    groups: [],
    group_members: [],
    app_settings: [],
    notifications: [],
    notification_reads: []
  }
  const backupTables = {
    ...onlineTables,
    customers: [
      { id: 'C-CONF', name: 'بکاپ', notes: '', updated_at: ts },
      { id: 'C-OFF', name: 'فقط آفلاین', updated_at: tsNewer }
    ]
  }
  const plan = analyzeMerge({ onlineTables, backupManifest: manifest, backupTables })
  assert(plan.totals.conflicts === 1, 'edit conflict')
  assert(plan.totals.inserts === 1, 'offline-only insert')

  const resolutions = { 'customers\0C-CONF': 'backup' }
  const merged = applyMergePlanToSnapshot(onlineTables, plan, resolutions)
  const byId = Object.fromEntries((merged.customers || []).map(r => [r.id, r]))
  assert(byId['C-CONF']?.name === 'بکاپ', 'conflict resolved to backup')
  assert(byId['C-OFF']?.name === 'فقط آفلاین', 'offline insert kept')
  assert(byId['C-NEW']?.name === 'فقط آنلاین', 'online-only kept')
}

// --- round-trip: buildBackupZip → parseBackupZip ---
{
  const manifest = createManifest({ source: 'offline', exportedAt: ts })
  const tables = {
    customers: [{ id: 'RT1', name: 'تست', updated_at: ts }],
    followups: [],
    refunds: [],
    ownership_transfers: [],
    ownership_transfer_acks: [],
    users: [],
    groups: [],
    group_members: [],
    app_settings: [],
    notifications: [],
    notification_reads: []
  }
  const bytes = buildBackupZip(manifest, tables)
  const parsed = parseBackupZip(bytes)
  assert(parsed.manifest.source === 'offline', 'zip round-trip manifest')
  assert(parsed.tables.customers[0].id === 'RT1', 'zip round-trip data')
  assert(rowsEquivalent(parsed.tables.customers[0], tables.customers[0]), 'zip row equivalent')
}

console.log('backup merge tests OK')
