const path = require('node:path')
const { app, BrowserWindow, shell, Menu } = require('electron')
const { registerIpcHandlers, bootstrapDatabase, shutdownDatabase } = require('./ipc.cjs')
const { buildAppMenu } = require('./menu.cjs')
const { rendererDistDir, appIconPath, isPackaged } = require('./paths.cjs')

const isDev = !isPackaged()
let mainWindow = null

function getMainWindow() {
  return mainWindow
}

function createWindow() {
  const iconPath = appIconPath()
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    show: false,
    autoHideMenuBar: false,
    title: 'CARNO — نسخه آفلاین',
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: isDev
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev) {
    mainWindow.loadURL('http://127.0.0.1:5174/login.html')
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(path.join(rendererDistDir(), 'login.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

if (process.platform === 'win32') {
  app.setAppUserModelId('com.carno.offline')
}

app.whenReady().then(async () => {
  registerIpcHandlers()
  await bootstrapDatabase()
  createWindow()
  Menu.setApplicationMenu(buildAppMenu(getMainWindow))

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  shutdownDatabase()
})
