// ============================================
// Data Layer (Supabase)
// ============================================

import { supabase } from './supabase.js'
import { invalidateDerivedCache } from './derived-cache.js'
import { getStoredTenantId } from './tenant.js'
import {
  isOfflineApp,
  readCoreSnapshot,
  writeCoreSnapshot
} from './data-cache.js'
import {
  normalizeSmsFeatures,
  normalizeFollowupDefaultHour,
  DEFAULT_SMS_TEMPLATES,
} from './sms-features.js'
import {
  sanitizeProfileFieldKeys,
  normalizeFieldFilledAt,
  backfillFieldFilledAtInMemory,
  applyFieldFilledAtOnSave
} from './customer-profile-fields.js'

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
    let isPrimary = false
    if (typeof item === 'string') {
      text = item.trim().replace(/\s+/g, ' ')
    } else if (item && typeof item === 'object') {
      text = String(item.text || item.address || '').trim().replace(/\s+/g, ' ')
      postalCode = toEnDigitsLocal(String(item.postalCode || item.postal || '').trim()).replace(/\s+/g, '')
      isPrimary = !!(item.isPrimary || item.primary)
    }
    if (!text) continue
    const key = `${text.toLowerCase()}|${postalCode}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ text, postalCode, isPrimary })
    if (out.length >= 2) break
  }
  if (!out.length) return out
  let primaryIdx = out.findIndex(a => a.isPrimary)
  if (primaryIdx < 0) primaryIdx = 0
  out.forEach((a, i) => { a.isPrimary = i === primaryIdx })
  return out
}

function emptyCoreData() {
  return {
    customers: [],
    followups: [],
    ownershipTransfers: [],
    ownershipTransferAcks: [],
    refunds: [],
    convertedCount: 0,
    destinationBanks: [],
    productCatalog: [],
    productBundles: [],
    inPersonSessions: [],
    eventMessageTypes: [],
    platforms: [],
    statuses: [],
    customerCodes: [],
    customerCodeExpiryMonths: 3,
    salesTargets: [],
    salesTargetDeadlineUrgency: null,
    saleToastEnabled: false,
    dmChatEnabled: false,
    requireFollowupOnCreate: false,
    /** When true, conversion-card sales amount also respects dashboard date range. */
    dashConversionAmountInRange: true,
    opsDigestEnabled: true,
    smsPanel: null,
    smsFeatures: null,
    smsFollowupDefaultHour: '10:00',
    shippingSender: null
  }
}

let data = emptyCoreData()

/** Placeholders for SMS settings form — not auto-persisted for new tenants. */
export const DEFAULT_SMS_PANEL = {
  username: '',
  password: '',
  sender: '',
  apiUrl: 'https://rest.payamak-panel.com/api/SmartSMS/Send',
  messageTemplate: 'کد تأیید شما: {code}\n اعتبار: ۵ دقیقه'
}

const EMPTY_SMS_PANEL = {
  username: '',
  password: '',
  sender: '',
  apiUrl: '',
  messageTemplate: ''
}

/** Normalize stored SMS config. Missing/partial values stay blank (no silent defaults). */
export function normalizeSmsPanel(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...EMPTY_SMS_PANEL }
  return {
    username: String(raw.username ?? '').trim(),
    password: String(raw.password ?? ''),
    sender: String(raw.sender ?? '').trim(),
    apiUrl: String(raw.apiUrl ?? '').trim(),
    messageTemplate: String(raw.messageTemplate ?? '').trim()
  }
}

const EMPTY_SHIPPING_SENDER = {
  name: '',
  phone: '',
  address: '',
  postalCode: '',
  logoDataUrl: null,
  orientation: 'portrait'
}

/** Normalize stored shipping-label sender profile. */
export function normalizeShippingSender(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...EMPTY_SHIPPING_SENDER }
  const logo = raw.logoDataUrl
  const logoDataUrl = (typeof logo === 'string' && logo.startsWith('data:image/')) ? logo : null
  const orientation = raw.orientation === 'landscape' ? 'landscape' : 'portrait'
  return {
    name: String(raw.name ?? '').trim(),
    phone: String(raw.phone ?? '').trim(),
    address: String(raw.address ?? '').trim().replace(/\s+/g, ' '),
    postalCode: String(raw.postalCode ?? '').trim().replace(/\s+/g, ''),
    logoDataUrl,
    orientation
  }
}

/** Starter pack for settings UI «بارگذاری پیش‌فرض» — not applied on boot. */
export const DEFAULT_PLATFORMS = [
  { key: 'instagram', label: 'اینستاگرام', color: '#E1306C', linkTemplate: 'https://instagram.com/{id}' },
  { key: 'telegram', label: 'تلگرام', color: '#0088cc', linkTemplate: 'https://telegram.me/{id}' },
  { key: 'whatsapp', label: 'واتساپ', color: '#25D366', linkTemplate: 'https://wa.me/{phone}' },
  { key: 'website', label: 'سایت', color: '#2563EB', linkTemplate: 'https://{id}' },
  { key: 'bale', label: 'بله', color: '#00A884', linkTemplate: 'https://ble.ir/{id}' },
  { key: 'eitaa', label: 'ایتا', color: '#F59E0B', linkTemplate: 'https://eitaa.com/{id}' },
  { key: 'goftino', label: 'گفتینو', color: '#6366F1', linkTemplate: '' },
  { key: 'outbound_call', label: 'تماس خروجی', color: '#0155d2', linkTemplate: '' },
  { key: 'rubika', label: 'روبیکا', color: '#A855F7', linkTemplate: '' },
  { key: 'referral', label: 'ارجاعی', color: '#78716C', linkTemplate: '' },
]

/** Starter pack for settings UI «بارگذاری پیش‌فرض» — not applied on boot. */
export const DEFAULT_STATUSES = [
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

export function getDefaultPlatforms() {
  return DEFAULT_PLATFORMS.map(p => ({ ...p }))
}

export function getDefaultStatuses() {
  return DEFAULT_STATUSES.map(s => ({ ...s }))
}

/** Admin-defined customer codes (کد مشتری); empty until configured in settings */
const DEFAULT_CUSTOMER_CODES = []

/** Default TTL (months) for newly defined customer codes; 0 = never expire */
export const DEFAULT_CUSTOMER_CODE_EXPIRY_MONTHS = 3

export function normalizeCustomerCodeExpiryMonths(raw) {
  if (raw == null || raw === '') return DEFAULT_CUSTOMER_CODE_EXPIRY_MONTHS
  // app_settings may store a bare number or a JSON object
  const n = Number(typeof raw === 'object' && raw !== null && 'months' in raw ? raw.months : raw)
  if (!Number.isFinite(n)) return DEFAULT_CUSTOMER_CODE_EXPIRY_MONTHS
  return Math.max(0, Math.min(120, Math.round(n)))
}

/** Add calendar months to an ISO timestamp (local time). */
export function addCalendarMonthsIso(iso, months) {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return null
  const m = Number(months)
  if (!Number.isFinite(m) || m <= 0) return null
  const day = d.getDate()
  d.setMonth(d.getMonth() + m)
  if (d.getDate() < day) d.setDate(0)
  return d.toISOString()
}

function isCustomerCodeExpired(code, nowMs = Date.now()) {
  if (!code?.expiresAt) return false
  const t = new Date(code.expiresAt).getTime()
  return Number.isFinite(t) && t <= nowMs
}

/** Legacy Carno catalog names (kept for reference / import helpers; not auto-seeded) */
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

/** Resolve catalog isEvent; legacy entries without the flag used «حضوری» in the name. */
function resolveCatalogIsEvent(raw, name) {
  if (typeof raw?.isEvent === 'boolean') return raw.isEvent
  return String(name || '').includes('حضوری')
}

/** Normalize one catalog entry (string legacy, profitMode legacy, or productKind). */
export function normalizeCatalogEntry(raw) {
  if (typeof raw === 'string') {
    const name = raw.trim()
    if (!name || name.toLowerCase() === '[object object]') return null
    return {
      name,
      productKind: PRODUCT_KIND.educational,
      allowGift: false,
      isEvent: resolveCatalogIsEvent(null, name)
    }
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

  const entry = {
    name,
    productKind,
    allowGift: raw.allowGift === true,
    isEvent: resolveCatalogIsEvent(raw, name)
  }
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

import {
  CUSTOMER_LIST_SELECT,
  CUSTOMER_DETAIL_SELECT,
  FOLLOWUP_SELECT,
  REFUND_SELECT,
  OWNERSHIP_TRANSFER_SELECT,
  OWNERSHIP_ACK_SELECT
} from './backup/backup-selects.js'

export {
  CUSTOMER_LIST_SELECT,
  CUSTOMER_DETAIL_SELECT,
  FOLLOWUP_SELECT,
  REFUND_SELECT,
  OWNERSHIP_TRANSFER_SELECT,
  OWNERSHIP_ACK_SELECT
} from './backup/backup-selects.js'

function normalizeProductsFromDb(products) {
  if (!Array.isArray(products)) return []
  return products.map(p => {
    if (!p || typeof p !== 'object') return p
    const name = coerceProductName(p.name)
    return name === p.name ? p : { ...p, name }
  })
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
  const hasNotes = Object.prototype.hasOwnProperty.call(c, 'notes')
  const hasProducts = Object.prototype.hasOwnProperty.call(c, 'products')
  const products = hasProducts ? normalizeProductsFromDb(c.products) : []
  const productCount = hasProducts
    ? products.length
    : (c.product_count != null ? Number(c.product_count) || 0 : 0)
  const mapped = {
    id,
    platformId: c.platform_id || '',
    platform: c.platform ?? 'instagram',
    name: c.name || '',
    nameEn: c.name_en || '',
    nationalId: c.national_id || '',
    birthDate: c.birth_date || '',
    phones,
    phone: phones[0] || '',
    addresses,
    status: c.status || 'new',
    notes: hasNotes ? (c.notes || '') : '',
    advisor: c.advisor || '',
    advisorPhone: c.advisor_phone || '',
    nextFollowupDate: c.next_followup_date || '',
    products,
    productCount,
    createdAt: c.created_at || null,
    updatedAt: c.updated_at || null,
    customerLevel: c.customer_level || '',
    customerLevelLocked: !!c.customer_level_locked,
    referredByPhone: c.referred_by_phone || '',
    customerCode: c.customer_code || '',
    fieldFilledAt: normalizeFieldFilledAt(c.field_filled_at),
    _detailsLoaded: hasNotes,
    _productsLoaded: hasProducts
  }
  return backfillFieldFilledAtInMemory(mapped)
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
    productName: f.product_name || '',
    notes: f.notes || '',
    createdByPhone: f.created_by_phone || '',
    status: f.status || 'pending',
    doneAt: f.done_at || '',
    doneByPhone: f.done_by_phone || '',
    doneNote: f.done_note || '',
    wasOverdue: !!f.was_overdue,
    assignedToPhone: f.assigned_to_phone || '',
    assignedByPhone: f.assigned_by_phone || '',
    assignedAt: f.assigned_at || ''
  }
}

/** Insert or replace a customer object in cache, collapsing any same-id copies. */
export function putCustomerInCache(customer) {
  if (!customer) return false
  const id = normalizeCustomerId(customer.id)
  if (!id) return false
  customer.id = id
  // Local app writes always carry notes + products; treat as fully loaded.
  if (customer._detailsLoaded == null) customer._detailsLoaded = true
  if (customer._productsLoaded == null) customer._productsLoaded = true
  if (customer.productCount == null && Array.isArray(customer.products)) {
    customer.productCount = customer.products.length
  }
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
  invalidateProductSalesCountCache()
  return true
}

/** Insert or replace a customer in the in-memory cache. Returns false if row invalid. */
export function upsertCustomerInCache(dbRow) {
  const mapped = mapCustomerFromDb(dbRow)
  if (!mapped) return false
  const hasNotes = dbRow && Object.prototype.hasOwnProperty.call(dbRow, 'notes')
  const hasProducts = dbRow && Object.prototype.hasOwnProperty.call(dbRow, 'products')
  const existing = data.customers.find(c => normalizeCustomerId(c.id) === mapped.id)
  if (!hasNotes && existing) {
    mapped.notes = existing.notes || ''
    mapped._detailsLoaded = !!existing._detailsLoaded
  }
  if (!hasProducts && existing) {
    mapped.products = existing.products || []
    mapped._productsLoaded = !!existing._productsLoaded
    if (mapped.productCount == null || mapped.productCount === 0) {
      mapped.productCount = existing.productCount ?? mapped.productCount
    }
  }
  return putCustomerInCache(mapped)
}

export function removeCustomerFromCache(id) {
  const nid = normalizeCustomerId(id)
  if (!nid) return false
  const before = data.customers.length
  data.customers = data.customers.filter(c => normalizeCustomerId(c.id) !== nid)
  if (data.customers.length !== before) invalidateProductSalesCountCache()
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
  invalidateDerivedCache('followups')
  return true
}

export function removeFollowupFromCache(id) {
  if (id == null || id === '') return false
  const nid = Number(id)
  const before = data.followups.length
  data.followups = data.followups.filter(f => Number(f.id) !== nid)
  if (data.followups.length !== before) invalidateDerivedCache('followups')
  return data.followups.length !== before
}

// ============================================
// Load / sync data from Supabase (egress-aware)
// ============================================

/** PostgREST/Supabase silently caps each response at 1000 rows by default. */
const SUPABASE_PAGE_SIZE = 1000

function emptySyncMeta() {
  return {
    customersAt: null,
    followupsAt: null,
    refundsAt: null,
    transfersAt: null,
    acksAt: null,
    supportsUpdatedAt: null // null unknown | true | false
  }
}

/** Watermarks for incremental sync (ISO strings). */
let syncMeta = emptySyncMeta()

/** @type {{ tenantId: string, userPhone: string, permSig: string } | null} */
let cacheIdentity = null
const PERSIST_DEBOUNCE_MS = 1500
let persistTimer = null

export function setCoreCacheIdentity(identity) {
  cacheIdentity = identity && identity.tenantId && identity.userPhone
    ? {
        tenantId: String(identity.tenantId),
        userPhone: String(identity.userPhone),
        permSig: identity.permSig || ''
      }
    : null
}

export function getSyncMeta() {
  return { ...syncMeta }
}

function sanitizePayloadForCache(src) {
  const copy = typeof structuredClone === 'function'
    ? structuredClone(src)
    : JSON.parse(JSON.stringify(src))
  if (copy.smsPanel && typeof copy.smsPanel === 'object') {
    copy.smsPanel = { ...copy.smsPanel, password: '' }
  }
  return copy
}

async function persistCoreCacheNow() {
  if (isOfflineApp() || !cacheIdentity?.tenantId || !cacheIdentity?.userPhone) return
  try {
    await writeCoreSnapshot({
      tenantId: cacheIdentity.tenantId,
      userPhone: cacheIdentity.userPhone,
      permSig: cacheIdentity.permSig,
      syncMeta: { ...syncMeta },
      payload: sanitizePayloadForCache(data)
    })
  } catch (e) {
    console.warn('persist core cache', e)
  }
}

export function schedulePersistCoreCache() {
  if (isOfflineApp() || !cacheIdentity) return
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    persistCoreCacheNow()
  }, PERSIST_DEBOUNCE_MS)
}

export function resetCoreData() {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  cacheIdentity = null
  const next = emptyCoreData()
  for (const key of Object.keys(next)) data[key] = next[key]
  syncMeta = emptySyncMeta()
  invalidateProductSalesCountCache()
  invalidateDerivedCache('all')
}

export function hydrateCoreData(snapshot) {
  const payload = snapshot?.payload
  if (!payload || typeof payload !== 'object') return false
  const defaults = emptyCoreData()
  for (const key of Object.keys(defaults)) {
    data[key] = payload[key] !== undefined ? payload[key] : defaults[key]
  }
  syncMeta = {
    ...emptySyncMeta(),
    ...(snapshot.syncMeta && typeof snapshot.syncMeta === 'object' ? snapshot.syncMeta : {})
  }
  invalidateProductSalesCountCache()
  invalidateDerivedCache('all')
  try { injectDynamicStyles() } catch (e) {
    console.warn('injectDynamicStyles after hydrate', e)
  }
  return true
}

/**
 * Bind cache identity and hydrate RAM from IndexedDB when the snapshot matches.
 * @returns {Promise<boolean>}
 */
export async function tryHydrateFromCoreCache({ tenantId, userPhone, permSig }) {
  setCoreCacheIdentity({ tenantId, userPhone, permSig })
  if (isOfflineApp() || !tenantId || !userPhone) return false
  const snapshot = await readCoreSnapshot({ tenantId, userPhone, permSig })
  if (!snapshot) return false
  if (!snapshot.syncMeta?.customersAt || snapshot.syncMeta.supportsUpdatedAt === false) return false
  if (!hydrateCoreData(snapshot)) return false
  dataLoadState = { status: 'ready', error: null }
  try {
    const { scheduleCustomerLevelResync } = await import('./customer-level-sync.js')
    scheduleCustomerLevelResync()
  } catch (e) {
    console.error('customer level resync after hydrate:', e)
  }
  return true
}

function maxIsoTimestamp(...values) {
  let max = null
  for (const v of values) {
    if (!v) continue
    const s = typeof v === 'string' ? v : (v instanceof Date ? v.toISOString() : String(v))
    if (!s) continue
    if (!max || s > max) max = s
  }
  return max
}

function maxUpdatedAtFromRows(rows, ...keys) {
  let max = null
  for (const row of rows || []) {
    for (const key of keys) {
      max = maxIsoTimestamp(max, row?.[key])
    }
  }
  return max
}

function isMissingUpdatedAtError(error) {
  const msg = error?.message || ''
  return /updated_at/i.test(msg) && (/column|does not exist|schema cache/i.test(msg))
}

function bumpWatermark(key, iso) {
  if (!iso) return
  syncMeta[key] = maxIsoTimestamp(syncMeta[key], iso)
}

function captureWatermarksFromFullLoad(raw) {
  const cAt = maxUpdatedAtFromRows(raw.customers, 'updated_at', 'created_at')
  const fAt = maxUpdatedAtFromRows(raw.followups, 'updated_at')
  const rAt = maxUpdatedAtFromRows(raw.refunds, 'updated_at', 'created_at')
  const tAt = maxUpdatedAtFromRows(raw.transfers, 'updated_at', 'created_at')
  const aAt = maxUpdatedAtFromRows(raw.acks, 'updated_at', 'seen_at')
  if (cAt) syncMeta.customersAt = cAt
  if (fAt) syncMeta.followupsAt = fAt
  if (rAt) syncMeta.refundsAt = rAt
  if (tAt) syncMeta.transfersAt = tAt
  if (aAt) syncMeta.acksAt = aAt
  // If migration applied, customers/followups should have updated_at on rows
  if (raw.customers?.length && raw.customers.some(r => r.updated_at)) {
    syncMeta.supportsUpdatedAt = true
  } else if (raw.customers?.length) {
    // No updated_at in payload — either omitted from select or missing column
    syncMeta.supportsUpdatedAt = syncMeta.supportsUpdatedAt === true ? true : null
  }
}

/**
 * Fetch every row from a table by paging past the 1000-row default limit.
 * @param {string} table
 * @param {object} [opts]
 * @param {string} [opts.select]
 * @param {string} [opts.orderCol]
 * @param {boolean} [opts.ascending]
 * @param {boolean} [opts.scopeTenant] push tenant_id filter (helps planner + RLS)
 * @param {(q: any) => any} [opts.apply] mutate the query (filters, etc.)
 * @returns {Promise<{ data: any[], error: any }>}
 */
async function fetchAllRows(table, opts = {}) {
  const {
    select = '*',
    orderCol = 'id',
    ascending = true,
    scopeTenant = false,
    apply
  } = opts
  const tenantId = scopeTenant ? getStoredTenantId() : null
  const all = []
  let from = 0
  for (;;) {
    let q = supabase.from(table).select(select)
    if (tenantId) q = q.eq('tenant_id', tenantId)
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

async function fetchRowsSince(table, opts = {}) {
  const {
    select,
    orderCol = 'updated_at',
    since,
    sinceCol = 'updated_at',
    ascending = true,
    scopeTenant = false
  } = opts
  if (!since) {
    return fetchAllRows(table, { select, orderCol, ascending, scopeTenant })
  }
  return fetchAllRows(table, {
    select,
    orderCol,
    ascending,
    scopeTenant,
    apply: q => q.gte(sinceCol, since)
  })
}

function applySettingsRows(rows) {
  const settings = {}
  ;(rows || []).forEach(s => { settings[s.key] = s.value })
  data.convertedCount = settings.convertedCount || 0
  data.destinationBanks = normalizeDestinationBanks(settings.destination_banks)
  data.productCatalog = normalizeProductCatalog(settings.product_catalog)
  data.productBundles = normalizeProductBundles(settings.product_bundles)
  data.inPersonSessions = normalizeInPersonSessions(settings.in_person_sessions)
  data.eventMessageTypes = normalizeEventMessageTypes(settings.event_message_types)
  // Missing keys stay empty/off — do not seed DEFAULT_* for new tenants.
  data.platforms = Array.isArray(settings.platforms) ? settings.platforms : []
  data.statuses = Array.isArray(settings.statuses)
    ? [...settings.statuses].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    : []
  data.customerCodeExpiryMonths = normalizeCustomerCodeExpiryMonths(settings.customer_code_expiry_months)
  data.customerCodes = Array.isArray(settings.customer_codes)
    ? [...settings.customer_codes].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    : [...DEFAULT_CUSTOMER_CODES]
  data.saleToastEnabled = coerceAppSettingBool(settings.sale_toast_enabled, false)
  data.dmChatEnabled = coerceAppSettingBool(settings.dm_chat_enabled, false)
  data.requireFollowupOnCreate = coerceAppSettingBool(settings.require_followup_on_create, false)
  data.dashConversionAmountInRange = coerceAppSettingBool(settings.dash_conversion_amount_in_range, true)
  data.opsDigestEnabled = coerceAppSettingBool(settings.ops_digest_enabled, true)
  try {
    data.smsPanel = normalizeSmsPanel(settings.sms_panel)
  } catch (e) {
    console.error('normalizeSmsPanel error:', e)
    data.smsPanel = normalizeSmsPanel(null)
  }
  data.smsFeatures = normalizeSmsFeatures(settings.sms_features)
  data.smsFollowupDefaultHour = normalizeFollowupDefaultHour(settings.sms_followup_default_hour)
  try {
    data.shippingSender = normalizeShippingSender(settings.shipping_sender)
  } catch (e) {
    console.error('normalizeShippingSender error:', e)
    data.shippingSender = normalizeShippingSender(null)
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
}

export async function loadData() {
  dataLoadState = { status: 'loading', error: null }
  try {
    await loadDataInner()
    dataLoadState = { status: 'ready', error: null }
  } catch (e) {
    dataLoadState = { status: 'error', error: e?.message || String(e) }
    throw e
  }
}

async function loadDataInner() {
  const listSelectCustomers = CUSTOMER_LIST_SELECT
  const listSelectFollowups = FOLLOWUP_SELECT
  const tenantScope = { scopeTenant: true }

  let settingsQuery = supabase.from('app_settings').select('key,value')
  const bootTenantId = getStoredTenantId()
  if (bootTenantId) settingsQuery = settingsQuery.eq('tenant_id', bootTenantId)

  let [customersRes, followupsRes, settingsRes, transfersRes, acksRes, refundsRes] = await Promise.all([
    fetchAllRows('customers', { select: listSelectCustomers, orderCol: 'id', ...tenantScope }),
    fetchAllRows('followups', { select: listSelectFollowups, orderCol: 'id', ...tenantScope }),
    settingsQuery,
    fetchAllRows('ownership_transfers', { select: OWNERSHIP_TRANSFER_SELECT, orderCol: 'id', ascending: true, ...tenantScope }),
    fetchAllRows('ownership_transfer_acks', { select: OWNERSHIP_ACK_SELECT, orderCol: 'id', ...tenantScope }),
    fetchAllRows('refunds', { select: REFUND_SELECT, orderCol: 'id', ascending: false, ...tenantScope })
  ])

  // Fallback if updated_at not migrated yet
  if (customersRes.error && isMissingUpdatedAtError(customersRes.error)) {
    syncMeta.supportsUpdatedAt = false
    customersRes = await fetchAllRows('customers', {
      select: CUSTOMER_LIST_SELECT.replace(/,?updated_at/, ''),
      orderCol: 'id',
      ...tenantScope
    })
  }
  // Fallback before migration 024 (customer_code)
  if (customersRes.error && /customer_code/i.test(customersRes.error.message || '')) {
    customersRes = await fetchAllRows('customers', {
      select: CUSTOMER_LIST_SELECT.replace(/,?customer_code/, ''),
      orderCol: 'id',
      ...tenantScope
    })
  }
  // Fallback before migration 047 (name_en / national_id / birth_date)
  if (customersRes.error && /name_en|national_id|birth_date/i.test(customersRes.error.message || '')) {
    customersRes = await fetchAllRows('customers', {
      select: CUSTOMER_LIST_SELECT
        .replace(/,?name_en/, '')
        .replace(/,?national_id/, '')
        .replace(/,?birth_date/, '')
        .replace(/,?field_filled_at/, ''),
      orderCol: 'id',
      ...tenantScope
    })
  }
  // Fallback before migration 048 (field_filled_at)
  if (customersRes.error && /field_filled_at/i.test(customersRes.error.message || '')) {
    customersRes = await fetchAllRows('customers', {
      select: CUSTOMER_LIST_SELECT.replace(/,?field_filled_at/, ''),
      orderCol: 'id',
      ...tenantScope
    })
  }
  if (followupsRes.error && isMissingUpdatedAtError(followupsRes.error)) {
    syncMeta.supportsUpdatedAt = false
    followupsRes = await fetchAllRows('followups', {
      select: FOLLOWUP_SELECT.replace(/,?updated_at/, ''),
      orderCol: 'id',
      ...tenantScope
    })
  }

  let transfersData = transfersRes
  if (transfersRes.error && isMissingUpdatedAtError(transfersRes.error)) {
    transfersData = await fetchAllRows('ownership_transfers', {
      select: OWNERSHIP_TRANSFER_SELECT.replace(/,?updated_at/, ''),
      orderCol: 'id',
      ascending: true,
      ...tenantScope
    })
  } else if (transfersRes.error && /column|schema cache/i.test(transfersRes.error.message || '')) {
    transfersData = await fetchAllRows('ownership_transfers', { orderCol: 'id', ascending: true, ...tenantScope })
  }

  let acksData = acksRes
  if (acksRes.error && isMissingUpdatedAtError(acksRes.error)) {
    acksData = await fetchAllRows('ownership_transfer_acks', {
      select: 'id,user_phone,batch_id,seen_at',
      orderCol: 'id',
      ...tenantScope
    })
  }

  let refundsData = refundsRes
  if (refundsRes.error && /column|does not exist|schema cache/i.test(refundsRes.error.message || '')) {
    refundsData = await fetchAllRows('refunds', { orderCol: 'id', ascending: false, ...tenantScope })
  }

  const errors = []
  if (customersRes.error) errors.push('مشتریان: ' + customersRes.error.message)
  if (followupsRes.error) errors.push('پیگیری‌ها: ' + followupsRes.error.message)
  if (settingsRes.error) errors.push('تنظیمات: ' + settingsRes.error.message)
  if (transfersData.error && !/ownership_transfers|does not exist|relation/i.test(transfersData.error.message || '')) {
    errors.push('انتقال‌ها: ' + transfersData.error.message)
  }
  if (acksData.error && !/ownership_transfer_acks|does not exist|relation/i.test(acksData.error.message || '')) {
    errors.push('تأیید انتقال‌ها: ' + acksData.error.message)
  }
  if (refundsData.error && !/refunds|does not exist|relation/i.test(refundsData.error.message || '')) {
    errors.push('عودت‌ها: ' + refundsData.error.message)
  }

  if (errors.length > 0) {
    throw new Error('خطا در بارگذاری داده‌ها:\n' + errors.join('\n'))
  }

  data.customers = dedupeCustomersById((customersRes.data || []).map(mapCustomerFromDb).filter(Boolean))
  invalidateProductSalesCountCache()
  data.followups = (followupsRes.data || []).map(mapFollowupFromDb).filter(Boolean)

  data.ownershipTransfers = (transfersData.error || !transfersData.data)
    ? []
    : transfersData.data.map(mapOwnershipTransferRow)

  data.ownershipTransferAcks = (acksData.error || !acksData.data)
    ? []
    : acksData.data.map(mapOwnershipTransferAckRow)

  data.refunds = (refundsData.error || !refundsData.data)
    ? []
    : refundsData.data.map(mapRefundRow)

  applySettingsRows(settingsRes.data)

  captureWatermarksFromFullLoad({
    customers: customersRes.data,
    followups: followupsRes.data,
    refunds: refundsData.data,
    transfers: transfersData.data,
    acks: acksData.data
  })

  try {
    const { scheduleCustomerLevelResync } = await import('./customer-level-sync.js')
    scheduleCustomerLevelResync()
  } catch (e) {
    console.error('customer level resync after load:', e)
  }

  schedulePersistCoreCache()
  return data
}

/**
 * Fetch customer notes (and refresh row) when opening detail panel.
 * List loads omit notes to cut egress.
 */
export async function ensureCustomerDetailsLoaded(id) {
  const nid = normalizeCustomerId(id)
  if (!nid) return null
  const existing = data.customers.find(c => normalizeCustomerId(c.id) === nid)
  if (!existing) return null
  if (existing._detailsLoaded) return existing

  let select = CUSTOMER_DETAIL_SELECT
  let { data: row, error } = await supabase
    .from('customers')
    .select(select)
    .eq('id', nid)
    .maybeSingle()

  if (error && isMissingUpdatedAtError(error)) {
    select = CUSTOMER_DETAIL_SELECT.replace(/,?updated_at/, '')
    ;({ data: row, error } = await supabase.from('customers').select(select).eq('id', nid).maybeSingle())
  }
  if (error) throw new Error('خطا در بارگذاری جزئیات مشتری: ' + error.message)
  if (!row) return existing
  upsertCustomerInCache(row)
  return data.customers.find(c => normalizeCustomerId(c.id) === nid) || existing
}

/**
 * Apply incremental changes since last watermarks. Falls back by throwing
 * missing-column errors for the caller to do a full load.
 */
export async function syncDataIncremental() {
  if (syncMeta.supportsUpdatedAt === false) {
    await loadData()
    return { mode: 'full', reason: 'no-updated-at' }
  }

  const sinceCustomers = syncMeta.customersAt
  const sinceFollowups = syncMeta.followupsAt
  const sinceRefunds = syncMeta.refundsAt
  const sinceTransfers = syncMeta.transfersAt
  const sinceAcks = syncMeta.acksAt

  // Without watermarks we cannot safely incremental-sync
  if (!sinceCustomers && !sinceFollowups) {
    await loadData()
    return { mode: 'full', reason: 'no-watermark' }
  }

  const [customersRes, followupsRes, settingsRes, transfersRes, acksRes, refundsRes] = await Promise.all([
    sinceCustomers
      ? fetchRowsSince('customers', { select: CUSTOMER_LIST_SELECT, since: sinceCustomers, orderCol: 'updated_at', scopeTenant: true })
      : Promise.resolve({ data: [], error: null }),
    sinceFollowups
      ? fetchRowsSince('followups', { select: FOLLOWUP_SELECT, since: sinceFollowups, orderCol: 'updated_at', scopeTenant: true })
      : Promise.resolve({ data: [], error: null }),
    (() => {
      let q = supabase.from('app_settings').select('key,value')
      const tid = getStoredTenantId()
      return tid ? q.eq('tenant_id', tid) : q
    })(),
    sinceTransfers
      ? fetchRowsSince('ownership_transfers', {
        select: OWNERSHIP_TRANSFER_SELECT,
        since: sinceTransfers,
        sinceCol: 'updated_at',
        orderCol: 'updated_at',
        scopeTenant: true
      })
      : fetchAllRows('ownership_transfers', { select: OWNERSHIP_TRANSFER_SELECT, orderCol: 'id', ascending: true, scopeTenant: true }),
    sinceAcks
      ? fetchRowsSince('ownership_transfer_acks', {
        select: OWNERSHIP_ACK_SELECT,
        since: sinceAcks,
        sinceCol: 'updated_at',
        orderCol: 'updated_at',
        scopeTenant: true
      })
      : fetchAllRows('ownership_transfer_acks', { select: OWNERSHIP_ACK_SELECT, orderCol: 'id', scopeTenant: true }),
    sinceRefunds
      ? fetchRowsSince('refunds', { select: REFUND_SELECT, since: sinceRefunds, orderCol: 'updated_at', scopeTenant: true })
      : Promise.resolve({ data: [], error: null })
  ])

  const maybeMissing = [customersRes, followupsRes, transfersRes, acksRes, refundsRes]
    .map(r => r.error)
    .filter(Boolean)
  if (maybeMissing.some(isMissingUpdatedAtError)) {
    syncMeta.supportsUpdatedAt = false
    await loadData()
    return { mode: 'full', reason: 'updated-at-missing' }
  }

  if (customersRes.error) throw new Error('مشتریان: ' + customersRes.error.message)
  if (followupsRes.error) throw new Error('پیگیری‌ها: ' + followupsRes.error.message)
  if (settingsRes.error) throw new Error('تنظیمات: ' + settingsRes.error.message)
  if (transfersRes.error && !/ownership_transfers|does not exist|relation/i.test(transfersRes.error.message || '')) {
    throw new Error('انتقال‌ها: ' + transfersRes.error.message)
  }
  if (acksRes.error && !/ownership_transfer_acks|does not exist|relation/i.test(acksRes.error.message || '')) {
    throw new Error('تأیید انتقال‌ها: ' + acksRes.error.message)
  }
  if (refundsRes.error && !/refunds|does not exist|relation/i.test(refundsRes.error.message || '')) {
    throw new Error('عودت‌ها: ' + refundsRes.error.message)
  }

  for (const row of customersRes.data || []) upsertCustomerInCache(row)
  for (const row of followupsRes.data || []) upsertFollowupInCache(row)
  for (const row of refundsRes.data || []) upsertRefundInCache(row)

  if (!transfersRes.error && transfersRes.data) {
    if (!sinceTransfers) {
      data.ownershipTransfers = transfersRes.data.map(mapOwnershipTransferRow)
    } else {
      for (const row of transfersRes.data) {
        const mapped = mapOwnershipTransferRow(row)
        const idx = data.ownershipTransfers.findIndex(t => Number(t.id) === Number(mapped.id))
        if (idx >= 0) data.ownershipTransfers[idx] = mapped
        else data.ownershipTransfers.push(mapped)
      }
    }
  }

  if (!acksRes.error && acksRes.data) {
    if (!sinceAcks) {
      data.ownershipTransferAcks = acksRes.data.map(mapOwnershipTransferAckRow)
    } else {
      for (const row of acksRes.data) {
        const mapped = mapOwnershipTransferAckRow(row)
        const idx = data.ownershipTransferAcks.findIndex(a => Number(a.id) === Number(mapped.id))
        if (idx >= 0) data.ownershipTransferAcks[idx] = mapped
        else data.ownershipTransferAcks.push(mapped)
      }
    }
  }

  applySettingsRows(settingsRes.data)

  bumpWatermark('customersAt', maxUpdatedAtFromRows(customersRes.data, 'updated_at', 'created_at'))
  bumpWatermark('followupsAt', maxUpdatedAtFromRows(followupsRes.data, 'updated_at'))
  bumpWatermark('refundsAt', maxUpdatedAtFromRows(refundsRes.data, 'updated_at', 'created_at'))
  bumpWatermark('transfersAt', maxUpdatedAtFromRows(transfersRes.data, 'updated_at', 'created_at'))
  bumpWatermark('acksAt', maxUpdatedAtFromRows(acksRes.data, 'updated_at', 'seen_at'))
  syncMeta.supportsUpdatedAt = true

  {
    const touched = []
    for (const row of customersRes.data || []) {
      if (row?.id) touched.push(row.id)
    }
    for (const row of followupsRes.data || []) {
      if (row?.customer_id) touched.push(row.customer_id)
    }
    if (touched.length) {
      try {
        const { scheduleCustomerLevelResyncForIds } = await import('./customer-level-sync.js')
        scheduleCustomerLevelResyncForIds(touched)
      } catch (e) {
        console.error('customer level resync after incremental:', e)
      }
    }
  }

  schedulePersistCoreCache()

  return {
    mode: 'incremental',
    counts: {
      customers: (customersRes.data || []).length,
      followups: (followupsRes.data || []).length,
      refunds: (refundsRes.data || []).length,
      transfers: (transfersRes.data || []).length,
      acks: (acksRes.data || []).length
    }
  }
}

/**
 * Lightweight delete reconciliation — only fetches id columns.
 */
export async function reconcileDeletedRows() {
  const [customersRes, followupsRes, refundsRes] = await Promise.all([
    fetchAllRows('customers', { select: 'id', orderCol: 'id', scopeTenant: true }),
    fetchAllRows('followups', { select: 'id', orderCol: 'id', scopeTenant: true }),
    fetchAllRows('refunds', { select: 'id', orderCol: 'id', scopeTenant: true })
  ])

  if (!customersRes.error && customersRes.data) {
    const ids = new Set(customersRes.data.map(r => normalizeCustomerId(r.id)))
    const before = data.customers.length
    data.customers = data.customers.filter(c => ids.has(normalizeCustomerId(c.id)))
    if (data.customers.length !== before) invalidateProductSalesCountCache()
  }
  if (!followupsRes.error && followupsRes.data) {
    const ids = new Set(followupsRes.data.map(r => Number(r.id)))
    data.followups = data.followups.filter(f => ids.has(Number(f.id)))
  }
  if (!refundsRes.error && refundsRes.data) {
    const ids = new Set(refundsRes.data.map(r => String(r.id)))
    data.refunds = (data.refunds || []).filter(r => ids.has(String(r.id)))
  } else if (refundsRes.error && /refunds|does not exist|relation/i.test(refundsRes.error.message || '')) {
    // ignore missing table
  }
  schedulePersistCoreCache()
}

/**
 * Preferred sync entry for live-sync / visibility.
 * @param {{ mode?: 'auto'|'full'|'incremental', reconcile?: boolean }} [opts]
 */
export async function syncCoreData(opts = {}) {
  const mode = opts.mode || 'auto'
  const reconcile = !!opts.reconcile

  if (mode === 'full') {
    await loadData()
    if (reconcile) await reconcileDeletedRows()
    return { mode: 'full' }
  }

  if (mode === 'incremental' || (mode === 'auto' && syncMeta.customersAt && syncMeta.supportsUpdatedAt !== false)) {
    try {
      const result = await syncDataIncremental()
      if (reconcile) await reconcileDeletedRows()
      return result
    } catch (e) {
      console.warn('incremental sync failed, falling back to full load:', e)
      await loadData()
      if (reconcile) await reconcileDeletedRows()
      return { mode: 'full', reason: 'incremental-error' }
    }
  }

  await loadData()
  if (reconcile) await reconcileDeletedRows()
  return { mode: 'full' }
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
  return out
}

// ============================================
// Platforms & Statuses
// ============================================

export function getPlatforms() {
  return Array.isArray(data.platforms) ? data.platforms : []
}

export async function savePlatforms(platforms) {
  data.platforms = platforms
  await saveSetting('platforms', platforms)
  injectDynamicStyles()
}

export function getStatuses() {
  return Array.isArray(data.statuses) ? data.statuses : []
}

export async function saveStatuses(statuses) {
  data.statuses = statuses.map((s, i) => ({ ...s, order: i }))
  await saveSetting('statuses', data.statuses)
  injectDynamicStyles()
}

export function getCustomerCodes() {
  return Array.isArray(data.customerCodes) ? data.customerCodes : [...DEFAULT_CUSTOMER_CODES]
}

export function getCustomerCodeExpiryMonths() {
  return normalizeCustomerCodeExpiryMonths(data.customerCodeExpiryMonths)
}

export async function saveCustomerCodeExpiryMonths(months) {
  const cleaned = normalizeCustomerCodeExpiryMonths(months)
  data.customerCodeExpiryMonths = cleaned
  await saveSetting('customer_code_expiry_months', cleaned)
  return cleaned
}

function serializeCustomerCodeEntry(c, order) {
  const filters = normalizeCustomerCodeSaleFilters(c)
  const entry = {
    key: String(c?.key || '').trim(),
    label: String(c?.label || '').trim(),
    order,
    filterAdvisors: filters.filterAdvisors,
    advisorPhones: filters.advisorPhones,
    advisorGroupIds: filters.advisorGroupIds,
    filterProducts: filters.filterProducts,
    productNames: filters.productNames
  }
  if (c?.createdAt) entry.createdAt = c.createdAt
  if (c?.expiresAt) entry.expiresAt = c.expiresAt
  return entry
}

/** Normalize optional conversion-sale filters on a customer-code catalog entry. */
export function normalizeCustomerCodeSaleFilters(raw = {}) {
  const filterAdvisors = !!raw.filterAdvisors
  const filterProducts = !!raw.filterProducts
  const advisorPhones = filterAdvisors
    ? [...new Set((raw.advisorPhones || []).map(p => normalizePhoneLocal(p)).filter(Boolean))]
    : []
  const advisorGroupIds = filterAdvisors
    ? [...new Set((raw.advisorGroupIds || []).map(id => String(id || '').trim()).filter(Boolean))]
    : []
  const productNames = filterProducts
    ? [...new Set((raw.productNames || []).map(n => String(n || '').trim()).filter(Boolean))]
    : []
  return { filterAdvisors, advisorPhones, advisorGroupIds, filterProducts, productNames }
}

/** Validate filter flags: when enabled, at least one selection required. */
export function validateCustomerCodeSaleFilters(raw = {}) {
  const f = normalizeCustomerCodeSaleFilters(raw)
  if (f.filterAdvisors && !f.advisorPhones.length && !f.advisorGroupIds.length) {
    return { ok: false, message: 'حداقل یک ثبت‌کننده فروش یا تیم را برای فیلتر ثبت‌کننده انتخاب کنید' }
  }
  if (f.filterProducts && !f.productNames.length) {
    return { ok: false, message: 'حداقل یک محصول را برای فیلتر محصول انتخاب کنید' }
  }
  return { ok: true, filters: f }
}

export async function saveCustomerCodes(codes) {
  data.customerCodes = (codes || []).map((c, i) => serializeCustomerCodeEntry(c, i))
  await saveSetting('customer_codes', data.customerCodes)
}

/**
 * Build a new catalog entry.
 * - expiresAt string → use as-is
 * - expiresAt null → no expiry
 * - expiresAt undefined → default from customer_code_expiry_months (0 → none)
 */
export function buildCustomerCodeEntry({
  key,
  label,
  order = 0,
  expiresAt,
  nowIso = new Date().toISOString(),
  filterAdvisors,
  advisorPhones,
  advisorGroupIds,
  filterProducts,
  productNames
} = {}) {
  const filters = normalizeCustomerCodeSaleFilters({
    filterAdvisors,
    advisorPhones,
    advisorGroupIds,
    filterProducts,
    productNames
  })
  const entry = {
    key,
    label,
    order,
    createdAt: nowIso,
    ...filters
  }
  if (expiresAt === null) return entry
  if (typeof expiresAt === 'string' && expiresAt) {
    entry.expiresAt = expiresAt
    return entry
  }
  const computed = addCalendarMonthsIso(nowIso, getCustomerCodeExpiryMonths())
  if (computed) entry.expiresAt = computed
  return entry
}

function customerCodeCatalogHasValue(codes, raw) {
  const v = String(raw || '').trim()
  if (!v) return true
  const lower = v.toLowerCase()
  return codes.some(c =>
    c.key === v ||
    String(c.key || '').toLowerCase() === lower ||
    c.label === v ||
    String(c.label || '').toLowerCase() === lower
  )
}

/**
 * Register unknown Excel/profile code values into the customer_codes catalog
 * so filters and settings (incl. advisor/product sale filters) can use them.
 * New entries: no expiry, no sale filters (editable later in settings).
 */
export async function ensureCustomerCodesInCatalog(rawValues = []) {
  const values = [...new Set((rawValues || []).map(v => String(v || '').trim()).filter(Boolean))]
  if (!values.length) return { added: 0, keys: [] }

  const codes = [...getCustomerCodes()]
  const addedKeys = []
  for (const raw of values) {
    if (customerCodeCatalogHasValue(codes, raw)) continue
    const entry = buildCustomerCodeEntry({
      key: raw,
      label: raw,
      order: codes.length,
      expiresAt: null,
      filterAdvisors: false,
      filterProducts: false
    })
    codes.push(entry)
    addedKeys.push(entry.key)
  }
  if (!addedKeys.length) return { added: 0, keys: [] }
  await saveCustomerCodes(codes)
  return { added: addedKeys.length, keys: addedKeys }
}

/** Add any customer.customerCode values missing from the settings catalog. */
export async function syncCustomerCodesFromProfiles() {
  const raw = (data.customers || [])
    .map(c => String(c?.customerCode || '').trim())
    .filter(Boolean)
  return ensureCustomerCodesInCatalog(raw)
}

export async function clearCustomerCodeKeysFromCustomers(keys) {
  const unique = [...new Set((keys || []).map(k => String(k || '').trim()).filter(Boolean))]
  if (!unique.length) return 0
  const keySet = new Set(unique)
  let cleared = 0
  for (const c of data.customers || []) {
    if (c?.customerCode && keySet.has(c.customerCode)) {
      c.customerCode = ''
      cleared++
    }
  }
  const tenantId = getStoredTenantId()
  let q = supabase.from('customers').update({ customer_code: '' }).in('customer_code', unique)
  if (tenantId) q = q.eq('tenant_id', tenantId)
  const { error } = await q
  if (error) {
    console.error('clearCustomerCodeKeysFromCustomers error:', error)
    throw new Error('خطا در پاک‌سازی کد مشتری از مشتریان: ' + error.message)
  }
  schedulePersistCoreCache()
  return cleared
}

/**
 * Remove catalog codes past expiresAt and clear those keys from customers.
 * Safe to call on boot / when opening settings. Returns { removed, clearedCustomers }.
 */
export async function purgeExpiredCustomerCodes() {
  const codes = getCustomerCodes()
  if (!codes.length) return { removed: 0, clearedCustomers: 0 }
  const nowMs = Date.now()
  const expired = codes.filter(c => isCustomerCodeExpired(c, nowMs))
  if (!expired.length) return { removed: 0, clearedCustomers: 0 }
  const remaining = codes.filter(c => !isCustomerCodeExpired(c, nowMs))
  const clearedCustomers = await clearCustomerCodeKeysFromCustomers(expired.map(c => c.key))
  await saveCustomerCodes(remaining)
  return { removed: expired.length, clearedCustomers }
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
  if (!normalized.length) return []
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

/**
 * True when catalog marks the product as an event (needs session / تاریخ برگزاری).
 * Bundles themselves are never catalog events — use getEventCourseNamesForSellable.
 */
export function isEventProductName(productName) {
  const entry = getCatalogEntryByName(productName)
  return !!(entry && entry.isEvent === true)
}

/**
 * Event course names that need تاریخ برگزاری for this sellable name.
 * - Catalog event product → [itself]
 * - Bundle → event products inside the bundle (catalog only)
 */
export function getEventCourseNamesForSellable(sellableName) {
  const name = coerceProductName(sellableName) || String(sellableName || '').trim()
  if (!name) return []
  if (isEventProductName(name)) return [name]
  const bundle = getBundleByName(name)
  if (!bundle) return []
  const out = []
  const seen = new Set()
  for (const raw of bundle.productNames || []) {
    const p = coerceProductName(raw) || String(raw || '').trim()
    if (!p || !isEventProductName(p)) continue
    const key = p.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out
}

/** True when this sellable (product or bundle-with-events) needs session date(s). */
export function saleNeedsInPersonSession(sellableName) {
  return getEventCourseNamesForSellable(sellableName).length > 0
}

/**
 * Normalized map courseName → sessionId on a sale line.
 * Supports legacy `inPersonSessionId` (single) and `inPersonSessionByCourse`.
 */
export function getSaleInPersonSessionMap(product) {
  const map = {}
  const raw = product?.inPersonSessionByCourse
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [course, sid] of Object.entries(raw)) {
      const c = coerceProductName(course) || String(course || '').trim()
      const id = String(sid || '').trim()
      if (c && id) map[c] = id
    }
  }
  const legacy = String(product?.inPersonSessionId || '').trim()
  if (legacy) {
    const courses = getEventCourseNamesForSellable(product?.name)
    if (courses.length === 1 && !map[courses[0]]) {
      map[courses[0]] = legacy
    } else if (!courses.length && !Object.keys(map).length) {
      // Unknown / renamed — keep a synthetic key so capacity counts still work
      map['__legacy__'] = legacy
    } else if (courses.length > 1) {
      // Prefer matching session's courseName when map incomplete
      const sess = getInPersonSessionById(legacy)
      if (sess?.courseName) {
        const match = courses.find(c => c.toLowerCase() === sess.courseName.toLowerCase())
        if (match && !map[match]) map[match] = legacy
      }
    }
  }
  return map
}

export function getSaleInPersonSessionIds(product) {
  return [...new Set(Object.values(getSaleInPersonSessionMap(product)).filter(Boolean))]
}

export function saleHasInPersonSessionId(product, sessionId) {
  const key = String(sessionId || '').trim()
  if (!key) return false
  return getSaleInPersonSessionIds(product).includes(key)
}

/** Missing required event courses for this sale line (empty = complete). */
export function getMissingEventCoursesForSale(product) {
  const courses = getEventCourseNamesForSellable(product?.name)
  if (!courses.length) return []
  const map = getSaleInPersonSessionMap(product)
  return courses.filter(c => !String(map[c] || '').trim())
}

/**
 * Write session assignments onto a sale line. Syncs legacy `inPersonSessionId`
 * (first assigned id) for older readers.
 */
export function applySaleInPersonSessionMap(product, sessionByCourse) {
  if (!product || typeof product !== 'object') return
  const courses = getEventCourseNamesForSellable(product.name)
  const next = {}
  if (sessionByCourse && typeof sessionByCourse === 'object') {
    for (const course of courses) {
      const sid = String(sessionByCourse[course] || '').trim()
      if (sid) next[course] = sid
    }
  }
  if (Object.keys(next).length) {
    product.inPersonSessionByCourse = next
    product.inPersonSessionId = Object.values(next)[0] || ''
  } else {
    delete product.inPersonSessionByCourse
    delete product.inPersonSessionId
  }
}

/** @deprecated use isEventProductName — kept for older call sites */
export function isInPersonProductName(name) {
  return isEventProductName(name)
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
  data.productCatalog = cleaned
  await saveSetting('product_catalog', data.productCatalog)
  return getProductCatalog()
}

// ============================================
// In-person course sessions (برگزاری دوره‌های حضوری)
// ============================================

function makeInPersonSessionId() {
  return `ips_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export function formatInPersonSessionLabel(session) {
  if (!session) return ''
  const course = String(session.courseName || '').trim() || '—'
  const date = String(session.sessionDate || '').trim() || '—'
  return `${course} — ${date}`
}

