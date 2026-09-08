/**
 * Phase 6 — post-deploy smoke checks (optional network).
 *
 * Env:
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY
 *   CRON_SECRET          (optional — hits subscription-cron)
 *   SMOKE_APP_URL        (optional — checks /platform /signup /payment-result)
 *
 * Run: node scripts/saas-smoke-check.mjs
 */
const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '')
const anon = process.env.SUPABASE_ANON_KEY || ''
const cronSecret = process.env.CRON_SECRET || ''
const appUrl = (process.env.SMOKE_APP_URL || '').replace(/\/$/, '')

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

async function checkFn(name, { method = 'POST', headers = {}, body } = {}) {
  const res = await fetch(`${url}/functions/v1/${name}`, {
    method,
    headers: {
      apikey: anon,
      Authorization: `Bearer ${anon}`,
      'Content-Type': 'application/json',
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* ignore */ }
  return { status: res.status, json, text: text.slice(0, 200) }
}

async function main() {
  if (!url || !anon) {
    console.log('saas-smoke: skipped (set SUPABASE_URL + SUPABASE_ANON_KEY)')
    process.exit(0)
  }

  console.log('saas-smoke: checking Edge reachability…')

  // Unauthenticated / bad body should not 404 — proves function is deployed
  const verify = await checkFn('verify-otp', { body: {} })
  assert(verify.status !== 404, `verify-otp missing (${verify.status})`)
  assert(verify.status < 500 || verify.json?.error, `verify-otp unexpected ${verify.status}`)

  const platform = await checkFn('platform-api', { body: { action: 'list_tenants' } })
  assert(platform.status !== 404, 'platform-api missing')
  assert(platform.status === 401 || platform.status === 403 || platform.json?.success === false, 'platform-api should deny anon')

  const tenantOps = await checkFn('tenant-ops', { body: { action: 'list_audit' } })
  assert(tenantOps.status !== 404, 'tenant-ops missing')

  const createPay = await checkFn('create-payment', { body: {} })
  assert(createPay.status !== 404, 'create-payment missing')

  // Public RPC for subdomain resolve should exist after migration 035
  const rpcRes = await fetch(`${url}/rest/v1/rpc/resolve_tenant_by_subdomain`, {
    method: 'POST',
    headers: {
      apikey: anon,
      Authorization: `Bearer ${anon}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ p_subdomain: '__smoke_nonexistent__' })
  })
  assert(rpcRes.status !== 404, 'resolve_tenant_by_subdomain RPC missing — apply migration 035?')
  // empty result is fine (200)
  assert(rpcRes.status === 200 || rpcRes.status === 204, `rpc status ${rpcRes.status}`)

  if (cronSecret) {
    const cron = await checkFn('subscription-cron', {
      headers: { 'x-cron-secret': cronSecret },
      body: {}
    })
    assert(cron.status === 200 && cron.json?.success, `cron failed: ${cron.text}`)
    console.log('saas-smoke: cron ok', cron.json)
  } else {
    console.log('saas-smoke: cron skipped (no CRON_SECRET)')
  }

  if (appUrl) {
    for (const path of ['/platform', '/signup', '/payment-result']) {
      const r = await fetch(`${appUrl}${path}`, { redirect: 'manual' })
      assert(r.status >= 200 && r.status < 400, `${path} → ${r.status}`)
    }
    console.log('saas-smoke: app routes ok')
  } else {
    console.log('saas-smoke: app routes skipped (no SMOKE_APP_URL)')
  }

  console.log('saas-smoke: ok')
}

main().catch((e) => {
  console.error('saas-smoke: FAIL', e.message || e)
  process.exit(1)
})
