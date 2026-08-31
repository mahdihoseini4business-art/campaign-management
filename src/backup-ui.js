// ============================================
// Full backup export / restore UI (settings admin)
// ============================================

import {
  escapeHtml,
  escapeAttr,
  showToast,
  getCurrentUser,
  requireMainAdmin,
  toJalali,
  formatNumber
} from './utils.js'
import { loadData } from './data.js'
import { loadGroupsData } from './groups.js'

/** @type {import('./backup/backup-format.js').BackupManifest | null} */
let _restoreManifest = null
/** @type {Record<string, Record<string, unknown>[]> | null} */
let _restoreBackupTables = null
/** @type {Record<string, Record<string, unknown>[]> | null} */
let _restoreOnlineTables = null
/** @type {import('./backup/backup-merge.js').MergePlan | null} */
let _restorePlan = null
/** @type {Record<string, 'backup'|'online'>} */
let _restoreResolutions = {}
let _restoreBusy = false

const TABLE_LABELS = {
  customers: 'مشتریان',
  followups: 'پیگیری‌ها',
  refunds: 'عودت‌ها',
  ownership_transfers: 'انتقال‌ها',
  ownership_transfer_acks: 'تأیید انتقال',
  users: 'کاربران',
  groups: 'گروه‌ها',
  group_members: 'اعضای گروه',
  app_settings: 'تنظیمات',
  notifications: 'اعلان‌ها',
  notification_reads: 'خوانده‌شدن اعلان'
}

function formatBackupDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return '—'
  const j = toJalali(d)
  const date = `${j.year}/${String(j.month).padStart(2, '0')}/${String(j.day).padStart(2, '0')}`
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return `${date} ${time}`
}

function setBackupProgress(text, visible = true) {
  const el = document.getElementById('backupProgress')
  if (!el) return
  el.hidden = !visible
  el.textContent = text || ''
}

function setRestoreProgress(text, visible = true) {
  const el = document.getElementById('backupRestoreProgress')
  if (!el) return
  el.hidden = !visible
  el.textContent = text || ''
}

export async function exportFullBackup() {
  if (!requireMainAdmin()) return
  if (_restoreBusy) return

  _restoreBusy = true
  setBackupProgress('در حال آماده‌سازی بکاپ…')

  try {
    const user = getCurrentUser()
    const backup = await import('./backup/index.js')
    const { bytes, filename, manifest } = await backup.exportFullBackupFromSupabase({
      exportedBy: {
        phone: user?.phone || '',
        role: user?.role || '',
        displayName: user?.displayName || '',
        username: user?.username || ''
      },
      source: 'online',
      includeDeletions: true,
      onProgress: ({ table, done, total }) => {
        const label = TABLE_LABELS[table] || table
        setBackupProgress(`خواندن ${label}… (${done}/${total})`)
      }
    })

    backup.downloadBackupFile(bytes, filename)
    const delCount = backup.countPendingDeletions(manifest.deletions || {})
    showToast(delCount > 0
      ? `بکاپ کامل دانلود شد (${delCount} حذف از آخرین بکاپ)`
      : 'بکاپ کامل با موفقیت دانلود شد')
  } catch (e) {
    console.error('exportFullBackup error:', e)
    showToast(e?.message || 'خطا در ایجاد بکاپ', 'error')
  } finally {
    _restoreBusy = false
    setBackupProgress('', false)
  }
}

export function openBackupRestoreModal() {
  if (!requireMainAdmin()) return
  resetRestoreState()
  const fileInput = document.getElementById('backupRestoreFileInput')
  if (fileInput) fileInput.value = ''
  document.getElementById('backupRestoreModal')?.classList.add('active')
  renderRestoreModal()
}

export function closeBackupRestoreModal() {
  if (_restoreBusy) return
  document.getElementById('backupRestoreModal')?.classList.remove('active')
  resetRestoreState()
}

function resetRestoreState() {
  _restoreManifest = null
  _restoreBackupTables = null
  _restoreOnlineTables = null
  _restorePlan = null
  _restoreResolutions = {}
  setRestoreProgress('', false)
}

export function initBackupRestoreListeners() {
  const input = document.getElementById('backupRestoreFileInput')
  if (!input || input.dataset.bound) return
  input.dataset.bound = '1'
  input.addEventListener('change', () => {
    const file = input.files?.[0]
    if (file) onBackupRestoreFileSelected(file)
  })
}

