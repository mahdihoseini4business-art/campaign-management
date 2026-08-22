import {
  getData,
  getProductCatalogNames,
  getCustomerOwnedProductNames,
  customerHasNoProducts
} from './data.js'
import { getUsersSafe } from './auth.js'
import {
  toEnDigits,
  escapeHtml,
  escapeAttr,
  hasPermission,
  getCurrentUser,
  matchesTabSearch,
  getCustomerPhones,
  getPrimaryPhone,
  normalizePhone,
  userDisplayName
} from './utils.js'
import { paginateList, renderPaginationBar } from './pagination.js'
import { toggleSortField, sortRecords, syncSortHeaders, sortSig, sortThHtml } from './table-sort.js'
import { runWithSearchOverlay, SEARCH_HOST } from './search-overlay.js'

const MARK_YES = '✅'
const NONE_KEY = '__none__'

/** Coerce catalog entries or raw names to clean string names. */
function resolveCatalogNames(list) {
  return (list || [])
    .map(item => {
      if (typeof item === 'string') return item.trim()
      if (item && typeof item === 'object') return String(item.name || '').trim()
      return ''
    })
    .filter(n => n && n.toLowerCase() !== '[object object]')
}

/** @type {Record<string, 'both' | 'has' | 'missing'>} */
const productFilterState = {}

/** @type {Set<string>|null} null = همه کارشناسان */
let selectedAdvisorPhones = null
/** @type {{ phone: string, name: string }[]} */
let advisorOptionsCache = []
let advisorDropdownOpen = false
let advisorOutsideClickBound = false
let productMatrixSortState = { field: null, asc: true }

function getFilterMode(key) {
  return productFilterState[key] || 'both'
}

function filterHeaderClass(mode) {
  if (mode === 'has') return ' product-matrix-filter-has'
  if (mode === 'missing') return ' product-matrix-filter-missing'
  return ''
}

function hasActiveAdvisorFilter() {
  if (!selectedAdvisorPhones) return false
  if (!advisorOptionsCache.length) return false
  return selectedAdvisorPhones.size < advisorOptionsCache.length
}

function syncClearFiltersButton() {
  const btn = document.getElementById('clearProductMatrixFiltersBtn')
  if (!btn) return
  const activeProducts = Object.values(productFilterState).some(m => m && m !== 'both')
  btn.hidden = !(activeProducts || hasActiveAdvisorFilter())
}

function updateAdvisorFilterCount() {
  const el = document.getElementById('productMatrixAdvisorCount')
  if (!el) return
  if (!hasActiveAdvisorFilter()) {
    el.textContent = ''
    return
  }
  el.textContent = `(${selectedAdvisorPhones.size}/${advisorOptionsCache.length})`
}

