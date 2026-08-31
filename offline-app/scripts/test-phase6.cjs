/**
 * Phase 6 smoke test: storage-query CRUD + backup export bytes.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const dbPath = path.join(os.tmpdir(), `carno-offline-p6-${Date.now()}.db`)

require('module').Module._load = ((orig) => function(request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: () => path.dirname(dbPath) } }
  }
  return orig.apply(this, arguments)
})(require('module').Module._load)

async function main() {
  const db = require('../electron/db.cjs')
  const storage = require('../electron/storage.cjs')
  const { executeDbRequest } = require('../electron/storage-query.cjs')
  const { buildOfflineBackupZip } = require('../electron/backup-export.cjs')
  const { parseBackupBytes } = require('../electron/backup-parse.cjs')

  await db.openDatabase(dbPath)
  db.initSchema()

  // seed user
  executeDbRequest({
    table: 'users',
    method: 'upsert',
    body: {
      username: 'admin',
      first_name: 'مدیر',
      last_name: '',
      phone: '09123456789',
      display_name: 'مدیر',
      role: 'admin',
      permissions: {},
      password_hash: ''
    },
    single: true
  })

  // insert customer via query API
  const ins = executeDbRequest({
    table: 'customers',
    method: 'insert',
    body: {
      id: 'CS-P6-1',
      name: 'مشتری تست',
      phone: '09120001111',
      phones: ['09120001111'],
      addresses: [],
      products: [],
      status: 'new'
    },
    single: true
  })
  if (ins.error) throw new Error(ins.error.message)
  console.log('insert customer', ins.data?.id)

  // select
  const sel = executeDbRequest({
    table: 'customers',
    method: 'select',
    select: 'id,name,phone',
    filters: [{ op: 'eq', col: 'id', value: 'CS-P6-1' }],
    single: true
  })
  console.log('select', sel.data?.name)

  // update
  executeDbRequest({
    table: 'customers',
    method: 'update',
    body: { name: 'مشتری ویرایش‌شده' },
    filters: [{ op: 'eq', col: 'id', value: 'CS-P6-1' }]
  })

  // delete + deletion log
  executeDbRequest({
    table: 'customers',
    method: 'delete',
    filters: [{ op: 'eq', col: 'id', value: 'CS-P6-1' }]
  })

  const { bytes, manifest } = buildOfflineBackupZip({ exportedBy: { username: 'admin' } })
  const parsed = parseBackupBytes(bytes)
  console.log('export source', parsed.manifest.source, 'users', parsed.tables.users.length)
  console.log('deletions in export', parsed.manifest.deletions?.customers?.length || 0)

  db.closeDatabase()
  fs.unlinkSync(dbPath)
  console.log('phase6 smoke test OK')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
