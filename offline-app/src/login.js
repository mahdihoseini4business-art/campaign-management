import { BACKUP_FORMAT_VERSION, BACKUP_TABLES, BACKUP_MANIFEST_PATH } from '@backup/constants.js'
import { validateManifest, BackupFormatError, isScopedBackupManifest } from '@backup/backup-format.js'
import { unzipSync, strFromU8 } from 'fflate'
import { setCurrentUser, toEnDigits } from '@online-src/utils.js'

const TABLE_LABELS = {
  customers: 'مشتری',
  followups: 'پیگیری',
  refunds: 'عودت',
  users: 'کاربر'
}

function el(id) {
  return document.getElementById(id)
}

function showError(msg) {
  const box = el('loginError')
  if (!box) return
  box.hidden = !msg
  box.textContent = msg || ''
}

function showNotice(msg) {
  const box = el('loginNotice')
  if (!box) return
  box.hidden = !msg
  box.textContent = msg || ''
}

function parseBackupPreview(bytes) {
  const unzipped = unzipSync(bytes)
  const manifestRaw = unzipped[BACKUP_MANIFEST_PATH]
  if (!manifestRaw) throw new BackupFormatError('manifest.json یافت نشد.')
  return validateManifest(JSON.parse(strFromU8(manifestRaw)))
}

async function initState() {
  if (!window.offlineApi) {
    showNotice('این صفحه باید در اپ Electron اجرا شود.')
    return
  }

  const { hasData, userCount } = await window.offlineApi.hasData()
  const importPanel = el('importPanel')
  const loginForm = el('loginForm')
  const setupPanel = el('setupPasswordPanel')

  if (!hasData) {
    importPanel.hidden = false
    loginForm.hidden = true
    setupPanel.hidden = true
    return
  }

  importPanel.hidden = true
  loginForm.hidden = false
  setupPanel.hidden = false
  showNotice(`${userCount.toLocaleString('fa-IR')} کاربر در پایگاه داده محلی — پس از ایمپورت، رمز آفلاین را تنظیم کنید.`)
}

async function handleImport() {
  const status = el('importStatus')
  showError('')
  const filePath = await window.offlineApi.pickBackupFile()
  if (!filePath) return

  try {
    status.hidden = false
    status.textContent = 'در حال خواندن فایل…'
    const bytes = await window.offlineApi.readBackupFile(filePath)
    const manifest = parseBackupPreview(new Uint8Array(bytes))
    status.textContent = 'در حال ایمپورت…'

    const result = await window.offlineApi.importBackup({ filePath, replace: true })
    const counts = result?.imported || manifest.tableCounts || {}
    const summary = BACKUP_TABLES.slice(0, 4)
      .map(t => `${TABLE_LABELS[t] || t}: ${counts[t] ?? 0}`)
      .join(' · ')

    status.textContent = `ایمپورت موفق — ${summary}`
    if (isScopedBackupManifest(manifest)) {
      const scopedUser = manifest.scope?.username || '—'
      showNotice(`بکاپ شخصی (${scopedUser}) — نام کاربری همان آنلاین است؛ از «تنظیم رمز آفلاین» یک رمز جدید بگذارید.`)
    }
    await initState()
  } catch (err) {
    status.hidden = false
    status.textContent = ''
    showError('خطا در ایمپورت: ' + (err?.message || String(err)))
  }
}

async function handleLogin(event) {
  event.preventDefault()
  showError('')

  const username = toEnDigits(el('loginUsername').value.trim())
  const password = toEnDigits(el('loginPassword').value)
  if (!username || !password) {
    showError('نام کاربری و رمز عبور را وارد کنید.')
    return
  }

  const result = await window.offlineApi.login({ username, password })
  if (!result?.ok) {
    if (result?.needsOfflinePassword) {
      el('setupPasswordPanel').open = true
      el('setupUsername').value = username
    }
    showError(result?.error || 'ورود ناموفق بود.')
    el('loginPassword').value = ''
    return
  }

  await setCurrentUser(result.user)
  window.location.href = './app.html'
}

async function handleSetupPassword(event) {
  event.preventDefault()
  showError('')

  const username = toEnDigits(el('setupUsername').value.trim())
  const p1 = toEnDigits(el('setupPassword').value)
  const p2 = toEnDigits(el('setupPassword2').value)

  if (!username) {
    showError('نام کاربری را وارد کنید.')
    return
  }
  if (p1.length < 4) {
    showError('رمز باید حداقل ۴ کاراکتر باشد.')
    return
  }
  if (p1 !== p2) {
    showError('رمز و تکرار آن یکسان نیست.')
    return
  }

  const result = await window.offlineApi.setOfflinePassword({ username, password: p1 })
  if (!result?.ok) {
    showError(result?.error || 'ذخیره رمز ناموفق بود.')
    return
  }

  showNotice(`رمز آفلاین برای «${username}» ذخیره شد. اکنون وارد شوید.`)
  el('loginUsername').value = username
  el('setupPassword').value = ''
  el('setupPassword2').value = ''
}

function init() {
  el('importBtn')?.addEventListener('click', () => { handleImport().catch(console.error) })
  el('loginForm')?.addEventListener('submit', (e) => { handleLogin(e).catch(console.error) })
  el('setupPasswordForm')?.addEventListener('submit', (e) => { handleSetupPassword(e).catch(console.error) })
  initState().catch(console.error)
}

init()
