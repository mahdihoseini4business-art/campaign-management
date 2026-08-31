import { BACKUP_TABLES, emptyDeletionsMap } from './constants.js'
import { sanitizeUsersForBackup } from './backup-format.js'

/** @typedef {import('./backup-format.js').BackupScope} BackupScope */

const ORG_WIDE_PERMISSION_BY_SCOPE = {
  dashboard: 'accounting_org_wide_dashboard',
  customers: 'accounting_org_wide_customers',
  sales: 'accounting_org_wide_sales'
}

/**
 * @param {unknown} phone
 */
export function normalizePhone(phone) {
  let p = String(phone || '').replace(/\D/g, '')
  if (!p) return ''
  if (p.length > 10) p = p.slice(-10)
  if (p.length === 10 && p.startsWith('9')) p = '0' + p
  return p
}

/**
 * @param {unknown} raw
 */
export function normalizeViewUserPhones(raw) {
  if (!raw) return []
  let list = raw
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw) } catch { return [] }
  }
  if (!Array.isArray(list)) return []
  return [...new Set(list.map(p => normalizePhone(p)).filter(Boolean))]
}

/**
 * @param {Record<string, unknown>} user
 * @param {string} key
 */
function hasPermissionForUser(user, key) {
  if (!user) return false
  if (user.role === 'admin') return true
  const permissions = user.permissions
  if (!permissions || typeof permissions !== 'object') return false
  return /** @type {Record<string, unknown>} */ (permissions)[key] === true
}

/**
 * @param {Record<string, unknown>} user
 * @param {'dashboard'|'customers'|'sales'} scope
 */
export function canViewOrgWideDataForUser(user, scope) {
  if (!user) return false
  if (user.role === 'admin') return true
  const key = ORG_WIDE_PERMISSION_BY_SCOPE[scope]
  if (!key) return false
  return hasPermissionForUser(user, key)
}

/**
 * @param {Record<string, unknown>} user
 * @param {Record<string, unknown>[]} groupMembers
 * @returns {Set<string>}
 */
export function resolveAdvisorPhones(user, groupMembers = []) {
  /** @type {Set<string>} */
  const phones = new Set()
  if (!user) return phones
  if (user.role === 'admin') {
    return phones
  }

  const self = normalizePhone(user.phone)
  if (self) phones.add(self)

  normalizeViewUserPhones(
    user.viewUserPhones ?? user.permissions?.viewUserPhones
  ).forEach(p => phones.add(p))

  const userPhone = normalizePhone(user.phone)
  const member = (groupMembers || []).find(
    m => normalizePhone(m.user_phone) === userPhone
  )
  if (member?.is_manager) {
    for (const m of groupMembers || []) {
      if (String(m.group_id || '') !== String(member.group_id || '')) continue
      const p = normalizePhone(m.user_phone)
      if (p) phones.add(p)
    }
  }

  return phones
}

/**
 * @param {Record<string, unknown>} user
 * @param {Record<string, unknown>[]} groupMembers
 * @returns {BackupScope}
 */
export function resolveBackupScope(user, groupMembers = []) {
  const phones = resolveAdvisorPhones(user, groupMembers)
  const userPhone = normalizePhone(user?.phone)
  const member = (groupMembers || []).find(
    m => normalizePhone(m.user_phone) === userPhone
  )
  const teamPhones = member?.is_manager
    ? [...phones].filter(p => p !== userPhone)
    : []

  return {
    username: String(user?.username || ''),
    phone: userPhone,
    advisorPhones: [...phones],
    includesTeam: teamPhones.length > 0
  }
}

/**
 * @param {Record<string, unknown>} customer
 * @param {Record<string, unknown>} user
 * @param {Set<string>} advisorPhones
 */
export function customerVisibleToUser(customer, user, advisorPhones) {
  if (!customer || !user) return false
  if (user.role === 'admin') return true
  if (canViewOrgWideDataForUser(user, 'customers')) return true

  const ownerPhone = normalizePhone(customer.advisor_phone)
  if (ownerPhone && advisorPhones.has(ownerPhone)) return true

  const self = normalizePhone(user.phone)
  if (self && ownerPhone === self) return true

  return false
}

/**
 * @param {Record<string, unknown>} customer
 * @param {Record<string, unknown>} user
 */
export function applyCustomerTypeFilter(customer, user) {
  const id = String(customer?.id || '')
  if (id.startsWith('LD') && !hasPermissionForUser(user, 'customers_ld')) return false
  if (id.startsWith('CS') && !hasPermissionForUser(user, 'customers_cs')) return false
  return true
}

