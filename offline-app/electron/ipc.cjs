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
const { executeDbRequest, setCurrentActorPhone } = require('./storage-query.cjs')
const { buildOfflineBackupZip } = require('./backup-export.cjs')

function registerIpcHandlers() {
  ipcMain.handle('offline:getInfo', () => getAppInfo(defaultDbPath()))

  ipcMain.handle('offline:getTableCounts', () => getTableCounts())

  ipcMain.handle('offline:initDatabase', () => initSchema())

  ipcMain.handle('offline:hasData', () => ({
    hasData: hasAnyData(),
    userCount: countUsers()
  }))

  ipcMain.handle('offline:dbRequest', (_event, req) => executeDbRequest(req || {}))

  ipcMain.handle('offline:setActorPhone', (_event, phone) => {
    setCurrentActorPhone(phone || '')
    return true
  })

  ipcMain.handle('offline:exportBackup', async (_event, opts = {}) => {
    const { bytes, filename, deletionCount } = buildOfflineBackupZip({
      exportedBy: opts.exportedBy || {}
    })
    const result = await dialog.showSaveDialog({
      title: 'ذخیره بکاپ آفلاین',
      defaultPath: filename,
      filters: [
        { name: 'CARNO Backup', extensions: ['carno-backup'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (result.canceled || !result.filePath) {
      return { canceled: true }
    }
    fs.writeFileSync(result.filePath, Buffer.from(bytes))
    const { clearDeletionLog } = require('./backup-export.cjs')
    clearDeletionLog()
    return { canceled: false, path: result.filePath, filename, deletionCount }
  })

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
    const result = await login(username, password)
    if (result.ok && result.user?.phone) {
      setCurrentActorPhone(result.user.phone)
    }
    return result
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
