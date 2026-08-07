// ============================================
// Hybrid live sync: Realtime patch + polling backup
// Customers/followups: single-row patch on postgres_changes
// Polling/visibility: full loadData()
// ============================================

import { supabase } from './supabase.js'
import {
  loadData,
  upsertCustomerInCache,
  removeCustomerFromCache,
  upsertFollowupInCache,
  removeFollowupFromCache
} from './data.js'
import { refreshNotifications, updateNotificationBadge } from './notifications.js'
import { renderCustomers, updateStats } from './customers.js'
import { renderFollowups, updateFollowupBadge } from './followups.js'
import { renderSales } from './sales.js'
import { renderProductMatrix } from './product-matrix.js'
import { renderAccounting } from './accounting.js'
import { renderShipments } from './shipments.js'
import { renderDashboard } from './dashboard.js'
import { updateTransferInboxBadge } from './transfers.js'

const CHANNEL_NAME = 'live-data-sync'
const POLL_MS = 90_000
const VISIBILITY_MIN_GAP_MS = 30_000
const UI_DEBOUNCE_MS = 350
const LOCAL_WRITE_SUPPRESS_MS = 2000

let channel = null
let pollTimer = null
let uiTimer = null
let notifRefreshTimer = null
let refreshingCore = false
let refreshingNotif = false
let lastSyncAt = 0
let localWriteUntil = 0
let started = false
let visibilityHandler = null

/** Call after a successful local DB write to ignore echo events briefly. */
export function noteLocalWrite(ms = LOCAL_WRITE_SUPPRESS_MS) {
  localWriteUntil = Date.now() + Math.max(0, ms)
}

function isLocalWriteSuppressed() {
  return Date.now() < localWriteUntil
}

function getActiveSheet() {
  const sheet = document.querySelector('.sheet.active')
  if (!sheet?.id) return 'dashboard'
  return sheet.id.replace(/^sheet-/, '') || 'dashboard'
}

function isDetailModalOpen() {
  return !!document.getElementById('detailModal')?.classList.contains('active')
}

async function refreshActiveViews() {
  try {
    updateFollowupBadge()
  } catch (e) {
    console.error('updateFollowupBadge error:', e)
  }
  try {
    updateTransferInboxBadge()
  } catch (e) {
    console.error('updateTransferInboxBadge error:', e)
  }
  try {
    updateNotificationBadge()
  } catch (e) {
    console.error('updateNotificationBadge error:', e)
  }

  const tab = getActiveSheet()
  try {
    if (tab === 'followups') {
      renderFollowups()
    } else if (tab === 'sales') {
      await renderSales()
    } else if (tab === 'products') {
      renderProductMatrix()
    } else if (tab === 'accounting') {
      renderAccounting()
    } else if (tab === 'shipments') {
      renderShipments()
    } else if (tab === 'dashboard') {
      await renderDashboard()
    } else {
      // customers (default) — list/stats only; do not rebuild open detail modal
      await renderCustomers()
      updateStats()
    }
  } catch (e) {
    console.error('refreshActiveViews error:', e)
  }

  // If detail is open, leave form as-is (avoid wiping in-progress edits)
  if (isDetailModalOpen()) return
}

function scheduleUiRefresh() {
  if (uiTimer) clearTimeout(uiTimer)
  uiTimer = setTimeout(() => {
    uiTimer = null
    refreshActiveViews()
  }, UI_DEBOUNCE_MS)
}

async function refreshCoreData(reason = 'sync') {
  if (refreshingCore) return
  refreshingCore = true
  try {
    await loadData()
    lastSyncAt = Date.now()
    scheduleUiRefresh()
  } catch (e) {
    console.error(`live-sync core refresh (${reason}) error:`, e)
  } finally {
    refreshingCore = false
  }
}

async function refreshNotifData(reason = 'sync') {
  if (refreshingNotif) return
  refreshingNotif = true
  try {
    await refreshNotifications()
    lastSyncAt = Date.now()
  } catch (e) {
    console.error(`live-sync notif refresh (${reason}) error:`, e)
  } finally {
    refreshingNotif = false
  }
}

