/**
 * query-builder query builder backed by `pg`.
 *
 * Reproduces the subset of the db-js builder this codebase actually uses,
 * so the ~266 existing `.from(...)` call sites keep working unchanged after the
 * tenant hosted backend is removed.
 *
 * Contract kept identical to db-js v2:
 *   - the builder is thenable, resolving to `{ data, error, count }`
 *   - it never rejects; failures come back as `error`
 *   - `.single()` with no rows yields error code `NO_ROWS`
 *   - PostgreSQL error codes (23505, 23503, …) pass through untouched
 */

const { quoteIdent, quoteTable, buildCondition, buildOrCondition } = require('./filters');
const { EMBEDDED_SELECTS } = require('./embedded');

/**
 * Shape an error the way callers already expect from db-js.
 *
 * @param {Error} err - Underlying error (usually from pg)
 * @returns {object} pg query layer-shaped error
 */
function toDbError(err) {
  return {
    message: err.message,
    code: err.code || 'DB_ERROR',
    details: err.detail || err.details || null,
    hint: err.hint || null
  };
}

class PgRestQuery {
  /**
   * @param {object} pool - pg Pool
   * @param {string} table - Table name
   */
  constructor(pool, table) {
    this._pool = pool;
    this._table = table;

    this._mode = 'select';          // select | insert | update | upsert | delete
    this._columns = '*';
    this._values = null;
    this._onConflict = null;
    this._returning = false;        // whether a mutation should RETURN rows

    this._filters = [];             // {kind:'op'|'or', …}
    this._orders = [];
    this._limit = null;
    this._offset = null;

    this._single = false;
    this._maybeSingle = false;
    this._count = null;             // 'exact' | null
    this._head = false;
  }

  // ── projection / mutation ────────────────────────────────────────────────

  select(columns = '*', options = {}) {
    this._columns = columns || '*';
    if (options.count) this._count = options.count;
    if (options.head) this._head = true;
    // `.select()` after a mutation turns it into a RETURNING clause.
    if (this._mode !== 'select') this._returning = true;
    return this;
  }

  insert(values) {
    this._mode = 'insert';
    this._values = Array.isArray(values) ? values : [values];
    return this;
  }

  upsert(values, options = {}) {
    this._mode = 'upsert';
    this._values = Array.isArray(values) ? values : [values];
    this._onConflict = options.onConflict || null;
    return this;
  }

  update(values) {
    this._mode = 'update';
    this._values = values;
    return this;
  }

  delete() {
    this._mode = 'delete';
    return this;
  }

  // ── filters ──────────────────────────────────────────────────────────────

  _addFilter(column, op, value) {
    this._filters.push({ kind: 'op', column, op, value });
    return this;
  }

  eq(column, value) { return this._addFilter(column, 'eq', value); }
  neq(column, value) { return this._addFilter(column, 'neq', value); }
  gt(column, value) { return this._addFilter(column, 'gt', value); }
  gte(column, value) { return this._addFilter(column, 'gte', value); }
  lt(column, value) { return this._addFilter(column, 'lt', value); }
  lte(column, value) { return this._addFilter(column, 'lte', value); }
  like(column, value) { return this._addFilter(column, 'like', value); }
  ilike(column, value) { return this._addFilter(column, 'ilike', value); }
  is(column, value) { return this._addFilter(column, 'is', value); }
  in(column, values) { return this._addFilter(column, 'in', values); }
  contains(column, value) { return this._addFilter(column, 'contains', value); }
  overlaps(column, value) { return this._addFilter(column, 'overlaps', value); }

  not(column, op, value) {
    return this._addFilter(column, 'not', { op, value });
  }

  or(filterString) {
    this._filters.push({ kind: 'or', value: filterString });
    return this;
  }

  filter(column, op, value) {
    return this._addFilter(column, op, value);
  }

  match(criteria) {
    for (const [column, value] of Object.entries(criteria || {})) {
      this._addFilter(column, 'eq', value);
    }
    return this;
  }

  // ── ordering / paging ────────────────────────────────────────────────────

