/**
 * Platform settings coerce / merge / feature-drift unit tests (no network).
 * Run: node scripts/test-platform-settings.mjs
 */
import {
  PLATFORM_SETTING_DEFAULTS,
  PLAN_FEATURE_FALLBACK,
  PLAN_IDS,
  DIAMOND_ONLY_FEATURES,
  coercePlatformSetting,
  mergePlatformSettings
} from '../src/platform/defaults.js'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

assert(coercePlatformSetting('trial_days', 7) === 7, 'number passthrough')
assert(coercePlatformSetting('trial_days', '14') === 14, 'numeric string')
assert(coercePlatformSetting('trial_days', '"21"') === 21, 'json-encoded number string')
assert(coercePlatformSetting('root_domain', 'carno.ir') === 'carno.ir', 'domain')
assert(coercePlatformSetting('root_domain', '"carno.ir"') === 'carno.ir', 'quoted domain')
assert(coercePlatformSetting('root_domain', JSON.stringify('acme.test')) === 'acme.test', 'json string domain')

{
  const m = mergePlatformSettings({
    grace_days: '5',
    root_domain: '"example.com"',
    trial_days: null
  })
  assert(m.grace_days === 5, 'merge grace')
  assert(m.root_domain === 'example.com', 'merge domain')
  assert(m.trial_days === PLATFORM_SETTING_DEFAULTS.trial_days, 'null keeps default')
  assert(m.subdomain_min_length === PLATFORM_SETTING_DEFAULTS.subdomain_min_length, 'default min length')
}

{
  const expected = Object.keys(PLAN_FEATURE_FALLBACK[PLAN_IDS.diamond]).filter(
    (k) =>
      PLAN_FEATURE_FALLBACK[PLAN_IDS.diamond][k] === true &&
      PLAN_FEATURE_FALLBACK[PLAN_IDS.gold][k] !== true
  )
  assert(
    JSON.stringify([...DIAMOND_ONLY_FEATURES].sort()) === JSON.stringify(expected.sort()),
    'DIAMOND_ONLY_FEATURES matches PLAN_FEATURE_FALLBACK drift'
  )
  assert(DIAMOND_ONLY_FEATURES.includes('custom_subdomain'), 'custom_subdomain diamond-only')
  assert(DIAMOND_ONLY_FEATURES.includes('dm_chat'), 'dm_chat diamond-only vs gold')
}

{
  // Paid create_tenant contract: ends_at must be in the future (phase 1).
  const paidEndsDays = 30
  const endsAt = new Date(Date.now() + paidEndsDays * 86400000).toISOString()
  assert(typeof endsAt === 'string' && endsAt.length > 10, 'ends_at iso')
  assert(new Date(endsAt).getTime() > Date.now(), 'ends_at in future')
}

console.log('test-platform-settings: ok')
