'use strict';
/**
 * Session verification interface for the Dog Log server API (WORK-274).
 *
 * The auth provider is a pending WORK-274 decision (for example Neon Auth / Better Auth,
 * or a self-hosted alternative), so the API depends only on this contract:
 *
 *   verifySession(token) → Promise<{ provider, subject } | null>
 *
 * It returns the verified identity for a valid bearer token, or null. It must check the
 * token's signature, expiry and audience itself; the API trusts nothing else in the
 * request. The identity is then mapped to the app user by dog_log.app_identity, so no
 * provider's user id becomes the data owner key.
 *
 * No verifier ships here: a deployment without a real verifier refuses every request.
 */

const PROVIDER = /^[a-z][a-z0-9_-]{0,39}$/;
const MAX_TOKEN = 8192;

/** The bearer token from an Authorization header, or null. */
function bearerToken(headers) {
  const h = headers && (headers.authorization || headers.Authorization);
  if (typeof h !== 'string') return null;
  const m = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(h.trim());
  if (!m || m[1].length > MAX_TOKEN) return null;
  return m[1];
}

/** A verified { provider, subject } for the request, or null. Verifier errors count as unverified. */
async function authenticate(headers, verifySession) {
  if (typeof verifySession !== 'function') return null;
  const token = bearerToken(headers);
  if (!token) return null;
  let identity;
  try {
    identity = await verifySession(token);
  } catch (e) {
    return null;
  }
  if (!identity || typeof identity !== 'object') return null;
  const { provider, subject } = identity;
  if (typeof provider !== 'string' || !PROVIDER.test(provider)) return null;
  if (typeof subject !== 'string' || subject.length < 1 || subject.length > 255) return null;
  return { provider, subject };
}

module.exports = { bearerToken, authenticate };
