/**
 * Auth surface backed by `auth.users` in the tenant database.
 *
 * Replaces the parts of `db.auth` this codebase calls, keeping the
 * db-js result shapes so existing call sites are unchanged:
 *   `{ data: { user } | { users } | { properties }, error }`
 *
 * Request authentication itself does NOT go through here — the API issues and
 * verifies its own JWTs in `src/utils/jwtUtils.js`. This module only covers
 * credential storage and the admin user-management calls.
 */

const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const USER_COLUMNS = `
  id, email, phone, aud, role,
  email_confirmed_at, last_sign_in_at,
  raw_user_meta_data, raw_app_meta_data,
  created_at, updated_at, deleted_at
`;

/**
 * Map an `auth.users` row onto the user object db-js returns.
 *
 * @param {object} row - Database row
 * @returns {object|null} query-builder user
 */
function toAuthUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    phone: row.phone,
    aud: row.aud || 'authenticated',
    role: row.role || 'authenticated',
    email_confirmed_at: row.email_confirmed_at,
    last_sign_in_at: row.last_sign_in_at,
    user_metadata: row.raw_user_meta_data || {},
    app_metadata: row.raw_app_meta_data || {},
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

/**
 * Shape an error the way db-js does.
 *
 * @param {string} message - Message
 * @param {string} [code] - Code
 * @returns {object} Error
 */
function authError(message, code = 'auth_error') {
  return { message, code, status: 400, name: 'AuthApiError' };
}

/**
 * Build the auth namespace bound to a pg pool.
 *
 * @param {object} pool - pg Pool
 * @returns {object} `{ signInWithPassword, signOut, getUser, admin }`
 */
