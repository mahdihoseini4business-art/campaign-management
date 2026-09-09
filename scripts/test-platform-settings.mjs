/**
 * Platform settings coerce / merge unit tests (no network).
 * Run: node scripts/test-platform-settings.mjs
 */
import {
  PLATFORM_SETTING_DEFAULTS,
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

console.log('test-platform-settings: ok')
