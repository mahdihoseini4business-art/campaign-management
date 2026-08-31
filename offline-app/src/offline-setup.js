/** Offline app bootstrap — runs before the shared online UI bundle. */
window.__CARNO_OFFLINE__ = true

function injectOfflineBanner() {
  if (document.getElementById('offlineModeBanner')) return
  const bar = document.createElement('div')
  bar.id = 'offlineModeBanner'
  bar.className = 'offline-mode-banner'
  bar.innerHTML = '<span>نسخه آفلاین — تغییرات روی SQLite محلی ذخیره می‌شوند</span>'
  document.body.prepend(bar)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectOfflineBanner)
} else {
  injectOfflineBanner()
}

// Hide online-only UI bits when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('appUpdateBanner')?.setAttribute('hidden', '')
  document.getElementById('browserNotifBanner')?.setAttribute('hidden', '')

  if (!document.querySelector('script[src*="jalalidatepicker"]')) {
    const s = document.createElement('script')
    s.src = './vendor/jalalidatepicker.min.js'
    s.defer = true
    document.head.appendChild(s)
  }
})
