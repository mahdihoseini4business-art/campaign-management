const { app, Menu, shell, dialog } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { buildOfflineBackupZip, clearDeletionLog } = require('./backup-export.cjs')

/**
 * @param {import('electron').BrowserWindow | null} getWindow
 */
function buildAppMenu(getWindow) {
  const isMac = process.platform === 'darwin'

  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'فایل',
      submenu: [
        {
          label: 'بکاپ کامل…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => exportBackupFromMenu(getWindow)
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit', label: 'خروج' }
      ]
    },
    {
      label: 'راهنما',
      submenu: [
        {
          label: 'درباره CARNO آفلاین',
          click: () => showAboutDialog(getWindow)
        },
        {
          label: 'باز کردن پوشه داده',
          click: () => shell.openPath(app.getPath('userData'))
        }
      ]
    }
  ]

  return Menu.buildFromTemplate(template)
}

/**
 * @param {() => import('electron').BrowserWindow | null} getWindow
 */
async function exportBackupFromMenu(getWindow) {
  const win = getWindow()
  try {
    const { bytes, filename, deletionCount } = buildOfflineBackupZip({ exportedBy: {} })
    const result = await dialog.showSaveDialog(win || undefined, {
      title: 'ذخیره بکاپ آفلاین',
      defaultPath: filename,
      filters: [
        { name: 'CARNO Backup', extensions: ['carno-backup'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (result.canceled || !result.filePath) return
    fs.writeFileSync(result.filePath, Buffer.from(bytes))
    clearDeletionLog()
    await dialog.showMessageBox(win || undefined, {
      type: 'info',
      title: 'بکاپ آفلاین',
      message: 'بکاپ با موفقیت ذخیره شد.',
      detail: deletionCount > 0
        ? `${deletionCount} حذف از آخرین بکاپ در فایل ثبت شد.`
        : path.basename(result.filePath)
    })
  } catch (err) {
    await dialog.showMessageBox(win || undefined, {
      type: 'error',
      title: 'خطا در بکاپ',
      message: err?.message || String(err)
    })
  }
}

/**
 * @param {() => import('electron').BrowserWindow | null} getWindow
 */
async function showAboutDialog(getWindow) {
  const win = getWindow()
  const pkg = require('../package.json')
  await dialog.showMessageBox(win || undefined, {
    type: 'info',
    title: 'درباره',
    message: `${pkg.productName || pkg.name} v${pkg.version}`,
    detail: [
      'نسخه اضطراری بدون اینترنت',
      'داده‌ها در SQLite محلی ذخیره می‌شوند.',
      '',
      `مسیر داده: ${app.getPath('userData')}`
    ].join('\n')
  })
}

module.exports = {
  buildAppMenu
}
