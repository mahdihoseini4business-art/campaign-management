// ============================================
// Data Layer (Supabase)
// ============================================

import { supabase } from './supabase.js'

const LOCAL_WRITE_SUPPRESS_MS = 2000
let localWriteUntil = 0

/** Immediate suppress so realtime echo cannot race the dynamic live-sync import. */
export function noteLocalWriteNow(ms = LOCAL_WRITE_SUPPRESS_MS) {
  localWriteUntil = Date.now() + Math.max(0, ms)
}

export function isDataLocalWriteSuppressed() {
  return Date.now() < localWriteUntil
}

function bumpLocalWrite() {
  noteLocalWriteNow()
  import('./live-sync.js').then(m => m.noteLocalWrite()).catch(() => {})
}

function toEnDigitsLocal(str) {
  return String(str || '').replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
}

function normalizePhoneLocal(phone) {
  let p = toEnDigitsLocal(String(phone || '')).replace(/\D/g, '')
  if (!p) return ''
  if (p.length > 10) p = p.slice(-10)
  if (p.length === 10 && p.startsWith('9')) p = '0' + p
  return p
}

/** Local normalizer to avoid circular import with utils.js */
function normalizeCustomerPhonesLocal(source) {
  let raw = []
  if (Array.isArray(source)) raw = source
  else if (source && typeof source === 'object') {
    if (Array.isArray(source.phones) && source.phones.length) raw = source.phones
    else if (source.phone) raw = [source.phone]
  }
  const seen = new Set()
  const out = []
  for (const item of raw) {
    const n = normalizePhoneLocal(item)
    if (!n || !/^09\d{9}$/.test(n) || seen.has(n)) continue
    seen.add(n)
    out.push(n)
    if (out.length >= 3) break
  }
  return out
}

