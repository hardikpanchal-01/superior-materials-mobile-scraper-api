/**
 * Tenant database client.
 *
 * This tenant runs on a plain CloudNativePG Postgres with no the database in front
 * of it, so this returns the pg-backed query-builder client from
 * `./pgrest` instead of a db-js client. The surface is unchanged, so the
 * ~266 existing `.from(...)` call sites and all 22 `auth.*` calls keep working.
 *
 * `getDb()` used the anon key and `getDbAdmin()` the service key.
 * The database role this pool connects as is expected to have BYPASSRLS, which
 * is what the service key effectively provided, so both now return the same
 * client. That is a widening of `getDb()`'s former privileges — it is
 * intentional, and matches how these calls were already used server-side.
 */

const { getPool } = require('../services/database/postgresClient');
const { createPgRestClient } = require('./pgrest');

let client = null;

/**
 * Build the client lazily, so it picks up the pool after dotenv has run.
 *
 * @returns {object} query-builder client
 */
function getClient() {
  const pool = getPool();

  if (!pool) {
    throw new Error(
      'Tenant database is not configured. Please set DATABASE_URL in your .env file.'
    );
  }

  if (!client) {
    client = createPgRestClient(pool);
  }
  return client;
}

/**
 * Tenant database client.
 *
 * @returns {object} query-builder client
 */
function getDb() {
  return getClient();
}

/**
 * Tenant database client with full privileges.
 *
 * @returns {object} query-builder client
 */
function getDbAdmin() {
  return getClient();
}

module.exports = {
  getDb,
  getDbAdmin
};
