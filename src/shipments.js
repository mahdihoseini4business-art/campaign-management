import { getData, saveCustomerToDB, coerceProductName } from './data.js'
import { getUsersSafe } from './auth.js'
import {
  toEnDigits, formatNumber, escapeHtml, escapeAttr, showToast, hasPermission,
  requirePermission, getCurrentUser, normalizePhone, getNowJalaliDateTime,
  ensureProductPayments, syncProductStatus, formatSoldAt24h, matchesTabSearch,
  getCustomerPhones, getPrimaryPhone, getApprovedPaid, getProductPayments,
  getPaymentEntryStatus, PAYMENT_STATUS, getSaleRegistrantPhone,
  canViewScopedCustomer, userDisplayName,
  isPhysicalSaleLine, hasApprovedPayment, getShipmentStatus,
  SHIPMENT_STATUS, renderCopyableCell, getPrimaryCustomerAddress
} from './utils.js'
import { paginateList, renderPaginationBar } from './pagination.js'
import { renderProducts } from './customers.js'

let shipmentsFilter = 'pending' // pending | shipped
let shipConfirmTarget = null // { customerId, productIndex }

function getLatestApprovedSoldAt(product) {
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
      if (!hasApprovedPayment(product)) return
      const price = parseFloat(product.price) || 0
      const approved = getApprovedPaid(product)
      const pays = getProductPayments(product)
      const lastPay = pays[pays.length - 1]
      const soldByPhone = getSaleRegistrantPhone(product, lastPay, c)
      const primaryAddress = getPrimaryCustomerAddress(c)
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
        price,
        approved,
        shippingAddress: primaryAddress?.text || '',
        shippingPostalCode: primaryAddress?.postalCode || '',
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

/** Same visibility as sales tab: own/scoped customers, or sales registered by me. */
function getVisibleShipments() {
  const data = getData()
  const currentUser = getCurrentUser()
  const myPhone = normalizePhone(currentUser?.phone || '')
  return getAllShipments().filter(s => {
    if (s.customerId.startsWith('LD') && !hasPermission('customers_ld')) return false
    if (s.customerId.startsWith('CS') && !hasPermission('customers_cs')) return false
    const customer = data.customers.find(c => c.id === s.customerId)
    const product = customer?.products?.[s.productIndex]
    const registeredByMe = !!(myPhone && (
      s.soldByPhone === myPhone ||
      (product && getProductPayments(product).some(pay => normalizePhone(pay.soldByPhone) === myPhone))
    ))
    if (!canViewScopedCustomer(customer, currentUser) && !registeredByMe) return false
    return true
  })
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

  if (shipmentsFilter === 'shipped') {
    thead.innerHTML = `<tr>
      <th>مشتری</th>
      <th>شماره</th>
      <th>کارشناس</th>
      <th>محصول</th>
      <th>وضعیت فروش</th>
      <th>آدرس گیرنده</th>
      <th>کد پستی گیرنده</th>
      <th>کد رهگیری</th>
      <th>تاریخ و ساعت ارسال</th>
    </tr>`
    return
  }

  thead.innerHTML = `<tr>
    <th>مشتری</th>
    <th>شماره</th>
    <th>کارشناس</th>
    <th>محصول</th>
    <th>وضعیت فروش</th>
    <th>مبلغ تأییدشده / قیمت کل</th>
    <th>تاریخ آخرین واریز تأییدشده</th>
    <th>آدرس گیرنده</th>
    <th>کد پستی گیرنده</th>
    ${canManage ? '<th>عملیات</th>' : ''}
  </tr>`
}

function phonesCell(row) {
  const phones = row.customerPhones || (row.customerPhone ? [row.customerPhone] : [])
  if (!phones.length) return '—'
  const extra = phones.length > 1
    ? ` <span style="color:var(--text-muted);font-size:11px;" title="${escapeAttr(phones.slice(1).join('، '))}">+${phones.length - 1}</span>`
    : ''
  return `${escapeHtml(phones[0])}${extra}`
}

export async function renderShipments() {
  const tbody = document.getElementById('shipmentsBody')
  if (!tbody) return

  const canManage = hasPermission('shipments_manage')
  renderShipmentsHeader(canManage)

  const search = toEnDigits(document.getElementById('searchShipments')?.value || '').toLowerCase()
  const allShipments = getVisibleShipments()

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
        s.productStatus
      ])
    )
  }

  const sortKey = shipmentsFilter === 'shipped' ? 'shippedAt' : 'lastApprovedAt'
  shipments.sort((a, b) => String(b[sortKey] || '').localeCompare(String(a[sortKey] || ''), 'fa'))

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
  const filterSig = `${shipmentsFilter}|${search}|${canManage ? 1 : 0}|${myPhone}`
  const page = paginateList('shipments', shipments, filterSig)

  tbody.innerHTML = page.items.map(s => {
    const common = `
      <td>${escapeHtml(s.customerName)}</td>
      <td style="direction:ltr;text-align:right;font-family:'Vazirmatn',sans-serif;font-size:13px;">${phonesCell(s)}</td>
      <td>${escapeHtml(s.advisor) || '—'}</td>
      <td>${escapeHtml(s.productName)}</td>
      <td>${escapeHtml(s.productStatus) || '—'}</td>`

    if (shipmentsFilter === 'shipped') {
      return `<tr class="clickable-row" onclick="app.onCustomerRowClick(event, '${escapeAttr(s.customerId)}')">
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

    return `<tr class="clickable-row" onclick="app.onCustomerRowClick(event, '${escapeAttr(s.customerId)}')">
      ${common}
      <td style="direction:ltr;text-align:right;font-family:'Vazirmatn',sans-serif;font-size:13px;">
        <b>${formatNumber(s.approved)}</b>
        <span style="color:var(--text-muted);"> / ${formatNumber(s.price)}</span>
      </td>
      <td style="font-family:'Vazirmatn',sans-serif;font-size:13px;direction:ltr;text-align:right;">${escapeHtml(formatSoldAt24h(s.lastApprovedAt) || '—')}</td>
      <td>${renderCopyableCell(s.shippingAddress)}</td>
      <td>${renderCopyableCell(s.shippingPostalCode)}</td>
      ${actions}
    </tr>`
  }).join('')

  renderPaginationBar('shipmentsPagination', 'shipments', page)
}

export function openConfirmShipmentModal(customerId, productIndex) {
  if (!requirePermission('shipments_manage')) return
  const data = getData()
  const customer = data.customers.find(c => c.id === customerId)
  const product = customer?.products?.[productIndex]
  if (!product || !isPhysicalSaleLine(product) || !hasApprovedPayment(product)) {
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
