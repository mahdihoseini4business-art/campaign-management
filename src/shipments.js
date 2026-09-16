import { getData, saveCustomerToDB, coerceProductName } from './data.js'
import { getUsersSafe, openSettingsModal } from './auth.js'
import {
  toEnDigits, formatNumber, escapeHtml, escapeAttr, showToast, hasPermission,
  requirePermission, getCurrentUser, normalizePhone, getNowJalaliDateTime,
  ensureProductPayments, syncProductStatus, formatSoldAt24h, matchesTabSearch,
  getCustomerPhones, getPrimaryPhone, getApprovedPaid, getProductPayments,
  getPaymentEntryStatus, PAYMENT_STATUS, getSaleRegistrantPhone,
  userDisplayName, isMainAdmin,
  isPhysicalSaleLine, isEligibleForShipment, isGiftSale, getGiftAccountingStatus,
  getShipmentStatus, SHIPMENT_STATUS, renderCopyableCell, getPrimaryCustomerAddress
} from './utils.js'
import { paginateList, renderPaginationBar, getPage } from './pagination.js'
import { toggleSortField, sortRecords, syncSortHeaders, sortSig, sortThHtml } from './table-sort.js'
import { renderProducts } from './customers.js'
import { debouncedSearchInput } from './search-debounce.js'
import { SEARCH_HOST } from './search-overlay.js'
import { shouldSkipTabRender, markTabRendered, tabPageKey } from './tab-cache.js'
import { assertFeature, assertWritable } from './entitlements.js'
import { printShippingLabels, shipmentToLabelItem } from './shipping-label.js'
import { canUseSmsKind } from './sms-business.js'
import { sendShipmentShippedSms } from './sms-ui.js'

let shipmentsFilter = 'pending' // pending | shipped
let shipmentsSortState = { field: null, asc: true }
let shipConfirmTarget = null // { customerId, productIndex }
const selectedShipmentKeys = new Set()

function shipmentKey(customerId, productIndex) {
  return `${customerId}|${productIndex}`
}

function getLatestApprovedSoldAt(product) {
  if (isGiftSale(product) && getGiftAccountingStatus(product) === PAYMENT_STATUS.approved) {
    return String(product.giftReviewedAt || product.soldAt || '')
  }
  const pays = getProductPayments(product)
    .filter(p => getPaymentEntryStatus(p) === PAYMENT_STATUS.approved && (parseFloat(p.amount) || 0) > 0)
  if (!pays.length) return ''
  return pays.reduce((best, p) => {
    const a = String(p.soldAt || '')
    return a.localeCompare(String(best || ''), 'fa') > 0 ? a : best
  }, '')
}

export function getAllShipments() {
  const data = getData()
  const rows = []
  data.customers.forEach(c => {
    ;(c.products || []).forEach((product, productIndex) => {
      ensureProductPayments(product)
      syncProductStatus(product)
      if (!isPhysicalSaleLine(product)) return
      if (!isEligibleForShipment(product)) return
      const price = parseFloat(product.price) || 0
      const approved = isGiftSale(product) ? 0 : getApprovedPaid(product)
      const pays = getProductPayments(product)
      const lastPay = pays[pays.length - 1]
      const soldByPhone = getSaleRegistrantPhone(product, lastPay, c)
      const primaryAddress = getPrimaryCustomerAddress(c)
      const shippingAddress = String(product.shippingAddress || '').trim() || primaryAddress?.text || ''
      const shippingPostalCode = String(product.shippingPostalCode || '').trim()
        || (String(product.shippingAddress || '').trim() ? '' : (primaryAddress?.postalCode || ''))
      rows.push({
        customerId: c.id,
        productIndex,
        customerName: c.name || c.platformId || c.id,
        customerPhone: getPrimaryPhone(c),
        customerPhones: getCustomerPhones(c),
        advisor: c.advisor || '',
        advisorPhone: soldByPhone,
        ownerAdvisor: c.advisor || '',
        soldByPhone,
        productName: coerceProductName(product.name),
        productStatus: product.status || '',
        isGift: isGiftSale(product),
        price,
        approved,
        shippingAddress,
        shippingPostalCode,
        shipmentStatus: getShipmentStatus(product),
        trackingCode: product.trackingCode || '',
        shippedAt: product.shippedAt || '',
        shippedBy: product.shippedBy || '',
        lastApprovedAt: getLatestApprovedSoldAt(product)
      })
    })
  })
  return rows
}

