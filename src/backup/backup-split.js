import { zipSync, strToU8 } from 'fflate'
import {
  createManifest,
  suggestBackupFilename,
  suggestDistributionFilename,
  validateManifest
} from './backup-format.js'
import { buildBackupZip } from './backup-zip.js'
import {
  filterTablesForUser,
  resolveBackupScope,
  countTableRows,
  emptyScopedDeletions,
  normalizePhone
} from './backup-scope.js'

const README_FA = `بسته توزیع آفلاین CARNO
============================

این ZIP شامل:
- full.carno-backup — بکاپ کامل سازمان (فقط برای ادمین / آرشیو)
- users/*.carno-backup — بکاپ شخصی هر کاربر

راهنمای هر کاربر:
1. فقط فایل users/{username}.carno-backup مربوط به خودتان را بردارید.
2. در اپ CARNO Offline: ایمپورت بکاپ → فایل را انتخاب کنید.
3. نام کاربری همان نام آنلاین است.
4. رمز آنلاین در بکاپ نیست — از «تنظیم رمز آفلاین» یک رمز جدید بگذارید.
5. سپس با username و رمز آفلاین وارد شوید.

توجه: بکاپ شخصی قابل بازیابی/merge در نسخه آنلاین نیست.
`

/**
 * @param {string} username
 */
function safeUsernameForPath(username) {
  const base = String(username || 'user').replace(/[^\w.-]+/g, '_').slice(0, 64)
  return base || 'user'
}

/**
 * @param {Record<string, unknown>[]} users
 */
function listSplitTargets(users) {
  return (users || []).filter(u => {
    if (!u || u.role === 'admin') return false
    return !!normalizePhone(u.phone)
  })
}

/**
 * @param {import('./backup-format.js').BackupManifest} manifest
 * @param {Record<string, Record<string, unknown>[]>} tables
 */
function packFullBackupLocal(manifest, tables) {
  const validated = validateManifest(manifest)
  const bytes = buildBackupZip(validated, tables)
  return {
    bytes,
    filename: suggestBackupFilename(validated)
  }
}

/**
 * Build offline distribution ZIP from an in-memory full snapshot.
 * @param {object} opts
 * @param {import('./backup-format.js').BackupManifest} opts.manifest
 * @param {Record<string, Record<string, unknown>[]>} opts.tables
 * @param {string} opts.parentExportId
 * @param {(info: { username: string, done: number, total: number }) => void} [opts.onUserProgress]
 */
export function buildSplitDistributionZip(opts) {
  const { manifest, tables, parentExportId, onUserProgress } = opts
  const fullPacked = packFullBackupLocal({
    ...manifest,
    backupKind: 'full'
  }, tables)

  /** @type {Record<string, Uint8Array>} */
  const entries = {
    'full.carno-backup': fullPacked.bytes,
    'README-fa.txt': strToU8(README_FA)
  }

  const users = tables.users || []
  const targets = listSplitTargets(users)
  const ctx = {
    groupMembers: tables.group_members || [],
    groups: tables.groups || []
  }

  /** @type {Array<Record<string, unknown>>} */
  const indexUsers = []
  const indexedUsernames = new Set()

  targets.forEach((user, idx) => {
    onUserProgress?.({
      username: String(user.username || ''),
      done: idx + 1,
      total: targets.length
    })

    const scope = resolveBackupScope(user, ctx.groupMembers)
    const scopedTables = filterTablesForUser(tables, user, ctx)
    const tableCounts = countTableRows(scopedTables)
    const scopedManifest = createManifest({
      exportedAt: manifest.exportedAt,
      exportedBy: {
        phone: String(user.phone || ''),
        role: String(user.role || ''),
        displayName: String(user.display_name || user.displayName || ''),
        username: String(user.username || '')
      },
      source: manifest.source,
      tableCounts,
      deletions: emptyScopedDeletions(),
      backupKind: 'scoped',
      scope,
      parentExportId
    })

    const userBytes = buildBackupZip(scopedManifest, scopedTables)
    const fileName = `users/${safeUsernameForPath(user.username)}.carno-backup`
    entries[fileName] = userBytes
    indexedUsernames.add(String(user.username || ''))

    indexUsers.push({
      username: user.username,
      phone: normalizePhone(user.phone),
      file: fileName,
      backupFilename: suggestBackupFilename(scopedManifest),
      tableCounts,
      skipped: false
    })
  })

  for (const user of users) {
    const username = String(user.username || '')
    if (indexedUsernames.has(username)) continue

    if (user.role === 'admin') {
      indexUsers.push({
        username: user.username,
        phone: normalizePhone(user.phone),
        file: 'full.carno-backup',
        skipped: true,
        skippedReason: 'admin_uses_full_backup'
      })
      continue
    }
    if (!normalizePhone(user.phone)) {
      indexUsers.push({
        username: user.username,
        phone: '',
        skipped: true,
        skippedReason: 'missing_phone'
      })
    }
  }

  const splitIndex = {
    exportedAt: manifest.exportedAt,
    parentExportId,
    fullBackup: 'full.carno-backup',
    formatVersion: manifest.formatVersion,
    userCount: indexUsers.filter(u => !u.skipped).length,
    users: indexUsers
  }

  entries['split-index.json'] = strToU8(JSON.stringify(splitIndex, null, 2))

  const bytes = zipSync(entries, { level: 6 })
  return {
    bytes,
    filename: suggestDistributionFilename(manifest.exportedAt),
    splitIndex,
    fullFilename: fullPacked.filename
  }
}

/**
 * Export split distribution: one full fetch, per-user scoped backups, one ZIP.
 * @param {object} [opts]
 * @param {import('./backup-format.js').BackupExportedBy} [opts.exportedBy]
 * @param {(info: { table: string, done: number, total: number }) => void} [opts.onProgress]
 * @param {(info: { username: string, done: number, total: number }) => void} [opts.onUserProgress]
 */
export async function exportSplitDistributionFromSupabase(opts = {}) {
  const { collectFullBackupFromSupabase, downloadBackupFile } = await import('./backup-export.js')
  const parentExportId = crypto.randomUUID()

  const { manifest, tables, deletionLogIds } = await collectFullBackupFromSupabase({
    ...opts,
    includeDeletions: true,
    onProgress: opts.onProgress
  })

  const fullManifest = createManifest({
    exportedAt: manifest.exportedAt,
    exportedBy: opts.exportedBy || manifest.exportedBy,
    source: 'online',
    tableCounts: manifest.tableCounts,
    deletions: manifest.deletions,
    backupKind: 'full'
  })

  const packed = buildSplitDistributionZip({
    manifest: fullManifest,
    tables,
    parentExportId,
    onUserProgress: opts.onUserProgress
  })

  if (deletionLogIds?.length) {
    try {
      const { clearDeletionLogEntries } = await import('./deletion-log.js')
      await clearDeletionLogEntries(deletionLogIds)
    } catch (e) {
      console.warn('clearDeletionLogEntries failed:', e)
    }
  }

  return {
    ...packed,
    manifest: fullManifest,
    parentExportId
  }
}

/**
 * Trigger browser download of distribution ZIP.
 * @param {Uint8Array} bytes
 * @param {string} filename
 */
export async function downloadDistributionFile(bytes, filename) {
  const { downloadBackupFile } = await import('./backup-export.js')
  downloadBackupFile(bytes, filename.endsWith('.zip') ? filename : `${filename}.zip`)
}
