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
const NONE_KEY = '__none__'

/** @type {Record<string, 'both' | 'has' | 'missing'>} */
const productFilterState = {}

function getFilterMode(key) {
  return productFilterState[key] || 'both'
}

function filterHeaderClass(mode) {
  if (mode === 'has') return ' product-matrix-filter-has'
  if (mode === 'missing') return ' product-matrix-filter-missing'
  return ''
}

function syncClearFiltersButton() {
  const btn = document.getElementById('clearProductMatrixFiltersBtn')
  if (!btn) return
  const active = Object.values(productFilterState).some(m => m && m !== 'both')
  btn.hidden = !active
}

/**
 * Customers visible in the product matrix (search + permissions + column filters).
 * Exported for CSV/Excel.
 */
export function getFilteredProductMatrixCustomers() {
  const data = getData()
  const currentUser = getCurrentUser()
  const search = toEnDigits(document.getElementById('searchProductMatrix')?.value || '').toLowerCase()
  const catalog = getProductCatalog()

  return (data.customers || []).filter(c => {
    const isCS = c.id.startsWith('CS')
    const isLD = c.id.startsWith('LD')
    if (isCS && !hasPermission('customers_cs')) return false
    if (isLD && !hasPermission('customers_ld')) return false
    if (!canViewScopedCustomer(c, currentUser)) return false

    const phones = getCustomerPhones(c)
    if (!matchesTabSearch(search, [c.name, c.advisor, ...phones])) return false

    const owned = getCustomerOwnedProductNames(c)

    for (const name of catalog) {
      const mode = getFilterMode(name)
      if (mode === 'both') continue
      const has = owned.has(name)
      if (mode === 'has' && !has) return false
      if (mode === 'missing' && has) return false
    }

    const noneMode = getFilterMode(NONE_KEY)
    if (noneMode !== 'both') {
      const noProducts = owned.size === 0
      if (noneMode === 'has' && !noProducts) return false
      if (noneMode === 'missing' && noProducts) return false
    }

    return true
  })
}

export function hasActiveProductMatrixFilter() {
  const search = document.getElementById('searchProductMatrix')?.value?.trim()
  if (search) return true
  return Object.values(productFilterState).some(m => m && m !== 'both')
}

export function cycleProductMatrixFilter(key) {
  const current = getFilterMode(key)
  const next = current === 'both' ? 'has' : current === 'has' ? 'missing' : 'both'
  if (next === 'both') delete productFilterState[key]
  else productFilterState[key] = next
  renderProductMatrix()
}

export function clearProductMatrixFilters() {
  for (const k of Object.keys(productFilterState)) delete productFilterState[k]
  renderProductMatrix()
}

function markCell(has) {
  if (!has) return '<td class="product-matrix-mark"></td>'
  return `<td class="product-matrix-mark product-matrix-yes">${MARK_YES}</td>`
}

export function renderProductMatrix() {
  if (!hasPermission('products_matrix')) return

  const thead = document.getElementById('productMatrixHead')
  const tbody = document.getElementById('productMatrixBody')
  if (!thead || !tbody) return

  const catalog = getProductCatalog()
  const search = toEnDigits(document.getElementById('searchProductMatrix')?.value || '').toLowerCase()
  const filterSig = `${search}|${JSON.stringify(productFilterState)}`
  const customers = getFilteredProductMatrixCustomers()

  const noneMode = getFilterMode(NONE_KEY)
  thead.innerHTML = `
    <tr>
      <th class="product-matrix-sticky product-matrix-col-name">نام مشتری</th>
      <th class="product-matrix-sticky product-matrix-col-phone">شماره مشتری</th>
      <th class="product-matrix-sticky product-matrix-col-advisor">کارشناس</th>
      ${catalog.map(name => {
        const mode = getFilterMode(name)
        return `<th class="product-matrix-product-col product-matrix-filterable${filterHeaderClass(mode)}" title="${escapeAttr(name)} — کلیک برای فیلتر" onclick="app.cycleProductMatrixFilter('${escapeAttr(name)}')"><span>${escapeHtml(name)}</span></th>`
      }).join('')}
      <th class="product-matrix-none-col product-matrix-filterable${filterHeaderClass(noneMode)}" title="بدون محصول — کلیک برای فیلتر" onclick="app.cycleProductMatrixFilter('${escapeAttr(NONE_KEY)}')">بدون محصول</th>
    </tr>`

  syncClearFiltersButton()

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

  const page = paginateList('productMatrix', customers, filterSig)
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

/** Headers + rows for matrix export (بله / خالی). */
export function getProductMatrixExportAoa() {
  const catalog = getProductCatalog()
  const headers = ['نام', 'شماره', 'کارشناس', ...catalog, 'بدون محصول']
  const rows = getFilteredProductMatrixCustomers().map(c => {
    const owned = getCustomerOwnedProductNames(c)
    const noProducts = customerHasNoProducts(c)
    return [
      c.name || '',
      getPrimaryPhone(c) || '',
      c.advisor || '',
      ...catalog.map(name => (owned.has(name) ? 'بله' : '')),
      noProducts ? 'بله' : ''
    ]
  })
  return { headers, rows }
}
