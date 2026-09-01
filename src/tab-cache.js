/**
 * Safe tab render cache — skip re-render only when dataVersion + filterSig + page match.
 * Any cache mutation bumps dataVersion → all tabs stale.
 */

import { getDataVersion } from './derived-cache.js'

/** @type {Record<string, { dataVersion: number, cacheKey: string }>} */
const tabState = {}

/**
 * @param {string} tab
 * @param {string} cacheKey — filterSig + page + view-specific state
 */
export function shouldSkipTabRender(tab, cacheKey) {
  const st = tabState[tab]
  if (!st) return false
  return st.dataVersion === getDataVersion() && st.cacheKey === cacheKey
}

/** @param {string} tab @param {string} cacheKey */
export function markTabRendered(tab, cacheKey) {
  tabState[tab] = { dataVersion: getDataVersion(), cacheKey }
}

/** Build cache key suffix for paginated tabs. */
export function tabPageKey(paginationKey, page) {
  return `${paginationKey}|p${page || 1}`
}
