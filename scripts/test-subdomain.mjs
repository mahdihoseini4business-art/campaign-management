/**
 * Phase 6 — subdomain label unit tests (no network).
 * Run: node scripts/test-subdomain.mjs
 */
import { extractSubdomainLabel, validateSubdomainLabel } from '../src/subdomain-core.js'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

assert(extractSubdomainLabel('acme.carno.ir', 'carno.ir') === 'acme', 'acme')
assert(extractSubdomainLabel('www.carno.ir', 'carno.ir') === null, 'www')
assert(extractSubdomainLabel('carno.ir', 'carno.ir') === null, 'apex')
assert(extractSubdomainLabel('platform.carno.ir', 'carno.ir') === null, 'reserved')
assert(extractSubdomainLabel('a.b.carno.ir', 'carno.ir') === null, 'nested')
assert(extractSubdomainLabel('Acme.Carno.ir:443', 'carno.ir') === 'acme', 'case+port')

assert(validateSubdomainLabel('ab').ok === false, 'too short')
assert(validateSubdomainLabel('acme').ok === true, 'ok')
assert(validateSubdomainLabel('Admin').ok === false, 'reserved')
assert(validateSubdomainLabel('bad_name').ok === false, 'underscore')

console.log('test-subdomain: ok')
