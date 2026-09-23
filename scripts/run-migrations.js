#!/usr/bin/env node
/**
 * Apply the SQL migrations in src/migrations to DATABASE_URL.
 *
 * Files are applied in filename order, each inside its own transaction, and
 * recorded in `public.schema_migrations` so later runs skip what is already
 * done. An advisory lock keeps two concurrent runs (e.g. two pods rolling at
 * once) from racing.
 *
 * Every migration in this repo is written to be idempotent, so re-running is
 * safe even if the tracking table is lost.
 *
 * Some files alter tables owned by the tenant's `*_app` role. Where the
 * connecting role lacks that ownership those cannot be applied, and `--only`
 * runs just the ones that are permitted.
 *
 * Usage:
 *   node scripts/run-migrations.js            # apply anything pending
 *   node scripts/run-migrations.js --list     # show status, change nothing
 *   node scripts/run-migrations.js --force    # re-apply every file
 *   node scripts/run-migrations.js --only 004 # only filenames containing "004"
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { getPool, closePool } = require('../src/services/database/postgresClient');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'src', 'migrations');
const LOCK_KEY = 8274512; // arbitrary, but stable across runs

const LIST_ONLY = process.argv.includes('--list');
const FORCE = process.argv.includes('--force');

const onlyFlag = process.argv.indexOf('--only');
const ONLY = onlyFlag !== -1 ? process.argv[onlyFlag + 1] : null;

/**
 * Read the migration files in apply order.
 *
 * @returns {Array<{name: string, sql: string, checksum: string}>}
 */
function loadMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .map(name => {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
      return { name, sql, checksum: crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16) };
    });
}

(async () => {
  const pool = getPool();
  if (!pool) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const client = await pool.connect();
  let locked = false;

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        name       text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const { rows: appliedRows } = await client.query(
      'SELECT name, checksum, applied_at FROM public.schema_migrations'
    );
    const applied = new Map(appliedRows.map(r => [r.name, r]));

    const migrations = loadMigrations().filter(m => !ONLY || m.name.includes(ONLY));
    if (migrations.length === 0) {
      console.log(ONLY ? `No migration files match "${ONLY}".` : 'No migration files found.');
      return;
    }

    if (LIST_ONLY) {
      console.log('migration                          status');
      for (const m of migrations) {
        const record = applied.get(m.name);
        const status = !record ? 'PENDING'
          : record.checksum !== m.checksum ? `applied (CHANGED since ${record.applied_at.toISOString().slice(0, 10)})`
            : `applied ${record.applied_at.toISOString().slice(0, 10)}`;
        console.log(`${m.name.padEnd(34)} ${status}`);
      }
      return;
    }

    // Serialise concurrent runners.
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    locked = true;

    let count = 0;
    for (const m of migrations) {
      const record = applied.get(m.name);
      if (record && !FORCE) {
        if (record.checksum !== m.checksum) {
          console.log(`~ ${m.name} — already applied but the file has changed since; leaving it alone`);
        }
        continue;
      }

      process.stdout.write(`> ${m.name} ... `);
      try {
        await client.query('BEGIN');
        await client.query(m.sql);
        await client.query(
          `INSERT INTO public.schema_migrations (name, checksum) VALUES ($1, $2)
           ON CONFLICT (name) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()`,
          [m.name, m.checksum]
        );
        await client.query('COMMIT');
        console.log('ok');
        count++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.log('FAILED');
        console.error(`  ${err.message}`);
        throw err;
      }
    }

    console.log(count === 0 ? 'Already up to date.' : `Applied ${count} migration(s).`);
  } finally {
    if (locked) {
      try { await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); } catch (e) { /* connection may be gone */ }
    }
    client.release();
    await closePool();
  }
})().catch(err => {
  console.error('Migration run failed:', err.message);
  process.exit(1);
});
