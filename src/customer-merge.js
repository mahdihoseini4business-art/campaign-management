/**
 * Bulk customer merge — phase 1: two profiles, no eligibility gates.
 * Flow: conflict resolution modal → preview modal → persist.
 */
import {
  getData, saveCustomerToDB, deleteCustomerRowOnly, updateFollowupsCustomerId,
  updateRefundsCustomerId, generateId, rekeyCustomerId, cloneCustomerRecord,
  invalidateProductSalesCountCache, ensureCustomerDetailsLoaded, saveSetting,
  saveFollowupToDB
} from './data.js'
import {
  escapeHtml, escapeAttr, showToast, showToastWithAction, normalizePhone, getCustomerPhones, getPrimaryPhone,
  getCustomerAddresses, getPlatformLabels, getStatusLabels,
  formatCustomerLevel, resolveCustomerLevel, syncCustomerLevel,
  ensureProductPayments, syncProductStatus, toEnDigits, formatNumber,
  requirePermission, findCustomersByPhonePrefix, matchesTabSearch,
  canViewCustomer, getNowJalaliDateTime, getCurrentUser,
  MAX_CUSTOMER_PHONES, MAX_CUSTOMER_ADDRESSES
} from './utils.js'
import { renderCustomers, openCustomerDetail, getOpenDetailCustomerId } from './customers.js'

/** @typedef {{ key: string, label: string, survivorVal: string, sourceVal: string, survivorDisplay?: string, sourceDisplay?: string }} MergeConflict */

/** @type {{ survivorId: string, sourceId: string, choices: Record<string, 'survivor'|'source'>, merged: object | null } | null} */
let pendingBulkMerge = null

/** @type {{ anchorCustomerId: string | null, selectedPartnerId: string | null, lastMatches: Array<{ customer: object, matchedPhone: string, matchKind?: string }> }} */
let detailMergePickState = { anchorCustomerId: null, selectedPartnerId: null, lastMatches: [] }

const SCALAR_FIELDS = [
  { key: 'name', label: 'نام' },
  { key: 'platformId', label: 'آیدی پلتفرم', compare: (a, b) => a.toLowerCase() === b.toLowerCase() },
  { key: 'platform', label: 'پلتفرم', display: (v) => getPlatformLabels()[v] || v },
  { key: 'status', label: 'وضعیت', display: (v) => getStatusLabels()[v] || v },
  { key: 'notes', label: 'یادداشت ثابت' },
  { key: 'customerCode', label: 'کد مشتری' },
  { key: 'referredByPhone', label: 'معرف (شماره)' },
  { key: 'nextFollowupDate', label: 'تاریخ پیگیری بعدی' },
  { key: 'advisor', label: 'کارشناس مسئول' },
  { key: 'customerLevel', label: 'سطح مشتری', display: (v) => formatCustomerLevel(v) || v }
]

function normStr(v) {
  return String(v ?? '').trim()
}

function displayVal(field, v) {
  if (!v) return '—'
  if (field.display) return field.display(v)
  return v
}

function scalarEqual(field, a, b) {
  const sa = normStr(a)
  const sb = normStr(b)
  if (!sa || !sb) return true
  if (field.compare) return field.compare(sa, sb)
  return sa === sb
}

function addressTextKey(entry) {
  return toEnDigits(normStr(entry?.text)).toLowerCase()
}

function addressEntryKey(entry) {
  const text = addressTextKey(entry)
  const postal = toEnDigits(normStr(entry?.postalCode))
  return `${text}|${postal}`
}

function formatAddressEntry(entry) {
  if (!entry?.text) return '—'
  const postal = entry.postalCode ? ` (${entry.postalCode})` : ''
  const pri = entry.isPrimary ? ' · اولویت ارسال' : ''
  return `${entry.text}${postal}${pri}`
}

function mergePhonesUnion(survivor, source) {
  const out = []
  const seen = new Set()
  for (const list of [getCustomerPhones(survivor), getCustomerPhones(source)]) {
    for (const raw of list) {
      const n = normalizePhone(raw)
      if (!n || !/^09\d{9}$/.test(n) || seen.has(n)) continue
      seen.add(n)
      out.push(n)
    }
  }
  return out
}

/**
 * @param {object} survivor
 * @param {object} source
 * @returns {MergeConflict[]}
 */