/**
 * @param {Record<string, unknown>} row
 */
function parseRecipientPhones(row) {
  const raw = row?.recipient_phones
  if (!raw) return []
  if (Array.isArray(raw)) {
    return raw.map(p => normalizePhone(p)).filter(Boolean)
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        return parsed.map(p => normalizePhone(p)).filter(Boolean)
      }
    } catch {
      return normalizePhone(raw) ? [normalizePhone(raw)] : []
    }
  }
  return []
}

/**
 * @param {Record<string, Record<string, unknown>[]>} allTables
 * @param {Record<string, unknown>} user
 * @param {{ groupMembers?: Record<string, unknown>[], groups?: Record<string, unknown>[] }} [ctx]
 * @returns {Record<string, Record<string, unknown>[]>}
 */
export function filterTablesForUser(allTables, user, ctx = {}) {
  const groupMembers = ctx.groupMembers || allTables.group_members || []
  const advisorPhones = resolveAdvisorPhones(user, groupMembers)
  const orgWideCustomers = canViewOrgWideDataForUser(user, 'customers')

  const customers = (allTables.customers || []).filter(c => {
    if (!applyCustomerTypeFilter(c, user)) return false
    if (orgWideCustomers) return true
    return customerVisibleToUser(c, user, advisorPhones)
  })

  /** @type {Set<string>} */
  const customerIds = new Set(customers.map(c => String(c.id || '')).filter(Boolean))

  const followups = (allTables.followups || []).filter(f =>
    customerIds.has(String(f.customer_id || ''))
  )

  const refunds = (allTables.refunds || []).filter(r => {
    const cid = String(r.customer_id || '')
    if (customerIds.has(cid)) return true
    const advisor = normalizePhone(r.advisor_phone)
    return !!(advisor && advisorPhones.has(advisor))
  })

  const ownership_transfers = (allTables.ownership_transfers || []).filter(t => {
    const from = normalizePhone(t.from_advisor_phone)
    const to = normalizePhone(t.to_advisor_phone)
    return (from && advisorPhones.has(from)) || (to && advisorPhones.has(to))
  })

  const ownership_transfer_acks = (allTables.ownership_transfer_acks || []).filter(a => {
    const phone = normalizePhone(a.user_phone)
    return !!(phone && advisorPhones.has(phone))
  })

  const userPhone = normalizePhone(user.phone)
  const member = groupMembers.find(m => normalizePhone(m.user_phone) === userPhone)
  const groupIds = new Set()
  if (member?.group_id != null) groupIds.add(String(member.group_id))

  const groups = (allTables.groups || []).filter(g =>
    groupIds.has(String(g.id || ''))
  )

  const group_members = groupMembers.filter(m =>
    groupIds.has(String(m.group_id || ''))
  )

  const relatedPhones = new Set(advisorPhones)
  const users = sanitizeUsersForBackup(
    (allTables.users || []).filter(u => {
      const p = normalizePhone(u.phone)
      return !!(p && relatedPhones.has(p))
    })
  )

  const notifications = (allTables.notifications || []).filter(n => {
    const recipients = parseRecipientPhones(n)
    if (!recipients.length) return false
    return recipients.some(p => advisorPhones.has(p))
  })

  const notificationIds = new Set(
    notifications.map(n => String(n.id || '')).filter(Boolean)
  )

  const notification_reads = (allTables.notification_reads || []).filter(r => {
    const phone = normalizePhone(r.user_phone)
    if (!phone || !advisorPhones.has(phone)) return false
    const nid = String(r.notification_id || '')
    return !nid || notificationIds.has(nid)
  })

  /** @type {Record<string, Record<string, unknown>[]>} */
  const scoped = {
    customers,
    followups,
    refunds,
    ownership_transfers,
    ownership_transfer_acks,
    users,
    groups,
    group_members,
    app_settings: [...(allTables.app_settings || [])],
    notifications,
    notification_reads,
  }

  for (const table of BACKUP_TABLES) {
    if (!scoped[table]) scoped[table] = []
  }

  return scoped
}

/**
 * @param {Record<string, Record<string, unknown>[]>} tables
 */
export function countTableRows(tables) {
  /** @type {Record<string, number>} */
  const counts = {}
  for (const table of BACKUP_TABLES) {
    counts[table] = (tables[table] || []).length
  }
  return counts
}

/**
 * Empty deletions for scoped backups.
 */
export function emptyScopedDeletions() {
  return emptyDeletionsMap()
}
