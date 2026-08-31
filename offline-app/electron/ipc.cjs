const { ipcMain, dialog } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const {
  defaultDbPath,
  openDatabase,
  closeDatabase,
  initSchema,
  getTableCounts,
  getAppInfo
} = require('./db.cjs')

function registerIpcHandlers() {
  ipcMain.handle('offline:getInfo', () => {
    const resolvedPath = defaultDbPath()
    return getAppInfo(resolvedPath)
  })

  ipcMain.handle('offline:getTableCounts', () => getTableCounts())

  ipcMain.handle('offline:initDatabase', () => initSchema())

  ipcMain.handle('offline:pickBackupFile', async () => {
    const result = await dialog.showOpenDialog({
      title: 'انتخاب فایل بکاپ',
      properties: ['openFile'],
      filters: [
        { name: 'CARNO Backup', extensions: ['carno-backup'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (result.canceled || !result.filePaths?.length) return null
    return result.filePaths[0]
  })

  ipcMain.handle('offline:readBackupFile', (_event, filePath) => {
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('مسیر فایل بکاپ نامعتبر است.')
    }
    const resolved = path.resolve(filePath)
    if (!fs.existsSync(resolved)) {
      throw new Error('فایل بکاپ یافت نشد.')
    }
    return fs.readFileSync(resolved)
  })
}

async function bootstrapDatabase() {
  const resolvedPath = defaultDbPath()
  await openDatabase(resolvedPath)
  initSchema()
  return resolvedPath
}

function shutdownDatabase() {
  closeDatabase()
}

module.exports = {
  registerIpcHandlers,
  bootstrapDatabase,
  shutdownDatabase
}
