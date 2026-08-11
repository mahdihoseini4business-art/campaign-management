// ============================================
// Live sale toast feed (bottom-right stack + Realtime broadcast)
// Design aligned with temporary toast.html mock
// ============================================

import { supabase } from './supabase.js'
import {
  getSaleToastEnabled, setSaleToastEnabledLocal, saveSaleToastEnabled, coerceProductName,
  setRequireFollowupOnCreateLocal
} from './data.js'
import { escapeHtml, formatNumber, requireMainAdmin, userDisplayName, getCurrentUser, normalizePhone } from './utils.js'
import { showBrowserNotificationFromHtml } from './browser-notifications.js'

const CHANNEL_NAME = 'sale-live-toasts'
const TOAST_MS = 5000
const NOTIF_SOUND_URL = '/notif.mp3'
const TOAST_DEDUPE_MS = 5000

let channel = null
let channelReady = null
/** @type {Map<string, number>} */
const recentSaleToastKeys = new Map()
/** @type {Map<string, number>} */
const recentSaleBroadcastKeys = new Map()

function pruneMap(map, now = Date.now()) {
  for (const [k, t] of map) {
    if (now - t > TOAST_DEDUPE_MS) map.delete(k)
  }
}

function saleToastDedupeKey(payload) {
  return [
    payload?.paymentId || '',
    payload?.customerId || '',
    normalizePhone(payload?.sellerPhone) || '',
    String(payload?.amount ?? ''),
    String(payload?.productName ?? '')
  ].join('|')
}

/** Returns true if this is the first claim in the dedupe window. */
function claimKey(map, payload) {
  const key = saleToastDedupeKey(payload)
  if (!key || key === '||||') return true
  const now = Date.now()
  pruneMap(map, now)
  if (map.has(key)) return false
  map.set(key, now)
  return true
}

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

function isRecipientForMe(payload) {
  const phone = normalizePhone(getCurrentUser()?.phone)
  if (!phone) return false
  const list = Array.isArray(payload?.recipientPhones) ? payload.recipientPhones : []
  return list.some(p => normalizePhone(p) === phone)
}

function mountToastCard({ titleHtml, detailsHtml, onOpen, variant = '', notifTag = 'sale-toast' }) {
  const stack = stackEl()
  if (!stack) return

  const toast = document.createElement('div')
  toast.className = `sale-toast-card${variant ? ` ${variant}` : ''}`
  toast.setAttribute('role', 'status')
  toast.innerHTML = `
    <div class="sale-toast-content">
      <div class="sale-toast-title">${titleHtml}</div>
      <div class="sale-toast-details">${detailsHtml}</div>
    </div>
    <button type="button" class="sale-toast-close" aria-label="بستن">&times;</button>
  `

  const closeBtn = toast.querySelector('.sale-toast-close')
  closeBtn?.addEventListener('click', (e) => {
    e.stopPropagation()
    removeSaleToastEl(toast)
  })

  if (typeof onOpen === 'function') {
    toast.style.cursor = 'pointer'
    toast.addEventListener('click', (e) => {
      if (e.target.closest('.sale-toast-close')) return
      removeSaleToastEl(toast)
      onOpen()
    })
  }

  stack.appendChild(toast)
  playNotifSound()
  showBrowserNotificationFromHtml({
    titleHtml,
    detailsHtml,
    tag: notifTag,
    onClick: typeof onOpen === 'function' ? onOpen : undefined
  })

  requestAnimationFrame(() => {
    requestAnimationFrame(() => toast.classList.add('show'))
  })

  const autoCloseTimeout = setTimeout(() => {
    removeSaleToastEl(toast)
  }, TOAST_MS)
  toast.dataset.timeoutId = String(autoCloseTimeout)
}

export function showSaleToast(payload) {
  if (!getSaleToastEnabled()) return
  if (!payload) return

  // Don't notify the seller about their own sale
  const myPhone = normalizePhone(getCurrentUser()?.phone)
  const sellerPhone = normalizePhone(payload.sellerPhone)
  if (myPhone && sellerPhone && myPhone === sellerPhone) return

  if (!claimKey(recentSaleToastKeys, payload)) return

  const seller = (payload.sellerName || '').trim() || 'کارشناس'
  const product = coerceProductName(payload.productName) || 'محصول'
  const amountRial = parseFloat(payload.amount) || 0
  // مبالغ در سیستم به ریال است؛ در توست مطابق دیزاین به تومان نشان داده می‌شود
  const amountToman = amountRial > 0 ? formatNumber(Math.round(amountRial / 10)) : ''

  mountToastCard({
    titleHtml: `⚡ فروش جدید از ${escapeHtml(seller)}`,
    detailsHtml: `${escapeHtml(product)}${amountToman ? ` — <span class="sale-toast-amount">${escapeHtml(amountToman)} تومان</span>` : ''}`,
    notifTag: `sale-${payload.paymentId || payload.at || Date.now()}`
  })
}

/** Toast for recipients of a manual admin notification */
export function showManualNotifToast(payload) {
  if (!payload || !isRecipientForMe(payload)) return

  const title = (payload.title || '').trim() || 'اعلان جدید'
  const sender = (payload.senderName || '').trim() || 'ادمین'

  mountToastCard({
    titleHtml: `🔔 اعلان جدید`,
    detailsHtml: `${escapeHtml(title)} — از ${escapeHtml(sender)}`,
    notifTag: `manual-notif-${payload.id || payload.at || Date.now()}`,
    onOpen: () => {
      import('./notifications.js').then(async (m) => {
        try { await m.refreshNotifications() } catch (_) { /* ignore */ }
        const id = Number(payload.id)
        if (id && typeof m.openNotificationDetail === 'function') {
          m.openNotificationDetail(id)
        } else if (typeof m.toggleNotificationMenu === 'function') {
          await m.toggleNotificationMenu()
        }
      }).catch(() => {})
    }
  })

  import('./notifications.js').then(m => m.refreshNotifications?.()).catch(() => {})
}