async function ensureAdvisorOptions() {
  // Only advisors who currently own at least one customer
  const phonesWithCustomers = new Map()
  for (const c of getData().customers || []) {
    const phone = normalizePhone(c.advisorPhone)
    if (!phone || phonesWithCustomers.has(phone)) continue
    phonesWithCustomers.set(phone, c.advisor || phone)
  }

  const userNameByPhone = new Map()
  for (const u of await getUsersSafe()) {
    const phone = normalizePhone(u.phone)
    if (!phone) continue
    userNameByPhone.set(phone, userDisplayName(u) || u.username || phone)
  }

  advisorOptionsCache = [...phonesWithCustomers.entries()]
    .map(([phone, fallbackName]) => ({
      phone,
      name: userNameByPhone.get(phone) || fallbackName
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'fa'))

  if (selectedAdvisorPhones) {
    const valid = new Set(advisorOptionsCache.map(a => a.phone))
    selectedAdvisorPhones = new Set([...selectedAdvisorPhones].filter(p => valid.has(p)))
    if (selectedAdvisorPhones.size === advisorOptionsCache.length) {
      selectedAdvisorPhones = null
    }
  }
}

function buildAdvisorDropdownHtml() {
  const allSelected = !hasActiveAdvisorFilter()
  const options = advisorOptionsCache.map(a => {
    const checked = allSelected || selectedAdvisorPhones.has(a.phone)
    return `<label class="product-matrix-advisor-option">
      <input type="checkbox" class="product-matrix-advisor-cb" value="${escapeAttr(a.phone)}"${checked ? ' checked' : ''} onchange="app.toggleProductMatrixAdvisor('${escapeAttr(a.phone)}', this.checked)">
      <span>${escapeHtml(a.name)}</span>
    </label>`
  }).join('')

  return `
    <label class="product-matrix-advisor-option product-matrix-advisor-option-all">
      <input type="checkbox" id="productMatrixAdvisorSelectAll"${allSelected ? ' checked' : ''} onchange="app.toggleProductMatrixAdvisorsAll(this.checked)">
      <span>همه کارشناسان</span>
    </label>
    <div class="product-matrix-advisor-options">${options || '<div class="product-matrix-advisor-empty">کارشناسی یافت نشد</div>'}</div>`
}

/**
 * Customers visible in the product matrix (search + column filters).
 * Org-wide: everyone with products_matrix sees all customers.
 * Exported for CSV/Excel.
 */
export function getFilteredProductMatrixCustomers() {
  const data = getData()
  const search = toEnDigits(document.getElementById('searchProductMatrix')?.value || '').toLowerCase()
  const catalog = resolveCatalogNames(getProductCatalogNames())
  const advisorFilterActive = hasActiveAdvisorFilter()

  return applyProductMatrixSort((data.customers || []).filter(c => {
    if (advisorFilterActive) {
      const owner = normalizePhone(c.advisorPhone)
      if (!owner || !selectedAdvisorPhones.has(owner)) return false
    }

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
  }))
}

function productMatrixSortValue(c, field) {
  if (field === 'phone') return { value: getPrimaryPhone(c) || '', type: 'text' }
  return { value: c[field] ?? '', type: 'text' }
}

function applyProductMatrixSort(list) {
  if (!productMatrixSortState.field) return list
  return sortRecords(list, productMatrixSortState, productMatrixSortValue)
}

export function sortProductMatrix(field) {
  toggleSortField(productMatrixSortState, field)
  renderProductMatrix()
}

export function hasActiveProductMatrixFilter() {
  const search = document.getElementById('searchProductMatrix')?.value?.trim()
  if (search) return true
  if (hasActiveAdvisorFilter()) return true
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
  selectedAdvisorPhones = null
  advisorDropdownOpen = false
  renderProductMatrix()
}

export function toggleProductMatrixAdvisorDropdown(event) {
  event?.stopPropagation?.()
  advisorDropdownOpen = !advisorDropdownOpen
  const dd = document.getElementById('productMatrixAdvisorDropdown')
  const btn = event?.currentTarget || document.querySelector('.product-matrix-advisor-btn')
  if (!dd) return
  if (!advisorDropdownOpen) {
    dd.hidden = true
    dd.classList.remove('is-fixed')
    return
  }
  dd.hidden = false
  // Escape overflow clipping of .table-wrapper
  if (btn && typeof btn.getBoundingClientRect === 'function') {
    const rect = btn.getBoundingClientRect()
    dd.classList.add('is-fixed')
    dd.style.position = 'fixed'
    dd.style.top = `${Math.round(rect.bottom + 4)}px`
    dd.style.right = `${Math.round(window.innerWidth - rect.right)}px`
    dd.style.left = 'auto'
  }
  bindAdvisorOutsideClick()
}

export function toggleProductMatrixAdvisor(phone, checked) {
  const p = normalizePhone(phone)
  if (!p) return
  if (!selectedAdvisorPhones) {
    selectedAdvisorPhones = new Set(advisorOptionsCache.map(a => a.phone))
  }
  if (checked) selectedAdvisorPhones.add(p)
  else selectedAdvisorPhones.delete(p)
  if (selectedAdvisorPhones.size === advisorOptionsCache.length) {
    selectedAdvisorPhones = null
  }
  renderProductMatrix()
}

export function toggleProductMatrixAdvisorsAll(checked) {
  selectedAdvisorPhones = checked
    ? null
    : new Set()
  renderProductMatrix()
}

function bindAdvisorOutsideClick() {
  if (advisorOutsideClickBound) return
  advisorOutsideClickBound = true
  document.addEventListener('click', (e) => {
    const wrap = document.getElementById('productMatrixAdvisorFilter')
    const dd = document.getElementById('productMatrixAdvisorDropdown')
    if (wrap?.contains(e.target) || dd?.contains(e.target)) return
    if (!advisorDropdownOpen) return
    advisorDropdownOpen = false
    if (dd) {
      dd.hidden = true
      dd.classList.remove('is-fixed')
    }
  })
}

function markCell(has) {
  if (!has) return '<td class="product-matrix-mark"></td>'
  return `<td class="product-matrix-mark product-matrix-yes">${MARK_YES}</td>`
}

export function onProductMatrixSearchInput() {
  return runWithSearchOverlay(SEARCH_HOST.products, () => renderProductMatrix())
}

export async function renderProductMatrix() {
  if (!hasPermission('products_matrix')) return

  const thead = document.getElementById('productMatrixHead')
  const tbody = document.getElementById('productMatrixBody')
  if (!thead || !tbody) return

  await ensureAdvisorOptions()

  const catalog = resolveCatalogNames(getProductCatalogNames())
  const search = toEnDigits(document.getElementById('searchProductMatrix')?.value || '').toLowerCase()
  const advisorSig = hasActiveAdvisorFilter()
    ? [...selectedAdvisorPhones].sort().join(',')
    : ''
  const filterSig = `${search}|${JSON.stringify(productFilterState)}|${advisorSig}|${sortSig(productMatrixSortState)}`
  const customers = getFilteredProductMatrixCustomers()

  const noneMode = getFilterMode(NONE_KEY)
  const advisorActiveClass = hasActiveAdvisorFilter() ? ' is-filtered' : ''
  thead.innerHTML = `
    <tr>
      ${sortThHtml({ field: 'name', label: 'نام مشتری', handler: "app.sortProductMatrixHeader('name')", extraClass: 'product-matrix-sticky product-matrix-col-name' })}
      ${sortThHtml({ field: 'phone', label: 'شماره مشتری', handler: "app.sortProductMatrixHeader('phone')", extraClass: 'product-matrix-sticky product-matrix-col-phone' })}
      <th class="product-matrix-sticky product-matrix-col-advisor sort-th" data-sort-field="advisor" aria-sort="none" id="productMatrixAdvisorFilter">
        <button type="button" class="sort-th-btn" aria-label="مرتب‌سازی بر اساس کارشناس" onclick="app.sortProductMatrixHeader('advisor')">کارشناس</button>
        <button type="button" class="product-matrix-advisor-btn${advisorActiveClass}" onclick="app.toggleProductMatrixAdvisorDropdown(event)" aria-label="فیلتر کارشناس" title="فیلتر کارشناس">
          ▾ <span class="product-matrix-advisor-count" id="productMatrixAdvisorCount"></span>
        </button>
        <div class="product-matrix-advisor-dropdown" id="productMatrixAdvisorDropdown"${advisorDropdownOpen ? '' : ' hidden'} onclick="event.stopPropagation()">
          ${buildAdvisorDropdownHtml()}
        </div>
      </th>
      ${catalog.map(name => {
        const mode = getFilterMode(name)
        return `<th class="product-matrix-product-col product-matrix-filterable${filterHeaderClass(mode)}" title="${escapeAttr(name)} — کلیک برای فیلتر" onclick="app.cycleProductMatrixFilter('${escapeAttr(name)}')"><span>${escapeHtml(name)}</span></th>`
      }).join('')}
      <th class="product-matrix-none-col product-matrix-product-col product-matrix-filterable${filterHeaderClass(noneMode)}" title="بدون محصول — کلیک برای فیلتر" onclick="app.cycleProductMatrixFilter('${escapeAttr(NONE_KEY)}')"><span>بدون محصول</span></th>
    </tr>`
  syncSortHeaders(thead, productMatrixSortState)

  updateAdvisorFilterCount()
  syncClearFiltersButton()
  bindAdvisorOutsideClick()

  if (advisorDropdownOpen) {
    const dd = document.getElementById('productMatrixAdvisorDropdown')
    const btn = document.querySelector('.product-matrix-advisor-btn')
    if (dd && btn) {
      dd.hidden = false
      const rect = btn.getBoundingClientRect()
      dd.classList.add('is-fixed')
      dd.style.position = 'fixed'
      dd.style.top = `${Math.round(rect.bottom + 4)}px`
      dd.style.right = `${Math.round(window.innerWidth - rect.right)}px`
      dd.style.left = 'auto'
    }
  }

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
  const catalog = resolveCatalogNames(getProductCatalogNames())
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