function normalizeCustomerAddressesLocal(source) {
  let raw = []
  if (Array.isArray(source)) raw = source
  else if (source && typeof source === 'object' && Array.isArray(source.addresses)) {
    raw = source.addresses
  }
  const seen = new Set()
  const out = []
  for (const item of raw) {
    let text = ''
    let postalCode = ''
    if (typeof item === 'string') {
      text = item.trim().replace(/\s+/g, ' ')
    } else if (item && typeof item === 'object') {
      text = String(item.text || item.address || '').trim().replace(/\s+/g, ' ')
      postalCode = toEnDigitsLocal(String(item.postalCode || item.postal || '').trim()).replace(/\s+/g, '')
    }
    if (!text) continue
    const key = `${text.toLowerCase()}|${postalCode}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ text, postalCode })
    if (out.length >= 10) break
  }
  return out
}

let data = {
  customers: [],
  followups: [],
  ownershipTransfers: [],
  ownershipTransferAcks: [],
  refunds: [],
  convertedCount: 0,
  destinationBanks: [],
  productCatalog: [],
  productBundles: [],
  platforms: [],
  statuses: [],
  salesTargets: [],
  salesTargetDeadlineUrgency: null,
  saleToastEnabled: true,
  smsPanel: null
}

export const DEFAULT_SMS_PANEL = {
  username: '',
  password: '',
  sender: '',
  apiUrl: 'https://rest.payamak-panel.com/api/SmartSMS/Send',
  messageTemplate: 'کد تأیید شما: {code}\n اعتبار: ۵ دقیقه'
}

export function normalizeSmsPanel(raw) {
  const base = { ...DEFAULT_SMS_PANEL }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base
  return {
    username: String(raw.username ?? '').trim(),
    password: String(raw.password ?? ''),
    sender: String(raw.sender ?? '').trim(),
    apiUrl: String(raw.apiUrl ?? '').trim() || DEFAULT_SMS_PANEL.apiUrl,
    messageTemplate: String(raw.messageTemplate ?? '').trim() || DEFAULT_SMS_PANEL.messageTemplate
  }
}

const DEFAULT_PLATFORMS = [
  { key: 'instagram', label: 'اینستاگرام', color: '#E1306C', linkTemplate: 'https://instagram.com/{id}' },
  { key: 'telegram', label: 'تلگرام', color: '#0088cc', linkTemplate: 'https://telegram.me/{id}' },
  { key: 'whatsapp', label: 'واتساپ', color: '#25D366', linkTemplate: 'https://wa.me/{phone}' },
  { key: 'website', label: 'سایت', color: '#2563EB', linkTemplate: 'https://{id}' },
  { key: 'bale', label: 'بله', color: '#00A884', linkTemplate: 'https://ble.ir/{id}' },
  { key: 'eitaa', label: 'ایتا', color: '#F59E0B', linkTemplate: 'https://eitaa.com/{id}' },
  { key: 'goftino', label: 'گفتینو', color: '#6366F1', linkTemplate: '' },
  { key: 'carno_leads', label: 'کارنو لیدز', color: '#0155d2', linkTemplate: '' },
  { key: 'rubika', label: 'روبیکا', color: '#A855F7', linkTemplate: '' },
  { key: 'referral', label: 'ارجاعی', color: '#78716C', linkTemplate: '' },
]

const DEFAULT_STATUSES = [
  { key: 'new', label: 'جدید', bgColor: '#e9ecef', textColor: '#495057', order: 0 },
  { key: 'contacted', label: 'تماس گرفته', bgColor: '#cce5ff', textColor: '#084298', order: 1 },
  { key: 'chatting', label: 'در حال چت', bgColor: '#d0bfff', textColor: '#581c87', order: 2 },
  { key: 'interested', label: 'علاقه‌مند', bgColor: '#fff3cd', textColor: '#664d03', order: 3 },
  { key: 'sent', label: 'اطلاعات ارسال', bgColor: '#d1e7dd', textColor: '#0f5132', order: 4 },
  { key: 'followup_done', label: 'تکمیل پیگیری', bgColor: '#b6effb', textColor: '#055160', order: 5 },
  { key: 'converting', label: 'در حال تبدیل', bgColor: '#f8d7da', textColor: '#842029', order: 6 },
  { key: 'purchased', label: 'خرید کرد', bgColor: '#d1e7dd', textColor: '#0f5132', order: 7 },
  { key: 'cancelled', label: 'منصرف شده', bgColor: '#e9ecef', textColor: '#495057', order: 8 },
]

/** Default product names seeded into settings until admin customizes */
export const DEFAULT_PRODUCT_CATALOG = [
  'آنلاین چینی', 'حضوری چینی', 'کتاب', 'کره ای حضوری', 'کره ای آنلاین',
  'حضوری فرمان', 'آنلاین فرمان', 'دوره زبان فنی', 'دوره GDS', 'آنلاین داخلی',
  'تنظیم موتور', 'دیاگ لانچ', 'دیاگ I700', 'دیاگ blu', 'دیاگ newlite', 'تست باکس شبکه'
]

export const PRODUCT_KIND = {
  educational: 'educational',
  physical: 'physical'
}

/** @deprecated kept for migrate; prefer PRODUCT_KIND */
export const PROFIT_MODE = {
  gross: 'gross',
  net: 'net',
  mixed: 'mixed'
}

function defaultCatalogEntries() {
  return DEFAULT_PRODUCT_CATALOG.map(name => ({
    name,
    productKind: PRODUCT_KIND.educational,
    allowGift: false
  }))
}

/** Normalize one catalog entry (string legacy, profitMode legacy, or productKind). */
export function normalizeCatalogEntry(raw) {
  if (typeof raw === 'string') {
    const name = raw.trim()
    if (!name || name.toLowerCase() === '[object object]') return null
    return { name, productKind: PRODUCT_KIND.educational, allowGift: false }
  }
  if (!raw || typeof raw !== 'object') return null
  let nameRaw = raw.name
  if (nameRaw && typeof nameRaw === 'object') {
    nameRaw = nameRaw.name
  }
  const name = String(nameRaw || '').trim()
  if (!name || name.toLowerCase() === '[object object]') return null

  let productKind = String(raw.productKind || '').toLowerCase()
  if (productKind !== PRODUCT_KIND.physical && productKind !== PRODUCT_KIND.educational) {
    // Migrate legacy profitMode
    const mode = String(raw.profitMode || '').toLowerCase()
    if (mode === PROFIT_MODE.net) productKind = PRODUCT_KIND.educational
    else if (mode === PROFIT_MODE.gross || mode === PROFIT_MODE.mixed) {
      productKind = PRODUCT_KIND.physical
    } else {
      productKind = PRODUCT_KIND.educational
    }
  }

  const entry = { name, productKind, allowGift: raw.allowGift === true }
  if (productKind === PRODUCT_KIND.physical) {
    let cost = Number(raw.costAmount)
    if (!Number.isFinite(cost) || cost < 0) {
      const legacy = Number(raw.netShareAmount)
      cost = Number.isFinite(legacy) && legacy > 0 ? legacy : 0
    }
    entry.costAmount = cost
  }
  return entry
}

/**
 * Coerce any product-name value (string, catalog entry, nested object) to a clean display string.
 * Use wherever product names are shown or stored on sale lines.
 */
export function coerceProductName(value) {
  if (value == null || value === '') return ''
  if (typeof value === 'string') {
    const s = value.trim()
    if (!s || /^\[object\s+Object\]$/i.test(s)) return ''
    return s
  }
  if (typeof value === 'object') {
    return coerceProductName(value.name)
  }
  const s = String(value).trim()
  return /^\[object\s+Object\]$/i.test(s) ? '' : s
}

export function normalizeCustomerId(id) {
  return String(id || '').trim()
}

/** Map a customers DB row → in-memory customer object */
export function mapCustomerFromDb(c) {
  const id = normalizeCustomerId(c?.id)
  if (!c || !id) return null
  const phones = normalizeCustomerPhonesLocal({
    phones: c.phones,
    phone: c.phone || ''
  })
  const addresses = normalizeCustomerAddressesLocal({
    addresses: c.addresses
  })
  return {
    id,
    platformId: c.platform_id || '',
    platform: c.platform || 'instagram',
    name: c.name || '',
    phones,
    phone: phones[0] || '',
    addresses,
    status: c.status || 'new',
    notes: c.notes || '',
    advisor: c.advisor || '',
    advisorPhone: c.advisor_phone || '',
    nextFollowupDate: c.next_followup_date || '',
    products: Array.isArray(c.products)
      ? c.products.map(p => {
        if (!p || typeof p !== 'object') return p
        const name = coerceProductName(p.name)
        return name === p.name ? p : { ...p, name }
      })
      : [],
    createdAt: c.created_at || null,
    customerLevel: c.customer_level || '',
    customerLevelLocked: !!c.customer_level_locked,
    referredByPhone: c.referred_by_phone || ''
  }
}

/** Map a followups DB row → in-memory followup object */
export function mapFollowupFromDb(f) {
  if (!f || f.id == null) return null
  return {
    id: f.id,
    customerId: f.customer_id,
    date: f.date || '',
    type: f.type || '',
    result: f.result || '',
    nextDate: f.next_date || '',
    notes: f.notes || '',
    createdByPhone: f.created_by_phone || '',
    status: f.status || 'pending',
    doneAt: f.done_at || '',
    doneByPhone: f.done_by_phone || '',
    doneNote: f.done_note || '',
    wasOverdue: !!f.was_overdue
  }
}

/** Insert or replace a customer object in cache, collapsing any same-id copies. */
export function putCustomerInCache(customer) {
  if (!customer) return false
  const id = normalizeCustomerId(customer.id)
  if (!id) return false
  customer.id = id
  const next = []
  let replaced = false
  for (const c of data.customers) {
    if (normalizeCustomerId(c.id) === id) {
      if (!replaced) {
        next.push(customer)
        replaced = true
      }
    } else {
      next.push(c)
    }
  }
  if (!replaced) next.push(customer)
  data.customers = next
  return true
}

/** Insert or replace a customer in the in-memory cache. Returns false if row invalid. */
export function upsertCustomerInCache(dbRow) {
  const mapped = mapCustomerFromDb(dbRow)
  if (!mapped) return false
  return putCustomerInCache(mapped)
}

export function removeCustomerFromCache(id) {
  const nid = normalizeCustomerId(id)
  if (!nid) return false
  const before = data.customers.length
  data.customers = data.customers.filter(c => normalizeCustomerId(c.id) !== nid)
  return data.customers.length !== before
}

/** Insert or replace a followup in the in-memory cache. Returns false if row invalid. */
export function upsertFollowupInCache(dbRow) {
  const mapped = mapFollowupFromDb(dbRow)
  if (!mapped) return false
  const id = Number(mapped.id)
  const idx = data.followups.findIndex(f => Number(f.id) === id)
  if (idx >= 0) data.followups[idx] = mapped
  else data.followups.push(mapped)
  return true
}

export function removeFollowupFromCache(id) {
  if (id == null || id === '') return false
  const nid = Number(id)
  const before = data.followups.length
  data.followups = data.followups.filter(f => Number(f.id) !== nid)
  return data.followups.length !== before
}

// ============================================
// Load all data from Supabase
// ============================================

/** PostgREST/Supabase silently caps each response at 1000 rows by default. */
const SUPABASE_PAGE_SIZE = 1000

/**
 * Fetch every row from a table by paging past the 1000-row default limit.
 * @param {string} table
 * @param {object} [opts]
 * @param {string} [opts.select]
 * @param {string} [opts.orderCol]
 * @param {boolean} [opts.ascending]
 * @param {(q: any) => any} [opts.apply] mutate the query (filters, etc.)
 * @returns {Promise<{ data: any[], error: any }>}
 */
async function fetchAllRows(table, opts = {}) {
  const {
    select = '*',
    orderCol = 'id',
    ascending = true,
    apply
  } = opts
  const all = []
  let from = 0
  for (;;) {
    let q = supabase.from(table).select(select)
    if (typeof apply === 'function') q = apply(q) || q
    if (orderCol) q = q.order(orderCol, { ascending })
    q = q.range(from, from + SUPABASE_PAGE_SIZE - 1)
    const { data, error } = await q
    if (error) return { data: all, error }
    const chunk = data || []
    all.push(...chunk)
    if (chunk.length < SUPABASE_PAGE_SIZE) return { data: all, error: null }
    from += SUPABASE_PAGE_SIZE
  }
}

export async function loadData() {
  const [customersRes, followupsRes, settingsRes, transfersRes, acksRes, refundsRes] = await Promise.all([
    fetchAllRows('customers', { orderCol: 'id' }),
    fetchAllRows('followups', { orderCol: 'id' }),
    supabase.from('app_settings').select('*'),
    fetchAllRows('ownership_transfers', { orderCol: 'id', ascending: true }),
    fetchAllRows('ownership_transfer_acks', { orderCol: 'id' }),
    fetchAllRows('refunds', { orderCol: 'id', ascending: false })
  ])

  const errors = []
  if (customersRes.error) errors.push('مشتریان: ' + customersRes.error.message)
  if (followupsRes.error) errors.push('پیگیری‌ها: ' + followupsRes.error.message)
  if (settingsRes.error) errors.push('تنظیمات: ' + settingsRes.error.message)
  // ownership_transfers may be missing before migration 008 — treat as empty
  if (transfersRes.error && !/ownership_transfers|does not exist|relation/i.test(transfersRes.error.message || '')) {
    errors.push('انتقال‌ها: ' + transfersRes.error.message)
  }
  // ownership_transfer_acks may be missing before migration 009 — treat as empty
  if (acksRes.error && !/ownership_transfer_acks|does not exist|relation/i.test(acksRes.error.message || '')) {
    errors.push('تأیید انتقال‌ها: ' + acksRes.error.message)
  }
  // refunds may be missing before migration 016 — treat as empty
  if (refundsRes.error && !/refunds|does not exist|relation/i.test(refundsRes.error.message || '')) {
    errors.push('عودت‌ها: ' + refundsRes.error.message)
  }

  if (errors.length > 0) {
    throw new Error('خطا در بارگذاری داده‌ها:\n' + errors.join('\n'))
  }

  // Map DB rows to app format (collapse same-id copies from pagination/realtime races)
  data.customers = dedupeCustomersById((customersRes.data || []).map(mapCustomerFromDb).filter(Boolean))

  data.followups = (followupsRes.data || []).map(mapFollowupFromDb).filter(Boolean)

  data.ownershipTransfers = (transfersRes.error || !transfersRes.data)
    ? []
    : transfersRes.data.map(mapOwnershipTransferRow)

  data.ownershipTransferAcks = (acksRes.error || !acksRes.data)
    ? []
    : acksRes.data.map(mapOwnershipTransferAckRow)

  data.refunds = (refundsRes.error || !refundsRes.data)
    ? []
    : refundsRes.data.map(mapRefundRow)

  // Load settings (convertedCount, destination banks, …)
  const settings = {}
  ;(settingsRes.data || []).forEach(s => { settings[s.key] = s.value })
  data.convertedCount = settings.convertedCount || 0
  data.destinationBanks = normalizeDestinationBanks(settings.destination_banks)
  data.productCatalog = normalizeProductCatalog(settings.product_catalog)
  data.productBundles = normalizeProductBundles(settings.product_bundles)
  data.platforms = Array.isArray(settings.platforms) && settings.platforms.length > 0 ? settings.platforms : [...DEFAULT_PLATFORMS]
  data.statuses = Array.isArray(settings.statuses) && settings.statuses.length > 0
    ? [...settings.statuses].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    : [...DEFAULT_STATUSES]
  data.saleToastEnabled = settings.sale_toast_enabled !== false && settings.sale_toast_enabled !== 'false'
  try {
    data.smsPanel = normalizeSmsPanel(settings.sms_panel)
  } catch (e) {
    console.error('normalizeSmsPanel error:', e)
    data.smsPanel = normalizeSmsPanel(null)
  }
  try {
    data.salesTargets = normalizeSalesTargets(settings.sales_targets)
  } catch (e) {
    console.error('normalizeSalesTargets error:', e)
    data.salesTargets = []
  }
  try {
    data.salesTargetDeadlineUrgency = normalizeDeadlineUrgency(settings.sales_target_deadline_urgency)
  } catch (e) {
    console.error('normalizeDeadlineUrgency error:', e)
    data.salesTargetDeadlineUrgency = normalizeDeadlineUrgency(null)
  }

  injectDynamicStyles()

  return data
}

function normalizeDestinationBanks(raw) {
  if (Array.isArray(raw)) {
    return raw.map(b => String(b || '').trim()).filter(Boolean)
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed.map(b => String(b || '').trim()).filter(Boolean)
    } catch (_) {
      return raw.split(/[\n,]/).map(b => b.trim()).filter(Boolean)
    }
  }
  return []
}

function normalizeProductCatalog(raw) {
  let list = raw
  if (typeof list === 'string' && list.trim()) {
    try {
      list = JSON.parse(list)
    } catch (_) {
      list = list.split(/[\n,]/).map(s => s.trim()).filter(Boolean)
    }
  }
  if (!Array.isArray(list)) list = []
  const seen = new Set()
  const out = []
  for (const item of list) {
    const entry = normalizeCatalogEntry(item)
    if (!entry) continue
    const key = entry.name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(entry)
  }
  return out.length ? out : defaultCatalogEntries()
}

// ============================================
// Platforms & Statuses
// ============================================

export function getPlatforms() {
  return Array.isArray(data.platforms) && data.platforms.length > 0 ? data.platforms : DEFAULT_PLATFORMS
}

export async function savePlatforms(platforms) {
  data.platforms = platforms
  await saveSetting('platforms', platforms)
  injectDynamicStyles()
}

export function getStatuses() {
  return Array.isArray(data.statuses) && data.statuses.length > 0 ? data.statuses : DEFAULT_STATUSES
}

export async function saveStatuses(statuses) {
  data.statuses = statuses.map((s, i) => ({ ...s, order: i }))
  await saveSetting('statuses', data.statuses)
  injectDynamicStyles()
}

function injectDynamicStyles() {
  let styleEl = document.getElementById('dynamic-platform-status-styles')
  if (!styleEl) {
    styleEl = document.createElement('style')
    styleEl.id = 'dynamic-platform-status-styles'
    document.head.appendChild(styleEl)
  }
  const platforms = getPlatforms()
  const statuses = getStatuses()
  let css = ''
  for (const p of platforms) {
    css += `.platform-${p.key} { background: ${p.color}; }\n`
  }
  for (const s of statuses) {
    css += `.status-${s.key} { background: ${s.bgColor}; color: ${s.textColor};${s.key === 'cancelled' ? ' text-decoration: line-through;' : ''} }\n`
  }
  styleEl.textContent = css
}

// ============================================
// Destination Banks
// ============================================

export function getDestinationBanks() {
  return Array.isArray(data.destinationBanks) ? [...data.destinationBanks] : []
}

export async function saveDestinationBanks(banks) {
  const cleaned = [...new Set((banks || []).map(b => String(b || '').trim()).filter(Boolean))]
  data.destinationBanks = cleaned
  await saveSetting('destination_banks', cleaned)
  return cleaned
}

// ============================================
// Product catalog (sales product names + profit)
// ============================================

export function getProductCatalog() {
  const list = Array.isArray(data.productCatalog) ? data.productCatalog : []
  const normalized = []
  const seen = new Set()
  for (const item of list) {
    const entry = normalizeCatalogEntry(item)
    if (!entry) continue
    const key = entry.name.toLowerCase()
    if (seen.has(key)) continue
    if (entry.name.toLowerCase() === '[object object]') continue
    seen.add(key)
    normalized.push(entry)
  }
  if (!normalized.length) return defaultCatalogEntries()
  // Heal in-memory cache if legacy strings / corrupt rows are still present
  data.productCatalog = normalized
  return normalized.map(e => ({ ...e }))
}

/** Catalog product names only (for dropdowns, matrix, bundles). */
export function getProductCatalogNames() {
  return getProductCatalog()
    .map(e => (typeof e === 'string' ? e : e?.name))
    .map(n => String(n ?? '').trim())
    .filter(n => n && n.toLowerCase() !== '[object object]')
}

export function getCatalogEntryByName(name) {
  const key = String(name || '').trim().toLowerCase()
  if (!key) return null
  return getProductCatalog().find(e => e.name.toLowerCase() === key) || null
}

/**
 * True when admin enabled gift registration for this catalog product.
 * Bundles are not gift-eligible in phase 1.
 */
export function isProductGiftAllowed(productName) {
  const entry = getCatalogEntryByName(productName)
  return !!(entry && entry.allowGift === true)
}

/** Sale line registered as a gift (price 0, no payments). */
export function isGiftSaleLine(line) {
  if (!line || typeof line !== 'object') return false
  if (line.saleType === 'gift') return true
  return String(line.status || '') === 'هدیه'
}

export async function saveProductCatalog(products) {
  const seen = new Set()
  const cleaned = []
  for (const p of products || []) {
    const entry = normalizeCatalogEntry(p)
    if (!entry) continue
    const key = entry.name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    cleaned.push(entry)
  }
  data.productCatalog = cleaned.length ? cleaned : defaultCatalogEntries()
  await saveSetting('product_catalog', data.productCatalog)
  return getProductCatalog()
}

// ============================================
// Product bundles (named sellable sets of catalog products)
// ============================================

function makeBundleId() {
  return `bndl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function normalizeProductBundles(raw) {
  let list = raw
  if (typeof list === 'string' && list.trim()) {
    try { list = JSON.parse(list) } catch (_) { return [] }
  }
  if (!Array.isArray(list)) return []
  return list.map(item => {
    if (!item || typeof item !== 'object') return null
    const name = String(item.name || '').trim()
    if (!name) return null
    const productNames = [...new Set(
      (Array.isArray(item.productNames) ? item.productNames : [])
        .map(p => String(p || '').trim())
        .filter(Boolean)
    )]
    if (productNames.length < 2) return null
    return {
      id: String(item.id || '').trim() || makeBundleId(),
      name,
      productNames
    }
  }).filter(Boolean)
}

export function getProductBundles() {
  return Array.isArray(data.productBundles)
    ? data.productBundles.map(b => ({ ...b, productNames: [...(b.productNames || [])] }))
    : []
}

export async function saveProductBundles(bundles) {
  data.productBundles = normalizeProductBundles(bundles)
  await saveSetting('product_bundles', data.productBundles)
  return getProductBundles()
}

/** Union of catalog product names + bundle names (sellable dropdown options). */
export function getSellableNames() {
  const products = getProductCatalogNames()
  const bundleNames = getProductBundles().map(b => coerceProductName(b.name)).filter(Boolean)
  const seen = new Set()
  const out = []
  for (const name of [...products, ...bundleNames]) {
    const clean = coerceProductName(name)
    if (!clean) continue
    const key = clean.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(clean)
  }
  return out
}

export function getBundleByName(name) {
  const key = String(name || '').trim().toLowerCase()
  if (!key) return null
  return getProductBundles().find(b => b.name.toLowerCase() === key) || null
}

export function isBundleName(name) {
  return !!getBundleByName(name)
}

/** Bundles that include the given catalog product name as a component. */
export function getBundlesUsingProduct(productName) {
  const key = String(productName || '').trim().toLowerCase()
  if (!key) return []
  return getProductBundles().filter(b =>
    (b.productNames || []).some(p => p.toLowerCase() === key)
  )
}

/**
 * True when the sale line has at least one accounting-approved payment with amount > 0.
 * Mirrors utils getPaymentEntryStatus / getApprovedPaid without importing utils (circular).
 */
function saleLineHasApprovedPayment(line) {
  if (!line || typeof line !== 'object') return false

  let pays = Array.isArray(line.payments) ? line.payments : null
  if (!pays) {
    // Legacy single-payment fields
    const deposit = parseFloat(line.deposit) || 0
    const price = parseFloat(line.price) || 0
    let amount = 0
    if (line.status === 'بیعانه' && deposit > 0) amount = deposit
    else if (price > 0) amount = price
    else if (deposit > 0) amount = deposit
    const hasLegacy = amount > 0 || line.soldAt || line.depositorName || line.paymentStatus
    if (!hasLegacy) return false
    const status = line.paymentStatus || 'approved'
    return status === 'approved' && amount > 0
  }

  return pays.some(p => {
    if (!p) return false
    const amount = parseFloat(p.amount) || 0
    if (amount <= 0) return false
    const status = p.paymentStatus || 'approved'
    return status === 'approved'
  })
}

/** Ownership from paid sale or accounting-approved gift (excludes fully refunded lines). */
function saleLineGrantsOwnership(line) {
  if (isGiftSaleLine(line)) {
    return (line.giftAccountingStatus || 'pending') === 'approved'
  }
  if (!saleLineHasApprovedPayment(line)) return false
  // Inline check to avoid circular import with utils.isProductFullyRefunded
  const refunds = Array.isArray(line.refunds) ? line.refunds : []
  const refunded = refunds.reduce((s, r) => s + (parseFloat(r?.amount) || 0), 0)
  if (refunded <= 0) return true
  const payments = Array.isArray(line.payments) ? line.payments : []
  const approved = payments.reduce((s, p) => {
    const st = p?.paymentStatus || 'approved'
    if (st !== 'approved') return s
    return s + (parseFloat(p.amount) || 0)
  }, 0)
  return refunded < approved - 0.5
}

/**
 * Catalog product names the customer owns — direct sale, bundle purchase, or approved gift.
 * @returns {Set<string>}
 */
export function getCustomerOwnedProductNames(customer) {
  const catalog = getProductCatalogNames()
  const catalogByLower = new Map(catalog.map(n => [n.toLowerCase(), n]))
  const owned = new Set()

  for (const line of customer?.products || []) {
    if (!saleLineGrantsOwnership(line)) continue

    const saleName = coerceProductName(line?.name)
    if (!saleName) continue

    const direct = catalogByLower.get(saleName.toLowerCase())
    if (direct) {
      owned.add(direct)
      continue
    }

    const bundle = getBundleByName(saleName)
    if (!bundle) continue
    for (const p of bundle.productNames || []) {
      const canonical = catalogByLower.get(String(p || '').trim().toLowerCase())
      if (canonical) owned.add(canonical)
    }
  }

  return owned
}

export function customerHasCatalogProduct(customer, productName) {
  const key = String(productName || '').trim().toLowerCase()
  if (!key) return false
  for (const name of getCustomerOwnedProductNames(customer)) {
    if (name.toLowerCase() === key) return true
  }
  return false
}

/** True when the customer owns no catalog products (after bundle expansion). */
export function customerHasNoProducts(customer) {
  return getCustomerOwnedProductNames(customer).size === 0
}

/**
 * Validate a bundle draft against catalog + other bundles.
 * @returns {{ ok: true, bundle } | { ok: false, error: string }}
 */
export function validateProductBundle(draft, { excludeId = null } = {}) {
  const name = String(draft?.name || '').trim()
  if (!name) return { ok: false, error: 'نام باندل را وارد کنید' }

  const productNames = [...new Set(
    (Array.isArray(draft?.productNames) ? draft.productNames : [])
      .map(p => String(p || '').trim())
      .filter(Boolean)
  )]
  if (productNames.length < 2) {
    return { ok: false, error: 'حداقل دو محصول از کاتالوگ انتخاب کنید' }
  }

  const catalog = getProductCatalogNames()
  const catalogLower = new Set(catalog.map(p => p.toLowerCase()))
  for (const p of productNames) {
    if (!catalogLower.has(p.toLowerCase())) {
      return { ok: false, error: `محصول «${p}» در کاتالوگ نیست` }
    }
  }

  const nameLower = name.toLowerCase()
  if (catalog.some(p => p.toLowerCase() === nameLower)) {
    return { ok: false, error: 'نام باندل نباید با نام یک محصول کاتالوگ یکی باشد' }
  }

  const others = getProductBundles().filter(b => b.id !== excludeId)
  if (others.some(b => b.name.toLowerCase() === nameLower)) {
    return { ok: false, error: 'باندلی با این نام قبلاً ثبت شده' }
  }

  return {
    ok: true,
    bundle: {
      id: String(draft?.id || '').trim() || makeBundleId(),
      name,
      productNames
    }
  }
}

/** Rename a catalog product inside all bundle compositions. */
export async function renameProductInBundles(oldName, newName) {
  const from = String(oldName || '').trim()
  const to = String(newName || '').trim()
  if (!from || !to || from === to) return getProductBundles()
  const fromLower = from.toLowerCase()
  let changed = false
  const next = getProductBundles().map(b => {
    const productNames = (b.productNames || []).map(p => {
      if (p.toLowerCase() !== fromLower) return p
      changed = true
      return to
    })
    const deduped = [...new Set(productNames)]
    return { ...b, productNames: deduped }
  })
  if (!changed) return getProductBundles()
  return saveProductBundles(next)
}

/**
 * Count customer sale lines whose product.name matches (case-insensitive).
 */
export function countSalesByProductName(productName) {
  const key = String(productName || '').trim().toLowerCase()
  if (!key) return 0
  let n = 0
  for (const c of data.customers || []) {
    for (const p of c.products || []) {
      if (String(p?.name || '').trim().toLowerCase() === key) n++
    }
  }
  return n
}

/**
 * Migrate sale lines + sales-target filters from an old catalog name to a bundle name.
 * @returns {{ updatedCustomers: number, updatedSales: number, updatedTargets: boolean, bundleName: string }}
 */
export async function migrateCatalogNameToBundle(oldCatalogName, bundleId) {
  const oldName = String(oldCatalogName || '').trim()
  if (!oldName) throw new Error('نام قدیمی را انتخاب کنید')

  const bundle = getProductBundles().find(b => b.id === bundleId)
  if (!bundle) throw new Error('باندل مقصد را انتخاب کنید')

  const oldLower = oldName.toLowerCase()
  const newName = bundle.name
  let updatedCustomers = 0
  let updatedSales = 0

  for (const customer of data.customers || []) {
    const products = customer.products || []
    let dirty = false
    for (const p of products) {
      if (String(p?.name || '').trim().toLowerCase() === oldLower) {
        p.name = newName
        dirty = true
        updatedSales++
      }
    }
    if (dirty) {
      await saveCustomerToDB(customer)
      updatedCustomers++
    }
  }

  let updatedTargets = false
  const targets = getSalesTargets()
  const nextTargets = targets.map(group => {
    const items = (group.items || []).map(bar => {
      const names = bar.productNames || []
      if (!names.some(n => n.toLowerCase() === oldLower)) return bar
      updatedTargets = true
      const replaced = names.map(n => (n.toLowerCase() === oldLower ? newName : n))
      return { ...bar, productNames: [...new Set(replaced)] }
    })
    return { ...group, items }
  })
  if (updatedTargets) await saveSalesTargets(nextTargets)

  return { updatedCustomers, updatedSales, updatedTargets, bundleName: newName }
}

// ============================================
// Sales targets
// ============================================

function normalizeSalesTargetBar(item) {
  if (!item || typeof item !== 'object') return null
  const metric = item.metric === 'count' ? 'count' : 'amount'
  const value = Number(item.value)
  if (!Number.isFinite(value) || value <= 0) return null
  const productNames = Array.isArray(item.productNames)
    ? [...new Set(item.productNames.map(p => String(p || '').trim()).filter(Boolean))]
    : []
  return {
    id: String(item.id || '').trim() || `tgt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    metric,
    value,
    productNames,
    startDate: String(item.startDate || '').trim(),
    endDate: String(item.endDate || '').trim(),
    createdAt: String(item.createdAt || '').trim() || new Date().toISOString()
  }
}

function normalizeSalesTargetAllocations(raw, barIds) {
  if (!Array.isArray(raw)) return []
  const idSet = new Set(barIds || [])
  return raw.map(alloc => {
    if (!alloc || typeof alloc !== 'object') return null
    const userGroupId = String(alloc.userGroupId || '').trim()
    if (!userGroupId) return null
    const shares = (Array.isArray(alloc.shares) ? alloc.shares : [])
      .map(share => {
        if (!share || typeof share !== 'object') return null
        const barId = String(share.barId || '').trim()
        const value = Number(share.value)
        if (!barId || !idSet.has(barId) || !Number.isFinite(value) || value <= 0) return null
        return { barId, value }
      })
      .filter(Boolean)
    if (!shares.length) return null
    return { userGroupId, shares }
  }).filter(Boolean)
}

function normalizeSalesTargets(raw) {
  let list = raw
  if (typeof list === 'string' && list.trim()) {
    try { list = JSON.parse(list) } catch (_) { return [] }
  }
  if (!Array.isArray(list)) return []
  return list.map(item => {
    if (!item || typeof item !== 'object') return null

    // New grouped format: { id, title, items: [...], allocations?: [...] }
    if (Array.isArray(item.items)) {
      const items = item.items.map(normalizeSalesTargetBar).filter(Boolean)
      if (!items.length) return null
      const title = String(item.title || '').trim() || 'گروه تارگت'
      const barIds = items.map(bar => bar.id)
      return {
        id: String(item.id || '').trim() || `grp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        title,
        items,
        allocations: normalizeSalesTargetAllocations(item.allocations, barIds),
        createdAt: String(item.createdAt || '').trim() || new Date().toISOString()
      }
    }

    // Legacy flat format: one bar with its own title → wrap as single-item group
    const bar = normalizeSalesTargetBar(item)
    if (!bar) return null
    const title = String(item.title || '').trim() || (bar.metric === 'count' ? 'تارگت تعداد' : 'تارگت مبلغ')
    return {
      id: String(item.id || '').trim() || `grp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      title,
      items: [bar],
      allocations: [],
      createdAt: String(item.createdAt || '').trim() || bar.createdAt
    }
  }).filter(Boolean)
}

function cloneSalesTargetGroup(group) {
  return {
    ...group,
    items: (group.items || []).map(bar => ({ ...bar, productNames: [...(bar.productNames || [])] })),
    allocations: (group.allocations || []).map(alloc => ({
      userGroupId: alloc.userGroupId,
      shares: (alloc.shares || []).map(share => ({ ...share }))
    }))
  }
}

export function getSalesTargets() {
  return Array.isArray(data.salesTargets) ? data.salesTargets.map(cloneSalesTargetGroup) : []
}

export async function saveSalesTargets(targets) {
  data.salesTargets = normalizeSalesTargets(targets)
  await saveSetting('sales_targets', data.salesTargets)
  return getSalesTargets()
}

// ============================================
// Deadline countdown urgency (sales target timer colors)
// ============================================

export const DEFAULT_DEADLINE_URGENCY = {
  defaultColor: '#25b88b',
  overdueColor: '#ED1C24',
  stages: [
    { id: 'urg_1h', withinValue: 1, withinUnit: 'hour', color: '#ED1C24' },
    { id: 'urg_1d', withinValue: 1, withinUnit: 'day', color: '#F59E0B' },
    { id: 'urg_3d', withinValue: 3, withinUnit: 'day', color: '#D97706' }
  ]
}

const URGENCY_UNITS = new Set(['day', 'hour', 'minute'])

function normalizeHexColor(raw, fallback) {
  const s = String(raw || '').trim()
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toUpperCase()
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    const r = s[1], g = s[2], b = s[3]
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase()
  }
  return fallback
}

function normalizeUrgencyStage(item) {
  if (!item || typeof item !== 'object') return null
  const withinValue = Math.max(1, Math.round(Number(item.withinValue) || 0))
  if (!Number.isFinite(withinValue) || withinValue <= 0) return null
  const withinUnit = URGENCY_UNITS.has(item.withinUnit) ? item.withinUnit : 'day'
  return {
    id: String(item.id || '').trim() || `urg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    withinValue,
    withinUnit,
    color: normalizeHexColor(item.color, '#F59E0B')
  }
}

export function normalizeDeadlineUrgency(raw) {
  let src = raw
  if (typeof src === 'string' && src.trim()) {
    try { src = JSON.parse(src) } catch (_) { src = null }
  }
  if (!src || typeof src !== 'object') {
    return {
      defaultColor: DEFAULT_DEADLINE_URGENCY.defaultColor,
      overdueColor: DEFAULT_DEADLINE_URGENCY.overdueColor,
      stages: DEFAULT_DEADLINE_URGENCY.stages.map(s => ({ ...s }))
    }
  }
  const stages = (Array.isArray(src.stages) ? src.stages : [])
    .map(normalizeUrgencyStage)
    .filter(Boolean)
  return {
    defaultColor: normalizeHexColor(src.defaultColor, DEFAULT_DEADLINE_URGENCY.defaultColor),
    overdueColor: normalizeHexColor(src.overdueColor, DEFAULT_DEADLINE_URGENCY.overdueColor),
    stages
  }
}

export function urgencyStageMs(stage) {
  const n = Math.max(0, Number(stage?.withinValue) || 0)
  if (stage?.withinUnit === 'minute') return n * 60 * 1000
  if (stage?.withinUnit === 'hour') return n * 60 * 60 * 1000
  return n * 24 * 60 * 60 * 1000
}

/** Pick color for remainingMs using configured stages (shortest matching threshold wins). */
export function colorForDeadlineRemaining(remainingMs, urgency) {
  const cfg = normalizeDeadlineUrgency(urgency)
  if (!(remainingMs > 0)) return cfg.overdueColor
  const sorted = [...(cfg.stages || [])].sort((a, b) => urgencyStageMs(a) - urgencyStageMs(b))
  for (const stage of sorted) {
    if (remainingMs <= urgencyStageMs(stage)) return stage.color
  }
  return cfg.defaultColor
}

export function getDeadlineUrgency() {
  return normalizeDeadlineUrgency(data.salesTargetDeadlineUrgency)
}

export async function saveDeadlineUrgency(config) {
  data.salesTargetDeadlineUrgency = normalizeDeadlineUrgency(config)
  await saveSetting('sales_target_deadline_urgency', data.salesTargetDeadlineUrgency)
  return getDeadlineUrgency()
}

// ============================================
// Get in-memory data
// ============================================

export function getData() {
  return data
}

// ============================================
// Save customer to Supabase
// ============================================

export async function saveCustomerToDB(customer, options = {}) {
  bumpLocalWrite()
  const phones = normalizeCustomerPhonesLocal(customer)
  const addresses = normalizeCustomerAddressesLocal(customer)
  const row = {
    id: customer.id,
    platform_id: customer.platformId || '',
    platform: customer.platform || 'instagram',
    name: customer.name || '',
    phone: phones[0] || '',
    phones,
    addresses,
    status: customer.status || 'new',
    notes: customer.notes || '',
    advisor: customer.advisor || '',
    advisor_phone: customer.advisorPhone || '',
    next_followup_date: customer.nextFollowupDate || '',
    products: customer.products || [],
    customer_level: customer.customerLevel || '',
    customer_level_locked: !!customer.customerLevelLocked,
    referred_by_phone: customer.referredByPhone || ''
  }
  // Only set on insert (e.g. LD↔CS rekey) so L/relationship start is preserved.
  if (options.createdAt) row.created_at = options.createdAt

  let { error } = await supabase.from('customers').upsert(row, { onConflict: 'id' })
  // Graceful fallback before migration 007 / 015 is applied
  if (error && /addresses/i.test(error.message || '')) {
    const { addresses: _omitAddr, ...withoutAddresses } = row
    ;({ error } = await supabase.from('customers').upsert(withoutAddresses, { onConflict: 'id' }))
  }
  if (error && /phones/i.test(error.message || '')) {
    const { phones: _omit, addresses: _omitAddr2, ...legacy } = row
    ;({ error } = await supabase.from('customers').upsert(legacy, { onConflict: 'id' }))
  }
  if (error) throw new Error('خطا در ذخیره مشتری: ' + error.message)
  bumpLocalWrite()
}

// ============================================
// Delete customer from Supabase
// ============================================

export async function deleteCustomerFromDB(id) {
  bumpLocalWrite()
  // Delete followups first
  const { error: followupError } = await supabase.from('followups').delete().eq('customer_id', id)
  if (followupError) throw new Error('خطا در حذف پیگیری‌ها: ' + followupError.message)
  // Delete customer
  const { error } = await supabase.from('customers').delete().eq('id', id)
  if (error) throw new Error('خطا در حذف مشتری: ' + error.message)
  bumpLocalWrite()
}

/** Delete customer row only — followups must already be reassigned (e.g. after merge). */
export async function deleteCustomerRowOnly(id) {
  bumpLocalWrite()
  const { error } = await supabase.from('customers').delete().eq('id', id)
  if (error) throw new Error('خطا در حذف مشتری: ' + error.message)
  bumpLocalWrite()
}

function cloneJson(value, fallback) {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return fallback
  }
}

