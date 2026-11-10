'use strict';
// WORK-274 Increment I1: unit tests for the server layer that need no database — the environment guard in
// server/db.js, session parsing in server/session.js and error mapping in server/api.js.
// Every connection string here is synthetic and built at run time; none names a real host or credential.
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveConfig, createDb, DbConfigError } = require('../../server/db');
const { bearerToken, authenticate } = require('../../server/session');
const { createApi, mapDbError } = require('../../server/api');

const FAKE_SECRET = ['synthetic', 'not', 'a', 'secret'].join('-');
const ENDPOINT = 'ep-synthetic-test-000000';
const remoteUrl = (host, query = '?sslmode=require') => ['postgresql', '://', 'app_user', ':', FAKE_SECRET, '@', host, '/neondb', query].join('');
const REMOTE_HOST = `${ENDPOINT}-pooler.ap-southeast-2.aws.neon.tech`;
const LOCAL = ['postgresql', '://', 'dog_log_runtime_test', '@', 'localhost:5432', '/neon'].join('');
const ok = (extra = {}) => ({ DOG_LOG_BACKEND_TARGET: 'dev', DOG_LOG_DATABASE_URL: LOCAL, ...extra });

function refuses(env, code) {
  let err;
  try { resolveConfig(env); } catch (e) { err = e; }
  assert.ok(err instanceof DbConfigError, `expected a DbConfigError ${code}`);
  assert.equal(err.code, code);
  // An error never carries the connection string, its password or its host.
  const text = `${err.message} ${err.stack}`;
  for (const v of [FAKE_SECRET, REMOTE_HOST, 'neon.tech', LOCAL]) assert.ok(!text.includes(v), `error leaks ${v}`);
}

test('db guard: a local DEV connection is accepted, and nothing but dev is an allowed target', () => {
  assert.deepEqual({ ...resolveConfig(ok()) }, { target: 'dev', connectionString: LOCAL, local: true });
  for (const target of [undefined, '', 'main', 'prod', 'production', 'DEV', 'preview']) refuses(ok({ DOG_LOG_BACKEND_TARGET: target }), 'target-not-allowed');
});

test('db guard: a Vercel Production deployment, or an unknown deployment environment, is refused', () => {
  refuses(ok({ VERCEL_ENV: 'production' }), 'environment-not-allowed');
  refuses(ok({ VERCEL_ENV: 'staging' }), 'environment-not-allowed');
  assert.equal(resolveConfig(ok({ VERCEL_ENV: 'preview' })).target, 'dev');
  assert.equal(resolveConfig(ok({ VERCEL_ENV: 'development' })).target, 'dev');
});

test('db guard: missing, malformed or non-PostgreSQL URLs are refused without echoing them', () => {
  refuses(ok({ DOG_LOG_DATABASE_URL: undefined }), 'url-missing');
  refuses(ok({ DOG_LOG_DATABASE_URL: '  ' }), 'url-missing');
  refuses(ok({ DOG_LOG_DATABASE_URL: 'not a url' }), 'url-invalid');
  refuses(ok({ DOG_LOG_DATABASE_URL: remoteUrl(REMOTE_HOST).replace('postgresql', 'https') }), 'url-invalid');
});

test('db guard: a remote host must be the declared Neon endpoint and require TLS', () => {
  const remote = (extra) => ok({ DOG_LOG_DATABASE_URL: remoteUrl(REMOTE_HOST), DOG_LOG_DATABASE_ENDPOINT: ENDPOINT, ...extra });
  assert.equal(resolveConfig(remote()).local, false);
  assert.equal(resolveConfig(remote({ DOG_LOG_DATABASE_URL: remoteUrl(`${ENDPOINT}.ap-southeast-2.aws.neon.tech`) })).local, false);
  refuses(remote({ DOG_LOG_DATABASE_ENDPOINT: undefined }), 'endpoint-missing');
  refuses(remote({ DOG_LOG_DATABASE_ENDPOINT: 'not-an-endpoint' }), 'endpoint-missing');
  refuses(remote({ DOG_LOG_DATABASE_ENDPOINT: 'ep-some-other-endpoint-111111' }), 'endpoint-mismatch');
  refuses(remote({ DOG_LOG_DATABASE_URL: remoteUrl(`${ENDPOINT}x.ap-southeast-2.aws.neon.tech`) }), 'endpoint-mismatch');
  refuses(remote({ DOG_LOG_DATABASE_URL: remoteUrl(REMOTE_HOST, '') }), 'tls-required');
  refuses(remote({ DOG_LOG_DATABASE_URL: remoteUrl(REMOTE_HOST, '?sslmode=prefer') }), 'tls-required');
});