/** Positive integer capacity, or null when unlimited / unset (legacy). */
export function getInPersonSessionCapacity(session) {
  const n = Number(session?.capacity)
  if (!Number.isFinite(n) || n < 1) return null
  return Math.floor(n)
}

function saleIsOnInPersonSession(customerId, productIndex, sessionId) {
  const customer = (data.customers || []).find(c => c.id === customerId)
  const product = Array.isArray(customer?.products) ? customer.products[productIndex] : null
  return saleHasInPersonSessionId(product, sessionId)
}

/** Seats left; null = unlimited. Pass occupancyMap to avoid rescanning customers. */
export function getInPersonSessionRemaining(sessionOrId, { ignoreSale, occupancyMap } = {}) {
  const session = typeof sessionOrId === 'object' && sessionOrId
    ? sessionOrId
    : getInPersonSessionById(sessionOrId)
  if (!session) return 0
  const cap = getInPersonSessionCapacity(session)
  if (cap == null) return null
  let used = countSalesLinkedToInPersonSession(session.id, occupancyMap)
  if (ignoreSale && saleIsOnInPersonSession(ignoreSale.customerId, ignoreSale.productIndex, session.id)) {
    used = Math.max(0, used - 1)
  }
  return Math.max(0, cap - used)
}

export function isInPersonSessionFull(sessionOrId, opts = {}) {
  const remaining = getInPersonSessionRemaining(sessionOrId, opts)
  if (remaining == null) return false
  return remaining <= 0
}