function truncateReason(text, maxLen = 72) {
  const s = String(text || '').trim().replace(/\s+/g, ' ')
  if (!s) return ''
  if (s.length <= maxLen) return s
  return `${s.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`
}

/** Toast for the sale registrant when accounting rejects their payment */
export function showPaymentRejectToast(payload) {
  if (!payload) return
  const myPhone = normalizePhone(getCurrentUser()?.phone)
  const targetPhone = normalizePhone(payload.sellerPhone)
  if (!myPhone || !targetPhone || myPhone !== targetPhone) return

  const product = coerceProductName(payload.productName) || 'محصول'
  const customer = (payload.customerName || '').trim() || payload.customerId || ''
  const reason = truncateReason(payload.reason)
  const reasonHtml = reason
    ? `<span class="sale-toast-reject-reason" title="${escapeHtml(String(payload.reason || '').trim())}">${escapeHtml(reason)}</span>`
    : ''

  mountToastCard({
    variant: 'is-reject',
    titleHtml: `⛔ فروش رد شد`,
    detailsHtml: `${escapeHtml(product)}${customer ? ` · ${escapeHtml(customer)}` : ''}${reasonHtml ? ` — ${reasonHtml}` : ''}`,
    notifTag: `payment-reject-${payload.paymentId || payload.at || Date.now()}`
  })
}

async function ensureChannel() {
  if (channel) return channel
  if (channelReady) return channelReady

  channelReady = (async () => {
    const ch = supabase.channel(CHANNEL_NAME, {
      config: { broadcast: { self: false } }
    })
    ch.on('broadcast', { event: 'sale' }, ({ payload }) => {
      showSaleToast(payload)
    })
    ch.on('broadcast', { event: 'manual-notif' }, ({ payload }) => {
      showManualNotifToast(payload)
    })
    ch.on('broadcast', { event: 'payment-reject' }, ({ payload }) => {
      showPaymentRejectToast(payload)
    })
    ch.on('broadcast', { event: 'setting' }, ({ payload }) => {
      if (!payload || typeof payload.enabled !== 'boolean') return
      if (payload.key === 'require_followup_on_create') {
        setRequireFollowupOnCreateLocal(payload.enabled)
        const el = document.getElementById('requireFollowupOnCreate')
        if (el) el.checked = payload.enabled
        return
      }
      // sale_toast_enabled (legacy payloads without key still apply here)
      if (!payload.key || payload.key === 'sale_toast_enabled') {
        setSaleToastEnabledLocal(payload.enabled)
        syncSaleToastToggleUi()
      }
    })
    await new Promise(resolve => {
      ch.subscribe((status) => {
        if (status === 'SUBSCRIBED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') resolve(status)
      })
    })
    channel = ch
    return ch
  })()

  try {
    return await channelReady
  } catch (e) {
    channelReady = null
    channel = null
    throw e
  }
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
  if (!payload) return
  // Prevent double-send when two field saves complete the payment nearly together
  if (!claimKey(recentSaleBroadcastKeys, payload)) return
  try {
    const ch = await ensureChannel()
    await ch.send({ type: 'broadcast', event: 'sale', payload })
  } catch (e) {
    console.error('broadcastSaleToast error:', e)
  }
}

export async function broadcastManualNotifToast(payload) {
  if (!payload) return
  // Show locally only if current user is among recipients
  showManualNotifToast(payload)
  try {
    const ch = await ensureChannel()
    await ch.send({ type: 'broadcast', event: 'manual-notif', payload })
  } catch (e) {
    console.error('broadcastManualNotifToast error:', e)
  }
}

export async function broadcastPaymentRejectToast(payload) {
  if (!payload) return
  // Show locally if current user is the sale registrant
  showPaymentRejectToast(payload)
  try {
    const ch = await ensureChannel()
    await ch.send({ type: 'broadcast', event: 'payment-reject', payload })
  } catch (e) {
    console.error('broadcastPaymentRejectToast error:', e)
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
      await ch.send({
        type: 'broadcast',
        event: 'setting',
        payload: { key: 'sale_toast_enabled', enabled: next }
      })
    } catch (_) { /* ignore realtime sync errors */ }
  } catch (e) {
    console.error('toggleSaleToastSetting error:', e)
    syncSaleToastToggleUi()
  }
}

/** Broadcast a boolean app_settings change to other clients on the sale toast channel. */
export async function broadcastAppSetting(key, enabled) {
  try {
    const ch = await ensureChannel()
    await ch.send({
      type: 'broadcast',
      event: 'setting',
      payload: { key, enabled: !!enabled }
    })
  } catch (_) { /* ignore realtime sync errors */ }
}

/** Build payload from current user + sale context */
export function buildSaleToastPayload({ customer, product, payment }) {
  const user = getCurrentUser()
  return {
    paymentId: payment?.id || '',
    sellerName: userDisplayName(user) || user?.username || '',
    sellerPhone: user?.phone || '',
    customerId: customer?.id || '',
    customerName: customer?.name || '',
    productName: coerceProductName(product?.name),
    amount: payment?.amount || '',
    at: Date.now()
  }
}
