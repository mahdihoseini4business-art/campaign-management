import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'
import { BACKUP_MANIFEST_PATH, BACKUP_TABLES } from './constants.js'
import {
  validateManifest,
  tableDataPath,
  sanitizeTableForBackup,
  BackupFormatError
} from './backup-format.js'

/**
 * Build a `.carno-backup` ZIP from manifest + table payloads.
 * @param {import('./backup-format.js').BackupManifest} manifest
 * @param {Record<string, Record<string, unknown>[]>} tables
 * @returns {Uint8Array}
 */
export function buildBackupZip(manifest, tables) {
  /** @type {Record<string, Uint8Array>} */
  const files = {}

  files[BACKUP_MANIFEST_PATH] = strToU8(JSON.stringify(manifest))

  for (const table of BACKUP_TABLES) {
    const rows = sanitizeTableForBackup(table, tables[table] || [])
    files[tableDataPath(table)] = strToU8(JSON.stringify(rows))
  }

  return zipSync(files, { level: 6 })
}

/**
 * Parse in-memory backup (for tests or restore preview).
 * @param {Uint8Array} bytes
 * @returns {{ manifest: import('./backup-format.js').BackupManifest, tables: Record<string, Record<string, unknown>[]> }}
 */
export function parseBackupZip(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new BackupFormatError('فایل پشتیبان خالی است.')
  }

  let unzipped
  try {
    unzipped = unzipSync(bytes)
  } catch {
    throw new BackupFormatError('فایل ZIP نامعتبر است.')
  }

  const manifestRaw = unzipped[BACKUP_MANIFEST_PATH]
  if (!manifestRaw) {
    throw new BackupFormatError('manifest.json در فایل پشتیبان یافت نشد.')
  }

  let manifest
  try {
    manifest = validateManifest(JSON.parse(strFromU8(manifestRaw)))
  } catch (e) {
    if (e instanceof BackupFormatError) throw e
    throw new BackupFormatError('manifest.json قابل خواندن نیست.')
  }

  /** @type {Record<string, Record<string, unknown>[]>} */
  const tables = {}
  for (const table of BACKUP_TABLES) {
    const path = tableDataPath(table)
    const raw = unzipped[path]
    if (!raw) {
      tables[table] = []
      continue
    }
    try {
      const parsed = JSON.parse(strFromU8(raw))
      if (!Array.isArray(parsed)) {
        throw new BackupFormatError(`داده جدول ${table} باید آرایه باشد.`)
      }
      tables[table] = parsed
    } catch (e) {
      if (e instanceof BackupFormatError) throw e
      throw new BackupFormatError(`فایل ${path} قابل خواندن نیست.`)
    }
  }

  return { manifest, tables }
}
