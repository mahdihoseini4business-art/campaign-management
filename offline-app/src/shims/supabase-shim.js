/**
 * Minimal Supabase PostgREST-compatible client for offline SQLite via IPC.
 */

function ensureApi() {
  if (!window.offlineApi?.dbRequest) {
    throw new Error('offlineApi.dbRequest در دسترس نیست — اپ را در Electron اجرا کنید.')
  }
}

class QueryBuilder {
  /**
   * @param {string} table
   * @param {string} [method]
   */
  constructor(table, method = 'select') {
    this._table = table
    this._method = method
    /** @type {Array<{ op: string, col: string, value?: unknown }>} */
    this._filters = []
    this._select = '*'
    /** @type {{ column: string, ascending: boolean } | null} */
    this._order = null
    this._limit = null
    /** @type {{ from: number, to: number } | null} */
    this._range = null
    this._body = null
    this._onConflict = null
    this._returning = null
    this._single = false
    this._maybeSingle = false
  }

  select(cols) {
    if (this._method === 'select' || this._returning != null) {
      this._select = cols
      if (this._method !== 'select') this._returning = cols
    }
    return this
  }

  insert(body) {
    this._method = 'insert'
    this._body = body
    return this
  }

  update(body) {
    this._method = 'update'
    this._body = body
    return this
  }

  upsert(body, opts = {}) {
    this._method = 'upsert'
    this._body = body
    this._onConflict = opts.onConflict || null
    return this
  }

  delete() {
    this._method = 'delete'
    return this
  }

  eq(col, value) {
    this._filters.push({ op: 'eq', col, value })
    return this
  }

  in(col, value) {
    this._filters.push({ op: 'in', col, value })
    return this
  }

  gte(col, value) {
    this._filters.push({ op: 'gte', col, value })
    return this
  }

  lte(col, value) {
    this._filters.push({ op: 'lte', col, value })
    return this
  }

  not(col, operator, value) {
    if (operator === 'is' && value === null) {
      this._filters.push({ op: 'not_is_null', col })
    }
    return this
  }

  order(column, opts = {}) {
    this._order = { column, ascending: opts.ascending !== false }
    return this
  }

  limit(n) {
    this._limit = n
    return this
  }

  range(from, to) {
    this._range = { from, to }
    return this
  }

  single() {
    this._single = true
    return this
  }

  maybeSingle() {
    this._maybeSingle = true
    return this
  }

  _payload() {
    return {
      table: this._table,
      method: this._method,
      select: this._select,
      filters: this._filters,
      order: this._order,
      limit: this._limit,
      range: this._range,
      body: this._body,
      onConflict: this._onConflict,
      returning: this._returning,
      single: this._single,
      maybeSingle: this._maybeSingle
    }
  }

  then(onFulfilled, onRejected) {
    ensureApi()
    return window.offlineApi.dbRequest(this._payload()).then(onFulfilled, onRejected)
  }
}

function from(table) {
  return new QueryBuilder(table, 'select')
}

function channel() {
  return {
    on() { return this },
    subscribe() { return this }
  }
}

function removeChannel() {}

const functions = {
  async invoke() {
    return { data: null, error: { message: 'Edge Functions در نسخه آفلاین غیرفعال است.' } }
  }
}

export const supabase = {
  from,
  channel,
  removeChannel,
  functions
}