/** Deep-clone a customer for LD↔CS rekey so nested products/payments are not shared. */
export function cloneCustomerRecord(customer, overrides = {}) {
  const productsSrc = Array.isArray(overrides.products) ? overrides.products : (customer?.products || [])
  const products = cloneJson(productsSrc, [])
  const phones = Array.isArray(overrides.phones)
    ? [...overrides.phones]
    : (Array.isArray(customer?.phones) ? [...customer.phones] : [])
  const addressesSrc = Array.isArray(overrides.addresses)
    ? overrides.addresses
    : (Array.isArray(customer?.addresses) ? customer.addresses : [])
  const addresses = addressesSrc.map(a => (a && typeof a === 'object' ? { ...a } : a))
  return {
    ...customer,
    ...overrides,
    phones,
    phone: phones[0] || overrides.phone || '',
    addresses,
    products,
    createdAt: overrides.createdAt !== undefined ? overrides.createdAt : (customer?.createdAt || null)
  }
}

function replaceCustomerInCache(oldId, nextCustomer) {
  const drop = new Set([normalizeCustomerId(oldId), normalizeCustomerId(nextCustomer?.id)])
  data.customers = data.customers.filter(c => !drop.has(normalizeCustomerId(c.id)))
  putCustomerInCache(nextCustomer)
}

