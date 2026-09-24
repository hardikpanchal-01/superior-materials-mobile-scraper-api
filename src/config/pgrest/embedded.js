/**
 * Embedded-resource selects.
 *
 * pg query layer lets a select string pull in a related table — `customers(id, name)`
 * — and returns it as a nested object. Implementing that generally would mean
 * reading foreign keys and synthesising joins; this codebase only does it twice,
 * so each one gets purpose-built SQL keyed by its exact select string.
 *
 * Adding a third embedded select anywhere means adding an entry here, otherwise
 * the builder will try to treat `customers(id, name)` as a column name and the
 * query will fail loudly rather than silently returning wrong data.
 */

const { buildCondition, buildOrCondition } = require('./filters');
const { restQuery } = require('./types');

/**
 * Render the WHERE clause for an embedded query, qualifying every column with
 * the base table's alias.
 *
 * @param {object} query - The PgRestQuery instance
 * @param {function(any): string} addParam - Parameter registrar
 * @param {string} alias - Base table alias
 * @returns {string} `WHERE …` or empty string
 */
function whereForAlias(query, addParam, alias) {
  if (query._filters.length === 0) return '';
  const parts = query._filters.map(f =>
    f.kind === 'or'
      ? buildOrCondition(f.value, addParam, alias)
      : buildCondition(f, addParam, alias)
  );
  return ` WHERE ${parts.join(' AND ')}`;
}

/**
 * Run purpose-built SQL and shape the result the way the builder would.
 *
 * @param {object} query - The PgRestQuery instance
 * @param {string} text - SQL
 * @param {any[]} values - Parameters
 * @returns {Promise<{data: any, error: object|null, count: null}>}
 */
async function run(query, text, values) {
  try {
    const result = await restQuery(query._pool, text, values);
    const rows = result.rows;

    if (query._single || query._maybeSingle) {
      // Required lazily: queryBuilder requires this module at load time.
      const { singleResult } = require('./queryBuilder');
      return singleResult(rows, query._maybeSingle);
    }
    return { data: rows, count: null, error: null };
  } catch (err) {
    return {
      data: null,
      count: null,
      error: {
        message: err.message,
        code: err.code || 'DB_ERROR',
        details: err.detail || null,
        hint: err.hint || null
      }
    };
  }
}

const EMBEDDED_SELECTS = {
  /**
   * userService.getUserCompany — the caller reads `data.customers?.name`.
   * LEFT JOIN so a membership row with a missing customer still returns.
   */
  'customer_id, customers(id, name)': (query) => {
    const values = [];
    const addParam = (v) => { values.push(v); return `$${values.length}`; };

    let text =
      'SELECT uc."customer_id", ' +
      'CASE WHEN c."id" IS NULL THEN NULL ' +
      'ELSE json_build_object(\'id\', c."id", \'name\', c."name") END AS "customers" ' +
      'FROM "user_customers" uc ' +
      'LEFT JOIN "customers" c ON c."id" = uc."customer_id"';

    text += whereForAlias(query, addParam, 'uc');
    if (query._limit !== null && query._limit !== undefined) {
      text += ` LIMIT ${addParam(query._limit)}`;
    }
    return run(query, text, values);
  },

  /**
   * ai/dashboards.listDashboards — `!inner` means an INNER JOIN, so shares
   * pointing at a deleted dashboard drop out.
   */
  'dashboard_id, ai_dashboards!inner(id, title, user_id, thread_id, updated_at, created_at)': (query) => {
    const values = [];
    const addParam = (v) => { values.push(v); return `$${values.length}`; };

    let text =
      'SELECT s."dashboard_id", ' +
      'json_build_object(' +
      "'id', d.\"id\", 'title', d.\"title\", 'user_id', d.\"user_id\", " +
      "'thread_id', d.\"thread_id\", 'updated_at', d.\"updated_at\", 'created_at', d.\"created_at\"" +
      ') AS "ai_dashboards" ' +
      'FROM "ai_dashboard_shares" s ' +
      'JOIN "ai_dashboards" d ON d."id" = s."dashboard_id"';

    text += whereForAlias(query, addParam, 's');
    if (query._limit !== null && query._limit !== undefined) {
      text += ` LIMIT ${addParam(query._limit)}`;
    }
    return run(query, text, values);
  }
};

module.exports = { EMBEDDED_SELECTS };
