'use strict';
// WORK-274 Increment I1: the portable Neon schema against the live Supabase end-state, on disposable local
// PostgreSQL only. Synthetic accounts only. Never contacts Supabase or Neon.
//   1. parity     — the Neon catalogue is the Supabase end-state except the four declared substitutions;
//   2. behaviour  — identical client operations give identical results on both (differential);
//   3. WORK-287   — an equal-time freezer-to-fridge transfer runs exactly once per due day;
//   4. security   — runtime role privileges, owner isolation and the owner guard, under hostile defaults;
//   5. concurrency, 6. rollback.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const cluster = require('./lib/cluster');
const { clients, normalise } = require('./lib/clients');

const PORT = Number(process.env.PGTEST_NEON_PORT || 55493);
const RUN_START = Date.now();
let pg;
let db;

test.before(() => {
  pg = cluster.start(PORT);
  db = clients(pg);
});
test.after(async () => {
  if (db) await db.end();
  if (pg) pg.stop();
});

const hoursAgoMs = (h) => Date.now() - h * 3600 * 1000;
const seedDoc = (extra = {}) => ({
  stock: { fridge: 5, freezer: 6, minceKg: 2.5, neckPackets: 3 },
  settings: { totalContainers: 12, mincePurchaseIncrementKg: 1 },
  history: [],
  ...extra,
});

async function rows(pool, sql, params) {
  return (await pool.query(sql, params)).rows;
}

// --------------------------------------------------------------------------------------------- 1. parity

const CATALOGUE = `select p.proname as name, pg_get_function_arguments(p.oid) as args, pg_get_function_result(p.oid) as result,
    l.lanname as lang, p.provolatile::text as vol, p.prosecdef as definer, p.proisstrict as strict,
    p.proconfig as cfg, p.prosrc as src
  from pg_proc p join pg_language l on l.oid = p.prolang where p.pronamespace = 'dog_log'::regnamespace`;

async function functions(pool) {
  return Object.fromEntries((await rows(pool, CATALOGUE)).map((f) => [f.name, f]));
}

test('parity: every internal function is the Supabase end-state, verbatim except the S2 owner guard', async () => {
  const supa = await functions(db.supaAdmin);
  const neon = await functions(db.neonAdmin);
  const internals = Object.keys(supa).filter((n) => n.startsWith('_')).sort();
  assert.equal(internals.length, 17);
  for (const n of internals) {
    assert.ok(neon[n], `${n} exists on Neon`);
    const { src: sSrc, ...sAttr } = supa[n];
    const { src: nSrc, ...nAttr } = neon[n];
    assert.deepEqual(nAttr, sAttr, `${n} attributes`);
    const expected = n === '_process_due_meals'
      ? sSrc.split('(select auth.uid())').join('(select dog_log._request_owner())')
      : sSrc;
    assert.equal(nSrc, expected, `${n} body`);
  }
  // The guard substitution really happened, twice, and the WORK-287 fix (v_from) is in the ported body.
  assert.equal(supa._process_due_meals.src.split('(select auth.uid())').length - 1, 2);
  assert.match(neon._process_due_meals.src, /v_from/);
  assert.doesNotMatch(Object.values(neon).map((f) => f.src).join('\n'), /auth\.uid|supabase|request\.jwt/);
});

test('parity: server_seed_state / server_sync are seed_state / sync with only the S3 owner substitution', async () => {
  const supa = await functions(db.supaAdmin);
  const neon = await functions(db.neonAdmin);
  for (const [from, to] of [['seed_state', 'server_seed_state'], ['sync', 'server_sync']]) {
    const s = supa[from];
    const n = neon[to];
    assert.equal(n.args, `p_owner uuid, ${s.args}`);
    for (const k of ['result', 'lang', 'vol', 'definer', 'strict']) assert.deepEqual(n[k], s[k], `${to}.${k}`);
    assert.deepEqual(n.cfg, s.cfg, `${to} search_path and lock_timeout`);
    const old = 'v_owner    uuid := (select auth.uid());';
    assert.equal(s.src.split(old).length - 1, 1);
    assert.equal(n.src, s.src.replace(old, 'v_owner    uuid := dog_log._bind_request_owner(p_owner);'), `${to} body`);
  }
  const onlyNeon = Object.keys(neon).filter((n) => !supa[n]).sort();
  const onlySupa = Object.keys(supa).filter((n) => !neon[n]).sort();
  assert.deepEqual(onlyNeon, ['_bind_request_owner', '_request_owner', 'server_resolve_owner', 'server_seed_state', 'server_sync']);
  assert.deepEqual(onlySupa, ['seed_state', 'sync']);
});

