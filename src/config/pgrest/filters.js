/**
 * pg query layer filter → SQL translation.
 *
 * Shared by the query builder. Every value goes through the parameter list —
 * nothing is interpolated into the SQL text except validated identifiers.
 */

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validate and quote a SQL identifier.
 *
 * Column names mostly come from literals in our own code, but the AI layer
 * passes user-influenced names (already checked by `_ai_validate_columns`), so
 * this stays strict rather than trusting the caller.
 *
 * @param {string} name - Identifier
 * @returns {string} Double-quoted identifier
 */
function quoteIdent(name) {
  const raw = String(name).trim();
  if (!IDENT_RE.test(raw)) {
    throw new Error(`Unsafe SQL identifier: ${JSON.stringify(name)}`);
  }
  return `"${raw}"`;
}

/**
 * Qualify a possibly schema-scoped table name (`users` or `auth.users`).
 *
 * @param {string} table - Table name
 * @returns {string} Quoted, optionally schema-qualified name
 */
function quoteTable(table) {
  return String(table)
    .split('.')
    .map(quoteIdent)
    .join('.');
}

/**
 * Operators that map straight onto a SQL infix operator.
 */
const INFIX_OPS = {
  eq: '=',
  neq: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  like: 'LIKE',
  ilike: 'ILIKE'
};

/**
 * Build a single filter condition.
 *
 * @param {object} filter - {column, op, value}
 * @param {function(any): string} addParam - Registers a value, returns its $n placeholder
 * @param {string} [alias] - Optional table alias to qualify the column with
 * @returns {string} SQL condition
 */
function buildCondition(filter, addParam, alias) {
  const { column, op, value } = filter;
  const col = alias
    ? `${quoteIdent(alias)}.${quoteIdent(column)}`
    : quoteIdent(column);

  if (INFIX_OPS[op]) {
    return `${col} ${INFIX_OPS[op]} ${addParam(value)}`;
  }

  switch (op) {
    case 'is':
      // pg query layer `is` only takes null / true / false.
      if (value === null || value === undefined || value === 'null') {
        return `${col} IS NULL`;
      }
      if (value === true || value === 'true') return `${col} IS TRUE`;
      if (value === false || value === 'false') return `${col} IS FALSE`;
      return `${col} IS NOT DISTINCT FROM ${addParam(value)}`;

    case 'in': {
      const list = Array.isArray(value) ? value : [value];
      // `= ANY($n)` takes an array parameter, so the placeholder count stays
      // fixed no matter how many values are supplied.
      if (list.length === 0) return 'FALSE';
      return `${col} = ANY(${addParam(list)})`;
    }

    case 'contains':
      // Array/jsonb containment.
      return `${col} @> ${addParam(value)}`;

    case 'overlaps':
      return `${col} && ${addParam(value)}`;

    case 'not': {
      const inner = buildCondition({ column, op: value.op, value: value.value }, addParam, alias);
      return `NOT (${inner})`;
    }

    default:
      throw new Error(`Unsupported pg query layer operator: ${op}`);
  }
}

/**
 * Split a pg query layer filter string on top-level commas, honouring the
 * double-quoted form pg query layer uses for values that themselves contain commas.
 *
 * @param {string} input - e.g. `a.eq.1,b.ilike.%x%`
 * @returns {string[]} Segments
 */
function splitTopLevel(input) {
  const parts = [];
  let current = '';
  let inQuotes = false;
  let depth = 0;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"' && input[i - 1] !== '\\') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (!inQuotes && ch === '(') {
      depth++; current += ch;
    } else if (!inQuotes && ch === ')') {
      depth--; current += ch;
    } else if (!inQuotes && depth === 0 && ch === ',') {
      parts.push(current); current = '';
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * Parse one `column.op.value` segment of a pg query layer filter string.
 *
 * @param {string} segment - Filter segment
 * @returns {object} {column, op, value}
 */
function parseFilterSegment(segment) {
  const trimmed = segment.trim();
  const firstDot = trimmed.indexOf('.');
  if (firstDot === -1) throw new Error(`Malformed filter segment: ${segment}`);

  const column = trimmed.slice(0, firstDot);
  let remainder = trimmed.slice(firstDot + 1);

  // `col.not.op.value` — the negation sits between the column and the operator.
  let negated = false;
  if (remainder.startsWith('not.')) {
    negated = true;
    remainder = remainder.slice(4);
  }

  const secondDot = remainder.indexOf('.');
  if (secondDot === -1) throw new Error(`Malformed filter segment: ${segment}`);

  const op = remainder.slice(0, secondDot);
  let value = remainder.slice(secondDot + 1);

  // Strip pg query layer's optional double quotes around the value.
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    value = value.slice(1, -1);
  }

  if (op === 'is') {
    if (value === 'null') value = null;
    else if (value === 'true') value = true;
    else if (value === 'false') value = false;
  }

  if (op === 'in') {
    // `in.(a,b,c)`
    const inner = value.replace(/^\(/, '').replace(/\)$/, '');
    value = inner ? splitTopLevel(inner).map(v => v.trim().replace(/^"|"$/g, '')) : [];
  }

  return negated
    ? { column, op: 'not', value: { op, value } }
    : { column, op, value };
}

/**
 * Translate a pg query layer `.or()` string into a single SQL condition.
 *
 * @param {string} input - e.g. `end_date.is.null,end_date.gte.2026-01-01`
 * @param {function(any): string} addParam - Parameter registrar
 * @param {string} [alias] - Optional table alias to qualify columns with
 * @returns {string} Parenthesised OR condition
 */
function buildOrCondition(input, addParam, alias) {
  return buildLogicalCondition(input, 'OR', addParam, alias);
}

const GROUP_RE = /^(not\.)?(and|or)\(([\s\S]*)\)$/;

/**
 * Join the segments of a filter string with AND/OR. A segment may itself be a
 * nested group — `and(a.eq.1,b.is.null)`, `or(...)`, or `not.and(...)` — as
 * the REST filter grammar allows.
 *
 * @param {string} input - Comma-separated filter segments
 * @param {'AND'|'OR'} joiner - How to combine the segments
 * @param {function(any): string} addParam - Parameter registrar
 * @param {string} [alias] - Optional table alias to qualify columns with
 * @returns {string} Parenthesised condition
 */
function buildLogicalCondition(input, joiner, addParam, alias) {
  const conditions = splitTopLevel(input)
    .map(s => s.trim())
    .filter(Boolean)
    .map(segment => {
      const group = segment.match(GROUP_RE);
      if (group) {
        const inner = buildLogicalCondition(group[3], group[2].toUpperCase(), addParam, alias);
        return group[1] ? `NOT ${inner}` : inner;
      }
      return buildCondition(parseFilterSegment(segment), addParam, alias);
    });

  if (conditions.length === 0) return 'TRUE';
  return `(${conditions.join(` ${joiner} `)})`;
}

module.exports = {
  quoteIdent,
  quoteTable,
  buildCondition,
  buildOrCondition,
  parseFilterSegment,
  splitTopLevel
};
