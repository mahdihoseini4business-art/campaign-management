import { jalaliToNum, formatSoldAt24h, escapeHtml, escapeAttr } from './utils.js'

export function toggleSortField(state, field, defaultAsc = true) {
  if (state.field === field) state.asc = !state.asc
  else {
    state.field = field
    state.asc = defaultAsc
  }
  return state
}

export function compareSortValues(va, vb, type = 'text') {
  if (type === 'number' || type === 'order' || type === 'iso') {
    const na = type === 'iso' ? Date.parse(va || 0) : Number(va)
    const nb = type === 'iso' ? Date.parse(vb || 0) : Number(vb)
    const aEmpty = va == null || va === '' || Number.isNaN(na)
    const bEmpty = vb == null || vb === '' || Number.isNaN(nb)
    if (aEmpty && bEmpty) return 0
    if (aEmpty) return 1
    if (bEmpty) return -1
    return na - nb
  }
  if (type === 'date') return jalaliToNum(va) - jalaliToNum(vb)
  if (type === 'datetime') {
    const sa = formatSoldAt24h(va) || String(va || '')
    const sb = formatSoldAt24h(vb) || String(vb || '')
    if (!sa && !sb) return 0
    if (!sa) return 1
    if (!sb) return -1
    return sa.localeCompare(sb, 'en')
  }
  return String(va ?? '').localeCompare(String(vb ?? ''), 'fa')
}

function unwrapSortValue(raw) {
  if (raw && typeof raw === 'object' && 'value' in raw) return raw
  return { value: raw, type: typeof raw === 'number' ? 'number' : 'text' }
}

export function sortRecords(list, state, getValue) {
  if (!state?.field) return list
  const dir = state.asc ? 1 : -1
  return [...list].sort((a, b) => {
    const left = unwrapSortValue(getValue(a, state.field))
    const right = unwrapSortValue(getValue(b, state.field))
    const type = left.type || right.type || 'text'
    return compareSortValues(left.value, right.value, type) * dir
  })
}

export function sortThHtml({ field, label, handler, extraClass = '', style = '', btnClass = '' }) {
  const cls = ['sort-th', extraClass].filter(Boolean).join(' ')
  const styleAttr = style ? ` style="${style}"` : ''
  const btnCls = ['sort-th-btn', btnClass].filter(Boolean).join(' ')
  return `<th class="${cls}" data-sort-field="${escapeAttr(field)}" aria-sort="none"${styleAttr}><button type="button" class="${btnCls}" aria-label="مرتب‌سازی بر اساس ${escapeAttr(label)}" onclick="${handler}">${escapeHtml(label)}</button></th>`
}

export function syncSortHeaders(root, state) {
  const scope = typeof root === 'string' ? document.querySelector(root) : root
  if (!scope) return
  scope.querySelectorAll('th.sort-th').forEach(th => {
    const field = th.dataset.sortField
    const active = !!(state?.field && state.field === field)
    th.classList.toggle('is-sorted', active)
    th.classList.toggle('is-asc', active && state.asc)
    th.classList.toggle('is-desc', active && !state.asc)
    th.setAttribute('aria-sort', active
      ? (state.asc ? 'ascending' : 'descending')
      : 'none')
  })
}

export function sortSig(state) {
  return state?.field ? `${state.field}:${state.asc ? 'asc' : 'desc'}` : ''
}