test('parity: sync tables, constraints and indexes match the end-state; only the owner key moves to app_user', async () => {
  const COLUMNS = `select table_name, column_name, data_type, column_default, is_nullable, is_identity from information_schema.columns
    where table_schema = 'dog_log' and table_name in ('state', 'meal_events', 'mutations', 'state_snapshots') order by 1, 2`;
  assert.deepEqual(await rows(db.neonAdmin, COLUMNS), await rows(db.supaAdmin, COLUMNS));
  const CONSTRAINTS = `select conrelid::regclass::text as tbl, conname, pg_get_constraintdef(oid) as def from pg_constraint
    where connamespace = 'dog_log'::regnamespace and conrelid::regclass::text in
      ('dog_log.state', 'dog_log.meal_events', 'dog_log.mutations', 'dog_log.state_snapshots') order by 1, 2`;
  const supa = await rows(db.supaAdmin, CONSTRAINTS);
  const neon = await rows(db.neonAdmin, CONSTRAINTS);
  const fk = (r) => r.conname === 'state_owner_id_fkey';
  assert.deepEqual(neon.filter((r) => !fk(r)), supa.filter((r) => !fk(r)));
  assert.equal(supa.find(fk).def, 'FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE CASCADE');
  assert.equal(neon.find(fk).def, 'FOREIGN KEY (owner_id) REFERENCES dog_log.app_user(id) ON DELETE CASCADE');
  const INDEXES = `select indexrelid::regclass::text as idx, pg_get_indexdef(indexrelid) as def from pg_index
    where indrelid::regclass::text in ('dog_log.state', 'dog_log.meal_events', 'dog_log.mutations', 'dog_log.state_snapshots') order by 1`;
  assert.deepEqual(await rows(db.neonAdmin, INDEXES), await rows(db.supaAdmin, INDEXES));
});

test('parity: no Supabase residue on Neon (no auth schema, client-role grants, policies or publication)', async () => {
  // Roles are cluster-wide, so the reference database's stub roles exist here too; none may hold any dog_log privilege.
  const [r] = await rows(db.neonAdmin, `select
    (select count(*) from pg_namespace where nspname = 'auth')::int as auth_schema,
    ((select count(*) from pg_class c, aclexplode(c.relacl) a join pg_roles g on g.oid = a.grantee
       where c.relnamespace = 'dog_log'::regnamespace and g.rolname in ('anon', 'authenticated', 'service_role'))
     + (select count(*) from pg_proc p, aclexplode(p.proacl) a join pg_roles g on g.oid = a.grantee
       where p.pronamespace = 'dog_log'::regnamespace and g.rolname in ('anon', 'authenticated', 'service_role'))
     + (select count(*) from pg_namespace n, aclexplode(n.nspacl) a join pg_roles g on g.oid = a.grantee
       where n.nspname = 'dog_log' and g.rolname in ('anon', 'authenticated', 'service_role')))::int as client_roles,
    (select count(*) from pg_policies where schemaname = 'dog_log')::int as policies,
    (select count(*) from pg_publication)::int as publications,
    (select count(*) from pg_class where relnamespace = 'dog_log'::regnamespace and relkind = 'r' and not relrowsecurity)::int as rls_off`);
  assert.deepEqual(r, { auth_schema: 0, client_roles: 0, policies: 0, publications: 0, rls_off: 0 });
});

// ------------------------------------------------------------------------------------------ 2. behaviour