export function detectMergeConflicts(survivor, source) {
  /** @type {MergeConflict[]} */
  const conflicts = []

  for (const field of SCALAR_FIELDS) {
    const sv = normStr(survivor[field.key])
    const ov = normStr(source[field.key])
    if (!sv || !ov || scalarEqual(field, sv, ov)) continue
    conflicts.push({
      key: field.key,
      label: field.label,
      survivorVal: sv,
      sourceVal: ov,
      survivorDisplay: displayVal(field, sv),
      sourceDisplay: displayVal(field, ov)
    })
  }

  const advisorPhoneS = normalizePhone(survivor.advisorPhone)
  const advisorPhoneO = normalizePhone(source.advisorPhone)
  if (advisorPhoneS && advisorPhoneO && advisorPhoneS !== advisorPhoneO
    && !conflicts.some(c => c.key === 'advisor')) {
    const survLabel = [survivor.advisor, advisorPhoneS].filter(Boolean).join(' · ') || advisorPhoneS
    const srcLabel = [source.advisor, advisorPhoneO].filter(Boolean).join(' · ') || advisorPhoneO
    conflicts.push({
      key: 'advisorPhone',
      label: 'شماره کارشناس مسئول',
      survivorVal: advisorPhoneS,
      sourceVal: advisorPhoneO,
      survivorDisplay: survLabel,
      sourceDisplay: srcLabel
    })
  }

  if (!!survivor.customerLevelLocked !== !!source.customerLevelLocked) {
    conflicts.push({
      key: 'customerLevelLocked',
      label: 'قفل سطح مشتری',
      survivorVal: survivor.customerLevelLocked ? '1' : '0',
      sourceVal: source.customerLevelLocked ? '1' : '0',
      survivorDisplay: survivor.customerLevelLocked ? 'قفل دستی' : 'خودکار',
      sourceDisplay: source.customerLevelLocked ? 'قفل دستی' : 'خودکار'
    })
  }

  const addrByText = new Map()
  const registerAddr = (entry, side) => {
    const tk = addressTextKey(entry)
    if (!tk) return
    if (!addrByText.has(tk)) addrByText.set(tk, { survivor: null, source: null })
    addrByText.get(tk)[side] = entry
  }
  getCustomerAddresses(survivor).forEach(a => registerAddr(a, 'survivor'))
  getCustomerAddresses(source).forEach(a => registerAddr(a, 'source'))

  for (const [textKey, pair] of addrByText) {
    if (!pair.survivor || !pair.source) continue
    if (addressEntryKey(pair.survivor) === addressEntryKey(pair.source)) continue
    conflicts.push({
      key: `address:${textKey}`,
      label: `آدرس (${pair.survivor.text})`,
      survivorVal: addressEntryKey(pair.survivor),
      sourceVal: addressEntryKey(pair.source),
      survivorDisplay: formatAddressEntry(pair.survivor),
      sourceDisplay: formatAddressEntry(pair.source)
    })
  }

  return conflicts
}

function pickScalar(field, survivor, source, choices) {
  const sv = normStr(survivor[field.key])
  const ov = normStr(source[field.key])
  if (!sv && ov) return ov
  if (sv && !ov) return sv
  if (!sv && !ov) return ''
  if (scalarEqual(field, sv, ov)) return sv
  return (choices[field.key] === 'source' ? ov : sv)
}

function mergeAddressesUnion(survivor, source, choices) {
  const byText = new Map()
  const register = (entry, side) => {
    const tk = addressTextKey(entry)
    if (!tk) return
    if (!byText.has(tk)) byText.set(tk, { survivor: null, source: null })
    byText.get(tk)[side] = entry
  }
  getCustomerAddresses(survivor).forEach(a => register(a, 'survivor'))
  getCustomerAddresses(source).forEach(a => register(a, 'source'))

  const out = []
  for (const [textKey, pair] of byText) {
    let entry = null
    if (pair.survivor && pair.source && addressEntryKey(pair.survivor) !== addressEntryKey(pair.source)) {
      const pick = choices[`address:${textKey}`] === 'source' ? pair.source : pair.survivor
      entry = { ...pick }
    } else {
      entry = { ...(pair.survivor || pair.source) }
    }
    if (entry?.text) out.push(entry)
  }

  if (!out.length) return []
  let primaryIdx = out.findIndex(a => a.isPrimary)
  if (primaryIdx < 0) primaryIdx = 0
  out.forEach((a, i) => { a.isPrimary = i === primaryIdx })
  return out
}

/**
 * Build merged in-memory customer (survivor id retained).
 * @param {object} survivor
 * @param {object} source
 * @param {Record<string, 'survivor'|'source'>} choices
 */
export function buildMergedCustomerProfile(survivor, source, choices = {}) {
  const phones = mergePhonesUnion(survivor, source)
  const addresses = mergeAddressesUnion(survivor, source, choices)

  let advisor = pickScalar({ key: 'advisor' }, survivor, source, choices)
  let advisorPhone = normalizePhone(
    choices.advisorPhone === 'source' ? source.advisorPhone : survivor.advisorPhone
  )
  if (choices.advisor === 'source') {
    advisor = normStr(source.advisor) || advisor
    if (!choices.advisorPhone) advisorPhone = normalizePhone(source.advisorPhone)
  } else if (choices.advisor === 'survivor') {
    advisor = normStr(survivor.advisor) || advisor
    if (!choices.advisorPhone) advisorPhone = normalizePhone(survivor.advisorPhone)
  }
  if (!advisorPhone) {
    advisorPhone = normalizePhone(
      choices.advisorPhone === 'source' ? source.advisorPhone : survivor.advisorPhone
    ) || normalizePhone(source.advisorPhone)
  }

  const levelLockedChoice = choices.customerLevelLocked
  const customerLevelLocked = levelLockedChoice === 'source'
    ? !!source.customerLevelLocked
    : levelLockedChoice === 'survivor'
      ? !!survivor.customerLevelLocked
      : !!(survivor.customerLevelLocked || source.customerLevelLocked)

  const survivorProducts = Array.isArray(survivor.products) ? [...survivor.products] : []
  const sourceProducts = Array.isArray(source.products) ? [...source.products] : []

  const merged = {
    ...survivor,
    id: survivor.id,
    phones,
    phone: phones[0] || '',
    addresses,
    name: pickScalar({ key: 'name' }, survivor, source, choices),
    platformId: pickScalar({ key: 'platformId', compare: (a, b) => a.toLowerCase() === b.toLowerCase() }, survivor, source, choices),
    platform: pickScalar({ key: 'platform', display: (v) => v }, survivor, source, choices) || survivor.platform || 'instagram',
    status: pickScalar({ key: 'status', display: (v) => v }, survivor, source, choices) || survivor.status || 'new',
    notes: pickScalar({ key: 'notes' }, survivor, source, choices),
    customerCode: pickScalar({ key: 'customerCode' }, survivor, source, choices),
    referredByPhone: pickScalar({ key: 'referredByPhone' }, survivor, source, choices),
    nextFollowupDate: (() => {
      const sv = normStr(survivor.nextFollowupDate)
      const ov = normStr(source.nextFollowupDate)
      if (!sv && !ov) return ''
      if (!sv) return ov
      if (!ov) return sv
      if (sv === ov) return sv
      return choices.nextFollowupDate === 'source' ? ov : sv
    })(),
    customerLevel: pickScalar({ key: 'customerLevel', display: (v) => v }, survivor, source, choices),
    customerLevelLocked,
    advisor,
    advisorPhone,
    products: [...survivorProducts, ...sourceProducts],
    createdAt: survivor.createdAt || source.createdAt || null
  }

  merged.products.forEach(p => {
    ensureProductPayments(p)
    syncProductStatus(p)
  })

  return merged
}

