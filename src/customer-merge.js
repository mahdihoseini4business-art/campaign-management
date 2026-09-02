/**
 * Bulk customer merge — phase 1: two profiles, no eligibility gates.
 * Flow: conflict resolution modal → preview modal → persist.
 */
import {
  getData, saveCustomerToDB, deleteCustomerRowOnly, updateFollowupsCustomerId,
  updateRefundsCustomerId, generateId, rekeyCustomerId, cloneCustomerRecord,
  invalidateProductSalesCountCache, ensureCustomerDetailsLoaded, saveSetting
} from './data.js'
import {
  escapeHtml, escapeAttr, showToast, normalizePhone, getCustomerPhones,
  getCustomerAddresses, getPlatformLabels, getStatusLabels,
  formatCustomerLevel, resolveCustomerLevel, syncCustomerLevel,
  ensureProductPayments, syncProductStatus, toEnDigits, formatNumber
} from './utils.js'
import { renderCustomers, openCustomerDetail } from './customers.js'

/** @typedef {{ key: string, label: string, survivorVal: string, sourceVal: string, survivorDisplay?: string, sourceDisplay?: string }} MergeConflict */

/** @type {{ survivorId: string, sourceId: string, choices: Record<string, 'survivor'|'source'>, merged: object | null } | null} */
let pendingBulkMerge = null

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
  const name = (id) => escapeHtml(id)
  const picked = choice || 'survivor'
  return `
    <div class="merge-conflict-row" data-key="${escapeAttr(conflict.key)}">
      <div class="merge-conflict-label">${escapeHtml(conflict.label)}</div>
      <label class="merge-conflict-option">
        <input type="radio" name="mergeConflict_${escapeAttr(conflict.key)}" value="survivor"
          ${picked === 'survivor' ? 'checked' : ''}
          onchange="app.setBulkMergeConflictChoice('${escapeAttr(conflict.key)}', 'survivor')">
        <span class="merge-conflict-option-id">${name(survivorId)}</span>
        <span class="merge-conflict-option-val">${escapeHtml(conflict.survivorDisplay || conflict.survivorVal || '—')}</span>
      </label>
      <label class="merge-conflict-option">
        <input type="radio" name="mergeConflict_${escapeAttr(conflict.key)}" value="source"
          ${picked === 'source' ? 'checked' : ''}
          onchange="app.setBulkMergeConflictChoice('${escapeAttr(conflict.key)}', 'source')">
        <span class="merge-conflict-option-id">${name(sourceId)}</span>
        <span class="merge-conflict-option-val">${escapeHtml(conflict.sourceDisplay || conflict.sourceVal || '—')}</span>
      </label>
    </div>`
}