// Run the same client calls on both backends for one synthetic account; every response must be identical
// once transaction-clock values are normalised, and so must every row the calls leave behind.
async function differential(steps) {
  const uid = randomUUID();
  await db.createUser(uid);
  const out = [];
  for (const [fn, args] of steps) {
    const call = async (side) => {
      try {
        return { ok: await db[side](uid, fn, args) };
      } catch (e) {
        return { error: { code: e.code, message: e.message, hint: e.hint || null } };
      }
    };
    const supa = await call('supa');
    const neon = await call('neon');
    assert.deepEqual(normalise(neon, RUN_START), normalise(supa, RUN_START), `${fn} response`);
    out.push(neon);
  }
  const TABLES = {
    state: 'select doc, revision, schema_version, min_client_version, time_zone, meal_cursor, meal_tracking_since, seed_id, seeded_from_device, updated_by_device from dog_log.state where owner_id = $1',
    meal_events: 'select meal_date::text, slot, outcome, source_container, slot_at, processed_by_device, state_revision, origin, freezer_to_fridge_count from dog_log.meal_events where owner_id = $1 order by slot_at, slot',
    mutations: 'select mutation_id, device_id, op_type, client_created_at, status, detail, result_revision from dog_log.mutations where owner_id = $1 order by mutation_id',
    state_snapshots: 'select reason, revision, doc from dog_log.state_snapshots where owner_id = $1 order by id',
  };
  for (const [t, sql] of Object.entries(TABLES)) {
    const s = await rows(db.supaAdmin, sql, [uid]);
    const n = await rows(db.neonAdmin, sql, [uid]);
    assert.deepEqual(normalise(n, RUN_START), normalise(s, RUN_START), `${t} rows`);
  }
  return { uid, out };
}

const op = (type, fields, at = new Date()) => ({ mutation_id: randomUUID(), type, client_created_at: at.toISOString(), ...fields });

test('behaviour: first-device seed then catch-up sync over two days (meals and equal-time transfers)', async () => {
  const doc = seedDoc({ tracking: { mealCursor: hoursAgoMs(50) } });
  const { out } = await differential([
    ['seed_state', [randomUUID(), JSON.stringify(doc), 'iphone', 1]],
    ['sync', ['[]', 'iphone', 1]],
    ['sync', ['[]', 'desktop', 1]], // nothing new is due: same revision, no duplicate events
  ]);
  assert.equal(out[0].ok.status, 'seeded');
  assert.equal(out[1].ok.status, 'ok');
  assert.equal(out[2].ok.revision, out[1].ok.revision);
});

test('behaviour: operations — deltas, clamps, recount conflicts, idempotent retries, rejects and ordering', async () => {
  const doc = seedDoc({ tracking: { mealCursor: hoursAgoMs(1) } });
  const add = op('adjust', { key: 'fridge', delta: 3, label: 'Fridge +3' });
  const earlier = op('adjust', { key: 'freezer', delta: -1 }, new Date(Date.now() - 60000));
  const batch = [
    add,
    op('adjust', { key: 'minceKg', delta: -10 }),                               // clamped at zero
    op('adjust', { key: 'fridge', delta: 0.5 }),                                // count delta must be an integer
    op('set', { key: 'freezer', value: 9, expected: 999 }),                     // stale expectation: conflict
    op('settings', { field: 'totalContainers', value: 14, expected: 12 }),
    op('clear_history', { before: new Date().toISOString() }),
    op('replace_state', { doc: seedDoc(), expected_revision: 99 }),            // revision conflict
    op('adjust', { key: 'fridge', delta: 1 }, new Date(Date.now() - 40 * 86400000)), // expired
    { mutation_id: 'not-a-uuid', type: 'adjust', key: 'fridge', delta: 1, client_created_at: new Date().toISOString() },
    earlier, // submitted last, applied first (client_created_at order); results keep submitted order
  ];
  const { out } = await differential([
    ['seed_state', [randomUUID(), JSON.stringify(doc), 'desktop', 1]],
    ['sync', [JSON.stringify(batch), 'desktop', 1]],
    ['sync', [JSON.stringify([add]), 'iphone', 1]], // a retry from another device is a duplicate, applied once
  ]);
  const statuses = out[1].ok.results.map((r) => r.status);
  assert.deepEqual(statuses, ['applied', 'applied-clamped', 'rejected', 'conflict', 'applied', 'applied', 'conflict', 'expired', 'rejected', 'applied']);
  assert.equal(out[2].ok.results[0].status, 'duplicate');
});