/** Label for selects: base + (ظرفیت باقیمانده N) | (ظرفیت تکمیل). */
export function formatInPersonSessionOptionLabel(session, occupancyMap) {
  const base = formatInPersonSessionLabel(session)
  const cap = getInPersonSessionCapacity(session)
  if (cap == null) return base
  const remaining = getInPersonSessionRemaining(session, { occupancyMap })
  if (remaining != null && remaining <= 0) return `${base} (ظرفیت تکمیل)`
  return `${base} (ظرفیت باقیمانده ${remaining})`
}

/**
 * Options for session <select>. Full sessions are disabled unless currently selected.
 * @param {Map<string, number>|Record<string, number>} [occupancyMap] precomputed seat usage
 * @returns {Array<{id:string,label:string,selected:boolean,disabled:boolean}>}
 */
export function mapInPersonSessionSelectOptions(sessions, selectedId = '', occupancyMap) {
  const selected = String(selectedId || '')
  return (sessions || []).map(s => {
    const full = isInPersonSessionFull(s, { occupancyMap })
    const isSelected = s.id === selected
    return {
      id: s.id,
      label: formatInPersonSessionOptionLabel(s, occupancyMap),
      selected: isSelected,
      disabled: full && !isSelected
    }
  })
}

/** Throws if session cannot accept another sale (unless this sale already holds the seat). */
export function assertSaleCanUseInPersonSession(sessionId, customerId, productIndex) {
  const key = String(sessionId || '').trim()
  if (!key) return
  const session = getInPersonSessionById(key)
  if (!session) throw new Error('سانس انتخاب‌شده معتبر نیست')
  if (!session.active && !saleIsOnInPersonSession(customerId, productIndex, key)) {
    throw new Error('سانس معتبر نیست')
  }
  if (saleIsOnInPersonSession(customerId, productIndex, key)) return
  if (isInPersonSessionFull(session)) {
    throw new Error('ظرفیت این سانس تکمیل است')
  }
}