/**
 * Insert customer under a new id, move followups, delete the old row.
 * Used for LD↔CS conversion so the previous id does not linger as a duplicate sale.
 */
export async function rekeyCustomerId(oldId, newCustomer) {
  if (!oldId || !newCustomer?.id || oldId === newCustomer.id) {
    throw new Error('شناسه تبدیل نامعتبر است')
  }
  const createdAt = newCustomer.createdAt || data.customers.find(c => c.id === oldId)?.createdAt || null
  const toSave = { ...newCustomer, createdAt: createdAt || newCustomer.createdAt || null }
  await saveCustomerToDB(toSave, { createdAt: toSave.createdAt || undefined })
  await updateFollowupsCustomerId(oldId, toSave.id)
  data.followups.forEach(f => { if (f.customerId === oldId) f.customerId = toSave.id })
  await deleteCustomerRowOnly(oldId)
  replaceCustomerInCache(oldId, toSave)
  return toSave
}

function paymentStatusRankLocal(status) {
  if (status === 'approved') return 3
  if (status === 'rejected') return 2
  if (status === 'pending') return 1
  return 0
}

function collectCustomerPaymentIds(customer) {
  const ids = []
  for (const line of customer?.products || []) {
    if (!line || typeof line !== 'object') continue
    for (const pay of line.payments || []) {
      if (pay?.id) ids.push(String(pay.id))
    }
  }
  return ids
}