test('behaviour: second device adoption — retried seed, competing seed, fresh-device seed without tracking', async () => {
  const seedId = randomUUID();
  const { out } = await differential([
    ['seed_state', [seedId, JSON.stringify(seedDoc()), 'iphone', 1]], // never tracked: initialised like a first run
    ['seed_state', [seedId, JSON.stringify(seedDoc()), 'iphone', 1]],
    ['seed_state', [randomUUID(), JSON.stringify(seedDoc({ stock: { fridge: 0 } })), 'desktop', 1]],
  ]);
  assert.deepEqual(out.map((o) => o.ok.status), ['seeded', 'already-seeded', 'cloud-exists']);
});

test('behaviour: custom schedule — transfer before Dinner, three-day catch-up, and all three slots at one time', async () => {
  await differential([
    ['seed_state', [randomUUID(), JSON.stringify(seedDoc({
      stock: { fridge: 2, freezer: 20 },
      settings: { breakfastTime: '07:30', dinnerTime: '19:00', fridgeTransferTime: '16:00', fridgeTransferCount: 3 },
      tracking: { mealCursor: hoursAgoMs(75) },
    })), 'iphone', 1]],
    ['sync', ['[]', 'iphone', 1]],
  ]);
  await differential([
    ['seed_state', [randomUUID(), JSON.stringify(seedDoc({
      stock: { fridge: 1, freezer: 4 },
      settings: { breakfastTime: '12:00', dinnerTime: '12:00', fridgeTransferTime: '12:00' },
      tracking: { mealCursor: hoursAgoMs(50) },
    })), 'iphone', 1]],
    ['sync', ['[]', 'iphone', 1]],
  ]);
});

test('behaviour: refusals are identical — outdated client, too many mutations, invalid seed, no cloud state', async () => {
  const { out } = await differential([
    ['sync', ['[]', 'iphone', 1]], // before any seed
    ['seed_state', [randomUUID(), JSON.stringify(seedDoc()), 'iphone', 0]],
    ['seed_state', [randomUUID(), '[]', 'iphone', 1]],
    ['seed_state', [randomUUID(), JSON.stringify(seedDoc()), 'iphone', 1]],
    ['sync', [JSON.stringify(Array.from({ length: 51 }, () => op('adjust', { key: 'fridge', delta: 1 }))), 'iphone', 1]],
    ['sync', ['{}', 'iphone', 1]],
    ['sync', ['[]', 'iphone', 0]],
  ]);
  assert.equal(out[0].ok.status, 'no-cloud-state');
  assert.deepEqual(out.slice(1).map((o) => o.error ? o.error.message : o.ok.status),
    ['client_outdated', 'invalid_seed', 'seeded', 'too_many_mutations', 'invalid_mutations', 'client_outdated']);
});

// ------------------------------------------------------------------------------------------- 3. WORK-287

test('WORK-287: with default settings each due 18:00 transfer runs exactly once, after Dinner, with no backfill', async () => {
  const uid = randomUUID();
  await db.neonAdmin.query('insert into dog_log.app_user (id) values ($1)', [uid]);
  const cursor = hoursAgoMs(80);
  await db.neon(uid, 'seed_state', [randomUUID(), JSON.stringify(seedDoc({ stock: { fridge: 10, freezer: 40 }, tracking: { mealCursor: cursor } })), 'iphone', 1]);
  await db.neon(uid, 'sync', ['[]', 'iphone', 1]);
  const [{ due, transfers, dinners, misordered, moved }] = await rows(db.neonAdmin, `
    with s as (select meal_tracking_since as since from dog_log.state where owner_id = $1),
    due as (select count(*)::int as n from s, generate_series((s.since at time zone 'Australia/Melbourne')::date,
              (now() at time zone 'Australia/Melbourne')::date, interval '1 day') d
            where (d::date + time '18:00') at time zone 'Australia/Melbourne' > s.since
              and (d::date + time '18:00') at time zone 'Australia/Melbourne' <= now())
    select (select n from due) as due,
      (select count(*)::int from dog_log.meal_events where owner_id = $1 and slot = 'transfer' and outcome = 'transferred') as transfers,
      (select count(*)::int from dog_log.meal_events where owner_id = $1 and slot = 'dinner' and origin = 'server') as dinners,
      (select count(*)::int from dog_log.meal_events t join dog_log.meal_events d
         on d.owner_id = t.owner_id and d.meal_date = t.meal_date and d.slot = 'dinner'
        where t.owner_id = $1 and t.slot = 'transfer' and t.slot_at <> d.slot_at) as misordered,
      (select coalesce(sum(freezer_to_fridge_count), 0)::int from dog_log.meal_events where owner_id = $1 and slot = 'transfer') as moved`, [uid]);
  assert.ok(due >= 3, `at least three 18:00 slots due in 80 hours (got ${due})`);
  assert.equal(transfers, due, 'one transfer per due day');
  assert.equal(dinners, due, 'one Dinner per due day');
  assert.equal(misordered, 0, 'transfer shares Dinner\'s time');
  assert.equal(moved, 2 * due, 'two Full Containers per default transfer');
  // A second sync and a second device add nothing.
  await db.neon(uid, 'sync', ['[]', 'desktop', 1]);
  const [{ n }] = await rows(db.neonAdmin, "select count(*)::int as n from dog_log.meal_events where owner_id = $1 and slot = 'transfer'", [uid]);
  assert.equal(n, transfers);
});

