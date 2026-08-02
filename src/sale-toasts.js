// ============================================
// Live sale toast feed (bottom-left stack + Realtime broadcast)
// ============================================

import { supabase } from './supabase.js'
import { getSaleToastEnabled, setSaleToastEnabledLocal, saveSaleToastEnabled } from './data.js'
import { escapeHtml, formatNumber, requireMainAdmin, userDisplayName, getCurrentUser } from './utils.js'

const CHANNEL_NAME = 'sale-live-toasts'
const TOAST_MS = 5000
const SLIDE_MS = 380

let channel = null
let toastSeq = 0

function stackEl() {
  return document.getElementById('saleToastStack')
}

export function showSaleToast(payload) {
  if (!getSaleToastEnabled()) return
  const stack = stackEl()
  if (!stack || !payload) return

  const seller = (payload.sellerName || '').trim() || 'کارشناس'
  const product = (payload.productName || '').trim() || 'محصول'
  const customer = (payload.customerName || '').trim() || payload.customerId || 'مشتری'
  const amount = parseFloat(payload.amount) || 0
  const amountLabel = amount > 0 ? `${formatNumber(amount)} ریال` : ''

  const el = document.createElement('div')
  el.className = 'sale-toast'
  el.setAttribute('role', 'status')
  el.dataset.id = String(++toastSeq)
  el.innerHTML = `
    <div class="sale-toast-title">فروش جدید</div>
    <div class="sale-toast-body">
      <span class="sale-toast-seller">${escapeHtml(seller)}</span>
      · ${escapeHtml(product)}
      ${customer ? ` · ${escapeHtml(customer)}` : ''}
      ${amountLabel ? ` · <span class="sale-toast-amount">${escapeHtml(amountLabel)}</span>` : ''}
    </div>
  `

  stack.appendChild(el)
  // Next frame so transition runs from off-screen
  requestAnimationFrame(() => {
    requestAnimationFrame(() => el.classList.add('is-visible'))
  })

  const hideTimer = setTimeout(() => {
    el.classList.remove('is-visible')
    el.classList.add('is-leaving')
    setTimeout(() => {
      el.remove()
    }, SLIDE_MS)
  }, TOAST_MS)

  el.addEventListener('click', () => {
    clearTimeout(hideTimer)
    el.classList.remove('is-visible')
    el.classList.add('is-leaving')
    setTimeout(() => el.remove(), SLIDE_MS)
  })
}

async function ensureChannel() {
  if (channel) return channel
  channel = supabase.channel(CHANNEL_NAME)
  channel.on('broadcast', { event: 'sale' }, ({ payload }) => {
    showSaleToast(payload)
  })
  channel.on('broadcast', { event: 'setting' }, ({ payload }) => {
    if (typeof payload?.enabled === 'boolean') {
      setSaleToastEnabledLocal(payload.enabled)
      syncSaleToastToggleUi()
    }
  })
  await new Promise(resolve => {
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') resolve(status)
    })
  })
  return channel
}

export async function initSaleToastFeed() {
  try {
    await ensureChannel()
  } catch (e) {
    console.error('initSaleToastFeed error:', e)
  }
  syncSaleToastToggleUi()
}

export async function broadcastSaleToast(payload) {
  if (!getSaleToastEnabled()) return
  // Show locally immediately (broadcast does not echo to sender by default)
  showSaleToast(payload)
  try {
    const ch = await ensureChannel()
    await ch.send({ type: 'broadcast', event: 'sale', payload })
  } catch (e) {
    console.error('broadcastSaleToast error:', e)
  }
}

export function syncSaleToastToggleUi() {
  const el = document.getElementById('saleToastEnabled')
  if (el) el.checked = !!getSaleToastEnabled()
}

export async function toggleSaleToastSetting(enabled) {
  if (!requireMainAdmin()) {
    syncSaleToastToggleUi()
    return
  }
  const next = !!enabled
  try {
    await saveSaleToastEnabled(next)
    syncSaleToastToggleUi()
    try {
      const ch = await ensureChannel()
      await ch.send({ type: 'broadcast', event: 'setting', payload: { enabled: next } })
    } catch (_) { /* ignore realtime sync errors */ }
  } catch (e) {
    console.error('toggleSaleToastSetting error:', e)
    syncSaleToastToggleUi()
  }
}

/** Build payload from current user + sale context */
export function buildSaleToastPayload({ customer, product, payment }) {
  const user = getCurrentUser()
  return {
    sellerName: userDisplayName(user) || user?.username || '',
    sellerPhone: user?.phone || '',
    customerId: customer?.id || '',
    customerName: customer?.name || '',
    productName: product?.name || '',
    amount: payment?.amount || '',
    at: Date.now()
  }
}
