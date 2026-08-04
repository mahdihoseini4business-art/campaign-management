/**
 * User groups: exclusive membership, one manager per group.
 * Manager's permissions.viewUserPhones is derived from other group members.
 */
import { supabase } from './supabase.js'
import { normalizePhone, normalizeViewUserPhones, userDisplayName, escapeHtml, escapeAttr } from './utils.js'
import { saveSetting } from './data.js'

export const GROUP_FILTER_PREFIX = '__group__:'

const MIGRATION_SETTING_KEY = 'groups_migrated_from_view_phones_v1'

/** @type {Array<{id: string, name: string, description?: string, created_at?: string}>} */
let _groupsCache = []
/** @type {Array<{group_id: string, user_phone: string, is_manager: boolean}>} */
let _membersCache = []

export function getGroupsCache() {
  return _groupsCache
}

export function getMembersCache() {
  return _membersCache
}

export async function loadGroupsData() {
  const [gRes, mRes] = await Promise.all([
    supabase.from('groups').select('*').order('name'),
    supabase.from('group_members').select('*')
  ])
  if (gRes.error) {
    console.error('loadGroupsData groups error:', gRes.error)
    throw gRes.error
  }
  if (mRes.error) {
    console.error('loadGroupsData members error:', mRes.error)
    throw mRes.error
  }
  _groupsCache = gRes.data || []
  _membersCache = (mRes.data || []).map(m => ({
    ...m,
    user_phone: normalizePhone(m.user_phone),
    is_manager: !!m.is_manager
  }))
  return { groups: _groupsCache, members: _membersCache }
}

export function getGroupById(groupId) {
  return _groupsCache.find(g => g.id === groupId) || null
}

export function getMembersOfGroup(groupId) {
  return _membersCache.filter(m => m.group_id === groupId)
}

export function getMembershipByPhone(phone) {
  const p = normalizePhone(phone)
  if (!p) return null
  const membership = _membersCache.find(m => m.user_phone === p)
  if (!membership) return null
  const group = getGroupById(membership.group_id)
  return group ? { group, membership, isManager: !!membership.is_manager } : null
}

/** Phones of other members when this phone is the group manager; else []. */
export function getManagedMemberPhonesFromCache(phone) {
  const info = getMembershipByPhone(phone)
  if (!info?.isManager) return []
  const self = normalizePhone(phone)
  return getMembersOfGroup(info.group.id)
    .map(m => m.user_phone)
    .filter(p => p && p !== self)
}

export function groupFilterValue(groupId) {
  return `${GROUP_FILTER_PREFIX}${groupId}`
}

export function isGroupFilterValue(value) {
  return typeof value === 'string' && value.startsWith(GROUP_FILTER_PREFIX)
}

export function parseGroupFilterId(value) {
  if (!isGroupFilterValue(value)) return null
  return value.slice(GROUP_FILTER_PREFIX.length) || null
}

/**
 * Resolve advisor filter value to a Set of phones, or null when no filter (show all).
 * Supports: '', '__team__', '__group__:{id}', or a single phone.
 */
export function phonesMatchingAdvisorFilter(filterValue, currentUser = null) {
  if (!filterValue) return null
  if (filterValue === '__team__') {
    return new Set(normalizeViewUserPhones(
      currentUser?.viewUserPhones ?? currentUser?.permissions?.viewUserPhones
    ))
  }
  const groupId = parseGroupFilterId(filterValue)
  if (groupId) {
    return new Set(getMembersOfGroup(groupId).map(m => m.user_phone).filter(Boolean))
  }
  const phone = normalizePhone(filterValue)
  return phone ? new Set([phone]) : null
}

/**
 * Partition users (with phone) into named groups + ungrouped.
 * Requires loadGroupsData() first.
 */
export function organizeUsersByGroup(users = []) {
  const byPhone = new Map()
  users.forEach(u => {
    const p = normalizePhone(u.phone)
    if (p) byPhone.set(p, u)
  })

  const assigned = new Set()
  const groups = getGroupsCache().map(g => {
    const members = getMembersOfGroup(g.id)
      .map(m => {
        const u = byPhone.get(m.user_phone)
        if (u) assigned.add(m.user_phone)
        return u ? { user: u, phone: m.user_phone, isManager: !!m.is_manager } : null
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (a.isManager !== b.isManager) return a.isManager ? -1 : 1
        return userDisplayName(a.user).localeCompare(userDisplayName(b.user), 'fa')
      })
    return { id: g.id, name: g.name, members }
  }).filter(g => g.members.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name, 'fa'))

  const ungrouped = users
    .filter(u => {
      const p = normalizePhone(u.phone)
      return p && !assigned.has(p)
    })
    .map(u => ({ user: u, phone: normalizePhone(u.phone), isManager: false }))
    .sort((a, b) => userDisplayName(a.user).localeCompare(userDisplayName(b.user), 'fa'))

  return { groups, ungrouped }
}