  order(column, options = {}) {
    if (!column) return this;
    this._orders.push({
      column,
      ascending: options.ascending !== false,
      nullsFirst: options.nullsFirst
    });
    return this;
  }

  limit(n) {
    this._limit = n;
    return this;
  }

  range(from, to) {
    this._offset = from;
    this._limit = (to - from) + 1;
    return this;
  }

  single() {
    this._single = true;
    return this;
  }

  maybeSingle() {
    this._maybeSingle = true;
    return this;
  }

  // ── SQL construction ─────────────────────────────────────────────────────

  /**
   * Render the WHERE clause.
   *
   * @param {function(any): string} addParam - Parameter registrar
   * @returns {string} `WHERE …` or empty string
   */
  _buildWhere(addParam) {
    if (this._filters.length === 0) return '';
    const parts = this._filters.map(f =>
      f.kind === 'or'
        ? buildOrCondition(f.value, addParam)
        : buildCondition(f, addParam)
    );
    return ` WHERE ${parts.join(' AND ')}`;
  }

  /**
   * Render ORDER BY / LIMIT / OFFSET.
   *
   * @param {function(any): string} addParam - Parameter registrar
   * @returns {string} Trailing clauses
   */
  _buildTail(addParam) {
    let sql = '';

    if (this._orders.length > 0) {
      const cols = this._orders.map(o => {
        let frag = `${quoteIdent(o.column)} ${o.ascending ? 'ASC' : 'DESC'}`;
        if (o.nullsFirst === true) frag += ' NULLS FIRST';
        else if (o.nullsFirst === false) frag += ' NULLS LAST';
        return frag;
      });
      sql += ` ORDER BY ${cols.join(', ')}`;
    }

    if (this._limit !== null && this._limit !== undefined) {
      sql += ` LIMIT ${addParam(this._limit)}`;
    }
    if (this._offset) {
      sql += ` OFFSET ${addParam(this._offset)}`;
    }
    return sql;
  }

  /**
   * Render the projection list for a SELECT.
   *
   * @returns {string} Column list
   */
  _buildProjection() {
    const raw = String(this._columns || '*').trim();
    if (raw === '*' || raw === '') return '*';

    return raw
      .split(',')
      .map(c => c.trim())
      .filter(Boolean)
      .map(c => (c === '*' ? '*' : quoteIdent(c)))
      .join(', ');
  }