function approvedPaidTotalLocal(customer) {
  let sum = 0
  for (const line of customer?.products || []) {
    if (!line || typeof line !== 'object') continue
    if (isGiftSaleLine(line)) {
      if ((line.giftAccountingStatus || 'pending') === 'approved') sum += 0.01
      continue
    }
    for (const pay of line.payments || []) {
      const st = pay?.paymentStatus || 'approved'
      if (st === 'approved') sum += parseFloat(pay.amount) || 0
    }
  }
  return sum
}

function createdAtMsLocal(customer) {
  const t = customer?.createdAt ? new Date(customer.createdAt).getTime() : 0
  return Number.isFinite(t) ? t : 0
}

function pickConversionSurvivor(a, b, followups) {
  const aPay = approvedPaidTotalLocal(a)
  const bPay = approvedPaidTotalLocal(b)
  if (aPay !== bPay) return aPay > bPay ? a : b
  const aFu = followups.filter(f => f.customerId === a.id).length
  const bFu = followups.filter(f => f.customerId === b.id).length
  if (aFu !== bFu) return aFu > bFu ? a : b
  const aT = createdAtMsLocal(a)
  const bT = createdAtMsLocal(b)
  if (aT !== bT) return aT > bT ? a : b
  const aCS = String(a.id).startsWith('CS')
  const bCS = String(b.id).startsWith('CS')
  const aPhones = normalizeCustomerPhonesLocal(a).length
  const bPhones = normalizeCustomerPhonesLocal(b).length
  if (aCS && aPhones && !(bCS && bPhones)) return a
  if (bCS && bPhones && !(aCS && aPhones)) return b
  return aCS ? a : b
}

function betterPaymentLocal(a, b) {
  if (!a) return b
  if (!b) return a
  return paymentStatusRankLocal(a.paymentStatus || 'pending') >= paymentStatusRankLocal(b.paymentStatus || 'pending')
    ? a
    : b
}

function productCloneKey(product) {
  const name = coerceProductName(product?.name || '').toLowerCase()
  const price = String(parseFloat(product?.price) || 0)
  const gift = isGiftSaleLine(product) ? '1' : '0'
  const soldAt = String(product?.soldAt || '').trim()
  return `${gift}|${name}|${price}|${soldAt}`
}

function mergeOrphanProductsIntoSurvivor(survivor, orphan) {
  const products = cloneJson(survivor.products || [], [])
  for (const op of orphan.products || []) {
    if (!op || typeof op !== 'object') continue
    const opIds = new Set((op.payments || []).map(p => p?.id && String(p.id)).filter(Boolean))
    let idx = -1
    if (opIds.size) {
      idx = products.findIndex(sp =>
        (sp.payments || []).some(p => p?.id && opIds.has(String(p.id)))
      )
    }
    if (idx < 0) {
      const key = productCloneKey(op)
      if (key !== '0||0|' && key !== '1||0|') {
        idx = products.findIndex(sp => productCloneKey(sp) === key)
      }
    }
    if (idx < 0) {
      const hasPay = (op.payments || []).some(p => (parseFloat(p?.amount) || 0) > 0)
      if (hasPay || isGiftSaleLine(op) || coerceProductName(op.name)) {
        products.push(cloneJson(op, { ...op }))
      }
      continue
    }
    const sp = products[idx]
    if (!Array.isArray(sp.payments)) sp.payments = []
    const byId = new Map(sp.payments.map(p => [String(p?.id || ''), p]))
    for (const pay of op.payments || []) {
      if (!pay) continue
      const id = String(pay.id || '')
      if (!id) {
        const dup = sp.payments.some(p =>
          (parseFloat(p.amount) || 0) === (parseFloat(pay.amount) || 0) &&
          String(p.soldAt || '') === String(pay.soldAt || '')
        )
        if (!dup && (parseFloat(pay.amount) || 0) > 0) sp.payments.push({ ...pay })
        continue
      }
      if (!byId.has(id)) {
        sp.payments.push({ ...pay })
        byId.set(id, pay)
      } else {
        const keep = betterPaymentLocal(byId.get(id), pay)
        const i = sp.payments.findIndex(p => String(p?.id) === id)
        if (i >= 0) sp.payments[i] = { ...keep }
        byId.set(id, keep)
      }
    }
    if (isGiftSaleLine(op) || isGiftSaleLine(sp)) {
      const a = sp.giftAccountingStatus || 'pending'
      const b = op.giftAccountingStatus || 'pending'
      sp.giftAccountingStatus = paymentStatusRankLocal(b) > paymentStatusRankLocal(a) ? b : a
      if (op.giftRejectReason && !sp.giftRejectReason) sp.giftRejectReason = op.giftRejectReason
    }
  }
  return products
}

