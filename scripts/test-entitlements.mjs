/**
 * Phase 6 — entitlement access-state unit tests (no network).
 * Run: node scripts/test-entitlements.mjs
 */
import {
  computeAccessState,
  mergeFeatures,
  paywallCopy,
  graceDaysRemaining,
  PLAN_FEATURE_FALLBACK
} from '../src/entitlements-core.js'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const day = 86400000
const now = Date.now()

{
  const a = computeAccessState(null)
  assert(a.accessMode === 'readonly' && a.paywall && a.reason === 'no_subscription', 'missing sub')
}

{
  const a = computeAccessState({
    plan_id: 'trial',
    status: 'trialing',
    trial_ends_at: new Date(now + 2 * day).toISOString(),
    ends_at: new Date(now + 2 * day).toISOString()
  })
  assert(a.accessMode === 'writable' && !a.paywall && a.reason === 'trialing', 'active trial')
}

{
  const a = computeAccessState({
    plan_id: 'trial',
    status: 'trialing',
    trial_ends_at: new Date(now - day).toISOString(),
    ends_at: new Date(now - day).toISOString()
  })
  assert(a.accessMode === 'readonly' && a.paywall && a.reason === 'trial_ended', 'ended trial')
}

{
  const a = computeAccessState({
    plan_id: 'gold',
    status: 'active',
    ends_at: new Date(now - day).toISOString()
  }, 3)
  assert(a.accessMode === 'grace' && !a.paywall && a.reason === 'grace', 'paid → grace')
}

{
  const a = computeAccessState({
    plan_id: 'gold',
    status: 'active',
    ends_at: new Date(now - 10 * day).toISOString()
  }, 3)
  assert(a.accessMode === 'readonly' && a.paywall && a.reason === 'expired', 'grace exhausted')
}

{
  const a = computeAccessState({ plan_id: 'diamond', status: 'suspended' })
  assert(a.reason === 'suspended' && a.paywall, 'suspended')
}

{
  const f = mergeFeatures('gold', { dm_chat: true, unknown: true })
  assert(f.dm_chat === true, 'db override')
  assert(f.custom_subdomain === false, 'fallback gold')
  assert(!('unknown' in f) || f.unknown === undefined, 'ignore unknown keys in base')
}

{
  assert(PLAN_FEATURE_FALLBACK.diamond.custom_subdomain === true, 'diamond subdomain')
  assert(paywallCopy('trial_ended').title.includes('آزمایشی'), 'paywall title')
  assert(graceDaysRemaining(new Date(now - day).toISOString(), 3, now) === 2, 'grace days left')
  assert(graceDaysRemaining(new Date(now - 10 * day).toISOString(), 3, now) === 0, 'grace over')
}

console.log('test-entitlements: ok')
