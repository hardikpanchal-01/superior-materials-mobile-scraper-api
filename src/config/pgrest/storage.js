/**
 * Object storage backed by the `public.storage_objects` table.
 *
 * Replaces object storage. Bytes live in the database rather than on local
 * disk so every API instance sees the same objects without a shared volume,
 * and so nothing else has to be provisioned alongside the Postgres cluster.
 *
 * Public URLs are served by the `/storage/:bucket/*` route registered in
 * `app.js`.
 */

/**
 * Base URL that public object URLs are built from.
 *
 * @returns {string} Base URL without a trailing slash
 */
function publicBaseUrl() {
  const base = process.env.API_BASE_URL
    || process.env.NEXT_PUBLIC_APP_URL
    || `http://localhost:${process.env.PORT || 5000}`;
  return base.replace(/\/+$/, '');
}

/**
 * Build the storage namespace bound to a pg pool.
 *
 * Mirrors `db.storage.from(bucket).upload/getPublicUrl/remove/download`.
 *
 * @param {object} pool - pg Pool
 * @returns {object} `{ from }`
 */
function createStorage(pool) {
  /**
   * @param {string} bucket - Bucket name
   * @returns {object} Bucket operations
   */
  function from(bucket) {
    return {
      /**
       * @param {string} path - Object path within the bucket
       * @param {Buffer} body - Bytes
       * @param {object} [options] - {contentType, upsert}
       * @returns {Promise<object>} `{ data: { path }, error }`
       */
      async upload(path, body, options = {}) {
        if (!pool) {
          return { data: null, error: { message: 'PostgreSQL pool not configured. Please set DATABASE_URL.' } };
        }
        try {
          const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
          const conflict = options.upsert
            ? `ON CONFLICT (bucket, path) DO UPDATE
                 SET data = EXCLUDED.data,
                     content_type = EXCLUDED.content_type,
                     size_bytes = EXCLUDED.size_bytes,
                     updated_at = now()`
            : 'ON CONFLICT (bucket, path) DO NOTHING';

          const result = await pool.query(
            `INSERT INTO public.storage_objects (bucket, path, content_type, size_bytes, data)
             VALUES ($1, $2, $3, $4, $5)
             ${conflict}
             RETURNING path`,
            [bucket, path, options.contentType || 'application/octet-stream', buffer.length, buffer]
          );

          // A non-upsert insert that hit an existing key returns no row —
          // that is the "already exists" case the database reports as an error.
          if (result.rows.length === 0) {
            return { data: null, error: { message: 'The resource already exists', statusCode: '409' } };
          }
          return { data: { path: result.rows[0].path, fullPath: `${bucket}/${result.rows[0].path}` }, error: null };
        } catch (err) {
          return { data: null, error: { message: err.message } };
        }
      },

      /**
       * Synchronous, like the db-js original.
       *
       * @param {string} path - Object path
       * @returns {object} `{ data: { publicUrl } }`
       */
      getPublicUrl(path) {
        const encoded = String(path).split('/').map(encodeURIComponent).join('/');
        return { data: { publicUrl: `${publicBaseUrl()}/storage/${encodeURIComponent(bucket)}/${encoded}` } };
      },

      /**
       * @param {string[]} paths - Object paths to delete
       * @returns {Promise<object>} `{ data, error }`
       */
      async remove(paths) {
        if (!pool) {
          return { data: null, error: { message: 'PostgreSQL pool not configured. Please set DATABASE_URL.' } };
        }
        try {
          const list = Array.isArray(paths) ? paths : [paths];
          const result = await pool.query(
            'DELETE FROM public.storage_objects WHERE bucket = $1 AND path = ANY($2) RETURNING path',
            [bucket, list]
          );
          return { data: result.rows, error: null };
        } catch (err) {
          return { data: null, error: { message: err.message } };
        }
      },

      /**
       * @param {string} path - Object path
       * @returns {Promise<object>} `{ data: {buffer, contentType}, error }`
       */
      async download(path) {
        if (!pool) {
          return { data: null, error: { message: 'PostgreSQL pool not configured. Please set DATABASE_URL.' } };
        }
        try {
          const result = await pool.query(
            'SELECT data, content_type FROM public.storage_objects WHERE bucket = $1 AND path = $2',
            [bucket, path]
          );
          if (result.rows.length === 0) {
            return { data: null, error: { message: 'Object not found', statusCode: '404' } };
          }
          return {
            data: { buffer: result.rows[0].data, contentType: result.rows[0].content_type },
            error: null
          };
        } catch (err) {
          return { data: null, error: { message: err.message } };
        }
      }
    };
  }

  return { from };
}

module.exports = { createStorage, publicBaseUrl };
