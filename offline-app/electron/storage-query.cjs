const { getDatabase, persistDatabase, queryAll, queryOne } = require('./db.cjs')
const {
  TABLE_COLUMNS,
  AUTO_ID_TABLES,
  recordKey,
  PRIMARY_KEYS
} = require('./table-config.cjs')
const { serializeCell, deserializeRow } = require('./row-serialize.cjs')
const { logDeletion } = require('./storage.cjs')

/** @type {string | null} */
let currentActorPhone = null

function setCurrentActorPhone(phone) {
  currentActorPhone = phone ? String(phone) : null
}

function nextAutoId(table) {
  const row = queryOne(`SELECT MAX(id) AS m FROM ${table}`)
  return Number(row?.m || 0) + 1
}

/**
 * @param {string} select
 * @returns {{ columns: string[], nested?: { table: string, cols: string[] } }}
 */
function parseSelect(select) {
  const raw = String(select || '*').trim()
  if (!raw || raw === '*') {
    return { columns: ['*'] }
  }
  const nestedMatch = raw.match(/,\s*(\w+)\(([^)]+)\)/)
  if (nestedMatch) {
    const base = raw.replace(nestedMatch[0], '').replace(/,\s*$/, '').trim()
    const cols = base ? base.split(',').map(s => s.trim()).filter(Boolean) : ['*']
    return {
      columns: cols.length ? cols : ['*'],
      nested: {
        table: nestedMatch[1],
        cols: nestedMatch[2].split(',').map(s => s.trim()).filter(Boolean)
      }
    }
  }
  return { columns: raw.split(',').map(s => s.trim()).filter(Boolean) }
}

/**
 * @param {Record<string, unknown>} row
 * @param {string[]} columns
 */
function projectRow(row, columns) {
  if (!row) return row
  if (columns.includes('*')) return { ...row }
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const col of columns) {
    if (col in row) out[col] = row[col]
  }
  return out
}

/**
 * @param {unknown} value
 */
function compareValues(value, expected) {
  if (value === expected) return true
  if (value == null && expected == null) return true
  if (typeof value === 'number' && Number(expected) === value) return true
  return String(value) === String(expected)
}

/**
 * @param {Record<string, unknown>} row
 * @param {Array<{ op: string, col: string, value?: unknown }>} filters
 */
function matchesFilters(row, filters) {
  for (const f of filters) {
    const val = row[f.col]
    switch (f.op) {
      case 'eq':
        if (!compareValues(val, f.value)) return false
        break
      case 'in':
        if (!Array.isArray(f.value) || !f.value.some(v => compareValues(val, v))) return false
        break
      case 'gte':
        if (val == null || String(val) < String(f.value)) return false
        break
      case 'lte':
        if (val == null || String(val) > String(f.value)) return false
        break
      case 'not_is_null':
        if (val == null || val === '') return false
        break
      case 'is_null':
        if (val != null && val !== '') return false
        break
      default:
        break
    }
  }
  return true
}

/**
 * @param {string} table
 * @param {Array<{ op: string, col: string, value?: unknown }>} filters
 */
function fetchMatchingRows(table, filters = []) {
  const rows = queryAll(`SELECT * FROM ${table}`).map(r => deserializeRow(table, r))
  return rows.filter(r => matchesFilters(r, filters))
}

/**
 * @param {string} table
 * @param {Record<string, unknown>} row
 */
function writeRow(table, row) {
  const cols = TABLE_COLUMNS[table]
  if (!cols) throw new Error(`جدول ناشناخته: ${table}`)
  const payload = { ...row }
  if (AUTO_ID_TABLES.has(table) && (payload.id == null || payload.id === '')) {
    payload.id = nextAutoId(table)
  }
  const values = cols.map(col => serializeCell(table, col, payload[col]))
  const placeholders = cols.map(() => '?').join(', ')
  getDatabase().run(
    `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`,
    values
  )
  return deserializeRow(table, payload)
}

/**
 * @param {object} req
 */