function customerSnapshotScore(customer) {
  let approved = 0
  let payments = 0
  let pending = 0
  for (const line of customer?.products || []) {
    if (!line || typeof line !== 'object') continue
    if (isGiftSaleLine(line)) {
      const st = line.giftAccountingStatus || 'pending'
      if (st === 'approved') approved += 1
      else if (st === 'pending') pending += 1
      payments += 1
      continue
    }
    for (const pay of line.payments || []) {
      payments += 1
      const st = pay?.paymentStatus || 'approved'
      const amt = parseFloat(pay?.amount) || 0
      if (st === 'approved') approved += amt || 1
      else if (st === 'pending') pending += amt || 1
    }
  }
  return approved * 1e12 + payments * 1e6 + pending
}

/** Collapse same-id customer copies; keep the stronger payment snapshot. */
export function dedupeCustomersById(customers) {
  const byId = new Map()
  for (const c of customers || []) {
    if (!c) continue
    const id = normalizeCustomerId(c.id)
    if (!id) continue
    c.id = id
    const existing = byId.get(id)
    if (!existing) {
      byId.set(id, c)
      continue
    }
    const keep = customerSnapshotScore(c) >= customerSnapshotScore(existing) ? c : existing
    const drop = keep === c ? existing : c
    keep.products = mergeOrphanProductsIntoSurvivor(keep, drop)
    byId.set(id, keep)
  }
  return [...byId.values()]
}

export function collapseDuplicateCustomersInCache() {
  const seen = new Set()
  let hasDup = false
  for (const c of data.customers) {
    const id = normalizeCustomerId(c?.id)
    if (!id) continue
    if (seen.has(id)) { hasDup = true; break }
    seen.add(id)
  }
  if (!hasDup) return false
  data.customers = dedupeCustomersById(data.customers)
  return true
}

function findConversionOrphanPairs(customers) {
  const pairKeys = new Set()
  const pairs = []
  const addPair = (ld, cs) => {
    if (!ld || !cs || ld.id === cs.id) return
    const a = String(ld.id).startsWith('LD') ? ld : (String(cs.id).startsWith('LD') ? cs : null)
    const b = String(cs.id).startsWith('CS') ? cs : (String(ld.id).startsWith('CS') ? ld : null)
    if (!a || !b) return
    const key = `${a.id}|${b.id}`
    if (pairKeys.has(key)) return
    pairKeys.add(key)
    pairs.push([a, b])
  }

  const byPlatform = new Map()
  for (const c of customers) {
    const key = String(c.platformId || '').trim().toLowerCase()
    if (!key) continue
    if (!byPlatform.has(key)) byPlatform.set(key, [])
    byPlatform.get(key).push(c)
  }
  for (const group of byPlatform.values()) {
    if (group.length < 2) continue
    const lds = group.filter(c => String(c.id).startsWith('LD'))
    const css = group.filter(c => String(c.id).startsWith('CS'))
    for (const ld of lds) {
      for (const cs of css) addPair(ld, cs)
    }
  }

  const payToCustomers = new Map()
  for (const c of customers) {
    for (const payId of collectCustomerPaymentIds(c)) {
      if (!payToCustomers.has(payId)) payToCustomers.set(payId, new Set())
      payToCustomers.get(payId).add(c.id)
    }
  }
  const byId = new Map(customers.map(c => [c.id, c]))
  for (const ids of payToCustomers.values()) {
    if (ids.size < 2) continue
    const group = [...ids].map(id => byId.get(id)).filter(Boolean)
    const lds = group.filter(c => String(c.id).startsWith('LD'))
    const css = group.filter(c => String(c.id).startsWith('CS'))
    for (const ld of lds) {
      for (const cs of css) addPair(ld, cs)
    }
  }

  return pairs
}

/**
 * Remove leftover LD/CS rows created by conversion that forgot to delete the old id.
 * Same sale then appeared twice (approved on CS, still pending on orphan LD).
 */
export async function cleanupConversionOrphans() {
  const pairs = findConversionOrphanPairs(data.customers)
  if (!pairs.length) return { merged: 0 }

  let merged = 0
  for (const [ld, cs] of pairs) {
    const survivorSrc = pickConversionSurvivor(ld, cs, data.followups)
    const orphan = survivorSrc.id === ld.id ? cs : ld
    const survivor = cloneCustomerRecord(survivorSrc, {
      products: mergeOrphanProductsIntoSurvivor(survivorSrc, orphan)
    })
    try {
      await saveCustomerToDB(survivor)
      const idx = data.customers.findIndex(c => c.id === survivor.id)
      if (idx >= 0) data.customers[idx] = survivor
      await updateFollowupsCustomerId(orphan.id, survivor.id)
      data.followups.forEach(f => { if (f.customerId === orphan.id) f.customerId = survivor.id })
      await deleteCustomerRowOnly(orphan.id)
      data.customers = data.customers.filter(c => c.id !== orphan.id)
      merged++
    } catch (e) {
      console.error('cleanupConversionOrphans error', ld.id, cs.id, e)
    }
  }
  return { merged }
}

function mapOwnershipTransferRow(t) {
  return {
    id: t.id,
    customerId: t.customer_id,
    customerPhone: t.customer_phone || '',
    fromAdvisorPhone: t.from_advisor_phone || '',
    fromAdvisorName: t.from_advisor_name || '',
    toAdvisorPhone: t.to_advisor_phone || '',
    toAdvisorName: t.to_advisor_name || '',
    actedByPhone: t.acted_by_phone || '',
    batchId: t.batch_id || '',
    reason: t.reason || '',
    customerStatusAtTransfer: t.customer_status_at_transfer || '',
    createdAt: t.created_at || null
  }
}

function mapOwnershipTransferAckRow(a) {
  return {
    id: a.id,
    userPhone: a.user_phone || '',
    batchId: a.batch_id || '',
    seenAt: a.seen_at || null
  }
}

export const TRANSFER_REASON_LABELS = {
  distribution: 'توزیع بین تیم',
  handoff: 'تحویل به مسئول بالاتر',
  reassign: 'جابه‌جایی مسئول',
  reclaim: 'بازپس‌گیری شماره'
}