/**
 * HTML options for advisor <select>: optgroups per team, optional "all members" row.
 */
export function buildGroupedAdvisorSelectHtml({
  users = [],
  selectedValue = '',
  teamLabel = null,
  allowedPhones = null,
  includeGroupAllOption = true,
  emptyLabel = 'همه کارشناسان'
} = {}) {
  const filtered = users.filter(u => {
    const p = normalizePhone(u.phone)
    if (!p) return false
    if (allowedPhones && !allowedPhones.has(p)) return false
    return true
  })

  const sel = (value) => (value === selectedValue ? ' selected' : '')
  let html = `<option value=""${sel('')}>${escapeHtml(emptyLabel)}</option>`
  if (teamLabel) {
    html += `<option value="__team__"${sel('__team__')}>${escapeHtml(teamLabel)}</option>`
  }

  const { groups, ungrouped } = organizeUsersByGroup(filtered)

  for (const g of groups) {
    html += `<optgroup label="${escapeAttr(g.name)}">`
    if (includeGroupAllOption && g.members.length) {
      const allVal = groupFilterValue(g.id)
      html += `<option value="${escapeAttr(allVal)}"${sel(allVal)}>همه اعضای ${escapeHtml(g.name)} (${g.members.length})</option>`
    }
    for (const m of g.members) {
      const label = userDisplayName(m.user) || m.phone
      const suffix = m.isManager ? ' · مدیر' : ''
      html += `<option value="${escapeAttr(m.phone)}"${sel(m.phone)}>${escapeHtml(label)}${suffix}</option>`
    }
    html += '</optgroup>'
  }

  if (ungrouped.length) {
    html += '<optgroup label="بدون گروه">'
    for (const m of ungrouped) {
      const label = userDisplayName(m.user) || m.phone
      html += `<option value="${escapeAttr(m.phone)}"${sel(m.phone)}>${escapeHtml(label)}</option>`
    }
    html += '</optgroup>'
  }

  return html
}

/**
 * Nested recipient list HTML for notification compose (group headers + members).
 */
export function buildGroupedRecipientListHtml(users = []) {
  const eligible = users.filter(u => normalizePhone(u.phone))
  if (!eligible.length) {
    return '<div class="settings-empty-detail">کاربری برای انتخاب نیست</div>'
  }

  const { groups, ungrouped } = organizeUsersByGroup(eligible)
  const blocks = []

  const memberRow = (m) => {
    const name = userDisplayName(m.user) || m.user.username || m.phone
    const label = `${name} · ${m.phone}${m.isManager ? ' مدیر' : ''}`
    return `<label class="view-users-option notif-member-row" data-search="${escapeAttr(label.toLowerCase())}" data-group-id="${escapeAttr(m.groupId || '')}">
      <input type="checkbox" value="${escapeAttr(m.phone)}" class="notif-recipient-cb" onchange="app.onNotifRecipientChange(this)">
      <span>${escapeHtml(name)}${m.isManager ? ' <span class="role-badge role-admin">مدیر</span>' : ''}</span>
      <span class="view-users-phone">${escapeHtml(m.phone)}</span>
    </label>`
  }

  for (const g of groups) {
    const searchBits = [g.name, ...g.members.map(m => `${userDisplayName(m.user)} ${m.phone}`)].join(' ').toLowerCase()
    const membersWithGroup = g.members.map(m => ({ ...m, groupId: g.id }))
    blocks.push(`
      <div class="notif-group-block" data-group-block="${escapeAttr(g.id)}" data-search="${escapeAttr(searchBits)}">
        <label class="notif-group-head">
          <input type="checkbox" class="notif-group-cb" data-group-id="${escapeAttr(g.id)}" onchange="app.toggleNotifGroup('${escapeAttr(g.id)}', this.checked)">
          <span class="notif-group-title">${escapeHtml(g.name)}</span>
          <span class="notif-group-count">${g.members.length} نفر</span>
        </label>
        <div class="notif-group-members">
          ${membersWithGroup.map(memberRow).join('')}
        </div>
      </div>`)
  }

  if (ungrouped.length) {
    const searchBits = ['بدون گروه', ...ungrouped.map(m => `${userDisplayName(m.user)} ${m.phone}`)].join(' ').toLowerCase()
    blocks.push(`
      <div class="notif-group-block" data-group-block="__none__" data-search="${escapeAttr(searchBits)}">
        <div class="notif-group-head notif-group-head-static">
          <span class="notif-group-title">بدون گروه</span>
          <span class="notif-group-count">${ungrouped.length} نفر</span>
        </div>
        <div class="notif-group-members">
          ${ungrouped.map(m => memberRow({ ...m, groupId: '' })).join('')}
        </div>
      </div>`)
  }

  return blocks.join('')
}