function parseInPersonSessionCapacity(raw) {
  if (raw == null || raw === '') return null
  const cleaned = String(raw).replace(/[^\d]/g, '')
  if (!cleaned) return null
  const n = Number(cleaned)
  if (!Number.isFinite(n) || n < 1) return null
  return Math.floor(n)
}

export function normalizeInPersonSession(raw) {
  if (!raw || typeof raw !== 'object') return null
  const courseName = coerceProductName(raw.courseName || raw.name || '')
  const sessionDate = String(raw.sessionDate || raw.date || '').trim()
  // Keep existing sessions even if catalog flag changed; create/update validates isEvent.
  if (!courseName) return null
  if (!sessionDate || sessionDate.split('/').length !== 3) return null
  const id = String(raw.id || '').trim() || makeInPersonSessionId()
  const entry = {
    id,
    courseName,
    sessionDate,
    active: raw.active !== false
  }
  const capacity = parseInPersonSessionCapacity(raw.capacity)
  if (capacity != null) entry.capacity = capacity
  return entry
}

export function normalizeInPersonSessions(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const item of raw) {
    const s = normalizeInPersonSession(item)
    if (!s) continue
    if (seen.has(s.id)) continue
    seen.add(s.id)
    out.push(s)
  }
  return out
}

function ensureInPersonSessionsNormalized() {
  const list = normalizeInPersonSessions(data.inPersonSessions)
  data.inPersonSessions = list
  return list
}

export function getInPersonSessions() {
  return ensureInPersonSessionsNormalized().map(s => ({ ...s }))
}

export function getActiveInPersonSessions() {
  return getInPersonSessions()
    .filter(s => s.active)
    .sort((a, b) => {
      const nb = Number(String(b.sessionDate).replace(/\D/g, '')) || 0
      const na = Number(String(a.sessionDate).replace(/\D/g, '')) || 0
      return nb - na
    })
}

export function getInPersonSessionById(id) {
  const key = String(id || '').trim()
  if (!key) return null
  const found = ensureInPersonSessionsNormalized().find(s => s.id === key)
  return found ? { ...found } : null
}

/** Catalog product names marked as رویداد (event). */
export function getInPersonCourseNames() {
  const names = getProductCatalogNames().filter(isEventProductName)
  return [...new Set(names)].sort((a, b) => a.localeCompare(b, 'fa'))
}

export async function saveInPersonSessions(sessions) {
  const cleaned = normalizeInPersonSessions(sessions)
  data.inPersonSessions = cleaned
  await saveSetting('in_person_sessions', cleaned)
  return getInPersonSessions()
}

export async function upsertInPersonSession(input) {
  const courseName = coerceProductName(input?.courseName || input?.name || '')
  if (!courseName || !isEventProductName(courseName)) {
    throw new Error('محصول رویداد و تاریخ برگزاری الزامی است')
  }
  const capacity = parseInPersonSessionCapacity(input?.capacity)
  if (capacity == null) {
    throw new Error('ظرفیت سانس را وارد کنید')
  }
  const next = normalizeInPersonSession({
    ...input,
    courseName,
    capacity,
    id: input?.id || makeInPersonSessionId()
  })
  if (!next) throw new Error('محصول رویداد و تاریخ برگزاری الزامی است')
  const list = getInPersonSessions()
  const idx = list.findIndex(s => s.id === next.id)
  const dup = list.some(s =>
    s.id !== next.id &&
    s.courseName.toLowerCase() === next.courseName.toLowerCase() &&
    s.sessionDate === next.sessionDate
  )
  if (dup) throw new Error('این سانس قبلاً ثبت شده')
  if (idx >= 0) list[idx] = next
  else list.push(next)
  await saveInPersonSessions(list)
  return next
}

/**
 * One customer pass → occupancy + unassigned + assigned rows.
 * Prefer this over calling list/count helpers separately when rendering settings.
 */
export function buildInPersonAssignmentSnapshots() {
  const occupancy = new Map()
  const unassigned = []
  const assigned = []
  const sessionsById = new Map(ensureInPersonSessionsNormalized().map(s => [s.id, s]))

  for (const c of data.customers || []) {
    const products = Array.isArray(c.products) ? c.products : []
    const phones = Array.isArray(c.phones) ? c.phones.join(' ') : String(c.phone || '')
    products.forEach((p, productIndex) => {
      if (p?.historicalImport) return
      const sessionMap = getSaleInPersonSessionMap(p)
      const ids = [...new Set(Object.values(sessionMap).filter(Boolean))]
      for (const sid of ids) {
        occupancy.set(sid, (occupancy.get(sid) || 0) + 1)
      }

      const courses = getEventCourseNamesForSellable(p?.name)
      const missing = courses.filter(course => !String(sessionMap[course] || '').trim())
      const base = {
        customerId: c.id,
        customerName: c.name || c.id,
        phone: phones,
        platformId: c.platformId || '',
        productIndex,
        productName: coerceProductName(p.name) || p.name || '—',
        price: parseFloat(p.price) || 0,
        status: p.status || '—'
      }
      if (missing.length) {
        unassigned.push({ ...base, missingCourses: missing })
      }
      if (!ids.length) return
      const sid = ids[0]
      const session = sessionsById.get(sid)
      assigned.push({
        ...base,
        sessionId: sid,
        sessionLabel: session ? formatInPersonSessionLabel(session) : sid,
        sessionIds: ids
      })
    })
  }
  return { occupancy, unassigned, assigned }
}

/**
 * One customer pass → sessionId → linked sale-line count.
 * Use this when rendering many capacity labels/options.
 */
export function buildInPersonSessionOccupancyMap() {
  return buildInPersonAssignmentSnapshots().occupancy
}

/** Count sale lines linked to a session id. Pass occupancyMap to skip rescanning. */
export function countSalesLinkedToInPersonSession(sessionId, occupancyMap) {
  const key = String(sessionId || '').trim()
  if (!key) return 0
  if (occupancyMap) {
    if (occupancyMap instanceof Map) return occupancyMap.get(key) || 0
    return Number(occupancyMap[key]) || 0
  }
  let n = 0
  for (const c of data.customers || []) {
    for (const p of c.products || []) {
      if (saleHasInPersonSessionId(p, key)) n++
    }
  }
  return n
}

/**
 * Unassigned event sale lines (product or bundle-with-events missing at least one session).
 * Historical matrix imports are excluded from assignment.
 * @returns {Array<{customerId, customerName, phone, productIndex, productName, price, status, missingCourses}>}
 */
