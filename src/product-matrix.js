import {
  getData,
  getProductCatalog,
  getCustomerOwnedProductNames,
  customerHasNoProducts
} from './data.js'
import {
  toEnDigits,
  escapeHtml,
  escapeAttr,
  hasPermission,
  getCurrentUser,
  canViewScopedCustomer,
  matchesTabSearch,
  getCustomerPhones,
  getPrimaryPhone
} from './utils.js'
import { paginateList, renderPaginationBar } from './pagination.js'

const MARK_YES = '✅'
const MARK_NO = '❌'

function getVisibleCustomers() {
  const data = getData()
  const currentUser = getCurrentUser()
  const search = toEnDigits(document.getElementById('searchProductMatrix')?.value || '').toLowerCase()

  return (data.customers || []).filter(c => {
    const isCS = c.id.startsWith('CS')
    const isLD = c.id.startsWith('LD')
    if (isCS && !hasPermission('customers_cs')) return false
    if (isLD && !hasPermission('customers_ld')) return false
    if (!canViewScopedCustomer(c, currentUser)) return false

    const phones = getCustomerPhones(c)
    return matchesTabSearch(search, [c.name, c.advisor, ...phones])
  })
}

function markCell(has) {
  const cls = has ? 'product-matrix-yes' : 'product-matrix-no'
  const mark = has ? MARK_YES : MARK_NO
  return `<td class="product-matrix-mark ${cls}">${mark}</td>`
}

export function renderProductMatrix() {
  if (!hasPermission('customers_view')) return

  const thead = document.getElementById('productMatrixHead')
  const tbody = document.getElementById('productMatrixBody')
  if (!thead || !tbody) return

  const catalog = getProductCatalog()
  const search = toEnDigits(document.getElementById('searchProductMatrix')?.value || '').toLowerCase()
  const customers = getVisibleCustomers()

  thead.innerHTML = `
    <tr>
      <th class="product-matrix-sticky product-matrix-col-name">نام مشتری</th>
      <th class="product-matrix-sticky product-matrix-col-phone">شماره مشتری</th>
      <th class="product-matrix-sticky product-matrix-col-advisor">کارشناس</th>
      ${catalog.map(name =>
        `<th class="product-matrix-product-col" title="${escapeAttr(name)}"><span>${escapeHtml(name)}</span></th>`
      ).join('')}
      <th class="product-matrix-none-col">بدون محصول</th>
    </tr>`

  if (!catalog.length) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:24px;">کاتالوگ محصولات خالی است — از تنظیمات اضافه کنید</td></tr>`
    renderPaginationBar('productMatrixPagination', 'productMatrix', {
      items: [], page: 1, totalPages: 1, total: 0, from: 0, to: 0
    })
    return
  }

  if (!customers.length) {
    const colSpan = 3 + catalog.length + 1
    tbody.innerHTML = `<tr><td colspan="${colSpan}" style="text-align:center;color:var(--text-muted);padding:24px;">موردی یافت نشد</td></tr>`
    renderPaginationBar('productMatrixPagination', 'productMatrix', {
      items: [], page: 1, totalPages: 1, total: 0, from: 0, to: 0
    })
    return
  }

  const page = paginateList('productMatrix', customers, search)
  tbody.innerHTML = page.items.map(c => {
    const owned = getCustomerOwnedProductNames(c)
    const noProducts = customerHasNoProducts(c)
    const phone = getPrimaryPhone(c) || '—'
    const productCells = catalog.map(name => markCell(owned.has(name))).join('')
    return `<tr>
      <td class="product-matrix-sticky product-matrix-col-name">${escapeHtml(c.name || '—')}</td>
      <td class="product-matrix-sticky product-matrix-col-phone" dir="ltr">${escapeHtml(phone)}</td>
      <td class="product-matrix-sticky product-matrix-col-advisor">${escapeHtml(c.advisor || '—')}</td>
      ${productCells}
      ${markCell(noProducts)}
    </tr>`
  }).join('')

  renderPaginationBar('productMatrixPagination', 'productMatrix', page)
}