/**
 * Derive managed phones from DB for a single user (no full cache required).
 * Used on login/session refresh.
 * @returns {Promise<string[]|null>} null = groups unavailable
 */
export async function fetchManagedMemberPhones(phone) {
  const info = await fetchGroupMembershipInfo(phone)
  if (info === null) return null
  return info.viewUserPhones
}

/**
 * Load group membership + derived view phones for session.
 * @returns {Promise<{groupId: string|null, groupName: string|null, isGroupManager: boolean, viewUserPhones: string[]}|null>}
 *   null when groups table is unavailable
 */
export async function fetchGroupMembershipInfo(phone) {
  const p = normalizePhone(phone)
  if (!p) {
    return { groupId: null, groupName: null, isGroupManager: false, viewUserPhones: [] }
  }

  const { data: myRow, error: myErr } = await supabase
    .from('group_members')
    .select('group_id, is_manager, groups(id, name)')
    .eq('user_phone', p)
    .limit(1)

  if (myErr) {
    console.error('fetchGroupMembershipInfo membership error:', myErr)
    return null
  }
  if (!myRow?.length) {
    return { groupId: null, groupName: null, isGroupManager: false, viewUserPhones: [] }
  }

  const row = myRow[0]
  const groupMeta = Array.isArray(row.groups) ? row.groups[0] : row.groups
  const groupId = row.group_id || groupMeta?.id || null
  const groupName = groupMeta?.name || null
  const isGroupManager = !!row.is_manager

  if (!isGroupManager || !groupId) {
    return { groupId, groupName, isGroupManager: false, viewUserPhones: [] }
  }

  const { data: peers, error: peersErr } = await supabase
    .from('group_members')
    .select('user_phone')
    .eq('group_id', groupId)
    .eq('is_manager', false)

  if (peersErr) {
    console.error('fetchGroupMembershipInfo peers error:', peersErr)
    return null
  }

  return {
    groupId,
    groupName,
    isGroupManager: true,
    viewUserPhones: [...new Set((peers || []).map(r => normalizePhone(r.user_phone)).filter(Boolean))]
  }
}

/**
 * Write permissions.viewUserPhones for the manager of a group (or clear if none).
 * Also clears stale grants for former managers who left this group.
 */
export async function syncGroupManagerViewPhones(groupId) {
  const { data: members, error } = await supabase
    .from('group_members')
    .select('user_phone, is_manager')
    .eq('group_id', groupId)

  if (error) {
    console.error('syncGroupManagerViewPhones load error:', error)
    return false
  }

  const rows = (members || []).map(m => ({
    phone: normalizePhone(m.user_phone),
    is_manager: !!m.is_manager
  })).filter(m => m.phone)

  const manager = rows.find(m => m.is_manager)
  const memberPhones = rows.filter(m => !m.is_manager).map(m => m.phone)

  if (manager) {
    await patchUserViewPhones(manager.phone, memberPhones)
  }

  // Non-managers in this group must not keep team grants
  for (const m of rows.filter(r => !r.is_manager)) {
    await patchUserViewPhones(m.phone, [])
  }

  return true
}

async function patchUserViewPhones(phone, viewPhones) {
  const p = normalizePhone(phone)
  if (!p) return

  const { data: users, error } = await supabase
    .from('users')
    .select('username, role, permissions')
    .eq('phone', p)
    .limit(1)

  if (error || !users?.length) return
  const user = users[0]
  if (user.role === 'admin' || user.username === 'admin') return

  const permissions = { ...(user.permissions || {}) }
  const next = normalizeViewUserPhones(viewPhones)
  const prev = normalizeViewUserPhones(permissions.viewUserPhones)
  if (prev.length === next.length && prev.every((x, i) => x === next[i])) return

  permissions.viewUserPhones = next
  const { error: upErr } = await supabase
    .from('users')
    .update({ permissions })
    .eq('username', user.username)

  if (upErr) console.error('patchUserViewPhones error:', upErr)
}

/** Clear viewUserPhones for a phone (e.g. after leaving all groups). */
export async function clearUserViewPhones(phone) {
  await patchUserViewPhones(phone, [])
}

