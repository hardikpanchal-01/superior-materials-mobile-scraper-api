/**
 * Chat realtime listener
 *
 * Watches for new rows in `public.chat_messages` and
 * `public.order_entity_messages`, then fans out FCM via chatService.
 *
 * This tenant's database has no hosted realtime, so this listens on the
 * PostgreSQL `chat_message_insert` / `order_entity_message_insert` channels
 * instead. The triggers that publish them are created by
 * `src/migrations/005_chat_notify_triggers.sql`.
 *
 * Only the row id travels in the notification payload (pg_notify caps payloads
 * at 8000 bytes and a chat row carries free text plus a jsonb attachments blob),
 * so each notification is followed by a read of the row.
 *
 * `LISTEN` is bound to a single backend connection, so this holds its own
 * standalone client rather than borrowing from the pool, and reconnects with
 * backoff if that connection drops.
 */

const { createStandaloneClient } = require('./database/postgresClient');
const { getDbAdmin } = require('../config/database');
const chatService = require('./chatService');

const CHAT_CHANNEL = 'chat_message_insert';
const ORDER_ENTITY_CHANNEL = 'order_entity_message_insert';

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

let client = null;
let stopping = false;
let reconnectAttempts = 0;
let reconnectTimer = null;

/**
 * Describe this deployment for log lines and the tenant_subdomain field.
 *
 * @returns {object} {label, subdomains}
 */
function listenerConfig() {
  const subdomain = process.env.TENANT_SUBDOMAIN || '';
  return {
    label: subdomain || 'tenant',
    subdomains: subdomain ? [subdomain] : []
  };
}

function buildPreview(text, attachments) {
  if (text && text.trim().length > 0) {
    return text.length > 120 ? `${text.substring(0, 119)}…` : text;
  }
  if (Array.isArray(attachments) && attachments.length > 0) {
    return 'Sent an attachment';
  }
  return '';
}

async function fetchActiveRecipients(db, senderId) {
  const { data, error } = await db
    .from('users')
    .select('id')
    .eq('active', true);

  if (error) {
    console.error(
      '[ChatRealtime] failed to load recipients:',
      error.message,
    );
    return [];
  }

  return (data || [])
    .map((u) => u.id)
    .filter((id) => id && id !== senderId);
}

async function fetchOrderMeta(db, orderId) {
  const { data, error } = await db
    .from('orders')
    .select('order_id, order_code, order_date, customer_name')
    .eq('order_id', orderId)
    .maybeSingle();

  if (error) {
    console.error(
      '[ChatRealtime] failed to load order meta:',
      error.message,
    );
    return null;
  }
  return data || null;
}

/**
 * Read the chat_messages row a notification referred to.
 *
 * @param {object} db - Tenant database client
 * @param {string} id - Row id
 * @returns {Promise<object|null>} Row
 */
async function fetchChatMessage(db, id) {
  const { data, error } = await db
    .from('chat_messages')
    .select('id, chat_id, order_id, sender_id, sender_name, message_text, attachments, is_deleted')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    console.error('[ChatRealtime] failed to load chat_message:', error.message);
    return null;
  }
  return data || null;
}

/**
 * Read the order_entity_messages row a notification referred to.
 *
 * @param {object} db - Tenant database client
 * @param {string} id - Row id
 * @returns {Promise<object|null>} Row
 */
async function fetchOrderEntityMessage(db, id) {
  const { data, error } = await db
    .from('order_entity_messages')
    .select('id, order_entity_id, sender_id, sender_name, message_text')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    console.error('[ChatRealtime] failed to load order_entity_message:', error.message);
    return null;
  }
  return data || null;
}

async function handleInsert(config, row) {
  if (!row) return;
  if (row.is_deleted === true) return;
  if (!row.sender_id || !row.order_id) return;

  try {
    const db = getDbAdmin();

    const [recipients, orderMeta] = await Promise.all([
      fetchActiveRecipients(db, row.sender_id),
      fetchOrderMeta(db, row.order_id),
    ]);

    if (recipients.length === 0) {
      console.log(
        `[ChatRealtime][${config.label}] order=${row.order_id} sender=${row.sender_id} -> no recipients`,
      );
      return;
    }

    const orderCode = orderMeta?.order_code || String(row.order_id);

    const result = await chatService.notifyChatMessage({
      order_id: row.order_id,
      order_code: orderCode,
      chat_id: row.chat_id,
      sender_id: row.sender_id,
      sender_name: row.sender_name || '',
      message_preview: buildPreview(row.message_text, row.attachments),
      tenant_subdomain:
        config.subdomains && config.subdomains.length === 1
          ? config.subdomains[0]
          : '',
      recipient_user_ids: recipients,
      order_date: orderMeta?.order_date || '',
      customer_name: orderMeta?.customer_name || '',
    });

    console.log(
      `[ChatRealtime][${config.label}] order=${orderCode} (id=${row.order_id}) -> ${result.successCount}/${result.tokenCount || 0} pushed (failures: ${result.failureCount}, recipients: ${result.recipientCount}, skipped: ${result.skipped || 'no'})`,
    );
  } catch (err) {
    console.error(
      `[ChatRealtime][${config.label}] handler error:`,
      err.message,
    );
  }
}

async function fetchOrderEntityMeta(db, orderEntityId) {
  const { data, error } = await db
    .from('order_entities')
    .select('id, job_name, company_name, on_job_date')
    .eq('id', orderEntityId)
    .maybeSingle();

  if (error) {
    console.error(
      '[ChatRealtime] failed to load order_entity meta:',
      error.message,
    );
    return null;
  }
  return data || null;
}