export function setShipmentsFilter(filter) {
  if (filter !== 'pending' && filter !== 'shipped') return
  shipmentsFilter = filter
  document.querySelectorAll('.shipments-filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter)
  })
  selectedShipmentKeys.clear()
  renderShipments()
}

function updateShipmentsSelectionUi(pageKeys = []) {
  const count = selectedShipmentKeys.size
  const countEl = document.getElementById('shipmentsSelectedCount')
  const printBtn = document.getElementById('shipmentsBatchPrintBtn')
  if (countEl) countEl.textContent = count ? `${count} انتخاب` : ''
  if (printBtn) printBtn.disabled = count === 0

  const selectAll = document.getElementById('selectAllShipments')
  if (selectAll && pageKeys.length) {
    const selectedOnPage = pageKeys.filter(k => selectedShipmentKeys.has(k)).length
    selectAll.checked = selectedOnPage === pageKeys.length
    selectAll.indeterminate = selectedOnPage > 0 && selectedOnPage < pageKeys.length
  } else if (selectAll) {
    selectAll.checked = false
    selectAll.indeterminate = false
  }
}

function renderShipmentsHeader() {
  const thead = document.getElementById('shipmentsHead')
  if (!thead) return
  const th = (field, label, extraClass = '', style = '') =>
    sortThHtml({ field, label, handler: `app.sortShipmentsHeader('${field}')`, extraClass, style })
  const selectTh = `<th class="select-col" style="width:40px;"><input type="checkbox" id="selectAllShipments" aria-label="انتخاب همه ارسالی‌های این صفحه" onchange="app.toggleSelectAllShipments(this.checked)"></th>`
  const actionsTh = '<th class="actions-col">عملیات</th>'

  if (shipmentsFilter === 'shipped') {
    thead.innerHTML = `<tr>
      ${selectTh}
      ${th('customerName', 'مشتری')}
      ${th('customerPhone', 'شماره')}
      ${th('advisor', 'کارشناس')}
      ${th('productName', 'محصول')}
      ${th('productStatus', 'وضعیت فروش')}
      ${th('trackingCode', 'کد رهگیری')}
      ${th('shippedAt', 'تاریخ و ساعت ارسال')}
      ${actionsTh}
    </tr>`
    syncSortHeaders(thead, shipmentsSortState)
    return
  }

  thead.innerHTML = `<tr>
    ${selectTh}
    ${th('customerName', 'مشتری')}
    ${th('customerPhone', 'شماره')}
    ${th('advisor', 'کارشناس')}
    ${th('productName', 'محصول')}
    ${th('productStatus', 'وضعیت فروش')}
    ${th('approved', 'مبلغ تأییدشده / قیمت کل')}
    ${th('lastApprovedAt', 'تاریخ آخرین واریز تأییدشده')}
    ${actionsTh}
  </tr>`
  syncSortHeaders(thead, shipmentsSortState)
}

function phonesCell(row) {
  const phones = row.customerPhones || (row.customerPhone ? [row.customerPhone] : [])
  if (!phones.length) return '—'
  const extra = phones.length > 1
    ? ` <span style="color:var(--text-muted);font-size:11px;" title="${escapeAttr(phones.slice(1).join('، '))}">+${phones.length - 1}</span>`
    : ''
  return `${escapeHtml(phones[0])}${extra}`
}