  /**
   * Compile the whole statement.
   *
   * @returns {{text: string, values: any[]}}
   */
  _toSql() {
    const values = [];
    const addParam = (v) => {
      values.push(v);
      return `$${values.length}`;
    };

    const table = quoteTable(this._table);
    let text;

    if (this._mode === 'select') {
      if (this._head && this._count) {
        text = `SELECT count(*)::bigint AS "__count" FROM ${table}`;
        text += this._buildWhere(addParam);
      } else {
        text = `SELECT ${this._buildProjection()} FROM ${table}`;
        text += this._buildWhere(addParam);
        text += this._buildTail(addParam);
      }
    } else if (this._mode === 'insert' || this._mode === 'upsert') {
      const rows = this._values || [];
      if (rows.length === 0) throw new Error('insert/upsert called with no rows');

      // Union the keys so rows with differing shapes still line up; missing
      // keys become NULL rather than shifting columns.
      const columns = [...new Set(rows.flatMap(r => Object.keys(r)))];
      const colSql = columns.map(quoteIdent).join(', ');
      const tuples = rows.map(row =>
        `(${columns.map(c => addParam(row[c] === undefined ? null : row[c])).join(', ')})`
      );

      text = `INSERT INTO ${table} (${colSql}) VALUES ${tuples.join(', ')}`;

      if (this._mode === 'upsert') {
        const conflictCols = (this._onConflict
          ? this._onConflict.split(',').map(c => c.trim())
          : ['id']
        ).map(quoteIdent).join(', ');

        const updates = columns
          .filter(c => !(this._onConflict || 'id').split(',').map(x => x.trim()).includes(c))
          .map(c => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`);

        text += updates.length > 0
          ? ` ON CONFLICT (${conflictCols}) DO UPDATE SET ${updates.join(', ')}`
          : ` ON CONFLICT (${conflictCols}) DO NOTHING`;
      }
    } else if (this._mode === 'update') {
      const entries = Object.entries(this._values || {});
      if (entries.length === 0) throw new Error('update called with no values');
      const sets = entries.map(([c, v]) => `${quoteIdent(c)} = ${addParam(v)}`);
      text = `UPDATE ${table} SET ${sets.join(', ')}`;
      text += this._buildWhere(addParam);
    } else if (this._mode === 'delete') {
      text = `DELETE FROM ${table}`;
      text += this._buildWhere(addParam);
    } else {
      throw new Error(`Unknown query mode: ${this._mode}`);
    }

    // Mutations only return rows when `.select()` was chained.
    if (this._mode !== 'select' && this._returning) {
      text += ` RETURNING ${this._buildProjection()}`;
    }

    return { text, values };
  }

  // ── execution ────────────────────────────────────────────────────────────

  /**
   * Run the query and shape the db-js style result.
   *
   * @returns {Promise<{data: any, error: object|null, count: number|null}>}
   */
  async _execute() {
    if (!this._pool) {
      return {
        data: null,
        count: null,
        error: {
          message: 'PostgreSQL pool not configured. Please set DATABASE_URL.',
          code: 'DB_ERROR',
          details: null,
          hint: null
        }
      };
    }

    // The two embedded-resource selects in this codebase are handled by
    // purpose-built SQL rather than a general pg query layer join implementation.
    const embedded = EMBEDDED_SELECTS[String(this._columns).replace(/\s+/g, ' ').trim()];
    if (embedded && this._mode === 'select') {
      return embedded(this);
    }

    let compiled;
    try {
      compiled = this._toSql();
    } catch (err) {
      return { data: null, count: null, error: toDbError(err) };
    }

    try {
      const result = await this._pool.query(compiled.text, compiled.values);

      if (this._head && this._count) {
        return { data: null, count: Number(result.rows[0]?.__count ?? 0), error: null };
      }

      const rows = result.rows;

      if (this._single || this._maybeSingle) {
        if (rows.length === 0) {
          if (this._maybeSingle) return { data: null, count: null, error: null };
          return {
            data: null,
            count: null,
            error: {
              message: 'JSON object requested, multiple (or no) rows returned',
              code: 'NO_ROWS',
              details: 'The result contains 0 rows',
              hint: null
            }
          };
        }
        return { data: rows[0], count: null, error: null };
      }

      // `.select('*', { count: 'exact' })` without head: rows plus a total.
      // Without a LIMIT the row count is the total, which is the common case.
      let count = null;
      if (this._count) {
        count = this._limit === null || this._limit === undefined
          ? rows.length
          : await this._countAll();
      }

      // A mutation without `.select()` yields null data, as in db-js.
      const data = (this._mode !== 'select' && !this._returning) ? null : rows;
      return { data, count, error: null };
    } catch (err) {
      return { data: null, count: null, error: toDbError(err) };
    }
  }

  /**
   * Total matching rows, ignoring LIMIT/OFFSET — for `{ count: 'exact' }`
   * combined with paging.
   *
   * @returns {Promise<number>}
   */
  async _countAll() {
    const values = [];
    const addParam = (v) => { values.push(v); return `$${values.length}`; };
    const text = `SELECT count(*)::bigint AS "__count" FROM ${quoteTable(this._table)}${this._buildWhere(addParam)}`;
    const result = await this._pool.query(text, values);
    return Number(result.rows[0]?.__count ?? 0);
  }

  /** Thenable: `await query` behaves like the db-js builder. */
  then(onFulfilled, onRejected) {
    return this._execute().then(onFulfilled, onRejected);
  }

  catch(onRejected) {
    return this._execute().catch(onRejected);
  }

  finally(onFinally) {
    return this._execute().finally(onFinally);
  }
}

module.exports = { PgRestQuery, toDbError };
