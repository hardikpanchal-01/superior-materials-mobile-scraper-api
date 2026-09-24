/**
 * Tenant database client for the AI Assistant engine.
 *
 * This tenant has no hosted backend, so this is the pg-backed
 * query-builder client from `../config/pgrest`. The RPCs the AI tools
 * rely on — `ai_select_rows` (two overloads), `ai_aggregate`, `ai_count`,
 * `_ai_validate_columns`, `ai_record_feedback` — are expected to exist as
 * functions in the tenant database, alongside the tables (`ai_chat_threads`,
 * `ai_audit_log`, `ai_dashboards`, …), so every AI module works unchanged.
 *
 * If a function is missing, the call surfaces as pg query layer error FN_NOT_FOUND —
 * worth checking per tenant, since function counts vary between databases.
 *
 * The connecting role is expected to have BYPASSRLS, matching the service-role
 * key this used to run with.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getPool } = require('../services/database/postgresClient.js');
const { createPgRestClient } = require('../config/pgrest/index.js');

const pool = getPool();

if (!pool) {
  console.warn('[ai/_db] DATABASE_URL is not set — AI data tools will fail.');
}

export const dbServer = createPgRestClient(pool);

export default dbServer;
