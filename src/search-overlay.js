/** Table/list search loading overlay — keeps stale rows visible but clearly "busy". */

export const SEARCH_HOST = {
  customers: '#customersSearchHost',
  followups: '#followupsSearchHost',
  sales: '#salesSearchHost',
  products: '#productsSearchHost',
  accounting: '#accountingSearchHost',
  shipments: '#shipmentsSearchHost',
  refunds: '#refundsSearchHost',
}

const OVERLAY_CLASS = 'table-search-overlay'
/** @type {Map<string|Element, number>} */
const overlayGeneration = new Map()

function resolveHost(hostOrSelector) {
  if (!hostOrSelector) return null
  if (typeof hostOrSelector === 'string') return document.querySelector(hostOrSelector)
  return hostOrSelector
}

function hostKey(hostOrSelector) {
  return hostOrSelector
}

function bumpGeneration(hostOrSelector) {
  const key = hostKey(hostOrSelector)
  const next = (overlayGeneration.get(key) || 0) + 1
  overlayGeneration.set(key, next)
  return next
}

function isCurrentGeneration(hostOrSelector, gen) {
  return overlayGeneration.get(hostKey(hostOrSelector)) === gen
}

function ensureOverlay(host) {
  if (!host) return null
  host.classList.add('list-search-host')
  let el = host.querySelector(`:scope > .${OVERLAY_CLASS}`)
  if (!el) {
    el = document.createElement('div')
    el.className = OVERLAY_CLASS
    el.hidden = true
    el.setAttribute('role', 'status')
    el.setAttribute('aria-live', 'polite')
    el.innerHTML = `
      <div class="table-search-overlay-inner">
        <div class="table-search-overlay-spinner" aria-hidden="true"></div>
        <div class="table-search-overlay-title">در حال جستجو…</div>
        <div class="table-search-overlay-detail">لطفاً کمی صبر کنید</div>
      </div>
    `
    host.insertBefore(el, host.firstChild)
  }
  return el
}

/** Show overlay immediately (e.g. at start of debounce). Returns generation token. */
export function showSearchOverlay(hostOrSelector) {
  const gen = bumpGeneration(hostOrSelector)
  const host = resolveHost(hostOrSelector)
  const el = ensureOverlay(host)
  if (!el || !host) return gen
  el.hidden = false
  host.setAttribute('aria-busy', 'true')
  return gen
}

export function hideSearchOverlay(hostOrSelector, gen = null) {
  if (gen != null && !isCurrentGeneration(hostOrSelector, gen)) return
  const host = resolveHost(hostOrSelector)
  if (!host) return
  const el = host.querySelector(`:scope > .${OVERLAY_CLASS}`)
  if (el) el.hidden = true
  host.removeAttribute('aria-busy')
}

/** Yield so the overlay can paint before heavy sync filter/render work. */
function paintFrame() {
  return new Promise(resolve => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve())
    })
  })
}

/**
 * Show search overlay, let it paint, run render, then hide.
 * @param {string|Element} hostOrSelector
 * @param {() => (void|Promise<void>)} fn
 */
export async function runWithSearchOverlay(hostOrSelector, fn) {
  const gen = showSearchOverlay(hostOrSelector)
  await paintFrame()
  try {
    return await fn()
  } finally {
    hideSearchOverlay(hostOrSelector, gen)
  }
}
