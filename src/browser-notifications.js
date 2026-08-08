// ============================================
// Browser Notification API (desktop/OS toasts)
// ============================================

const APP_TITLE = 'CARNO'
const ICON_URL = '/icon.webp'
const BANNER_DISMISS_KEY = 'cm-browser-notif-banner-dismissed'

export function isNotificationSupported() {
  return typeof window !== 'undefined' && 'Notification' in window
}

/** @returns {'unsupported' | 'default' | 'granted' | 'denied'} */
export function getNotificationPermission() {
  if (!isNotificationSupported()) return 'unsupported'
  return Notification.permission
}

export async function requestBrowserNotificationPermission() {
  if (!isNotificationSupported()) return 'unsupported'
  if (Notification.permission === 'granted') return 'granted'
  if (Notification.permission === 'denied') return 'denied'
  try {
    const result = await Notification.requestPermission()
    syncBrowserNotifUi()
    if (result === 'granted') hideBrowserNotifBanner()
    return result
  } catch (e) {
    console.error('requestBrowserNotificationPermission error:', e)
    return Notification.permission
  }
}

function htmlToPlainText(html) {
  if (!html) return ''
  const d = document.createElement('div')
  d.innerHTML = String(html)
  return (d.textContent || '').replace(/\s+/g, ' ').trim()
}

export function showBrowserNotification({ title, body, tag, onClick } = {}) {
  if (!isNotificationSupported()) return false
  if (Notification.permission !== 'granted') return false

  const t = String(title || APP_TITLE).trim() || APP_TITLE
  const b = String(body || '').replace(/\s+/g, ' ').trim()
  if (!t && !b) return false

  try {
    const n = new Notification(t, {
      body: b,
      icon: ICON_URL,
      badge: ICON_URL,
      lang: 'fa',
      dir: 'rtl',
      tag: tag || undefined
    })
    n.onclick = () => {
      try { window.focus() } catch (_) { /* ignore */ }
      try { n.close() } catch (_) { /* ignore */ }
      if (typeof onClick === 'function') {
        try { onClick() } catch (_) { /* ignore */ }
      }
    }
    return true
  } catch (e) {
    console.error('showBrowserNotification error:', e)
    return false
  }
}

export function showBrowserNotificationFromHtml({ titleHtml, detailsHtml, tag, onClick } = {}) {
  return showBrowserNotification({
    title: htmlToPlainText(titleHtml) || APP_TITLE,
    body: htmlToPlainText(detailsHtml),
    tag,
    onClick
  })
}

function isBannerDismissed() {
  try {
    return localStorage.getItem(BANNER_DISMISS_KEY) === '1'
  } catch (_) {
    return false
  }
}

function hideBrowserNotifBanner() {
  const el = document.getElementById('browserNotifBanner')
  if (!el) return
  el.hidden = true
  el.classList.remove('is-visible')
}

function showBrowserNotifBanner() {
  const el = document.getElementById('browserNotifBanner')
  if (!el) return
  el.hidden = false
  el.classList.add('is-visible')
}

export function dismissBrowserNotifBanner() {
  try { localStorage.setItem(BANNER_DISMISS_KEY, '1') } catch (_) { /* ignore */ }
  hideBrowserNotifBanner()
}

export function initBrowserNotifications() {
  syncBrowserNotifUi()
  const perm = getNotificationPermission()
  if (perm === 'default' && !isBannerDismissed()) showBrowserNotifBanner()
  else hideBrowserNotifBanner()

  if (navigator.permissions?.query) {
    navigator.permissions.query({ name: 'notifications' }).then(status => {
      status.onchange = () => {
        syncBrowserNotifUi()
        if (getNotificationPermission() !== 'default') hideBrowserNotifBanner()
      }
    }).catch(() => { /* Safari / unsupported */ })
  }
}

export function syncBrowserNotifUi() {
  const perm = getNotificationPermission()
  const statusEl = document.getElementById('browserNotifStatus')
  const enableBtn = document.getElementById('browserNotifEnableBtn')
  const hintEl = document.getElementById('browserNotifHint')
  const profileLabel = document.getElementById('browserNotifProfileLabel')

  const labels = {
    unsupported: 'پشتیبانی نمی‌شود',
    granted: 'فعال',
    denied: 'مسدود شده',
    default: 'فعال نشده'
  }

  if (statusEl) {
    statusEl.textContent = labels[perm] || labels.default
    statusEl.dataset.state = perm
  }

  if (enableBtn) {
    const canPrompt = perm === 'default'
    enableBtn.hidden = perm === 'granted' || perm === 'unsupported'
    enableBtn.disabled = !canPrompt
    enableBtn.textContent = perm === 'denied' ? 'مسدود در مرورگر' : 'فعال‌سازی اعلان مرورگر'
  }

  if (hintEl) {
    if (perm === 'denied') {
      hintEl.hidden = false
      hintEl.textContent = 'اجازه از تنظیمات مرورگر برای این سایت مسدود شده. از آیکون قفل کنار نوار آدرس، اعلان‌ها را مجاز کنید.'
    } else if (perm === 'unsupported') {
      hintEl.hidden = false
      hintEl.textContent = 'این مرورگر از اعلان دسکتاپ پشتیبانی نمی‌کند.'
    } else {
      hintEl.hidden = true
      hintEl.textContent = ''
    }
  }

  if (profileLabel) {
    profileLabel.textContent = perm === 'granted'
      ? 'اعلان مرورگر فعال است'
      : perm === 'denied'
        ? 'اعلان مرورگر مسدود است'
        : 'فعال‌سازی اعلان مرورگر'
  }
}
