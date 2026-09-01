/**
 * Derived indexes over in-memory data — rebuilt on invalidate, not stale snapshots.
 * Invalidated from data.js on cache mutations (same hooks as productSalesCountCache).
 */

import { getData } from './data.js'
import { getCustomerPhones, normalizePhone } from './utils.js'

let dataVersion = 0

let customersById = null
let followupsByCustomerId = null
let referralCountByCustomerId = null
let allSalesFlat = null

export function getDataVersion() {
  return dataVersion
}

export function bumpDataVersion() {
  dataVersion += 1
}

/** @param {'all'|'customers'|'followups'|'sales'} [scope] */
export function invalidateDerivedCache(scope = 'all') {
  bumpDataVersion()
  if (scope === 'followups') {
    followupsByCustomerId = null
    return
  }
  customersById = null
  referralCountByCustomerId = null
  allSalesFlat = null
  if (scope === 'all') {
    followupsByCustomerId = null
  }
}

export function buildFollowupsByCustomerMap(followups) {
  const map = new Map()
  for (const f of followups || []) {
    const id = f.customerId
    if (!id) continue
    const list = map.get(id)
    if (list) list.push(f)
    else map.set(id, [f])
  }
  return map
}

function ensureCustomersById() {
  if (customersById) return customersById
  customersById = new Map()
  for (const c of getData().customers || []) {
    if (c?.id) customersById.set(c.id, c)
  }
  return customersById
}

export function getCustomersById() {
  return ensureCustomersById()
}

export function getCustomerById(id) {
  if (!id) return null
  return ensureCustomersById().get(id) || null
}

function ensureFollowupsByCustomerId() {
  if (followupsByCustomerId) return followupsByCustomerId
  followupsByCustomerId = buildFollowupsByCustomerMap(getData().followups)
  return followupsByCustomerId
}

export function getFollowupsByCustomerId() {
  return ensureFollowupsByCustomerId()
}

function ensureReferralCountByCustomerId() {
  if (referralCountByCustomerId) return referralCountByCustomerId
  const customers = getData().customers || []
  referralCountByCustomerId = new Map()
  for (const c of customers) {
    if (!c?.id) continue
    const phones = getCustomerPhones(c)
    if (!phones.length) {
      referralCountByCustomerId.set(c.id, 0)
      continue
    }
    const set = new Set(phones)
    let count = 0
    for (const other of customers) {
      if (other.id === c.id) continue
      if (set.has(normalizePhone(other.referredByPhone))) count++
    }
    referralCountByCustomerId.set(c.id, count)
  }
  return referralCountByCustomerId
}

export function getReferralCountForCustomer(customerId) {
  if (!customerId) return 0
  return ensureReferralCountByCustomerId().get(customerId) ?? 0
}

export function setAllSalesCache(sales) {
  allSalesFlat = sales
}

export function getAllSalesFromCache() {
  return allSalesFlat
}

export function clearAllSalesCache() {
  allSalesFlat = null
}