function selectCellHtml(s) {
  const key = shipmentKey(s.customerId, s.productIndex)
  const checked = selectedShipmentKeys.has(key) ? ' checked' : ''
  return `<td class="select-col" onclick="event.stopPropagation()">
    <input type="checkbox" class="shipment-row-cb" data-key="${escapeAttr(key)}"${checked}
      aria-label="انتخاب ارسالی" onchange="app.toggleShipmentSelect('${escapeAttr(key)}', this.checked)">
  </td>`
}

function hasShippingAddress(s) {
  return !!(s && String(s.shippingAddress || '').trim())
}

function printBtnHtml(s) {
  if (!hasShippingAddress(s)) {
    return `<button type="button" class="btn btn-sm" disabled title="آدرس گیرنده ثبت نشده">پرینت لیبل</button>`
  }
  return `<button type="button" class="btn btn-sm" onclick="event.stopPropagation(); app.printShipmentLabel('${escapeAttr(s.customerId)}', ${s.productIndex})">پرینت لیبل</button>`
}

export function onShipmentsSearchInput() {
  debouncedSearchInput(SEARCH_HOST.shipments, () => renderShipments())
}

export function toggleShipmentSelect(key, checked) {
  if (checked) selectedShipmentKeys.add(key)
  else selectedShipmentKeys.delete(key)
  const pageKeys = [...document.querySelectorAll('#shipmentsBody .shipment-row-cb')]
    .map(cb => cb.dataset.key)
    .filter(Boolean)
  updateShipmentsSelectionUi(pageKeys)
}

export function toggleSelectAllShipments(checked) {
  document.querySelectorAll('#shipmentsBody .shipment-row-cb').forEach(cb => {
    const key = cb.dataset.key
    if (!key) return
    cb.checked = checked
    if (checked) selectedShipmentKeys.add(key)
    else selectedShipmentKeys.delete(key)
  })
  const pageKeys = [...document.querySelectorAll('#shipmentsBody .shipment-row-cb')]
    .map(cb => cb.dataset.key)
    .filter(Boolean)
  updateShipmentsSelectionUi(pageKeys)
}

async function handleSenderIncomplete() {
  showToast('اطلاعات فرستنده پستی در تنظیمات تکمیل نشده است')
  if (isMainAdmin()) {
    try { await openSettingsModal('shipping-sender') } catch (_) { /* ignore */ }
  }
}

function findShipmentRow(customerId, productIndex) {
  return getAllShipments().find(s => s.customerId === customerId && s.productIndex === productIndex) || null
}

export async function printShipmentLabel(customerId, productIndex) {
  if (!assertFeature('shipments')) return
  const row = findShipmentRow(customerId, productIndex)
  if (!row) {
    showToast('ردیف ارسالی یافت نشد')
    return
  }
  if (!hasShippingAddress(row)) {
    showToast('آدرس گیرنده ثبت نشده است')
    return
  }
  const result = printShippingLabels([shipmentToLabelItem(row)])
  if (result.reason === 'sender_incomplete') await handleSenderIncomplete()
  else if (result.reason === 'empty') showToast('موردی برای پرینت نیست')
}

export async function printSelectedShipmentLabels() {
  if (!assertFeature('shipments')) return
  if (!selectedShipmentKeys.size) {
    showToast('حداقل یک ردیف انتخاب کنید')
    return
  }
  const all = getAllShipments()
  const byKey = new Map(all.map(s => [shipmentKey(s.customerId, s.productIndex), s]))
  const rows = [...selectedShipmentKeys]
    .map(k => byKey.get(k))
    .filter(s => s && hasShippingAddress(s))
  if (!rows.length) {
    showToast('هیچ‌کدام از ردیف‌های انتخاب‌شده آدرس ندارند')
    return
  }
  const result = printShippingLabels(rows.map(shipmentToLabelItem))
  if (result.reason === 'sender_incomplete') await handleSenderIncomplete()
  else if (result.reason === 'empty') showToast('حداقل یک ردیف انتخاب کنید')
}

