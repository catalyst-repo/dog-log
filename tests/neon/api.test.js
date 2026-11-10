'use strict';
// WORK-274 Increment I1: the server API end to end on disposable local PostgreSQL — request → session
// verifier → identity mapping → server_* entry point → response — through server/db.js with a real
// node-postgres pool connected as the runtime role. A test-only verifier stands in for the undecided
// auth provider. Never contacts Supabase or Neon.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const cluster = require('./lib/cluster');
const { createDb } = require('../../server/db');
const { createApi } = require('../../server/api');

const PORT = Number(process.env.PGTEST_NEON_API_PORT || 55494);
let pg;
let admin;
let db;
let api;
const events = [];

// Test-only session verifier: a fixed token table. A real verifier checks signature, expiry and audience.
const TOKENS = { 'token-a': { provider: 'test', subject: 'user-a' }, 'token-unlinked': { provider: 'test', subject: 'nobody' } };
const verifySession = async (token) => TOKENS[token] || null;

test.before(async () => {
  pg = cluster.start(PORT);
  admin = new Pool(pg.config('neon'));
  const owner = randomUUID();
  await admin.query('insert into dog_log.app_user (id) values ($1)', [owner]);
  await admin.query("insert into dog_log.app_identity (provider, subject, user_id) values ('test', 'user-a', $1)", [owner]);
  // A local connection string for the runtime role; local hosts need no endpoint or TLS (server/db.js).
  // On Unix the cluster listens only on a private socket directory, passed as the `host` query parameter.
  const socket = pg.host.startsWith('/');
  const url = ['postgresql', '://', 'dog_log_runtime_test', '@', socket ? 'localhost' : pg.host, ':', pg.port, '/neon',
    socket ? `?host=${encodeURIComponent(pg.host)}` : ''].join('');
  db = createDb({ env: { DOG_LOG_BACKEND_TARGET: 'dev', DOG_LOG_DATABASE_URL: url }, createPool: (o) => new Pool(o) });
  api = createApi({ db, verifySession, log: (e) => events.push(e) });
});
test.after(async () => {
  if (db) await db.close();
  if (admin) await admin.end();
  if (pg) pg.stop();
});

const post = (path, body, token = 'token-a') => api({
  method: 'POST', path, headers: token ? { authorization: `Bearer ${token}` } : {},
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const mutation = (fields) => ({ mutation_id: randomUUID(), client_created_at: new Date().toISOString(), ...fields });

test('api: unauthenticated and unlinked sessions are refused before any write', async () => {
  assert.deepEqual((await post('/api/sync', {}, null)).status, 401);
  assert.deepEqual((await post('/api/sync', {}, 'forged-token')).status, 401);
  const unlinked = await post('/api/sync/seed', { seed_id: randomUUID(), doc: { stock: { fridge: 1 } } }, 'token-unlinked');
  assert.deepEqual([unlinked.status, unlinked.body], [403, { error: 'no_account' }]);
  const [{ n }] = (await admin.query('select count(*)::int as n from dog_log.state')).rows;
  assert.equal(n, 0);
});

test('api: seed then sync returns the RPC contract, with the owner taken only from the session', async () => {
  assert.deepEqual((await post('/api/sync', { mutations: [] })).body, { status: 'no-cloud-state' });
  const seedId = randomUUID();
  const seed = await post('/api/sync/seed', {
    seed_id: seedId, doc: { stock: { fridge: 4, freezer: 3 }, tracking: { mealCursor: Date.now() - 30 * 3600 * 1000 } },
    device_id: 'iphone', client_version: 1,
    owner_id: randomUUID(), // ignored: a client can never choose the owner
  });
  assert.equal(seed.status, 200);
  assert.equal(seed.body.status, 'seeded');
  assert.deepEqual(Object.keys(seed.body.state).sort(),
    ['doc', 'meal_cursor', 'meal_tracking_since', 'min_client_version', 'recent_meals', 'revision', 'schema_version', 'server_now', 'time_zone']);
  assert.equal((await post('/api/sync/seed', { seed_id: seedId, doc: { stock: {} } })).body.status, 'already-seeded');

  const sync = await post('/api/sync', { mutations: [mutation({ type: 'adjust', key: 'freezer', delta: 2 })], device_id: 'iphone', client_version: 1 });
  assert.equal(sync.status, 200);
  assert.equal(sync.body.status, 'ok');
  assert.equal(sync.body.results[0].status, 'applied');
  assert.ok(sync.body.recent_meals.length > 0, 'due meals were processed server-side');
  assert.equal(sync.headers['cache-control'], 'no-store');
  const owners = (await admin.query('select owner_id from dog_log.state')).rows;
  const [{ user_id }] = (await admin.query("select user_id from dog_log.app_identity where subject = 'user-a'")).rows;
  assert.deepEqual(owners.map((r) => r.owner_id), [user_id]);
});

test('api: refusals map to stable responses', async () => {
  const outdated = await post('/api/sync', { client_version: 0 });
  assert.deepEqual([outdated.status, outdated.body], [426, { error: 'client_outdated', min_client_version: 1 }]);
  const many = await post('/api/sync', { mutations: Array.from({ length: 51 }, () => mutation({ type: 'adjust', key: 'fridge', delta: 1 })) });
  assert.deepEqual([many.status, many.body], [400, { error: 'too_many_mutations' }]);
  for (const body of ['not json', '[]', { mutations: {} }, { device_id: 7 }, { client_version: 1.5 }]) {
    assert.deepEqual((await post('/api/sync', body)).body, { error: 'invalid_request' }, JSON.stringify(body));
  }
  for (const body of [{ seed_id: 'x', doc: {} }, { seed_id: randomUUID(), doc: [] }, { seed_id: randomUUID() }]) {
    assert.deepEqual((await post('/api/sync/seed', body)).body, { error: 'invalid_request' }, JSON.stringify(body));
  }
});

test('api: the log receives outcomes and codes only — never tokens, bodies or messages', () => {
  assert.ok(events.length > 0);
  const text = JSON.stringify(events);
  for (const leak of ['token-a', 'Bearer', 'mutation_id', 'freezer', 'too_many_mutations', 'dog_log_runtime_test']) {
    assert.equal(text.includes(leak), false, `log leaks ${leak}`);
  }
  for (const e of events) assert.deepEqual(Object.keys(e).filter((k) => !['route', 'outcome', 'status', 'code'].includes(k)), []);
});
