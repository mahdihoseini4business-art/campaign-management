// ============================================
// Frontend version check — soft update banner
// ============================================

const CHECK_MS = 60_000
const VERSION_URL = '/version.json'

let currentVersion = null
let bannerShown = false
let pollTimer = null
let visibilityHandler = null
let started = false

async function fetchVersion() {
  const url = `${VERSION_URL}?t=${Date.now()}`
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`version fetch ${res.status}`)
  const data = await res.json()
  const v = data?.version
  if (v == null || v === '') throw new Error('version missing')
  return String(v)
}

function showUpdateBanner() {
  if (bannerShown) return
  const banner = document.getElementById('appUpdateBanner')
  if (!banner) return
  banner.hidden = false
  banner.classList.add('is-visible')
  bannerShown = true
}

function hideUpdateBanner() {
  const banner = document.getElementById('appUpdateBanner')
  if (!banner) return
  banner.hidden = true
  banner.classList.remove('is-visible')
}

async function checkForUpdate() {
  try {
    const remote = await fetchVersion()
    if (currentVersion == null) {
      currentVersion = remote
      return
    }
    if (remote !== currentVersion) {
      showUpdateBanner()
    }
  } catch (e) {
    console.warn('app-update check failed:', e)
  }
}

export function reloadForUpdate() {
  location.reload()
}

export async function initAppUpdate() {
  if (started) return
  started = true

  const reloadBtn = document.getElementById('appUpdateReloadBtn')
  reloadBtn?.addEventListener('click', reloadForUpdate)

  hideUpdateBanner()

  try {
    currentVersion = await fetchVersion()
  } catch (e) {
    console.warn('app-update initial version failed:', e)
    currentVersion = null
  }

  if (pollTimer) clearInterval(pollTimer)
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'hidden') return
    checkForUpdate()
  }, CHECK_MS)

  visibilityHandler = () => {
    if (document.visibilityState === 'visible') checkForUpdate()
  }
  document.addEventListener('visibilitychange', visibilityHandler)
}
