import { BACKUP_FORMAT_VERSION, BACKUP_TABLES, BACKUP_MANIFEST_PATH } from '@backup/constants.js'
import { validateManifest, BackupFormatError } from '@backup/backup-format.js'
import { unzipSync, strFromU8 } from 'fflate'

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
  deletion_log: 'حذف‌های ثبت‌شده'
}

/** Lightweight backup preview parser (no Supabase / data.js dependency). */
function parseBackupZip(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new BackupFormatError('فایل پشتیبان خالی است.')
  }
  let unzipped
  try {
    unzipped = unzipSync(bytes)
  } catch {
    throw new BackupFormatError('فایل ZIP نامعتبر است.')
  }
  const manifestRaw = unzipped[BACKUP_MANIFEST_PATH]
  if (!manifestRaw) throw new BackupFormatError('manifest.json در فایل پشتیبان یافت نشد.')
  const manifest = validateManifest(JSON.parse(strFromU8(manifestRaw)))
  return { manifest }
}

function el(id) {
  return document.getElementById(id)
}

function formatPath(p) {
  if (!p) return '—'
  if (p.length <= 72) return p
  const head = p.slice(0, 28)
  const tail = p.slice(-36)
  return `${head}…${tail}`
}

function renderStatus(info) {
  const list = el('statusList')
  if (!list) return
  const rows = [
    ['حالت', 'آفلاین (Electron + SQLite)'],
    ['موتور DB', info.engine || 'sql.js'],
    ['مسیر پایگاه داده', formatPath(info.dbPath)],
    ['نسخه schema', String(info.schemaVersion)],
    ['نسخه فرمت بکاپ', String(info.backupFormatVersion || BACKUP_FORMAT_VERSION)],
    ['تعداد جداول', String((info.tables || BACKUP_TABLES).length)]
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

async function refreshStatus() {
  if (!window.offlineApi) {
    renderStatus({ schemaVersion: 1, backupFormatVersion: BACKUP_FORMAT_VERSION })
    renderTableCounts({})
    return
  }

  const [info, counts] = await Promise.all([
    window.offlineApi.getInfo(),
    window.offlineApi.getTableCounts()
  ])
  renderStatus(info)
  renderTableCounts(counts)
}

async function previewBackupFile() {
  const preview = el('backupPreview')
  if (!window.offlineApi?.pickBackupFile) return

  const filePath = await window.offlineApi.pickBackupFile()
  if (!filePath) return

  try {
    const bytes = await window.offlineApi.readBackupFile(filePath)
    const { manifest: m } = parseBackupZip(new Uint8Array(bytes))
    const parts = BACKUP_TABLES.map(t => `${TABLE_LABELS[t] || t}: ${m.tableCounts?.[t] ?? 0}`)
    preview.hidden = false
    preview.textContent =
      `فایل معتبر — منبع: ${m.source === 'offline' ? 'آفلاین' : 'آنلاین'}، ` +
      `تاریخ: ${new Date(m.exportedAt).toLocaleString('fa-IR')} — ` +
      parts.join(' · ') +
      ' (ایمپورت در فاز ۵ پیاده‌سازی می‌شود)'
  } catch (err) {
    preview.hidden = false
    preview.textContent = 'خطا در خواندن بکاپ: ' + (err?.message || String(err))
  }
}

function init() {
  const footer = el('backupModuleInfo')
  if (footer) {
    footer.textContent = `ماژول بکاپ مشترک بارگذاری شد — فرمت نسخه ${BACKUP_FORMAT_VERSION}`
  }

  const pickBtn = el('pickBackupBtn')
  const refreshBtn = el('refreshBtn')

  if (window.offlineApi) {
    pickBtn.disabled = false
    pickBtn.addEventListener('click', () => { previewBackupFile().catch(console.error) })
  } else {
    pickBtn.title = 'فقط در محیط Electron در دسترس است'
  }

  refreshBtn?.addEventListener('click', () => { refreshStatus().catch(console.error) })
  refreshStatus().catch(console.error)
}

init()
