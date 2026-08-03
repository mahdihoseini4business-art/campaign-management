import { getData, saveCustomerToDB, generateId } from './data.js'
import {
  toEnDigits, showToast, getCurrentUser, resolveAdvisor, getPlatformLabels, buildPlatformImportMap, getStatusLabels,
  requirePermission, ensureProductPayments, syncProductStatus, getApprovedPaid,
  getProductBalance, getProductPayments, getPaymentEntryStatus,
  PAYMENT_STATUS, PAYMENT_STATUS_LABELS, createPayment, formatSoldAt24h, normalizePhone,
  formatCustomerLevel, parseCustomerLevel, syncCustomerLevel,
  normalizeCustomerPhones, getCustomerPhones, findCustomerByPhone,
  jalaliDatePart, jalaliToNum, escapeHtml, escapeAttr
} from './utils.js'
import { getUsersSafe } from './auth.js'
import { renderCustomers, getFilteredCustomers } from './customers.js'
import { getFilteredFollowups } from './followups.js'
import { renderSales, getFilteredSales, getSalesDateFilter } from './sales.js'

// ============================================
// Helpers
// ============================================


/** Export-only / computed columns — never auto-map these headers */
const AUTO_MAP_IGNORE_HEADERS = new Set([
  'تعداد پیگیری', 'آخرین پیگیری', 'مانده'
])

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
 * Pass 2: safe contains only when label length ≥ 3 and header isn't ignored.
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