function defaultChoices(conflicts) {
  /** @type {Record<string, 'survivor'|'source'>} */
  const choices = {}
  for (const c of conflicts) choices[c.key] = 'survivor'
  return choices
}

function renderConflictRow(conflict, survivorId, sourceId, choice) {
  const picked = choice || 'survivor'
  return `
    <div class="merge-conflict-row" data-key="${escapeAttr(conflict.key)}">
      <div class="merge-conflict-label">${escapeHtml(conflict.label)}</div>
      <div class="merge-conflict-choices">
        <label class="merge-choice">
          <input type="radio" name="mergeConflict_${escapeAttr(conflict.key)}" value="survivor"
            ${picked === 'survivor' ? 'checked' : ''}
            onchange="app.setBulkMergeConflictChoice('${escapeAttr(conflict.key)}', 'survivor')">
          <span class="merge-choice-id">${escapeHtml(survivorId)}</span>
          <span class="merge-choice-val">${escapeHtml(conflict.survivorDisplay || conflict.survivorVal || '—')}</span>
        </label>
        <label class="merge-choice">
          <input type="radio" name="mergeConflict_${escapeAttr(conflict.key)}" value="source"
            ${picked === 'source' ? 'checked' : ''}
            onchange="app.setBulkMergeConflictChoice('${escapeAttr(conflict.key)}', 'source')">
          <span class="merge-choice-id">${escapeHtml(sourceId)}</span>
          <span class="merge-choice-val">${escapeHtml(conflict.sourceDisplay || conflict.sourceVal || '—')}</span>
        </label>
      </div>
    </div>`
}

function hasAdvisorMismatch(a, b) {
  const pa = normalizePhone(a?.advisorPhone)
  const pb = normalizePhone(b?.advisorPhone)
  if (!pa || !pb) return false
  return pa !== pb
}

function renderAdvisorWarnBanner(survivor, source, merged, { inPreview = false } = {}) {
  if (!hasAdvisorMismatch(survivor, source)) return ''
  const advisorConflict = pendingBulkMerge?.choices?.advisor === 'source'
    || pendingBulkMerge?.choices?.advisorPhone === 'source'
  let text
  if (inPreview && merged) {
    text = `کارشناس مسئول نهایی: ${merged.advisor || '—'}${merged.advisorPhone ? ` · ${merged.advisorPhone}` : ''}`
  } else if (advisorConflict) {
    text = 'کارشناس مسئول این دو مشتری متفاوت است — مقدار نهایی را در تعارض‌های زیر انتخاب کنید.'
  } else {
    text = 'کارشناس مسئول این دو مشتری متفاوت است. پیش‌فرض: کارشناس مشتری بازمانده.'
  }
  return `<div class="merge-banner merge-banner--warn" role="status">${escapeHtml(text)}</div>`
}

