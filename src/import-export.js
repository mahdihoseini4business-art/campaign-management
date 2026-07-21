import { getData, saveCustomerToDB, generateId } from './data.js'
import { toEnDigits, showToast, getCurrentUser } from './utils.js'

// ============================================
// Export
// ============================================

const EXPORT_CONFIG = {
  customers: {
    label: 'مشتریان',
    headers: ['شناسه', 'ایدی پلتفرم', 'پلتفرم', 'نام', 'شماره', 'وضعیت', 'کارشناس', 'پیگیری بعدی', 'توضیحات'],
    getRows: () => {
      const data = getData()
      const statusMap = { new: 'جدید', contacted: 'تماس گرفته', chatting: 'در حال چت', interested: 'علاقه‌مند', sent: 'اطلاعات ارسال', followup_done: 'تکمیل پیگیری', converting: 'در حال تبدیل', purchased: 'خرید کرد', cancelled: 'منصرف شده' }
      const platformMap = { instagram: 'اینستاگرام', telegram: 'تلگرام', whatsapp: 'واتساپ' }
      return data.customers.map(c => [
        c.id, c.platformId || '', platformMap[c.platform] || c.platform, c.name, c.phone, statusMap[c.status] || c.status, c.advisor || '', c.nextFollowupDate || '', c.notes
      ])
    }
  },
  followups: {
    label: 'پیگیری‌ها',
    headers: ['شناسه مشتری', 'نام مشتری', 'تاریخ', 'نوع', 'نتیجه', 'پیگیری بعدی', 'توضیحات'],
    getRows: () => {
      const data = getData()
      return data.followups.map(f => {
        const c = data.customers.find(x => x.id === f.customerId)
        return [f.customerId, c ? c.name : '', f.date, f.type, f.result, f.nextDate, f.notes]
      })
    }
  },
  sales: {
    label: 'فروش‌ها',
    headers: ['شناسه مشتری', 'نام مشتری', 'شماره موبایل', 'پلتفرم', 'محصول', 'وضعیت', 'مبلغ کل', 'بیعانه', 'مانده', 'تاریخ تسویه', 'کارشناس'],
    getRows: () => {
      const data = getData()
      const platformMap = { instagram: 'اینستاگرام', telegram: 'تلگرام', whatsapp: 'واتساپ' }
      // Import getAllSales inline to avoid circular dependency
      const sales = []
      data.customers.forEach(c => {
        if (c.products) {
          c.products.forEach(p => {
            const price = parseFloat(p.price) || 0
            const deposit = parseFloat(p.deposit) || 0
            sales.push({
              customerId: c.id, customerName: c.name || c.platformId, customerPhone: c.phone || '',
              platform: c.platform, productName: p.name, status: p.status, price, deposit,
              balance: price - deposit, settlementDate: p.settlementDate || ''
            })
          })
        }
      })
      return sales.map(s => {
        const cust = data.customers.find(c => c.id === s.customerId)
        return [
          s.customerId, s.customerName, s.customerPhone, platformMap[s.platform] || s.platform,
          s.productName, s.status, s.price || '', s.deposit || '', s.balance || '', s.settlementDate || '', cust ? (cust.advisor || '') : ''
        ]
      })
    }
  }
}

export function exportTabCSV(tab) {
  const cfg = EXPORT_CONFIG[tab]
  if (!cfg) return

  const csvContent = '\uFEFF' + [cfg.headers, ...cfg.getRows()]
    .map(r => r.map(c => `"${String(c || '').replace(/"/g, '""')}"`).join(','))
    .join('\n')

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `${cfg.label}_${new Date().toISOString().slice(0, 10)}.csv`
  link.click()
  showToast(`فایل CSV دانلود شد`)
}

