/**
 * Notification database client.
 *
 * The notification tables (notification_queue, user_devices) live in their own
 * CloudNativePG database, reached via NOTIFICATION_DATABASE_URL. Callers use the
 * `.from(...).select()/.insert()` builder API (returning `{ data, error }`), so
 * this exposes a query-builder client over a dedicated pool.
 */
const pg = require('pg');
const { Pool } = pg;
const { createPgRestClient } = require('./pgrest');

const NOTIFICATION_DATABASE_URL = process.env.NOTIFICATION_DATABASE_URL;

let notificationPool = null;

if (NOTIFICATION_DATABASE_URL) {
  // Strip sslmode param (the pg driver handles SSL from client config instead).
  let connectionString = NOTIFICATION_DATABASE_URL;
  let sslDisabled = false;
  try {
    const u = new URL(NOTIFICATION_DATABASE_URL);
    sslDisabled = u.searchParams.get('sslmode') === 'disable';
    u.searchParams.delete('sslmode');
    connectionString = u.toString();
  } catch { /* use as-is */ }

  const isLocal =
    NOTIFICATION_DATABASE_URL.includes('localhost') ||
    NOTIFICATION_DATABASE_URL.includes('127.0.0.1');

  notificationPool = new Pool({
    connectionString,
    min: 1,
    max: 10,
    idleTimeoutMillis: 60000,
    connectionTimeoutMillis: 15000,
    statement_timeout: 30000,
    ssl: (isLocal || sslDisabled) ? false : { rejectUnauthorized: false }
  });

  notificationPool.on('error', (err) => {
    console.error('Notification PostgreSQL pool error:', err.message || err);
  });
} else {
  console.warn('⚠️  NOTIFICATION_DATABASE_URL not configured - notification features will be unavailable');
}

let notificationDb = null;

/**
 * Query-builder client bound to the notification database.
 *
 * @returns {object} Query-builder client
 */
function getNotificationDb() {
  if (!notificationPool) {
    throw new Error(
      'Notification database is not configured. Please set NOTIFICATION_DATABASE_URL in your .env file.'
    );
  }
  if (!notificationDb) {
    notificationDb = createPgRestClient(notificationPool);
  }
  return notificationDb;
}

module.exports = {
  getNotificationDb
};