export async function createGroup(name, description = '') {
  const trimmed = String(name || '').trim()
  if (!trimmed) throw new Error('نام گروه الزامی است')

  const { data, error } = await supabase
    .from('groups')
    .insert({ name: trimmed, description: String(description || '').trim() || null })
    .select('*')
    .single()

  if (error) throw error
  _groupsCache = [..._groupsCache, data].sort((a, b) => a.name.localeCompare(b.name, 'fa'))
  return data
}

export async function renameGroup(groupId, name) {
  const trimmed = String(name || '').trim()
  if (!trimmed) throw new Error('نام گروه الزامی است')

  const { data, error } = await supabase
    .from('groups')
    .update({ name: trimmed })
    .eq('id', groupId)
    .select('*')
    .single()

  if (error) throw error
  _groupsCache = _groupsCache.map(g => (g.id === groupId ? data : g))
  return data
}

/**
 * Delete group. Clears viewUserPhones for former manager, then CASCADE removes members.
 */
export async function deleteGroup(groupId) {
  const members = getMembersOfGroup(groupId)
  for (const m of members) {
    await clearUserViewPhones(m.user_phone)
  }

  const { error } = await supabase.from('groups').delete().eq('id', groupId)
  if (error) throw error

  _groupsCache = _groupsCache.filter(g => g.id !== groupId)
  _membersCache = _membersCache.filter(m => m.group_id !== groupId)
  return true
}

export async function addGroupMember(groupId, userPhone, { asManager = false } = {}) {
  const phone = normalizePhone(userPhone)
  if (!phone) throw new Error('شماره موبایل نامعتبر است')

  const existing = _membersCache.find(m => m.user_phone === phone)
  if (existing) {
    if (existing.group_id === groupId) return existing
    throw new Error('این کاربر در گروه دیگری عضو است')
  }

  if (asManager) {
    await clearManagerFlag(groupId)
  }

  const { data, error } = await supabase
    .from('group_members')
    .insert({ group_id: groupId, user_phone: phone, is_manager: !!asManager })
    .select('*')
    .single()

  if (error) throw error

  const row = { ...data, user_phone: phone, is_manager: !!data.is_manager }
  _membersCache = [..._membersCache, row]
  await syncGroupManagerViewPhones(groupId)
  return row
}

export async function removeGroupMember(groupId, userPhone) {
  const phone = normalizePhone(userPhone)
  if (!phone) return false

  const { error } = await supabase
    .from('group_members')
    .delete()
    .eq('group_id', groupId)
    .eq('user_phone', phone)

  if (error) throw error

  _membersCache = _membersCache.filter(m => !(m.group_id === groupId && m.user_phone === phone))
  await clearUserViewPhones(phone)
  await syncGroupManagerViewPhones(groupId)
  return true
}

export async function setGroupManager(groupId, userPhone) {
  const phone = normalizePhone(userPhone)
  if (!phone) throw new Error('شماره موبایل نامعتبر است')

  const member = _membersCache.find(m => m.group_id === groupId && m.user_phone === phone)
  if (!member) throw new Error('کاربر عضو این گروه نیست')

  await clearManagerFlag(groupId)

  const { error } = await supabase
    .from('group_members')
    .update({ is_manager: true })
    .eq('group_id', groupId)
    .eq('user_phone', phone)

  if (error) throw error

  _membersCache = _membersCache.map(m => {
    if (m.group_id !== groupId) return m
    return { ...m, is_manager: m.user_phone === phone }
  })

  await syncGroupManagerViewPhones(groupId)
  return true
}

async function clearManagerFlag(groupId) {
  const { error } = await supabase
    .from('group_members')
    .update({ is_manager: false })
    .eq('group_id', groupId)
    .eq('is_manager', true)

  if (error) throw error

  _membersCache = _membersCache.map(m =>
    m.group_id === groupId ? { ...m, is_manager: false } : m
  )
}

/**
 * Assign user to a group (moves from previous group if any). Does not auto-set manager.
 */
export async function assignUserToGroup(userPhone, groupId) {
  const phone = normalizePhone(userPhone)
  if (!phone) throw new Error('شماره موبایل نامعتبر است')

  const current = _membersCache.find(m => m.user_phone === phone)
  if (current) {
    if (current.group_id === groupId) return current
    await removeGroupMember(current.group_id, phone)
  }

  if (!groupId) return null
  return addGroupMember(groupId, phone, { asManager: false })
}

/**
 * One-time: create groups from legacy permissions.viewUserPhones.
 * Conflicts (phone already in a group) are skipped and reported.
 */
