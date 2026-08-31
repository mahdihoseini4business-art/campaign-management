const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('offlineApi', {
  getInfo: () => ipcRenderer.invoke('offline:getInfo'),
  getTableCounts: () => ipcRenderer.invoke('offline:getTableCounts'),
  initDatabase: () => ipcRenderer.invoke('offline:initDatabase'),
  pickBackupFile: () => ipcRenderer.invoke('offline:pickBackupFile'),
  readBackupFile: (filePath) => ipcRenderer.invoke('offline:readBackupFile', filePath)
})
