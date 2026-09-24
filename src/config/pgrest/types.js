/**
 * Value conversion so query-builder results and writes match what the hosted
 * REST layer produced.
 *
 * Reads: the REST layer served JSON, so callers (and the mobile app, which
 * receives these values verbatim) were written against numbers for int8 and
 * numeric, ISO 8601 strings for timestamps, and bare `YYYY-MM-DD` for dates.
 * node-postgres defaults to strings for int8/numeric and JS Dates for the
 * date/time types. The parsers below are applied per query (the `types` option)
 * rather than globally, because raw `pool.query` callers elsewhere rely on the
 * node-postgres defaults.
 *
 * Writes: node-postgres renders a JS array as a Postgres ARRAY literal. Sent to
 * a json/jsonb column, `[]` becomes `{}` (an object) and an array of objects is
 * rejected outright. Values for json/jsonb columns are therefore serialised
 * explicitly; real Postgres array columns (text[], int8[]) must not be.
 */

const pg = require('pg');

const OID = {
  INT8: 20,
  NUMERIC: 1700,
  DATE: 1082,
  TIMESTAMP: 1114,
  TIMESTAMPTZ: 1184
};

/**
 * Turn Postgres timestamp text into the ISO form the REST layer emitted:
 * `2026-09-24 07:12:31.788+00` becomes `2026-09-24T07:12:31.788+00:00`.
 * A bare `+00` offset is rejected by some JS date parsers, so it is expanded.
 *
 * @param {string} value - Timestamp text from Postgres
 * @returns {string} ISO 8601 text
 */
function toIsoTimestamp(value) {
  if (value.length <= 10 || value[10] !== ' ') return value; // infinity, etc.
  const iso = `${value.slice(0, 10)}T${value.slice(11)}`;
  return /[+-]\d{2}$/.test(iso) ? `${iso}:00` : iso;
}

const PARSERS = {
  [OID.INT8]: (v) => Number(v),
  [OID.NUMERIC]: (v) => Number(v),
  [OID.DATE]: (v) => v,
  [OID.TIMESTAMP]: toIsoTimestamp,
  [OID.TIMESTAMPTZ]: toIsoTimestamp
};

/** Pass as the `types` option of a pg query config. */
const REST_TYPES = {
  getTypeParser(oid, format) {
    if (format !== 'binary' && PARSERS[oid]) return PARSERS[oid];
    return pg.types.getTypeParser(oid, format);
  }
};

/**
 * Run a query with REST-style value conversion.
 *
 * @param {object} pool - pg Pool
 * @param {string} text - SQL
 * @param {any[]} values - Parameters
 * @returns {Promise<object>} pg result
 */
function restQuery(pool, text, values) {
  return pool.query({ text, values, types: REST_TYPES });
}

// pool -> Map(table -> Set of json/jsonb column names)
const jsonColumnCache = new WeakMap();

/**
 * Names of the json/jsonb columns of a table (or view), cached per pool.
 * A failed lookup returns an empty set without caching, so writes fall back to
 * binding values unchanged rather than failing.
 *
 * @param {object} pool - pg Pool
 * @param {string} quotedTable - Quoted, optionally schema-qualified table name
 * @returns {Promise<Set<string>>}
 */
async function jsonColumnsOf(pool, quotedTable) {
  let perPool = jsonColumnCache.get(pool);
  if (!perPool) {
    perPool = new Map();
    jsonColumnCache.set(pool, perPool);
  }
  if (perPool.has(quotedTable)) return perPool.get(quotedTable);

  try {
    const result = await pool.query(
      `SELECT a.attname
         FROM pg_attribute a
        WHERE a.attrelid = to_regclass($1)
          AND a.attnum > 0
          AND NOT a.attisdropped
          AND a.atttypid IN ('json'::regtype, 'jsonb'::regtype)`,
      [quotedTable]
    );
    const columns = new Set(result.rows.map(r => r.attname));
    perPool.set(quotedTable, columns);
    return columns;
  } catch (err) {
    console.warn(`[pgrest] json column lookup failed for ${quotedTable}: ${err.message}`);
    return new Set();
  }
}

/**
 * Serialise a value bound for a json/jsonb column the way the REST layer did:
 * every non-null value is sent as JSON text.
 *
 * @param {any} value - Value to write
 * @returns {any} JSON text, or null
 */
function toJsonParam(value) {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

module.exports = { REST_TYPES, restQuery, jsonColumnsOf, toJsonParam, toIsoTimestamp };