function truncateNotes(notes, max = 120) {
  const s = normStr(notes)
  if (!s) return '—'
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function formatPhonesInline(customer) {
  const phones = getCustomerPhones(customer)
  return phones.length ? phones.map(p => escapeHtml(p)).join('<br>') : '—'
}

function formatAddressesInline(customer) {
  const addrs = getCustomerAddresses(customer)
  if (!addrs.length) return '—'
  return addrs.map(a => {
    const postal = a.postalCode ? ` <span class="merge-preview-muted">(${escapeHtml(a.postalCode)})</span>` : ''
    const pri = a.isPrimary ? ' <span class="address-primary-badge">اولویت</span>' : ''
    return `<div>${escapeHtml(a.text)}${postal}${pri}</div>`
  }).join('')
}

function renderCompareRow(label, beforeHtml, afterHtml, changed = false) {
  const cls = changed ? ' merge-diff-changed' : ''
  return `<tr>
    <th scope="row">${escapeHtml(label)}</th>
    <td class="merge-compare-before${cls}">${beforeHtml}</td>
    <td class="merge-compare-after${cls}">${afterHtml}</td>
  </tr>`
}

function renderMergePreviewHtml({ survivor, source, merged }) {
  const platforms = getPlatformLabels()
  const statuses = getStatusLabels()
  const data = getData()
  const sourceId = source.id
  const sourceName = source.name || source.platformId || 'بدون نام'
  const sourceFollowups = data.followups.filter(f => f.customerId === sourceId).length
  const sourceProducts = (source.products || []).length
  const sourceRefunds = (data.refunds || []).filter(r => String(r.customerId) === String(sourceId)).length

  const mergedPhones = getCustomerPhones(merged)
  const mergedAddrs = getCustomerAddresses(merged)
  const limitWarnings = []
  if (mergedPhones.length > MAX_CUSTOMER_PHONES) {
    limitWarnings.push(`تعداد شماره (${mergedPhones.length}) از سقف ${MAX_CUSTOMER_PHONES} بیشتر است — ممکن است در ویرایش بعدی محدود شود.`)
  }
  if (mergedAddrs.length > MAX_CUSTOMER_ADDRESSES) {
    limitWarnings.push(`تعداد آدرس (${mergedAddrs.length}) از سقف ${MAX_CUSTOMER_ADDRESSES} بیشتر است — ممکن است در ویرایش بعدی محدود شود.`)
  }

  const levelBefore = formatCustomerLevel(resolveCustomerLevel(survivor, data.customers, data.followups))
  const levelAfter = formatCustomerLevel(
    merged.customerLevelLocked
      ? (merged.customerLevel || resolveCustomerLevel(merged, data.customers, data.followups))
      : resolveCustomerLevel(merged, data.customers, data.followups)
  )

  const advisorBefore = `${escapeHtml(survivor.advisor || '—')}${survivor.advisorPhone ? `<br><span dir="ltr">${escapeHtml(survivor.advisorPhone)}</span>` : ''}`
  const advisorAfter = `${escapeHtml(merged.advisor || '—')}${merged.advisorPhone ? `<br><span dir="ltr">${escapeHtml(merged.advisorPhone)}</span>` : ''}`

  const metaStrip = `
    <dl class="merge-preview-meta">
      <div><dt>شناسه</dt><dd><span class="id-badge">${escapeHtml(merged.id)}</span></dd></div>
      <div><dt>پلتفرم</dt><dd>${escapeHtml(platforms[merged.platform] || merged.platform || '—')}</dd></div>
      <div><dt>پیگیری بعدی</dt><dd>${escapeHtml(merged.nextFollowupDate || '—')}</dd></div>
      <div><dt>کد مشتری</dt><dd>${escapeHtml(merged.customerCode || '—')}</dd></div>
    </dl>`

  const compareTable = `
    <table class="merge-preview-compare">
      <thead>
        <tr>
          <th scope="col"></th>
          <th scope="col">قبل</th>
          <th scope="col">بعد</th>
        </tr>
      </thead>
      <tbody>
        ${renderCompareRow('نام', escapeHtml(survivor.name || '—'), escapeHtml(merged.name || '—'), normStr(survivor.name) !== normStr(merged.name))}
        ${renderCompareRow('آیدی پلتفرم', escapeHtml(survivor.platformId || '—'), escapeHtml(merged.platformId || '—'), normStr(survivor.platformId).toLowerCase() !== normStr(merged.platformId).toLowerCase())}
        ${renderCompareRow('وضعیت', escapeHtml(statuses[survivor.status] || survivor.status || '—'), escapeHtml(statuses[merged.status] || merged.status || '—'), survivor.status !== merged.status)}
        ${renderCompareRow('شماره‌ها', formatPhonesInline(survivor), formatPhonesInline(merged), formatPhonesInline(survivor) !== formatPhonesInline(merged))}
        ${renderCompareRow('آدرس‌ها', formatAddressesInline(survivor), formatAddressesInline(merged), formatAddressesInline(survivor) !== formatAddressesInline(merged))}
        ${renderCompareRow('کارشناس', advisorBefore, advisorAfter, hasAdvisorMismatch(survivor, merged) || survivor.advisor !== merged.advisor)}
        ${renderCompareRow('یادداشت', escapeHtml(truncateNotes(survivor.notes)), escapeHtml(truncateNotes(merged.notes)), normStr(survivor.notes) !== normStr(merged.notes))}
        ${renderCompareRow('فروش‌ها', formatNumber((survivor.products || []).length), formatNumber((merged.products || []).length), (survivor.products || []).length !== (merged.products || []).length)}
        ${renderCompareRow('سطح', escapeHtml(levelBefore), escapeHtml(levelAfter), levelBefore !== levelAfter)}
      </tbody>
    </table>`

  const limitHtml = limitWarnings.length
    ? limitWarnings.map(w => `<div class="merge-banner merge-banner--warn">${escapeHtml(w)}</div>`).join('')
    : ''

  return `
    ${renderAdvisorWarnBanner(survivor, source, merged, { inPreview: true })}
    <div class="merge-banner merge-banner--danger" role="alert">
      <span class="id-badge">${escapeHtml(sourceId)}</span>
      <span class="merge-banner-text">${escapeHtml(sourceName)} حذف می‌شود — ${formatNumber(sourceProducts)} فروش، ${formatNumber(sourceFollowups)} پیگیری، ${formatNumber(sourceRefunds)} عودت منتقل می‌شوند.</span>
    </div>
    ${limitHtml}
    ${metaStrip}
    ${compareTable}`
}

async function writeMergeAuditFollowup({ finalSurvivorId, sourceId, sourceLabel, actedBy = getCurrentUser() }) {
  const { date, time, dateTime } = getNowJalaliDateTime()
  const note = {
    customerId: finalSurvivorId,
    date: dateTime,
    type: 'سیستمی',
    result: 'ادغام مشتری',
    nextDate: '',
    notes: `پروفایل ${sourceId} (${sourceLabel || '—'}) در تاریخ ${date} ساعت ${time} با این مشتری ادغام شد.`,
    createdByPhone: normalizePhone(actedBy?.phone || '')
  }
  try {
    const fid = await saveFollowupToDB(note)
    note.id = fid
    getData().followups.push(note)
  } catch (e) {
    console.warn('merge audit followup skipped:', e?.message || e)
  }
}

async function loadCustomerForMerge(id) {
  await ensureCustomerDetailsLoaded(id)
  const data = getData()
  const c = data.customers.find(x => x.id === id)
  if (!c) throw new Error(`مشتری ${id} یافت نشد`)
  return c
}

function getSurvivorAndSource() {
  if (!pendingBulkMerge) return { survivor: null, source: null }
  const data = getData()
  const survivor = data.customers.find(c => c.id === pendingBulkMerge.survivorId)
  const source = data.customers.find(c => c.id === pendingBulkMerge.sourceId)
  return { survivor, source }
}

function rebuildMergedPreview() {
  const { survivor, source } = getSurvivorAndSource()
  if (!survivor || !source || !pendingBulkMerge) return null
  const merged = buildMergedCustomerProfile(survivor, source, pendingBulkMerge.choices)
  pendingBulkMerge.merged = merged
  return merged
}

function openPreviewModal(merged) {
  const { survivor, source } = getSurvivorAndSource()
  const body = document.getElementById('bulkMergePreviewBody')
  if (body && survivor && source) {
    body.innerHTML = renderMergePreviewHtml({ survivor, source, merged })
  }
  document.getElementById('bulkMergePreviewModal')?.classList.add('active')
}

function closeConflictModal() {
  document.getElementById('bulkMergeConflictModal')?.classList.remove('active')
}

export function closeBulkMergePreviewModal() {
  document.getElementById('bulkMergePreviewModal')?.classList.remove('active')
}

export function backBulkMergePreviewToConflicts() {
  closeBulkMergePreviewModal()
  if (!pendingBulkMerge) return
  const { survivor, source } = getSurvivorAndSource()
  if (!survivor || !source) return
  const conflicts = detectMergeConflicts(survivor, source)
  renderConflictModalContent(survivor, source, conflicts)
  document.getElementById('bulkMergeConflictModal')?.classList.add('active')
}

export function closeBulkMergeConflictModal() {
  closeConflictModal()
  pendingBulkMerge = null
}

export function setBulkMergeSurvivor(survivorId) {
  if (!pendingBulkMerge) return
  const ids = pendingBulkMerge._ids || []
  if (!ids.includes(survivorId)) return
  const sourceId = ids.find(id => id !== survivorId)
  if (!sourceId || sourceId === survivorId) return
  pendingBulkMerge.survivorId = survivorId
  pendingBulkMerge.sourceId = sourceId
  const { survivor, source } = getSurvivorAndSource()
  if (!survivor || !source) return
  const conflicts = detectMergeConflicts(survivor, source)
  pendingBulkMerge.choices = defaultChoices(conflicts)
  renderConflictModalContent(survivor, source, conflicts)
}

export function setBulkMergeConflictChoice(key, side) {
  if (!pendingBulkMerge) return
  pendingBulkMerge.choices[key] = side === 'source' ? 'source' : 'survivor'
}

function renderConflictModalContent(survivor, source, conflicts) {
  const list = document.getElementById('bulkMergeConflictList')
  const intro = document.getElementById('bulkMergeConflictIntro')
  const advisorWarn = document.getElementById('bulkMergeAdvisorWarn')
  if (intro) {
    intro.textContent = conflicts.length
      ? 'فیلدهای متفاوت را انتخاب کنید. شماره و آدرس بدون تداخل خودکار جمع می‌شوند.'
      : 'تعارض فیلدی نیست — شماره، آدرس و داده‌های وابسته ادغام می‌شوند.'
  }
  if (advisorWarn) {
    const html = renderAdvisorWarnBanner(survivor, source, null, { inPreview: false })
    if (html) {
      advisorWarn.innerHTML = html
      advisorWarn.hidden = false
    } else {
      advisorWarn.innerHTML = ''
      advisorWarn.hidden = true
    }
  }
  if (list) {
    list.innerHTML = conflicts.length
      ? conflicts.map(c => renderConflictRow(c, survivor.id, source.id, pendingBulkMerge?.choices[c.key])).join('')
      : '<p class="merge-conflict-empty">تعارض فیلدی برای انتخاب وجود ندارد.</p>'
  }

  document.querySelectorAll('input[name="bulkMergeSurvivor"]').forEach(r => {
    r.checked = r.value === survivor.id
  })
}

function proceedToPreview() {
  const merged = rebuildMergedPreview()
  if (!merged || !pendingBulkMerge) return
  closeConflictModal()
  openPreviewModal(merged)
}

export function confirmBulkMergeConflicts() {
  if (!pendingBulkMerge) {
    closeBulkMergeConflictModal()
    return
  }
  proceedToPreview()
}

export function skipBulkMergeConflicts() {
  proceedToPreview()
}

export async function confirmBulkMergePreview() {
  if (!requirePermission('customers_merge')) return
  if (!pendingBulkMerge?.merged) {
    closeBulkMergePreviewModal()
    return
  }
  const btn = document.getElementById('bulkMergePreviewConfirmBtn')
  if (btn) { btn.disabled = true; btn.textContent = 'در حال ادغام...' }

  try {
    const { survivorId, sourceId, merged } = pendingBulkMerge
    const finalId = await executeCustomerMerge({ survivorId, sourceId, merged })
    closeBulkMergePreviewModal()
    pendingBulkMerge = null
    const { clearSelection } = await import('./bulk.js')
    clearSelection('customers')
    await renderCustomers()
    await openCustomerDetail(finalId)
    showToastWithAction(`ادغام انجام شد — ${sourceId} داخل ${finalId} ادغام شد`, {
      actionLabel: `مشاهده ${finalId}`,
      onAction: () => { openCustomerDetail(finalId) }
    })
  } catch (e) {
    console.error('confirmBulkMergePreview error:', e)
    showToast(e?.message || 'خطا در ادغام مشتریان')
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'تأیید ادغام' }
  }
}

