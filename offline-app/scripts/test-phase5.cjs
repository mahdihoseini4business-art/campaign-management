/**
 * Smoke test for offline storage + auth (no Electron GUI).
 * Run: node offline-app/scripts/test-phase5.cjs
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { zipSync, strToU8 } = require('fflate')

const repoRoot = path.resolve(__dirname, '..', '..')
const dbPath = path.join(os.tmpdir(), `carno-offline-test-${Date.now()}.db`)

require('module').Module._load = ((orig) => function(request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: () => path.dirname(dbPath) } }
  }
  return orig.apply(this, arguments)
})(require('module').Module._load)

async function main() {
  const db = require('../electron/db.cjs')
  const storage = require('../electron/storage.cjs')
  const auth = require('../electron/auth-local.cjs')

  await db.openDatabase(dbPath)
  db.initSchema()

  const manifest = {
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    exportedBy: { username: 'admin' },
    source: 'online',
    tableCounts: { users: 1, customers: 1 },
    deletions: { customers: [], followups: [], refunds: [], ownership_transfers: [],
      ownership_transfer_acks: [], users: [], groups: [], group_members: [],
      app_settings: [], notifications: [], notification_reads: [] }
  }

  const tables = {
    users: [{
      username: 'admin',
      first_name: 'مدیر',
      last_name: 'سیستم',
      phone: '09123456789',
      display_name: 'مدیر سیستم',
      role: 'admin',
      permissions: {}
    }],
    customers: [{
      id: 'CS-001',
      platform_id: '1',
      platform: 'instagram',
      name: 'تست',
      phone: '09121111111',
      phones: ['09121111111'],
      addresses: [],
      status: 'new',
      notes: '',
      advisor: '',
      advisor_phone: '',
      next_followup_date: '',
      products: [],
      customer_level: '',
      customer_level_locked: false,
      referred_by_phone: '',
      customer_code: '',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }],
    followups: [], refunds: [], ownership_transfers: [], ownership_transfer_acks: [],
    groups: [], group_members: [], app_settings: [], notifications: [], notification_reads: []
  }

  for (const t of Object.keys(tables)) {
    if (!manifest.tableCounts[t]) manifest.tableCounts[t] = tables[t].length
  }

  const zipEntries = {
    'manifest.json': strToU8(JSON.stringify(manifest))
  }
  for (const [table, rows] of Object.entries(tables)) {
    zipEntries[`data/${table}.json`] = strToU8(JSON.stringify(rows))
  }
  const bytes = zipSync(zipEntries)

  const imported = storage.importBackupBytes(bytes, { replace: true })
  console.log('imported', imported.imported)

  await auth.setOfflinePassword('admin', '1234')
  const loginOk = await auth.login('admin', '1234')
  console.log('login', loginOk.ok, loginOk.user?.username)

  const bad = await auth.login('admin', 'wrong')
  console.log('bad login blocked', !bad.ok)

  const all = storage.fetchAllTables()
  console.log('customers', all.customers.length, 'users', all.users.length)

  db.closeDatabase()
  fs.unlinkSync(dbPath)
  console.log('phase5 smoke test OK')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
