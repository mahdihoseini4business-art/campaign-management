import * as XLSX from 'xlsx'
import { getData, saveCustomerToDB, generateId, generateIdBatch, getStatuses, getCustomerCodes, saveFollowupToDB, updateFollowupInDB, getDestinationBanks, getSellableNames, putCustomerInCache, getProductCatalogNames, getCustomerOwnedProductNames, getPlatforms, coerceProductName } from './data.js'
import {
  toEnDigits, showToast, getCurrentUser, resolveAdvisor, getPlatformLabels, buildPlatformImportMap, getStatusLabels,
  requirePermission, ensureProductPayments, syncProductStatus, getApprovedPaid,
  getProductBalance, getProductPayments, getPaymentEntryStatus,
  PAYMENT_STATUS, PAYMENT_STATUS_LABELS, createPayment, formatSoldAt24h, normalizePhone,
  formatCustomerLevel, parseCustomerLevel, syncCustomerLevel,
  normalizeCustomerPhones, getCustomerPhones, findCustomerByPhone,
  jalaliDatePart, jalaliToNum, escapeHtml, escapeAttr, normalizeTimeTo24h,
  userDisplayName, applyProfitSnapshotToProduct, jalaliDateTimeToIso, jalaliAddDays, getTodayJalaliStr,
  formatNumber, getSaleRegistrantPhone
} from './utils.js'
import { getUsersSafe } from './auth.js'
import { renderCustomers, getFilteredCustomers } from './customers.js'
import { getFollowupsForExport, hasActiveFollowupExportFilter, renderFollowups } from './followups.js'
import { renderSales, getFilteredSales, getSalesDateFilter } from './sales.js'
import { getProductMatrixExportAoa, hasActiveProductMatrixFilter, renderProductMatrix } from './product-matrix.js'

// ============================================
// Helpers
// ============================================


/** Columns that are informational / legacy and never map to import fields */
const INFO_ONLY_HEADERS = new Set([
  'تعداد پیگیری', 'آخرین پیگیری', 'مانده', 'همه یادداشت‌ها',
  // Follow-up export extra (lives on customer, not the follow-up row)
  'شماره مشتری',
  // Accounting approval is never imported — accountants review deposits manually
  'وضعیت واریزی', 'وضعیت واریز',
  // Sales export-only — customer advisor stays in «کارشناس»
  'ثبت‌کننده فروش'
])

const FOLLOWUP_EXPORT_HEADERS = [
  'شناسه مشتری', 'نام مشتری', 'شماره مشتری', 'کارشناس',
  'تاریخ', 'نوع', 'نتیجه', 'پیگیری بعدی', 'توضیحات', 'ثبت‌کننده'
]

function followupsForCustomer(customerId, followups) {
  return followups
    .filter(f => f.customerId === customerId)
    .slice()
    .sort((a, b) => {
      const dCmp = String(a.date || '').localeCompare(String(b.date || ''))
      if (dCmp) return dCmp
      return String(a.id || '').localeCompare(String(b.id || ''))
    })
}

/** All timeline notes for one customer (profile notes stay in توضیحات separately). */
function formatAllFollowupNotes(customerId, followups) {
  return followupsForCustomer(customerId, followups).map(f => {
    const note = String(f.notes || f.doneNote || '').trim()
    if (!note) return ''
    const meta = [f.date, f.type, f.result].filter(Boolean).join(' | ')
    return meta ? `${meta}: ${note}` : note
  }).filter(Boolean).join('\n')
}

function buildFollowupExportAoa(followups, customers) {
  const rows = followups.map(f => {
    const c = customers.find(x => x.id === f.customerId)
    const phoneStr = c ? (getCustomerPhones(c)[0] || '') : ''
    return [
      f.customerId || '',
      c ? (c.name || c.platformId || '') : '',
      phoneStr,
      c?.advisor || '',
      f.date || '',
      f.type || '',
      f.result || '',
      f.nextDate || '',
      f.notes || f.doneNote || '',
      f.createdByPhone || ''
    ]
  })
  return [FOLLOWUP_EXPORT_HEADERS, ...rows]
}

function sheetFromAoa(headers, rows) {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows])
  const colWidths = headers.map((h, i) => {
    const maxLen = Math.max(h.length, ...rows.map(r => String(r[i] ?? '').length))
    return { wch: Math.min(Math.max(maxLen + 2, 10), 40) }
  })
  ws['!cols'] = colWidths
  return ws
}

function hasActiveExportScopeFilter(tab) {
  if (tab === 'customers') {
    return !!(
      document.getElementById('searchCustomers')?.value?.trim()
      || document.getElementById('filterAdvisor')?.value
      || document.getElementById('filterPlatform')?.value
      || document.getElementById('filterStatus')?.value
      || document.getElementById('filterCustomerLevel')?.value
      || document.getElementById('filterTransferIn')?.value
    )
  }
  if (tab === 'followups') {
    return hasActiveFollowupExportFilter()
  }
  if (tab === 'sales') {
    const dateFilter = getSalesDateFilter()
    return !!(
      document.getElementById('searchSales')?.value?.trim()
      || document.getElementById('filterSalesAdvisor')?.value
      || document.getElementById('filterSalesPlatform')?.value
      || document.getElementById('filterSalesLevel')?.value
      || document.getElementById('filterSalesCustomerCode')?.value
      || document.getElementById('filterSalesStatus')?.value
      || document.getElementById('filterSalesPaymentStatus')?.value
      || dateFilter?.hasDateFilter
    )
  }
  if (tab === 'products') {
    return hasActiveProductMatrixFilter()
  }
  return false
}

/** Force Excel to keep id/phone cells as text (leading zeros, no scientific notation). */
function forceSheetTextColumns(ws, rowCount, colIndexes) {
  const textCols = new Set(colIndexes)
  for (let r = 0; r < rowCount; r++) {
    textCols.forEach(c => {
      const addr = XLSX.utils.encode_cell({ r: r + 1, c })
      const cell = ws[addr]
      if (!cell || cell.v === '' || cell.v == null) return
      cell.t = 's'
      cell.v = String(cell.v)
      cell.z = '@'
    })
  }
}

/** @deprecated alias — same as INFO_ONLY_HEADERS for auto-map skip */
const AUTO_MAP_IGNORE_HEADERS = INFO_ONLY_HEADERS