export function exportTabXLSX(tab) {
  const cfg = EXPORT_CONFIG[tab]
  if (!cfg) return

  const ws = XLSX.utils.aoa_to_sheet([cfg.headers, ...cfg.getRows()])

  const colWidths = cfg.headers.map((h, i) => {
    const maxLen = Math.max(h.length, ...cfg.getRows().map(r => String(r[i] || '').length))
    return { wch: Math.min(Math.max(maxLen + 2, 10), 30) }
  })
  ws['!cols'] = colWidths

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, cfg.label)
  XLSX.writeFile(wb, `${cfg.label}_${new Date().toISOString().slice(0, 10)}.xlsx`)
  showToast(`فایل Excel دانلود شد`)
}

// ============================================
// Import Customers from Excel
// ============================================

const IMPORT_FIELDS = [
  { key: 'platformId', label: 'ایدی پلتفرم' },
  { key: 'platform', label: 'پلتفرم' },
  { key: 'name', label: 'نام' },
  { key: 'phone', label: 'شماره تماس' },
  { key: 'status', label: 'وضعیت' },
  { key: 'notes', label: 'توضیحات' },
  { key: 'advisor', label: 'کارشناس' },
]

const PLATFORM_MAP_IMPORT = {
  'اینستاگرام': 'instagram', 'instagram': 'instagram', 'اینستا': 'instagram', 'insta': 'instagram',
  'تلگرام': 'telegram', 'telegram': 'telegram', 'tg': 'telegram',
  'واتساپ': 'whatsapp', 'whatsapp': 'whatsapp', 'wa': 'whatsapp',
}

const STATUS_MAP_IMPORT = {
  'جدید': 'new', 'جديد': 'new',
  'تماس گرفته شده': 'contacted', 'تماس گرفته': 'contacted',
  'در حال چت': 'chatting',
  'علاقمند': 'interested', 'علاقه\u200cمند': 'interested',
  'اطلاعات ارسال شده': 'sent', 'اطلاعات ارسال': 'sent',
  'تکمیل پیگیری': 'followup_done',
  'در حال تبدیل': 'converting',
  'خرید کرد': 'purchased', 'خرید': 'purchased',
  'منصرف شده': 'cancelled', 'منصرف': 'cancelled',
}

let importData = { headers: [], rows: [], mapping: {} }

export function openImportModal() {
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

        importData.mapping = {}
        const headerLower = importData.headers.map(h => h.toLowerCase())
        IMPORT_FIELDS.forEach(f => {
          const idx = headerLower.findIndex(h =>
            h === f.label || h.includes(f.label) || f.label.includes(h)
          )
          if (idx !== -1) importData.mapping[f.key] = idx
        })

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
        <select onchange="window.appSetImportMapping(${i}, this.value)">
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
  const data = getData()
  const mapping = importData.mapping
  if (Object.keys(mapping).length === 0) {
    showToast('حداقل یک ستون را نقشه\u200cبرداری کنید')
    return
  }

  let imported = 0, skipped = 0

  importData.rows.forEach(row => {
    const getValue = (fieldKey) => {
      const colIdx = mapping[fieldKey]
      if (colIdx === undefined || colIdx === null) return ''
      return String(row[colIdx] || '').trim()
    }

    const platformId = getValue('platformId')
    if (!platformId) { skipped++; return }

    const phone = getValue('phone')
    const platformRaw = getValue('platform').toLowerCase()
    const platform = PLATFORM_MAP_IMPORT[platformRaw] || platformRaw || 'instagram'
    const statusRaw = getValue('status')
    const status = STATUS_MAP_IMPORT[statusRaw] || statusRaw || 'new'

    const existById = data.customers.find(c => c.platformId.toLowerCase() === platformId.toLowerCase())
    const existByPhone = phone && data.customers.find(c => c.phone && c.phone === phone)

    if (existById || existByPhone) { skipped++; return }

    const type = phone ? 'CS' : 'LD'
    const currentUser = getCurrentUser()
    const advisor = getValue('advisor') || (currentUser ? currentUser.displayName : '')
    data.customers.push({
      id: generateId(type), platformId, platform,
      name: getValue('name'), phone, status,
      notes: getValue('notes'), advisor, products: []
    })
    imported++
  })

  // Save all imported customers to Supabase
  const newCustomers = data.customers.slice(-imported)
  for (const c of newCustomers) {
    await saveCustomerToDB(c)
  }

  closeImportModal()
  showToast(`${imported} مشتری ایمپورت شد${skipped > 0 ? ` — ${skipped} ردیف رد شد` : ''}`)
  // Re-render will be called by main.js
}

