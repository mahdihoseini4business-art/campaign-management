const { JSON_COLUMNS, BOOL_COLUMNS, TABLE_COLUMNS } = require('./table-config.cjs')

/**
 * @param {string} table
 * @param {string} col
 * @param {unknown} value
 */
function serializeCell(table, col, value) {
  if (JSON_COLUMNS[table]?.includes(col)) {
    if (value === null || value === undefined) {
      return col === 'value' ? '{}' : '[]'
    }
    if (typeof value === 'string') return value
    return JSON.stringify(value)
  }
  if (BOOL_COLUMNS[table]?.includes(col)) {
    return value ? 1 : 0
  }
  if (value === null || value === undefined) return null
  return value
}

/**
 * @param {string} table
 * @param {Record<string, unknown>} row
 */
function serializeRow(table, row) {
  const cols = TABLE_COLUMNS[table]
  if (!cols) throw new Error(`جدول ناشناخته: ${table}`)
  return cols.map(col => serializeCell(table, col, row[col]))
}

/**
 * @param {string} table
 * @param {Record<string, unknown>} row
 */
function deserializeRow(table, row) {
  if (!row || typeof row !== 'object') return row
  const out = { ...row }
  for (const col of JSON_COLUMNS[table] || []) {
    const raw = out[col]
    if (typeof raw !== 'string') continue
    try {
      out[col] = JSON.parse(raw)
    } catch {
      // keep string
    }
  }
  for (const col of BOOL_COLUMNS[table] || []) {
    out[col] = !!out[col]
  }
  return out
}

/**
 * Convert sql.js exec result to array of objects.
 * @param {import('sql.js').QueryExecResult[] | undefined} result
 */
function rowsFromExec(result) {
  if (!result?.length) return []
  const { columns, values } = result[0]
  return (values || []).map(cells => {
    /** @type {Record<string, unknown>} */
    const row = {}
    columns.forEach((col, i) => { row[col] = cells[i] })
    return row
  })
}

module.exports = {
  serializeCell,
  serializeRow,
  deserializeRow,
  rowsFromExec
}
