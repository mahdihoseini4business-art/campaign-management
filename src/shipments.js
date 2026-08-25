import { getData, saveCustomerToDB, coerceProductName } from './data.js'
import { getUsersSafe } from './auth.js'
import {
  toEnDigits, formatNumber, escapeHtml, escapeAttr, showToast, hasPermission,
  requirePermission, getCurrentUser, normalizePhone, getNowJalaliDateTime,
  ensureProductPayments, syncProductStatus, formatSoldAt24h, matchesTabSearch,
  getCustomerPhones, getPrimaryPhone, getApprovedPaid, getProductPayments,
  getPaymentEntryStatus, PAYMENT_STATUS, getSaleRegistrantPhone,
  userDisplayName,
  isPhysicalSaleLine, isEligibleForShipment, isGiftSale, getGiftAccountingStatus,
  getShipmentStatus, SHIPMENT_STATUS, renderCopyableCell, getPrimaryCustomerAddress
} from './utils.js'
import { paginateList, renderPaginationBar } from './pagination.js'
import { toggleSortField, sortRecords, syncSortHeaders, sortSig, sortThHtml } from './table-sort.js'
import { renderProducts } from './customers.js'
import { runWithSearchOverlay, SEARCH_HOST } from './search-overlay.js'

let shipmentsFilter = 'pending' // pending | shipped
let shipmentsSortState = { field: null, asc: true }
let shipConfirmTarget = null // { customerId, productIndex }

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
  renderShipments()
}

function renderShipmentsHeader(canManage) {
  const thead = document.getElementById('shipmentsHead')
  if (!thead) return
  const th = (field, label, extraClass = '', style = '') =>
    sortThHtml({ field, label, handler: `app.sortShipmentsHeader('${field}')`, extraClass, style })

  if (shipmentsFilter === 'shipped') {
    thead.innerHTML = `<tr>
      ${th('customerName', 'مشتری')}
      ${th('customerPhone', 'شماره')}
      ${th('advisor', 'کارشناس')}
      ${th('productName', 'محصول')}
      ${th('productStatus', 'وضعیت فروش')}
      ${th('shippingAddress', 'آدرس گیرنده')}
      ${th('shippingPostalCode', 'کد پستی گیرنده')}
      ${th('trackingCode', 'کد رهگیری')}
      ${th('shippedAt', 'تاریخ و ساعت ارسال')}
    </tr>`
    syncSortHeaders(thead, shipmentsSortState)
    return
  }

  thead.innerHTML = `<tr>
    ${th('customerName', 'مشتری')}
    ${th('customerPhone', 'شماره')}
    ${th('advisor', 'کارشناس')}
    ${th('productName', 'محصول')}
    ${th('productStatus', 'وضعیت فروش')}
    ${th('approved', 'مبلغ تأییدشده / قیمت کل')}
    ${th('lastApprovedAt', 'تاریخ آخرین واریز تأییدشده')}
    ${th('shippingAddress', 'آدرس گیرنده')}
    ${th('shippingPostalCode', 'کد پستی گیرنده')}
    ${canManage ? '<th class="actions-col">عملیات</th>' : ''}
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

export function onShipmentsSearchInput() {
  return runWithSearchOverlay(SEARCH_HOST.shipments, () => renderShipments())
}

export async function renderShipments() {
  const tbody = document.getElementById('shipmentsBody')
  if (!tbody) return

  const canManage = hasPermission('shipments_manage')
  renderShipmentsHeader(canManage)

  const search = toEnDigits(document.getElementById('searchShipments')?.value || '').toLowerCase()
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

  const colCount = shipmentsFilter === 'shipped' ? 9 : (canManage ? 10 : 9)

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
    return
  }

  const myPhone = normalizePhone(getCurrentUser()?.phone || '')
  const filterSig = `${shipmentsFilter}|${search}|${canManage ? 1 : 0}|${myPhone}|${sortSig(shipmentsSortState)}`
  const page = paginateList('shipments', shipments, filterSig)

  tbody.innerHTML = page.items.map(s => {
    const productLabel = s.isGift
      ? `${escapeHtml(s.productName)} <span class="gift-badge">هدیه</span>`
      : escapeHtml(s.productName)
    const statusLabel = escapeHtml(s.productStatus) || '—'
    const common = `
      <td>${escapeHtml(s.customerName)}</td>
      <td style="direction:ltr;text-align:right;font-family:'Vazirmatn',sans-serif;font-size:13px;">${phonesCell(s)}</td>
      <td>${escapeHtml(s.advisor) || '—'}</td>
      <td>${productLabel}</td>
      <td>${statusLabel}</td>`

    if (shipmentsFilter === 'shipped') {
      return `<tr class="clickable-row${s.isGift ? ' gift-row' : ''}" onclick="app.onCustomerRowClick(event, '${escapeAttr(s.customerId)}')">
        ${common}
        <td>${renderCopyableCell(s.shippingAddress)}</td>
        <td>${renderCopyableCell(s.shippingPostalCode)}</td>
        <td>${renderCopyableCell(s.trackingCode, { truncate: true })}</td>
        <td style="font-family:'Vazirmatn',sans-serif;font-size:13px;direction:ltr;text-align:right;">${escapeHtml(formatSoldAt24h(s.shippedAt) || s.shippedAt || '—')}</td>
      </tr>`
    }

    const actions = canManage
      ? `<td><button type="button" class="btn btn-sm btn-approve" onclick="event.stopPropagation(); app.openConfirmShipmentModal('${escapeAttr(s.customerId)}', ${s.productIndex})">تأیید ارسال</button></td>`
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
      <td>${renderCopyableCell(s.shippingAddress)}</td>
      <td>${renderCopyableCell(s.shippingPostalCode)}</td>
      ${actions}
    </tr>`
  }).join('')

  renderPaginationBar('shipmentsPagination', 'shipments', page)
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
  if (modal) modal.classList.add('active')
  input?.focus()
}

export function closeConfirmShipmentModal() {
  shipConfirmTarget = null
  document.getElementById('confirmShipmentModal')?.classList.remove('active')
}

export async function confirmShipment() {
  if (!requirePermission('shipments_manage')) return
  if (!shipConfirmTarget) return
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
  product.shipmentStatus = SHIPMENT_STATUS.shipped
  product.trackingCode = trackingCode
  product.shippedAt = dateTime
  product.shippedBy = normalizePhone(user?.phone || '')
  try {
    await saveCustomerToDB(customer)
    closeConfirmShipmentModal()
    showToast('ارسال تأیید شد')
    renderShipments()
    try { renderProducts(customerId) } catch (_) { /* detail may be closed */ }
  } catch (e) {
    console.error('confirmShipment error:', e)
    showToast('خطا در تأیید ارسال')
  }
}