function scheduleNotifRefresh(reason) {
  if (notifRefreshTimer) clearTimeout(notifRefreshTimer)
  notifRefreshTimer = setTimeout(() => {
    notifRefreshTimer = null
    refreshNotifData(reason)
  }, UI_DEBOUNCE_MS)
}

async function refreshAll(reason) {
  await Promise.all([
    refreshCoreData(reason),
    refreshNotifData(reason)
  ])
}

function fallbackFullCore(reason) {
  refreshCoreData(reason || 'realtime-fallback')
}

function onCustomerChange(payload) {
  if (isLocalWriteSuppressed()) return
  const event = payload?.eventType || payload?.event
  try {
    if (event === 'DELETE') {
      const id = payload.old?.id
      if (!id || !removeCustomerFromCache(id)) {
        fallbackFullCore('customer-delete')
        return
      }
      lastSyncAt = Date.now()
      scheduleUiRefresh()
      return
    }
    const row = payload.new
    if (!row?.id || !upsertCustomerInCache(row)) {
      fallbackFullCore('customer-upsert')
      return
    }
    lastSyncAt = Date.now()
    scheduleUiRefresh()
  } catch (e) {
    console.error('onCustomerChange error:', e)
    fallbackFullCore('customer-error')
  }
}

function onFollowupChange(payload) {
  if (isLocalWriteSuppressed()) return
  const event = payload?.eventType || payload?.event
  try {
    if (event === 'DELETE') {
      const id = payload.old?.id
      if (id == null || !removeFollowupFromCache(id)) {
        fallbackFullCore('followup-delete')
        return
      }
      lastSyncAt = Date.now()
      scheduleUiRefresh()
      return
    }
    const row = payload.new
    if (row?.id == null || !upsertFollowupInCache(row)) {
      fallbackFullCore('followup-upsert')
      return
    }
    lastSyncAt = Date.now()
    scheduleUiRefresh()
  } catch (e) {
    console.error('onFollowupChange error:', e)
    fallbackFullCore('followup-error')
  }
}

function onRemoteNotifChange() {
  if (isLocalWriteSuppressed()) return
  scheduleNotifRefresh('realtime')
}

async function ensureRealtimeChannel() {
  if (channel) return channel

  channel = supabase
    .channel(CHANNEL_NAME)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'customers' }, onCustomerChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'followups' }, onFollowupChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications' }, onRemoteNotifChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'notification_reads' }, onRemoteNotifChange)

  await new Promise(resolve => {
    channel.subscribe(status => {
      if (status === 'SUBSCRIBED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        if (status !== 'SUBSCRIBED') {
          console.warn('live-sync realtime status:', status)
        }
        resolve(status)
      }
    })
  })

  return channel
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'hidden') return
    refreshAll('poll')
  }, POLL_MS)
}

function onVisibilityChange() {
  if (document.visibilityState !== 'visible') return
  if (Date.now() - lastSyncAt < VISIBILITY_MIN_GAP_MS) return
  refreshAll('visibility')
}

export async function initLiveSync() {
  if (started) return
  started = true
  lastSyncAt = Date.now()

  try {
    await ensureRealtimeChannel()
  } catch (e) {
    console.error('initLiveSync realtime error:', e)
  }

  startPolling()
  visibilityHandler = onVisibilityChange
  document.addEventListener('visibilitychange', visibilityHandler)
}

export function disposeLiveSync() {
  started = false
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (uiTimer) {
    clearTimeout(uiTimer)
    uiTimer = null
  }
  if (notifRefreshTimer) {
    clearTimeout(notifRefreshTimer)
    notifRefreshTimer = null
  }
  if (visibilityHandler) {
    document.removeEventListener('visibilitychange', visibilityHandler)
    visibilityHandler = null
  }
  if (channel) {
    try { supabase.removeChannel(channel) } catch (_) { /* ignore */ }
    channel = null
  }
}

/** Force a full refresh (optional external use). */
export async function refreshFromServer(reason = 'manual') {
  await refreshAll(reason)
}
