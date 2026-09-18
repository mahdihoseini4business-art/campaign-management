/**
 * Smoke tests for Events feature helpers (no Supabase).
 * Run: node scripts/smoke-events.mjs
 */
import assert from 'node:assert/strict'

// Minimal stubs mirroring data.js normalizeEventMessageTypes behavior
const DEFAULT_EVENT_MESSAGE_TYPES = [
  {
    id: 'welcome',
    name: 'پیام خوش‌آمدگویی',
    body: 'سلام {customer_name} عزیز، به رویداد «{event_name}» خوش آمدید.'
  },
  {
    id: 'notification',
    name: 'پیام اطلاع‌رسانی',
    body: 'سلام {customer_name} عزیز، اطلاع‌رسانی رویداد «{event_name}» مورخ {event_date}.'
  }
]

function normalizeEventMessageType(raw) {
  if (!raw || typeof raw !== 'object') return null
  const name = String(raw.name || '').trim()
  if (!name) return null
  const id = String(raw.id || '').trim() || `emt_${Date.now()}`
  return { id, name, body: String(raw.body || '') }
}

function normalizeEventMessageTypes(raw) {
  if (!Array.isArray(raw) || !raw.length) {
    return DEFAULT_EVENT_MESSAGE_TYPES.map(t => ({ ...t }))
  }
  const seen = new Set()
  const out = []
  for (const item of raw) {
    const t = normalizeEventMessageType(item)
    if (!t || seen.has(t.id)) continue
    seen.add(t.id)
    out.push(t)
  }
  return out.length ? out : DEFAULT_EVENT_MESSAGE_TYPES.map(t => ({ ...t }))
}

function renderPreview(body, vars) {
  let out = String(body || '')
  for (const [k, v] of Object.entries(vars || {})) {
    out = out.split(`{${k}}`).join(String(v ?? ''))
  }
  return out
}

// Defaults
const defaults = normalizeEventMessageTypes(null)
assert.equal(defaults.length, 2)
assert.equal(defaults[0].id, 'welcome')
assert.equal(defaults[1].id, 'notification')

// Custom types
const custom = normalizeEventMessageTypes([
  { id: 'custom1', name: 'یادآوری', body: 'یادآوری {event_name} برای {customer_name}' }
])
assert.equal(custom.length, 1)
assert.equal(custom[0].name, 'یادآوری')

// Preview substitution
const preview = renderPreview(defaults[0].body, {
  customer_name: 'علی',
  event_name: 'حضوری چینی'
})
assert.ok(preview.includes('علی'))
assert.ok(preview.includes('حضوری چینی'))
assert.ok(!preview.includes('{customer_name}'))

// Attendee row key uniqueness shape
const rows = [
  { customerId: 'c1', productIndex: 0, sessionId: 'ips_1' },
  { customerId: 'c1', productIndex: 0, sessionId: 'ips_2' }
]
const keys = new Set(rows.map(r => `${r.customerId}::${r.productIndex}::${r.sessionId}`))
assert.equal(keys.size, 2)

console.log('smoke-events: OK')