export async function renderShipments() {
  if (!assertFeature('shipments', { silent: true })) return
  const tbody = document.getElementById('shipmentsBody')
  if (!tbody) return

  const canManage = hasPermission('shipments_manage')
  renderShipmentsHeader()

  const search = toEnDigits(document.getElementById('searchShipments')?.value || '').toLowerCase()
  const myPhone = normalizePhone(getCurrentUser()?.phone || '')
  const cacheKey = `${shipmentsFilter}|${search}|${canManage ? 1 : 0}|${myPhone}|${sortSig(shipmentsSortState)}|${tabPageKey('shipments', getPage('shipments'))}`
  if (shouldSkipTabRender('shipments', cacheKey)) {
    const pageKeys = [...document.querySelectorAll('#shipmentsBody .shipment-row-cb')]
      .map(cb => cb.dataset.key)
      .filter(Boolean)
    updateShipmentsSelectionUi(pageKeys)
    return
  }

  const allShipments = getAllShipments()

  try {
    const users = await getUsersSafe()
    const nameByPhone = new Map(
      users.filter(u => u.phone).map(u => [normalizePhone(u.phone), userDisplayName(u)])
    )
    allShipments.forEach(s => {
      const phone = s.soldByPhone || s.advisorPhone
      s.advisor = nameByPhone.get(phone) || s.ownerAdvisor || s.advisor || '—'
    })
  } catch (_) { /* keep fallback advisor names */ }

  let shipments = allShipments.filter(s => s.shipmentStatus === shipmentsFilter)

  if (search) {
    shipments = shipments.filter(s =>
      matchesTabSearch(search, [
        s.customerId,
        s.customerName,
        s.customerPhone,
        ...(s.customerPhones || []),
        s.advisor,
        s.productName,
        s.shippingAddress,
        s.shippingPostalCode,
        s.trackingCode,
        s.productStatus,
        s.isGift ? 'هدیه' : ''
      ])
    )
  }

  if (shipmentsSortState.field) {
    shipments = sortRecords(shipments, shipmentsSortState, shipmentsSortValue)
  } else {
    const sortKey = shipmentsFilter === 'shipped' ? 'shippedAt' : 'lastApprovedAt'
    shipments.sort((a, b) => String(b[sortKey] || '').localeCompare(String(a[sortKey] || ''), 'fa'))
  }

  const setStat = (id, n) => {
    const el = document.getElementById(id)
    if (el) el.textContent = String(n)
  }
  setStat('stat-ship-pending', allShipments.filter(s => s.shipmentStatus === SHIPMENT_STATUS.pending).length)
  setStat('stat-ship-shipped', allShipments.filter(s => s.shipmentStatus === SHIPMENT_STATUS.shipped).length)

  const colCount = 9

  if (shipments.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="${colCount}">
        <div class="empty-state">
          <div class="icon">📦</div>
          <h3>ارسالی در این وضعیت نیست</h3>
          <p>فیلتر یا جستجو را تغییر دهید</p>
        </div>
      </td></tr>`
    renderPaginationBar('shipmentsPagination', 'shipments', { total: 0, from: 0, to: 0, page: 1, totalPages: 1 })
    updateShipmentsSelectionUi([])
    markTabRendered('shipments', cacheKey)
    return
  }

  const filterSig = `${shipmentsFilter}|${search}|${canManage ? 1 : 0}|${myPhone}|${sortSig(shipmentsSortState)}`
  const page = paginateList('shipments', shipments, filterSig)
  const pageKeys = page.items.map(s => shipmentKey(s.customerId, s.productIndex))

  tbody.innerHTML = page.items.map(s => {
    const productLabel = s.isGift
      ? `${escapeHtml(s.productName)} <span class="gift-badge">هدیه</span>`
      : escapeHtml(s.productName)
    const statusLabel = escapeHtml(s.productStatus) || '—'
    const common = `
      ${selectCellHtml(s)}
      <td>${escapeHtml(s.customerName)}</td>
      <td style="direction:ltr;text-align:right;font-family:'Vazirmatn',sans-serif;font-size:13px;">${phonesCell(s)}</td>
      <td>${escapeHtml(s.advisor) || '—'}</td>
      <td>${productLabel}</td>
      <td>${statusLabel}</td>`

    if (shipmentsFilter === 'shipped') {
      return `<tr class="clickable-row${s.isGift ? ' gift-row' : ''}" onclick="app.onCustomerRowClick(event, '${escapeAttr(s.customerId)}')">
        ${common}
        <td>${renderCopyableCell(s.trackingCode, { truncate: true })}</td>
        <td style="font-family:'Vazirmatn',sans-serif;font-size:13px;direction:ltr;text-align:right;">${escapeHtml(formatSoldAt24h(s.shippedAt) || s.shippedAt || '—')}</td>
        <td class="actions-col" onclick="event.stopPropagation()">${printBtnHtml(s)}</td>
      </tr>`
    }

    const manageActions = canManage
      ? `<button type="button" class="btn btn-sm btn-approve" onclick="event.stopPropagation(); app.openConfirmShipmentModal('${escapeAttr(s.customerId)}', ${s.productIndex})">تأیید ارسال</button>`
      : ''

    const amountHtml = s.isGift
      ? `<span class="gift-badge">۰ · هدیه</span>`
      : `<b>${formatNumber(s.approved)}</b>
        <span style="color:var(--text-muted);"> / ${formatNumber(s.price)}</span>`

    return `<tr class="clickable-row${s.isGift ? ' gift-row' : ''}" onclick="app.onCustomerRowClick(event, '${escapeAttr(s.customerId)}')">
      ${common}
      <td style="direction:ltr;text-align:right;font-family:'Vazirmatn',sans-serif;font-size:13px;">
        ${amountHtml}
      </td>
      <td style="font-family:'Vazirmatn',sans-serif;font-size:13px;direction:ltr;text-align:right;">${escapeHtml(formatSoldAt24h(s.lastApprovedAt) || '—')}</td>
      <td class="actions-col" onclick="event.stopPropagation()">
        <div class="shipments-actions">
          ${printBtnHtml(s)}
          ${manageActions}
        </div>
      </td>
    </tr>`
  }).join('')

  renderPaginationBar('shipmentsPagination', 'shipments', page)
  updateShipmentsSelectionUi(pageKeys)
  markTabRendered('shipments', cacheKey)
}

function shipmentsSortValue(s, field) {
  if (field === 'approved' || field === 'price') return { value: s[field] || 0, type: 'number' }
  if (field === 'lastApprovedAt' || field === 'shippedAt') return { value: s[field] || '', type: 'datetime' }
  if (field === 'customerPhone') return { value: s.customerPhone || '', type: 'text' }
  return { value: s[field] ?? '', type: 'text' }
}

export function sortShipments(field) {
  toggleSortField(shipmentsSortState, field)
  renderShipments()
}

export function openConfirmShipmentModal(customerId, productIndex) {
  if (!assertFeature('shipments')) return
  if (!assertWritable()) return
  if (!requirePermission('shipments_manage')) return
  const data = getData()
  const customer = data.customers.find(c => c.id === customerId)
  const product = customer?.products?.[productIndex]
  if (!product || !isPhysicalSaleLine(product) || !isEligibleForShipment(product)) {
    showToast('ردیف ارسالی یافت نشد')
    return
  }
  if (getShipmentStatus(product) === SHIPMENT_STATUS.shipped) {
    showToast('این محصول قبلاً ارسال شده است')
    return
  }
  shipConfirmTarget = { customerId, productIndex }
  const modal = document.getElementById('confirmShipmentModal')
  const input = document.getElementById('shipmentTrackingCode')
  if (input) input.value = product.trackingCode || ''
  const smsWrap = document.getElementById('shipmentSmsSendWrap')
  const smsCb = document.getElementById('shipmentSmsSend')
  const showSms = canUseSmsKind('shipment_shipped')
  if (smsWrap) smsWrap.style.display = showSms ? '' : 'none'
  if (smsCb) smsCb.checked = showSms
  if (modal) modal.classList.add('active')
  input?.focus()
}

export function closeConfirmShipmentModal() {
  shipConfirmTarget = null
  document.getElementById('confirmShipmentModal')?.classList.remove('active')
}

function buildShipmentSnapshot(customer, product, productIndex, trackingCode, shippedAt, shippedBy) {
  const primaryAddress = getPrimaryCustomerAddress(customer)
  const shippingAddress = String(product.shippingAddress || '').trim() || primaryAddress?.text || ''
  const shippingPostalCode = String(product.shippingPostalCode || '').trim()
    || (String(product.shippingAddress || '').trim() ? '' : (primaryAddress?.postalCode || ''))
  return {
    customerId: customer.id,
    productIndex,
    customerName: customer.name || customer.platformId || customer.id,
    customerPhone: getPrimaryPhone(customer),
    customerPhones: getCustomerPhones(customer),
    shippingAddress,
    shippingPostalCode,
    trackingCode: trackingCode || '',
    shippedAt: shippedAt || '',
    shippedBy: shippedBy || ''
  }
}

export async function confirmShipment(options = {}) {
  if (!requirePermission('shipments_manage')) return
  if (!shipConfirmTarget) return
  const { print = false } = options
  const { customerId, productIndex } = shipConfirmTarget
  const data = getData()
  const customer = data.customers.find(c => c.id === customerId)
  const product = customer?.products?.[productIndex]
  if (!product) {
    showToast('ردیف ارسالی یافت نشد')
    return
  }
  const trackingCode = toEnDigits(String(document.getElementById('shipmentTrackingCode')?.value || '')).trim()
  const user = getCurrentUser()
  const { dateTime } = getNowJalaliDateTime()
  const shippedBy = normalizePhone(user?.phone || '')
  product.shipmentStatus = SHIPMENT_STATUS.shipped
  product.trackingCode = trackingCode
  product.shippedAt = dateTime
  product.shippedBy = shippedBy
  const wantSms = !!document.getElementById('shipmentSmsSend')?.checked && canUseSmsKind('shipment_shipped')
  const labelSnapshot = buildShipmentSnapshot(customer, product, productIndex, trackingCode, dateTime, shippedBy)
  try {
    await saveCustomerToDB(customer)
    if (wantSms && !product.smsShippedAt) {
      try {
        const smsResult = await sendShipmentShippedSms(customer, product, productIndex)
        if (smsResult?.sent > 0) {
          product.smsShippedAt = dateTime
          await saveCustomerToDB(customer)
        }
      } catch (smsErr) {
        console.error('shipment SMS', smsErr)
      }
    }
    closeConfirmShipmentModal()
    showToast('ارسال تأیید شد')
    selectedShipmentKeys.delete(shipmentKey(customerId, productIndex))
    renderShipments()
    try { renderProducts(customerId) } catch (_) { /* detail may be closed */ }
    if (print) {
      if (!hasShippingAddress(labelSnapshot)) {
        showToast('آدرس گیرنده ثبت نشده — لیبل چاپ نشد')
      } else {
        const result = printShippingLabels([shipmentToLabelItem(labelSnapshot)])
        if (result.reason === 'sender_incomplete') await handleSenderIncomplete()
      }
    }
  } catch (e) {
    console.error('confirmShipment error:', e)
    showToast('خطا در تأیید ارسال')
  }
}

export async function confirmShipmentAndPrint() {
  await confirmShipment({ print: true })
}