export async function migrateLegacyViewUserPhones(users = []) {
  const { data: settingRows } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', MIGRATION_SETTING_KEY)
    .limit(1)

  if (settingRows?.[0]?.value === true || settingRows?.[0]?.value === 'true') {
    return { skipped: true, created: 0, conflicts: [] }
  }

  // Ensure cache is loaded
  try {
    await loadGroupsData()
  } catch (e) {
    console.error('migrateLegacyViewUserPhones: groups table unavailable', e)
    return { skipped: true, created: 0, conflicts: [], error: e }
  }

  const phoneToUser = new Map()
  users.forEach(u => {
    const p = normalizePhone(u.phone)
    if (p) phoneToUser.set(p, u)
  })

  const conflicts = []
  let created = 0

  const managers = users.filter(u => {
    if (u.role === 'admin' || u.username === 'admin') return false
    const phones = normalizeViewUserPhones(u.permissions?.viewUserPhones)
    return phones.length > 0
  })

  for (const manager of managers) {
    const managerPhone = normalizePhone(manager.phone)
    if (!managerPhone) continue

    if (getMembershipByPhone(managerPhone)) {
      conflicts.push({ phone: managerPhone, reason: 'مدیر قبلاً در گروهی عضو است' })
      continue
    }

    const subordinatePhones = normalizeViewUserPhones(manager.permissions?.viewUserPhones)
      .filter(p => p !== managerPhone)

    const label = userDisplayName(manager) || manager.username || managerPhone
    let groupName = `گروه ${label}`
    let suffix = 2
    while (_groupsCache.some(g => g.name === groupName)) {
      groupName = `گروه ${label} (${suffix++})`
    }

    let group
    try {
      group = await createGroup(groupName)
    } catch (e) {
      conflicts.push({ phone: managerPhone, reason: e.message || 'خطا در ایجاد گروه' })
      continue
    }

    try {
      await addGroupMember(group.id, managerPhone, { asManager: true })
    } catch (e) {
      conflicts.push({ phone: managerPhone, reason: e.message || 'خطا در افزودن مدیر' })
      continue
    }

    created++

    for (const subPhone of subordinatePhones) {
      if (!phoneToUser.has(subPhone)) {
        conflicts.push({ phone: subPhone, reason: `کاربر یافت نشد (گروه ${groupName})` })
        continue
      }
      if (getMembershipByPhone(subPhone)) {
        conflicts.push({ phone: subPhone, reason: `عضویت انحصاری — در گروه دیگری است (رد شده از ${groupName})` })
        continue
      }
      try {
        await addGroupMember(group.id, subPhone, { asManager: false })
      } catch (e) {
        conflicts.push({ phone: subPhone, reason: e.message || 'خطا در افزودن عضو' })
      }
    }

    await syncGroupManagerViewPhones(group.id)
  }

  try {
    await saveSetting(MIGRATION_SETTING_KEY, true)
  } catch (e) {
    console.error('migrateLegacyViewUserPhones: failed to save flag', e)
  }

  if (conflicts.length) {
    console.warn('migrateLegacyViewUserPhones conflicts:', conflicts)
  }

  return { skipped: false, created, conflicts }
}

/**
 * Align session viewUserPhones + group metadata with membership.
 * @returns {Promise<{viewUserPhones: string[], groupId: string|null, groupName: string|null, isGroupManager: boolean}>}
 */
export async function resolveGroupSessionInfo(user) {
  const empty = { viewUserPhones: [], groupId: null, groupName: null, isGroupManager: false }
  if (!user || user.role === 'admin') return empty

  const info = await fetchGroupMembershipInfo(user.phone)
  if (info === null) {
    return {
      viewUserPhones: normalizeViewUserPhones(user.permissions?.viewUserPhones ?? user.viewUserPhones),
      groupId: user.groupId || null,
      groupName: user.groupName || null,
      isGroupManager: normalizeViewUserPhones(user.permissions?.viewUserPhones ?? user.viewUserPhones).length > 0
    }
  }

  const prev = normalizeViewUserPhones(user.permissions?.viewUserPhones)
  const derived = info.viewUserPhones
  if (prev.length !== derived.length || prev.some((p, i) => p !== derived[i])) {
    await patchUserViewPhones(user.phone, derived)
  }

  return {
    viewUserPhones: derived,
    groupId: info.groupId,
    groupName: info.groupName,
    isGroupManager: info.isGroupManager
  }
}

/** @deprecated prefer resolveGroupSessionInfo */
export async function resolveViewUserPhonesForSession(user) {
  const info = await resolveGroupSessionInfo(user)
  return info.viewUserPhones
}
