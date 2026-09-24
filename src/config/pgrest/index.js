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
const { restQuery, toJsonParam } = require('./types');

/**
 * Prepare a value for use as a function argument, given the declared type of
 * that parameter.
 *
 * - json/jsonb: sent as JSON text. node-postgres would otherwise render a JS
 *   array as a Postgres array literal (`{}`), which reads as an empty jsonb
 *   *object*.
 * - real array types (`text[]`, e.g. `_ai_validate_columns.p_columns`): passed
 *   as a JS array so node-postgres renders a proper array literal. JSON text
 *   here fails with "malformed array literal".
 * - unknown type (metadata lookup failed): objects are sent as JSON text.
 *
 * @param {any} value - Argument value
 * @param {{typname: string, typcategory: string}|undefined} type - Declared type
 * @returns {any} Value safe to pass as a query parameter
 */
function toRpcParam(value, type) {
  if (value === null || value === undefined) return value;
  if (type && (type.typname === 'json' || type.typname === 'jsonb')) return toJsonParam(value);
  if (type && type.typcategory === 'A') return value;
  if (Buffer.isBuffer(value) || value instanceof Date) return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

// pool -> Map("schema.name" -> overloads[])
const fnCache = new WeakMap();

/**
 * Signatures of every overload of a function, cached per pool.
 *
 * @param {object} pool - pg Pool
 * @param {string} schema - Schema name
 * @param {string} name - Function name
 * @returns {Promise<object[]>} `[{args: {name: {typname, typcategory}}, retset, retKind}]`
 */
async function functionOverloads(pool, schema, name) {
  let perPool = fnCache.get(pool);
  if (!perPool) {
    perPool = new Map();
    fnCache.set(pool, perPool);
  }
  const key = `${schema}.${name}`;
  if (perPool.has(key)) return perPool.get(key);

  const result = await pool.query(
    `SELECT p.proretset AS retset,
            rt.typname AS ret_typname,
            rt.typtype AS ret_typtype,
            COALESCE(p.proargnames, '{}') AS argnames,
            COALESCE(p.proargmodes::text[], '{}') AS argmodes,
            ARRAY(SELECT t.typname::text
                    FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY u(oid, ord)
                    JOIN pg_type t ON t.oid = u.oid ORDER BY u.ord) AS in_typnames,
            ARRAY(SELECT t.typcategory::text
                    FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY u(oid, ord)
                    JOIN pg_type t ON t.oid = u.oid ORDER BY u.ord) AS in_typcats
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_type rt ON rt.oid = p.prorettype
      WHERE n.nspname = $1 AND p.proname = $2`,
    [schema, name]
  );

  const overloads = result.rows.map(r => {
    // proargnames also lists OUT/TABLE columns; keep only the inputs, which
    // line up one-to-one with proargtypes.
    const inputNames = r.argmodes.length === 0
      ? r.argnames.slice(0, r.in_typnames.length)
      : r.argnames.filter((_, i) => ['i', 'b', 'v'].includes(r.argmodes[i]));
    const args = {};
    inputNames.forEach((argName, i) => {
      args[argName] = { typname: r.in_typnames[i], typcategory: r.in_typcats[i] };
    });

    let retKind;
    if (r.ret_typname === 'void') retKind = 'void';
    else if (r.ret_typtype === 'c' || r.ret_typname === 'record') retKind = 'row';
    else retKind = 'scalar';

    return { args, retset: r.retset, retKind };
  });

  perPool.set(key, overloads);
  return overloads;
}

/**
 * Pick the overload a named-argument call resolves to: one that accepts every
 * supplied name, preferring the fewest parameters.
 *
 * @param {object[]} overloads - From functionOverloads
 * @param {string[]} keys - Supplied argument names
 * @returns {object|undefined}
 */
function pickOverload(overloads, keys) {
  return overloads
    .filter(o => keys.every(k => o.args[k]))
    .sort((a, b) => Object.keys(a.args).length - Object.keys(b.args).length)[0];
}

/**
 * Shape function output as the REST layer did: void is null, a scalar is the
 * bare value, SETOF scalar is an array of values, a composite is an object and
 * SETOF composite (or TABLE) is an array of objects.
 *
 * @param {object[]} rows - Result rows of `SELECT * FROM fn(...)`
 * @param {object|undefined} overload - Resolved signature, if known
 * @returns {any}
 */
function shapeRpcResult(rows, overload) {
  const first = (row) => (row ? Object.values(row)[0] : null);

  if (!overload) {
    // Signature unknown: the previous heuristic.
    if (rows.length === 1 && Object.keys(rows[0]).length === 1) return first(rows[0]);
    return rows;
  }
  if (overload.retKind === 'void') return null;
  if (overload.retKind === 'scalar') {
    return overload.retset ? rows.map(first) : first(rows[0]);
  }
  return overload.retset ? rows : (rows[0] ?? null);
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
      const fnSchema = defaultSchema;

      let overload;
      try {
        overload = pickOverload(
          await functionOverloads(pool, fnSchema, name),
          entries.map(([key]) => key)
        );
      } catch (err) {
        console.warn(`[pgrest] signature lookup failed for ${fnSchema}.${name}: ${err.message}`);
      }

      const values = entries.map(([key, v]) => toRpcParam(v, overload?.args[key]));
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
        const result = await restQuery(pool, `SELECT * FROM ${fnRef}(${argSql})`, values);
        return { data: shapeRpcResult(result.rows, overload), error: null };
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

module.exports = { createPgRestClient, toRpcParam, pickOverload, shapeRpcResult };
