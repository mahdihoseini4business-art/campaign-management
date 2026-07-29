import { getData, saveCustomerToDB, generateId } from './data.js'
import {
  toEnDigits, showToast, getCurrentUser, resolveAdvisor, getPlatformLabels, buildPlatformImportMap, getStatusLabels,
  requirePermission, ensureProductPayments, syncProductStatus, getApprovedPaid,
  getProductBalance, getProductPayments, getPaymentEntryStatus,
  PAYMENT_STATUS, PAYMENT_STATUS_LABELS, createPayment, formatSoldAt24h, normalizePhone,
  formatCustomerLevel, parseCustomerLevel, syncCustomerLevel,
  normalizeCustomerPhones, getCustomerPhones, findCustomerByPhone
} from './utils.js'
import { getUsersSafe } from './auth.js'
import { renderCustomers, getFilteredCustomers } from './customers.js'
import { getFilteredFollowups } from './followups.js'
import { renderSales, getFilteredSales } from './sales.js'

// ============================================
// Helpers
// ============================================


function autoMapColumns(headers, fields) {
  const mapping = {}
  const headerNorm = headers.map(h => String(h || '').trim())
  const used = new Set()

  fields.forEach(f => {
    const labels = [f.label, ...(f.aliases || [])].filter(Boolean)
    let idx = -1
    for (const label of labels) {
      idx = headerNorm.findIndex((h, i) => !used.has(i) && h === label)
      if (idx !== -1) break
    }
    if (idx === -1) {
      for (const label of labels) {
        idx = headerNorm.findIndex((h, i) =>
          !used.has(i) && (h.includes(label) || label.includes(h))
        )
        if (idx !== -1) break
      }
    }
    if (idx !== -1) {
      mapping[f.key] = idx
      used.add(idx)
    }
  })
  return mapping
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
        const pays = getProductPayments(p).filter(pay => (parseFloat(pay.amount) || 0) > 0)
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
            getApprovedPaid(p) || '',
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
  { key: 'platformId', label: 'ایدی پلتفرم' },
  { key: 'platform', label: 'پلتفرم' },
  { key: 'name', label: 'نام' },
  { key: 'phone', label: 'شماره تماس', aliases: ['شماره', 'شماره موبایل', 'شماره ۱', 'شماره 1'] },
  { key: 'phone2', label: 'شماره تماس ۲', aliases: ['شماره ۲', 'شماره 2', 'موبایل ۲'] },
  { key: 'phone3', label: 'شماره تماس ۳', aliases: ['شماره ۳', 'شماره 3', 'موبایل ۳'] },
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

let importData = { headers: [], rows: [], mapping: {} }

export function openImportModal() {
  if (!requirePermission('customers_import')) return
  importData = { headers: [], rows: [], mapping: {} }
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

  container.innerHTML = importData.headers.map((h, i) => {
    const selected = importData.mapping[Object.keys(importData.mapping).find(k => importData.mapping[k] === i)] || ''
    return `
      <div class="import-map-row">
        <span class="excel-col" title="${h}">${h || '(خالی)'}</span>
        <span class="arrow">←</span>
        <select onchange="app.setImportMapping(${i}, this.value)">
          <option value="">— نادیده گرفتن —</option>
          ${IMPORT_FIELDS.map(f => `<option value="${f.key}" ${selected === f.key ? 'selected' : ''}>${f.label}</option>`).join('')}
        </select>
      </div>
    `
  }).join('')
}

export function setImportMapping(colIndex, fieldKey) {
  Object.keys(importData.mapping).forEach(k => {
    if (importData.mapping[k] === colIndex) delete importData.mapping[k]
  })
  if (fieldKey) {
    Object.keys(importData.mapping).forEach(k => {
      if (k === fieldKey) delete importData.mapping[k]
    })
    importData.mapping[fieldKey] = colIndex
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

  let imported = 0, skipped = 0
  const newCustomers = []
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
    let platformId = getValue('platformId')
    if (!platformId && primaryPhone) {
      const cleanPhone = primaryPhone.replace(/^0/, '+98')
      platformId = `telegram.me/${cleanPhone}`
    } else if (!platformId) {
      platformId = `auto_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    }

    const platformRaw = getValue('platform').toLowerCase()
    const platform = buildPlatformImportMap()[platformRaw] || platformRaw || 'instagram'
    const statusRaw = getValue('status')
    const status = STATUS_MAP_IMPORT[statusRaw] || statusRaw || 'new'

    const existById = importId && data.customers.find(c => c.id === importId)
    const existByPlatform = data.customers.find(c =>
      (c.platformId || '').toLowerCase() === platformId.toLowerCase()
    )
    const existByPhone = phones.some(p => findCustomerByPhone(p, data.customers))

    if (existById || existByPlatform || existByPhone) { skipped++; continue }

    const type = phones.length ? 'CS' : 'LD'
    const currentUser = getCurrentUser()
    const advisorRaw = getValue('advisor') || (currentUser ? (currentUser.phone || currentUser.displayName) : '')
    const { advisor, advisorPhone } = resolveAdvisor(advisorRaw, users)
    const levelRaw = getValue('customerLevel')
    const level = parseCustomerLevel(levelRaw)
    const referredByPhone = normalizePhone(getValue('referredByPhone'))

    const newCustomer = {
      id: await generateId(type),
      platformId,
      platform,
      name: getValue('name'),
      phone: primaryPhone,
      phones,
      status,
      notes: getValue('notes'),
      nextFollowupDate: getValue('nextFollowupDate') || '',
      advisor,
      advisorPhone,
      products: [],
      createdAt: new Date().toISOString(),
      referredByPhone: referredByPhone || '',
      customerLevel: level || '',
      customerLevelLocked: !!level
    }
    if (!level) {
      syncCustomerLevel(newCustomer, data.customers, data.followups)
    }
    data.customers.push(newCustomer)
    newCustomers.push(newCustomer)
    imported++
  }

  for (const c of newCustomers) {
    await saveCustomerToDB(c)
  }

  // Recompute unlocked levels (CIP may unlock after referrals imported)
  for (const c of data.customers) {
    if (c.customerLevelLocked) continue
    const before = c.customerLevel || ''
    syncCustomerLevel(c, data.customers, data.followups)
    if ((c.customerLevel || '') !== before) {
      await saveCustomerToDB(c)
    }
  }

  closeImportModal()
  await renderCustomers()
  showToast(`${imported} مشتری ایمپورت شد${skipped > 0 ? ` — ${skipped} ردیف رد شد` : ''}`)
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

let salesImportData = { headers: [], rows: [], mapping: {} }

export function openSalesImportModal() {
  if (!requirePermission('sales_import')) return
  salesImportData = { headers: [], rows: [], mapping: {} }
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

  container.innerHTML = salesImportData.headers.map((h, i) => {
    const selected = salesImportData.mapping[Object.keys(salesImportData.mapping).find(k => salesImportData.mapping[k] === i)] || ''
    return `
      <div class="import-map-row">
        <span class="excel-col" title="${h}">${h || '(خالی)'}</span>
        <span class="arrow">←</span>
        <select onchange="app.setSalesImportMapping(${i}, this.value)">
          <option value="">— نادیده گرفتن —</option>
          ${SALES_IMPORT_FIELDS.map(f => `<option value="${f.key}" ${selected === f.key ? 'selected' : ''}>${f.label}${f.required ? ' *' : ''}</option>`).join('')}
        </select>
      </div>
    `
  }).join('')
}

export function setSalesImportMapping(colIndex, fieldKey) {
  Object.keys(salesImportData.mapping).forEach(k => {
    if (salesImportData.mapping[k] === colIndex) delete salesImportData.mapping[k]
  })
  if (fieldKey) {
    Object.keys(salesImportData.mapping).forEach(k => {
      if (k === fieldKey) delete salesImportData.mapping[k]
    })
    salesImportData.mapping[fieldKey] = colIndex
  }
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
