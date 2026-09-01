export const PAGE_SIZE = 20

const pages = {}
const filterSigs = {}

export function paginateList(key, items, filterSig = '') {
  if (filterSigs[key] !== filterSig) {
    pages[key] = 1
    filterSigs[key] = filterSig
  }

  const total = items.length
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  let page = pages[key] || 1
  if (page > totalPages) page = totalPages
  if (page < 1) page = 1
  pages[key] = page

  const start = total === 0 ? 0 : (page - 1) * PAGE_SIZE
  return {
    items: items.slice(start, start + PAGE_SIZE),
    page,
    totalPages,
    total,
    from: total === 0 ? 0 : start + 1,
    to: Math.min(start + PAGE_SIZE, total)
  }
}

export function setPage(key, page) {
  pages[key] = Math.max(1, page)
}

export function getPage(key) {
  return pages[key] || 1
}

function buildPageButtons(current, total) {
  if (total <= 1) return []
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => ({ type: 'page', num: i + 1 }))
  }

  const nums = new Set([1, total, current, current - 1, current + 1, current - 2, current + 2])
  const sorted = [...nums].filter(n => n >= 1 && n <= total).sort((a, b) => a - b)
  const result = []
  let prev = 0
  for (const n of sorted) {
    if (n - prev > 1) result.push({ type: 'ellipsis' })
    result.push({ type: 'page', num: n })
    prev = n
  }
  return result
}

export function renderPaginationBar(containerId, key, meta) {
  const el = document.getElementById(containerId)
  if (!el) return

  if (meta.total === 0) {
    el.innerHTML = ''
    return
  }

  const buttons = buildPageButtons(meta.page, meta.totalPages)
  const numsHtml = buttons.map(b => {
    if (b.type === 'ellipsis') return '<span class="pagination-ellipsis">…</span>'
    const active = b.num === meta.page ? ' active' : ''
    return `<button type="button" class="pagination-num${active}" onclick="app.goToPage('${key}', ${b.num})">${b.num}</button>`
  }).join('')

  const prevDisabled = meta.page <= 1 ? ' disabled' : ''
  const nextDisabled = meta.page >= meta.totalPages ? ' disabled' : ''

  el.innerHTML = `
    <div class="pagination-bar">
      <span class="pagination-info">نمایش ${meta.from} تا ${meta.to} از ${meta.total}</span>
      <div class="pagination-controls">
        <button type="button" class="pagination-btn"${prevDisabled} onclick="app.goToPage('${key}', ${meta.page - 1})">قبلی</button>
        <div class="pagination-nums">${numsHtml}</div>
        <button type="button" class="pagination-btn"${nextDisabled} onclick="app.goToPage('${key}', ${meta.page + 1})">بعدی</button>
      </div>
    </div>`
}