export function listUnassignedInPersonSales() {
  return buildInPersonAssignmentSnapshots().unassigned
}

/**
 * Sales already linked to an in-person session (excludes historical imports).
 * @param {string} [sessionId] if set, only that session
 */
export function listAssignedInPersonSales(sessionId = '') {
  const want = String(sessionId || '').trim()
  const { assigned } = buildInPersonAssignmentSnapshots()
  if (!want) {
    return assigned.map(({ sessionIds, ...row }) => row)
  }
  const sessionsById = new Map(ensureInPersonSessionsNormalized().map(s => [s.id, s]))
  const rows = []
  for (const row of assigned) {
    const ids = row.sessionIds || [row.sessionId]
    if (!ids.includes(want)) continue
    const session = sessionsById.get(want)
    rows.push({
      customerId: row.customerId,
      customerName: row.customerName,
      phone: row.phone,
      platformId: row.platformId,
      productIndex: row.productIndex,
      productName: row.productName,
      price: row.price,
      status: row.status,
      sessionId: want,
      sessionLabel: session ? formatInPersonSessionLabel(session) : want
    })
  }
  return rows
}

/** Assign an existing sale line to an in-person session (admin settings). */
export function assignInPersonSessionToSaleLocal(customerId, productIndex, sessionId) {
  const session = getInPersonSessionById(sessionId)
  if (!session || !session.active) throw new Error('سانس معتبر نیست')
  const customer = (data.customers || []).find(c => c.id === customerId)
  if (!customer) throw new Error('مشتری یافت نشد')
  const products = Array.isArray(customer.products) ? customer.products : []
  const product = products[productIndex]
  if (!product) throw new Error('فروش یافت نشد')
  if (product.historicalImport) throw new Error('فروش ایمپورت تاریخی قابل تخصیص نیست')
  const courses = getEventCourseNamesForSellable(product.name)
  if (!courses.length) throw new Error('این محصول رویداد نیست')
  const courseMatch = courses.find(c => c.toLowerCase() === String(session.courseName || '').toLowerCase())
  if (!courseMatch) {
    throw new Error(`این سانس برای دوره «${session.courseName}» است و با محصولات رویداد این فروش هم‌خوان نیست`)
  }
  assertSaleCanUseInPersonSession(session.id, customerId, productIndex)
  const map = getSaleInPersonSessionMap(product)
  map[courseMatch] = session.id
  applySaleInPersonSessionMap(product, map)
  return product
}

/** Assign session + persist customer (UI / single edits). */
export async function assignInPersonSessionToSale(customerId, productIndex, sessionId) {
  const product = assignInPersonSessionToSaleLocal(customerId, productIndex, sessionId)
  const customer = (data.customers || []).find(c => c.id === customerId)
  if (customer) await saveCustomerToDB(customer)
  return product
}

// ============================================
// Event message types (تنظیمات رویدادها)
// ============================================

export const DEFAULT_EVENT_MESSAGE_TYPES = Object.freeze([
  {
    id: 'welcome',
    name: 'پیام خوش‌آمدگویی',
    body: 'سلام {customer_name} عزیز، به رویداد «{event_name}» خوش آمدید. از حضور شما سپاسگزاریم.\n{org_name}'
  },
  {
    id: 'notification',
    name: 'پیام اطلاع‌رسانی',
    body: 'سلام {customer_name} عزیز، اطلاع‌رسانی رویداد «{event_name}» مورخ {event_date}.\n{org_name}'
  }
])