export function generateTransferBatchId() {
  return `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function transferBatchKey(t) {
  return t.batchId || `single_${t.id}`
}

function formatTransferCreatedAt(iso) {
  if (!iso) return { date: '—', time: '', dateTime: '—' }
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { date: '—', time: '', dateTime: '—' }
  const tehran = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Tehran' }))
  // Same algorithm as utils.toJalali (kept local to avoid circular import)
  const gy = tehran.getFullYear()
  const gm = tehran.getMonth() + 1
  const gd = tehran.getDate()
  const g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]
  let gy2 = (gm > 2) ? (gy + 1) : gy
  let days = 355666 + (365 * gy) + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100) + Math.floor((gy2 + 399) / 400) + gd + g_d_m[gm - 1]
  let jy = -1595 + (33 * Math.floor(days / 12053))
  days %= 12053
  jy += 4 * Math.floor(days / 1461)
  days %= 1461
  if (days > 365) {
    jy += Math.floor((days - 1) / 365)
    days = (days - 1) % 365
  }
  let jm, jd
  if (days < 186) {
    jm = 1 + Math.floor(days / 31)
    jd = 1 + (days % 31)
  } else {
    jm = 7 + Math.floor((days - 186) / 30)
    jd = 1 + ((days - 186) % 30)
  }
  const date = `${jy}/${String(jm).padStart(2, '0')}/${String(jd).padStart(2, '0')}`
  const time = `${String(tehran.getHours()).padStart(2, '0')}:${String(tehran.getMinutes()).padStart(2, '0')}`
  return { date, time, dateTime: `${date} ${time}` }
}

/**
 * Group ownership_transfers into inbox batches for a user.
 * @param {string} userPhone
 * @param {'received'|'sent'|'all'} [direction='all']
 */
export function getTransferBatchesForUser(userPhone, direction = 'all') {
  const phone = normalizePhoneLocal(userPhone)
  if (!phone) return []

  const ackSet = new Set(
    (data.ownershipTransferAcks || [])
      .filter(a => normalizePhoneLocal(a.userPhone) === phone)
      .map(a => a.batchId)
  )

  const groups = new Map()

  for (const t of (data.ownershipTransfers || [])) {
    const from = normalizePhoneLocal(t.fromAdvisorPhone)
    const to = normalizePhoneLocal(t.toAdvisorPhone)
    const acted = normalizePhoneLocal(t.actedByPhone)
    const isReceived = to === phone
    const isSent = acted === phone || from === phone
    if (!isReceived && !isSent) continue

    const dirs = []
    if (isReceived) dirs.push('received')
    if (isSent) dirs.push('sent')

    for (const dir of dirs) {
      if (direction !== 'all' && direction !== dir) continue

      const batchId = transferBatchKey(t)
      // Sent multi-dest: one row per destination; received: one row per batch (to=me)
      const counterpartPhone = dir === 'received' ? from : to
      const groupId = dir === 'received'
        ? `${batchId}|received|${to}`
        : `${batchId}|sent|${to}`

      let g = groups.get(groupId)
      if (!g) {
        g = {
          id: groupId,
          batchId,
          direction: dir,
          fromAdvisorPhone: from,
          fromAdvisorName: t.fromAdvisorName || '',
          toAdvisorPhone: to,
          toAdvisorName: t.toAdvisorName || '',
          actedByPhone: acted,
          counterpartPhone,
          counterpartName: dir === 'received' ? (t.fromAdvisorName || '') : (t.toAdvisorName || ''),
          reason: t.reason || '',
          createdAt: t.createdAt,
          seen: dir === 'received' ? ackSet.has(batchId) : true,
          customers: []
        }
        groups.set(groupId, g)
      }

      const customer = (data.customers || []).find(c => c.id === t.customerId)
      const phoneSnap = t.customerPhone
        || (customer ? (normalizeCustomerPhonesLocal(customer)[0] || customer.phone || '') : '')
      g.customers.push({
        customerId: t.customerId,
        phone: phoneSnap,
        name: customer?.name || '',
        transferId: t.id
      })

      // Keep earliest createdAt as batch time; enrich names if missing
      if (t.createdAt && (!g.createdAt || new Date(t.createdAt) < new Date(g.createdAt))) {
        g.createdAt = t.createdAt
      }
      if (dir === 'received' && t.fromAdvisorName && !g.counterpartName) g.counterpartName = t.fromAdvisorName
      if (dir === 'sent' && t.toAdvisorName && !g.counterpartName) g.counterpartName = t.toAdvisorName
      if (t.fromAdvisorName) g.fromAdvisorName = g.fromAdvisorName || t.fromAdvisorName
      if (t.toAdvisorName) g.toAdvisorName = g.toAdvisorName || t.toAdvisorName
      if (t.reason && !g.reason) g.reason = t.reason
    }
  }

  const list = [...groups.values()].map(g => {
    const { date, time, dateTime } = formatTransferCreatedAt(g.createdAt)
    // Deduplicate customers by id
    const seenIds = new Set()
    const customers = []
    for (const c of g.customers) {
      if (seenIds.has(c.customerId)) continue
      seenIds.add(c.customerId)
      customers.push(c)
    }
    return {
      ...g,
      customers,
      count: customers.length,
      date,
      time,
      dateTime,
      reasonLabel: TRANSFER_REASON_LABELS[g.reason] || g.reason || '—'
    }
  })

  list.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
  return list
}

export function countUnreadReceivedBatches(userPhone) {
  return getTransferBatchesForUser(userPhone, 'received').filter(b => !b.seen).length
}

function latestTransferMatch(customerId, predicate) {
  let latest = null
  for (const t of (data.ownershipTransfers || [])) {
    if (t.customerId !== customerId) continue
    if (!predicate(t)) continue
    const at = t.createdAt ? new Date(t.createdAt).getTime() : 0
    if (!at || Number.isNaN(at)) continue
    if (!latest || at > latest.at) {
      latest = { at, batchId: transferBatchKey(t), transfer: t }
    }
  }
  return latest
}

/** True if customer was transferred TO user within the last `days` days (ignore ack). */
export function isRecentTransferredIn(customerId, userPhone, days = 7) {
  const phone = normalizePhoneLocal(userPhone)
  if (!phone || !customerId) return false
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  const latest = latestTransferMatch(
    customerId,
    t => normalizePhoneLocal(t.toAdvisorPhone) === phone
  )
  return !!(latest && latest.at >= cutoff)
}

/**
 * True if customer was transferred OUT by user within the last `days` days
 * (acted_by or previous owner = user).
 */
export function isRecentTransferredOut(customerId, userPhone, days = 7) {
  const phone = normalizePhoneLocal(userPhone)
  if (!phone || !customerId) return false
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  const latest = latestTransferMatch(
    customerId,
    t => {
      const from = normalizePhoneLocal(t.fromAdvisorPhone)
      const acted = normalizePhoneLocal(t.actedByPhone)
      return acted === phone || from === phone
    }
  )
  return !!(latest && latest.at >= cutoff)
}

/** Unacked incoming transfer within `days` — used for row badge emphasis. */
export function isUnreadTransferredIn(customerId, userPhone, days = 7) {
  const phone = normalizePhoneLocal(userPhone)
  if (!phone || !customerId) return false
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  const ackSet = new Set(
    (data.ownershipTransferAcks || [])
      .filter(a => normalizePhoneLocal(a.userPhone) === phone)
      .map(a => a.batchId)
  )
  const latest = latestTransferMatch(
    customerId,
    t => normalizePhoneLocal(t.toAdvisorPhone) === phone
  )
  if (!latest || latest.at < cutoff) return false
  return !ackSet.has(latest.batchId)
}

export async function markTransferBatchSeen(batchId, userPhone) {
  const phone = normalizePhoneLocal(userPhone)
  const bid = String(batchId || '').trim()
  if (!phone || !bid || bid.startsWith('single_')) {
    // Still allow ack for synthetic single_* keys locally even if DB rejects weird ids
  }
  if (!phone || !bid) return null

  const existing = (data.ownershipTransferAcks || []).find(
    a => normalizePhoneLocal(a.userPhone) === phone && a.batchId === bid
  )
  if (existing) return existing

  const row = { user_phone: phone, batch_id: bid }
  const { data: inserted, error } = await supabase
    .from('ownership_transfer_acks')
    .upsert(row, { onConflict: 'user_phone,batch_id' })
    .select('*')
    .single()

  if (error) {
    if (/ownership_transfer_acks|does not exist|relation/i.test(error.message || '')) {
      console.warn('ownership_transfer_acks save skipped (migration 009?):', error.message)
      const local = { id: `local_${Date.now()}`, userPhone: phone, batchId: bid, seenAt: new Date().toISOString() }
      if (!Array.isArray(data.ownershipTransferAcks)) data.ownershipTransferAcks = []
      data.ownershipTransferAcks.push(local)
      return local
    }
    throw new Error('خطا در علامت‌گذاری انتقال: ' + error.message)
  }

  const mapped = mapOwnershipTransferAckRow(inserted)
  if (!Array.isArray(data.ownershipTransferAcks)) data.ownershipTransferAcks = []
  data.ownershipTransferAcks.push(mapped)
  return mapped
}

// ============================================
// Ownership transfers
// ============================================

export async function saveOwnershipTransferToDB(transfer) {
  const row = {
    customer_id: transfer.customerId,
    customer_phone: transfer.customerPhone || null,
    from_advisor_phone: transfer.fromAdvisorPhone || null,
    from_advisor_name: transfer.fromAdvisorName || null,
    to_advisor_phone: transfer.toAdvisorPhone || null,
    to_advisor_name: transfer.toAdvisorName || null,
    acted_by_phone: transfer.actedByPhone || null,
    batch_id: transfer.batchId || null,
    reason: transfer.reason || null,
    customer_status_at_transfer: transfer.customerStatusAtTransfer || null
  }
  let { data: inserted, error } = await supabase
    .from('ownership_transfers')
    .insert(row)
    .select('*')
    .single()
  // Graceful fallback before migration 009 is applied
  if (error && /customer_phone/i.test(error.message || '')) {
    const { customer_phone: _omit, ...legacy } = row
    ;({ data: inserted, error } = await supabase
      .from('ownership_transfers')
      .insert(legacy)
      .select('*')
      .single())
  }
  if (error) throw new Error('خطا در ثبت انتقال: ' + error.message)
  return mapOwnershipTransferRow(inserted)
}

// ============================================
// Refunds (عودت وجه)
// ============================================

export function mapRefundRow(row) {
  if (!row) return null
  return {
    id: row.id,
    customerId: row.customer_id,
    productIndex: row.product_index ?? 0,
    productName: row.product_name || '',
    paymentId: row.payment_id || '',
    amount: parseFloat(row.amount) || 0,
    isFullPayment: !!row.is_full_payment,
    status: row.status || 'requested',
    note: row.note || '',
    reason: row.refund_reason || '',
    accountInfo: row.account_info || '',
    accountHolderName: row.account_holder_name || '',
    sheba: row.sheba || '',
    cardNumber: row.card_number || '',
    rejectReason: row.reject_reason || '',
    advisorPhone: row.advisor_phone || '',
    customerName: row.customer_name || '',
    createdByPhone: row.created_by_phone || '',
    createdByName: row.created_by_name || '',
    updatedByPhone: row.updated_by_phone || '',
    completedByPhone: row.completed_by_phone || '',
    requestedAt: row.requested_at || row.created_at || null,
    awaitingAt: row.awaiting_at || null,
    completedAt: row.completed_at || null,
    archivedAt: row.archived_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  }
}

export function getRefunds() {
  return Array.isArray(data.refunds) ? data.refunds : []
}

function upsertMappedRefund(mapped) {
  if (!mapped?.id && mapped?.id !== 0) return null
  if (!Array.isArray(data.refunds)) data.refunds = []
  const idx = data.refunds.findIndex(r => String(r.id) === String(mapped.id))
  if (idx >= 0) data.refunds[idx] = mapped
  else data.refunds.unshift(mapped)
  return mapped
}

/** Insert or replace a refund from a DB row. Returns false if row invalid. */
export function upsertRefundInCache(dbRow) {
  const mapped = mapRefundRow(dbRow)
  if (!mapped?.id && mapped?.id !== 0) return false
  upsertMappedRefund(mapped)
  return true
}

export function removeRefundFromCache(id) {
  if (id == null || id === '') return false
  const before = (data.refunds || []).length
  data.refunds = (data.refunds || []).filter(r => String(r.id) !== String(id))
  return (data.refunds || []).length !== before
}

export async function saveRefundToDB(refund) {
  const row = {
    customer_id: refund.customerId,
    product_index: refund.productIndex ?? 0,
    product_name: refund.productName || '',
    payment_id: refund.paymentId,
    amount: refund.amount,
    is_full_payment: !!refund.isFullPayment,
    status: refund.status || 'requested',
    note: refund.note || '',
    refund_reason: refund.reason || '',
    account_info: refund.accountInfo || '',
    account_holder_name: refund.accountHolderName || '',
    sheba: refund.sheba || '',
    card_number: refund.cardNumber || '',
    reject_reason: refund.rejectReason || '',
    advisor_phone: refund.advisorPhone || null,
    customer_name: refund.customerName || '',
    created_by_phone: refund.createdByPhone || null,
    created_by_name: refund.createdByName || null,
    updated_by_phone: refund.updatedByPhone || null,
    completed_by_phone: refund.completedByPhone || null,
    requested_at: refund.requestedAt || new Date().toISOString(),
    awaiting_at: refund.awaitingAt || null,
    completed_at: refund.completedAt || null
  }
  const { data: inserted, error } = await supabase
    .from('refunds')
    .insert(row)
    .select('*')
    .single()
  if (error) throw new Error('خطا در ثبت عودت: ' + error.message)
  bumpLocalWrite()
  return upsertMappedRefund(mapRefundRow(inserted))
}

export async function updateRefundInDB(id, patch) {
  const row = { updated_at: new Date().toISOString() }
  if (patch.status != null) row.status = patch.status
  if (patch.note != null) row.note = patch.note
  if (patch.reason != null) row.refund_reason = patch.reason
  if (patch.accountInfo != null) row.account_info = patch.accountInfo
  if (patch.accountHolderName != null) row.account_holder_name = patch.accountHolderName
  if (patch.sheba != null) row.sheba = patch.sheba
  if (patch.cardNumber != null) row.card_number = patch.cardNumber
  if (patch.rejectReason != null) row.reject_reason = patch.rejectReason
  if (patch.updatedByPhone != null) row.updated_by_phone = patch.updatedByPhone
  if (patch.completedByPhone != null) row.completed_by_phone = patch.completedByPhone
  if (Object.prototype.hasOwnProperty.call(patch, 'requestedAt')) {
    row.requested_at = patch.requestedAt
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'awaitingAt')) {
    row.awaiting_at = patch.awaitingAt
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'completedAt')) {
    row.completed_at = patch.completedAt
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'archivedAt')) {
    row.archived_at = patch.archivedAt
  }
  const { data: updated, error } = await supabase
    .from('refunds')
    .update(row)
    .eq('id', id)
    .select('*')
    .single()
  if (error) throw new Error('خطا در به‌روزرسانی عودت: ' + error.message)
  bumpLocalWrite()
  return upsertMappedRefund(mapRefundRow(updated))
}

export async function refreshRefundsFromDB() {
  const res = await fetchAllRows('refunds', { orderCol: 'id', ascending: false })
  if (res.error) {
    if (/refunds|does not exist|relation/i.test(res.error.message || '')) {
      data.refunds = []
      return data.refunds
    }
    throw new Error('خطا در بارگذاری عودت‌ها: ' + res.error.message)
  }
  data.refunds = (res.data || []).map(mapRefundRow)
  return data.refunds
}

// ============================================
// Save followup to Supabase
// ============================================

export async function saveFollowupToDB(followup) {
  const isDoneNote = followup.status === 'done' ||
    followup.type === 'پیگیری انجام‌شده' ||
    followup.type === 'پیگیری معوقه انجام‌شده'

  const baseRow = {
    customer_id: followup.customerId,
    date: followup.date,
    type: followup.type,
    result: followup.result,
    next_date: followup.nextDate || '',
    notes: followup.notes,
    created_by_phone: followup.createdByPhone || null
  }

  // Prefer writing status/done columns when present; fall back on any schema error
  if (isDoneNote || followup.status || followup.doneAt || followup.wasOverdue) {
    const full = await supabase.from('followups').insert({
      ...baseRow,
      status: followup.status || 'pending',
      done_at: followup.doneAt || null,
      done_by_phone: followup.doneByPhone || null,
      done_note: followup.doneNote || null,
      was_overdue: !!followup.wasOverdue
    }).select('id').single()

    if (!full.error) {
      bumpLocalWrite()
      return full.data ? full.data.id : null
    }

    // Fallback without optional columns
    const fallback = await supabase.from('followups').insert(baseRow).select('id').single()
    if (fallback.error) throw new Error('خطا در درج پیگیری: ' + fallback.error.message)
    bumpLocalWrite()
    return fallback.data ? fallback.data.id : null
  }

  const { data: inserted, error } = await supabase.from('followups').insert(baseRow).select('id').single()
  if (error) throw new Error('خطا در درج پیگیری: ' + error.message)
  bumpLocalWrite()
  return inserted ? inserted.id : null
}

export async function updateFollowupInDB(followup) {
  if (!followup.id) return
  const row = {
    customer_id: followup.customerId,
    date: followup.date,
    type: followup.type,
    result: followup.result,
    next_date: followup.nextDate,
    notes: followup.notes
  }
  if (followup.createdByPhone !== undefined) {
    row.created_by_phone = followup.createdByPhone || null
  }
  const { error } = await supabase.from('followups').update(row).eq('id', followup.id)
  if (error) throw new Error('خطا در ویرایش پیگیری: ' + error.message)
  bumpLocalWrite()
}

// ============================================
// Delete followup from Supabase
// ============================================

export async function markFollowupDoneInDB(id, { doneAt, doneByPhone, doneNote, wasOverdue }) {
  const { error } = await supabase.from('followups').update({
    status: 'done',
    done_at: doneAt,
    done_by_phone: doneByPhone,
    done_note: doneNote,
    was_overdue: !!wasOverdue
  }).eq('id', id)
  if (error) throw new Error('خطا در ثبت انجام پیگیری: ' + error.message)
  bumpLocalWrite()
}

export async function deleteFollowupFromDB(id) {
  const { error } = await supabase.from('followups').delete().eq('id', id)
  if (error) throw new Error('خطا در حذف پیگیری: ' + error.message)
  bumpLocalWrite()
}

// ============================================
// Update followups customer ID (for LD↔CS conversion)
// ============================================

export async function updateFollowupsCustomerId(oldId, newId) {
  // Update customer_id directly instead of delete+re-insert
  const { error } = await supabase.from('followups').update({ customer_id: newId }).eq('customer_id', oldId)
  if (error) throw new Error('خطا در بروزرسانی پیگیری‌ها: ' + error.message)
  bumpLocalWrite()
}

// ============================================
// Save app setting
// ============================================

export async function saveSetting(key, value) {
  const { error } = await supabase.from('app_settings').upsert({ key, value }, { onConflict: 'key' })
  if (error) throw new Error('خطا در ذخیره تنظیمات: ' + error.message)
}

export function getSaleToastEnabled() {
  return data.saleToastEnabled !== false
}

export function setSaleToastEnabledLocal(enabled) {
  data.saleToastEnabled = !!enabled
}

export async function saveSaleToastEnabled(enabled) {
  data.saleToastEnabled = !!enabled
  await saveSetting('sale_toast_enabled', !!enabled)
}

export function getSmsPanel() {
  return normalizeSmsPanel(data.smsPanel)
}

export async function saveSmsPanel(config) {
  const cleaned = normalizeSmsPanel(config)
  data.smsPanel = cleaned
  await saveSetting('sms_panel', cleaned)
}

// ============================================
// Generate next ID
// ============================================

// High-water mark so deleted IDs are never reused (DATA-H3)
async function getNextIdNumber(prefix) {
  const counterKey = `id_counter_${prefix}`

  const [{ data: settingsRows }, { data: rows, error: idsError }] = await Promise.all([
    supabase.from('app_settings').select('value').eq('key', counterKey).limit(1),
    fetchAllRows('customers', {
      select: 'id',
      orderCol: 'id',
      apply: q => q.like('id', prefix + '%')
    })
  ])

  if (idsError) throw new Error('خطا در خواندن شناسه‌ها: ' + idsError.message)

  const stored = settingsRows?.[0]?.value != null ? parseInt(settingsRows[0].value, 10) : 0
  const existingIds = (rows || [])
    .map(c => parseInt(c.id.slice(2), 10))
    .filter(n => !isNaN(n))
  const maxExisting = existingIds.length > 0 ? Math.max(...existingIds) : 0

  // Never go below the highest ID ever issued or still present
  return Math.max(stored || 0, maxExisting) + 1
}

/** Preview next ID without consuming it */
export async function peekNextId(type) {
  const prefix = type === 'CS' ? 'CS' : 'LD'
  const nextNum = await getNextIdNumber(prefix)
  return prefix + String(nextNum).padStart(4, '0')
}

export async function generateId(type) {
  const prefix = type === 'CS' ? 'CS' : 'LD'
  const nextNum = await getNextIdNumber(prefix)
  await saveSetting(`id_counter_${prefix}`, nextNum)
  return prefix + String(nextNum).padStart(4, '0')
}

/**
 * Fill missing advisorPhone from users.display_name match (legacy rows).
 * Persists updates so ownership survives user recreation by phone.
 */
export async function backfillAdvisorPhones(users) {
  if (!users || !users.length) return { updated: 0 }

  const byName = new Map()
  users.forEach(u => {
    const name = (u.display_name || `${u.first_name || ''} ${u.last_name || ''}`.trim() || '').trim()
    const phone = (u.phone || '').trim()
    if (name && phone) byName.set(name, phone)
  })

  let updated = 0
  for (const c of data.customers) {
    if (c.advisorPhone) continue
    if (!c.advisor) continue
    const phone = byName.get(c.advisor.trim())
    if (!phone) continue
    c.advisorPhone = phone
    try {
      await saveCustomerToDB(c)
      updated++
    } catch (e) {
      console.error('backfillAdvisorPhones error for', c.id, e)
    }
  }
  return { updated }
}