async function onBackupRestoreFileSelected(file) {
  if (!requireMainAdmin()) return
  if (_restoreBusy) return

  _restoreBusy = true
  setRestoreProgress('در حال خواندن فایل بکاپ…')
  renderRestoreModal()

  try {
    const backup = await import('./backup/index.js')
    const { manifest, tables: backupTables } = await backup.parseBackupFile(file)

    setRestoreProgress('در حال مقایسه با داده‌های آنلاین…')
    const { tables: onlineTables } = await backup.collectFullBackupFromSupabase({
      source: 'online',
      onProgress: ({ table, done, total }) => {
        const label = TABLE_LABELS[table] || table
        setRestoreProgress(`مقایسه ${label}… (${done}/${total})`)
      }
    })

    const plan = backup.analyzeMerge({
      onlineTables,
      backupManifest: manifest,
      backupTables
    })

    _restoreManifest = manifest
    _restoreBackupTables = backupTables
    _restoreOnlineTables = onlineTables
    _restorePlan = plan
    _restoreResolutions = {}

    setRestoreProgress('', false)
    renderRestoreModal()
  } catch (e) {
    console.error('onBackupRestoreFileSelected error:', e)
    showToast(e?.message || 'خطا در خواندن فایل بکاپ', 'error')
    resetRestoreState()
    renderRestoreModal()
  } finally {
    _restoreBusy = false
  }
}

function renderRestoreModal() {
  const body = document.getElementById('backupRestoreBody')
  const applyBtn = document.getElementById('backupRestoreApplyBtn')
  if (!body) return

  if (_restoreBusy) {
    body.innerHTML = '<p class="settings-pane-desc" style="margin:0;">لطفاً صبر کنید…</p>'
    if (applyBtn) applyBtn.disabled = true
    return
  }

  if (!_restorePlan || !_restoreManifest) {
    body.innerHTML = `
      <div class="import-preflight" style="font-size:13px;line-height:1.75;margin-bottom:12px;">
        <b>قبل از بازیابی:</b>
        فایل <code>.carno-backup</code> را انتخاب کنید. برنامه تغییرات را با داده‌های فعلی مقایسه می‌کند و قبل از اعمال، خلاصه و تعارض‌ها را نشان می‌دهد.
        <br>این عملیات فقط برای مدیر اصلی است.
      </div>
      <div class="form-group">
        <label>فایل بکاپ</label>
        <input type="file" id="backupRestoreFileInput" accept=".carno-backup,application/zip,application/octet-stream" style="font-size:13px;">
      </div>
    `
    initBackupRestoreListeners()
    if (applyBtn) {
      applyBtn.style.display = 'none'
      applyBtn.disabled = true
    }
    return
  }

  const t = _restorePlan.totals
  const conflicts = backupModuleListConflicts()
  const unresolved = conflicts.filter(c => !_restoreResolutions[`${c.table}\0${c.key}`])

  let html = `
    <div class="backup-restore-summary">
      <p><strong>منبع بکاپ:</strong> ${_restoreManifest.source === 'offline' ? 'نسخه آفلاین' : 'نسخه آنلاین'}</p>
      <p><strong>تاریخ بکاپ:</strong> ${escapeHtml(formatBackupDate(_restoreManifest.exportedAt))}</p>
      <ul class="backup-restore-stats">
        <li><span class="backup-stat-insert">${formatNumber(t.inserts)}</span> رکورد جدید</li>
        <li><span class="backup-stat-update">${formatNumber(t.updates)}</span> به‌روزرسانی</li>
        <li><span class="backup-stat-unchanged">${formatNumber(t.unchanged)}</span> بدون تغییر</li>
        <li><span class="backup-stat-conflict">${formatNumber(t.conflicts + t.deleteConflicts)}</span> تعارض</li>
        <li><span class="backup-stat-delete">${formatNumber(t.deletes)}</span> حذف</li>
        <li><span class="backup-stat-skip">${formatNumber(t.keepOnline)}</span> نگه‌داری نسخه آنلاین (جدیدتر)</li>
      </ul>
    </div>
  `

  if (conflicts.length) {
    html += `<div class="backup-restore-conflicts"><h4 style="margin:12px 0 8px;font-size:14px;">تعارض‌ها — نسخه برنده را انتخاب کنید</h4>`
    html += conflicts.map(c => renderConflictRow(c)).join('')
    html += '</div>'
  } else {
    html += '<p class="settings-pane-desc" style="margin-top:12px;">تعارضی یافت نشد. می‌توانید بازیابی را اعمال کنید.</p>'
  }

  body.innerHTML = html

  if (applyBtn) {
    applyBtn.style.display = ''
    applyBtn.disabled = unresolved.length > 0
    applyBtn.textContent = unresolved.length
      ? `ابتدا ${formatNumber(unresolved.length)} تعارض را حل کنید`
      : 'اعمال بازیابی'
  }
}