function createAuth(pool) {
  /**
   * Run a query, surfacing failures as db-style errors.
   *
   * @param {string} text - SQL
   * @param {any[]} values - Parameters
   * @returns {Promise<object[]>} Rows
   */
  async function query(text, values = []) {
    if (!pool) throw new Error('PostgreSQL pool not configured. Please set DATABASE_URL.');
    const result = await pool.query(text, values);
    return result.rows;
  }

  const admin = {
    /**
     * Page through users, ordered oldest-first so paging is stable.
     *
     * @param {object} options - {page, perPage}
     * @returns {Promise<object>} `{ data: { users }, error }`
     */
    async listUsers({ page = 1, perPage = 50 } = {}) {
      try {
        const limit = Math.max(1, perPage);
        const offset = (Math.max(1, page) - 1) * limit;
        const rows = await query(
          `SELECT ${USER_COLUMNS} FROM auth.users
           WHERE deleted_at IS NULL
           ORDER BY created_at ASC, id ASC
           LIMIT $1 OFFSET $2`,
          [limit, offset]
        );
        return { data: { users: rows.map(toAuthUser) }, error: null };
      } catch (err) {
        return { data: { users: [] }, error: authError(err.message) };
      }
    },

    /**
     * @param {string} userId - User UUID
     * @returns {Promise<object>} `{ data: { user }, error }`
     */
    async getUserById(userId) {
      try {
        const rows = await query(
          `SELECT ${USER_COLUMNS} FROM auth.users WHERE id = $1 AND deleted_at IS NULL`,
          [userId]
        );
        if (rows.length === 0) {
          return { data: { user: null }, error: authError('User not found', 'user_not_found') };
        }
        return { data: { user: toAuthUser(rows[0]) }, error: null };
      } catch (err) {
        return { data: { user: null }, error: authError(err.message) };
      }
    },

    /**
     * @param {object} attrs - {email, password, phone, email_confirm, user_metadata, app_metadata}
     * @returns {Promise<object>} `{ data: { user }, error }`
     */
    async createUser(attrs = {}) {
      try {
        const {
          email, password, phone,
          email_confirm: emailConfirm,
          user_metadata: userMetadata,
          app_metadata: appMetadata
        } = attrs;

        const encrypted = password ? await bcrypt.hash(password, 10) : null;

        const rows = await query(
          `INSERT INTO auth.users
             (id, email, phone, encrypted_password, aud, role,
              email_confirmed_at, raw_user_meta_data, raw_app_meta_data,
              created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'authenticated', 'authenticated',
                   $4, $5, $6, now(), now())
           RETURNING ${USER_COLUMNS}`,
          [
            email ? String(email).toLowerCase().trim() : null,
            phone || null,
            encrypted,
            emailConfirm ? new Date().toISOString() : null,
            JSON.stringify(userMetadata || {}),
            JSON.stringify(appMetadata || {})
          ]
        );
        return { data: { user: toAuthUser(rows[0]) }, error: null };
      } catch (err) {
        // Surface duplicate email/phone the way callers already branch on it.
        if (err.code === '23505') {
          return { data: { user: null }, error: { ...authError('User already registered', 'email_exists'), status: 422 } };
        }
        return { data: { user: null }, error: authError(err.message) };
      }
    },

    /**
     * @param {string} userId - User UUID
     * @param {object} attrs - {email, password, phone, email_confirm, user_metadata}
     * @returns {Promise<object>} `{ data: { user }, error }`
     */
    async updateUserById(userId, attrs = {}) {
      try {
        const sets = [];
        const values = [];
        const add = (frag, value) => { values.push(value); sets.push(`${frag} = $${values.length}`); };

        if (attrs.email !== undefined) add('email', String(attrs.email).toLowerCase().trim());
        if (attrs.phone !== undefined) add('phone', attrs.phone);
        if (attrs.password !== undefined) add('encrypted_password', await bcrypt.hash(attrs.password, 10));
        if (attrs.user_metadata !== undefined) add('raw_user_meta_data', JSON.stringify(attrs.user_metadata));
        if (attrs.app_metadata !== undefined) add('raw_app_meta_data', JSON.stringify(attrs.app_metadata));
        if (attrs.email_confirm) sets.push('email_confirmed_at = now()');

        if (sets.length === 0) return admin.getUserById(userId);

        sets.push('updated_at = now()');
        values.push(userId);

        const rows = await query(
          `UPDATE auth.users SET ${sets.join(', ')} WHERE id = $${values.length}
           RETURNING ${USER_COLUMNS}`,
          values
        );
        if (rows.length === 0) {
          return { data: { user: null }, error: authError('User not found', 'user_not_found') };
        }
        return { data: { user: toAuthUser(rows[0]) }, error: null };
      } catch (err) {
        if (err.code === '23505') {
          return { data: { user: null }, error: { ...authError('Value already in use', 'email_exists'), status: 422 } };
        }
        return { data: { user: null }, error: authError(err.message) };
      }
    },

    /**
     * Issue a recovery link. The token is persisted in
     * `public.auth_recovery_tokens` so whatever completes the reset can verify
     * it — stock the database keeps this on `auth.users`, but that table is owned by
     * another role here and cannot be altered.
     *
     * @param {object} params - {type, email, options:{redirectTo}}
     * @returns {Promise<object>} `{ data: { properties }, error }`
     */
    async generateLink({ type = 'recovery', email, options = {} } = {}) {
      try {
        if (type !== 'recovery') {
          return { data: null, error: authError(`Unsupported link type: ${type}`) };
        }

        const normalized = String(email || '').toLowerCase().trim();
        const token = crypto.randomBytes(32).toString('hex');

        const rows = await query(
          `SELECT ${USER_COLUMNS} FROM auth.users
            WHERE lower(email) = $1 AND deleted_at IS NULL
            LIMIT 1`,
          [normalized]
        );

        if (rows.length === 0) {
          return { data: null, error: authError('User not found', 'user_not_found') };
        }

        // One live token per user: a fresh request supersedes the previous one.
        await query(
          `INSERT INTO public.auth_recovery_tokens (user_id, email, token, sent_at, expires_at, consumed_at)
           VALUES ($1, $2, $3, now(), now() + interval '1 hour', NULL)
           ON CONFLICT (user_id) DO UPDATE
             SET email = EXCLUDED.email,
                 token = EXCLUDED.token,
                 sent_at = EXCLUDED.sent_at,
                 expires_at = EXCLUDED.expires_at,
                 consumed_at = NULL`,
          [rows[0].id, normalized, token]
        );

        const redirectTo = options.redirectTo
          || process.env.PASSWORD_RESET_REDIRECT_URL
          || (process.env.NEXT_PUBLIC_APP_URL ? `${process.env.NEXT_PUBLIC_APP_URL}/reset-password` : '');

        const separator = redirectTo.includes('?') ? '&' : '?';
        const actionLink = `${redirectTo}${separator}token=${token}&type=recovery&email=${encodeURIComponent(normalized)}`;

        return {
          data: {
            properties: {
              action_link: actionLink,
              hashed_token: token,
              verification_type: 'recovery',
              redirect_to: redirectTo
            },
            user: toAuthUser(rows[0])
          },
          error: null
        };
      } catch (err) {
        return { data: null, error: authError(err.message) };
      }
    }
  };

  return {
    admin,

    /**
     * Verify an email/password pair against `encrypted_password`.
     *
     * @param {object} credentials - {email, password}
     * @returns {Promise<object>} `{ data: { user, session }, error }`
     */
    async signInWithPassword({ email, password } = {}) {
      try {
        const normalized = String(email || '').toLowerCase().trim();
        const rows = await query(
          `SELECT ${USER_COLUMNS}, encrypted_password
             FROM auth.users
            WHERE lower(email) = $1 AND deleted_at IS NULL
            LIMIT 1`,
          [normalized]
        );

        const row = rows[0];
        // Same message whether the account is missing or the password is wrong,
        // so this can't be used to probe which emails exist.
        const invalid = { data: { user: null, session: null }, error: { ...authError('Invalid login credentials', 'invalid_credentials'), status: 400 } };

        if (!row || !row.encrypted_password) return invalid;

        const ok = await bcrypt.compare(String(password || ''), row.encrypted_password);
        if (!ok) return invalid;

        await query('UPDATE auth.users SET last_sign_in_at = now() WHERE id = $1', [row.id]);

        return { data: { user: toAuthUser(row), session: null }, error: null };
      } catch (err) {
        return { data: { user: null, session: null }, error: authError(err.message) };
      }
    },

    /**
     * No server-side session exists to invalidate — the API's own JWTs are
     * stateless — so this succeeds without doing anything.
     *
     * @returns {Promise<object>} `{ error: null }`
     */
    async signOut() {
      return { error: null };
    },

    /**
     * Without a the database session there is no ambient user to resolve. Callers
     * treat a null user as "not authenticated", which is the correct answer.
     *
     * @returns {Promise<object>} `{ data: { user: null }, error }`
     */
    async getUser() {
      return {
        data: { user: null },
        error: authError('No active session; use the API access token instead', 'session_not_found')
      };
    }
  };
}

module.exports = { createAuth, toAuthUser };
