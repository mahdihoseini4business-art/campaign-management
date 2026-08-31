import { getCurrentUser } from '@online-src/utils.js'

export function initBackupRestoreListeners() {}

export async function exportFullBackup() {
  const user = getCurrentUser()
  const progress = document.getElementById('backupProgress')
  if (progress) {
    progress.hidden = false
    progress.textContent = 'در حال آماده‌سازی بکاپ…'
  }
  try {
    const result = await window.offlineApi.exportBackup({
      exportedBy: {
        username: user?.username || '',
        phone: user?.phone || '',
        role: user?.role || '',
        displayName: user?.displayName || ''
      }
    })
    if (progress) {
      progress.textContent = result?.deletionCount
        ? `بکاپ دانلود شد (${result.deletionCount} حذف ثبت‌شده).`
        : 'بکاپ با موفقیت دانلود شد.'
    }
  } catch (err) {
    if (progress) progress.textContent = 'خطا: ' + (err?.message || String(err))
    throw err
  }
}

export function openBackupRestoreModal() {
  import('@online-src/utils.js').then(({ showToast }) => {
    showToast('بازیابی به سرور آنلاین فقط در نسخه وب انجام می‌شود. از «بکاپ کامل» برای انتقال به آنلاین استفاده کنید.')
  })
}

export function closeBackupRestoreModal() {}

export function applyBackupRestore() {}

export function setBackupConflictResolution() {}

export function resolveAllBackupConflicts() {}