function renderMergePreviewHtml(merged, sourceId) {
  const platforms = getPlatformLabels()
  const statuses = getStatusLabels()
  const phones = getCustomerPhones(merged)
  const addrs = getCustomerAddresses(merged)
  const data = getData()
  const sourceFollowups = data.followups.filter(f => f.customerId === sourceId).length
  const sourceProducts = (data.customers.find(c => c.id === sourceId)?.products || []).length

  const phoneHtml = phones.length
    ? phones.map(p => escapeHtml(p)).join('<br>')
    : '—'
  const addrHtml = addrs.length
    ? addrs.map(a => {
      const postal = a.postalCode ? ` <span class="merge-preview-muted">(${escapeHtml(a.postalCode)})</span>` : ''
      const pri = a.isPrimary ? ' <span class="address-primary-badge">اولویت ارسال</span>' : ''
      return `<div>${escapeHtml(a.text)}${postal}${pri}</div>`
    }).join('')
    : '—'

  const levelKey = merged.customerLevelLocked
    ? (merged.customerLevel || resolveCustomerLevel(merged, data.customers, data.followups))
    : resolveCustomerLevel(merged, data.customers, data.followups)

  return `
    <div class="merge-preview-grid">
      <div class="merge-preview-field"><span class="merge-preview-label">شناسه بازمانده</span><span class="merge-preview-value"><span class="id-badge">${escapeHtml(merged.id)}</span></span></div>
      <div class="merge-preview-field"><span class="merge-preview-label">نام</span><span class="merge-preview-value">${escapeHtml(merged.name || '—')}</span></div>
      <div class="merge-preview-field"><span class="merge-preview-label">آیدی پلتفرم</span><span class="merge-preview-value">${escapeHtml(merged.platformId || '—')}</span></div>
      <div class="merge-preview-field"><span class="merge-preview-label">پلتفرم</span><span class="merge-preview-value">${escapeHtml(platforms[merged.platform] || merged.platform || '—')}</span></div>
      <div class="merge-preview-field"><span class="merge-preview-label">وضعیت</span><span class="merge-preview-value">${escapeHtml(statuses[merged.status] || merged.status || '—')}</span></div>
      <div class="merge-preview-field"><span class="merge-preview-label">شماره‌ها</span><span class="merge-preview-value">${phoneHtml}</span></div>
      <div class="merge-preview-field"><span class="merge-preview-label">آدرس‌ها</span><span class="merge-preview-value">${addrHtml}</span></div>
      <div class="merge-preview-field"><span class="merge-preview-label">کارشناس</span><span class="merge-preview-value">${escapeHtml(merged.advisor || '—')}${merged.advisorPhone ? ` · ${escapeHtml(merged.advisorPhone)}` : ''}</span></div>
      <div class="merge-preview-field"><span class="merge-preview-label">کد مشتری</span><span class="merge-preview-value">${escapeHtml(merged.customerCode || '—')}</span></div>
      <div class="merge-preview-field"><span class="merge-preview-label">معرف</span><span class="merge-preview-value">${escapeHtml(merged.referredByPhone || '—')}</span></div>
      <div class="merge-preview-field"><span class="merge-preview-label">پیگیری بعدی</span><span class="merge-preview-value">${escapeHtml(merged.nextFollowupDate || '—')}</span></div>
      <div class="merge-preview-field"><span class="merge-preview-label">سطح</span><span class="merge-preview-value">${escapeHtml(formatCustomerLevel(levelKey))}</span></div>
      <div class="merge-preview-field merge-preview-field-full"><span class="merge-preview-label">یادداشت</span><span class="merge-preview-value merge-preview-notes">${escapeHtml(merged.notes || '—')}</span></div>
      <div class="merge-preview-field"><span class="merge-preview-label">محصولات (کل)</span><span class="merge-preview-value">${formatNumber(merged.products?.length || 0)}</span></div>
      <div class="merge-preview-field"><span class="merge-preview-label">منتقل از ${escapeHtml(sourceId)}</span><span class="merge-preview-value">${sourceProducts} فروش · ${sourceFollowups} پیگیری</span></div>
    </div>`
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

function openPreviewModal(merged, sourceId) {
  const body = document.getElementById('bulkMergePreviewBody')
  if (body) body.innerHTML = renderMergePreviewHtml(merged, sourceId)
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
  if (intro) {
    intro.textContent = conflicts.length
      ? 'برای فیلدهایی که در هر دو پروفایل مقدار متفاوت دارند، مقدار درست را انتخاب کنید. شماره‌ها و آدرس‌های بدون تداخل خودکار جمع می‌شوند.'
      : 'تعارضی در فیلدهای تکی نیست. شماره‌ها و آدرس‌ها و داده‌های وابسته ادغام می‌شوند.'
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
  openPreviewModal(merged, pendingBulkMerge.sourceId)
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
    showToast(`ادغام انجام شد — ${sourceId} داخل ${finalId} ادغام شد`)
  } catch (e) {
    console.error('confirmBulkMergePreview error:', e)
    showToast(e?.message || 'خطا در ادغام مشتریان')
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'تأیید و ادغام' }
  }
}

/**
 * @param {{ survivorId: string, sourceId: string, merged: object }} params
 */
/** @returns {Promise<string>} final survivor id */
async function executeCustomerMerge({ survivorId, sourceId, merged }) {
  const data = getData()
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

  invalidateProductSalesCountCache()
  return finalSurvivorId
}

/** Entry from bulk action — exactly two customer ids. */
export async function openBulkCustomerMerge(ids) {
  const unique = [...new Set((ids || []).map(String).filter(Boolean))]
  if (unique.length !== 2) {
    showToast('برای ادغام دقیقاً ۲ مشتری انتخاب کنید')
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

  pendingBulkMerge = {
    survivorId: unique[0],
    sourceId: unique[1],
    choices: {},
    merged: null,
    _ids: unique
  }

  const conflicts = detectMergeConflicts(a, b)
  pendingBulkMerge.choices = defaultChoices(conflicts)

  const survivorPicker = document.getElementById('bulkMergeSurvivorPicker')
  if (survivorPicker) {
    survivorPicker.innerHTML = unique.map(id => {
      const c = data.customers.find(x => x.id === id)
      const label = `${id} — ${c?.name || c?.platformId || 'بدون نام'}`
      return `<label class="merge-survivor-option">
        <input type="radio" name="bulkMergeSurvivor" value="${escapeAttr(id)}"
          ${id === pendingBulkMerge.survivorId ? 'checked' : ''}
          onchange="app.setBulkMergeSurvivor('${escapeAttr(id)}')">
        <span>${escapeHtml(label)}</span>
      </label>`
    }).join('')
  }

  renderConflictModalContent(a, b, conflicts)
  document.getElementById('bulkMergeConflictModal')?.classList.add('active')
}
