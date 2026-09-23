/**
 * Central auth database client.
 *
 * The shared login/identity store behind auth.truckast.ai. It is a SEPARATE
 * CloudNativePG cluster from the tenant database (`auth-postgres` in namespace
 * `central-auth`), holding the `auth_tenant` schema: tenants, tenant_users,
 * auth_codes and the user records every tenant logs in against.
 *
 * This used to be a hosted backend. That project no longer exists, so this
 * connects straight to Postgres through the same query-builder shim the
 * tenant client uses. Call sites are unchanged — including the 39
 * `.schema('auth_tenant')` calls, which the shim now supports.
 *
 * Connection comes from CENTRAL_AUTH_DATABASE_URL. The database has no public
 * endpoint by design (no NLB, no NodePort) because it holds password hashes for
 * every tenant's users, so this only resolves from inside the cluster or over a
 * port-forward.
 */

const pg = require('pg');
const { createPgRestClient } = require('./pgrest');

const CENTRAL_AUTH_DATABASE_URL = process.env.CENTRAL_AUTH_DATABASE_URL;
const QUERY_TIMEOUT_MS = parseInt(process.env.DB_QUERY_TIMEOUT_MS, 10) || 30000;

/**
 * Split the SSL settings out of a connection string.
 *
 * Mirrors the tenant pool: pg >= 8.16 reads `sslmode=require` as `verify-full`,
 * which rejects the cluster's self-signed certificate. Driving TLS from the
 * client config instead keeps behaviour stable across pg versions.
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

  if (sslmode === 'disable') return { connectionString, ssl: false };

  // A port-forwarded tunnel is plain TCP to localhost, where TLS is neither
  // available nor needed.
  const isLocalTunnel = /@(localhost|127\.0\.0\.1)[:/]/.test(base);
  if (isLocalTunnel && !sslmode) return { connectionString, ssl: false };

  const needsSsl = Boolean(sslmode) || !isLocalTunnel;
  return { connectionString, ssl: needsSsl ? { rejectUnauthorized: false } : false };
}

let pool = null;
let client = null;

if (CENTRAL_AUTH_DATABASE_URL) {
  const { connectionString, ssl } = resolveSslConfig(CENTRAL_AUTH_DATABASE_URL);
  pool = new pg.Pool({
    connectionString,
    min: 0,
    max: 10,
    idleTimeoutMillis: 60000,
    connectionTimeoutMillis: 15000,
    statement_timeout: QUERY_TIMEOUT_MS,
    ssl
  });

  pool.on('error', (err) => {
    console.error('Central auth pool error:', err.message || err);
  });
} else {
  console.warn('⚠️  CENTRAL_AUTH_DATABASE_URL is not set — mobile login, signup, QR and short URLs will be unavailable.');
}

/**
 * Central auth client, scoped to `auth_tenant` — the schema the previous
 * the database client was configured with by default.
 *
 * @returns {object} query-builder client
 * @throws {Error} If CENTRAL_AUTH_DATABASE_URL is not configured
 */
function getAuthDbAdmin() {
  if (!pool) {
    throw new Error(
      'Central auth database is not configured. Please set CENTRAL_AUTH_DATABASE_URL in your .env file.'
    );
  }
  if (!client) {
    client = createPgRestClient(pool, { schema: 'auth_tenant' });
  }
  return client;
}

/**
 * Verify the central auth database is reachable.
 *
 * @returns {Promise<boolean>} True if a query succeeds
 */
async function testAuthConnection() {
  if (!pool) return false;
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (error) {
    console.error('Central auth connection test failed:', error.message);
    return false;
  }
}

/**
 * Close the pool during graceful shutdown.
 *
 * @returns {Promise<void>}
 */
async function closeAuthPool() {
  if (!pool) return;
  try {
    await pool.end();
  } catch (error) {
    console.error('Error closing central auth pool:', error.message);
  }
}

module.exports = {
  getCentralAuthDb: getAuthDbAdmin,
  // Retained so the existing call sites keep working. There is no the database
  // behind this any more — prefer getCentralAuthDb in new code.
  getAuthDbAdmin,
  testAuthConnection,
  closeAuthPool
};