/**
 * @param {{ survivorId: string, sourceId: string, merged: object }} params
 */
/** @returns {Promise<string>} final survivor id */
async function executeCustomerMerge({ survivorId, sourceId, merged }) {
  const data = getData()
  const sourceCustomer = data.customers.find(c => c.id === sourceId)
  const sourceLabel = sourceCustomer?.name || sourceCustomer?.platformId || sourceId
  let finalSurvivorId = survivorId
  let toSave = cloneCustomerRecord(merged, { id: survivorId })

  syncCustomerLevel(toSave, data.customers.filter(c => c.id !== sourceId), data.followups)

  const wasLd = String(survivorId).startsWith('LD')
  const hasPhone = getCustomerPhones(toSave).length > 0

  if (wasLd && hasPhone) {
    const newId = await generateId('CS')
    toSave = cloneCustomerRecord(toSave, { id: newId })
    await rekeyCustomerId(survivorId, toSave)
    finalSurvivorId = newId
  } else {
    await saveCustomerToDB(toSave)
    const idx = data.customers.findIndex(c => c.id === finalSurvivorId)
    if (idx >= 0) data.customers[idx] = toSave
    else data.customers.push(toSave)
  }

  await updateFollowupsCustomerId(sourceId, finalSurvivorId)
  data.followups.forEach(f => { if (f.customerId === sourceId) f.customerId = finalSurvivorId })

  await updateRefundsCustomerId(sourceId, finalSurvivorId)
  ;(data.refunds || []).forEach(r => {
    if (String(r.customerId) === String(sourceId)) r.customerId = finalSurvivorId
  })

  await deleteCustomerRowOnly(sourceId)
  data.customers = data.customers.filter(c => c.id !== sourceId)

  if (wasLd && hasPhone) {
    await saveSetting('convertedCount', (data.convertedCount || 0) + 1)
    data.convertedCount = (data.convertedCount || 0) + 1
  }

  await writeMergeAuditFollowup({ finalSurvivorId, sourceId, sourceLabel })

  invalidateProductSalesCountCache()
  return finalSurvivorId
}

