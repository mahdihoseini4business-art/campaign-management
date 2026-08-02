// ============================================
// Live sale toast feed (bottom-right stack + Realtime broadcast)
// Design aligned with temporary toast.html mock
// ============================================

import { supabase } from './supabase.js'
import { getSaleToastEnabled, setSaleToastEnabledLocal, saveSaleToastEnabled } from './data.js'
import { escapeHtml, formatNumber, requireMainAdmin, userDisplayName, getCurrentUser } from './utils.js'

const CHANNEL_NAME = 'sale-live-toasts'
const TOAST_MS = 5000
const NOTIF_SOUND_URL = '/notif.mp3'

let channel = null

function stackEl() {
  return document.getElementById('saleToastStack')
}

function playNotifSound() {
  try {
    const audio = new Audio(NOTIF_SOUND_URL)
    audio.play().catch(() => { /* autoplay may be blocked until user gesture */ })
  } catch (_) { /* ignore */ }
}

function removeSaleToastEl(toast) {
  if (!toast || toast.dataset.removing === '1') return
  toast.dataset.removing = '1'
  const timeoutId = Number(toast.dataset.timeoutId || 0)
  if (timeoutId) clearTimeout(timeoutId)
  toast.classList.remove('show')
  const onEnd = (e) => {
    if (e && e.target !== toast) return
    toast.removeEventListener('transitionend', onEnd)
    toast.remove()
  }
  toast.addEventListener('transitionend', onEnd)
  // Fallback if transitionend doesn't fire
  setTimeout(() => {
    if (toast.isConnected) toast.remove()
  }, 400)
}

export function showSaleToast(payload) {
  if (!getSaleToastEnabled()) return
  const stack = stackEl()
  if (!stack || !payload) return

  const seller = (payload.sellerName || '').trim() || 'کارشناس'
  const product = (payload.productName || '').trim() || 'محصول'
  const amountRial = parseFloat(payload.amount) || 0
  // مبالغ در سیستم به ریال است؛ در توست مطابق دیزاین به تومان نشان داده می‌شود
  const amountToman = amountRial > 0 ? formatNumber(Math.round(amountRial / 10)) : ''

  const toast = document.createElement('div')
  toast.className = 'sale-toast-card'
  toast.setAttribute('role', 'status')
  toast.innerHTML = `
    <div class="sale-toast-content">
      <div class="sale-toast-title">⚡ فروش جدید از ${escapeHtml(seller)}</div>
      <div class="sale-toast-details">
        ${escapeHtml(product)}${amountToman ? ` — <span class="sale-toast-amount">${escapeHtml(amountToman)} تومان</span>` : ''}
      </div>
    </div>
    <button type="button" class="sale-toast-close" aria-label="بستن">&times;</button>
  `

  const closeBtn = toast.querySelector('.sale-toast-close')
  closeBtn?.addEventListener('click', (e) => {
    e.stopPropagation()
    removeSaleToastEl(toast)
  })

  stack.appendChild(toast)
  playNotifSound()

  requestAnimationFrame(() => {
    requestAnimationFrame(() => toast.classList.add('show'))
  })

  const autoCloseTimeout = setTimeout(() => {
    removeSaleToastEl(toast)
  }, TOAST_MS)
  toast.dataset.timeoutId = String(autoCloseTimeout)
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
