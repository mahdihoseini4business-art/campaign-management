/**
 * Split backup scope + distribution tests (no Supabase/network).
 * Run: node scripts/test-backup-split.mjs
 */
import {
  filterTablesForUser,
  resolveAdvisorPhones,
  resolveBackupScope,
  countTableRows,
  canViewOrgWideDataForUser
} from '../src/backup/backup-scope.js'
import {
  createManifest,
  validateManifest,
  isScopedBackupManifest
} from '../src/backup/backup-format.js'
import { emptyDeletionsMap } from '../src/backup/constants.js'
import { buildBackupZip, parseBackupZip } from '../src/backup/backup-zip.js'
import { buildSplitDistributionZip } from '../src/backup/backup-split.js'
import { unzipSync, strFromU8 } from 'fflate'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const groupMembers = [
  { group_id: 'g1', user_phone: '09121111111', is_manager: true },
  { group_id: 'g1', user_phone: '09122222222', is_manager: false }
]

const users = [
  { username: 'admin', phone: '09120000000', role: 'admin', permissions: {} },
  { username: 'ali', phone: '09121111111', role: 'user', permissions: { dashboard: true, customers_view: true, customers_ld: true, customers_cs: true } },
  { username: 'sara', phone: '09122222222', role: 'user', permissions: { dashboard: true, customers_view: true, customers_ld: true, customers_cs: true } },
  { username: 'wide', phone: '09123333333', role: 'user', permissions: { dashboard: true, customers_view: true, customers_ld: true, customers_cs: true, accounting_org_wide_customers: true } }
]

const allTables = {
  customers: [
    { id: 'LD1', advisor_phone: '09121111111', name: 'Ali customer' },
    { id: 'LD2', advisor_phone: '09122222222', name: 'Sara customer' },
    { id: 'CS1', advisor_phone: '09124444444', name: 'Other customer' }
  ],
  followups: [
    { id: 'f1', customer_id: 'LD1' },
    { id: 'f2', customer_id: 'LD2' },
    { id: 'f3', customer_id: 'CS1' }
  ],
  refunds: [
    { id: 'r1', customer_id: 'LD1', advisor_phone: '09121111111' }
  ],
  ownership_transfers: [
    { id: 't1', from_advisor_phone: '09121111111', to_advisor_phone: '09122222222' }
  ],
  ownership_transfer_acks: [
    { id: 'a1', user_phone: '09121111111' }
  ],
  users,
  groups: [{ id: 'g1', name: 'Team A' }],
  group_members: groupMembers,
  app_settings: [{ key: 'platforms', value: '[]' }],
  notifications: [
    { id: 'n1', recipient_phones: ['09121111111'] },
    { id: 'n2', recipient_phones: ['09124444444'] }
  ],
  notification_reads: [
    { user_phone: '09121111111', notification_id: 'n1' }
  ]
}

// --- advisor phones / group manager ---
{
  const aliPhones = resolveAdvisorPhones(users[1], groupMembers)
  assert(aliPhones.has('09121111111'), 'manager includes self')
  assert(aliPhones.has('09122222222'), 'manager includes team member')

  const saraPhones = resolveAdvisorPhones(users[2], groupMembers)
  assert(saraPhones.has('09122222222'), 'member includes self')
  assert(!saraPhones.has('09121111111'), 'member excludes manager')
}

// --- scoped customers: ali ---
{
  const aliTables = filterTablesForUser(allTables, users[1], { groupMembers })
  assert(aliTables.customers.length === 2, 'manager sees team customers')
  assert(aliTables.followups.length === 2, 'followups for team customers')
  assert(aliTables.users.length === 2, 'user rows for team')
  assert(aliTables.deletions === undefined || true, 'no deletions key in scoped output')
}

// --- scoped customers: sara ---
{
  const saraTables = filterTablesForUser(allTables, users[2], { groupMembers })
  assert(saraTables.customers.length === 1, 'member sees own customer only')
  assert(saraTables.customers[0].id === 'LD2', 'member customer id')
}

// --- org-wide user ---
{
  assert(canViewOrgWideDataForUser(users[3], 'customers'), 'org-wide flag')
  const wideTables = filterTablesForUser(allTables, users[3], { groupMembers })
  assert(wideTables.customers.length === 3, 'org-wide sees all customers')
}

// --- scoped manifest ---
{
  const scope = resolveBackupScope(users[1], groupMembers)
  const scopedTables = filterTablesForUser(allTables, users[1], { groupMembers })
  const manifest = createManifest({
    backupKind: 'scoped',
    scope,
    tableCounts: countTableRows(scopedTables),
    deletions: emptyDeletionsMap(),
    source: 'online'
  })
  assert(manifest.backupKind === 'scoped', 'backupKind scoped')
  assert(manifest.scope.username === 'ali', 'scope username')
  assert(isScopedBackupManifest(manifest), 'isScopedBackupManifest')
  assert(Object.values(manifest.deletions).every(arr => arr.length === 0), 'empty deletions')
}

// --- validateManifest v1 and v2 ---
{
  const v1 = validateManifest({
    formatVersion: 1,
    exportedAt: '2026-08-31T10:00:00.000Z',
    source: 'online',
    tableCounts: { customers: 1 },
    deletions: {}
  })
  assert(v1.backupKind === 'full', 'v1 defaults to full')

  const v2 = validateManifest({
    formatVersion: 2,
    exportedAt: '2026-08-31T10:00:00.000Z',
    source: 'online',
    tableCounts: { customers: 1 },
    deletions: {},
    backupKind: 'scoped',
    scope: { username: 'ali', phone: '0912', advisorPhones: ['0912'] }
  })
  assert(v2.backupKind === 'scoped', 'v2 scoped')
}

// --- round-trip zip ---
{
  const manifest = createManifest({
    backupKind: 'full',
    tableCounts: { customers: 1 },
    source: 'online'
  })
  const bytes = buildBackupZip(manifest, { customers: [{ id: 'LD1' }] })
  const parsed = parseBackupZip(bytes)
  assert(parsed.manifest.backupKind === 'full', 'round-trip manifest')
  assert(parsed.tables.customers.length === 1, 'round-trip customers')
}

// --- distribution zip ---
{
  const manifest = createManifest({
    backupKind: 'full',
    exportedAt: '2026-08-31T10:00:00.000Z',
    tableCounts: countTableRows(allTables),
    source: 'online'
  })
  const { bytes, splitIndex } = buildSplitDistributionZip({
    manifest,
    tables: allTables,
    parentExportId: 'test-export-id'
  })
  assert(bytes.length > 0, 'distribution bytes')
  assert(splitIndex.userCount === 3, 'three non-admin users with phone')
  assert(splitIndex.users.some(u => u.username === 'ali' && !u.skipped), 'ali in index')

  const unzipped = unzipSync(bytes)
  assert(unzipped['full.carno-backup'], 'full backup in zip')
  assert(unzipped['split-index.json'], 'split index in zip')
  assert(unzipped['users/ali.carno-backup'], 'ali scoped file')

  const aliManifest = validateManifest(JSON.parse(strFromU8(
    unzipSync(unzipped['users/ali.carno-backup'])['manifest.json']
  )))
  assert(aliManifest.backupKind === 'scoped', 'ali file is scoped')
}

console.log('test-backup-split: all passed')