function renderFieldMappingRows({ fields, headers, mapping, autoMapping = {}, onChangeFn }) {
  const mappedCount = Object.keys(mapping).length
  const autoCount = Object.keys(autoMapping).length
  const unusedHeaders = headers
    .map((h, i) => ({ h, i }))
    .filter(({ i }) => !Object.values(mapping).includes(i))
    .map(({ h }) => h || '(خالی)')

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
  if (unusedHeaders.length) {
    unusedBlock = `
      <details class="import-unused">
        <summary>${unusedHeaders.length} ستون اکسل استفاده نشده (نادیده گرفته می‌شوند)</summary>
        <div class="import-unused-list">${unusedHeaders.map(h => `<span>${escapeHtml(h)}</span>`).join('')}</div>
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

const PAYMENT_STATUS_IMPORT = {
  'در انتظار تأیید': PAYMENT_STATUS.pending,
  'در انتظار تایید': PAYMENT_STATUS.pending,
  pending: PAYMENT_STATUS.pending,
  'تأیید شده': PAYMENT_STATUS.approved,
  'تایید شده': PAYMENT_STATUS.approved,
  approved: PAYMENT_STATUS.approved,
  'رد شده': PAYMENT_STATUS.rejected,
  rejected: PAYMENT_STATUS.rejected
}

// ============================================
// Export
// ============================================

const EXPORT_CONFIG = {
  customers: {
    label: 'مشتریان',
    headers: [
      'شناسه', 'ایدی پلتفرم', 'پلتفرم', 'نام', 'شماره', 'شماره ۲', 'شماره ۳', 'وضعیت', 'سطح مشتری', 'کارشناس',
      'تعداد پیگیری', 'آخرین پیگیری', 'پیگیری بعدی', 'توضیحات'
    ],
    getRows: () => {
      const data = getData()
      return getFilteredCustomers().map(c => {
        const customerFollowups = data.followups.filter(f => f.customerId === c.id)
        const lastDate = customerFollowups.length
          ? customerFollowups[customerFollowups.length - 1].date
          : ''
        const lastNote = customerFollowups.length
          ? (customerFollowups[customerFollowups.length - 1].notes || '')
          : ''
        const notes = lastNote || c.notes || ''
        const level = c.customerLevelLocked
          ? (c.customerLevel || '')
          : syncCustomerLevel(c, data.customers, data.followups)
        const phones = getCustomerPhones(c)
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
          c.advisor || '',
          customerFollowups.length,
          lastDate,
          c.nextFollowupDate || '',
          notes
        ]
      })
    }
  },
  followups: {
    label: 'پیگیری‌ها',
    headers: ['شناسه مشتری', 'نام مشتری', 'تاریخ', 'نوع', 'نتیجه', 'پیگیری بعدی', 'توضیحات'],
    getRows: () => {
      const data = getData()
      return getFilteredFollowups().map(f => {
        const c = data.customers.find(x => x.id === f.customerId)
        return [
          f.customerId,
          c ? (c.name || '') : '',
          f.date || '',
          f.type || '',
          f.result || '',
          f.nextDate || '',
          f.notes || ''
        ]
      })
    }
  },
  sales: {
    label: 'فروش‌ها',
    headers: [
      'شناسه مشتری', 'نام مشتری', 'شماره موبایل', 'پلتفرم', 'محصول', 'وضعیت',
      'مبلغ کل', 'پرداخت‌شده', 'مانده', 'تاریخ تسویه', 'کارشناس',
      'مبلغ واریز', 'تاریخ واریز', 'نام واریزکننده', 'بانک مقصد', 'وضعیت واریزی'
    ],
    getRows: () => {
      const data = getData()
      const rows = []
      getFilteredSales().forEach(s => {
        const c = data.customers.find(x => x.id === s.customerId)
        const p = c?.products?.[s.productIndex]
        if (!c || !p) {
          rows.push([
            s.customerId, s.customerName, s.customerPhone,
            getPlatformLabels()[s.platform] || s.platform || '',
            s.productName, s.status, s.price || '', s.deposit || '', s.balance || '',
            s.settlementDate || '', s.advisor || '',
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
        const phoneStr = getCustomerPhones(c).join(' / ') || ''
        const platformLabel = getPlatformLabels()[c.platform] || c.platform || ''
        if (pays.length === 0) {
          rows.push([
            c.id,
            c.name || c.platformId || '',
            phoneStr,
            platformLabel,
            p.name || '',
            p.status || '',
            price || '',
            dateFilter.hasDateFilter ? (s.deposit || '') : (getApprovedPaid(p) || ''),
            getProductBalance(p) || '',
            p.settlementDate || '',
            c.advisor || '',
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
            p.name || '',
            p.status || '',
            price || '',
            paidSoFar || '',
            balance || '',
            p.settlementDate || '',
            c.advisor || '',
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
  }
}

export function exportTabCSV(tab) {
  const exportPerm = { customers: 'customers_export', followups: 'followups_export', sales: 'sales_export' }[tab]
  if (exportPerm && !requirePermission(exportPerm)) return
  const cfg = EXPORT_CONFIG[tab]
  if (!cfg) return

  const rows = cfg.getRows()
  const csvContent = '\uFEFF' + [cfg.headers, ...rows]
    .map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n')

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `${cfg.label}_${new Date().toISOString().slice(0, 10)}.csv`
  link.click()
  showToast(`${rows.length} ردیف در CSV ذخیره شد`)
}

export function exportTabXLSX(tab) {
  const exportPerm = { customers: 'customers_export', followups: 'followups_export', sales: 'sales_export' }[tab]
  if (exportPerm && !requirePermission(exportPerm)) return
  const cfg = EXPORT_CONFIG[tab]
  if (!cfg) return

  const rows = cfg.getRows()
  const ws = XLSX.utils.aoa_to_sheet([cfg.headers, ...rows])

  const colWidths = cfg.headers.map((h, i) => {
    const maxLen = Math.max(h.length, ...rows.map(r => String(r[i] ?? '').length))
    return { wch: Math.min(Math.max(maxLen + 2, 10), 40) }
  })
  ws['!cols'] = colWidths

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, cfg.label)
  XLSX.writeFile(wb, `${cfg.label}_${new Date().toISOString().slice(0, 10)}.xlsx`)
  showToast(`${rows.length} ردیف در Excel ذخیره شد`)
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

let importData = { headers: [], rows: [], mapping: {}, autoMapping: {} }

export function openImportModal() {
  if (!requirePermission('customers_import')) return
  importData = { headers: [], rows: [], mapping: {}, autoMapping: {} }
  document.getElementById('importStep1').style.display = ''
  document.getElementById('importStep2').style.display = 'none'
  document.getElementById('importBtn').style.display = 'none'
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
        const ws = wb.Sheets[wb.SheetNames[0]]
        const json = XLSX.utils.sheet_to_json(ws, { header: 1 })

        if (json.length < 2) { showToast('فایل خالی است'); return }

        importData.headers = json[0].map(h => String(h || '').trim())
        importData.rows = json.slice(1).filter(r => r.some(c => c != null && String(c).trim() !== ''))
        importData.mapping = autoMapColumns(importData.headers, IMPORT_FIELDS)
        importData.autoMapping = { ...importData.mapping }

        renderImportMapping()
      } catch (err) {
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
  document.getElementById('importPreview').textContent = `${importData.rows.length} ردیف داده یافت شد`

  container.innerHTML = renderFieldMappingRows({
    fields: IMPORT_FIELDS,
    headers: importData.headers,
    mapping: importData.mapping,
    autoMapping: importData.autoMapping,
    onChangeFn: 'setImportMapping'
  })
}

/** fieldKey → excel column index (or clear) */
export function setImportMapping(fieldKey, colRaw) {
  setFieldColumnMapping(importData, fieldKey, colRaw)
  renderImportMapping()
}

function isFieldMapped(mapping, fieldKey) {
  return mapping[fieldKey] !== undefined && mapping[fieldKey] !== null
}

function applyMappedCustomerFields(customer, { mapping, getValue, users, phones, primaryPhone, platformId, platform, status, isCreate }) {
  const currentUser = getCurrentUser()

  if (isFieldMapped(mapping, 'platformId') || isCreate) {
    customer.platformId = platformId
  }
  if (isFieldMapped(mapping, 'platform') || isCreate) {
    customer.platform = platform || customer.platform || 'instagram'
  }
  if (isFieldMapped(mapping, 'name') || isCreate) {
    customer.name = getValue('name')
  }
  if (isFieldMapped(mapping, 'phone') || isFieldMapped(mapping, 'phone2') || isFieldMapped(mapping, 'phone3') || isCreate) {
    // Don't wipe existing phones when Excel cells failed to parse
    if (phones.length || isCreate) {
      customer.phones = phones
      customer.phone = primaryPhone
    }
  }
  if (isFieldMapped(mapping, 'status') || isCreate) {
    customer.status = status || customer.status || 'new'
  }
  if (isFieldMapped(mapping, 'notes') || isCreate) {
    customer.notes = getValue('notes')
  }
  if (isFieldMapped(mapping, 'nextFollowupDate') || isCreate) {
    customer.nextFollowupDate = getValue('nextFollowupDate') || ''
  }
  if (isFieldMapped(mapping, 'advisor') || isCreate) {
    const advisorRaw = getValue('advisor') || (isCreate && currentUser
      ? (currentUser.phone || currentUser.displayName)
      : (customer.advisor || ''))
    if (advisorRaw || isCreate) {
      const resolved = resolveAdvisor(advisorRaw, users)
      customer.advisor = resolved.advisor
      customer.advisorPhone = resolved.advisorPhone
    }
  }
  if (isFieldMapped(mapping, 'referredByPhone')) {
    customer.referredByPhone = normalizePhone(getValue('referredByPhone')) || ''
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
}

export async function doImport() {
  if (!requirePermission('customers_import')) return
  const data = getData()
  const mapping = importData.mapping
  if (Object.keys(mapping).length === 0) {
    showToast('حداقل یک ستون را نقشه\u200cبرداری کنید')
    return
  }

  let created = 0, updated = 0, skipped = 0, failed = 0
  const users = await getUsersSafe()

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
    const status = STATUS_MAP_IMPORT[statusRaw] || statusRaw || 'new'

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
        data.customers.push(newCustomer)
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

  closeImportModal()
  await renderCustomers()

  const parts = []
  if (created) parts.push(`${created} ایجاد`)
  if (updated) parts.push(`${updated} به‌روزرسانی`)
  if (skipped) parts.push(`${skipped} رد شده`)
  if (failed) parts.push(`${failed} خطا`)
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
  { key: 'productName', label: 'محصول' },
  { key: 'status', label: 'وضعیت' },
  { key: 'price', label: 'مبلغ کل', aliases: ['قیمت کل'] },
  { key: 'deposit', label: 'پرداخت‌شده', aliases: ['بیعانه'] },
  { key: 'settlementDate', label: 'تاریخ تسویه' },
  { key: 'advisor', label: 'کارشناس' },
  { key: 'paymentAmount', label: 'مبلغ واریز' },
  { key: 'soldAt', label: 'تاریخ واریز', aliases: ['تاریخ و ساعت'] },
  { key: 'depositorName', label: 'نام واریزکننده' },
  { key: 'destinationBank', label: 'بانک مقصد' },
  { key: 'paymentStatus', label: 'وضعیت واریزی' },
]

const SALES_STATUS_MAP = {
  'تکمیل': 'تکمیل', complet: 'تکمیل', completed: 'تکمیل',
  'بیعانه': 'بیعانه', deposit: 'بیعانه', partial: 'بیعانه',
}

let salesImportData = { headers: [], rows: [], mapping: {}, autoMapping: {} }

export function openSalesImportModal() {
  if (!requirePermission('sales_import')) return
  salesImportData = { headers: [], rows: [], mapping: {}, autoMapping: {} }
  document.getElementById('salesImportMapping').style.display = 'none'
  document.getElementById('salesImportMapping').innerHTML = ''
  document.getElementById('salesImportBtn').style.display = 'none'
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
    reader.onload = function (ev) {
      try {
        const wb = XLSX.read(ev.target.result, { type: 'array' })
        const ws = wb.Sheets[wb.SheetNames[0]]
        const json = XLSX.utils.sheet_to_json(ws, { header: 1 })

        if (json.length < 2) { showToast('فایل خالی است'); return }

        salesImportData.headers = json[0].map(h => String(h || '').trim())
        salesImportData.rows = json.slice(1).filter(r => r.some(c => c != null && String(c).trim() !== ''))
        salesImportData.mapping = autoMapColumns(salesImportData.headers, SALES_IMPORT_FIELDS)
        salesImportData.autoMapping = { ...salesImportData.mapping }

        renderSalesImportMapping()
      } catch (err) {
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
  document.getElementById('salesImportPreview').textContent = `${salesImportData.rows.length} ردیف داده یافت شد`

  container.innerHTML = renderFieldMappingRows({
    fields: SALES_IMPORT_FIELDS,
    headers: salesImportData.headers,
    mapping: salesImportData.mapping,
    autoMapping: salesImportData.autoMapping,
    onChangeFn: 'setSalesImportMapping'
  })
}

/** fieldKey → excel column index (or clear) */
export function setSalesImportMapping(fieldKey, colRaw) {
  setFieldColumnMapping(salesImportData, fieldKey, colRaw)
  renderSalesImportMapping()
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

  let imported = 0, skipped = 0, created = 0
  const users = await getUsersSafe()
  const touched = new Set()

  for (const row of salesImportData.rows) {
    const getValue = (fieldKey) => {
      const colIdx = mapping[fieldKey]
      if (colIdx === undefined || colIdx === null) return ''
      return String(row[colIdx] || '').trim()
    }

    const phone = toEnDigits(getValue('phone'))
    const customerId = getValue('customerId')
    const productName = getValue('productName')
    if (!productName) { skipped++; continue }
    if (!phone && !customerId) { skipped++; continue }

    let customer = null
    if (customerId) customer = data.customers.find(c => c.id === customerId)
    if (!customer && phone) {
      customer = findCustomerByPhone(phone, data.customers)
    }

    if (!customer) {
      if (!phone) { skipped++; continue }
      const name = getValue('customerName') || ''
      const id = await generateId('CS')
      const currentUser = getCurrentUser()
      const advisorRaw = getValue('advisor') || (currentUser ? (currentUser.phone || currentUser.displayName) : '')
      const { advisor, advisorPhone } = resolveAdvisor(advisorRaw, users)
      const platformRaw = getValue('platform').toLowerCase()
      const platform = buildPlatformImportMap()[platformRaw] || platformRaw || 'instagram'
      const phones = normalizeCustomerPhones([phone])
      customer = {
        id,
        platformId: '',
        platform,
        name,
        phone: phones[0] || '',
        phones,
        status: 'new',
        notes: 'خودکار ایجاد شده از ایمپورت فروش',
        advisor,
        advisorPhone,
        nextFollowupDate: '',
        products: [],
        createdAt: new Date().toISOString(),
        customerLevel: '',
        customerLevelLocked: false,
        referredByPhone: ''
      }
      data.customers.push(customer)
      created++
    }

    const statusRaw = getValue('status')
    const status = SALES_STATUS_MAP[statusRaw] || statusRaw || 'تکمیل'
    const price = parseMoney(getValue('price'))
    const deposit = parseMoney(getValue('deposit'))
    const settlementDate = getValue('settlementDate')
    const soldAt = getValue('soldAt') || settlementDate || ''
    const depositorName = getValue('depositorName')
    const destinationBank = getValue('destinationBank')
    const paymentStatusRaw = getValue('paymentStatus')
    const paymentStatus = PAYMENT_STATUS_IMPORT[paymentStatusRaw]
      || PAYMENT_STATUS_IMPORT[paymentStatusRaw.toLowerCase()]
      || PAYMENT_STATUS.pending
    let paymentAmount = parseMoney(getValue('paymentAmount'))
    if (!paymentAmount) {
      paymentAmount = status === 'بیعانه' ? (deposit || price) : (price || deposit)
    }
    if (!paymentAmount) { skipped++; continue }

    if (!Array.isArray(customer.products)) customer.products = []

    let product = customer.products.find(p =>
      p.name === productName && (price <= 0 || (parseFloat(p.price) || 0) === price)
    )

    const payment = createPayment({
      amount: String(paymentAmount),
      soldAt,
      depositorName,
      destinationBank,
      paymentStatus,
      soldByPhone: normalizePhone(getCurrentUser()?.phone || '')
    })

    if (!product) {
      product = {
        name: productName,
        status,
        price: String(price || paymentAmount),
        deposit: String(deposit || 0),
        settlementDate,
        priceLocked: price > 0,
        payments: [payment]
      }
      ensureProductPayments(product)
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
    syncCustomerLevel(c, data.customers, data.followups)
    await saveCustomerToDB(c)
  }

  closeSalesImportModal()
  await renderCustomers()
  await renderSales()
  let msg = `${imported} واریز/محصول ایمپورت شد`
  if (created > 0) msg += ` — ${created} مشتری جدید ایجاد شد`
  if (skipped > 0) msg += ` — ${skipped} ردیف رد شد`
  showToast(msg)
}
