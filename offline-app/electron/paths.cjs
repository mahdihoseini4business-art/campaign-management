const path = require('node:path')
const { app } = require('electron')

function isPackaged() {
  return Boolean(app?.isPackaged)
}

function appRoot() {
  return isPackaged()
    ? path.join(process.resourcesPath, 'app.asar')
    : path.join(__dirname, '..')
}

function rendererDistDir() {
  return path.join(appRoot(), 'dist')
}

function sqlJsDistDir() {
  if (isPackaged()) {
    return path.join(process.resourcesPath, 'sql.js')
  }
  return path.join(appRoot(), 'node_modules', 'sql.js', 'dist')
}

function dbDir() {
  if (isPackaged()) {
    return path.join(process.resourcesPath, 'db')
  }
  return path.join(appRoot(), 'db')
}

function schemaSqlPath() {
  return path.join(dbDir(), 'schema.sql')
}

function schemaVersionPath() {
  return path.join(dbDir(), 'schema-version.txt')
}

function appIconPath() {
  const candidates = [
    path.join(appRoot(), 'dist', 'icon.png'),
    path.join(appRoot(), 'build', 'icon.png'),
    path.join(appRoot(), 'build', 'icon.ico'),
    path.join(appRoot(), 'dist', 'logo.webp'),
    path.join(appRoot(), 'dist', 'icon.webp')
  ]
  for (const candidate of candidates) {
    if (require('node:fs').existsSync(candidate)) return candidate
  }
  return null
}

module.exports = {
  isPackaged,
  appRoot,
  rendererDistDir,
  sqlJsDistDir,
  schemaSqlPath,
  schemaVersionPath,
  appIconPath
}