test('Melbourne DST: the meal engine places 09:00 correctly on both sides of DST start, identically on both backends', async () => {
  // Fixed historical dates, so the state row is written directly: seed_state clamps a cursor to the last 400 days.
  const uid = randomUUID();
  const doc = JSON.stringify({ stock: { fridge: 3, freezer: 2 } });
  const cursor = '2025-10-03 12:00 Australia/Melbourne';
  const until = '2025-10-06 12:00 Australia/Melbourne';
  await db.supaAdmin.query('insert into auth.users (id) values ($1)', [uid]);
  await db.neonAdmin.query('insert into dog_log.app_user (id) values ($1)', [uid]);
  const insert = 'insert into dog_log.state (owner_id, doc, seed_id, meal_cursor, meal_tracking_since) values ($1, $2, gen_random_uuid(), $3, $3)';
  await db.supaAdmin.query(insert, [uid, doc, cursor]);
  await db.neonAdmin.query(insert, [uid, doc, cursor]);
  await db.supaAdmin.query("select dog_log._process_due_meals($1, $2, 'dst')", [uid, until]);
  const c = await db.neonAdmin.connect();
  try {
    await c.query('begin');
    await c.query('select dog_log._bind_request_owner($1)', [uid]);
    await c.query("select dog_log._process_due_meals($1, $2, 'dst')", [uid, until]);
    await c.query('commit');
  } finally {
    c.release();
  }
  const EVENTS = "select meal_date::text, slot, outcome, source_container, slot_at, freezer_to_fridge_count from dog_log.meal_events where owner_id = $1 order by slot_at, slot";
  const neon = await rows(db.neonAdmin, EVENTS, [uid]);
  assert.deepEqual(neon, await rows(db.supaAdmin, EVENTS, [uid]));
  assert.deepEqual(normalise((await rows(db.neonAdmin, 'select doc from dog_log.state where owner_id = $1', [uid]))[0], RUN_START),
    normalise((await rows(db.supaAdmin, 'select doc from dog_log.state where owner_id = $1', [uid]))[0], RUN_START));
  assert.equal(neon.filter((e) => e.slot !== 'transfer').length, 6, 'Fri Dinner .. Mon Breakfast');
  assert.equal(neon.filter((e) => e.slot === 'transfer').length, 3, 'one transfer per day');
  const breakfast = (day) => neon.find((e) => e.meal_date === day && e.slot === 'breakfast').slot_at.toISOString();
  assert.equal(breakfast('2025-10-04'), '2025-10-03T23:00:00.000Z', '09:00 AEST (UTC+10)');
  assert.equal(breakfast('2025-10-05'), '2025-10-04T22:00:00.000Z', '09:00 AEDT (UTC+11)');
});

// ------------------------------------------------------------------------------------------- 4. security