test('db guard: createDb never builds a pool for a refused configuration', () => {
  let built = 0;
  const createPool = () => { built += 1; return { query: async () => ({ rows: [{ result: null }] }), end: async () => {} }; };
  assert.throws(() => createDb({ env: ok({ VERCEL_ENV: 'production' }), createPool }), DbConfigError);
  assert.throws(() => createDb({ env: ok() }), TypeError);
  assert.equal(built, 0);
  const handle = createDb({ env: ok(), createPool });
  assert.equal(built, 1);
  assert.equal(handle.target, 'dev');
  assert.equal(Object.keys(handle).includes('connectionString'), false, 'the db handle never exposes the connection string');
});

test('session: bearer tokens are parsed strictly and verifier output is validated', async () => {
  assert.equal(bearerToken({ authorization: 'Bearer abc.def-ghi' }), 'abc.def-ghi');
  for (const h of [undefined, '', 'Basic abc', 'Bearer', 'Bearer a b', `Bearer ${'x'.repeat(9000)}`]) assert.equal(bearerToken({ authorization: h }), null);
  const verify = async (t) => ({ good: { provider: 'test', subject: 'user-a' }, badprov: { provider: 'Bad Provider', subject: 'x' }, nosub: { provider: 'test', subject: '' } })[t] || null;
  assert.deepEqual(await authenticate({ authorization: 'Bearer good' }, verify), { provider: 'test', subject: 'user-a' });
  for (const t of ['badprov', 'nosub', 'unknown']) assert.equal(await authenticate({ authorization: `Bearer ${t}` }, verify), null);
  assert.equal(await authenticate({ authorization: 'Bearer good' }, async () => { throw new Error('verifier down'); }), null);
  assert.equal(await authenticate({ authorization: 'Bearer good' }, undefined), null);
});

test('api: database errors map to stable codes and never carry the database message', () => {
  const e = (code, message, hint) => Object.assign(new Error(message), { code, hint });
  assert.deepEqual(mapDbError(e('22023', 'client_outdated', 'min_client_version=3')).body, { error: 'client_outdated', min_client_version: 3 });
  assert.equal(mapDbError(e('22023', 'client_outdated')).status, 426);
  assert.deepEqual(mapDbError(e('22023', 'too_many_mutations')).body, { error: 'too_many_mutations' });
  assert.equal(mapDbError(e('22023', 'something else')).status, 500);
  assert.equal(mapDbError(e('42501', 'not_authenticated')).status, 401);
  for (const c of ['55P03', '57014', '40001', '40P01']) assert.deepEqual(mapDbError(e(c, 'x')).body, { error: 'busy', retryable: true });
  const leaky = mapDbError(e('08006', `connection to ${remoteUrl(REMOTE_HOST)} failed`));
  assert.deepEqual(leaky.body, { error: 'server_error' });
  assert.equal(JSON.stringify(leaky).includes(FAKE_SECRET), false);
});

test('api: refuses to start without a db or a session verifier, and routes strictly', async () => {
  assert.throws(() => createApi({ verifySession: async () => null }), TypeError);
  assert.throws(() => createApi({ db: { call: async () => null } }), TypeError);
  const api = createApi({ db: { call: async () => { throw new Error('unreachable'); } }, verifySession: async () => null });
  assert.equal((await api({ method: 'POST', path: '/api/other', headers: {}, body: '{}' })).status, 404);
  const get = await api({ method: 'GET', path: '/api/sync', headers: {}, body: '' });
  assert.equal(get.status, 405);
  assert.equal(get.headers.allow, 'POST');
  const anon = await api({ method: 'POST', path: '/api/sync', headers: {}, body: '{}' });
  assert.deepEqual([anon.status, anon.body, anon.headers['cache-control']], [401, { error: 'not_authenticated' }, 'no-store']);
});
