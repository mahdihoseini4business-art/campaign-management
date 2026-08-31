import { supabase } from '../supabase.js'

const PAGE_SIZE = 1000

/**
 * Fetch every row from a Supabase table (pages past PostgREST 1000-row cap).
 * @param {string} table
 * @param {object} [opts]
 * @param {string} [opts.select]
 * @param {string} [opts.orderCol]
 * @param {boolean} [opts.ascending]
 * @returns {Promise<{ data: any[], error: import('@supabase/supabase-js').PostgrestError | null }>}
 */
export async function fetchAllRows(table, opts = {}) {
  const {
    select = '*',
    orderCol = 'id',
    ascending = true
  } = opts

  const all = []
  let from = 0

  for (;;) {
    let q = supabase.from(table).select(select)
    if (orderCol) q = q.order(orderCol, { ascending })
    q = q.range(from, from + PAGE_SIZE - 1)

    const { data, error } = await q
    if (error) return { data: all, error }

    const chunk = data || []
    all.push(...chunk)
    if (chunk.length < PAGE_SIZE) return { data: all, error: null }
    from += PAGE_SIZE
  }
}

/**
 * Fetch app_settings as key/value rows (not paged — typically small).
 */
export async function fetchAppSettings() {
  const { data, error } = await supabase.from('app_settings').select('key,value').order('key')
  return { data: data || [], error }
}

/**
 * Fetch with column fallback when optional columns are missing on older DBs.
 * @param {string} table
 * @param {string} select
 * @param {string} orderCol
 * @param {RegExp[]} stripPatterns patterns to remove from select on retry
 */
export async function fetchAllRowsWithFallback(table, select, orderCol, stripPatterns = []) {
  let currentSelect = select
  let lastError = null

  for (let attempt = 0; attempt <= stripPatterns.length; attempt++) {
    const { data, error } = await fetchAllRows(table, {
      select: currentSelect,
      orderCol,
      ascending: true
    })
    if (!error) return { data, error: null }
    lastError = error
    const msg = error.message || ''
    const pattern = stripPatterns[attempt]
    if (!pattern || !pattern.test(msg)) break
    currentSelect = currentSelect.replace(pattern, '')
  }

  return { data: [], error: lastError }
}