test('security: the runtime role may execute only the three server entry points, despite hostile defaults', async () => {
  const [r] = await rows(db.neonAdmin, `select
    (select array_agg(p.proname::text order by p.proname) from pg_proc p where p.pronamespace = 'dog_log'::regnamespace
       and has_function_privilege('dog_log_runtime_test', p.oid, 'execute')) as executable,
    (select bool_or(has_table_privilege('dog_log_runtime_test', c.oid, priv)) from pg_class c,
       unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) priv
      where c.relnamespace = 'dog_log'::regnamespace and c.relkind = 'r') as any_table,
    (select bool_or(has_table_privilege('public', c.oid, 'select')) from pg_class c
      where c.relnamespace = 'dog_log'::regnamespace and c.relkind = 'r') as public_table,
    has_sequence_privilege('dog_log_runtime_test', 'dog_log.state_snapshots_id_seq', 'usage') as sequence,
    (select bool_or(has_function_privilege('public', p.oid, 'execute')) from pg_proc p where p.pronamespace = 'dog_log'::regnamespace) as public_execute,
    (select rolcanlogin from pg_roles where rolname = 'dog_log_api') as group_can_login`);
  assert.deepEqual(r, {
    executable: ['server_resolve_owner', 'server_seed_state', 'server_sync'],
    any_table: false, public_table: false, sequence: false, public_execute: false, group_can_login: false,
  });
  await assert.rejects(db.runtime.query('select * from dog_log.state'), { code: '42501' });
  await assert.rejects(db.runtime.query('update dog_log.state set revision = revision'), { code: '42501' });
  await assert.rejects(db.runtime.query("select dog_log._process_due_meals(gen_random_uuid(), now(), 'x')"), { code: '42501' });
  await assert.rejects(db.runtime.query("select dog_log._apply_op(gen_random_uuid(), '{}', now(), 1)"), { code: '42501' });
});

test('security: owners are isolated; a missing owner is refused; identities resolve only when linked', async () => {
  const a = randomUUID();
  const b = randomUUID();
  await db.neonAdmin.query('insert into dog_log.app_user (id) values ($1), ($2)', [a, b]);
  await db.neonAdmin.query("insert into dog_log.app_identity (provider, subject, user_id) values ('test', 'owner-a', $1)", [a]);
  await db.neon(a, 'seed_state', [randomUUID(), JSON.stringify(seedDoc({ stock: { fridge: 1 } })), 'a', 1]);
  await db.neon(b, 'seed_state', [randomUUID(), JSON.stringify(seedDoc({ stock: { fridge: 7 } })), 'b', 1]);
  const before = await rows(db.neonAdmin, 'select doc, revision from dog_log.state where owner_id = $1', [b]);
  const res = await db.neon(a, 'sync', [JSON.stringify([op('adjust', { key: 'fridge', delta: 5 })]), 'a', 1]);
  assert.equal(res.doc.stock.fridge, 6);
  assert.deepEqual(await rows(db.neonAdmin, 'select doc, revision from dog_log.state where owner_id = $1', [b]), before);
  const [{ resolved }] = await rows(db.runtime, "select dog_log.server_resolve_owner('test', 'owner-a') as resolved");
  assert.equal(resolved, a);
  const [{ unknown }] = await rows(db.runtime, "select dog_log.server_resolve_owner('test', 'nobody') as unknown");
  assert.equal(unknown, null);
  await assert.rejects(db.runtime.query("select dog_log.server_sync(null, '[]', 'x', 1)"), { code: '42501', message: 'not_authenticated' });
  await assert.rejects(db.runtime.query("select dog_log.server_seed_state(null, gen_random_uuid(), '{}', 'x', 1)"), { code: '42501', message: 'not_authenticated' });
});

test('security: the internal owner guard refuses an owner other than the bound request owner, per transaction', async () => {
  const a = randomUUID();
  const b = randomUUID();
  const c = await db.neonAdmin.connect();
  try {
    await c.query('begin');
    await c.query('select dog_log._bind_request_owner($1)', [a]);
    await assert.rejects(c.query("select dog_log._process_due_meals($1, now(), 'x')", [b]), { code: '42501', message: 'owner_mismatch' });
    await c.query('rollback');
    // The binding is transaction-local: a later transaction on the same connection sees no request owner.
    const [{ owner }] = (await c.query('select dog_log._request_owner() as owner')).rows;
    assert.equal(owner, null);
  } finally {
    c.release();
  }
});

// ---------------------------------------------------------------------------------------- 5. concurrency

