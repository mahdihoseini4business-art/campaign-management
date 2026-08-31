const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('offlineApi', {
  getInfo: () => ipcRenderer.invoke('offline:getInfo'),
  getTableCounts: () => ipcRenderer.invoke('offline:getTableCounts'),
  initDatabase: () => ipcRenderer.invoke('offline:initDatabase'),
  hasData: () => ipcRenderer.invoke('offline:hasData'),
  pickBackupFile: () => ipcRenderer.invoke('offline:pickBackupFile'),
  readBackupFile: (filePath) => ipcRenderer.invoke('offline:readBackupFile', filePath),
  importBackup: (payload) => ipcRenderer.invoke('offline:importBackup', payload),
  login: (payload) => ipcRenderer.invoke('offline:login', payload),
  setOfflinePassword: (payload) => ipcRenderer.invoke('offline:setOfflinePassword', payload),
  getUserPublic: (username) => ipcRenderer.invoke('offline:getUserPublic', username),
  fetchAllTables: () => ipcRenderer.invoke('offline:fetchAllTables')
})