function backupModuleListConflicts() {
  if (!_restorePlan) return []
  const conflicts = []
  for (const item of _restorePlan.records) {
    if (item.action === 'conflict' || item.action === 'delete_conflict') {
      conflicts.push(item)
    }
  }
  return conflicts
}

function renderConflictRow(item) {
  const resKey = `${item.table}\0${item.key}`
  const chosen = _restoreResolutions[resKey] || ''
  const tableLabel = TABLE_LABELS[item.table] || item.table
  const kind = item.action === 'delete_conflict' ? 'تعارض حذف' : 'تعارض ویرایش'

  return `
    <div class="backup-conflict-row" data-conflict-key="${escapeAttr(resKey)}">
      <div class="backup-conflict-head">
        <strong>${escapeHtml(tableLabel)}</strong>
        <span class="backup-conflict-kind">${escapeHtml(kind)}</span>
        <code dir="ltr">${escapeHtml(item.key)}</code>
      </div>
      <div class="backup-conflict-actions">
        <label class="backup-conflict-choice${chosen === 'backup' ? ' is-selected' : ''}">
          <input type="radio" name="conflict-${escapeAttr(resKey)}" value="backup"
            ${chosen === 'backup' ? 'checked' : ''}
            onchange="app.setBackupConflictResolution('${escapeAttr(resKey)}','backup')">
          نسخه بکاپ
        </label>
        <label class="backup-conflict-choice${chosen === 'online' ? ' is-selected' : ''}">
          <input type="radio" name="conflict-${escapeAttr(resKey)}" value="online"
            ${chosen === 'online' ? 'checked' : ''}
            onchange="app.setBackupConflictResolution('${escapeAttr(resKey)}','online')">
          نسخه آنلاین
        </label>
      </div>
    </div>
  `
}

export function setBackupConflictResolution(resKey, choice) {
  if (!resKey || (choice !== 'backup' && choice !== 'online')) return
  _restoreResolutions[resKey] = choice
  renderRestoreModal()
}

export async function applyBackupRestore() {
  if (!requireMainAdmin()) return
  if (!_restorePlan || _restoreBusy) return

  const conflicts = backupModuleListConflicts()
  const unresolved = conflicts.filter(c => !_restoreResolutions[`${c.table}\0${c.key}`])
  if (unresolved.length) {
    showToast('ابتدا همه تعارض‌ها را حل کنید', 'error')
    return
  }

  const destructive = _restorePlan.totals.deletes > 0
    || conflicts.some(c => _restoreResolutions[`${c.table}\0${c.key}`] === 'backup' && c.action === 'delete_conflict')

  const confirmMsg = destructive
    ? 'بازیابی شامل حذف یا بازنویسی داده است. ادامه می‌دهید؟'
    : 'تغییرات بکاپ روی داده‌های آنلاین اعمال شود؟'

  if (!confirm(confirmMsg)) return

  _restoreBusy = true
  setRestoreProgress('در حال اعمال تغییرات…')
  const applyBtn = document.getElementById('backupRestoreApplyBtn')
  if (applyBtn) applyBtn.disabled = true

  try {
    const backup = await import('./backup/index.js')
    await backup.applyMergePlanToSupabase(_restorePlan, _restoreResolutions, ({ phase, done, total, detail }) => {
      const label = detail ? (TABLE_LABELS[detail] || detail) : ''
      setRestoreProgress(`${phase === 'delete' ? 'حذف' : 'ذخیره'} ${label}… (${done}/${total})`)
    })

    await loadData()
    try {
      await loadGroupsData()
    } catch (e) {
      console.warn('loadGroupsData after restore:', e)
    }

    showToast('بازیابی با موفقیت اعمال شد')
    closeBackupRestoreModal()

    const activeSheet = document.querySelector('.sheet.active')?.id?.replace('sheet-', '') || 'dashboard'
    if (typeof window.app?.renderCustomers === 'function' && activeSheet === 'customers') {
      window.app.renderCustomers()
    }
    if (typeof window.app?.renderDashboard === 'function' && activeSheet === 'dashboard') {
      window.app.renderDashboard()
    }
  } catch (e) {
    console.error('applyBackupRestore error:', e)
    showToast(e?.message || 'خطا در اعمال بازیابی', 'error')
    setRestoreProgress('', false)
    renderRestoreModal()
  } finally {
    _restoreBusy = false
  }
}