function executeDbRequest(req) {
  const table = req.table
  const method = req.method || 'select'
  if (!TABLE_COLUMNS[table] && table !== 'deletion_log') {
    return { data: null, error: { message: `جدول ناشناخته: ${table}` } }
  }

  try {
    if (method === 'select') {
      return handleSelect(table, req)
    }
    if (method === 'insert') {
      return handleInsert(table, req)
    }
    if (method === 'update') {
      return handleUpdate(table, req)
    }
    if (method === 'upsert') {
      return handleUpsert(table, req)
    }
    if (method === 'delete') {
      return handleDelete(table, req)
    }
    return { data: null, error: { message: `متد ناشناخته: ${method}` } }
  } catch (err) {
    return { data: null, error: { message: err?.message || String(err) } }
  }
}

function handleSelect(table, req) {
  const parsed = parseSelect(req.select)
  let rows = fetchMatchingRows(table, req.filters || [])

  if (req.order?.column) {
    const col = req.order.column
    const asc = req.order.ascending !== false
    rows.sort((a, b) => {
      const av = a[col]
      const bv = b[col]
      if (av === bv) return 0
      if (av == null) return asc ? -1 : 1
      if (bv == null) return asc ? 1 : -1
      return asc ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av))
    })
  }

  if (req.range) {
    rows = rows.slice(req.range.from, req.range.to + 1)
  } else if (req.limit != null) {
    rows = rows.slice(0, req.limit)
  }

  if (parsed.nested) {
    rows = rows.map(row => {
      const copy = { ...row }
      if (parsed.nested && row.group_id) {
        const g = queryOne('SELECT id, name FROM groups WHERE id = ?', [row.group_id])
        copy[parsed.nested.table] = g ? projectRow(g, parsed.nested.cols) : null
      }
      return copy
    })
  }

  rows = rows.map(r => projectRow(r, parsed.columns))

  if (req.single) {
    if (rows.length !== 1) {
      return { data: null, error: { message: rows.length ? 'چند ردیف یافت شد' : 'ردیف یافت نشد' } }
    }
    return { data: rows[0], error: null }
  }
  if (req.maybeSingle) {
    return { data: rows[0] || null, error: null }
  }
  return { data: rows, error: null }
}

function handleInsert(table, req) {
  const body = Array.isArray(req.body) ? req.body[0] : req.body
  const saved = writeRow(table, body || {})
  persistDatabase()
  const out = req.returning ? projectRow(saved, parseSelect(req.returning).columns) : saved
  if (req.single) return { data: out, error: null }
  return { data: req.returning ? [out] : saved, error: null }
}

function handleUpdate(table, req) {
  const matches = fetchMatchingRows(table, req.filters || [])
  if (!matches.length) {
    return req.single
      ? { data: null, error: { message: 'ردیف یافت نشد' } }
      : { data: [], error: null }
  }
  const updated = []
  for (const row of matches) {
    const merged = { ...row, ...(req.body || {}) }
    updated.push(writeRow(table, merged))
  }
  persistDatabase()
  if (req.single) return { data: updated[0], error: null }
  return { data: updated, error: null }
}

function handleUpsert(table, req) {
  const body = Array.isArray(req.body) ? req.body : [req.body]
  const saved = body.filter(Boolean).map(row => writeRow(table, row))
  persistDatabase()
  const first = saved[0] || null
  const out = req.returning && first
    ? projectRow(first, parseSelect(req.returning).columns)
    : first
  if (req.single) return { data: out, error: null }
  return { data: saved, error: null }
}

function deleteRowByPk(table, row) {
  const pk = PRIMARY_KEYS[table]
  if (!pk) throw new Error(`کلید اصلی برای ${table} تعریف نشده`)
  if (Array.isArray(pk)) {
    const sql = `DELETE FROM ${table} WHERE ${pk.map(c => `${c} = ?`).join(' AND ')}`
    getDatabase().run(sql, pk.map(c => row[c]))
    return
  }
  getDatabase().run(`DELETE FROM ${table} WHERE ${pk} = ?`, [row[pk]])
}

function handleDelete(table, req) {
  const matches = fetchMatchingRows(table, req.filters || [])
  for (const row of matches) {
    const key = recordKey(table, row)
    if (key) logDeletion(table, key, currentActorPhone || '')
    deleteRowByPk(table, row)
  }
  persistDatabase()
  return { data: matches, error: null }
}

module.exports = {
  setCurrentActorPhone,
  executeDbRequest
}