function platformIdSearchKey(raw) {
  const s = String(raw || '').trim()
  if (s.startsWith('@')) return s.slice(1).trim().toLowerCase()
  return s.toLowerCase()
}

function customerMatchesPlatformId(c, query) {
  const key = platformIdSearchKey(query)
  if (!key || key.length < 2) return false
  const pid = normStr(c.platformId).toLowerCase()
  if (!pid) return false
  return pid.includes(key) || `@${pid}`.includes(key)
}

function findCustomersForMergeSearch(query, customers, { excludeId = null, limit = 8 } = {}) {
  const raw = String(query || '').trim()
  if (raw.length < 2) return []

  const byId = new Map()
  const digits = toEnDigits(raw).replace(/\D/g, '')

  if (digits.length >= 3) {
    for (const hit of findCustomersByPhonePrefix(digits, customers, { excludeId, limit })) {
      if (!canViewCustomer(hit.customer)) continue
      byId.set(hit.customer.id, { ...hit, matchKind: 'phone' })
    }
  }

  const q = toEnDigits(raw).trim().toLowerCase()
  const platformQ = platformIdSearchKey(raw)

  for (const c of customers || []) {
    if (excludeId && c.id === excludeId) continue
    if (!canViewCustomer(c)) continue
    if (byId.has(c.id)) continue

    if (platformQ.length >= 2 && customerMatchesPlatformId(c, raw)) {
      const pid = normStr(c.platformId)
      byId.set(c.id, {
        customer: c,
        matchedPhone: pid ? `@${pid}` : '',
        exact: false,
        matchKind: 'platformId'
      })
      continue
    }

    const fields = [
      c.id,
      c.name,
      c.platformId,
      c.advisor,
      c.customerCode,
      ...getCustomerPhones(c)
    ]
    if (!matchesTabSearch(q, fields)) continue
    byId.set(c.id, {
      customer: c,
      matchedPhone: getPrimaryPhone(c) || normStr(c.platformId) || '',
      exact: false,
      matchKind: 'text'
    })
  }

  return [...byId.values()].slice(0, Math.max(0, limit))
}