async function handleOrderEntityInsert(config, row) {
  if (!row) return;
  if (!row.sender_id || !row.order_entity_id) return;

  try {
    const db = getDbAdmin();

    const [recipients, meta] = await Promise.all([
      fetchActiveRecipients(db, row.sender_id),
      fetchOrderEntityMeta(db, row.order_entity_id),
    ]);

    if (recipients.length === 0) {
      console.log(
        `[ChatRealtime][${config.label}] order_entity=${row.order_entity_id} sender=${row.sender_id} -> no recipients`,
      );
      return;
    }

    const result = await chatService.notifyOrderEntityMessage({
      order_entity_id: row.order_entity_id,
      sender_id: row.sender_id,
      sender_name: row.sender_name || '',
      message_preview: buildPreview(row.message_text, null),
      tenant_subdomain:
        config.subdomains && config.subdomains.length === 1
          ? config.subdomains[0]
          : '',
      recipient_user_ids: recipients,
      job_name: meta?.job_name || '',
      company_name: meta?.company_name || '',
      on_job_date: meta?.on_job_date || '',
    });

    console.log(
      `[ChatRealtime][${config.label}] order_request=${row.order_entity_id} -> ${result.successCount}/${result.tokenCount || 0} pushed (failures: ${result.failureCount}, recipients: ${result.recipientCount}, skipped: ${result.skipped || 'no'})`,
    );
  } catch (err) {
    console.error(
      `[ChatRealtime][${config.label}] order entity handler error:`,
      err.message,
    );
  }
}

/**
 * Route one NOTIFY payload to its handler.
 *
 * @param {object} config - Listener config
 * @param {object} message - pg notification {channel, payload}
 * @returns {Promise<void>}
 */
async function dispatch(config, message) {
  const id = message.payload;
  if (!id) return;

  try {
    const db = getDbAdmin();
    if (message.channel === CHAT_CHANNEL) {
      await handleInsert(config, await fetchChatMessage(db, id));
    } else if (message.channel === ORDER_ENTITY_CHANNEL) {
      await handleOrderEntityInsert(config, await fetchOrderEntityMessage(db, id));
    }
  } catch (err) {
    console.error(`[ChatRealtime][${config.label}] dispatch error:`, err.message);
  }
}

/**
 * Open the listening connection and subscribe to both channels.
 *
 * @param {object} config - Listener config
 * @returns {Promise<void>}
 */
async function connect(config) {
  client = createStandaloneClient();
  if (!client) {
    console.warn('[ChatRealtime] DATABASE_URL is not set — listener disabled');
    return;
  }

  client.on('notification', (message) => { dispatch(config, message); });

  client.on('error', (err) => {
    console.error(`[ChatRealtime][${config.label}] connection error:`, err.message);
    scheduleReconnect(config);
  });

  client.on('end', () => {
    if (!stopping) scheduleReconnect(config);
  });

  await client.connect();
  await client.query(`LISTEN ${CHAT_CHANNEL}`);
  await client.query(`LISTEN ${ORDER_ENTITY_CHANNEL}`);

  reconnectAttempts = 0;
  console.log(`[ChatRealtime][${config.label}] listening on ${CHAT_CHANNEL}, ${ORDER_ENTITY_CHANNEL}`);
}

/**
 * Reconnect with exponential backoff.
 *
 * @param {object} config - Listener config
 */
function scheduleReconnect(config) {
  if (stopping || reconnectTimer) return;

  // Drop the dead client so a late 'end' event can't queue a second reconnect.
  const dead = client;
  client = null;
  if (dead) {
    try { dead.removeAllListeners(); dead.end().catch(() => {}); } catch (e) { /* already gone */ }
  }

  const delay = Math.min(RECONNECT_BASE_MS * (2 ** reconnectAttempts), RECONNECT_MAX_MS);
  reconnectAttempts++;

  console.log(`[ChatRealtime][${config.label}] reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (stopping) return;
    try {
      await connect(config);
    } catch (err) {
      console.error(`[ChatRealtime][${config.label}] reconnect failed:`, err.message);
      scheduleReconnect(config);
    }
  }, delay);

  if (reconnectTimer.unref) reconnectTimer.unref();
}

/**
 * Start listening for new chat messages.
 *
 * @returns {void}
 */
function startChatRealtimeListener() {
  // Kill switch — set CHAT_REALTIME_DISABLED=true on whichever backend you
  // don't want firing FCM (e.g. disable on production while testing locally,
  // or vice versa) to avoid double-pushes when prod + local share a database.
  if (
    process.env.CHAT_REALTIME_DISABLED === 'true' ||
    process.env.CHAT_REALTIME_DISABLED === '1'
  ) {
    console.log(
      '[ChatRealtime] CHAT_REALTIME_DISABLED is set — listener will not start',
    );
    return;
  }

  stopping = false;
  const config = listenerConfig();

  connect(config).catch((err) => {
    console.error(`[ChatRealtime][${config.label}] initial connect failed:`, err.message);
    scheduleReconnect(config);
  });
}

/**
 * Stop listening and release the connection.
 *
 * @returns {Promise<void>}
 */
async function stopChatRealtimeListener() {
  stopping = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (client) {
    const closing = client;
    client = null;
    closing.removeAllListeners();
    try {
      await closing.end();
    } catch (err) {
      console.error('[ChatRealtime] error closing listener connection:', err.message);
    }
  }
}

module.exports = {
  startChatRealtimeListener,
  stopChatRealtimeListener,
};