function makeEventMessageTypeId() {
  return `emt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export function normalizeEventMessageType(raw) {
  if (!raw || typeof raw !== 'object') return null
  const name = String(raw.name || '').trim()
  if (!name) return null
  const id = String(raw.id || '').trim() || makeEventMessageTypeId()
  return {
    id,
    name,
    body: String(raw.body || '')
  }
}

export function normalizeEventMessageTypes(raw) {
  if (!Array.isArray(raw) || !raw.length) {
    return DEFAULT_EVENT_MESSAGE_TYPES.map(t => ({ ...t }))
  }
  const seen = new Set()
  const out = []
  for (const item of raw) {
    const t = normalizeEventMessageType(item)
    if (!t) continue
    if (seen.has(t.id)) continue
    seen.add(t.id)
    out.push(t)
  }
  return out.length ? out : DEFAULT_EVENT_MESSAGE_TYPES.map(t => ({ ...t }))
}

export function getEventMessageTypes() {
  const list = normalizeEventMessageTypes(data.eventMessageTypes)
  data.eventMessageTypes = list
  return list.map(t => ({ ...t }))
}

export async function saveEventMessageTypes(types) {
  const cleaned = normalizeEventMessageTypes(types)
  data.eventMessageTypes = cleaned
  await saveSetting('event_message_types', cleaned)
  return getEventMessageTypes()
}

export async function upsertEventMessageType(input) {
  const next = normalizeEventMessageType({
    ...input,
    id: input?.id || makeEventMessageTypeId()
  })
  if (!next) throw new Error('نام نوع پیام الزامی است')
  const list = getEventMessageTypes()
  const idx = list.findIndex(t => t.id === next.id)
  const dupName = list.some(t =>
    t.id !== next.id && t.name.toLowerCase() === next.name.toLowerCase()
  )
  if (dupName) throw new Error('نوع پیام با این نام قبلاً ثبت شده')
  if (idx >= 0) list[idx] = next
  else list.push(next)
  await saveEventMessageTypes(list)
  return next
}

export async function removeEventMessageType(id) {
  const key = String(id || '').trim()
  const list = getEventMessageTypes().filter(t => t.id !== key)
  if (!list.length) throw new Error('حداقل یک نوع پیام باید باقی بماند')
  await saveEventMessageTypes(list)
  return list
}

/** Remove session assignment from a sale line. */
export async function unassignInPersonSessionFromSale(customerId, productIndex) {
  const customer = (data.customers || []).find(c => c.id === customerId)
  if (!customer) throw new Error('مشتری یافت نشد')
  const products = Array.isArray(customer.products) ? customer.products : []
  const product = products[productIndex]
  if (!product) throw new Error('فروش یافت نشد')
  if (!getSaleInPersonSessionIds(product).length) return product
  applySaleInPersonSessionMap(product, {})
  await saveCustomerToDB(customer)
  return product
}

/**
 * Clear session assignment on all sales linked to this session, then remove the session.
 * @returns {{ cleared: number }}
 */
export async function deleteInPersonSessionAndClearAssignments(sessionId) {
  const key = String(sessionId || '').trim()
  if (!key) throw new Error('سانس نامعتبر است')
  const list = getInPersonSessions()
  if (!list.some(s => s.id === key)) throw new Error('سانس یافت نشد')

  let cleared = 0
  const touched = []
  for (const c of data.customers || []) {
    let changed = false
    for (const p of c.products || []) {
      if (!saleHasInPersonSessionId(p, key)) continue
      const map = getSaleInPersonSessionMap(p)
      for (const [course, sid] of Object.entries(map)) {
        if (sid === key) delete map[course]
      }
      applySaleInPersonSessionMap(p, map)
      cleared++
      changed = true
    }
    if (changed) touched.push(c)
  }
  for (const c of touched) {
    await saveCustomerToDB(c)
  }
  await saveInPersonSessions(list.filter(s => s.id !== key))
  return { cleared }
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

/**
 * Cached sale-line counts by product/bundle name (case-insensitive key).
 * Each customer.products[] row with a non-empty name counts as 1 sale
 * (completed, deposit, or gift — payment count does not matter).
 */
let productSalesCountCache = null
/** Depth of deferred invalidation (imports / batch writes). */
let productSalesCacheDeferDepth = 0
let productSalesCacheInvalidatePending = false

/**
 * Coalesce product-sales / customers derived-cache invalidation while `fn` runs.
 * One flush when the outermost defer ends (if anything was invalidated).
 * @template T
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function runWithDeferredProductSalesCacheInvalidation(fn) {
  productSalesCacheDeferDepth++
  try {
    return await fn()
  } finally {
    productSalesCacheDeferDepth = Math.max(0, productSalesCacheDeferDepth - 1)
    if (productSalesCacheDeferDepth === 0 && productSalesCacheInvalidatePending) {
      productSalesCacheInvalidatePending = false
      productSalesCountCache = null
      invalidateDerivedCache('customers')
    }
  }
}

export function invalidateProductSalesCountCache() {
  if (productSalesCacheDeferDepth > 0) {
    productSalesCacheInvalidatePending = true
    return
  }
  productSalesCountCache = null
  invalidateDerivedCache('customers')
}

function buildProductSalesCountMap() {
  const map = new Map()
  for (const c of data.customers || []) {
    for (const p of c.products || []) {
      const name = coerceProductName(p?.name)
      if (!name) continue
      const key = name.toLowerCase()
      map.set(key, (map.get(key) || 0) + 1)
    }
  }
  return map
}

/** @returns {Map<string, number>} lowercase product name → sale-line count */
export function getProductSalesCountMap() {
  if (!productSalesCountCache) {
    productSalesCountCache = buildProductSalesCountMap()
  }
  return productSalesCountCache
}

/** Union of catalog product names + bundle names (sellable dropdown options).
 * Ordered by sale volume (most → least); ties use Persian alphabetical order. */
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
  const counts = getProductSalesCountMap()
  out.sort((a, b) => {
    const diff = (counts.get(b.toLowerCase()) || 0) - (counts.get(a.toLowerCase()) || 0)
    if (diff !== 0) return diff
    return String(a).localeCompare(String(b), 'fa')
  })
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

/** Ownership from paid sale, accounting-approved gift, or historical matrix import (excludes refunded lines). */
function saleLineGrantsOwnership(line) {
  if (!line || typeof line !== 'object') return false
  // Historical ownership rows (no real payment amount) still light up the product matrix.
  if (line.historicalImport) {
    const refunds = Array.isArray(line.refunds) ? line.refunds : []
    const refunded = refunds.reduce((s, r) => s + (parseFloat(r?.amount) || 0), 0)
    return refunded <= 0
  }
  if (isGiftSaleLine(line)) {
    return (line.giftAccountingStatus || 'pending') === 'approved'
  }
  if (!saleLineHasApprovedPayment(line)) return false
  // Inline check to avoid circular import with utils.isDealCancelled
  const refunds = Array.isArray(line.refunds) ? line.refunds : []
  const refunded = refunds.reduce((s, r) => s + (parseFloat(r?.amount) || 0), 0)
  return refunded <= 0
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
 * Rename a product everywhere it appears: customer sales, follow-ups, refunds, sales-target filters.
 * Call after renaming in the catalog (bundles via renameProductInBundles separately).
 */
export async function renameProductAcrossApp(oldName, newName) {
  const from = String(oldName || '').trim()
  const to = String(newName || '').trim()
  if (!from || !to || from.toLowerCase() === to.toLowerCase()) {
    return {
      updatedCustomers: 0,
      updatedSales: 0,
      updatedFollowups: 0,
      updatedRefunds: 0,
      updatedTargets: false,
    }
  }
  const oldLower = from.toLowerCase()
  let updatedCustomers = 0
  let updatedSales = 0
  let updatedFollowups = 0
  let updatedRefunds = 0

  const tenantId = getStoredTenantId()
  if (tenantId) {
    const { data: rows, error } = await supabase
      .from('customers')
      .select('id, products')
      .eq('tenant_id', tenantId)
    if (error) throw new Error('خطا در خواندن مشتریان برای تغییر نام محصول: ' + error.message)

    for (const row of rows || []) {
      const products = Array.isArray(row.products) ? row.products : []
      let dirty = false
      const nextProducts = products.map((p) => {
        if (String(p?.name || '').trim().toLowerCase() !== oldLower) return p
        dirty = true
        updatedSales += 1
        return { ...p, name: to }
      })
      if (!dirty) continue

      const rowId = normalizeCustomerId(row.id)
      const cached = (data.customers || []).find((c) => normalizeCustomerId(c.id) === rowId)
      if (cached) {
        cached.products = nextProducts
        cached._productsLoaded = true
        cached.productCount = nextProducts.length
        await saveCustomerToDB(cached)
      } else {
        const { error: upErr } = await supabase
          .from('customers')
          .update({ products: nextProducts })
          .eq('tenant_id', tenantId)
          .eq('id', row.id)
        if (upErr) throw new Error('خطا در به‌روزرسانی فروش مشتری: ' + upErr.message)
      }
      updatedCustomers += 1
    }
  } else {
    for (const customer of data.customers || []) {
      const products = customer.products || []
      let dirty = false
      for (const p of products) {
        if (String(p?.name || '').trim().toLowerCase() === oldLower) {
          p.name = to
          dirty = true
          updatedSales += 1
        }
      }
      if (dirty) {
        customer.productCount = products.length
        await saveCustomerToDB(customer)
        updatedCustomers += 1
      }
    }
  }

  for (const f of data.followups || []) {
    if (String(f.productName || '').trim().toLowerCase() !== oldLower) continue
    f.productName = to
    await saveFollowupToDB(f)
    updatedFollowups += 1
  }

  for (const r of getRefunds()) {
    if (String(r.productName || '').trim().toLowerCase() !== oldLower) continue
    r.productName = to
    await updateRefundInDB(r.id, { productName: to })
    updatedRefunds += 1
  }

  let updatedTargets = false
  const targets = getSalesTargets()
  const nextTargets = targets.map((group) => {
    const items = (group.items || []).map((bar) => {
      const names = bar.productNames || []
      if (!names.some((n) => n.toLowerCase() === oldLower)) return bar
      updatedTargets = true
      const replaced = names.map((n) => (n.toLowerCase() === oldLower ? to : n))
      return { ...bar, productNames: [...new Set(replaced)] }
    })
    return { ...group, items }
  })
  if (updatedTargets) await saveSalesTargets(nextTargets)

  invalidateProductSalesCountCache()
  try {
    const { invalidateDerivedCache } = await import('./derived-cache.js')
    invalidateDerivedCache('all')
  } catch (_) { /* ignore */ }

  return {
    updatedCustomers,
    updatedSales,
    updatedFollowups,
    updatedRefunds,
    updatedTargets,
  }
}

/**
 * Count customer sale lines whose product.name matches (case-insensitive).
 * Uses the shared sales-count cache (one scan of customers until invalidated).
 */
export function countSalesByProductName(productName) {
  const key = String(productName || '').trim().toLowerCase()
  if (!key) return 0
  return getProductSalesCountMap().get(key) || 0
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

/** Org stages, or a single implicit final stage when the bar has none. */
export function effectiveSalesTargetBarStages(bar) {
  const stages = (Array.isArray(bar?.stages) ? bar.stages : [])
    .map(stage => {
      if (!stage || typeof stage !== 'object') return null
      const id = String(stage.id || '').trim()
      const value = Number(stage.value)
      if (!id || !Number.isFinite(value) || value <= 0) return null
      const label = String(stage.label || '').trim()
      return { id, value, ...(label ? { label } : {}) }
    })
    .filter(Boolean)
  if (stages.length) return stages
  const value = Number(bar?.value)
  const id = String(bar?.id || '').trim()
  if (!(value > 0) || !id) return []
  return [{ id: `${id}__final`, value }]
}

/** Expand a legacy final-only share across org stages (last stage = value). */
export function scaleShareStagesFromValue(value, bar) {
  const stages = effectiveSalesTargetBarStages(bar)
  const final = Number(stages[stages.length - 1]?.value) || Number(bar?.value) || 0
  const v = Number(value)
  if (!stages.length || !(v > 0) || !(final > 0)) return []

  const out = stages.map((st, i) => {
    if (i === stages.length - 1) return { stageId: st.id, value: v }
    const scaled = Math.round((Number(st.value) / final) * v)
    return { stageId: st.id, value: Math.max(1, scaled) }
  })

  for (let i = out.length - 2; i >= 0; i--) {
    if (out[i].value >= out[i + 1].value) {
      out[i].value = Math.max(1, out[i + 1].value - 1)
    }
  }
  for (let i = 1; i < out.length; i++) {
    if (out[i].value <= out[i - 1].value) {
      out[i].value = out[i - 1].value + 1
    }
  }
  out[out.length - 1].value = v
  if (out.some(s => !(s.value > 0)) || (out.length > 1 && out[out.length - 1].value <= out[out.length - 2].value)) {
    return []
  }
  return out
}

export function salesTargetShareGoalAndStages(share, bar) {
  if (!share || !bar) return null
  const barStages = effectiveSalesTargetBarStages(bar)
  const rawStages = Array.isArray(share.stages) ? share.stages : []
  const byId = new Map()
  for (const stage of rawStages) {
    const stageId = String(stage?.stageId || stage?.id || '').trim()
    const value = Number(stage?.value)
    if (!stageId || !Number.isFinite(value) || value <= 0) continue
    byId.set(stageId, value)
  }
  const complete = barStages.length > 0 && barStages.every(st => (byId.get(st.id) || 0) > 0)
  if (complete) {
    const scopeStages = barStages.map(st => ({
      id: st.id,
      value: byId.get(st.id),
      ...(st.label ? { label: st.label } : {})
    }))
    return { goal: scopeStages[scopeStages.length - 1].value, scopeStages }
  }
  const value = Number(share.value)
  if (!(value > 0)) return null
  return { goal: value, scopeStages: null }
}

function barListById(bars) {
  const map = new Map()
  for (const bar of bars || []) {
    const id = String(bar?.id || '').trim()
    if (id) map.set(id, bar)
  }
  return map
}

function cloneShareStages(stages) {
  return (Array.isArray(stages) ? stages : []).map(stage => ({
    stageId: String(stage.stageId || stage.id || '').trim(),
    value: Number(stage.value)
  })).filter(s => s.stageId && Number.isFinite(s.value) && s.value > 0)
}

function normalizeOneSalesTargetShare(share, bar) {
  if (!share || typeof share !== 'object' || !bar) return null
  const barId = String(share.barId || bar.id || '').trim()
  if (!barId) return null
  const barStages = effectiveSalesTargetBarStages(bar)
  if (!barStages.length) return null

  const rawStages = Array.isArray(share.stages) ? share.stages : []
  const byId = new Map()
  for (const stage of rawStages) {
    const stageId = String(stage?.stageId || stage?.id || '').trim()
    const value = Number(stage?.value)
    if (!stageId || !Number.isFinite(value) || value <= 0) continue
    byId.set(stageId, value)
  }

  const complete = barStages.every(st => (byId.get(st.id) || 0) > 0)
  if (complete) {
    const stages = barStages.map(st => ({ stageId: st.id, value: Number(byId.get(st.id)) }))
    for (let i = 1; i < stages.length; i++) {
      if (!(stages[i].value > stages[i - 1].value)) return null
    }
    return { barId, value: stages[stages.length - 1].value, stages }
  }

  const anyFilled = barStages.some(st => (byId.get(st.id) || 0) > 0)
  if (anyFilled) return null

  const value = Number(share.value)
  if (!Number.isFinite(value) || value <= 0) return null
  if (barStages.length === 1) {
    return { barId, value, stages: [{ stageId: barStages[0].id, value }] }
  }
  const scaled = scaleShareStagesFromValue(value, bar)
  if (scaled.length === barStages.length) {
    return { barId, value, stages: scaled }
  }
  return { barId, value }
}

function normalizeSalesTargetShares(raw, bars) {
  const map = barListById(bars)
  return (Array.isArray(raw) ? raw : [])
    .map(share => {
      if (!share || typeof share !== 'object') return null
      const barId = String(share.barId || '').trim()
      return normalizeOneSalesTargetShare(share, map.get(barId))
    })
    .filter(Boolean)
}

/** Cumulative ascending stages; last stage aligned with bar.value. Empty → single-goal bar. */
function normalizeSalesTargetStages(raw, finalValue) {
  const final = Number(finalValue)
  if (!Number.isFinite(final) || final <= 0) return []

  const seen = new Set()
  const stages = (Array.isArray(raw) ? raw : [])
    .map(stage => {
      if (!stage || typeof stage !== 'object') return null
      const value = Number(stage.value)
      if (!Number.isFinite(value) || value <= 0) return null
      const key = String(value)
      if (seen.has(key)) return null
      seen.add(key)
      const label = String(stage.label || '').trim()
      return {
        id: String(stage.id || '').trim() || `stg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        value,
        ...(label ? { label } : {})
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.value - b.value)

  if (!stages.length) return []

  const last = stages[stages.length - 1]
  if (last.value !== final) {
    if (last.value < final) {
      stages.push({
        id: `stg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        value: final
      })
    } else {
      last.value = final
    }
  }

  // Drop any stage that somehow exceeds final after alignment
  return stages.filter(s => s.value <= final)
}

/** Normalize stored Jalali date → YYYY/MM/DD (empty stays empty). */
function normalizeStoredJalaliDate(raw) {
  let s = toEnDigitsLocal(String(raw || '')).trim().split(/\s+/)[0] || ''
  if (!s) return ''
  s = s.replace(/[-.]/g, '/')
  const parts = s.split('/')
  if (parts.length !== 3) return s
  const y = parseInt(parts[0], 10)
  const m = parseInt(parts[1], 10)
  const d = parseInt(parts[2], 10)
  if (!y || !m || !d) return s
  return `${y}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`
}

function normalizeSalesTargetBar(item) {
  if (!item || typeof item !== 'object') return null
  const metric = item.metric === 'count'
    ? 'count'
    : (item.metric === 'profile_completion' ? 'profile_completion' : 'amount')
  let value = Number(item.value)
  if (!Number.isFinite(value) || value <= 0) {
    // Allow stages-only input: take max stage as final value
    const stageVals = (Array.isArray(item.stages) ? item.stages : [])
      .map(s => Number(s?.value))
      .filter(v => Number.isFinite(v) && v > 0)
    value = stageVals.length ? Math.max(...stageVals) : NaN
  }
  if (!Number.isFinite(value) || value <= 0) return null
  const productNames = metric === 'profile_completion'
    ? []
    : (Array.isArray(item.productNames)
      ? [...new Set(item.productNames.map(p => String(p || '').trim()).filter(Boolean))]
      : [])
  const profileFields = metric === 'profile_completion'
    ? sanitizeProfileFieldKeys(item.profileFields)
    : []
  if (metric === 'profile_completion' && !profileFields.length) return null
  const stages = normalizeSalesTargetStages(item.stages, value)
  if (stages.length) value = stages[stages.length - 1].value
  const startDate = normalizeStoredJalaliDate(item.startDate)
  const endDate = normalizeStoredJalaliDate(item.endDate)
  return {
    id: String(item.id || '').trim() || `tgt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    metric,
    value,
    stages,
    productNames,
    profileFields,
    startDate,
    endDate,
    createdAt: String(item.createdAt || '').trim() || new Date().toISOString()
  }
}

function normalizeAllocationMembers(raw, bars) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  return raw.map(member => {
    if (!member || typeof member !== 'object') return null
    const userPhone = normalizePhoneLocal(member.userPhone || member.user_phone || '')
    if (!userPhone || seen.has(userPhone)) return null
    const shares = normalizeSalesTargetShares(member.shares, bars)
    if (!shares.length) return null
    seen.add(userPhone)
    return { userPhone, shares }
  }).filter(Boolean)
}

function normalizeSalesTargetAllocations(raw, bars) {
  if (!Array.isArray(raw)) return []
  return raw.map(alloc => {
    if (!alloc || typeof alloc !== 'object') return null
    const userGroupId = String(alloc.userGroupId || '').trim()
    if (!userGroupId) return null
    const shares = normalizeSalesTargetShares(alloc.shares, bars)
    if (!shares.length) return null
    const members = normalizeAllocationMembers(alloc.members, bars)
    return { userGroupId, shares, members }
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
      return {
        id: String(item.id || '').trim() || `grp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        title,
        items,
        allocations: normalizeSalesTargetAllocations(item.allocations, items),
        createdAt: String(item.createdAt || '').trim() || new Date().toISOString()
      }
    }

    // Legacy flat format: one bar with its own title → wrap as single-item group
    const bar = normalizeSalesTargetBar(item)
    if (!bar) return null
    const title = String(item.title || '').trim()
      || (bar.metric === 'profile_completion'
        ? 'تارگت پروفایل'
        : (bar.metric === 'count' ? 'تارگت تعداد' : 'تارگت مبلغ'))
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
    items: (group.items || []).map(bar => ({
      ...bar,
      productNames: [...(bar.productNames || [])],
      profileFields: [...(bar.profileFields || [])],
      stages: (bar.stages || []).map(stage => ({ ...stage }))
    })),
    allocations: (group.allocations || []).map(alloc => ({
      userGroupId: alloc.userGroupId,
      shares: (alloc.shares || []).map(share => ({
        barId: share.barId,
        value: share.value,
        ...(share.stages?.length ? { stages: cloneShareStages(share.stages) } : {})
      })),
      members: (alloc.members || []).map(member => ({
        userPhone: member.userPhone,
        shares: (member.shares || []).map(share => ({
          barId: share.barId,
          value: share.value,
          ...(share.stages?.length ? { stages: cloneShareStages(share.stages) } : {})
        }))
      }))
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

/** idle | loading | ready | error */
let dataLoadState = { status: 'idle', error: null }

export function getDataLoadState() {
  return { status: dataLoadState.status, error: dataLoadState.error }
}

// ============================================
// Save customer to Supabase
// ============================================

/** Chunk size for multi-row customer upserts (mirrors backup restore). */
export const CUSTOMER_UPSERT_CHUNK = 150

/**
 * Snapshot previous cache row for fieldFilledAt stamping.
 * @param {object} customer
 * @param {Map<string, object> | null} [prevById]
 */
function resolveCustomerPrevForStamp(customer, prevById = null) {
  const id = customer?.id
  const prev = id
    ? (prevById ? (prevById.get(id) || null) : ((data.customers || []).find(c => c.id === id) || null))
    : null
  const prevSnap = prev && prev !== customer
    ? {
        ...prev,
        fieldFilledAt: normalizeFieldFilledAt(prev.fieldFilledAt),
        phones: Array.isArray(prev.phones) ? [...prev.phones] : [],
        addresses: Array.isArray(prev.addresses) ? prev.addresses.map(a => (a && typeof a === 'object' ? { ...a } : a)) : []
      }
    : (prev ? { ...prev, fieldFilledAt: normalizeFieldFilledAt(prev.fieldFilledAt) } : null)
  // When same reference was mutated in place, treat as no reliable prev field values
  return prev === customer
    ? { fieldFilledAt: normalizeFieldFilledAt(customer.fieldFilledAt) }
    : prevSnap
}

/**
 * Build a customers-table upsert row (mutates customer.fieldFilledAt via stamp).
 * @param {object} customer
 * @param {{ createdAt?: string, allowEmptyPlatform?: boolean }} [options]
 * @param {Map<string, object> | null} [prevById]
 */
function buildCustomerUpsertRow(customer, options = {}, prevById = null) {
  applyFieldFilledAtOnSave(resolveCustomerPrevForStamp(customer, prevById), customer)

  const phones = normalizeCustomerPhonesLocal(customer)
  const addresses = normalizeCustomerAddressesLocal(customer)
  const row = {
    id: customer.id,
    platform_id: customer.platformId || '',
    platform: customer.platform || 'instagram',
    name: customer.name || '',
    name_en: customer.nameEn || '',
    national_id: customer.nationalId || '',
    birth_date: customer.birthDate || '',
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
    referred_by_phone: customer.referredByPhone || '',
    customer_code: customer.customerCode || '',
    field_filled_at: normalizeFieldFilledAt(customer.fieldFilledAt)
  }
  // Only set when caller passes createdAt (insert/rekey or historical LRFM backdate).
  if (options.createdAt) row.created_at = options.createdAt
  // Historical matrix import may persist empty platform (no instagram fallback).
  if (options.allowEmptyPlatform) row.platform = customer.platform || ''
  return row
}

/**
 * Upsert one or more customer rows with the same schema fallbacks as single save.
 * @param {Record<string, unknown>[]} rows
 */
async function upsertCustomerRows(rows) {
  if (!rows.length) return
  let payload = rows
  let { error } = await supabase.from('customers').upsert(payload, { onConflict: 'id' })
  // Graceful fallback before migration 048 (field_filled_at)
  if (error && /field_filled_at/i.test(error.message || '')) {
    payload = rows.map(({ field_filled_at: _omitFfa, ...rest }) => rest)
    ;({ error } = await supabase.from('customers').upsert(payload, { onConflict: 'id' }))
  }
  // Graceful fallback before migration 047 (profile fields)
  if (error && /name_en|national_id|birth_date/i.test(error.message || '')) {
    payload = payload.map(({
      name_en: _omitEn,
      national_id: _omitNid,
      birth_date: _omitBd,
      field_filled_at: _omitFfa2,
      ...rest
    }) => rest)
    ;({ error } = await supabase.from('customers').upsert(payload, { onConflict: 'id' }))
  }
  // Graceful fallback before migration 007 / 015 / 024 is applied
  if (error && /customer_code/i.test(error.message || '')) {
    payload = payload.map(({ customer_code: _omitCode, ...rest }) => rest)
    ;({ error } = await supabase.from('customers').upsert(payload, { onConflict: 'id' }))
  }
  if (error && /addresses/i.test(error.message || '')) {
    payload = payload.map(({ addresses: _omitAddr, ...rest }) => rest)
    ;({ error } = await supabase.from('customers').upsert(payload, { onConflict: 'id' }))
  }
  if (error && /phones/i.test(error.message || '')) {
    payload = payload.map(({ phones: _omit, addresses: _omitAddr2, ...legacy }) => legacy)
    ;({ error } = await supabase.from('customers').upsert(payload, { onConflict: 'id' }))
  }
  if (error) throw new Error('خطا در ذخیره مشتری: ' + error.message)
}

export async function saveCustomerToDB(customer, options = {}) {
  bumpLocalWrite()
  const row = buildCustomerUpsertRow(customer, options)
  await upsertCustomerRows([row])
  bumpLocalWrite()
  invalidateProductSalesCountCache()
}

/**
 * Persist many customers in chunked Supabase upserts (one RTT per chunk).
 * Prefer this for imports; single-row {@link saveCustomerToDB} stays for UI edits.
 *
 * @param {Array<object | { customer: object, options?: { createdAt?: string, allowEmptyPlatform?: boolean } }>} items
 * @param {{
 *   chunkSize?: number,
 *   deferInvalidate?: boolean,
 *   skipInvalidate?: boolean,
 *   onChunk?: (info: { done: number, total: number, chunkIndex: number, chunkCount: number }) => void,
 *   signal?: AbortSignal,
 * }} [batchOpts]
 * @returns {Promise<{ saved: number }>}
 */
export async function saveCustomersToDBBatch(items, batchOpts = {}) {
  const list = Array.isArray(items) ? items : []
  if (!list.length) return { saved: 0 }

  const chunkSize = Math.max(1, Math.floor(Number(batchOpts.chunkSize) || CUSTOMER_UPSERT_CHUNK))
  /** When true (default), invalidate product-sales cache once after all chunks. */
  const deferInvalidate = batchOpts.deferInvalidate !== false
  const skipInvalidate = !!batchOpts.skipInvalidate
  const signal = batchOpts.signal || null
  const onChunk = typeof batchOpts.onChunk === 'function' ? batchOpts.onChunk : null

  const prevById = new Map()
  for (const c of data.customers || []) {
    if (c?.id) prevById.set(c.id, c)
  }

  /** @type {Record<string, unknown>[]} */
  const rows = []
  for (const item of list) {
    const customer = item?.customer != null ? item.customer : item
    if (!customer?.id) continue
    const options = item?.customer != null ? (item.options || {}) : {}
    rows.push(buildCustomerUpsertRow(customer, options, prevById))
  }
  if (!rows.length) return { saved: 0 }

  bumpLocalWrite()
  const total = rows.length
  const chunkCount = Math.ceil(total / chunkSize)
  let done = 0
  for (let i = 0, chunkIndex = 0; i < total; i += chunkSize, chunkIndex++) {
    if (signal?.aborted) {
      const err = new Error('CANCELLED')
      err.code = 'CANCELLED'
      throw err
    }
    const chunk = rows.slice(i, i + chunkSize)
    await upsertCustomerRows(chunk)
    done += chunk.length
    if (!skipInvalidate && !deferInvalidate) invalidateProductSalesCountCache()
    onChunk?.({ done, total, chunkIndex, chunkCount })
  }
  bumpLocalWrite()
  if (!skipInvalidate && deferInvalidate) invalidateProductSalesCountCache()
  return { saved: done }
}

/**
 * Chunked customer upsert with per-chunk fallback to single-row saves.
 * Use for imports so one bad row does not discard the whole chunk.
 *
 * @param {Array<object | { customer: object, options?: object }>} items
 * @param {{
 *   chunkSize?: number,
 *   signal?: AbortSignal,
 *   onChunk?: (info: { done: number, total: number, chunkIndex: number, chunkCount: number }) => void,
 *   onRowError?: (info: { customer: object, error: Error }) => void,
 * }} [batchOpts]
 * @returns {Promise<{ saved: number, failed: number }>}
 */
export async function saveCustomersToDBBatchSafe(items, batchOpts = {}) {
  const list = Array.isArray(items) ? items.filter(item => {
    const c = item?.customer != null ? item.customer : item
    return !!(c && c.id)
  }) : []
  if (!list.length) return { saved: 0, failed: 0 }

  const chunkSize = Math.max(1, Math.floor(Number(batchOpts.chunkSize) || CUSTOMER_UPSERT_CHUNK))
  const signal = batchOpts.signal || null
  const onChunk = typeof batchOpts.onChunk === 'function' ? batchOpts.onChunk : null
  const onRowError = typeof batchOpts.onRowError === 'function' ? batchOpts.onRowError : null

  let saved = 0
  let failed = 0
  const total = list.length
  const chunkCount = Math.ceil(total / chunkSize)

  for (let i = 0, chunkIndex = 0; i < total; i += chunkSize, chunkIndex++) {
    if (signal?.aborted) {
      const err = new Error('CANCELLED')
      err.code = 'CANCELLED'
      throw err
    }
    const chunk = list.slice(i, i + chunkSize)
    try {
      await saveCustomersToDBBatch(chunk, {
        chunkSize: chunk.length,
        signal,
        skipInvalidate: true,
        deferInvalidate: true
      })
      saved += chunk.length
    } catch (err) {
      if (err?.code === 'CANCELLED' || err?.message === 'CANCELLED') throw err
      for (const item of chunk) {
        if (signal?.aborted) {
          const cancelErr = new Error('CANCELLED')
          cancelErr.code = 'CANCELLED'
          throw cancelErr
        }
        const customer = item?.customer != null ? item.customer : item
        const options = item?.customer != null ? (item.options || {}) : {}
        try {
          await saveCustomerToDB(customer, options)
          saved++
        } catch (rowErr) {
          failed++
          onRowError?.({ customer, error: rowErr })
        }
      }
    }
    onChunk?.({ done: Math.min(i + chunk.length, total), total, chunkIndex, chunkCount })
  }

  if (saved) invalidateProductSalesCountCache()
  return { saved, failed }
}

/**
 * Persist only loyalty level columns (avoids full-row upsert + product payload).
 * Used by background customer-level sync so live UI stays responsive.
 */
export async function saveCustomerLevelFieldsToDB(customer) {
  if (!customer?.id) return
  bumpLocalWrite()
  const tenantId = getStoredTenantId()
  let q = supabase
    .from('customers')
    .update({
      customer_level: customer.customerLevel || '',
      customer_level_locked: !!customer.customerLevelLocked
    })
    .eq('id', customer.id)
  if (tenantId) q = q.eq('tenant_id', tenantId)
  const { error } = await q
  if (error) throw new Error('خطا در ذخیره سطح مشتری: ' + error.message)
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
  await deleteRefundsForCustomerFromDB(id)
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
    createdAt: overrides.createdAt !== undefined ? overrides.createdAt : (customer?.createdAt || null),
    fieldFilledAt: overrides.fieldFilledAt !== undefined
      ? normalizeFieldFilledAt(overrides.fieldFilledAt)
      : normalizeFieldFilledAt(customer?.fieldFilledAt)
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
  invalidateProductSalesCountCache()
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
      invalidateProductSalesCountCache()
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
  reclaim: 'بازپس‌گیری شماره',
  claim: 'تصاحب مشتری بدون کارشناس'
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

function isMissingRefundsTable(error) {
  return /refunds|does not exist|relation/i.test(error?.message || '')
}

export async function deleteRefundFromDB(id) {
  if (id == null || id === '') return false
  bumpLocalWrite()
  const { error } = await supabase.from('refunds').delete().eq('id', id)
  if (error && !isMissingRefundsTable(error)) {
    throw new Error('خطا در حذف عودت: ' + error.message)
  }
  removeRefundFromCache(id)
  bumpLocalWrite()
  return true
}

export async function deleteRefundsByIdsFromDB(ids) {
  const unique = [...new Set((ids || []).filter(id => id != null && id !== ''))]
  if (!unique.length) return 0
  bumpLocalWrite()
  const { error } = await supabase.from('refunds').delete().in('id', unique)
  if (error && !isMissingRefundsTable(error)) {
    throw new Error('خطا در حذف عودت‌ها: ' + error.message)
  }
  unique.forEach(removeRefundFromCache)
  bumpLocalWrite()
  return unique.length
}

export async function deleteRefundsForCustomerFromDB(customerId) {
  if (customerId == null || customerId === '') return 0
  bumpLocalWrite()
  const { error } = await supabase.from('refunds').delete().eq('customer_id', customerId)
  if (error && !isMissingRefundsTable(error)) {
    throw new Error('خطا در حذف عودت‌ها: ' + error.message)
  }
  const before = (data.refunds || []).length
  data.refunds = (data.refunds || []).filter(r => String(r.customerId) !== String(customerId))
  bumpLocalWrite()
  return before - (data.refunds || []).length
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
  if (patch.productName != null) row.product_name = patch.productName
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
  let res = await fetchAllRows('refunds', { select: REFUND_SELECT, orderCol: 'id', ascending: false, scopeTenant: true })
  if (res.error && /column|does not exist|schema cache/i.test(res.error.message || '')) {
    res = await fetchAllRows('refunds', { orderCol: 'id', ascending: false, scopeTenant: true })
  }
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
    product_name: followup.productName || '',
    notes: followup.notes,
    created_by_phone: followup.createdByPhone || null,
    assigned_to_phone: followup.assignedToPhone || null,
    assigned_by_phone: followup.assignedByPhone || null,
    assigned_at: followup.assignedAt || ''
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

    // Fallback without optional columns (assignment + status)
    const { assigned_to_phone, assigned_by_phone, assigned_at, ...legacyBase } = baseRow
    const fallback = await supabase.from('followups').insert(legacyBase).select('id').single()
    if (fallback.error) throw new Error('خطا در درج پیگیری: ' + fallback.error.message)
    bumpLocalWrite()
    return fallback.data ? fallback.data.id : null
  }

  const { data: inserted, error } = await supabase.from('followups').insert(baseRow).select('id').single()
  if (error) {
    // Fallback when assignment columns are missing on older DBs
    const { assigned_to_phone, assigned_by_phone, assigned_at, ...legacyBase } = baseRow
    const fallback = await supabase.from('followups').insert(legacyBase).select('id').single()
    if (fallback.error) throw new Error('خطا در درج پیگیری: ' + fallback.error.message)
    bumpLocalWrite()
    return fallback.data ? fallback.data.id : null
  }
  bumpLocalWrite()
  return inserted ? inserted.id : null
}

function buildFollowupInsertRow(followup) {
  return {
    customer_id: followup.customerId,
    date: followup.date,
    type: followup.type,
    result: followup.result,
    next_date: followup.nextDate || '',
    product_name: followup.productName || '',
    notes: followup.notes,
    created_by_phone: followup.createdByPhone || null,
    assigned_to_phone: followup.assignedToPhone || null,
    assigned_by_phone: followup.assignedByPhone || null,
    assigned_at: followup.assignedAt || '',
    status: followup.status || 'pending',
    done_at: followup.doneAt || null,
    done_by_phone: followup.doneByPhone || null,
    done_note: followup.doneNote || null,
    was_overdue: !!followup.wasOverdue
  }
}

/**
 * Multi-row followup insert. Returns ids in the same order as `followups`.
 * @param {object[]} followups
 * @param {{ chunkSize?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<(string|number|null)[]>}
 */
export async function saveFollowupsToDBBatch(followups, opts = {}) {
  const list = Array.isArray(followups) ? followups : []
  if (!list.length) return []

  const chunkSize = Math.max(1, Math.floor(Number(opts.chunkSize) || CUSTOMER_UPSERT_CHUNK))
  const signal = opts.signal || null
  /** @type {(string|number|null)[]} */
  const ids = new Array(list.length).fill(null)

  for (let i = 0; i < list.length; i += chunkSize) {
    if (signal?.aborted) {
      const err = new Error('CANCELLED')
      err.code = 'CANCELLED'
      throw err
    }
    const slice = list.slice(i, i + chunkSize)
    const rows = slice.map(buildFollowupInsertRow)
    let payload = rows
    let { data: inserted, error } = await supabase.from('followups').insert(payload).select('id')

    if (error) {
      // Strip status/done columns
      payload = rows.map(({
        status: _s, done_at: _da, done_by_phone: _db, done_note: _dn, was_overdue: _wo,
        ...rest
      }) => rest)
      ;({ data: inserted, error } = await supabase.from('followups').insert(payload).select('id'))
    }
    if (error) {
      // Strip assignment columns too
      payload = payload.map(({
        assigned_to_phone: _a, assigned_by_phone: _b, assigned_at: _c,
        ...legacy
      }) => legacy)
      ;({ data: inserted, error } = await supabase.from('followups').insert(payload).select('id'))
    }

    if (error) {
      // Fall back to single-row inserts for this chunk
      for (let j = 0; j < slice.length; j++) {
        if (signal?.aborted) {
          const cancelErr = new Error('CANCELLED')
          cancelErr.code = 'CANCELLED'
          throw cancelErr
        }
        try {
          ids[i + j] = await saveFollowupToDB(slice[j])
        } catch (rowErr) {
          throw rowErr
        }
      }
      continue
    }

    bumpLocalWrite()
    for (let j = 0; j < (inserted || []).length; j++) {
      ids[i + j] = inserted[j]?.id ?? null
    }
  }

  return ids
}

export async function updateFollowupInDB(followup) {
  if (!followup.id) return
  const row = {
    customer_id: followup.customerId,
    date: followup.date,
    type: followup.type,
    result: followup.result,
    next_date: followup.nextDate,
    product_name: followup.productName || '',
    notes: followup.notes
  }
  if (followup.createdByPhone !== undefined) {
    row.created_by_phone = followup.createdByPhone || null
  }
  if (followup.assignedToPhone !== undefined) {
    row.assigned_to_phone = followup.assignedToPhone || null
  }
  if (followup.assignedByPhone !== undefined) {
    row.assigned_by_phone = followup.assignedByPhone || null
  }
  if (followup.assignedAt !== undefined) {
    row.assigned_at = followup.assignedAt || ''
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

export async function updateRefundsCustomerId(oldId, newId) {
  const { error } = await supabase.from('refunds').update({ customer_id: newId }).eq('customer_id', oldId)
  if (error) throw new Error('خطا در بروزرسانی عودت‌ها: ' + error.message)
  bumpLocalWrite()
}

// ============================================
// Save app setting
// ============================================

/** Coerce app_settings JSON/text booleans; `fallback` used when key is unset/unknown. */
export function coerceAppSettingBool(raw, fallback = false) {
  if (raw === true || raw === 1 || raw === '1') return true
  if (raw === false || raw === 0 || raw === '0') return false
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase()
    if (s === 'true' || s === 'yes' || s === 'on') return true
    if (s === 'false' || s === 'no' || s === 'off') return false
  }
  if (raw == null) return fallback
  return fallback
}

export async function saveSetting(key, value) {
  const tenantId = getStoredTenantId()
  const row = { key, value }
  if (tenantId) row.tenant_id = tenantId
  const { error } = await supabase
    .from('app_settings')
    .upsert(row, { onConflict: tenantId ? 'tenant_id,key' : 'key' })
  if (error) throw new Error('خطا در ذخیره تنظیمات: ' + error.message)
}

export function getSaleToastEnabled() {
  return !!data.saleToastEnabled
}

export function setSaleToastEnabledLocal(enabled) {
  data.saleToastEnabled = !!enabled
}

export async function saveSaleToastEnabled(enabled) {
  data.saleToastEnabled = !!enabled
  await saveSetting('sale_toast_enabled', !!enabled)
}

export function getDmChatEnabled() {
  return !!data.dmChatEnabled
}

export function setDmChatEnabledLocal(enabled) {
  data.dmChatEnabled = !!enabled
}

export async function saveDmChatEnabled(enabled) {
  data.dmChatEnabled = !!enabled
  await saveSetting('dm_chat_enabled', !!enabled)
}

export function getRequireFollowupOnCreate() {
  return !!data.requireFollowupOnCreate
}

export function setRequireFollowupOnCreateLocal(enabled) {
  data.requireFollowupOnCreate = !!enabled
}

export async function saveRequireFollowupOnCreate(enabled) {
  data.requireFollowupOnCreate = !!enabled
  await saveSetting('require_followup_on_create', !!enabled)
}

/**
 * Conversion-card sales amount: when true, approved payments must also fall in the
 * dashboard date range; when false, all payments since customerCode first-fill.
 */
export function getDashConversionAmountInRange() {
  return data.dashConversionAmountInRange !== false
}

export function setDashConversionAmountInRangeLocal(enabled) {
  data.dashConversionAmountInRange = !!enabled
}

export async function saveDashConversionAmountInRange(enabled) {
  data.dashConversionAmountInRange = !!enabled
  await saveSetting('dash_conversion_amount_in_range', !!enabled)
}

/** Daily morning/evening digests — default ON when unset. */
export function getOpsDigestEnabled() {
  return data.opsDigestEnabled !== false
}

export function setOpsDigestEnabledLocal(enabled) {
  data.opsDigestEnabled = !!enabled
}

export async function saveOpsDigestEnabled(enabled) {
  data.opsDigestEnabled = !!enabled
  await saveSetting('ops_digest_enabled', !!enabled)
}

export function getSmsPanel() {
  return normalizeSmsPanel(data.smsPanel)
}

export async function saveSmsPanel(config) {
  const cleaned = normalizeSmsPanel(config)
  // Credentials live in Edge SMS_* secrets — never persist password client-side.
  cleaned.password = ''
  data.smsPanel = cleaned
  await saveSetting('sms_panel', cleaned)
}

export function getSmsFeatures() {
  return normalizeSmsFeatures(data.smsFeatures)
}

export async function saveSmsFeatures(features) {
  const cleaned = normalizeSmsFeatures(features)
  data.smsFeatures = cleaned
  await saveSetting('sms_features', cleaned)
}

export function getFollowupSmsDefaultHour() {
  return normalizeFollowupDefaultHour(data.smsFollowupDefaultHour)
}

/** @returns {string} "HH:MM" for scheduling */
export function getFollowupSmsDefaultTime() {
  return getFollowupSmsDefaultHour()
}

export async function saveFollowupSmsDefaultHour(hour) {
  const cleaned = normalizeFollowupDefaultHour(hour)
  data.smsFollowupDefaultHour = cleaned
  await saveSetting('sms_followup_default_hour', cleaned)
}

export async function listSmsTemplates() {
  const tenantId = getStoredTenantId()
  let q = supabase.from('sms_templates').select('*').order('key')
  if (tenantId) q = q.eq('tenant_id', tenantId)
  const { data: rows, error } = await q
  if (error) throw new Error('خطا در خواندن قالب‌ها: ' + error.message)

  const existing = rows || []
  const have = new Set(existing.map((r) => String(r.key || '')))
  const missing = DEFAULT_SMS_TEMPLATES.filter((t) => !have.has(t.key))

  if (!missing.length) return existing

  // Seed any newly added default templates (e.g. sale_settlement_due) without wiping customs
  if (!tenantId) {
    return [
      ...existing,
      ...missing.map((t) => ({ ...t, enabled: true })),
    ].sort((a, b) => String(a.key).localeCompare(String(b.key)))
  }

  const inserts = missing.map((t) => ({
    tenant_id: tenantId,
    key: t.key,
    name: t.name,
    body: t.body,
    enabled: true,
  }))
  const { data: seeded, error: seedErr } = await supabase
    .from('sms_templates')
    .upsert(inserts, { onConflict: 'tenant_id,key' })
    .select('*')
  if (seedErr) {
    console.warn('sms template seed missing', seedErr)
    return [
      ...existing,
      ...missing.map((t) => ({ ...t, enabled: true })),
    ].sort((a, b) => String(a.key).localeCompare(String(b.key)))
  }

  const byKey = new Map()
  for (const r of existing) byKey.set(String(r.key), r)
  for (const r of seeded || []) byKey.set(String(r.key), r)
  return [...byKey.values()].sort((a, b) => String(a.key).localeCompare(String(b.key)))
}

export async function saveSmsTemplateRow(template) {
  const tenantId = getStoredTenantId()
  if (!tenantId) throw new Error('سازمان انتخاب نشده')
  const row = {
    tenant_id: tenantId,
    key: String(template.key || '').trim(),
    name: String(template.name || '').trim(),
    body: String(template.body || ''),
    enabled: template.enabled !== false,
    updated_at: new Date().toISOString(),
  }
  const { data: saved, error } = await supabase
    .from('sms_templates')
    .upsert(row, { onConflict: 'tenant_id,key' })
    .select('*')
    .maybeSingle()
  if (error) throw new Error('خطا در ذخیره قالب: ' + error.message)
  return saved
}

export async function listSmsLogs({ limit = 50, kind = '' } = {}) {
  const tenantId = getStoredTenantId()
  let q = supabase
    .from('sms_logs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (tenantId) q = q.eq('tenant_id', tenantId)
  if (kind) q = q.eq('kind', kind)
  const { data: rows, error } = await q
  if (error) throw new Error('خطا در خواندن تاریخچه: ' + error.message)
  return rows || []
}

/** SMS logs for one customer (for the customer panel SMS tab), newest first. */
export async function listCustomerSmsLogs(customerId, { limit = 20 } = {}) {
  const tenantId = getStoredTenantId()
  const cid = String(customerId || '').trim()
  if (!tenantId || !cid) return []
  const { data: rows, error } = await supabase
    .from('sms_logs')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('customer_id', cid)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error('خطا در خواندن پیامک‌های مشتری: ' + error.message)
  return rows || []
}

/** Exact count of SMS logs for one customer (for the tab badge). */
export async function countCustomerSmsLogs(customerId) {
  const tenantId = getStoredTenantId()
  const cid = String(customerId || '').trim()
  if (!tenantId || !cid) return 0
  const { count, error } = await supabase
    .from('sms_logs')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('customer_id', cid)
  if (error) return 0
  return Number(count || 0)
}

/** SMS kinds grouped for dashboard report card. */
export const SMS_DASH_CATEGORIES = Object.freeze({
  settlement: ['sale_settlement_due'],
  followup: ['followup_schedule', 'followup_bulk'],
  shipment: ['shipment_queued', 'shipment_shipped'],
})

/**
 * Count sent SMS logs by dashboard category for an ISO range (inclusive).
 * @param {{ fromIso: string, toIso: string }} range
 * @returns {Promise<{ settlement: number, followup: number, shipment: number, other: number, total: number }>}
 */
export async function countSmsLogsByDashCategory({ fromIso, toIso }) {
  const empty = { settlement: 0, followup: 0, shipment: 0, other: 0, total: 0 }
  const tenantId = getStoredTenantId()
  if (!tenantId || !fromIso || !toIso) return empty

  const { data: rows, error } = await supabase
    .from('sms_logs')
    .select('kind')
    .eq('tenant_id', tenantId)
    .eq('status', 'sent')
    .gte('created_at', fromIso)
    .lte('created_at', toIso)
    .limit(20000)

  if (error) {
    console.warn('countSmsLogsByDashCategory', error)
    return empty
  }

  const settlementSet = new Set(SMS_DASH_CATEGORIES.settlement)
  const followupSet = new Set(SMS_DASH_CATEGORIES.followup)
  const shipmentSet = new Set(SMS_DASH_CATEGORIES.shipment)
  const out = { ...empty }

  for (const r of rows || []) {
    const kind = String(r?.kind || '')
    out.total += 1
    if (settlementSet.has(kind)) out.settlement += 1
    else if (followupSet.has(kind)) out.followup += 1
    else if (shipmentSet.has(kind)) out.shipment += 1
    else out.other += 1
  }
  return out
}

/**
 * Keys already sent today (Tehran) for settlement-due SMS: `${customerId}::${productIndex}`
 * Used to enforce at most one settlement SMS per product per customer per day.
 */
export async function listSettlementSmsSentTodayKeys() {
  const tenantId = getStoredTenantId()
  if (!tenantId) return new Set()

  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
  const dayStart = new Date(`${day}T00:00:00+03:30`).toISOString()
  const dayEnd = new Date(`${day}T23:59:59.999+03:30`).toISOString()

  const { data: rows, error } = await supabase
    .from('sms_logs')
    .select('customer_id, meta, status')
    .eq('tenant_id', tenantId)
    .eq('kind', 'sale_settlement_due')
    .eq('status', 'sent')
    .gte('created_at', dayStart)
    .lte('created_at', dayEnd)
    .limit(2000)
  if (error) {
    console.warn('listSettlementSmsSentTodayKeys', error)
    return new Set()
  }
  const keys = new Set()
  for (const r of rows || []) {
    const cid = String(r.customer_id || '').trim()
    if (!cid) continue
    const meta = r.meta && typeof r.meta === 'object' ? r.meta : {}
    const idx = meta.productIndex
    const productIndex = Number.isFinite(Number(idx)) ? Number(idx) : null
    if (productIndex == null || productIndex < 0) continue
    const reminderKind = String(meta.reminderKind || 'due').trim() === 'minus3' ? 'minus3' : 'due'
    keys.add(`${cid}::${productIndex}::${reminderKind}`)
    // Legacy rows without reminderKind counted as due-day send
    if (!meta.reminderKind) keys.add(`${cid}::${productIndex}::due`)
  }
  return keys
}

/**
 * Sent event SMS logs for attendee badges (kind = event_single).
 * Returns newest-first rows with customer_id + meta (sessionId, productIndex, event_message_type).
 */
export async function listEventSmsSentLogs({ limit = 5000 } = {}) {
  const tenantId = getStoredTenantId()
  if (!tenantId) return []

  const { data: rows, error } = await supabase
    .from('sms_logs')
    .select('customer_id, meta, created_at, status')
    .eq('tenant_id', tenantId)
    .eq('kind', 'event_single')
    .eq('status', 'sent')
    .order('created_at', { ascending: false })
    .limit(Math.max(1, Math.min(10000, Number(limit) || 5000)))
  if (error) {
    console.warn('listEventSmsSentLogs', error)
    return []
  }
  return rows || []
}

export async function createSmsCampaign(campaign) {
  const tenantId = getStoredTenantId()
  if (!tenantId) throw new Error('سازمان انتخاب نشده')
  const row = {
    tenant_id: tenantId,
    title: String(campaign.title || 'کمپین پیامک').trim(),
    template_key: campaign.template_key || null,
    body: campaign.body || null,
    filter: campaign.filter || {},
    mode: campaign.mode || 'immediate',
    status: campaign.status || 'sending',
    total: Number(campaign.total || 0),
    sent: 0,
    failed: 0,
    send_at: campaign.send_at || null,
    drip_interval_min: Number(campaign.drip_interval_min || 5),
    drip_batch_size: Number(campaign.drip_batch_size || 20),
    next_batch_at: campaign.next_batch_at || null,
    created_by: campaign.created_by || null,
  }
  const { data: saved, error } = await supabase.from('sms_campaigns').insert(row).select('*').single()
  if (error) throw new Error('خطا در ایجاد کمپین: ' + error.message)
  return saved
}

export async function listSmsCampaigns({ limit = 30 } = {}) {
  const tenantId = getStoredTenantId()
  let q = supabase
    .from('sms_campaigns')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (tenantId) q = q.eq('tenant_id', tenantId)
  const { data: rows, error } = await q
  if (error) throw new Error('خطا در خواندن کمپین‌ها: ' + error.message)
  return rows || []
}

export async function createSmsSchedule(schedule) {
  const tenantId = getStoredTenantId()
  if (!tenantId) throw new Error('سازمان انتخاب نشده')
  const row = {
    tenant_id: tenantId,
    customer_id: schedule.customer_id || null,
    campaign_id: schedule.campaign_id || null,
    kind: schedule.kind || 'followup_schedule',
    template_key: schedule.template_key || 'followup_due',
    body_override: schedule.body_override || null,
    send_at: schedule.send_at,
    status: 'pending',
    meta: schedule.meta || {},
    created_by: schedule.created_by || null,
  }
  const { data: saved, error } = await supabase.from('sms_schedules').insert(row).select('*').single()
  if (error) throw new Error('خطا در زمان‌بندی پیامک: ' + error.message)
  return saved
}

export async function cancelPendingSmsSchedulesForCustomer(customerId) {
  const tenantId = getStoredTenantId()
  if (!tenantId || !customerId) return
  await supabase
    .from('sms_schedules')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)
    .eq('customer_id', customerId)
    .eq('status', 'pending')
    .eq('kind', 'followup_schedule')
}

/** Cancel pending settlement-due SMS schedules for a customer (all products). */
export async function cancelPendingSettlementSmsForCustomer(customerId) {
  const tenantId = getStoredTenantId()
  if (!tenantId || !customerId) return
  await supabase
    .from('sms_schedules')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)
    .eq('customer_id', customerId)
    .eq('status', 'pending')
    .eq('kind', 'sale_settlement_due')
}

const AUTO_SMS_SCHEDULE_KINDS = ['followup_schedule', 'sale_settlement_due']

/** Pending auto schedules (follow-up + settlement) for current tenant. */
export async function listPendingAutoSmsSchedules({ limit = 200 } = {}) {
  const tenantId = getStoredTenantId()
  if (!tenantId) return []
  const { data: rows, error } = await supabase
    .from('sms_schedules')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('status', 'pending')
    .in('kind', AUTO_SMS_SCHEDULE_KINDS)
    .order('send_at', { ascending: true })
    .limit(limit)
  if (error) throw new Error('خطا در خواندن زمان‌بندی پیامک: ' + error.message)
  return rows || []
}

/** Pending schedules whose send_at is due (any kind). */
export async function listDuePendingSmsSchedules({ limit = 50 } = {}) {
  const tenantId = getStoredTenantId()
  if (!tenantId) return []
  const nowIso = new Date().toISOString()
  const { data: rows, error } = await supabase
    .from('sms_schedules')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('status', 'pending')
    .lte('send_at', nowIso)
    .order('send_at', { ascending: true })
    .limit(limit)
  if (error) throw new Error('خطا در خواندن صف پیامک: ' + error.message)
  return rows || []
}

export async function updateSmsScheduleRow(id, patch) {
  const tenantId = getStoredTenantId()
  if (!tenantId || !id) return null
  const { data: saved, error } = await supabase
    .from('sms_schedules')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .select('*')
    .maybeSingle()
  if (error) throw new Error('خطا در به‌روزرسانی زمان‌بندی: ' + error.message)
  return saved
}

export function getShippingSender() {
  return normalizeShippingSender(data.shippingSender)
}

export async function saveShippingSender(config) {
  const cleaned = normalizeShippingSender(config)
  data.shippingSender = cleaned
  await saveSetting('shipping_sender', cleaned)
}

// ============================================
// Generate next ID
// ============================================

// High-water mark so deleted IDs are never reused (DATA-H3)
async function getNextIdNumber(prefix) {
  const counterKey = `id_counter_${prefix}`
  const tenantId = getStoredTenantId()
  let settingsQ = supabase.from('app_settings').select('value').eq('key', counterKey).limit(1)
  if (tenantId) settingsQ = settingsQ.eq('tenant_id', tenantId)

  const [{ data: settingsRows }, { data: rows, error: idsError }] = await Promise.all([
    settingsQ,
    fetchAllRows('customers', {
      select: 'id',
      orderCol: 'id',
      scopeTenant: true,
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

/** Reserve a contiguous block of CS/LD ids (one counter write). */
export async function generateIdBatch(type, count) {
  const n = Math.max(0, Math.floor(Number(count) || 0))
  if (!n) return []
  const prefix = type === 'CS' ? 'CS' : 'LD'
  const start = await getNextIdNumber(prefix)
  const last = start + n - 1
  await saveSetting(`id_counter_${prefix}`, last)
  return Array.from({ length: n }, (_, i) => prefix + String(start + i).padStart(4, '0'))
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