// ============================================
// Sales Import
// ============================================

const SALES_IMPORT_FIELDS = [
  { key: 'phone', label: 'شماره موبایل', required: true },
  { key: 'customerName', label: 'نام مشتری' },
  { key: 'productName', label: 'محصول' },
  { key: 'status', label: 'وضعیت' },
  { key: 'price', label: 'قیمت کل' },
  { key: 'deposit', label: 'بیعانه' },
  { key: 'settlementDate', label: 'تاریخ تسویه' },
  { key: 'advisor', label: 'کارشناس' },
]

const SALES_STATUS_MAP = {
  'تکمیل': 'تکمیل', 'complet': 'تکمیل', 'completed': 'تکمیل',
  'بیعانه': 'بیعانه', 'deposit': 'بیعانه', 'partial': 'بیعانه',
}

let salesImportData = { headers: [], rows: [], mapping: {} }

export function openSalesImportModal() {
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

        salesImportData.mapping = {}
        const headerLower = salesImportData.headers.map(h => h.toLowerCase())
        SALES_IMPORT_FIELDS.forEach(f => {
          const idx = headerLower.findIndex(h =>
            h === f.label || h.includes(f.label) || f.label.includes(h)
          )
          if (idx !== -1) salesImportData.mapping[f.key] = idx
        })

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
        <select onchange="window.appSetSalesImportMapping(${i}, this.value)">
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
  const data = getData()
  const mapping = salesImportData.mapping
  if (!mapping.phone && mapping.phone !== 0) {
    showToast('ستون شماره موبایل الزامی است')
    return
  }

  let imported = 0, skipped = 0, created = 0

  salesImportData.rows.forEach(row => {
    const getValue = (fieldKey) => {
      const colIdx = mapping[fieldKey]
      if (colIdx === undefined || colIdx === null) return ''
      return String(row[colIdx] || '').trim()
    }

    const phone = getValue('phone')
    if (!phone) { skipped++; return }

    const productName = getValue('productName')
    if (!productName) { skipped++; return }

    let customer = data.customers.find(c => c.phone === phone)
    if (!customer) {
      const name = getValue('customerName') || ''
      const id = generateId('CS')
      const currentUser = getCurrentUser()
      const advisor = getValue('advisor') || (currentUser ? currentUser.displayName : '')
      customer = { id, platformId: '', platform: 'instagram', name, phone, status: 'new', notes: 'خودکار ایجاد شده از ایمپورت فروش', advisor, products: [] }
      data.customers.push(customer)
      created++
    }

    const statusRaw = getValue('status')
    const status = SALES_STATUS_MAP[statusRaw] || statusRaw || 'تکمیل'
    const price = parseFloat(String(getValue('price')).replace(/[^\d]/g, '')) || 0
    const deposit = parseFloat(String(getValue('deposit')).replace(/[^\d]/g, '')) || 0
    const settlementDate = getValue('settlementDate')

    const isDuplicate = customer.products.some(p =>
      p.name === productName && p.status === status && (parseFloat(p.price) || 0) === price
    )
    if (isDuplicate) { skipped++; return }

    customer.products.push({ name: productName, status, price: String(price), deposit: String(deposit), settlementDate })
    imported++
  })

  // Save all affected customers to Supabase
  const affectedCustomers = [...new Set(data.customers.filter(c => c.products.length > 0).map(c => c.id))]
  for (const id of affectedCustomers) {
    const c = data.customers.find(x => x.id === id)
    if (c) await saveCustomerToDB(c)
  }

  closeSalesImportModal()
  let msg = `${imported} محصول ایمپورت شد`
  if (created > 0) msg += ` — ${created} مشتری جدید ایجاد شد`
  if (skipped > 0) msg += ` — ${skipped} ردیف رد شد`
  showToast(msg)
}
