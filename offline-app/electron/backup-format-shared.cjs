const BACKUP_FORMAT_VERSION = 1
const BACKUP_DATA_PREFIX = 'data/'

function tableDataPath(table) {
  return `${BACKUP_DATA_PREFIX}${table}.json`
}

function suggestBackupFilename(manifest) {
  const ts = (manifest.exportedAt || new Date().toISOString())
    .replace(/[:.]/g, '-')
    .slice(0, 19)
  return `carno-backup-offline-${ts}.carno-backup`
}

module.exports = {
  BACKUP_FORMAT_VERSION,
  tableDataPath,
  suggestBackupFilename
}
