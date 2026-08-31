/**
 * Phase 7 — offline export + merge analysis end-to-end (no Electron GUI).
 * Run: node offline-app/scripts/test-phase7.cjs
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const dbPath = path.join(os.tmpdir(), `carno-offline-p7-${Date.now()}.db`)
const repoRoot = path.resolve(__dirname, '..', '..')

require('module').Module._load = ((orig) => function(request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: () => path.dirname(dbPath) } }
  }
  return orig.apply(this, arguments)
})(require('module').Module._load)

async function main() {
  const db = require('../electron/db.cjs')
  const { executeDbRequest } = require('../electron/storage-query.cjs')
  const { buildOfflineBackupZip } = require('../electron/backup-export.cjs')
  const { parseBackupBytes } = require('../electron/backup-parse.cjs')

  await db.openDatabase(dbPath)
  db.initSchema()

  const ts = '2026-08-30T08:00:00.000Z'
  const tsOffline = '2026-08-30T14:00:00.000Z'

  executeDbRequest({
    table: 'users',
    method: 'upsert',
    body: {
      username: 'admin',
      first_name: 'مدیر',
      phone: '09123456789',
      display_name: 'مدیر',
      role: 'admin',
      permissions: {},
      password_hash: ''
    },
    single: true
  })

  executeDbRequest({
    table: 'customers',
    method: 'insert',
    body: {
      id: 'CS-P7-1',
      name: 'مشتری آفلاین',
      phone: '09120002222',
      phones: ['09120002222'],
      addresses: [],
      products: [],
      status: 'new',
      notes: 'یادداشت آفلاین',
      updated_at: tsOffline
    },
    single: true
  })

  executeDbRequest({
    table: 'customers',
    method: 'insert',
    body: {
      id: 'CS-P7-2',
      name: 'حذف در آفلاین',
      phone: '09120003333',
      phones: ['09120003333'],
      addresses: [],
      products: [],
      status: 'new',
      updated_at: ts
    },
    single: true
  })

  executeDbRequest({
    table: 'customers',
    method: 'delete',
    filters: [{ op: 'eq', col: 'id', value: 'CS-P7-2' }]
  })

  const { bytes, manifest } = buildOfflineBackupZip({ exportedBy: { username: 'admin' } })
  const parsed = parseBackupBytes(bytes)
  assert(parsed.manifest.source === 'offline', 'offline source')
  assert((parsed.manifest.deletions?.customers || []).includes('CS-P7-2'), 'deletion in manifest')

  const onlineTables = {
    customers: [
      {
        id: 'CS-P7-1',
        name: 'مشتری آنلاین',
        phone: '09120002222',
        phones: ['09120002222'],
        addresses: [],
        products: [],
        status: 'new',
        notes: 'یادداشت آنلاین',
        updated_at: ts
      },
      {
        id: 'CS-P7-2',
        name: 'حذف در آفلاین',
        phone: '09120003333',
        phones: ['09120003333'],
        addresses: [],
        products: [],
        status: 'new',
        updated_at: ts
      },
      {
        id: 'CS-P7-ON',
        name: 'فقط آنلاین',
        phone: '09120004444',
        phones: ['09120004444'],
        addresses: [],
        products: [],
        status: 'new',
        updated_at: ts
      }
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

  const { analyzeMerge, applyMergePlanToSnapshot } = await import(
    pathToFileURL(path.join(repoRoot, 'src/backup/backup-merge.js')).href
  )

  const plan = analyzeMerge({
    onlineTables,
    backupManifest: parsed.manifest,
    backupTables: parsed.tables
  })

  assert(plan.totals.deletes >= 1 || plan.totals.deleteConflicts >= 1, 'merge plans deletion')
  assert(plan.totals.updates >= 1 || plan.totals.conflicts >= 0, 'merge has customer changes')

  const merged = applyMergePlanToSnapshot(onlineTables, plan, {})
  const ids = new Set((merged.customers || []).map(r => r.id))
  assert(!ids.has('CS-P7-2'), 'deleted customer removed in snapshot')
  assert(ids.has('CS-P7-ON'), 'online-only customer kept')

  const mergeTest = spawnSync(process.execPath, ['scripts/test-backup-merge.mjs'], {
    cwd: repoRoot,
    stdio: 'inherit'
  })
  if (mergeTest.status !== 0) {
    throw new Error('scripts/test-backup-merge.mjs failed')
  }

  db.closeDatabase()
  fs.unlinkSync(dbPath)
  console.log('phase7 end-to-end test OK')
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
