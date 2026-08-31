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
const {
  importBackupBytes,
  hasAnyData,
  countUsers,
  fetchAllTables
} = require('./storage.cjs')
const { login, setOfflinePassword, getUserPublic } = require('./auth-local.cjs')

function registerIpcHandlers() {
  ipcMain.handle('offline:getInfo', () => getAppInfo(defaultDbPath()))

  ipcMain.handle('offline:getTableCounts', () => getTableCounts())

  ipcMain.handle('offline:initDatabase', () => initSchema())

  ipcMain.handle('offline:hasData', () => ({
    hasData: hasAnyData(),
    userCount: countUsers()
  }))

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

  ipcMain.handle('offline:importBackup', (_event, payload) => {
    const filePath = payload?.filePath
    const replace = payload?.replace !== false
    if (!filePath) throw new Error('مسیر فایل بکاپ مشخص نشده است.')
    const resolved = path.resolve(filePath)
    if (!fs.existsSync(resolved)) throw new Error('فایل بکاپ یافت نشد.')
    const bytes = fs.readFileSync(resolved)
    return importBackupBytes(bytes, { replace })
  })

  ipcMain.handle('offline:login', async (_event, payload) => {
    const username = String(payload?.username || '').trim()
    const password = String(payload?.password || '')
    return login(username, password)
  })

  ipcMain.handle('offline:setOfflinePassword', async (_event, payload) => {
    const username = String(payload?.username || '').trim()
    const password = String(payload?.password || '')
    return setOfflinePassword(username, password)
  })

  ipcMain.handle('offline:getUserPublic', (_event, username) => {
    return getUserPublic(String(username || '').trim())
  })

  ipcMain.handle('offline:fetchAllTables', () => fetchAllTables())
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
