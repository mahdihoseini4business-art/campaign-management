import { BACKUP_FORMAT_VERSION, BACKUP_TABLES, BACKUP_MANIFEST_PATH } from '@backup/constants.js'
import { validateManifest, BackupFormatError } from '@backup/backup-format.js'
import { unzipSync, strFromU8 } from 'fflate'
import { requireSession, getCurrentUser, clearCurrentUser } from './session.js'

const TABLE_LABELS = {
  customers: 'مشتریان',
  followups: 'پیگیری‌ها',
  refunds: 'عودت‌ها',
  ownership_transfers: 'انتقال مالکیت',
  ownership_transfer_acks: 'تأیید انتقال',
  users: 'کاربران',
  groups: 'گروه‌ها',
  group_members: 'اعضای گروه',
  app_settings: 'تنظیمات',
  notifications: 'اعلان‌ها',
  notification_reads: 'خوانده‌شده‌ها',
  dm_conversations: 'گفتگوها',
  dm_messages: 'پیام‌ها',
  dm_reads: 'خوانده‌شدن چت',
  dm_members: 'اعضای چت',
  dm_pins: 'پین چت',
  dm_chat_time_daily: 'زمان چت روزانه',
  deletion_log: 'حذف‌های ثبت‌شده'
}

function el(id) {
  return document.getElementById(id)
}

function formatPath(p) {
  if (!p) return '—'
  if (p.length <= 72) return p
  return `${p.slice(0, 28)}…${p.slice(-36)}`
}

function parseBackupPreview(bytes) {
  const unzipped = unzipSync(bytes)
  const manifestRaw = unzipped[BACKUP_MANIFEST_PATH]
  if (!manifestRaw) throw new BackupFormatError('manifest.json یافت نشد.')
  return validateManifest(JSON.parse(strFromU8(manifestRaw)))
}

function renderUserBar(user) {
  const bar = el('userBar')
  if (!bar || !user) return
  bar.innerHTML = `
    <span>${user.displayName || user.username}</span>
    <span class="offline-user-role">${user.role === 'admin' ? 'مدیر' : 'کاربر'}</span>
    <button type="button" class="btn btn-sm" id="logoutBtn">خروج</button>
  `
  el('logoutBtn')?.addEventListener('click', () => {
    clearCurrentUser()
    window.location.href = './login.html'
  })
}

function renderStatus(info, user) {
  const list = el('statusList')
  if (!list) return
  const rows = [
    ['کاربر', user?.displayName || user?.username || '—'],
    ['حالت', 'آفلاین (Electron + SQLite)'],
    ['موتور DB', info.engine || 'sql.js'],
    ['مسیر پایگاه داده', formatPath(info.dbPath)],
    ['نسخه schema', String(info.schemaVersion)],
    ['نسخه فرمت بکاپ', String(info.backupFormatVersion || BACKUP_FORMAT_VERSION)]
  ]
  list.innerHTML = rows.map(([label, value]) => `
    <div><dt>${label}</dt><dd>${value}</dd></div>
  `).join('')
}

function renderTableCounts(counts) {
  const grid = el('tableCounts')
  if (!grid) return
  const entries = Object.entries(counts || {})
  if (!entries.length) {
    grid.innerHTML = '<p class="offline-hint">هنوز داده‌ای وارد نشده است.</p>'
    return
  }
  grid.innerHTML = entries.map(([table, count]) => `
    <div class="offline-table-item">
      <strong>${TABLE_LABELS[table] || table}</strong>
      <span>${Number(count).toLocaleString('fa-IR')}</span>
    </div>
  `).join('')
}

async function refreshStatus(user) {
  if (!window.offlineApi) return
  const [info, counts] = await Promise.all([
    window.offlineApi.getInfo(),
    window.offlineApi.getTableCounts()
  ])
  renderStatus(info, user)
  renderTableCounts(counts)
}

async function importBackupReplace() {
  const preview = el('backupPreview')
  if (!window.offlineApi) return

  const ok = window.confirm(
    'ایمپورت بکاپ جدید، تمام داده‌های محلی فعلی را جایگزین می‌کند. ادامه می‌دهید؟'
  )
  if (!ok) return

  const filePath = await window.offlineApi.pickBackupFile()
  if (!filePath) return

  try {
    preview.hidden = false
    preview.textContent = 'در حال ایمپورت…'
    const bytes = await window.offlineApi.readBackupFile(filePath)
    const manifest = parseBackupPreview(new Uint8Array(bytes))
    await window.offlineApi.importBackup({ filePath, replace: true })
    preview.textContent =
      `ایمپورت موفق — ${new Date(manifest.exportedAt).toLocaleString('fa-IR')} — ` +
      `${manifest.tableCounts?.customers ?? 0} مشتری`
    await refreshStatus(getCurrentUser())
  } catch (err) {
    preview.hidden = false
    preview.textContent = 'خطا: ' + (err?.message || String(err))
  }
}

async function init() {
  const user = await requireSession()
  if (!user) return

  renderUserBar(user)

  const footer = el('backupModuleInfo')
  if (footer) {
    footer.textContent = `ماژول بکاپ مشترک — فرمت ${BACKUP_FORMAT_VERSION}`
  }

  el('importBackupBtn')?.addEventListener('click', () => { importBackupReplace().catch(console.error) })
  el('refreshBtn')?.addEventListener('click', () => { refreshStatus(user).catch(console.error) })

  if (window.offlineApi) {
    el('importBackupBtn').disabled = false
  }

  await refreshStatus(user)
}

init().catch(console.error)
