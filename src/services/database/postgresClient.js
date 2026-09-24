/**
 * PostgreSQL Client
 *
 * Simplified connection pool for PostgreSQL database.
 * Provides basic connection management without cron-specific features.
 */

const pg = require('pg');
const { Pool } = pg;

// Get database URL from environment
const DATABASE_URL = process.env.DATABASE_URL || process.env.DB_POOL_URL;

// Query timeout configuration (default: 30 seconds)
const QUERY_TIMEOUT_MS = parseInt(process.env.DB_QUERY_TIMEOUT_MS) || 30000;

/**
 * Split the SSL settings out of a connection string.
 *
 * pg >= 8.16 reads `sslmode=require` from the connection string and applies
 * `verify-full` semantics, which rejects the self-signed certificate the
 * pm-postgres (CloudNativePG) cluster presents — the connection dies with
 * "self-signed certificate in certificate chain". Taking the SSL params out of
 * the URL and driving SSL from the client config instead keeps the behaviour
 * the same no matter which pg version is installed.
 *
 * Only the query string is rewritten; credentials in the URL are left verbatim.
 *
 * @param {string} url - Raw connection string
 * @returns {{connectionString: string, ssl: object|false}}
 */
function resolveSslConfig(url) {
  const queryStart = url.indexOf('?');
  const base = queryStart === -1 ? url : url.slice(0, queryStart);
  const params = new URLSearchParams(queryStart === -1 ? '' : url.slice(queryStart + 1));

  const sslmode = params.get('sslmode');
  params.delete('sslmode');
  params.delete('uselibpqcompat');

  const rest = params.toString();
  const connectionString = rest ? `${base}?${rest}` : base;

  if (sslmode === 'disable') {
    return { connectionString, ssl: false };
  }

  // Encrypt whenever the URL asks for it. Certificate verification stays off:
  // the pm-postgres cluster uses a certificate that doesn't chain to a public
  // root.
  const needsSsl = Boolean(sslmode);
  return { connectionString, ssl: needsSsl ? { rejectUnauthorized: false } : false };
}

// Only create pool if DATABASE_URL is configured
let pool = null;

if (DATABASE_URL) {
  /**
   * PostgreSQL connection pool
   *
   * Configuration:
   * - max: Maximum number of connections (20)
   * - idleTimeoutMillis: Close idle connections after 60s (the connection pooler closes idle conns; we release first to avoid "Connection terminated unexpectedly")
   * - connectionTimeoutMillis: Fail connection attempts after 15 seconds
   */
  const { connectionString, ssl } = resolveSslConfig(DATABASE_URL);

  pool = new Pool({
    connectionString,
    min: 2,
    max: 20,
    idleTimeoutMillis: 60000,
    connectionTimeoutMillis: 15000,
    statement_timeout: QUERY_TIMEOUT_MS,  // Kill queries exceeding this time
    ssl
  });

  // Log pool errors (short message only; full dump is noisy for "Connection terminated unexpectedly")
  pool.on('error', (err) => {
    console.error('PostgreSQL pool error:', err.message || err);
  });

  // Log when connections are acquired (debug mode only)
  if (process.env.NODE_ENV === 'development') {
    pool.on('connect', () => {
      console.log('PostgreSQL: New connection established');
    });
  }
} else {
  console.warn('⚠️  DATABASE_URL not configured - PostgreSQL features will be unavailable');
}

// LISTEN/NOTIFY needs a direct connection. DATABASE_URL normally points at
// PgBouncer in transaction mode, which hands the server connection back after
// every statement: LISTEN succeeds there but notifications never arrive.
const REALTIME_DATABASE_URL = process.env.REALTIME_DATABASE_URL;

/**
 * Create a standalone (non-pooled) client for LISTEN.
 *
 * `LISTEN` registers on one specific backend connection, so it cannot use the
 * pool — a pooled client would stop receiving notifications as soon as it were
 * released and handed to someone else. It uses REALTIME_DATABASE_URL (a direct,
 * non-PgBouncer host) and only falls back to DATABASE_URL, with a warning.
 *
 * @returns {object|null} An unconnected pg Client, or null if no URL is set
 */
function createStandaloneClient() {
  const url = REALTIME_DATABASE_URL || DATABASE_URL;
  if (!url) return null;
  if (!REALTIME_DATABASE_URL) {
    console.warn('⚠️  REALTIME_DATABASE_URL not set - LISTEN is using DATABASE_URL; notifications will never arrive if that is a PgBouncer pooler');
  }
  const { connectionString, ssl } = resolveSslConfig(url);
  // keepAlive so a silently dropped connection is detected and reconnected.
  return new pg.Client({ connectionString, ssl, keepAlive: true });
}

/**
 * Test database connection
 *
 * @returns {Promise<boolean>} True if connection successful
 */
async function testConnection() {
  if (!pool) {
    return false;
  }

  let client = null;
  try {
    client = await pool.connect();
    await client.query('SELECT 1 as connected');
    client.release();
    return true;
  } catch (error) {
    console.error('Database connection test failed:', error.message);
    if (client) {
      try {
        client.release();
      } catch (e) {
        // Ignore release error
      }
    }
    return false;
  }
}

/**
 * Get pool statistics for monitoring
 *
 * @returns {object} Pool statistics
 */
function getPoolStats() {
  if (!pool) {
    return {
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
      status: 'not_configured'
    };
  }
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount
  };
}

/**
 * Close the connection pool gracefully
 *
 * @returns {Promise<void>}
 */
async function closePool() {
  if (!pool) {
    return;
  }
  try {
    await pool.end();
    console.log('PostgreSQL pool closed');
  } catch (error) {
    console.error('Error closing pool:', error);
    throw error;
  }
}

/**
 * Get the pool instance
 * @returns {Pool|null} The pool instance or null if not configured
 */
function getPool() {
  return pool;
}

module.exports = {
  pool,
  testConnection,
  getPoolStats,
  closePool,
  getPool,
  createStandaloneClient,
  QUERY_TIMEOUT_MS
};


