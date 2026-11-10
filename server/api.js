'use strict';
/**
 * Dog Log server-side sync API (WORK-274, Increment I1).
 *
 * Replaces the browser's direct Supabase RPC calls with two authenticated server routes.
 * Each route's response body is the same JSON its RPC returned, so the client contract is
 * unchanged:
 *
 *   POST /api/sync/seed  { seed_id, doc, device_id?, client_version? }  → dog_log.server_seed_state
 *   POST /api/sync       { mutations?, device_id?, client_version? }   → dog_log.server_sync
 *
 * The owner is never taken from the request: it is the app user that dog_log.app_identity
 * maps the verified session to. Errors are mapped to stable codes and never carry database
 * messages, connection details or stack traces.
 *
 * The handler is framework-neutral, ({ method, path, headers, body }) → { status, headers,
 * body }, so a Vercel function adapter can be added in a later, separately approved increment.
 * Nothing in this directory is deployed: .vercelignore excludes it.
 */

const { authenticate } = require('./session');

const MAX_BODY_CHARS = 1000000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RETRYABLE = new Set(['55P03', '57014', '40001', '40P01']); // lock timeout, cancel, serialization, deadlock
const BAD_REQUEST = new Set(['invalid_seed', 'invalid_mutations', 'too_many_mutations']);
const HEADERS = Object.freeze({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });

function reply(status, body) {
  return { status, headers: { ...HEADERS }, body };
}

function parseBody(body) {
  if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  if (typeof body !== 'string' || body.length > MAX_BODY_CHARS) return null;
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    return null;
  }
}

function optionalDevice(v) {
  return v === undefined || v === null || typeof v === 'string';
}

function optionalVersion(v) {
  return v === undefined || v === null || Number.isInteger(v);
}

/** Validated arguments for a route, or null when the request body is malformed. */
const ROUTES = {
  '/api/sync/seed': {
    entry: 'seedState',
    args(owner, b) {
      if (typeof b.seed_id !== 'string' || !UUID.test(b.seed_id)) return null;
      if (!b.doc || typeof b.doc !== 'object' || Array.isArray(b.doc)) return null;
      if (!optionalDevice(b.device_id) || !optionalVersion(b.client_version)) return null;
      return [owner, b.seed_id, JSON.stringify(b.doc), b.device_id ?? null, b.client_version ?? 1];
    },
  },
  '/api/sync': {
    entry: 'sync',
    args(owner, b) {
      if (b.mutations !== undefined && b.mutations !== null && !Array.isArray(b.mutations)) return null;
      if (!optionalDevice(b.device_id) || !optionalVersion(b.client_version)) return null;
      return [owner, JSON.stringify(b.mutations ?? []), b.device_id ?? null, b.client_version ?? 1];
    },
  },
};

/** A stable API error for a database error; the database message itself never leaves. */
function mapDbError(err) {
  const code = err && err.code;
  const message = err && err.message;
  if (code === '22023' && message === 'client_outdated') {
    const m = /min_client_version=(\d+)/.exec((err && err.hint) || '');
    return reply(426, { error: 'client_outdated', min_client_version: m ? Number(m[1]) : null });
  }
  if (code === '22023' && BAD_REQUEST.has(message)) return reply(400, { error: message });
  if (code === '42501') return reply(401, { error: 'not_authenticated' });
  if (RETRYABLE.has(code)) return reply(503, { error: 'busy', retryable: true });
  return reply(500, { error: 'server_error' });
}

/**
 * createApi({ db, verifySession, log? }) → async handle(req).
 * db is server/db.js createDb(); verifySession is the server/session.js contract.
 * log(event) receives { route, outcome, code? } only: never tokens, bodies or messages.
 */
function createApi(options) {
  const { db, verifySession } = options || {};
  const log = typeof (options && options.log) === 'function' ? options.log : () => {};
  if (!db || typeof db.call !== 'function') throw new TypeError('createApi needs a db from server/db.js');
  if (typeof verifySession !== 'function') throw new TypeError('createApi needs a verifySession function');

  return async function handle(req) {
    const route = ROUTES[req && req.path];
    if (!route) return reply(404, { error: 'not_found' });
    if (req.method !== 'POST') return { ...reply(405, { error: 'method_not_allowed' }), headers: { ...HEADERS, allow: 'POST' } };

    const identity = await authenticate(req.headers, verifySession);
    if (!identity) {
      log({ route: req.path, outcome: 'unauthenticated' });
      return reply(401, { error: 'not_authenticated' });
    }
    const body = parseBody(req.body);
    if (!body) return reply(400, { error: 'invalid_request' });

    try {
      const owner = await db.call('resolveOwner', [identity.provider, identity.subject]);
      if (!owner) {
        log({ route: req.path, outcome: 'no_account' });
        return reply(403, { error: 'no_account' });
      }
      const args = route.args(owner, body);
      if (!args) return reply(400, { error: 'invalid_request' });
      const result = await db.call(route.entry, args);
      log({ route: req.path, outcome: 'ok' });
      return reply(200, result);
    } catch (err) {
      const mapped = mapDbError(err);
      log({ route: req.path, outcome: 'error', status: mapped.status, code: (err && err.code) || null });
      return mapped;
    }
  };
}

module.exports = { createApi, mapDbError, ROUTES };
