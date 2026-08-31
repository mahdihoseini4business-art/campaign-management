/**
 * Smoke test for packaged app resources (run after npm run pack).
 */
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..', 'out', 'win-unpacked')
const exe = path.join(root, 'CARNO Offline.exe')
const resources = path.join(root, 'resources')

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

assert(fs.existsSync(exe), 'packaged exe missing: ' + exe)
assert(fs.existsSync(path.join(resources, 'app.asar')), 'app.asar missing')
assert(fs.existsSync(path.join(resources, 'db', 'schema.sql')), 'schema.sql missing in resources')
assert(fs.existsSync(path.join(resources, 'sql.js', 'sql-wasm.wasm')), 'sql-wasm.wasm missing in resources')

console.log('packaged app smoke test OK')
