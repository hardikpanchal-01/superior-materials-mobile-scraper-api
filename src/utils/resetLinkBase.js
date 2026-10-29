/**
 * Reset-link base URL
 *
 * The host of the e-mailed password-reset link must come from configuration,
 * never from the request. A caller-supplied `redirect_url` is used only when
 * its origin is one of this tenant's configured frontend origins; anything
 * else is ignored and the configured link is used instead.
 *
 * Allowed origins (all optional, read from the environment):
 *   PASSWORD_RESET_REDIRECT_URL     - full reset page URL (existing)
 *   NEXT_PUBLIC_APP_URL             - tenant frontend base URL (existing)
 *   PASSWORD_RESET_ALLOWED_ORIGINS  - extra origins, comma separated (new)
 */

const DEFAULT_RESET_URL = 'http://localhost:3000/reset-password';

function toOrigin(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    const u = new URL(value.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** The reset page URL from configuration (same order as before). */
function configuredResetBase(env = process.env) {
  if (env.PASSWORD_RESET_REDIRECT_URL) return env.PASSWORD_RESET_REDIRECT_URL;
  if (env.NEXT_PUBLIC_APP_URL) return `${env.NEXT_PUBLIC_APP_URL}/reset-password`;
  return DEFAULT_RESET_URL;
}

/** Set of origins a caller-supplied redirect_url may point at. */
function allowedResetOrigins(env = process.env) {
  const list = [env.PASSWORD_RESET_REDIRECT_URL, env.NEXT_PUBLIC_APP_URL]
    .concat(String(env.PASSWORD_RESET_ALLOWED_ORIGINS || '').split(','));
  return new Set(list.map(toOrigin).filter(Boolean));
}

/**
 * Pick the base URL for the reset link.
 * @param {string|null} requested - redirect_url from the request body (untrusted)
 * @returns {{ baseUrl: string, source: 'request'|'config', rejected: boolean }}
 */
function resolveResetBase(requested, env = process.env) {
  const fallback = configuredResetBase(env);
  if (!requested) return { baseUrl: fallback, source: 'config', rejected: false };

  const origin = toOrigin(requested);
  if (origin && allowedResetOrigins(env).has(origin)) {
    // Keep only origin + path: drops any user-info, query string or fragment.
    const u = new URL(requested.trim());
    return { baseUrl: `${u.origin}${u.pathname}`, source: 'request', rejected: false };
  }
  return { baseUrl: fallback, source: 'config', rejected: true };
}

module.exports = { resolveResetBase, configuredResetBase, allowedResetOrigins };
