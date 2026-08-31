const crypto = require('node:crypto')
const { getDatabase, persistDatabase, queryAll, queryOne } = require('./db.cjs')
const { deserializeRow } = require('./row-serialize.cjs')

const HASH_SECRET = process.env.VITE_HASH_SECRET || 'c4mp_m4n4g3r_s3cr3t_k3y_2024'

/**
 * @param {string} pw
 * @param {string} username
 * @returns {Promise<string>}
 */
function hashPassword(pw, username) {
  return new Promise((resolve, reject) => {
    const salt = `${HASH_SECRET}:${username || 'default'}:salt`
    crypto.pbkdf2(String(pw), salt, 100000, 32, 'sha256', (err, derivedKey) => {
      if (err) reject(err)
      else resolve(derivedKey.toString('hex'))
    })
  })
}

/**
 * @param {Record<string, unknown>} row
 */
function publicUser(row) {
  if (!row) return null
  const user = deserializeRow('users', row)
  delete user.password_hash
  return user
}

function getUserByUsername(username) {
  const row = queryOne(
    'SELECT * FROM users WHERE username = ? LIMIT 1',
    [String(username || '')]
  )
  return row ? deserializeRow('users', row) : null
}

function resolveGroupSessionInfo(user) {
  const empty = { viewUserPhones: [], groupId: null, groupName: null, isGroupManager: false }
  if (!user || user.role === 'admin') return empty

  const member = queryOne(
    `SELECT gm.group_id, gm.is_manager, g.name AS group_name
     FROM group_members gm
     LEFT JOIN groups g ON g.id = gm.group_id
     WHERE gm.user_phone = ?
     LIMIT 1`,
    [user.phone || '']
  )
  if (!member) {
    const phones = normalizeViewUserPhones(user.permissions?.viewUserPhones)
    return {
      viewUserPhones: phones,
      groupId: null,
      groupName: null,
      isGroupManager: phones.length > 0
    }
  }

  const phoneRows = queryAll(
    `SELECT user_phone FROM group_members WHERE group_id = ? AND user_phone != ?`,
    [member.group_id, user.phone || '']
  )
  const viewUserPhones = phoneRows
    .map(r => String(r.user_phone || ''))
    .filter(Boolean)

  return {
    viewUserPhones,
    groupId: member.group_id || null,
    groupName: member.group_name || null,
    isGroupManager: !!member.is_manager
  }
}

/**
 * @param {unknown} input
 */
function normalizeViewUserPhones(input) {
  if (!Array.isArray(input)) return []
  const seen = new Set()
  const out = []
  for (const item of input) {
    const p = String(item || '').trim()
    if (!p || seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}

/**
 * @param {string} username
 * @param {string} password
 */
async function login(username, password) {
  const user = getUserByUsername(username)
  if (!user) return { ok: false, error: 'نام کاربری یا رمز عبور اشتباه است.' }

  if (!user.password_hash) {
    return {
      ok: false,
      needsOfflinePassword: true,
      error: 'رمز آفلاین برای این کاربر تنظیم نشده است. از بخش «تنظیم رمز آفلاین» استفاده کنید.'
    }
  }

  const hash = await hashPassword(password, username)
  if (hash !== user.password_hash) {
    return { ok: false, error: 'نام کاربری یا رمز عبور اشتباه است.' }
  }

  const groupInfo = resolveGroupSessionInfo(user)
  const permissions = user.role === 'admin'
    ? null
    : { ...(user.permissions || {}), viewUserPhones: groupInfo.viewUserPhones }

  return {
    ok: true,
    user: {
      username: user.username,
      displayName: user.display_name,
      firstName: user.first_name,
      lastName: user.last_name,
      phone: user.phone,
      role: user.role,
      permissions,
      viewUserPhones: groupInfo.viewUserPhones,
      groupId: groupInfo.groupId,
      groupName: groupInfo.groupName,
      isGroupManager: groupInfo.isGroupManager
    }
  }
}

/**
 * @param {string} username
 * @param {string} password
 */
async function setOfflinePassword(username, password) {
  const user = getUserByUsername(username)
  if (!user) return { ok: false, error: 'کاربر یافت نشد.' }
  if (!password || String(password).length < 4) {
    return { ok: false, error: 'رمز عبور باید حداقل ۴ کاراکتر باشد.' }
  }

  const hash = await hashPassword(password, username)
  const db = getDatabase()
  db.run(
    'UPDATE users SET password_hash = ? WHERE username = ?',
    [hash, username]
  )
  persistDatabase()
  return { ok: true }
}

/**
 * @param {string} username
 */
function getUserPublic(username) {
  return publicUser(getUserByUsername(username))
}

module.exports = {
  hashPassword,
  login,
  setOfflinePassword,
  getUserByUsername,
  getUserPublic,
  resolveGroupSessionInfo
}