function hideDetailMergePartnerSuggest() {
  const box = document.getElementById('detailMergePartnerSuggest')
  if (box) {
    box.hidden = true
    box.innerHTML = ''
  }
}

function renderDetailMergePartnerSelected(customer) {
  const el = document.getElementById('detailMergePartnerSelected')
  const searchEl = document.getElementById('detailMergePartnerSearch')
  const hidden = document.getElementById('detailMergePartnerId')
  const btn = document.getElementById('detailMergePartnerContinueBtn')
  if (!el || !customer) return
  const phone = getPrimaryPhone(customer)
  const platformTag = customer.platformId ? `@${customer.platformId}` : ''
  el.hidden = false
  el.innerHTML = `
    <div class="merge-partner-selected-row">
      <div>
        <div><strong>${escapeHtml(customer.name || customer.platformId || customer.id)}</strong></div>
        <div class="merge-partner-selected-id">${escapeHtml(customer.id)}${phone ? ` · ${escapeHtml(phone)}` : ''}${platformTag ? ` · ${escapeHtml(platformTag)}` : ''}</div>
      </div>
      <button type="button" class="btn btn-sm" onclick="app.clearDetailMergePartnerSelection()">پاک کردن</button>
    </div>
  `
  if (hidden) hidden.value = customer.id
  if (searchEl) searchEl.value = customer.name || customer.platformId || customer.id
  if (btn) btn.disabled = false
  hideDetailMergePartnerSuggest()
}

export function clearDetailMergePartnerSelection() {
  detailMergePickState.selectedPartnerId = null
  const el = document.getElementById('detailMergePartnerSelected')
  const hidden = document.getElementById('detailMergePartnerId')
  const btn = document.getElementById('detailMergePartnerContinueBtn')
  const searchEl = document.getElementById('detailMergePartnerSearch')
  if (el) { el.hidden = true; el.innerHTML = '' }
  if (hidden) hidden.value = ''
  if (searchEl) searchEl.value = ''
  if (btn) btn.disabled = true
  searchEl?.focus()
}

function clearDetailMergePartnerSelectionInternal() {
  detailMergePickState.selectedPartnerId = null
  const el = document.getElementById('detailMergePartnerSelected')
  const hidden = document.getElementById('detailMergePartnerId')
  const btn = document.getElementById('detailMergePartnerContinueBtn')
  if (el) { el.hidden = true; el.innerHTML = '' }
  if (hidden) hidden.value = ''
  if (btn) btn.disabled = true
}

export function closeDetailMergePickModal() {
  document.getElementById('detailMergePickModal')?.classList.remove('active')
  detailMergePickState = { anchorCustomerId: null, selectedPartnerId: null, lastMatches: [] }
  hideDetailMergePartnerSuggest()
}

export function onDetailMergePartnerSearchBlur() {
  setTimeout(() => hideDetailMergePartnerSuggest(), 180)
}

export function onDetailMergePartnerSearchKeydown(event) {
  if (event?.key === 'Escape') {
    hideDetailMergePartnerSuggest()
    return
  }
  if (event?.key !== 'Enter') return
  event.preventDefault()
  const firstId = detailMergePickState.lastMatches[0]?.customer?.id
  if (firstId) selectDetailMergePartner(firstId)
}

export function onDetailMergePartnerSearchInput() {
  const anchorId = detailMergePickState.anchorCustomerId
  const searchEl = document.getElementById('detailMergePartnerSearch')
  const query = searchEl?.value || ''
  if (detailMergePickState.selectedPartnerId && query.trim() !== '') {
    const picked = getData().customers.find(c => c.id === detailMergePickState.selectedPartnerId)
    const pickedLabel = picked?.name || picked?.platformId || picked?.id || ''
    if (query.trim() !== pickedLabel.trim()) clearDetailMergePartnerSelectionInternal()
  }

  const box = document.getElementById('detailMergePartnerSuggest')
  if (!box) return

  const matches = findCustomersForMergeSearch(query, getData().customers, {
    excludeId: anchorId,
    limit: 8
  })
  detailMergePickState.lastMatches = matches

  if (!matches.length) {
    hideDetailMergePartnerSuggest()
    return
  }

  box.hidden = false
  box.innerHTML = matches.map(({ customer: c, matchedPhone, matchKind }) => {
    const meta = matchKind === 'platformId'
      ? (matchedPhone || `@${c.platformId || ''}`)
      : (matchedPhone || '—')
    return `
    <button type="button" class="customer-phone-suggest-item" role="option"
      onmousedown="event.preventDefault(); app.selectDetailMergePartner('${escapeAttr(c.id)}')">
      <span class="customer-phone-suggest-main">
        <strong>${escapeHtml(c.name || c.platformId || c.id)}</strong>
        <span class="customer-phone-suggest-id">${escapeHtml(c.id)}</span>
      </span>
      <span class="customer-phone-suggest-meta" dir="ltr">${escapeHtml(meta)}</span>
      <span class="customer-phone-suggest-advisor">${escapeHtml(c.advisor || '—')}</span>
    </button>
  `
  }).join('')
}

