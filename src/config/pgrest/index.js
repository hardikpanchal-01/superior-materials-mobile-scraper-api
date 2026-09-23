/**
 * Drop-in replacement for the tenant the database client, backed by `pg`.
 *
 * This tenant database is a plain CloudNativePG Postgres — there is no
 * a hosted API layer in front of it. This module provides
 * the same surface db-js exposed so the existing call sites keep
 * working:
 *
 *   client.from(table)…            → SQL via PgRestQuery
 *   client.rpc(name, args)         → SELECT * FROM name(...)
 *   client.auth / client.auth.admin → auth.users
 *   client.storage                 → public.storage_objects
 *
 * The connection role is expected to have BYPASSRLS, matching what the elevated role
 * service key did, so the former anon/service-key distinction has no
 * behavioural effect and both factories return the same client.
 */

const { PgRestQuery } = require('./queryBuilder');
const { createAuth } = require('./auth');
const { createStorage } = require('./storage');

/**
 * Prepare a value for use as a function argument.
 *
 * The AI functions take `jsonb` parameters and callers pass plain JS arrays and
 * objects. node-postgres would render an array as a PostgreSQL array literal
 * (`{}`), which Postgres then reads as an empty jsonb *object* — so
 * `jsonb_array_length` fails with "cannot get array length of a non-array".
 * Serialising to JSON text instead lets Postgres coerce it to the declared
 * parameter type, which is what pg query layer did.
 *
 * @param {any} value - Argument value
 * @returns {any} Value safe to pass as a query parameter
 */
function toRpcParam(value) {
  if (value === null || value === undefined) return value;
  if (Buffer.isBuffer(value) || value instanceof Date) return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

const SCHEMA_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Build a client bound to a pg pool.
 *
 * @param {object} pool - pg Pool (may be null if the URL is unset)
 * @param {object} [options] - {schema} default schema for from()/rpc()
 * @returns {object} query-builder client
 */
function createPgRestClient(pool, options = {}) {
  const defaultSchema = options.schema || 'public';

  if (!SCHEMA_RE.test(defaultSchema)) {
    throw new Error(`Unsafe schema name: ${defaultSchema}`);
  }

  /**
   * Qualify a table with the active schema. `public` is left bare so the
   * search_path still applies, matching the previous behaviour.
   *
   * @param {string} table - Table name
   * @returns {string} Possibly schema-qualified name
   */
  const qualify = (table) =>
    (defaultSchema === 'public' || String(table).includes('.'))
      ? table
      : `${defaultSchema}.${table}`;

  return {
    /**
     * @param {string} table - Table name
     * @returns {PgRestQuery} Query builder
     */
    from(table) {
      return new PgRestQuery(pool, qualify(table));
    },

    /**
     * Scope subsequent calls to another schema, as `db.schema('x')` does.
     * The central auth database is addressed this way — `auth_tenant`.
     *
     * @param {string} name - Schema name
     * @returns {object} A client bound to that schema
     */
    schema(name) {
      return createPgRestClient(pool, { ...options, schema: name });
    },

    /**
     * Call a Postgres function.
     *
     * All six functions the AI layer uses (`ai_select_rows`, `ai_aggregate`,
     * `ai_count`, `_ai_validate_columns`, `ai_record_feedback`,
     * `increment_short_url_click`) already exist in the database, so this just
     * needs to invoke them by named argument.
     *
     * @param {string} name - Function name
     * @param {object} [args] - Named arguments
     * @returns {Promise<{data: any, error: object|null}>}
     */
    async rpc(name, args = {}) {
      if (!pool) {
        return {
          data: null,
          error: { message: 'PostgreSQL pool not configured. Please set DATABASE_URL.', code: 'DB_ERROR' }
        };
      }

      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name))) {
        return { data: null, error: { message: `Unsafe function name: ${name}`, code: 'DB_ERROR' } };
      }

      const entries = Object.entries(args || {});
      const values = entries.map(([, v]) => toRpcParam(v));
      // Named notation (`arg => $n`) so overloaded functions resolve the same
      // way pg query layer resolves them — `ai_select_rows` has two signatures.
      const argSql = entries
        .map(([key], i) => {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
            throw new Error(`Unsafe argument name: ${key}`);
          }
          return `"${key}" => $${i + 1}`;
        })
        .join(', ');

      const fnRef = defaultSchema === 'public' ? `"${name}"` : `"${defaultSchema}"."${name}"`;

      try {
        const result = await pool.query(`SELECT * FROM ${fnRef}(${argSql})`, values);
        const rows = result.rows;

        // A function returning a single scalar comes back as one row with one
        // column; pg query layer unwraps that to the bare value.
        if (rows.length === 1 && Object.keys(rows[0]).length === 1) {
          const only = Object.values(rows[0])[0];
          return { data: only, error: null };
        }
        return { data: rows, error: null };
      } catch (err) {
        return {
          data: null,
          error: {
            message: err.message,
            // Undefined function → the code the AI layer checks for.
            code: err.code === '42883' ? 'FN_NOT_FOUND' : (err.code || 'DB_ERROR'),
            details: err.detail || null,
            hint: err.hint || null
          }
        };
      }
    },

    auth: createAuth(pool),
    storage: createStorage(pool)
  };
}

module.exports = { createPgRestClient };
