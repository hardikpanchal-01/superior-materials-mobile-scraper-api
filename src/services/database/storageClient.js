/**
 * Object storage client.
 *
 * Previously backed by object storage; this tenant has no hosted backend, so
 * objects now live in `public.storage_objects` in the tenant database and are
 * served by the `/storage/:bucket/*` route. The exported function signatures are
 * unchanged, so `scrapedOrderDatabaseService` and `userService` are unaffected.
 *
 * The file keeps its name because it is required by path in several places;
 * only the backend behind it changed.
 */

const { getPool } = require('./postgresClient');
const { createStorage } = require('../../config/pgrest/storage');

// Storage timeout configuration (default: 30 seconds)
const STORAGE_TIMEOUT_MS = parseInt(process.env.STORAGE_TIMEOUT_MS) || 30000;

/**
 * Storage bucket name for scraped orders
 */
const SCRAPED_ORDERS_BUCKET = 'scraped-orders';

/**
 * Storage bucket name for user avatars
 */
const AVATARS_BUCKET = 'avatars';

let storage = null;

/**
 * Resolve the storage namespace lazily, so it picks up the pool after dotenv
 * has run.
 *
 * @returns {object} Storage namespace
 */
function getStorage() {
  const pool = getPool();
  if (!pool) {
    throw new Error('Storage is not configured. Please set DATABASE_URL in your .env file.');
  }
  if (!storage) {
    storage = createStorage(pool);
  }
  return storage;
}

/**
 * Reject a storage operation that outruns the timeout.
 *
 * @param {Promise} promise - Operation
 * @param {number} timeoutMs - Timeout
 * @param {string} label - Wording for the timeout error
 * @returns {Promise} Result of the operation
 */
function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Upload JSON data to storage with timeout protection
 *
 * @param {string} fileName - Name of the file to create
 * @param {object|array} data - Data to store as JSON
 * @param {number} timeoutMs - Timeout in milliseconds (default: STORAGE_TIMEOUT_MS)
 * @returns {Promise<{path: string, publicUrl: string}>} Upload result
 */
async function uploadToStorage(fileName, data, timeoutMs = STORAGE_TIMEOUT_MS) {
  const bucket = getStorage().from(SCRAPED_ORDERS_BUCKET);

  const jsonContent = JSON.stringify(data, null, 2);
  const buffer = Buffer.from(jsonContent, 'utf-8');

  try {
    const { data: uploadData, error: uploadError } = await withTimeout(
      bucket.upload(fileName, buffer, { contentType: 'application/json', upsert: false }),
      timeoutMs,
      'Storage upload'
    );

    if (uploadError) {
      throw new Error(`Storage upload failed: ${uploadError.message}`);
    }

    const { data: urlData } = bucket.getPublicUrl(fileName);

    return {
      path: uploadData.path,
      publicUrl: urlData.publicUrl
    };
  } catch (error) {
    if (error.message.includes('timeout')) {
      console.error(`Storage upload timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
}

/**
 * Upload an avatar image to storage
 *
 * @param {string} userId - User ID used to namespace the file
 * @param {Buffer} fileBuffer - Raw file buffer
 * @param {string} mimeType - MIME type (e.g. 'image/png')
 * @param {string} originalName - Original file name for extension extraction
 * @returns {Promise<{path: string, publicUrl: string}>} Upload result
 */
async function uploadAvatarToStorage(userId, fileBuffer, mimeType, originalName) {
  const bucket = getStorage().from(AVATARS_BUCKET);

  // Extract extension from original filename
  const ext = originalName.split('.').pop().toLowerCase();
  const fileName = `${userId}/avatar_${Date.now()}.${ext}`;

  const { data: uploadData, error: uploadError } = await withTimeout(
    bucket.upload(fileName, fileBuffer, { contentType: mimeType, upsert: true }),
    STORAGE_TIMEOUT_MS,
    'Avatar upload'
  );

  if (uploadError) {
    throw new Error(`Avatar upload failed: ${uploadError.message}`);
  }

  const { data: urlData } = bucket.getPublicUrl(fileName);

  return {
    path: uploadData.path,
    publicUrl: urlData.publicUrl
  };
}

/**
 * Delete an avatar file from storage
 *
 * @param {string} filePath - The storage path of the file to delete
 * @returns {Promise<void>}
 */
async function deleteAvatarFromStorage(filePath) {
  const { error } = await getStorage().from(AVATARS_BUCKET).remove([filePath]);

  if (error) {
    console.warn('Failed to delete old avatar from storage:', error.message);
  }
}

module.exports = {
  SCRAPED_ORDERS_BUCKET,
  AVATARS_BUCKET,
  uploadToStorage,
  uploadAvatarToStorage,
  deleteAvatarFromStorage,
  getStorage,
  STORAGE_TIMEOUT_MS
};
