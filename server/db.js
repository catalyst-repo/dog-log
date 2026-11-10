'use strict';
/**
 * Environment-safe database connection for the Dog Log server API (WORK-274).
 *
 * - Connects only to a declared, allowed backend target. Increment I1 allows only the
 *   persistent Neon DEV target `dev`; Production stays on Supabase until a governed
 *   cutover changes the backend declaration and this list together.
 * - Refuses to run in a Vercel Production deployment.
 * - Reads the connection string from one server-side environment variable. It is never
 *   logged, returned or placed in an error message, and no browser code ever sees it.
 * - A non-local host must be the expected Neon endpoint (DOG_LOG_DATABASE_ENDPOINT, a
 *   non-secret endpoint id) and use TLS, so a Production URL put in the wrong variable is
 *   refused rather than silently used.
 * - The driver is injected (createPool), so this file has no runtime dependency.
 */

const URL_VAR = 'DOG_LOG_DATABASE_URL';
const TARGET_VAR = 'DOG_LOG_BACKEND_TARGET';
const ENDPOINT_VAR = 'DOG_LOG_DATABASE_ENDPOINT';
const ALLOWED_TARGETS = Object.freeze(['dev']);
const ALLOWED_VERCEL_ENVS = Object.freeze(['preview', 'development']);
const LOCAL_HOSTS = Object.freeze(['localhost', '127.0.0.1', '::1', '[::1]']);
const TLS_MODES = Object.freeze(['require', 'verify-ca', 'verify-full']);

class DbConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DbConfigError';
    this.code = code;
  }
}

/** The validated configuration, or a DbConfigError naming only variables, never values. */
function resolveConfig(env) {
  env = env || {};
  const vercelEnv = env.VERCEL_ENV;
  if (vercelEnv !== undefined && !ALLOWED_VERCEL_ENVS.includes(vercelEnv)) {
    throw new DbConfigError('environment-not-allowed',
      'the Dog Log Neon backend is not enabled in this deployment environment (VERCEL_ENV)');
  }
  const target = env[TARGET_VAR];
  if (!ALLOWED_TARGETS.includes(target)) {
    throw new DbConfigError('target-not-allowed', `${TARGET_VAR} must name an allowed backend target (${ALLOWED_TARGETS.join(', ')})`);
  }
  const raw = env[URL_VAR];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new DbConfigError('url-missing', `${URL_VAR} is not set`);
  }
  let url;
  try {
    url = new URL(raw);
  } catch (e) {
    throw new DbConfigError('url-invalid', `${URL_VAR} is not a valid connection URL`);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new DbConfigError('url-invalid', `${URL_VAR} must be a postgres:// or postgresql:// URL`);
  }
  const host = url.hostname.toLowerCase();
  const local = host === '' || LOCAL_HOSTS.includes(host);
  if (!local) {
    const endpoint = env[ENDPOINT_VAR];
    if (typeof endpoint !== 'string' || !/^ep-[a-z0-9-]+$/.test(endpoint)) {
      throw new DbConfigError('endpoint-missing', `${ENDPOINT_VAR} must name the expected Neon endpoint for a remote host`);
    }
    const label = host.split('.')[0];
    if (label !== endpoint && label !== `${endpoint}-pooler`) {
      throw new DbConfigError('endpoint-mismatch', `${URL_VAR} does not point at the endpoint named by ${ENDPOINT_VAR}`);
    }
    if (!TLS_MODES.includes(url.searchParams.get('sslmode'))) {
      throw new DbConfigError('tls-required', `${URL_VAR} must require TLS (sslmode=require or stricter) for a remote host`);
    }
  }
  return Object.freeze({ target, connectionString: raw, local });
}

/**
 * createDb({ env, createPool }) → { target, call(fn, args), close() }.
 *
 * createPool({ connectionString }) returns a pool with query(text, values) and end(), for
 * example node-postgres or @neondatabase/serverless. call() runs one server entry point as
 * its own statement and transaction, so the request owner it binds lasts only for that call.
 */
function createDb(options) {
  const { env, createPool } = options || {};
  if (typeof createPool !== 'function') throw new TypeError('createDb needs a createPool function');
  const config = resolveConfig(env);
  const pool = createPool({ connectionString: config.connectionString });
  const ENTRY_POINTS = {
    resolveOwner: 'select dog_log.server_resolve_owner($1, $2) as result',
    seedState: 'select dog_log.server_seed_state($1, $2, $3, $4, $5) as result',
    sync: 'select dog_log.server_sync($1, $2, $3, $4) as result',
  };
  return Object.freeze({
    target: config.target,
    async call(fn, args) {
      const text = ENTRY_POINTS[fn];
      if (!text) throw new TypeError(`unknown entry point ${fn}`);
      const res = await pool.query(text, args);
      return res.rows[0].result;
    },
    async close() {
      await pool.end();
    },
  });
}

module.exports = { createDb, resolveConfig, DbConfigError, URL_VAR, TARGET_VAR, ENDPOINT_VAR, ALLOWED_TARGETS };