function normalizeHeaderLabel(h) {
  return String(h || '')
    .trim()
    .replace(/\u200c/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

/**
 * Auto-map Excel headers → import field keys.
 * Pass 1: exact match on label/aliases (preferred).
 * Pass 2: short Excel header that is a prefix of the field label.
 */
function autoMapColumns(headers, fields) {
  const mapping = {}
  const headerNorm = headers.map(h => String(h || '').trim())
  const headerKey = headerNorm.map(normalizeHeaderLabel)
  const used = new Set()
  const ignored = new Set(
    headerNorm
      .map((h, i) => (AUTO_MAP_IGNORE_HEADERS.has(h) ? i : -1))
      .filter(i => i >= 0)
  )

  const tryExact = (labels) => {
    for (const label of labels) {
      const want = normalizeHeaderLabel(label)
      if (!want) continue
      const idx = headerKey.findIndex((h, i) => !used.has(i) && !ignored.has(i) && h === want)
      if (idx !== -1) return idx
    }
    return -1
  }

  const tryLoose = (labels) => {
    // Only: short Excel header that is a prefix of the field label
    // (e.g. header "سطح" → field "سطح مشتری"). Never the reverse —
    // otherwise "شماره" would steal "شماره ۲".
    const sorted = [...labels].filter(Boolean).sort((a, b) => b.length - a.length)
    for (const label of sorted) {
      const want = normalizeHeaderLabel(label)
      if (want.length < 2) continue
      const idx = headerKey.findIndex((h, i) => {
        if (used.has(i) || ignored.has(i) || !h) return false
        if (h.length >= want.length) return false
        return want.startsWith(h) && h.length >= 2
      })
      if (idx !== -1) return idx
    }
    return -1
  }

  fields.forEach(f => {
    const labels = [f.label, ...(f.aliases || [])].filter(Boolean)
    let idx = tryExact(labels)
    if (idx === -1) idx = tryLoose(labels)
    if (idx !== -1) {
      mapping[f.key] = idx
      used.add(idx)
    }
  })
  return mapping
}

function buildStatusImportMap() {
  const map = { ...STATUS_MAP_IMPORT }
  for (const s of getStatuses()) {
    if (!s) continue
    map[s.key] = s.key
    if (s.label) {
      map[s.label] = s.key
      map[String(s.label).toLowerCase()] = s.key
    }
  }
  return map
}

/** Resolve Excel value to customer_code key (accepts key or label). */
function resolveCustomerCodeKey(raw) {
  const v = String(raw || '').trim()
  if (!v) return ''
  const codes = getCustomerCodes()
  const byKey = codes.find(c => c.key === v || c.key === v.toLowerCase())
  if (byKey) return byKey.key
  const byLabel = codes.find(c => c.label === v || String(c.label).toLowerCase() === v.toLowerCase())
  if (byLabel) return byLabel.key
  return v
}

function renderFieldMappingRows({ fields, headers, mapping, autoMapping = {}, onChangeFn }) {
  const mappedCount = Object.keys(mapping).length
  const autoCount = Object.keys(autoMapping).length
  const unused = headers
    .map((h, i) => ({ h: h || '(خالی)', i }))
    .filter(({ i }) => !Object.values(mapping).includes(i))

  const infoOnly = unused.filter(({ h }) => INFO_ONLY_HEADERS.has(h))
  const unexpected = unused.filter(({ h }) => !INFO_ONLY_HEADERS.has(h))

  const hint = autoCount > 0
    ? `${autoCount} فیلد از روی نام ستون‌های اکسل به‌صورت خودکار مپ شد — در صورت نیاز اصلاح کنید.`
    : mappedCount > 0
      ? 'مپینگ را بررسی و در صورت نیاز اصلاح کنید.'
      : 'مپینگ خودکاری پیدا نشد — ستون اکسل مربوط به هر فیلد را انتخاب کنید.'

  const rows = fields.map(f => {
    const selected = mapping[f.key]
    const hasMap = selected !== undefined && selected !== null
    const isAuto = hasMap && autoMapping[f.key] === selected
    const opts = headers.map((h, i) => {
      const label = h || `(ستون ${i + 1})`
      const sel = selected === i ? 'selected' : ''
      return `<option value="${i}" ${sel}>${escapeHtml(label)}</option>`
    }).join('')
    return `
      <div class="import-map-row${hasMap ? (isAuto ? ' is-auto' : ' is-mapped') : ' is-unmapped'}">
        <span class="field-col" title="${escapeAttr(f.label)}">
          ${escapeHtml(f.label)}${f.required ? ' <span class="req">*</span>' : ''}
          ${isAuto ? '<span class="auto-badge">خودکار</span>' : ''}
        </span>
        <span class="arrow">←</span>
        <select onchange="app.${onChangeFn}('${f.key}', this.value)" aria-label="ستون اکسل برای ${escapeAttr(f.label)}">
          <option value="">— انتخاب نشده —</option>
          ${opts}
        </select>
      </div>
    `
  }).join('')

  let unusedBlock = ''
  if (infoOnly.length) {
    unusedBlock += `
      <details class="import-unused import-unused-info">
        <summary>${infoOnly.length} ستون اطلاعاتی (برای ایمپورت مشتری لازم نیست)</summary>
        <div class="import-unused-list">${infoOnly.map(({ h }) => `<span>${escapeHtml(h)}</span>`).join('')}</div>
        <p class="import-unused-note">ستون‌هایی مثل «همه یادداشت‌ها» فقط برای پشتیبان‌گیری متنی هستند. جزئیات ساخت‌یافته در شیت «پیگیری‌ها»ی فایل Excel یا خروجی تب پیگیری‌هاست.</p>
      </details>
    `
  }
  if (unexpected.length) {
    unusedBlock += `
      <details class="import-unused">
        <summary>${unexpected.length} ستون بدون مپینگ (نادیده گرفته می‌شوند)</summary>
        <div class="import-unused-list">${unexpected.map(({ h }) => `<span>${escapeHtml(h)}</span>`).join('')}</div>
      </details>
    `
  }

  return `<p class="import-map-hint">${escapeHtml(hint)}</p>${rows}${unusedBlock}`
}

function setFieldColumnMapping(store, fieldKey, colRaw) {
  if (!fieldKey) return
  if (colRaw === '' || colRaw === null || colRaw === undefined) {
    delete store.mapping[fieldKey]
    return
  }
  const colIndex = Number(colRaw)
  if (Number.isNaN(colIndex)) return
  Object.keys(store.mapping).forEach(k => {
    if (store.mapping[k] === colIndex) delete store.mapping[k]
  })
  store.mapping[fieldKey] = colIndex
}

function parseMoney(raw) {
  return parseFloat(String(raw || '').replace(/[^\d.]/g, '')) || 0
}

/** Parse Excel money → system Rial (تومان در فایل ×۱۰ می‌شود). */
function parseImportMoney(raw, amountUnit = salesImportData.amountUnit) {
  const n = parseMoney(raw)
  if (!n) return 0
  return amountUnit === 'toman' ? n * 10 : n
}

// ============================================
// Export
// ============================================

function resolveSaleRegistrantName(product, payment, customer, soldByPhoneFallback, nameByPhone) {
  const phone = getSaleRegistrantPhone(product, payment, customer) || normalizePhone(soldByPhoneFallback || '')
  if (!phone) return ''
  return nameByPhone.get(phone) || ''
}

async function buildSalesExportRows() {
  let nameByPhone = new Map()
  try {
    const users = await getUsersSafe()
    nameByPhone = new Map(
      users.filter(u => u.phone).map(u => [normalizePhone(u.phone), userDisplayName(u)])
    )
  } catch (_) { /* names optional */ }

  const data = getData()
  const codeLabels = Object.fromEntries(getCustomerCodes().map(c => [c.key, c.label]))
  const rows = []
  getFilteredSales().forEach(s => {
    const c = data.customers.find(x => x.id === s.customerId)
    const p = c?.products?.[s.productIndex]
    const codeKey = c?.customerCode || s.customerCode || ''
    const codeLabel = codeLabels[codeKey] || codeKey || ''
    const customerAdvisor = c?.advisor || s.advisor || ''
    if (!c || !p) {
      rows.push([
        s.customerId, s.customerName, s.customerPhone,
        getPlatformLabels()[s.platform] || s.platform || '',
        codeLabel,
        s.productName, s.status, s.price || '', s.deposit || '', s.balance || '',
        s.settlementDate || '', customerAdvisor,
        resolveSaleRegistrantName(null, null, c, s.soldByPhone, nameByPhone),
        '', formatSoldAt24h(s.soldAt) || s.soldAt || '', s.depositorName || '', '', ''
      ])
      return
    }
    ensureProductPayments(p)
    syncProductStatus(p)
    const price = parseFloat(p.price) || 0
    const dateFilter = getSalesDateFilter()
    let pays = getProductPayments(p).filter(pay => (parseFloat(pay.amount) || 0) > 0)
    if (dateFilter.hasDateFilter) {
      pays = pays.filter(pay => {
        if (getPaymentEntryStatus(pay) === PAYMENT_STATUS.rejected) return false
        const d = jalaliDatePart(pay.soldAt)
        if (!d) return false
        const n = jalaliToNum(d)
        return n >= dateFilter.fromNum && n <= dateFilter.toNum
      })
    }
    // Primary phone only — multi-phone lives on customer export; join breaks import match
    const phoneStr = getCustomerPhones(c)[0] || ''
    const platformLabel = getPlatformLabels()[c.platform] || c.platform || ''
    if (pays.length === 0) {
      rows.push([
        c.id,
        c.name || c.platformId || '',
        phoneStr,
        platformLabel,
        codeLabel,
        p.name || '',
        p.status || '',
        price || '',
        dateFilter.hasDateFilter ? (s.deposit || '') : (getApprovedPaid(p) || ''),
        getProductBalance(p) || '',
        p.settlementDate || '',
        customerAdvisor,
        resolveSaleRegistrantName(p, null, c, s.soldByPhone, nameByPhone),
        '', '', '', '', ''
      ])
      return
    }
    let paidSoFar = 0
    pays.forEach(pay => {
      const amount = parseFloat(pay.amount) || 0
      const status = getPaymentEntryStatus(pay)
      // Cumulative paid = sum of non-rejected deposits up to this row
      if (status !== PAYMENT_STATUS.rejected) {
        paidSoFar += amount
      }
      const balance = Math.max(0, price - paidSoFar)
      rows.push([
        c.id,
        c.name || c.platformId || '',
        phoneStr,
        platformLabel,
        codeLabel,
        p.name || '',
        p.status || '',
        price || '',
        paidSoFar || '',
        balance || '',
        p.settlementDate || '',
        customerAdvisor,
        resolveSaleRegistrantName(p, pay, c, s.soldByPhone, nameByPhone),
        amount || '',
        formatSoldAt24h(pay.soldAt) || pay.soldAt || '',
        pay.depositorName || '',
        pay.destinationBank || '',
        PAYMENT_STATUS_LABELS[status] || status || ''
      ])
    })
  })
  return rows
}

const EXPORT_CONFIG = {
  customers: {
    label: 'مشتریان',
    // Core columns stay in sync with IMPORT_FIELDS; «همه یادداشت‌ها» is export-only
    headers: [
      'شناسه', 'ایدی پلتفرم', 'پلتفرم', 'نام', 'شماره', 'شماره ۲', 'شماره ۳',
      'وضعیت', 'سطح مشتری', 'کد مشتری', 'شماره معرف', 'توضیحات', 'کارشناس', 'پیگیری بعدی',
      'همه یادداشت‌ها'
    ],
    getRows: () => {
      const data = getData()
      const codeLabels = Object.fromEntries(getCustomerCodes().map(c => [c.key, c.label]))
      return getFilteredCustomers().map(c => {
        const level = c.customerLevelLocked
          ? (c.customerLevel || '')
          : syncCustomerLevel(c, data.customers, data.followups)
        const phones = getCustomerPhones(c)
        const codeKey = c.customerCode || ''
        return [
          c.id,
          c.platformId || '',
          getPlatformLabels()[c.platform] || c.platform || '',
          c.name || '',
          phones[0] || '',
          phones[1] || '',
          phones[2] || '',
          getStatusLabels()[c.status] || c.status || '',
          formatCustomerLevel(level) === '—' ? '' : formatCustomerLevel(level),
          codeLabels[codeKey] || codeKey || '',
          c.referredByPhone || '',
          c.notes || '',
          c.advisor || '',
          c.nextFollowupDate || '',
          formatAllFollowupNotes(c.id, data.followups)
        ]
      })
    }
  },
  followups: {
    label: 'پیگیری‌ها',
    headers: FOLLOWUP_EXPORT_HEADERS,
    getRows: () => {
      return getFollowupsForExport().map(f => [
        f.customerId || '',
        f.customerName || '',
        f.customerPhone || '',
        f.advisor || '',
        f.date || '',
        f.type || '',
        f.result || '',
        f.nextDate || '',
        f.notes || '',
        f.createdByPhone || ''
      ])
    }
  },
  sales: {
    label: 'فروش‌ها',
    headers: [
      'شناسه مشتری', 'نام مشتری', 'شماره موبایل', 'پلتفرم', 'کد مشتری', 'محصول', 'وضعیت',
      'مبلغ کل', 'پرداخت‌شده', 'مانده', 'تاریخ تسویه', 'کارشناس', 'ثبت‌کننده فروش',
      'مبلغ واریز', 'تاریخ واریز', 'نام واریزکننده', 'بانک مقصد', 'وضعیت واریزی'
    ]
  },
  products: {
    label: 'ماتریس_محصولات',
    get headers() {
      return getProductMatrixExportAoa().headers
    },
    getRows() {
      return getProductMatrixExportAoa().rows
    }
  }
}

export async function exportTabCSV(tab) {
  const exportPerm = { customers: 'customers_export', followups: 'followups_export', sales: 'sales_export', products: 'products_matrix' }[tab]
  if (exportPerm && !requirePermission(exportPerm)) return
  const cfg = EXPORT_CONFIG[tab]
  if (!cfg) return

  const rows = tab === 'sales' ? await buildSalesExportRows() : cfg.getRows()
  const csvContent = '\uFEFF' + [cfg.headers, ...rows]
    .map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n')

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `${cfg.label}_${new Date().toISOString().slice(0, 10)}.csv`
  link.click()
  const filterHint = hasActiveExportScopeFilter(tab) ? ' — فقط ردیف‌های فیلترشده' : ''
  showToast(`${rows.length} ردیف در CSV ذخیره شد${filterHint}`)
}

export async function exportTabXLSX(tab) {
  const exportPerm = { customers: 'customers_export', followups: 'followups_export', sales: 'sales_export', products: 'products_matrix' }[tab]
  if (exportPerm && !requirePermission(exportPerm)) return
  const cfg = EXPORT_CONFIG[tab]
  if (!cfg) return

  const rows = tab === 'sales' ? await buildSalesExportRows() : cfg.getRows()
  const ws = sheetFromAoa(cfg.headers, rows)

  // Keep phone / id columns as text so Excel doesn't drop leading zeros
  if (tab === 'customers') {
    forceSheetTextColumns(ws, rows.length, [0, 1, 4, 5, 6, 10]) // شناسه، ایدی، شماره‌ها، معرف
  } else if (tab === 'followups') {
    forceSheetTextColumns(ws, rows.length, [0, 2, 9]) // شناسه مشتری، شماره مشتری، ثبت‌کننده
  } else if (tab === 'sales') {
    forceSheetTextColumns(ws, rows.length, [0, 2]) // شناسه مشتری، شماره موبایل
  } else if (tab === 'products') {
    forceSheetTextColumns(ws, rows.length, [1]) // شماره
  }

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, cfg.label)

  // Customers Excel: second sheet with every followup/note for exported customers
  let followupCount = 0
  if (tab === 'customers') {
    const data = getData()
    const exportedIds = new Set(getFilteredCustomers().map(c => c.id))
    const followups = data.followups
      .filter(f => exportedIds.has(f.customerId))
      .slice()
      .sort((a, b) => {
        const idCmp = String(a.customerId || '').localeCompare(String(b.customerId || ''))
        if (idCmp) return idCmp
        const dCmp = String(a.date || '').localeCompare(String(b.date || ''))
        if (dCmp) return dCmp
        return String(a.id || '').localeCompare(String(b.id || ''))
      })
    followupCount = followups.length
    const fAoa = buildFollowupExportAoa(followups, data.customers)
    const fuRows = fAoa.slice(1)
    const wsFollowups = sheetFromAoa(fAoa[0], fuRows)
    forceSheetTextColumns(wsFollowups, fuRows.length, [0, 2, 9]) // شناسه، شماره مشتری، ثبت‌کننده
    XLSX.utils.book_append_sheet(wb, wsFollowups, 'پیگیری‌ها')
  }

  XLSX.writeFile(wb, `${cfg.label}_${new Date().toISOString().slice(0, 10)}.xlsx`)
  const filterHint = hasActiveExportScopeFilter(tab) ? ' — فقط ردیف‌های فیلترشده' : ''
  if (tab === 'customers' && followupCount > 0) {
    showToast(`${rows.length} مشتری و ${followupCount} یادداشت/پیگیری در Excel ذخیره شد${filterHint}`)
  } else {
    showToast(`${rows.length} ردیف در Excel ذخیره شد${filterHint}`)
  }
}

// ============================================
// Import Customers from Excel
// ============================================

const IMPORT_FIELDS = [
  { key: 'id', label: 'شناسه', aliases: ['شناسه مشتری'] },
  { key: 'platformId', label: 'ایدی پلتفرم', aliases: ['آیدی پلتفرم', 'id پلتفرم'] },
  { key: 'platform', label: 'پلتفرم' },
  { key: 'name', label: 'نام', aliases: ['نام مشتری'] },
  { key: 'phone', label: 'شماره', aliases: ['شماره تماس', 'شماره موبایل', 'شماره ۱', 'شماره 1'] },
  { key: 'phone2', label: 'شماره ۲', aliases: ['شماره تماس ۲', 'شماره 2', 'موبایل ۲'] },
  { key: 'phone3', label: 'شماره ۳', aliases: ['شماره تماس ۳', 'شماره 3', 'موبایل ۳'] },
  { key: 'status', label: 'وضعیت' },
  { key: 'customerLevel', label: 'سطح مشتری', aliases: ['سطح'] },
  { key: 'customerCode', label: 'کد مشتری', aliases: ['کد'] },
  { key: 'referredByPhone', label: 'شماره معرف', aliases: ['معرف'] },
  { key: 'notes', label: 'توضیحات' },
  { key: 'advisor', label: 'کارشناس' },
  { key: 'nextFollowupDate', label: 'پیگیری بعدی' },
]

const STATUS_MAP_IMPORT = {
  'جدید': 'new', 'جديد': 'new',
  'تماس گرفته شده': 'contacted', 'تماس گرفته': 'contacted',
  'در حال چت': 'chatting',
  'علاقمند': 'interested', 'علاقه‌مند': 'interested', 'علاقه\u200cمند': 'interested',
  'اطلاعات ارسال شده': 'sent', 'اطلاعات ارسال': 'sent',
  'تکمیل پیگیری': 'followup_done',
  'در حال تبدیل': 'converting',
  'خرید کرد': 'purchased', 'خرید': 'purchased',
  'منصرف شده': 'cancelled', 'منصرف': 'cancelled',
}

const FOLLOWUP_IMPORT_FIELDS = [
  { key: 'customerId', label: 'شناسه مشتری', aliases: ['شناسه'], required: true },
  { key: 'customerName', label: 'نام مشتری', aliases: ['نام'] },
  { key: 'date', label: 'تاریخ' },
  { key: 'type', label: 'نوع' },
  { key: 'result', label: 'نتیجه' },
  { key: 'nextDate', label: 'پیگیری بعدی' },
  { key: 'notes', label: 'توضیحات', aliases: ['یادداشت'] },
  { key: 'createdByPhone', label: 'ثبت‌کننده', aliases: ['ایجادکننده'] },
]

function parseSheetAoA(ws) {
  const json = XLSX.utils.sheet_to_json(ws, { header: 1 })
  if (!json.length) return null
  const headers = (json[0] || []).map(h => String(h || '').trim())
  const rows = json.slice(1).filter(r => Array.isArray(r) && r.some(c => c != null && String(c).trim() !== ''))
  if (!headers.some(Boolean) || !rows.length) return null
  return { headers, rows }
}

function sheetLooksLikeFollowups(headers) {
  const set = new Set(headers.map(normalizeHeaderLabel))
  const hasCustomerId = set.has(normalizeHeaderLabel('شناسه مشتری')) || set.has(normalizeHeaderLabel('شناسه'))
  const hasNoteOrDate = set.has(normalizeHeaderLabel('توضیحات')) || set.has(normalizeHeaderLabel('تاریخ'))
  const hasPlatformId = set.has(normalizeHeaderLabel('ایدی پلتفرم'))
    || set.has(normalizeHeaderLabel('آیدی پلتفرم'))
  const hasPhoneCols = set.has(normalizeHeaderLabel('شماره')) || set.has(normalizeHeaderLabel('شماره ۲'))
  // Followups sheet has customer id + date/notes, but not customer profile columns
  return hasCustomerId && hasNoteOrDate && !hasPlatformId && !hasPhoneCols
}

function sheetLooksLikeCustomers(headers) {
  const set = new Set(headers.map(normalizeHeaderLabel))
  const hasPlatformId = set.has(normalizeHeaderLabel('ایدی پلتفرم'))
    || set.has(normalizeHeaderLabel('آیدی پلتفرم'))
  const hasPhone = set.has(normalizeHeaderLabel('شماره')) || set.has(normalizeHeaderLabel('شماره موبایل'))
  const hasName = set.has(normalizeHeaderLabel('نام')) || set.has(normalizeHeaderLabel('نام مشتری'))
  if (sheetLooksLikeFollowups(headers)) return false
  return hasPlatformId || (hasPhone && hasName)
}

function findFollowupsSheetName(wb) {
  const names = wb.SheetNames || []
  const exact = names.find(n => String(n).trim() === 'پیگیری‌ها')
  if (exact) return exact
  const fuzzy = names.find(n => String(n).includes('پیگیری'))
  if (fuzzy) return fuzzy
  for (const name of names) {
    const parsed = parseSheetAoA(wb.Sheets[name])
    if (parsed && sheetLooksLikeFollowups(parsed.headers)) return name
  }
  return null
}

function findCustomersSheetName(wb) {
  const names = wb.SheetNames || []
  const exact = names.find(n => String(n).trim() === 'مشتریان')
  if (exact) return exact
  for (const name of names) {
    const parsed = parseSheetAoA(wb.Sheets[name])
    if (parsed && sheetLooksLikeCustomers(parsed.headers)) return name
  }
  return names[0] || null
}

function followupFingerprint(f) {
  return [
    f.customerId || '',
    String(f.date || '').trim(),
    String(f.type || '').trim(),
    String(f.notes || f.doneNote || '').trim()
  ].join('\u0001')
}

function isDoneFollowupType(type) {
  return type === 'پیگیری انجام‌شده' || type === 'پیگیری معوقه انجام‌شده'
}

/**
 * Import structured followup rows (same shape as export sheet «پیگیری‌ها»).
 * Matching notes (fingerprint) update nextDate/result instead of being skipped.
 * When syncCustomerNextDate is true (خروجی تب پیگیری‌ها), also rewrites
 * customer.nextFollowupDate from column «پیگیری بعدی».
 */
async function importFollowupRows({ headers, rows, mapping }, { syncCustomerNextDate = false } = {}) {
  const data = getData()
  const map = mapping || autoMapColumns(headers, FOLLOWUP_IMPORT_FIELDS)
  if (map.customerId === undefined || map.customerId === null) {
    return { created: 0, updated: 0, skipped: 0, failed: 0, missingCustomer: 0, customersUpdated: 0 }
  }

  let created = 0, updated = 0, skipped = 0, failed = 0, missingCustomer = 0, customersUpdated = 0
  const byFingerprint = new Map()
  for (const f of data.followups) {
    byFingerprint.set(followupFingerprint(f), f)
  }
  const currentUser = getCurrentUser()
  const nextDateMapped = map.nextDate !== undefined && map.nextDate !== null

  for (const row of rows) {
    const getValue = (fieldKey) => {
      const colIdx = map[fieldKey]
      if (colIdx === undefined || colIdx === null) return ''
      return String(row[colIdx] || '').trim()
    }

    const customerId = getValue('customerId')
    const notes = getValue('notes')
    const date = toEnDigits(getValue('date'))
    const type = getValue('type') || 'یادداشت'
    if (!customerId || (!notes && !date && !(syncCustomerNextDate && nextDateMapped))) {
      skipped++
      continue
    }

    const customer = data.customers.find(c => c.id === customerId)
    if (!customer) {
      missingCustomer++
      continue
    }

    const nextDate = toEnDigits(getValue('nextDate'))
    const result = getValue('result') || ''
    const createdByPhone = normalizePhone(getValue('createdByPhone')) || normalizePhone(currentUser?.phone || '')
    const done = isDoneFollowupType(type)
    const followup = {
      customerId,
      date: date || '',
      type,
      result,
      nextDate: nextDate || '',
      notes: notes || '',
      createdByPhone,
      status: done ? 'done' : 'pending',
      doneAt: done ? (date || '') : '',
      doneByPhone: done ? createdByPhone : '',
      doneNote: done ? (notes || '') : '',
      wasOverdue: type === 'پیگیری معوقه انجام‌شده'
    }

    const fp = followupFingerprint(followup)
    const existing = byFingerprint.get(fp)

    try {
      let noteTouched = false
      if (existing) {
        let noteChanged = false
        if ((existing.nextDate || '') !== (followup.nextDate || '')) {
          existing.nextDate = followup.nextDate || ''
          noteChanged = true
        }
        if ((existing.result || '') !== (followup.result || '')) {
          existing.result = followup.result || ''
          noteChanged = true
        }
        if (noteChanged) {
          await updateFollowupInDB(existing)
          updated++
          noteTouched = true
        }
      } else if (notes || date) {
        const id = await saveFollowupToDB(followup)
        followup.id = id
        data.followups.push(followup)
        byFingerprint.set(fp, followup)
        created++
        noteTouched = true
      }

      // Pending tab reads customer.nextFollowupDate — rewrite from Excel when asked
      let customerTouched = false
      if (syncCustomerNextDate && nextDateMapped) {
        const normalizedNext = nextDate || ''
        if ((customer.nextFollowupDate || '') !== normalizedNext) {
          customer.nextFollowupDate = normalizedNext
          await saveCustomerToDB(customer)
          customersUpdated++
          customerTouched = true
        }
      }

      if (!noteTouched && !customerTouched) skipped++
    } catch (err) {
      console.error('followup import row failed', err)
      failed++
    }
  }

  return { created, updated, skipped, failed, missingCustomer, customersUpdated }
}

let importData = {
  headers: [],
  rows: [],
  mapping: {},
  autoMapping: {},
  followups: null, // { headers, rows, mapping } from sheet پیگیری‌ها
  mode: 'customers' // customers | followups
}

export function openImportModal() {
  if (!requirePermission('customers_import')) return
  importData = { headers: [], rows: [], mapping: {}, autoMapping: {}, followups: null, mode: 'customers', dryRun: null }
  document.getElementById('importStep1').style.display = ''
  document.getElementById('importStep2').style.display = 'none'
  document.getElementById('importBtn').style.display = 'none'
  const dryBtn = document.getElementById('importDryRunBtn')
  if (dryBtn) dryBtn.style.display = 'none'
  document.getElementById('importFileInput').value = ''
  document.getElementById('importMapping').innerHTML = ''
  document.getElementById('importPreview').textContent = ''
  document.getElementById('importModal').classList.add('active')
}

export function closeImportModal() {
  document.getElementById('importModal').classList.remove('active')
}

export function initImportListeners() {
  document.getElementById('importFileInput').addEventListener('change', function (e) {
    const file = e.target.files[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = function (ev) {
      try {
        const wb = XLSX.read(ev.target.result, { type: 'array' })
        const followupsSheetName = findFollowupsSheetName(wb)
        const customersSheetName = findCustomersSheetName(wb)
        const followupsParsed = followupsSheetName
          ? parseSheetAoA(wb.Sheets[followupsSheetName])
          : null
        const customersParsed = customersSheetName
          ? parseSheetAoA(wb.Sheets[customersSheetName])
          : null

        const onlyFollowups = followupsParsed
          && (!customersParsed || customersSheetName === followupsSheetName
            || !sheetLooksLikeCustomers(customersParsed.headers))

        // Standalone followups export (tab پیگیری‌ها / single sheet)
        if (onlyFollowups && sheetLooksLikeFollowups(followupsParsed.headers)) {
          importData.mode = 'followups'
          importData.headers = []
          importData.rows = []
          importData.mapping = {}
          importData.autoMapping = {}
          importData.followups = {
            headers: followupsParsed.headers,
            rows: followupsParsed.rows,
            mapping: autoMapColumns(followupsParsed.headers, FOLLOWUP_IMPORT_FIELDS)
          }
          renderImportMapping()
          return
        }

        if (!customersParsed) { showToast('فایل خالی است'); return }

        // Customers sheet (+ optional پیگیری‌ها sheet from app export)
        importData.mode = 'customers'
        importData.headers = customersParsed.headers
        importData.rows = customersParsed.rows
        importData.mapping = autoMapColumns(customersParsed.headers, IMPORT_FIELDS)
        importData.autoMapping = { ...importData.mapping }

        if (followupsParsed && followupsSheetName !== customersSheetName) {
          importData.followups = {
            headers: followupsParsed.headers,
            rows: followupsParsed.rows,
            mapping: autoMapColumns(followupsParsed.headers, FOLLOWUP_IMPORT_FIELDS)
          }
        } else {
          importData.followups = null
        }

        renderImportMapping()
      } catch (err) {
        console.error(err)
        showToast('خطا در خواندن فایل')
      }
    }
    reader.readAsArrayBuffer(file)
  })
}

function renderImportMapping() {
  const container = document.getElementById('importMapping')
  document.getElementById('importStep1').style.display = 'none'
  document.getElementById('importStep2').style.display = ''
  document.getElementById('importBtn').style.display = ''
  const dryBtn = document.getElementById('importDryRunBtn')
  if (dryBtn) dryBtn.style.display = ''

  const fu = importData.followups
  const fuCount = fu ? fu.rows.length : 0

  if (importData.mode === 'followups') {
    document.getElementById('importPreview').textContent =
      `${fuCount} یادداشت/پیگیری یافت شد — مپینگ خودکار از روی هدر خروجی`
    container.innerHTML = `
      <p class="import-map-hint">فایل خروجی پیگیری‌ها تشخیص داده شد. یادداشت‌های موجود به‌روزرسانی می‌شوند و تاریخ «پیگیری بعدی» روی مشتری بازنویسی می‌شود.</p>
      ${renderFieldMappingRows({
        fields: FOLLOWUP_IMPORT_FIELDS,
        headers: fu.headers,
        mapping: fu.mapping,
        autoMapping: fu.mapping,
        onChangeFn: 'setFollowupImportMapping'
      })}
    `
    return
  }

  const parts = [`${importData.rows.length} مشتری`]
  if (fuCount) parts.push(`${fuCount} یادداشت/پیگیری از شیت پیگیری‌ها`)
  document.getElementById('importPreview').textContent = parts.join(' + ') + ' یافت شد'

  let followupsNote = ''
  if (fuCount) {
    followupsNote = `<p class="import-map-hint" style="margin-top:12px;">شیت «پیگیری‌ها» هم همراه فایل است و بعد از ایمپورت مشتریان، ${fuCount} یادداشت به‌صورت خودکار وارد می‌شود.</p>`
  } else {
    followupsNote = `<p class="import-map-hint" style="margin-top:12px;">اگر فایل خروجی Excel برنامه باشد، شیت دوم «پیگیری‌ها» هم ایمپورت می‌شود. در این فایل شیت پیگیری پیدا نشد.</p>`
  }

  container.innerHTML = renderFieldMappingRows({
    fields: IMPORT_FIELDS,
    headers: importData.headers,
    mapping: importData.mapping,
    autoMapping: importData.autoMapping,
    onChangeFn: 'setImportMapping'
  }) + followupsNote
}

/** fieldKey → excel column index (or clear) */
export function setImportMapping(fieldKey, colRaw) {
  setFieldColumnMapping(importData, fieldKey, colRaw)
  renderImportMapping()
}

export function setFollowupImportMapping(fieldKey, colRaw) {
  if (!importData.followups) return
  setFieldColumnMapping(importData.followups, fieldKey, colRaw)
  renderImportMapping()
}

function isFieldMapped(mapping, fieldKey) {
  return mapping[fieldKey] !== undefined && mapping[fieldKey] !== null
}

function applyMappedCustomerFields(customer, { mapping, getValue, users, phones, primaryPhone, platformId, platform, status, isCreate }) {
  const currentUser = getCurrentUser()
  // On update, empty Excel cells mean "leave unchanged" (avoid wiping with defaults like new/instagram)
  const hasVal = (key) => String(getValue(key) || '').trim() !== ''

  if (isFieldMapped(mapping, 'platformId') || isCreate) {
    if (isCreate || hasVal('platformId') || platformId) {
      customer.platformId = platformId
    }
  }
  if (isFieldMapped(mapping, 'platform') || isCreate) {
    if (isCreate || hasVal('platform')) {
      customer.platform = platform || customer.platform || 'instagram'
    }
  }
  if (isFieldMapped(mapping, 'name') || isCreate) {
    if (isCreate || hasVal('name')) {
      customer.name = getValue('name')
    }
  }
  if (isFieldMapped(mapping, 'phone') || isFieldMapped(mapping, 'phone2') || isFieldMapped(mapping, 'phone3') || isCreate) {
    // Don't wipe existing phones when Excel cells failed to parse
    if (phones.length || isCreate) {
      customer.phones = phones
      customer.phone = primaryPhone
    }
  }
  if (isFieldMapped(mapping, 'status') || isCreate) {
    if (isCreate || hasVal('status')) {
      customer.status = status || customer.status || 'new'
    }
  }
  if (isFieldMapped(mapping, 'notes') || isCreate) {
    if (isCreate || hasVal('notes')) {
      customer.notes = getValue('notes')
    }
  }
  if (isFieldMapped(mapping, 'nextFollowupDate') || isCreate) {
    if (isCreate || hasVal('nextFollowupDate')) {
      customer.nextFollowupDate = getValue('nextFollowupDate') || ''
    }
  }
  if (isFieldMapped(mapping, 'advisor') || isCreate) {
    const advisorRaw = getValue('advisor') || (isCreate && currentUser
      ? (currentUser.phone || currentUser.displayName)
      : '')
    if (advisorRaw || isCreate) {
      const resolved = resolveAdvisor(advisorRaw, users)
      customer.advisor = resolved.advisor
      customer.advisorPhone = resolved.advisorPhone
    }
  }
  if (isFieldMapped(mapping, 'referredByPhone')) {
    if (isCreate || hasVal('referredByPhone')) {
      customer.referredByPhone = normalizePhone(getValue('referredByPhone')) || ''
    }
  } else if (isCreate) {
    customer.referredByPhone = ''
  }
  if (isFieldMapped(mapping, 'customerLevel')) {
    const level = parseCustomerLevel(getValue('customerLevel'))
    if (level) {
      customer.customerLevel = level
      customer.customerLevelLocked = true
    }
  } else if (isCreate) {
    customer.customerLevel = ''
    customer.customerLevelLocked = false
  }
  if (isFieldMapped(mapping, 'customerCode')) {
    if (isCreate || hasVal('customerCode')) {
      customer.customerCode = resolveCustomerCodeKey(getValue('customerCode'))
    }
  } else if (isCreate) {
    customer.customerCode = ''
  }
}

function previewFollowupRows({ headers, rows, mapping }, { syncCustomerNextDate = false, knownCustomerIds = null } = {}) {
  const data = getData()
  const map = mapping || autoMapColumns(headers, FOLLOWUP_IMPORT_FIELDS)
  if (map.customerId === undefined || map.customerId === null) {
    return { created: 0, updated: 0, skipped: 0, missingCustomer: 0, customersUpdated: 0 }
  }

  let created = 0, updated = 0, skipped = 0, missingCustomer = 0, customersUpdated = 0
  const byFingerprint = new Map()
  for (const f of data.followups) {
    byFingerprint.set(followupFingerprint(f), f)
  }
  const customerIdSet = knownCustomerIds || new Set(data.customers.map(c => c.id))
  const nextDateMapped = map.nextDate !== undefined && map.nextDate !== null

  for (const row of rows) {
    const getValue = (fieldKey) => {
      const colIdx = map[fieldKey]
      if (colIdx === undefined || colIdx === null) return ''
      return String(row[colIdx] || '').trim()
    }

    const customerId = getValue('customerId')
    const notes = getValue('notes')
    const date = toEnDigits(getValue('date'))
    const type = getValue('type') || 'یادداشت'
    if (!customerId || (!notes && !date && !(syncCustomerNextDate && nextDateMapped))) {
      skipped++
      continue
    }

    if (!customerIdSet.has(customerId)) {
      missingCustomer++
      continue
    }

    const nextDate = toEnDigits(getValue('nextDate'))
    const result = getValue('result') || ''
    const done = isDoneFollowupType(type)
    const followup = {
      customerId,
      date: date || '',
      type,
      result,
      nextDate: nextDate || '',
      notes: notes || '',
      status: done ? 'done' : 'pending',
    }

    const fp = followupFingerprint(followup)
    const existing = byFingerprint.get(fp)
    let noteTouched = false
    if (existing) {
      const noteChanged =
        (existing.nextDate || '') !== (followup.nextDate || '') ||
        (existing.result || '') !== (followup.result || '')
      if (noteChanged) {
        updated++
        noteTouched = true
      }
    } else if (notes || date) {
      byFingerprint.set(fp, followup)
      created++
      noteTouched = true
    }

    let customerTouched = false
    if (syncCustomerNextDate && nextDateMapped) {
      const customer = data.customers.find(c => c.id === customerId)
      const normalizedNext = nextDate || ''
      if (customer && (customer.nextFollowupDate || '') !== normalizedNext) {
        customersUpdated++
        customerTouched = true
      }
    }

    if (!noteTouched && !customerTouched) skipped++
  }

  return { created, updated, skipped, missingCustomer, customersUpdated }
}

function analyzeCustomerImportRows(rows, mapping, data) {
  let created = 0, updated = 0, skipped = 0
  const knownIds = new Set(data.customers.map(c => c.id))

  for (const row of rows) {
    const getValue = (fieldKey) => {
      const colIdx = mapping[fieldKey]
      if (colIdx === undefined || colIdx === null) return ''
      return String(row[colIdx] || '').trim()
    }

    const phone = toEnDigits(getValue('phone'))
    const phone2 = toEnDigits(getValue('phone2'))
    const phone3 = toEnDigits(getValue('phone3'))
    const phones = normalizeCustomerPhones([phone, phone2, phone3])
    const importId = getValue('id')
    const platformIdRaw = getValue('platformId')
    const name = getValue('name')

    if (!importId && !platformIdRaw && !name && !phones.length) {
      skipped++
      continue
    }

    let existing = null
    if (importId) existing = data.customers.find(c => c.id === importId) || null
    if (!existing && phones.length) {
      for (const p of phones) {
        existing = findCustomerByPhone(p, data.customers)
        if (existing) break
      }
    }
    if (!existing && platformIdRaw) {
      existing = data.customers.find(c =>
        (c.platformId || '').toLowerCase() === platformIdRaw.toLowerCase()
      ) || null
    }

    if (existing) {
      updated++
    } else {
      const id = importId || `__preview_${created}`
      if (knownIds.has(id)) {
        skipped++
        continue
      }
      knownIds.add(id)
      created++
    }
  }

  return { created, updated, skipped, knownIds }
}

async function previewCustomerImport() {
  if (importData.mode === 'followups') {
    const fu = importData.followups
    if (!fu?.rows?.length) return null
    return {
      mode: 'followups',
      followups: previewFollowupRows(fu, { syncCustomerNextDate: true })
    }
  }

  const mapping = importData.mapping
  if (Object.keys(mapping).length === 0) return null

  const data = getData()
  const stats = analyzeCustomerImportRows(importData.rows, mapping, data)

  let followups = null
  if (importData.followups?.rows?.length) {
    followups = previewFollowupRows(importData.followups, {
      syncCustomerNextDate: false,
      knownCustomerIds: stats.knownIds
    })
  }

  return {
    mode: 'customers',
    totalRows: importData.rows.length,
    created: stats.created,
    updated: stats.updated,
    skipped: stats.skipped,
    followups
  }
}

function renderCustomerImportPreview(stats) {
  const preview = document.getElementById('importPreview')
  if (!preview || !stats) return

  if (stats.mode === 'followups') {
    const fu = stats.followups
    preview.innerHTML = [
      '<b>پیش‌نمایش:</b>',
      fu.customersUpdated ? `${fu.customersUpdated} تاریخ پیگیری مشتری` : '',
      fu.updated ? `${fu.updated} یادداشت به‌روزرسانی` : '',
      fu.created ? `${fu.created} یادداشت ایجاد` : '',
      fu.skipped ? `${fu.skipped} بدون تغییر` : '',
      fu.missingCustomer ? `${fu.missingCustomer} بدون مشتری` : ''
    ].filter(Boolean).join(' — ') || '<b>پیش‌نمایش:</b> هیچ تغییری اعمال نمی‌شود'
    return
  }

  const parts = [
    `<b>پیش‌نمایش:</b> ${stats.totalRows} ردیف`,
    stats.created ? `${stats.created} مشتری جدید` : '',
    stats.updated ? `${stats.updated} مشتری به‌روزرسانی` : '',
    stats.skipped ? `${stats.skipped} رد شده` : ''
  ]

  const fu = stats.followups
  if (fu) {
    if (fu.created) parts.push(`${fu.created} یادداشت جدید`)
    if (fu.updated) parts.push(`${fu.updated} یادداشت به‌روزرسانی`)
    if (fu.skipped) parts.push(`${fu.skipped} یادداشت بدون تغییر`)
    if (fu.missingCustomer) parts.push(`${fu.missingCustomer} یادداشت بدون مشتری`)
  }

  preview.innerHTML = parts.filter(Boolean).join(' — ')
}

export async function dryRunCustomerImport() {
  if (!requirePermission('customers_import')) return
  const stats = await previewCustomerImport()
  if (!stats) {
    showToast('حداقل یک ستون را نقشه\u200cبرداری کنید')
    return
  }
  importData.dryRun = stats
  renderCustomerImportPreview(stats)
  showToast('پیش‌نمایش آماده است — در دیتابیس تغییری ذخیره نشد')
}

export async function doImport() {
  if (!requirePermission('customers_import')) return
  const data = getData()

  // ---------- Followups-only file (خروجی تب پیگیری‌ها) ----------
  if (importData.mode === 'followups') {
    if (!importData.followups?.rows?.length) {
      showToast('ردیفی برای ایمپورت پیگیری یافت نشد')
      return
    }
    const fu = await importFollowupRows(importData.followups, { syncCustomerNextDate: true })
    closeImportModal()
    await renderCustomers()
    try { await renderFollowups() } catch (_) {}
    const parts = []
    if (fu.customersUpdated) parts.push(`${fu.customersUpdated} تاریخ پیگیری مشتری`)
    if (fu.updated) parts.push(`${fu.updated} یادداشت به‌روزرسانی`)
    if (fu.created) parts.push(`${fu.created} یادداشت ایجاد`)
    if (fu.skipped) parts.push(`${fu.skipped} بدون تغییر`)
    if (fu.missingCustomer) parts.push(`${fu.missingCustomer} بدون مشتری`)
    if (fu.failed) parts.push(`${fu.failed} خطا`)
    showToast(parts.length ? parts.join(' — ') : 'هیچ تغییری اعمال نشد')
    return
  }

  const mapping = importData.mapping
  if (Object.keys(mapping).length === 0) {
    showToast('حداقل یک ستون را نقشه\u200cبرداری کنید')
    return
  }

  let created = 0, updated = 0, skipped = 0, failed = 0
  const users = await getUsersSafe()
  const statusMap = buildStatusImportMap()

  for (const row of importData.rows) {
    const getValue = (fieldKey) => {
      const colIdx = mapping[fieldKey]
      if (colIdx === undefined || colIdx === null) return ''
      return String(row[colIdx] || '').trim()
    }

    const phone = toEnDigits(getValue('phone'))
    const phone2 = toEnDigits(getValue('phone2'))
    const phone3 = toEnDigits(getValue('phone3'))
    const phones = normalizeCustomerPhones([phone, phone2, phone3])
    const primaryPhone = phones[0] || ''
    const importId = getValue('id')
    const platformIdRaw = getValue('platformId')
    const name = getValue('name')

    // Skip completely empty rows
    if (!importId && !platformIdRaw && !name && !phones.length) {
      skipped++
      continue
    }

    const platformRaw = getValue('platform').toLowerCase()
    const platform = buildPlatformImportMap()[platformRaw] || platformRaw || 'instagram'
    const statusRaw = getValue('status')
    const status = statusMap[statusRaw] || statusMap[statusRaw.toLowerCase()] || statusRaw || 'new'

    // Match existing: id → phone → platformId (only when provided in file)
    let existing = null
    if (importId) existing = data.customers.find(c => c.id === importId) || null
    if (!existing && phones.length) {
      for (const p of phones) {
        existing = findCustomerByPhone(p, data.customers)
        if (existing) break
      }
    }
    if (!existing && platformIdRaw) {
      existing = data.customers.find(c =>
        (c.platformId || '').toLowerCase() === platformIdRaw.toLowerCase()
      ) || null
    }

    let platformId = platformIdRaw
    if (!platformId) {
      if (existing?.platformId) {
        platformId = existing.platformId
      } else if (primaryPhone) {
        platformId = `telegram.me/${primaryPhone.replace(/^0/, '+98')}`
      } else {
        platformId = `auto_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      }
    }

    try {
      if (existing) {
        applyMappedCustomerFields(existing, {
          mapping, getValue, users, phones, primaryPhone, platformId, platform, status, isCreate: false
        })
        if (!existing.customerLevelLocked) {
          syncCustomerLevel(existing, data.customers, data.followups)
        }
        await saveCustomerToDB(existing)
        updated++
      } else {
        const type = phones.length ? 'CS' : 'LD'
        const id = importId || await generateId(type)
        // Guard against colliding with an id that appeared mid-import
        if (data.customers.some(c => c.id === id)) {
          skipped++
          continue
        }
        const newCustomer = {
          id,
          products: [],
          createdAt: new Date().toISOString(),
          advisor: '',
          advisorPhone: '',
          platformId: '',
          platform: 'instagram',
          name: '',
          phone: '',
          phones: [],
          status: 'new',
          notes: '',
          nextFollowupDate: '',
          referredByPhone: '',
          customerLevel: '',
          customerLevelLocked: false
        }
        applyMappedCustomerFields(newCustomer, {
          mapping, getValue, users, phones, primaryPhone, platformId, platform, status, isCreate: true
        })
        if (!newCustomer.customerLevelLocked) {
          syncCustomerLevel(newCustomer, data.customers, data.followups)
        }
        putCustomerInCache(newCustomer)
        await saveCustomerToDB(newCustomer)
        created++
      }
    } catch (err) {
      console.error('customer import row failed', err)
      failed++
    }
  }

  // Recompute unlocked levels (CIP may unlock after referrals imported)
  for (const c of data.customers) {
    if (c.customerLevelLocked) continue
    const before = c.customerLevel || ''
    syncCustomerLevel(c, data.customers, data.followups)
    if ((c.customerLevel || '') !== before) {
      try {
        await saveCustomerToDB(c)
      } catch (err) {
        console.error('customer level sync failed', c.id, err)
      }
    }
  }

  // Import sheet «پیگیری‌ها» from the same workbook (after customers exist)
  let fu = { created: 0, updated: 0, skipped: 0, failed: 0, missingCustomer: 0, customersUpdated: 0 }
  if (importData.followups?.rows?.length) {
    fu = await importFollowupRows(importData.followups)
  }

  closeImportModal()
  await renderCustomers()
  try { await renderFollowups() } catch (_) {}

  const parts = []
  if (created) parts.push(`${created} مشتری ایجاد`)
  if (updated) parts.push(`${updated} مشتری به‌روزرسانی`)
  if (skipped) parts.push(`${skipped} رد شده`)
  if (failed) parts.push(`${failed} خطای مشتری`)
  if (fu.created) parts.push(`${fu.created} یادداشت`)
  if (fu.updated) parts.push(`${fu.updated} یادداشت به‌روزرسانی`)
  if (fu.skipped) parts.push(`${fu.skipped} یادداشت بدون تغییر`)
  if (fu.missingCustomer) parts.push(`${fu.missingCustomer} یادداشت بدون مشتری`)
  if (fu.failed) parts.push(`${fu.failed} خطای یادداشت`)
  showToast(parts.length ? parts.join(' — ') : 'هیچ ردیفی ایمپورت نشد')
}

// ============================================
// Sales Import
// ============================================

const SALES_IMPORT_FIELDS = [
  { key: 'customerId', label: 'شناسه مشتری', aliases: ['شناسه'] },
  { key: 'phone', label: 'شماره موبایل', aliases: ['شماره', 'شماره تماس'], required: true },
  { key: 'customerName', label: 'نام مشتری', aliases: ['نام'] },
  { key: 'platform', label: 'پلتفرم' },
  { key: 'customerCode', label: 'کد مشتری', aliases: ['کد'] },
  { key: 'productName', label: 'محصول', required: true },
  { key: 'status', label: 'وضعیت' },
  // «مبلغ» (site) = paid amount; «مبلغ کل» = invoice total (esp. بیعانه)
  { key: 'paymentAmount', label: 'مبلغ', aliases: ['مبلغ واریز'] },
  { key: 'price', label: 'مبلغ کل', aliases: ['قیمت کل'] },
  { key: 'deposit', label: 'پرداخت‌شده', aliases: ['بیعانه پرداختی'] },
  { key: 'settlementDate', label: 'تاریخ تسویه' },
  { key: 'advisor', label: 'کارشناس' },
  { key: 'soldAt', label: 'تاریخ', aliases: ['تاریخ واریز', 'تاریخ و ساعت'] },
  { key: 'soldAtTime', label: 'ساعت' },
  { key: 'depositorName', label: 'نام واریزکننده' },
  { key: 'destinationBank', label: 'مقصد', aliases: ['بانک مقصد'] },
]

/** Only two sale statuses are accepted in the system (hardcoded). */
const SALE_STATUS_OPTIONS = ['تکمیل', 'بیعانه']

/** Soft hints for auto-suggesting status value map — final choice is always تکمیل|بیعانه */
const SALE_STATUS_HINTS = {
  'تکمیل': 'تکمیل',
  'تکمیل شده': 'تکمیل',
  'تکمیل‌شده': 'تکمیل',
  'تسویه': 'تکمیل',
  'تسویه شده': 'تکمیل',
  'تسویه‌شده': 'تکمیل',
  complet: 'تکمیل',
  completed: 'تکمیل',
  settled: 'تکمیل',
  'بیعانه': 'بیعانه',
  deposit: 'بیعانه',
  partial: 'بیعانه',
}

function emptySalesImportState() {
  return {
    headers: [],
    rows: [],
    mapping: {},
    autoMapping: {},
    isSiteFormat: false,
    /** File amounts unit: 'rial' (as-is) | 'toman' (×10 → system rial) */
    amountUnit: 'rial',
    uniqueProducts: [],
    uniqueDestinations: [],
    uniqueStatuses: [],
    uniqueAdvisors: [],
    productValueMap: {},
    destinationValueMap: {},
    statusValueMap: {},
    advisorValueMap: {},
    productAutoMap: {},
    destinationAutoMap: {},
    statusAutoMap: {},
    advisorAutoMap: {},
    advisorOptions: [], // [{ value, label }]
    problemExport: null // { headers, rows, reasons }
  }
}

let salesImportData = emptySalesImportState()

function looksLikeSiteSalesExport(headers) {
  const set = new Set(headers.map(normalizeHeaderLabel))
  const has = (label) => set.has(normalizeHeaderLabel(label))
  const hasTime = has('ساعت')
  const hasDate = has('تاریخ')
  const hasMablagh = has('مبلغ')
  const hasMablaghVariz = has('مبلغ واریز')
  const hasMaqsad = has('مقصد')
  const hasBank = has('بانک مقصد')
  const hasCustomerId = has('شناسه مشتری')
  if (hasTime && hasDate && !hasCustomerId) return true
  if (hasMaqsad && !hasBank) return true
  if (hasMablagh && !hasMablaghVariz && !hasCustomerId) return true
  return false
}

function collectUniqueMappedValues(rows, colIdx) {
  if (colIdx === undefined || colIdx === null) return []
  const seen = new Set()
  const out = []
  for (const row of rows) {
    const v = String(row[colIdx] ?? '').trim()
    if (!v || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out.sort((a, b) => a.localeCompare(b, 'fa'))
}

function autoMapValueNames(excelNames, catalogNames) {
  const map = {}
  const catalog = catalogNames.map(c => ({ raw: c, norm: normalizeHeaderLabel(c) }))
  for (const name of excelNames) {
    const n = normalizeHeaderLabel(name)
    if (!n) continue
    const exact = catalog.find(c => c.norm === n)
    if (exact) {
      map[name] = exact.raw
      continue
    }
    // Prefer longer catalog matches to avoid short false positives
    const loose = catalog
      .filter(c => c.norm.length >= 2 && (c.norm.includes(n) || n.includes(c.norm)))
      .sort((a, b) => b.norm.length - a.norm.length)[0]
    if (loose) map[name] = loose.raw
  }
  return map
}

function hintSaleStatus(excelValue) {
  const raw = String(excelValue || '').trim()
  if (!raw) return ''
  return SALE_STATUS_HINTS[raw]
    || SALE_STATUS_HINTS[normalizeHeaderLabel(raw)]
    || SALE_STATUS_HINTS[raw.toLowerCase()]
    || ''
}

function refreshSalesValueMaps() {
  const mapping = salesImportData.mapping
  salesImportData.uniqueProducts = collectUniqueMappedValues(
    salesImportData.rows, mapping.productName
  )
  salesImportData.uniqueDestinations = collectUniqueMappedValues(
    salesImportData.rows, mapping.destinationBank
  )
  salesImportData.uniqueStatuses = collectUniqueMappedValues(
    salesImportData.rows, mapping.status
  )
  salesImportData.uniqueAdvisors = collectUniqueMappedValues(
    salesImportData.rows, mapping.advisor
  )

  const catalog = getSellableNames()
  const banks = getDestinationBanks()
  const advisorOpts = salesImportData.advisorOptions || []

  const productAuto = autoMapValueNames(salesImportData.uniqueProducts, catalog)
  const destAuto = autoMapValueNames(salesImportData.uniqueDestinations, banks)
  const statusAuto = {}
  for (const name of salesImportData.uniqueStatuses) {
    const hint = hintSaleStatus(name)
    if (hint) statusAuto[name] = hint
  }
  const advisorAuto = {}
  for (const name of salesImportData.uniqueAdvisors) {
    const n = normalizeHeaderLabel(name)
    const phone = normalizePhone(name)
    const byPhone = phone && /^09\d{9}$/.test(phone)
      ? advisorOpts.find(o => o.value === phone)
      : null
    if (byPhone) {
      advisorAuto[name] = byPhone.value
      continue
    }
    const exact = advisorOpts.find(o => normalizeHeaderLabel(o.label) === n)
    if (exact) {
      advisorAuto[name] = exact.value
      continue
    }
    const loose = advisorOpts
      .filter(o => {
        const ln = normalizeHeaderLabel(o.label)
        return ln.length >= 2 && (ln.includes(n) || n.includes(ln))
      })
      .sort((a, b) => b.label.length - a.label.length)[0]
    if (loose) advisorAuto[name] = loose.value
  }

  const mergeManual = (auto, manual, allowedKeys, validate) => {
    const next = { ...auto }
    for (const [k, v] of Object.entries(manual || {})) {
      if (!allowedKeys.includes(k)) continue
      if (validate && !validate(v)) continue
      if (v) next[k] = v
    }
    return next
  }

  salesImportData.productAutoMap = productAuto
  salesImportData.destinationAutoMap = destAuto
  salesImportData.statusAutoMap = statusAuto
  salesImportData.advisorAutoMap = advisorAuto
  salesImportData.productValueMap = mergeManual(
    productAuto, salesImportData.productValueMap, salesImportData.uniqueProducts
  )
  salesImportData.destinationValueMap = mergeManual(
    destAuto, salesImportData.destinationValueMap, salesImportData.uniqueDestinations
  )
  salesImportData.statusValueMap = mergeManual(
    statusAuto, salesImportData.statusValueMap, salesImportData.uniqueStatuses,
    v => SALE_STATUS_OPTIONS.includes(v)
  )
  salesImportData.advisorValueMap = mergeManual(
    advisorAuto, salesImportData.advisorValueMap, salesImportData.uniqueAdvisors,
    v => advisorOpts.some(o => o.value === v)
  )
}

function renderValueMappingSection({
  title, hint, excelValues, valueMap, autoMap, options, onChangeFn, required
}) {
  if (!excelValues.length) return ''
  const rows = excelValues.map((name, idx) => {
    const selected = valueMap[name] || ''
    const isAuto = selected && autoMap[name] === selected
    const hasMap = !!selected
    const opts = options.map(o => {
      const value = typeof o === 'string' ? o : o.value
      const label = typeof o === 'string' ? o : o.label
      const sel = selected === value ? 'selected' : ''
      return `<option value="${escapeAttr(value)}" ${sel}>${escapeHtml(label)}</option>`
    }).join('')
    return `
      <div class="import-map-row${hasMap ? (isAuto ? ' is-auto' : ' is-mapped') : ' is-unmapped'}">
        <span class="field-col" title="${escapeAttr(name)}">
          ${escapeHtml(name)}
          ${isAuto ? '<span class="auto-badge">خودکار</span>' : ''}
        </span>
        <span class="arrow">←</span>
        <select onchange="app.${onChangeFn}(${idx}, this.value)" aria-label="مپینگ ${escapeAttr(name)}">
          <option value="">— انتخاب نشده —</option>
          ${opts}
        </select>
      </div>
    `
  }).join('')
  const unmapped = excelValues.filter(n => !valueMap[n]).length
  const reqNote = required && unmapped
    ? `<p class="import-map-hint" style="color:var(--warning);">هنوز ${unmapped} مورد مپ نشده — ردیف‌های مربوط در فایل مشکل‌دار قابل دانلود خواهند بود.</p>`
    : ''
  return `
    <div class="import-value-map">
      <h3 class="import-value-title">${escapeHtml(title)}</h3>
      <p class="import-map-hint">${escapeHtml(hint)}</p>
      ${reqNote}
      ${rows}
    </div>
  `
}

function buildSoldAt(dateRaw, timeRaw) {
  const date = jalaliDatePart(toEnDigits(dateRaw))
  const time = normalizeTimeTo24h(toEnDigits(timeRaw))
  if (date && time) return `${date} ${time}`
  if (date) {
    // Date cell may already include time
    const existingTime = soldAtTimeFromCell(dateRaw)
    if (existingTime) return `${date} ${existingTime}`
    return date
  }
  return toEnDigits(String(dateRaw || '').trim())
}

function soldAtTimeFromCell(raw) {
  const s = toEnDigits(String(raw || '')).trim()
  const parts = s.split(/\s+/)
  if (parts.length < 2) return ''
  return normalizeTimeTo24h(parts.slice(1).join(' '))
}

export function openSalesImportModal() {
  if (!requirePermission('sales_import')) return
  salesImportData = emptySalesImportState()
  document.getElementById('salesImportMapping').style.display = 'none'
  document.getElementById('salesImportMapping').innerHTML = ''
  document.getElementById('salesImportBtn').style.display = 'none'
  const problemsBtn = document.getElementById('salesImportProblemsBtn')
  if (problemsBtn) problemsBtn.style.display = 'none'
  document.getElementById('salesImportPreview').textContent = ''
  document.getElementById('salesImportFileInput').value = ''
  document.getElementById('salesImportModal').classList.add('active')
}

export function closeSalesImportModal() {
  document.getElementById('salesImportModal').classList.remove('active')
}

export function initSalesImportListeners() {
  document.getElementById('salesImportFileInput').addEventListener('change', function (e) {
    const file = e.target.files[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = async function (ev) {
      try {
        const wb = XLSX.read(ev.target.result, { type: 'array' })
        const ws = wb.Sheets[wb.SheetNames[0]]
        const json = XLSX.utils.sheet_to_json(ws, { header: 1 })

        if (json.length < 2) { showToast('فایل خالی است'); return }

        salesImportData = emptySalesImportState()
        salesImportData.headers = json[0].map(h => String(h || '').trim())
        salesImportData.rows = json.slice(1).filter(r => r.some(c => c != null && String(c).trim() !== ''))
        salesImportData.mapping = autoMapColumns(salesImportData.headers, SALES_IMPORT_FIELDS)
        salesImportData.autoMapping = { ...salesImportData.mapping }
        salesImportData.isSiteFormat = looksLikeSiteSalesExport(salesImportData.headers)
        // Site sales Excel is usually تومان; program export is already ریال
        salesImportData.amountUnit = salesImportData.isSiteFormat ? 'toman' : 'rial'

        try {
          const users = await getUsersSafe()
          salesImportData.advisorOptions = (users || [])
            .map(u => {
              const phone = normalizePhone(u.phone)
              const label = userDisplayName(u) || phone
              if (!phone && !label) return null
              return { value: phone || label, label: label || phone }
            })
            .filter(Boolean)
            .sort((a, b) => a.label.localeCompare(b.label, 'fa'))
        } catch (_) {
          salesImportData.advisorOptions = []
        }

        refreshSalesValueMaps()
        renderSalesImportMapping()
      } catch (err) {
        console.error(err)
        showToast('خطا در خواندن فایل')
      }
    }
    reader.readAsArrayBuffer(file)
  })
}

function renderSalesImportMapping() {
  const container = document.getElementById('salesImportMapping')
  container.style.display = ''
  document.getElementById('salesImportBtn').style.display = ''
  document.getElementById('salesImportProblemsBtn')?.style && (document.getElementById('salesImportProblemsBtn').style.display = 'none')

  const siteNote = salesImportData.isSiteFormat
    ? 'فرمت فروش سایت تشخیص داده شد — واریزها «در انتظار تأیید» وارد می‌شوند؛ مبلغ/مبلغ‌کل و تاریخ+ساعت بر همان اساس تفسیر می‌شوند.'
    : 'فرمت خروجی برنامه یا اکسل عمومی.'
  const unitNote = salesImportData.amountUnit === 'toman'
    ? 'واحد مبالغ: تومان (در سیستم ×۱۰ به ریال)'
    : 'واحد مبالغ: ریال'
  document.getElementById('salesImportPreview').textContent =
    `${salesImportData.rows.length} ردیف — ${siteNote} — ${unitNote}`

  const productSection = renderValueMappingSection({
    title: 'مپینگ نام محصول',
    hint: 'هر نام محصول در فایل اکسل را به یکی از محصولات یا باندل‌های کاتالوگ تنظیمات وصل کنید.',
    excelValues: salesImportData.uniqueProducts,
    valueMap: salesImportData.productValueMap,
    autoMap: salesImportData.productAutoMap,
    options: getSellableNames(),
    onChangeFn: 'setSalesProductValueMap',
    required: true
  })

  const statusSection = renderValueMappingSection({
    title: 'مپینگ وضعیت فروش',
    hint: 'فقط دو مقدار پذیرفته می‌شود: تکمیل یا بیعانه. مقادیر مپ‌نشده باعث می‌شوند همان ردیف‌ها در فایل مشکل‌دار بمانند.',
    excelValues: salesImportData.uniqueStatuses,
    valueMap: salesImportData.statusValueMap,
    autoMap: salesImportData.statusAutoMap,
    options: SALE_STATUS_OPTIONS,
    onChangeFn: 'setSalesStatusValueMap',
    required: true
  })

  const banks = getDestinationBanks()
  const destSection = banks.length
    ? renderValueMappingSection({
      title: 'مپینگ مقصد واریز',
      hint: 'هر مقصد در فایل را به یکی از بانک‌های مقصد تنظیمات وصل کنید.',
      excelValues: salesImportData.uniqueDestinations,
      valueMap: salesImportData.destinationValueMap,
      autoMap: salesImportData.destinationAutoMap,
      options: banks,
      onChangeFn: 'setSalesDestinationValueMap',
      required: true
    })
    : (salesImportData.uniqueDestinations.length
      ? `<p class="import-map-hint" style="color:var(--danger);">بانک مقصدی در تنظیمات تعریف نشده — اول از تنظیمات اضافه کنید.</p>`
      : '')

  const advisorSection = (salesImportData.advisorOptions || []).length
    ? renderValueMappingSection({
      title: 'مپینگ نام کارشناس',
      hint: 'هر نام کارشناس در فایل را به یکی از کاربران سیستم وصل کنید.',
      excelValues: salesImportData.uniqueAdvisors,
      valueMap: salesImportData.advisorValueMap,
      autoMap: salesImportData.advisorAutoMap,
      options: salesImportData.advisorOptions,
      onChangeFn: 'setSalesAdvisorValueMap',
      required: true
    })
    : (salesImportData.uniqueAdvisors.length
      ? `<p class="import-map-hint" style="color:var(--warning);">لیست کاربران برای مپینگ کارشناس در دسترس نیست.</p>`
      : '')

  const catalogEmpty = getSellableNames().length === 0
    ? `<p class="import-map-hint" style="color:var(--danger);">کاتالوگ محصولات خالی است — از تنظیمات مدیر محصول اضافه کنید.</p>`
    : ''

  const unit = salesImportData.amountUnit === 'toman' ? 'toman' : 'rial'
  const amountUnitSection = `
    <div class="import-value-map">
      <h3 class="import-value-title">واحد مبالغ فایل اکسل</h3>
      <p class="import-map-hint">سیستم همه مبالغ را به <b>ریال</b> ذخیره می‌کند. اگر اعداد فایل تومان است، تومان را انتخاب کنید تا هنگام ایمپورت ×۱۰ شود.</p>
      <div class="import-amount-unit" role="radiogroup" aria-label="واحد مبالغ">
        <label class="import-amount-option${unit === 'rial' ? ' is-selected' : ''}">
          <input type="radio" name="salesAmountUnit" value="rial" ${unit === 'rial' ? 'checked' : ''}
            onchange="app.setSalesAmountUnit('rial')">
          <span>ریال</span>
        </label>
        <label class="import-amount-option${unit === 'toman' ? ' is-selected' : ''}">
          <input type="radio" name="salesAmountUnit" value="toman" ${unit === 'toman' ? 'checked' : ''}
            onchange="app.setSalesAmountUnit('toman')">
          <span>تومان</span>
        </label>
      </div>
    </div>
  `

  container.innerHTML = `
    ${renderFieldMappingRows({
      fields: SALES_IMPORT_FIELDS,
      headers: salesImportData.headers,
      mapping: salesImportData.mapping,
      autoMapping: salesImportData.autoMapping,
      onChangeFn: 'setSalesImportMapping'
    })}
    ${amountUnitSection}
    ${catalogEmpty}
    ${productSection}
    ${statusSection}
    ${destSection}
    ${advisorSection}
  `
}

/** fieldKey → excel column index (or clear) */
export function setSalesImportMapping(fieldKey, colRaw) {
  setFieldColumnMapping(salesImportData, fieldKey, colRaw)
  refreshSalesValueMaps()
  renderSalesImportMapping()
}

export function setSalesAmountUnit(unit) {
  salesImportData.amountUnit = unit === 'toman' ? 'toman' : 'rial'
  renderSalesImportMapping()
}

export function setSalesProductValueMap(index, catalogName) {
  const name = salesImportData.uniqueProducts[index]
  if (!name) return
  if (!catalogName) delete salesImportData.productValueMap[name]
  else salesImportData.productValueMap[name] = catalogName
  renderSalesImportMapping()
}

export function setSalesDestinationValueMap(index, bankName) {
  const name = salesImportData.uniqueDestinations[index]
  if (!name) return
  if (!bankName) delete salesImportData.destinationValueMap[name]
  else salesImportData.destinationValueMap[name] = bankName
  renderSalesImportMapping()
}

export function setSalesStatusValueMap(index, statusName) {
  const name = salesImportData.uniqueStatuses[index]
  if (!name) return
  if (!statusName || !SALE_STATUS_OPTIONS.includes(statusName)) {
    delete salesImportData.statusValueMap[name]
  } else {
    salesImportData.statusValueMap[name] = statusName
  }
  renderSalesImportMapping()
}

export function setSalesAdvisorValueMap(index, advisorKey) {
  const name = salesImportData.uniqueAdvisors[index]
  if (!name) return
  const ok = (salesImportData.advisorOptions || []).some(o => o.value === advisorKey)
  if (!advisorKey || !ok) delete salesImportData.advisorValueMap[name]
  else salesImportData.advisorValueMap[name] = advisorKey
  renderSalesImportMapping()
}

function padImportRow(row, colCount) {
  const out = []
  for (let i = 0; i < colCount; i++) {
    const v = row?.[i]
    out.push(v == null ? '' : v)
  }
  return out
}

function renderSalesImportResult({ imported, created, skipped, failed, problemCount }) {
  const container = document.getElementById('salesImportMapping')
  container.style.display = ''
  document.getElementById('salesImportBtn').style.display = 'none'
  const problemsBtn = document.getElementById('salesImportProblemsBtn')
  if (problemsBtn) {
    problemsBtn.style.display = problemCount ? '' : 'none'
  }

  const parts = []
  if (imported) parts.push(`${imported} واریز/محصول ایمپورت شد`)
  if (created) parts.push(`${created} مشتری جدید`)
  if (skipped) parts.push(`${skipped} رد/تکراری`)
  if (failed) parts.push(`${failed} خطای ذخیره`)
  document.getElementById('salesImportPreview').textContent = parts.join(' — ') || 'هیچ ردیفی ایمپورت نشد'

  container.innerHTML = `
    <div class="import-value-map">
      <h3 class="import-value-title">نتیجه ایمپورت</h3>
      <p class="import-map-hint">${escapeHtml(parts.join(' — ') || 'هیچ ردیفی ایمپورت نشد')}</p>
      ${problemCount ? `
        <p class="import-map-hint" style="color:var(--danger);">
          ${problemCount} ردیف به‌خاطر مقدار نامعتبر/مپ‌نشده (مثل وضعیت خارج از تکمیل/بیعانه، محصول، مقصد یا کارشناس) ایمپورت نشد.
          همان ردیف‌ها را می‌توانید به‌صورت فایل Excel جدید دانلود کنید.
        </p>
      ` : '<p class="import-map-hint">ردیفی با خطای مپینگ باقی نماند.</p>'}
    </div>
  `
}

export function downloadSalesImportProblems() {
  const pack = salesImportData.problemExport
  if (!pack?.rows?.length) {
    showToast('ردیفی برای دانلود نیست')
    return
  }
  const headers = [...pack.headers, 'علت رد']
  const rows = pack.rows.map((r, i) => [...padImportRow(r, pack.headers.length), pack.reasons[i] || ''])
  const ws = sheetFromAoa(headers, rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'ردیف‌های مشکل‌دار')
  XLSX.writeFile(wb, `فروش_مشکل‌دار_${new Date().toISOString().slice(0, 10)}.xlsx`)
  showToast(`${rows.length} ردیف مشکل‌دار دانلود شد`)
}

export async function doSalesImport() {
  if (!requirePermission('sales_import')) return
  const data = getData()
  const mapping = salesImportData.mapping
  const hasPhone = mapping.phone !== undefined && mapping.phone !== null
  const hasCustomerId = mapping.customerId !== undefined && mapping.customerId !== null
  if (!hasPhone && !hasCustomerId) {
    showToast('ستون شماره موبایل یا شناسه مشتری الزامی است')
    return
  }
  if (!isFieldMapped(mapping, 'productName')) {
    showToast('ستون محصول را مپ کنید')
    return
  }
  if (!getSellableNames().length) {
    showToast('کاتالوگ محصولات خالی است — از تنظیمات اضافه کنید')
    return
  }

  let imported = 0, skipped = 0, created = 0, failed = 0
  const problemRows = []
  const problemReasons = []
  const markProblem = (row, reason) => {
    problemRows.push(Array.isArray(row) ? row.slice() : [])
    problemReasons.push(reason)
  }

  const users = await getUsersSafe()
  const banks = getDestinationBanks()
  const touched = new Set()
  const paymentColMapped = isFieldMapped(mapping, 'paymentAmount')
  const priceColMapped = isFieldMapped(mapping, 'price')
  const isSite = salesImportData.isSiteFormat
  const hasAdvisorOptions = (salesImportData.advisorOptions || []).length > 0

  for (const row of salesImportData.rows) {
    const getValue = (fieldKey) => {
      const colIdx = mapping[fieldKey]
      if (colIdx === undefined || colIdx === null) return ''
      const v = row[colIdx]
      // Keep numeric 0 (e.g. ساعت = 0 → 00:00); || would drop it
      if (v == null || v === '') return ''
      return String(v).trim()
    }

    const phoneRaw = toEnDigits(getValue('phone'))
    const phonesFromCell = normalizeCustomerPhones(phoneRaw)
    const phone = phonesFromCell[0] || ''
    const customerId = getValue('customerId')
    const productRaw = getValue('productName')
    if (!productRaw) {
      markProblem(row, 'محصول خالی است')
      continue
    }
    if (!phone && !customerId) {
      markProblem(row, 'شماره موبایل و شناسه مشتری خالی است')
      continue
    }

    const productName = salesImportData.productValueMap[productRaw]
    if (!productName) {
      markProblem(row, `محصول مپ نشده: ${productRaw}`)
      continue
    }

    const statusRaw = getValue('status')
    let status = 'تکمیل'
    if (statusRaw) {
      const mappedStatus = salesImportData.statusValueMap[statusRaw]
      if (SALE_STATUS_OPTIONS.includes(mappedStatus)) {
        status = mappedStatus
      } else {
        markProblem(row, `وضعیت باید به تکمیل یا بیعانه مپ شود: ${statusRaw}`)
        continue
      }
    }

    const destRaw = getValue('destinationBank')
    let destinationBank = ''
    if (destRaw) {
      if (banks.length) {
        const mappedDest = salesImportData.destinationValueMap[destRaw]
        if (!mappedDest) {
          markProblem(row, `مقصد واریز مپ نشده: ${destRaw}`)
          continue
        }
        destinationBank = mappedDest
      } else {
        destinationBank = destRaw
      }
    }

    const advisorExcel = getValue('advisor')
    let advisorResolved = null
    if (advisorExcel) {
      if (hasAdvisorOptions) {
        const mappedAdvisor = salesImportData.advisorValueMap[advisorExcel]
        if (!mappedAdvisor) {
          markProblem(row, `کارشناس مپ نشده: ${advisorExcel}`)
          continue
        }
        advisorResolved = resolveAdvisor(mappedAdvisor, users)
      } else {
        advisorResolved = resolveAdvisor(advisorExcel, users)
      }
    }

    let customer = null
    if (customerId) customer = data.customers.find(c => c.id === customerId)
    if (!customer && phone) {
      customer = findCustomerByPhone(phone, data.customers)
    }

    if (!customer) {
      if (!phone) {
        markProblem(row, 'برای ایجاد مشتری جدید شماره موبایل لازم است')
        continue
      }
      const name = getValue('customerName') || ''
      const id = await generateId('CS')
      const currentUser = getCurrentUser()
      if (!advisorResolved) {
        const fallback = currentUser ? (currentUser.phone || currentUser.displayName) : ''
        advisorResolved = resolveAdvisor(fallback, users)
      }
      const platformRaw = getValue('platform').toLowerCase()
      const defaultPlatform = isSite ? 'website' : 'instagram'
      const platform = buildPlatformImportMap()[platformRaw] || platformRaw || defaultPlatform
      const phones = phonesFromCell.length ? phonesFromCell : normalizeCustomerPhones([phone])
      customer = {
        id,
        platformId: '',
        platform,
        name,
        phone: phones[0] || '',
        phones,
        status: 'purchased',
        notes: isSite ? 'ایجاد شده از ایمپورت فروش سایت' : 'خودکار ایجاد شده از ایمپورت فروش',
        advisor: advisorResolved.advisor,
        advisorPhone: advisorResolved.advisorPhone,
        nextFollowupDate: '',
        products: [],
        createdAt: new Date().toISOString(),
        customerLevel: '',
        customerLevelLocked: false,
        referredByPhone: '',
        customerCode: resolveCustomerCodeKey(getValue('customerCode'))
      }
      putCustomerInCache(customer)
      created++
      touched.add(customer.id)
    } else if (isFieldMapped(salesImportData.mapping, 'customerCode') && getValue('customerCode')) {
      const nextCode = resolveCustomerCodeKey(getValue('customerCode'))
      if (nextCode && customer.customerCode !== nextCode) {
        customer.customerCode = nextCode
        touched.add(customer.id)
      }
    }

    let price = parseImportMoney(getValue('price'))
    const deposit = parseImportMoney(getValue('deposit'))
    const settlementDate = getValue('settlementDate')
    const soldAt = buildSoldAt(getValue('soldAt'), getValue('soldAtTime')) || settlementDate || ''
    const depositorName = getValue('depositorName')

    // Accounting approval is never imported — all deposits stay pending for manual review
    const paymentStatus = PAYMENT_STATUS.pending

    let paymentAmount = parseImportMoney(getValue('paymentAmount'))

    // Site / semantic rules:
    // تکمیل: «مبلغ» = total = full payment
    // بیعانه: «مبلغ» = paid deposit, «مبلغ کل» = invoice total (balance = price - paid)
    if (isSite || (paymentColMapped && priceColMapped)) {
      if (status === 'بیعانه') {
        if (!paymentAmount && deposit) paymentAmount = deposit
        // price already from مبلغ کل
      } else {
        // تکمیل / settled
        if (!price && paymentAmount) price = paymentAmount
        if (!paymentAmount && price) paymentAmount = price
      }
    } else if (!paymentAmount && !paymentColMapped) {
      paymentAmount = status === 'بیعانه' ? (deposit || price) : (price || deposit)
    }

    if (!Array.isArray(customer.products)) customer.products = []

    let product = customer.products.find(p =>
      p.name === productName && (price <= 0 || (parseFloat(p.price) || 0) === price)
    )

    if (!paymentAmount) {
      if (!product) {
        product = {
          name: productName,
          status,
          price: String(price || 0),
          deposit: String(deposit || 0),
          settlementDate,
          priceLocked: price > 0,
          payments: []
        }
        applyProfitSnapshotToProduct(product)
        customer.products.push(product)
        imported++
      } else {
        if (price > 0) product.price = String(price)
        if (settlementDate) product.settlementDate = settlementDate
        if (status) product.status = status
        skipped++
      }
      touched.add(customer.id)
      continue
    }

    const payment = createPayment({
      amount: String(paymentAmount),
      soldAt,
      depositorName,
      destinationBank,
      paymentStatus,
      soldByPhone: normalizePhone(getCurrentUser()?.phone || '')
    })

    if (!product) {
      const invoicePrice = price > 0
        ? price
        : (status === 'بیعانه' ? 0 : paymentAmount)
      product = {
        name: productName,
        status,
        price: String(invoicePrice),
        deposit: String(deposit || (status === 'بیعانه' ? paymentAmount : 0)),
        settlementDate,
        priceLocked: invoicePrice > 0,
        payments: [payment]
      }
      ensureProductPayments(product)
      applyProfitSnapshotToProduct(product)
      syncProductStatus(product)
      customer.products.push(product)
      imported++
      touched.add(customer.id)
      continue
    }

    ensureProductPayments(product)
    const dupPay = (product.payments || []).some(p =>
      (parseFloat(p.amount) || 0) === paymentAmount &&
      String(p.soldAt || '').trim() === String(soldAt).trim()
    )
    if (dupPay) { skipped++; continue }

    if (price > 0) product.price = String(price)
    if (settlementDate) product.settlementDate = settlementDate
    if (status) product.status = status
    product.payments.push(payment)
    syncProductStatus(product)
    imported++
    touched.add(customer.id)
  }

  for (const id of touched) {
    const c = data.customers.find(x => x.id === id)
    if (!c) continue
    try {
      syncCustomerLevel(c, data.customers, data.followups)
      await saveCustomerToDB(c)
    } catch (err) {
      console.error('sales import save failed', id, err)
      failed++
    }
  }

  salesImportData.problemExport = problemRows.length
    ? { headers: salesImportData.headers.slice(), rows: problemRows, reasons: problemReasons }
    : null

  await renderCustomers()
  await renderSales()

  const parts = []
  if (imported) parts.push(`${imported} واریز/محصول ایمپورت شد`)
  if (created) parts.push(`${created} مشتری جدید`)
  if (skipped) parts.push(`${skipped} رد/تکراری`)
  if (failed) parts.push(`${failed} خطای ذخیره`)
  if (problemRows.length) parts.push(`${problemRows.length} مشکل‌دار`)
  showToast(parts.length ? parts.join(' — ') : 'هیچ ردیفی ایمپورت نشد')

  renderSalesImportResult({
    imported,
    created,
    skipped,
    failed,
    problemCount: problemRows.length
  })
}

// ============================================
// Historical product-matrix import
// ============================================

const MATRIX_IMPORT_FIELDS = [
  { key: 'name', label: 'نام', aliases: ['نام مشتری'] },
  { key: 'phone', label: 'شماره', aliases: ['شماره مشتری', 'شماره تماس', 'شماره موبایل'] },
  { key: 'platform', label: 'پلتفرم' },
  { key: 'platformId', label: 'ایدی پلتفرم', aliases: ['آیدی پلتفرم', 'id پلتفرم'] }
]

const MATRIX_RESERVED_HEADER_LABELS = [
  'نام', 'نام مشتری', 'شماره', 'شماره مشتری', 'شماره تماس', 'شماره موبایل',
  'کارشناس', 'پلتفرم', 'ایدی پلتفرم', 'آیدی پلتفرم', 'id پلتفرم', 'بدون محصول'
]

function emptyMatrixImportState() {
  return {
    headers: [],
    rows: [],
    mapping: {},
    productCols: [], // [{ index, header }]
    productValueMap: {},
    productPriceMap: {},
    productAutoMap: {},
    uniqueProductHeaders: [],
    refJalali: '',
    dryRun: null,
    problemExport: null,
    running: false
  }
}

let matrixImportData = emptyMatrixImportState()

function matrixReservedHeaderSet() {
  return new Set(MATRIX_RESERVED_HEADER_LABELS.map(normalizeHeaderLabel))
}

function cellMarksOwned(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return false
  const n = toEnDigits(s).replace(/\s/g, '').toLowerCase()
  const fa = s.replace(/\u200c/g, '').trim()
  if (fa === 'بله' || fa === 'بلی' || fa.includes('✅')) return true
  if (n === '1' || n === 'true' || n === 'yes' || n === 'y' || n === 'x' || n === '✓') return true
  return false
}

function collectMatrixProductColumns(headers, mapping) {
  const reserved = matrixReservedHeaderSet()
  const used = new Set(Object.values(mapping).filter(i => i != null))
  const cols = []
  headers.forEach((h, i) => {
    if (used.has(i)) return
    const label = String(h || '').trim()
    if (!label) return
    if (reserved.has(normalizeHeaderLabel(label))) return
    cols.push({ index: i, header: label })
  })
  return cols
}

function defaultMatrixRefJalali() {
  return jalaliAddDays(getTodayJalaliStr(), -365) || '1403/01/01'
}

function readMatrixRefJalali() {
  const el = document.getElementById('matrixImportRefDate')
  const raw = toEnDigits(el?.value || matrixImportData.refJalali || '').trim()
  if (raw && jalaliToNum(raw) !== 99999999) return jalaliDatePart(raw)
  return defaultMatrixRefJalali()
}

function parseMatrixColumnPrice(raw) {
  const n = parseMoney(raw)
  return n > 0 ? Math.round(n) : 0
}

function buildHistoricalSaleLine(productName, soldAtJalali, priceValue = 0) {
  const soldAt = soldAtJalali ? `${soldAtJalali} 00:00` : ''
  const price = parseMatrixColumnPrice(priceValue)
  const product = {
    name: productName,
    status: 'تکمیل',
    price: String(price),
    priceLocked: price > 0,
    historicalImport: true,
    payments: [createPayment({
      amount: '0',
      soldAt,
      depositorName: 'ایمپورت تاریخی',
      destinationBank: '',
      paymentStatus: PAYMENT_STATUS.approved,
      soldByPhone: ''
    })]
  }
  ensureProductPayments(product)
  syncProductStatus(product)
  applyProfitSnapshotToProduct(product)
  return product
}

function customerHasProductLine(customer, productName) {
  const key = String(productName || '').trim().toLowerCase()
  if (!key) return false
  for (const n of getCustomerOwnedProductNames(customer)) {
    if (String(n).trim().toLowerCase() === key) return true
  }
  return (customer?.products || []).some(p => String(coerceProductName(p?.name) || '').trim().toLowerCase() === key)
}

function buildPhoneIndex(customers) {
  const map = new Map()
  for (const c of customers || []) {
    for (const p of getCustomerPhones(c)) {
      const n = normalizePhone(p)
      if (n && !map.has(n)) map.set(n, c)
    }
  }
  return map
}

function resolveMatrixPlatform(raw) {
  const v = String(raw || '').trim()
  if (!v) return ''
  const map = buildPlatformImportMap()
  const key = map[v] || map[v.toLowerCase()] || ''
  if (key) return key
  const platforms = getPlatforms() || []
  const hit = platforms.find(p => p.key === v || normalizeHeaderLabel(p.label) === normalizeHeaderLabel(v))
  return hit ? hit.key : ''
}

function shouldBackdateCreatedAt(customer, refIso) {
  if (!refIso) return false
  const ref = new Date(refIso).getTime()
  if (!Number.isFinite(ref)) return false
  if (!customer?.createdAt) return true
  const cur = new Date(customer.createdAt).getTime()
  return !Number.isFinite(cur) || ref < cur
}

function mergeMatrixFileRows() {
  const mapping = matrixImportData.mapping
  const productCols = matrixImportData.productCols || []
  const productValueMap = matrixImportData.productValueMap || {}
  const merged = new Map()
  const problems = []

  const getCell = (row, fieldKey) => {
    const colIdx = mapping[fieldKey]
    if (colIdx === undefined || colIdx === null) return ''
    const v = row[colIdx]
    if (v == null || v === '') return ''
    return String(v).trim()
  }

  for (const row of matrixImportData.rows) {
    const phoneRaw = toEnDigits(getCell(row, 'phone'))
    const phones = normalizeCustomerPhones(phoneRaw)
    const phone = phones[0] || ''
    if (!phone || !/^09\d{9}$/.test(phone)) {
      problems.push({ row, reason: 'شماره موبایل نامعتبر است' })
      continue
    }

    let rec = merged.get(phone)
    if (!rec) {
      rec = {
        phone,
        name: '',
        platform: '',
        platformId: '',
        products: new Map(),
        unmapped: []
      }
      merged.set(phone, rec)
    }
    const name = getCell(row, 'name')
    if (name && !rec.name) rec.name = name
    const platform = resolveMatrixPlatform(getCell(row, 'platform'))
    if (platform && !rec.platform) rec.platform = platform
    const platformId = getCell(row, 'platformId')
    if (platformId && !rec.platformId) rec.platformId = platformId

    for (const col of productCols) {
      if (!cellMarksOwned(row[col.index])) continue
      const catalogName = productValueMap[col.header]
      if (!catalogName) {
        rec.unmapped.push(col.header)
        continue
      }
      const price = parseMatrixColumnPrice(matrixImportData.productPriceMap?.[col.header])
      const existing = rec.products.get(catalogName) || 0
      rec.products.set(catalogName, Math.max(existing, price))
    }
  }

  return { merged, problems }
}

function previewMatrixImport() {
  const { merged, problems } = mergeMatrixFileRows()
  const data = getData()
  const phoneIndex = buildPhoneIndex(data.customers)
  let created = 0
  let updated = 0
  let productsAdded = 0
  let skippedProducts = 0
  let unmappedMarks = 0

  for (const rec of merged.values()) {
    const existing = phoneIndex.get(rec.phone)
    if (!existing) created++
    else updated++
    unmappedMarks += rec.unmapped.length
    const customer = existing || { products: [] }
    for (const name of rec.products.keys()) {
      if (customerHasProductLine(customer, name)) skippedProducts++
      else productsAdded++
    }
  }

  return {
    uniquePhones: merged.size,
    created,
    updated,
    productsAdded,
    skippedProducts,
    unmappedMarks,
    invalidPhones: problems.length,
    problems,
    merged
  }
}

function renderMatrixImportMapping() {
  const container = document.getElementById('matrixImportMapping')
  if (!container) return
  container.style.display = ''
  document.getElementById('matrixImportDryRunBtn').style.display = ''
  document.getElementById('matrixImportBtn').style.display = ''
  const problemsBtn = document.getElementById('matrixImportProblemsBtn')
  if (problemsBtn) problemsBtn.style.display = 'none'

  const mapping = matrixImportData.mapping
  const fieldSelect = (fieldKey) => {
    const selected = mapping[fieldKey]
    const opts = ['<option value="">— مپ نشده —</option>']
      .concat(matrixImportData.headers.map((h, i) => {
        const sel = selected === i ? ' selected' : ''
        return `<option value="${i}"${sel}>${escapeHtml(h || `(ستون ${i + 1})`)}</option>`
      }))
    return `<select class="form-select" onchange="app.setMatrixImportMapping('${fieldKey}', this.value)">${opts.join('')}</select>`
  }

  const catalog = getProductCatalogNames()

  const productRows = (matrixImportData.productCols || []).map(col => {
    const mapped = matrixImportData.productValueMap[col.header] || ''
    const price = matrixImportData.productPriceMap[col.header] || ''
    const priceDisplay = price ? formatNumber(price) : ''
    const opts = catalog.map(n => {
      const sel = n === mapped ? ' selected' : ''
      return `<option value="${escapeAttr(n)}"${sel}>${escapeHtml(n)}</option>`
    }).join('')
    return `<tr>
      <td>${escapeHtml(col.header)}</td>
      <td><select class="form-select" onchange="app.setMatrixProductValueMap('${escapeAttr(col.header)}', this.value)">
        <option value="">— مپ نشده —</option>${opts}
      </select></td>
      <td><input type="text" class="form-input num-input" value="${escapeAttr(priceDisplay)}" inputmode="numeric" placeholder="مثلاً ۱۰٬۰۰۰٬۰۰۰" oninput="app.formatInput(this);app.setMatrixProductPriceMap('${escapeAttr(col.header)}', this.value)" title="واحد: ریال"></td>
    </tr>`
  }).join('')

  const ref = matrixImportData.refJalali || defaultMatrixRefJalali()
  container.innerHTML = `
    <div style="font-size:13px;color:var(--text-muted);margin-bottom:10px;">
      ستون کارشناس نادیده گرفته می‌شود. مشتری جدید بدون کارشناس ساخته می‌شود.
      پلتفرم و ایدی پلتفرم فقط اگر در فایل مقدار داشته باشند وارد می‌شوند.
      برای هر ستون محصول می‌توانید قیمت کل همان فروش تاریخی را هم وارد کنید.
    </div>
    <div class="form-group">
      <label>تاریخ مرجع LRFM (شروع رابطه)</label>
      <input type="text" class="form-input" id="matrixImportRefDate" value="${escapeAttr(ref)}" placeholder="مثلاً 1403/01/01" data-jdp style="max-width:180px;font-family:'Vazirmatn',sans-serif;">
      <div class="form-hint">برای مشتری جدید و مشتری موجود با created_at جدیدتر از این تاریخ اعمال می‌شود.</div>
    </div>
    <div style="font-weight:600;margin:12px 0 6px;">ستون‌های شناسایی</div>
    <table class="import-map-table" style="width:100%;font-size:13px;">
      <tbody>
        ${MATRIX_IMPORT_FIELDS.map(f => `<tr><td style="width:140px;">${escapeHtml(f.label)}${f.key === 'phone' ? ' *' : ''}</td><td>${fieldSelect(f.key)}</td></tr>`).join('')}
      </tbody>
    </table>
    <div style="font-weight:600;margin:14px 0 6px;">ستون‌های محصول → کاتالوگ</div>
    ${productRows
      ? `<div style="max-height:280px;overflow:auto;border:1px solid var(--border);border-radius:8px;">
          <table class="import-map-table" style="width:100%;font-size:13px;">
            <thead><tr><th>ستون فایل</th><th>محصول سیستم</th><th>قیمت کل</th></tr></thead>
            <tbody>${productRows}</tbody>
          </table>
        </div>`
      : '<div style="font-size:13px;color:var(--text-muted);">ستون محصولی تشخیص داده نشد.</div>'}
  `
  if (window.jalaliDatepicker) {
    try { window.jalaliDatepicker.startWatch({ time: false, zIndex: 11000 }) } catch (_) { /* ignore */ }
  }
}

function refreshMatrixProductMaps() {
  matrixImportData.productCols = collectMatrixProductColumns(
    matrixImportData.headers,
    matrixImportData.mapping
  )
  const headers = matrixImportData.productCols.map(c => c.header)
  matrixImportData.uniqueProductHeaders = headers
  const auto = autoMapValueNames(headers, getProductCatalogNames())
  const next = { ...auto }
  for (const [k, v] of Object.entries(matrixImportData.productValueMap || {})) {
    if (headers.includes(k) && v) next[k] = v
  }
  matrixImportData.productAutoMap = auto
  matrixImportData.productValueMap = next
}

export function setMatrixImportMapping(fieldKey, value) {
  const idx = value === '' ? null : Number(value)
  matrixImportData.mapping[fieldKey] = Number.isFinite(idx) ? idx : null
  refreshMatrixProductMaps()
  renderMatrixImportMapping()
}

export function setMatrixProductValueMap(header, value) {
  if (!value) delete matrixImportData.productValueMap[header]
  else matrixImportData.productValueMap[header] = value
}

export function setMatrixProductPriceMap(header, value) {
  const raw = String(value ?? '').trim()
  if (!raw) {
    delete matrixImportData.productPriceMap[header]
    return
  }
  const price = parseMatrixColumnPrice(raw)
  if (price > 0) matrixImportData.productPriceMap[header] = String(price)
  else delete matrixImportData.productPriceMap[header]
}

export function openMatrixImportModal() {
  if (!requirePermission('matrix_historical_import')) return
  matrixImportData = emptyMatrixImportState()
  matrixImportData.refJalali = defaultMatrixRefJalali()
  const mapping = document.getElementById('matrixImportMapping')
  if (mapping) {
    mapping.style.display = 'none'
    mapping.innerHTML = ''
  }
  const preview = document.getElementById('matrixImportPreview')
  if (preview) preview.textContent = ''
  const file = document.getElementById('matrixImportFileInput')
  if (file) file.value = ''
  const dry = document.getElementById('matrixImportDryRunBtn')
  const btn = document.getElementById('matrixImportBtn')
  const problemsBtn = document.getElementById('matrixImportProblemsBtn')
  if (dry) dry.style.display = 'none'
  if (btn) btn.style.display = 'none'
  if (problemsBtn) problemsBtn.style.display = 'none'
  document.getElementById('matrixImportModal')?.classList.add('active')
}

export function closeMatrixImportModal() {
  document.getElementById('matrixImportModal')?.classList.remove('active')
}

export function initMatrixImportListeners() {
  const input = document.getElementById('matrixImportFileInput')
  if (!input) return
  input.addEventListener('change', function (e) {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const wb = XLSX.read(ev.target.result, { type: 'array' })
        const ws = wb.Sheets[wb.SheetNames[0]]
        const json = XLSX.utils.sheet_to_json(ws, { header: 1 })
        if (json.length < 2) { showToast('فایل خالی است'); return }
        matrixImportData = emptyMatrixImportState()
        matrixImportData.headers = (json[0] || []).map(h => String(h || '').trim())
        matrixImportData.rows = json.slice(1).filter(r => Array.isArray(r) && r.some(c => c != null && String(c).trim() !== ''))
        matrixImportData.mapping = autoMapColumns(matrixImportData.headers, MATRIX_IMPORT_FIELDS)
        matrixImportData.refJalali = defaultMatrixRefJalali()
        refreshMatrixProductMaps()
        renderMatrixImportMapping()
        const preview = document.getElementById('matrixImportPreview')
        if (preview) preview.textContent = `${matrixImportData.rows.length} ردیف خوانده شد — ${matrixImportData.productCols.length} ستون محصول`
      } catch (err) {
        console.error(err)
        showToast('خطا در خواندن فایل')
      }
    }
    reader.readAsArrayBuffer(file)
  })
}

export function dryRunMatrixImport() {
  if (!requirePermission('matrix_historical_import')) return
  if (!isFieldMapped(matrixImportData.mapping, 'phone')) {
    showToast('ستون شماره موبایل را مپ کنید')
    return
  }
  const stats = previewMatrixImport()
  matrixImportData.dryRun = stats
  const preview = document.getElementById('matrixImportPreview')
  if (preview) {
    const totalAmount = Array.from(stats.merged.values()).reduce((sum, rec) => {
      return sum + Array.from(rec.products.values()).reduce((inner, price) => inner + (parseFloat(price) || 0), 0)
    }, 0)
    preview.innerHTML = [
      `<b>پیش‌نمایش:</b> ${stats.uniquePhones} شماره یکتا`,
      `${stats.created} مشتری جدید`,
      `${stats.updated} مشتری موجود`,
      `${stats.productsAdded} محصول اضافه`,
      `${stats.skippedProducts} محصول تکراری`,
      totalAmount > 0 ? `${totalAmount.toLocaleString('en-US')} قیمت کل تاریخی` : '',
      stats.invalidPhones ? `${stats.invalidPhones} شماره نامعتبر` : '',
      stats.unmappedMarks ? `${stats.unmappedMarks} علامت روی محصول مپ‌نشده` : ''
    ].filter(Boolean).join(' — ')
  }
  showToast('پیش‌نمایش آماده است — در دیتابیس تغییری ذخیره نشد')
}

export function downloadMatrixImportProblems() {
  const pack = matrixImportData.problemExport
  if (!pack?.rows?.length) {
    showToast('ردیفی برای دانلود نیست')
    return
  }
  const headers = [...pack.headers, 'علت رد']
  const rows = pack.rows.map((r, i) => [...padImportRow(r, pack.headers.length), pack.reasons[i] || ''])
  const ws = sheetFromAoa(headers, rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'ردیف‌های مشکل‌دار')
  XLSX.writeFile(wb, `ماتریس_تاریخی_مشکل‌دار_${new Date().toISOString().slice(0, 10)}.xlsx`)
  showToast(`${rows.length} ردیف مشکل‌دار دانلود شد`)
}

export async function doMatrixImport() {
  if (!requirePermission('matrix_historical_import')) return
  if (matrixImportData.running) return
  if (!isFieldMapped(matrixImportData.mapping, 'phone')) {
    showToast('ستون شماره موبایل را مپ کنید')
    return
  }
  if (!getProductCatalogNames().length) {
    showToast('کاتالوگ محصولات خالی است — از تنظیمات اضافه کنید')
    return
  }

  const refJalali = readMatrixRefJalali()
  const refIso = jalaliDateTimeToIso(refJalali, '00:00')
  if (!refIso) {
    showToast('تاریخ مرجع LRFM نامعتبر است')
    return
  }

  matrixImportData.running = true
  const previewEl = document.getElementById('matrixImportPreview')
  const setProgress = (msg) => { if (previewEl) previewEl.textContent = msg }

  try {
    const { merged, problems } = mergeMatrixFileRows()
    const data = getData()
    const phoneIndex = buildPhoneIndex(data.customers)
    const toCreate = []
    const toUpdate = []
    const extraProblems = [...problems]

    for (const rec of merged.values()) {
      if (rec.unmapped.length) {
        extraProblems.push({
          row: [rec.phone, rec.name, rec.unmapped.join('، ')],
          reason: `محصول مپ نشده: ${rec.unmapped.join('، ')}`
        })
      }
      let customer = phoneIndex.get(rec.phone)
      let isNew = false
      let dirty = false
      if (!customer) {
        isNew = true
        dirty = true
        customer = {
          id: '',
          platformId: rec.platformId || '',
          platform: rec.platform || '',
          name: rec.name || '',
          phone: rec.phone,
          phones: [rec.phone],
          status: rec.products.size ? 'purchased' : 'new',
          notes: 'ایجاد شده از ایمپورت تاریخی ماتریس',
          advisor: '',
          advisorPhone: '',
          nextFollowupDate: '',
          products: [],
          createdAt: refIso,
          customerLevel: '',
          customerLevelLocked: false,
          referredByPhone: '',
          customerCode: ''
        }
      } else {
        if (!customer.name && rec.name) { customer.name = rec.name; dirty = true }
        if (!customer.platformId && rec.platformId) { customer.platformId = rec.platformId; dirty = true }
        if (!customer.platform && rec.platform) { customer.platform = rec.platform; dirty = true }
        if (!Array.isArray(customer.products)) customer.products = []
      }

      let added = 0
      for (const [name, price] of rec.products.entries()) {
        if (customerHasProductLine(customer, name)) continue
        customer.products.push(buildHistoricalSaleLine(name, refJalali, price))
        added++
        dirty = true
      }
      if (added && customer.status !== 'purchased' && rec.products.size) {
        customer.status = 'purchased'
      }

      const backdate = shouldBackdateCreatedAt(customer, refIso)
      if (backdate) {
        customer.createdAt = refIso
        dirty = true
      }

      if (!dirty) continue
      if (isNew) toCreate.push(customer)
      else toUpdate.push({ customer, backdate })
    }

    setProgress(`در حال ساخت شناسه برای ${toCreate.length} مشتری جدید...`)
    const ids = await generateIdBatch('CS', toCreate.length)
    toCreate.forEach((c, i) => { c.id = ids[i] })

    const touched = [...toCreate, ...toUpdate.map(x => x.customer)]
    const BATCH = 40
    let saved = 0
    let failed = 0
    for (let i = 0; i < touched.length; i += BATCH) {
      const chunk = touched.slice(i, i + BATCH)
      await Promise.all(chunk.map(async (c) => {
        try {
          if (!c.customerLevelLocked) {
            syncCustomerLevel(c, data.customers, data.followups)
          }
          await saveCustomerToDB(c, {
            createdAt: c.createdAt || refIso,
            updateCreatedAt: true,
            allowEmptyPlatform: true
          })
          putCustomerInCache(c)
          saved++
        } catch (err) {
          console.error('matrix import save failed', c.id, err)
          failed++
          extraProblems.push({ row: [c.phone, c.name, c.id], reason: err?.message || 'خطای ذخیره' })
        }
      }))
      setProgress(`ذخیره ${Math.min(i + BATCH, touched.length)} از ${touched.length} مشتری...`)
    }

    const problemPackRows = extraProblems.map(p => {
      if (Array.isArray(p.row) && p.row.length && typeof p.row[0] !== 'object') {
        return padImportRow(p.row, Math.max(matrixImportData.headers.length, p.row.length))
      }
      return padImportRow(p.row, matrixImportData.headers.length)
    })
    matrixImportData.problemExport = extraProblems.length
      ? {
          headers: [...matrixImportData.headers],
          rows: extraProblems.map((p, i) => {
            if (Array.isArray(p.row) && p.row.length === matrixImportData.headers.length) return p.row
            return problemPackRows[i]
          }),
          reasons: extraProblems.map(p => p.reason || '')
        }
      : null

    const problemsBtn = document.getElementById('matrixImportProblemsBtn')
    if (problemsBtn) problemsBtn.style.display = extraProblems.length ? '' : 'none'

    try { await renderCustomers() } catch (_) {}
    try { await renderProductMatrix() } catch (_) {}
    try { await renderSales() } catch (_) {}

    const parts = []
    if (toCreate.length) parts.push(`${toCreate.length} مشتری جدید`)
    if (toUpdate.length) parts.push(`${toUpdate.length} مشتری به‌روزرسانی`)
    if (saved) parts.push(`${saved} ذخیره`)
    if (failed) parts.push(`${failed} خطا`)
    if (extraProblems.length) parts.push(`${extraProblems.length} ردیف مشکل‌دار`)
    setProgress(parts.join(' — ') || 'ایمپورت انجام شد')
    showToast(parts.length ? parts.join(' — ') : 'هیچ ردیفی ایمپورت نشد')
  } finally {
    matrixImportData.running = false
  }
}