export function selectDetailMergePartner(customerId) {
  const anchorId = detailMergePickState.anchorCustomerId
  if (!customerId || customerId === anchorId) {
    showToast('نمی‌توانید مشتری را با خودش ادغام کنید')
    return
  }
  const c = getData().customers.find(x => x.id === customerId)
  if (!c || !canViewCustomer(c)) {
    showToast('مشتری یافت نشد یا دسترسی ندارید')
    return
  }
  detailMergePickState.selectedPartnerId = customerId
  renderDetailMergePartnerSelected(c)
}

export async function confirmDetailMergePartnerPick() {
  if (!requirePermission('customers_merge')) return
  const anchorId = detailMergePickState.anchorCustomerId
  const partnerId = detailMergePickState.selectedPartnerId
    || document.getElementById('detailMergePartnerId')?.value?.trim()
  if (!anchorId || !partnerId) {
    showToast('مشتری مقصد را انتخاب کنید')
    return
  }
  if (anchorId === partnerId) {
    showToast('نمی‌توانید مشتری را با خودش ادغام کنید')
    return
  }
  closeDetailMergePickModal()
  await beginCustomerMergeFlow(anchorId, partnerId, { defaultSurvivorId: anchorId })
}

export function openDetailPanelMergePicker() {
  if (!requirePermission('customers_merge')) return
  const anchorId = getOpenDetailCustomerId()
  if (!anchorId) {
    showToast('ابتدا پنل یک مشتری را باز کنید')
    return
  }
  const anchor = getData().customers.find(c => c.id === anchorId)
  if (!anchor) {
    showToast('مشتری یافت نشد')
    return
  }

  detailMergePickState = { anchorCustomerId: anchorId, selectedPartnerId: null, lastMatches: [] }
  const intro = document.getElementById('detailMergePickIntro')
  if (intro) {
    intro.textContent =
      `مشتری ${anchorId} (${anchor.name || anchor.platformId || 'بدون نام'}) با کدام مشتری ادغام شود؟`
  }
  const searchEl = document.getElementById('detailMergePartnerSearch')
  if (searchEl) searchEl.value = ''
  clearDetailMergePartnerSelectionInternal()
  hideDetailMergePartnerSuggest()
  document.getElementById('detailMergePickModal')?.classList.add('active')
  searchEl?.focus()
}

async function beginCustomerMergeFlow(idA, idB, { defaultSurvivorId } = {}) {
  const unique = [...new Set([String(idA), String(idB)].filter(Boolean))]
  if (unique.length !== 2) {
    showToast('برای ادغام دقیقاً ۲ مشتری لازم است')
    return
  }

  try {
    await loadCustomerForMerge(unique[0])
    await loadCustomerForMerge(unique[1])
  } catch (e) {
    showToast(e?.message || 'خطا در بارگذاری مشتری')
    return
  }

  const data = getData()
  const a = data.customers.find(c => c.id === unique[0])
  const b = data.customers.find(c => c.id === unique[1])
  if (!a || !b) {
    showToast('مشتری انتخاب‌شده یافت نشد')
    return
  }

  const survivorId = defaultSurvivorId && unique.includes(defaultSurvivorId)
    ? defaultSurvivorId
    : unique[0]
  const sourceId = unique.find(id => id !== survivorId) || unique[1]

  pendingBulkMerge = {
    survivorId,
    sourceId,
    choices: {},
    merged: null,
    _ids: unique
  }

  const survivor = data.customers.find(c => c.id === survivorId) || a
  const source = data.customers.find(c => c.id === sourceId) || b
  const conflicts = detectMergeConflicts(survivor, source)
  pendingBulkMerge.choices = defaultChoices(conflicts)

  const survivorPicker = document.getElementById('bulkMergeSurvivorPicker')
  if (survivorPicker) {
    survivorPicker.innerHTML = unique.map(id => {
      const c = data.customers.find(x => x.id === id)
      const name = c?.name || c?.platformId || 'بدون نام'
      const selected = id === pendingBulkMerge.survivorId
      return `<label class="merge-survivor-card">
        <input type="radio" name="bulkMergeSurvivor" value="${escapeAttr(id)}"
          ${selected ? 'checked' : ''}
          onchange="app.setBulkMergeSurvivor('${escapeAttr(id)}')">
        <span class="merge-survivor-card-body">
          <span class="id-badge">${escapeHtml(id)}</span>
          <span class="merge-survivor-name">${escapeHtml(name)}</span>
        </span>
      </label>`
    }).join('')
  }

  renderConflictModalContent(survivor, source, conflicts)
  document.getElementById('bulkMergeConflictModal')?.classList.add('active')
}

/** Entry from bulk action — exactly two customer ids. */
export async function openBulkCustomerMerge(ids) {
  if (!requirePermission('customers_merge')) return

  const unique = [...new Set((ids || []).map(String).filter(Boolean))]
  if (unique.length !== 2) {
    showToast('برای ادغام دقیقاً ۲ مشتری انتخاب کنید')
    return
  }

  await beginCustomerMergeFlow(unique[0], unique[1], { defaultSurvivorId: unique[0] })
}