test('concurrency: two devices syncing the same due meals at once deduct each meal exactly once', async () => {
  const uid = randomUUID();
  await db.neonAdmin.query('insert into dog_log.app_user (id) values ($1)', [uid]);
  await db.neon(uid, 'seed_state', [randomUUID(), JSON.stringify(seedDoc({ stock: { fridge: 5, freezer: 0 }, tracking: { mealCursor: hoursAgoMs(30) } })), 'seed', 1]);
  const first = await db.runtime.connect();
  try {
    await first.query('begin');
    const r1 = (await first.query("select dog_log.server_sync($1, '[]', 'desktop', 1) as result", [uid])).rows[0].result;
    // The second device waits on the owner's row lock, then finds nothing left to process.
    const second = db.runtime.query("select dog_log.server_sync($1, '[]', 'iphone', 1) as result", [uid]);
    await new Promise((r) => setTimeout(r, 500));
    await first.query('commit');
    const r2 = (await second).rows[0].result;
    assert.equal(r2.revision, r1.revision);
    const [{ devices, dupes }] = await rows(db.neonAdmin, `select string_agg(distinct processed_by_device, ',') as devices,
      (select count(*)::int from (select meal_date, slot from dog_log.meal_events where owner_id = $1 group by 1, 2 having count(*) > 1) d) as dupes
      from dog_log.meal_events where owner_id = $1 and origin = 'server'`, [uid]);
    assert.equal(devices, 'desktop');
    assert.equal(dupes, 0);
  } finally {
    first.release();
  }
});

test('concurrency: one mutation retried from two tabs at once applies once; a seed race keeps the first seed', async () => {
  const uid = randomUUID();
  await db.neonAdmin.query('insert into dog_log.app_user (id) values ($1)', [uid]);
  await db.neon(uid, 'seed_state', [randomUUID(), JSON.stringify(seedDoc({ stock: { freezer: 0 } })), 'seed', 1]);
  const m = JSON.stringify([op('adjust', { key: 'freezer', delta: 1 })]);
  const [x, y] = await Promise.all([db.neon(uid, 'sync', [m, 'tab1', 1]), db.neon(uid, 'sync', [m, 'tab2', 1])]);
  assert.deepEqual([x.results[0].status, y.results[0].status].sort(), ['applied', 'duplicate']);
  const [{ freezer }] = await rows(db.neonAdmin, "select (doc #>> '{stock,freezer}')::int as freezer from dog_log.state where owner_id = $1", [uid]);
  assert.equal(freezer, 1);

  const s = randomUUID();
  await db.neonAdmin.query('insert into dog_log.app_user (id) values ($1)', [s]);
  const results = await Promise.all([
    db.neon(s, 'seed_state', [randomUUID(), JSON.stringify(seedDoc({ stock: { fridge: 9 } })), 'iphone', 1]),
    db.neon(s, 'seed_state', [randomUUID(), JSON.stringify(seedDoc({ stock: { fridge: 0 } })), 'desktop', 1]),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['cloud-exists', 'seeded']);
  const winner = results.find((r) => r.status === 'seeded');
  const [{ fridge }] = await rows(db.neonAdmin, "select (doc #>> '{stock,fridge}')::int as fridge from dog_log.state where owner_id = $1", [s]);
  assert.equal(fridge, winner.state.doc.stock.fridge);
});

// ------------------------------------------------------------------------------------------- 6. rollback

test('rollback: refused while accounts or state exist; pre-adoption it removes the schema; the migration re-applies', async () => {
  const count = async () => (await rows(db.neonAdmin, 'select count(*)::int as n from dog_log.state'))[0].n;
  const before = await count();
  assert.ok(before > 0);
  assert.throws(() => pg.applyNeonRollback(), /rollback refused/);
  assert.equal(await count(), before, 'refused rollback changed nothing');
  await db.neonAdmin.query('delete from dog_log.app_user');
  pg.applyNeonRollback();
  const [gone] = await rows(db.neonAdmin, "select count(*)::int as schemas, (select count(*)::int from pg_roles where rolname = 'dog_log_api') as role from pg_namespace where nspname = 'dog_log'");
  assert.deepEqual(gone, { schemas: 0, role: 1 });
  pg.applyNeonMigration();
  const [{ n }] = await rows(db.runtime, "select count(*)::int as n from (select dog_log.server_resolve_owner('test', 'x')) s");
  assert.equal(n, 1, 're-applied schema is usable by the runtime role again');
});
