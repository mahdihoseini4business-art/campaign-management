/**
 * Shared UI/helpers for deferred customer products batch load.
 */

import { areProductsReady, getProductsLoadState } from './data.js'

/** @returns {boolean} true when caller should skip full product-dependent render */
export function blockUntilProductsReady(tbody, colSpan, message = 'در حال بارگذاری فروش‌ها…') {
  if (!tbody || areProductsReady()) return false
  const st = getProductsLoadState()
  const pct = st.percent > 0 ? ` (${st.percent}٪)` : ''
  tbody.innerHTML = `<tr><td colspan="${colSpan}"><div class="empty-state"><h3>${message}${pct}</h3><p style="color:var(--text-muted);font-size:13px;margin-top:8px;">لطفاً چند لحظه صبر کنید…</p></div></td></tr>`
  return true
}

/** Dashboard / matrix sheets without a single tbody. */
export function getProductsLoadingBannerHtml(message = 'در حال بارگذاری داده‌های فروش…') {
  if (areProductsReady()) return ''
  const st = getProductsLoadState()
  const pct = st.percent > 0 ? ` — ${st.percent}٪` : ''
  return `<div class="products-load-banner" role="status">${message}${pct}</div>`
}
