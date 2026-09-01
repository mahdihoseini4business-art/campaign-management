/** Shared debounced search for tab filter boxes (typing only — not live-sync). */

import { showSearchOverlay, hideSearchOverlay } from './search-overlay.js'

export const SEARCH_DEBOUNCE_MS = 250

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const timers = new Map()

export function cancelDebouncedSearch(hostKey) {
  const t = timers.get(hostKey)
  if (t) {
    clearTimeout(t)
    timers.delete(hostKey)
  }
}

/**
 * @param {string} hostKey — SEARCH_HOST value
 * @param {() => void | Promise<void>} renderFn
 */
export function debouncedSearchInput(hostKey, renderFn) {
  cancelDebouncedSearch(hostKey)
  const gen = showSearchOverlay(hostKey)
  const timer = setTimeout(async () => {
    timers.delete(hostKey)
    try {
      await renderFn()
    } finally {
      hideSearchOverlay(hostKey, gen)
    }
  }, SEARCH_DEBOUNCE_MS)
  timers.set(hostKey, timer)
}
