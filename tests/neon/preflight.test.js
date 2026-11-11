'use strict';
// WORK-274: the committed DEV schema-migration request files, checked against the governance
// backend-preflight tool, and the migration's applied-history ledger, checked on disposable local
// PostgreSQL: the change id commits atomically with the schema, a second apply is refused, the rollback
// removes the record with the schema, and only a real ledger read from the right target verifies.
//
// Nothing here contacts Neon, Supabase or any provider. Every "observation" below is a SYNTHETIC Neon
// branch read built from the declared ids. It proves the request files are shaped correctly and that the
// tool refuses the wrong cases; it is never evidence that a real DEV preflight has passed.
//
// The backend-preflight tool lives in the governance repository. Set CATALYST_GOVERNANCE_DIR to a
// checkout of it (for example a worktree of catalyst-repo/governance main); without it those tests skip.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Pool } = require('pg');
const cluster = require('./lib/cluster');

const ROOT = path.resolve(__dirname, '..', '..');
const MANIFEST = path.join(ROOT, '.catalyst/app.yml');
const REQUESTS = path.join(ROOT, 'neon/preflight');
const PREFLIGHT = path.join(REQUESTS, '20261110120000_dog_log_portable_schema.dev.preflight.json');
const VERIFY = path.join(REQUESTS, '20261110120000_dog_log_portable_schema.dev.verify-applied.json');
const CHANGE = '20261110120000_dog_log_portable_schema';

// The declared Dog Log Neon boundary (.catalyst/app.yml), from the operator's Neon Console.
const PROJECT = 'proud-leaf-63550349';
const DEV = { name: 'dev', id: 'br-wispy-cell-a7tpzt7c' };
const MAIN = { name: 'main', id: 'br-muddy-smoke-a7tg6nwc' };

const GOV = process.env.CATALYST_GOVERNANCE_DIR;
const TOOL = GOV && path.join(GOV, 'governance-v2/scripts/backend-preflight.js');
const skip = !TOOL || !fs.existsSync(TOOL)
  ? 'set CATALYST_GOVERNANCE_DIR to a catalyst-repo/governance checkout to run the backend-preflight checks'
  : false;

const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
// A SYNTHETIC Neon branch read (the shape of describe_branch), never a provider observation.
const synthetic = (branch, project = PROJECT) => ({ adapter: 'neon', raw: { id: branch.id, name: branch.name, project_id: project } });

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'doglog-preflight-'));
test.after(() => fs.rmSync(work, { recursive: true, force: true }));
let n = 0;
function run(cmd, request) {
  const file = path.join(work, `request-${++n}.json`);
  fs.writeFileSync(file, JSON.stringify(request));
  const r = spawnSync(process.execPath, [TOOL, cmd, file, '--manifest', MANIFEST], { encoding: 'utf8' });
  return { status: r.status, out: JSON.parse(r.stdout) };
}
const codes = (out) => out.reasons.map((x) => x.code).sort();
const preflight = (patch) => run('preflight', { ...read(PREFLIGHT), ...patch });
const withExpected = (patch, observed) => preflight({ expected: { ...read(PREFLIGHT).expected, ...patch }, observed });
const verify = (patch) => run('verify-applied', { ...read(VERIFY), ...patch });

// ------------------------------------------------------------------ the committed request files

test('requests: as committed, preflight refuses dev only for the missing provider observation', { skip }, () => {
  const { status, out } = preflight({});
  assert.equal(status, 1);
  assert.equal(out.decision, 'refuse');
  assert.deepEqual(codes(out), ['no-observation']);
  assert.equal(out.role, 'dev');
  assert.equal(out.requiresClearance, false);
});

test('requests: the verify-applied target is exactly the binding preflight returns for dev', { skip }, () => {
  const { status, out } = preflight({ observed: synthetic(DEV) });
  assert.equal(status, 0, 'a synthetic read of the declared dev branch allows the request shape');
  assert.equal(out.decision, 'allow');
  assert.deepEqual(out.binding, read(VERIFY).target);
  assert.equal(out.binding.targetId, DEV.id);
  assert.equal(out.binding.change, CHANGE);
});

test('requests: as committed, verify-applied holds no evidence and says so', { skip }, () => {
  const { status, out } = verify({});
  assert.equal(status, 1);
  assert.equal(out.verdict, 'insufficient-evidence');
  assert.deepEqual(codes(out), ['no-observation']);
});

// ------------------------------------------------------------------ wrong project, branch or environment

test('preflight: an observation from another project is refused', { skip }, () => {
  const { status, out } = preflight({ observed: synthetic(DEV, 'some-other-project-12345678') });
  assert.equal(status, 1);
  assert.ok(codes(out).includes('project-mismatch'));
});

test('preflight: an expected project other than the declared one is refused', { skip }, () => {
  const { status, out } = withExpected({ project: 'some-other-project-12345678' }, synthetic(DEV));
  assert.equal(status, 1);
  assert.deepEqual(codes(out), ['project-mismatch']);
});

test('preflight: a read of the wrong branch never stands in for dev', { skip }, () => {
  for (const observed of [synthetic(MAIN), synthetic({ name: 'dev', id: MAIN.id }), synthetic({ name: 'dev', id: 'br-not-the-declared-dev' })]) {
    const { status, out } = preflight({ observed });
    assert.equal(status, 1);
    assert.ok(codes(out).includes('target-mismatch'), JSON.stringify(observed));
  }
});

test('preflight: the same change aimed at main (Production) is refused without DEV proof, rollback and clearance', { skip }, () => {
  const { status, out } = withExpected({ target: 'main' }, synthetic(MAIN));
  assert.equal(status, 1);
  assert.equal(out.role, 'prod');
  assert.equal(out.requiresClearance, true);
  assert.deepEqual(codes(out), ['clearance-required', 'dev-not-verified', 'no-rollback']);
});

test('preflight: role and environment words are never target names', { skip }, () => {
  for (const target of ['prod', 'production']) {
    const { status, out } = withExpected({ target }, synthetic(DEV));
    assert.equal(status, 1);
    assert.deepEqual(codes(out), ['reserved-target-name']);
  }
});

test('preflight: the wrong app or provider is refused', { skip }, () => {
  assert.ok(codes(withExpected({ app: 'another-app' }, synthetic(DEV)).out).includes('app-mismatch'));
  assert.ok(codes(withExpected({ provider: 'supabase' }, synthetic(DEV)).out).includes('provider-mismatch'));
  const supabaseRead = { adapter: 'supabase', raw: { id: PROJECT } };
  assert.ok(codes(preflight({ observed: supabaseRead }).out).includes('provider-mismatch'));
});

test('preflight: a schema migration without its change id is refused', { skip }, () => {
  const { status, out } = preflight({ change: undefined, observed: synthetic(DEV) });
  assert.equal(status, 1);
  assert.deepEqual(codes(out), ['no-change-id']);
});

// ------------------------------------------------------------------ applied state and duplicate apply

test('verify-applied: dev history without the change is unverified; missing history is insufficient', { skip }, () => {
  const readAt = new Date().toISOString();
  let r = verify({ observed: synthetic(DEV), applied: [], readAt });
  assert.equal(r.status, 1);
  assert.equal(r.out.verdict, 'unverified');
  assert.deepEqual(codes(r.out), ['not-applied']);
  r = verify({ observed: synthetic(DEV), applied: null, readAt });
  assert.equal(r.out.verdict, 'insufficient-evidence');
  assert.deepEqual(codes(r.out), ['no-applied-history']);
});

test('verify-applied: evidence read from main never verifies the dev target', { skip }, () => {
  const { status, out } = verify({ observed: synthetic(MAIN), applied: [CHANGE], readAt: new Date().toISOString() });
  assert.equal(status, 1);
  assert.equal(out.verdict, 'insufficient-evidence');
  assert.deepEqual(codes(out), ['evidence-wrong-target']);
});

test('duplicate apply: a dev history that already holds the change verifies, so the change must not be applied again', { skip }, () => {
  const { status, out } = verify({ observed: synthetic(DEV), applied: [CHANGE], readAt: new Date().toISOString() });
  assert.equal(status, 0);
  assert.equal(out.verdict, 'verified');
  assert.equal(out.binding.targetId, DEV.id);
});

// ------------------------------------------------------------------ applied history on local PostgreSQL
//
// The real migration and rollback files run on disposable local databases with the same hostile default
// privileges as the other Neon tests. The ledger is read with the request file's own $appliedFrom query,
// exactly as an executor reads it on dev.

let cl;
const pools = new Map();
test.before(() => { cl = cluster.start(Number(process.env.PGTEST_NEON_PREFLIGHT_PORT || 55494)); });
test.after(async () => {
  for (const p of pools.values()) await p.end();
  if (cl) cl.stop();
});
const pool = (db) => {
  if (!pools.has(db)) pools.set(db, new Pool({ ...cl.config(db), max: 2 }));
  return pools.get(db);
};
const one = async (db, sql) => (await pool(db).query(sql)).rows[0];
let dbs = 0;
// An empty database with the hostile defaults: a dev branch with nothing applied.
function emptyDb() {
  const name = `hist_${++dbs}`;
  cl.sql('postgres', `create database ${name}`);
  cl.sql(name, cl.hostileDefaults);
  return name;
}
function appliedDb() {
  const name = emptyDb();
  cl.applyFile(name, cluster.NEON_MIGRATION);
  return name;
}
// The ledger as the executor reads it: the $appliedFrom versions, or null when there is no ledger.
async function history(db) {
  const { reg } = await one(db, "select to_regclass('dog_log_migrations.schema_migrations')::text as reg");
  if (!reg) return null;
  return (await pool(db).query(read(VERIFY).$appliedFrom)).rows.map((r) => r.version);
}
const hasSchema = async (db, name) => (await one(db, `select count(*)::int as n from pg_namespace where nspname = '${name}'`)).n === 1;
// The migration with one failing statement injected just before its final commit, after the history insert.
function failingCopy() {
  const sql = fs.readFileSync(cluster.NEON_MIGRATION, 'utf8');
  const at = sql.lastIndexOf('\ncommit;');
  assert.ok(at > sql.lastIndexOf('insert into dog_log_migrations.schema_migrations'), 'the failure is injected after the history insert');
  const file = path.join(work, 'migration-with-late-failure.sql');
  fs.writeFileSync(file, `${sql.slice(0, at)}\nselect 1 / 0; -- injected failure after the history insert\n${sql.slice(at)}`);
  return file;
}
const verifyWith = async (db, observed, patch = {}) =>
  verify({ observed, applied: await history(db), readAt: new Date().toISOString(), ...patch });

test('history: a successful apply records exactly its change id, and only the owner can reach the ledger', async () => {
  const db = appliedDb();
  assert.deepEqual(await history(db), [CHANGE]);
  const r = await one(db, `select
      (select count(*)::int from dog_log_migrations.schema_migrations where applied_at is not null) as stamped,
      has_schema_privilege('public', 'dog_log_migrations', 'usage') as public_usage,
      has_table_privilege('public', 'dog_log_migrations.schema_migrations', 'select') as public_select,
      has_table_privilege('dog_log_api', 'dog_log_migrations.schema_migrations', 'select') as api_select,
      has_table_privilege('dog_log_api', 'dog_log_migrations.schema_migrations', 'insert') as api_insert`);
  assert.deepEqual(r, { stamped: 1, public_usage: false, public_select: false, api_select: false, api_insert: false });
});

test('history: a failure after the history insert rolls back the schema and the record together', async () => {
  const db = emptyDb();
  assert.throws(() => cl.applyFile(db, failingCopy()), /division by zero/);
  assert.equal(await hasSchema(db, 'dog_log'), false, 'no dog_log schema survives');
  assert.equal(await hasSchema(db, 'dog_log_migrations'), false, 'no ledger survives');
  assert.equal(await history(db), null);
});

test('history: an already-recorded change blocks the apply, which leaves no partial schema', async () => {
  const db = emptyDb();
  cl.sql(db, `create schema dog_log_migrations;
    create table dog_log_migrations.schema_migrations (version text primary key, applied_at timestamptz not null default now());
    insert into dog_log_migrations.schema_migrations (version) values ('${CHANGE}');`);
  assert.throws(() => cl.applyFile(db, cluster.NEON_MIGRATION), /schema_migrations_pkey/);
  assert.equal(await hasSchema(db, 'dog_log'), false, 'the refused apply left no dog_log schema');
  assert.deepEqual(await history(db), [CHANGE], 'the ledger is exactly as it was');
});

test('history: re-applying on a target that has the change fails at once and changes nothing', async () => {
  const db = appliedDb();
  const fingerprint = async () => (await one(db, `select md5(string_agg(x, '|' order by x)) as f from (
      select 'c:' || n.nspname || '.' || c.relname || ':' || c.relkind::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('dog_log', 'dog_log_migrations')
      union all select 'f:' || p.oid::regprocedure::text || ':' || md5(pg_get_functiondef(p.oid)) from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'dog_log'
      union all select 'h:' || version || ':' || applied_at::text from dog_log_migrations.schema_migrations) s(x)`)).f;
  const before = await fingerprint();
  assert.match(before, /^[0-9a-f]{32}$/);
  assert.throws(() => cl.applyFile(db, cluster.NEON_MIGRATION), /already exists/);
  assert.equal(await fingerprint(), before, 'schema, functions and ledger exactly as they were');
  assert.deepEqual(await history(db), [CHANGE], 'still recorded exactly once');
});

test('history: the rollback removes the record with the schema; a refused rollback keeps both', async () => {
  const db = appliedDb();
  await pool(db).query('insert into dog_log.app_user (id) values (gen_random_uuid())');
  assert.throws(() => cl.applyFile(db, cluster.NEON_ROLLBACK), /rollback refused: dog_log holds/);
  assert.equal(await hasSchema(db, 'dog_log'), true);
  assert.deepEqual(await history(db), [CHANGE]);
  await pool(db).query('delete from dog_log.app_user');
  cl.applyFile(db, cluster.NEON_ROLLBACK);
  assert.equal(await hasSchema(db, 'dog_log'), false);
  assert.deepEqual(await history(db), [], 'the ledger stays, without the rolled-back change');
  cl.applyFile(db, cluster.NEON_MIGRATION);
  assert.deepEqual(await history(db), [CHANGE], 're-applying records the change again');
});

test('history: a rollback refuses when the change is not recorded, and changes nothing', async () => {
  const db = appliedDb();
  await pool(db).query(`delete from dog_log_migrations.schema_migrations where version = '${CHANGE}'`);
  assert.throws(() => cl.applyFile(db, cluster.NEON_ROLLBACK), /not recorded in dog_log_migrations/);
  assert.equal(await hasSchema(db, 'dog_log'), true, 'the schema is still there');
});

// ------------------------------------------------------------------ verify-applied over a real ledger read

test('verify-applied: the ledger read from an applied dev database verifies the change', { skip }, async () => {
  const { status, out } = await verifyWith(appliedDb(), synthetic(DEV));
  assert.equal(status, 0);
  assert.equal(out.verdict, 'verified');
  assert.equal(out.binding.targetId, DEV.id);
});

test('verify-applied: no ledger, a failed apply or a rolled-back change never verifies', { skip }, async () => {
  let r = await verifyWith(emptyDb(), synthetic(DEV));
  assert.equal(r.out.verdict, 'insufficient-evidence');
  assert.deepEqual(codes(r.out), ['no-applied-history']);
  const failed = emptyDb();
  assert.throws(() => cl.applyFile(failed, failingCopy()), /division by zero/);
  r = await verifyWith(failed, synthetic(DEV));
  assert.deepEqual(codes(r.out), ['no-applied-history']);
  const rolled = appliedDb();
  cl.applyFile(rolled, cluster.NEON_ROLLBACK);
  r = await verifyWith(rolled, synthetic(DEV));
  assert.equal(r.status, 1);
  assert.equal(r.out.verdict, 'unverified');
  assert.deepEqual(codes(r.out), ['not-applied']);
});

test('verify-applied: a real ledger with the wrong target identity never verifies', { skip }, async () => {
  const db = appliedDb();
  for (const observed of [synthetic(MAIN), synthetic({ name: 'dev', id: MAIN.id }), synthetic(DEV, 'some-other-project-12345678')]) {
    const { status, out } = await verifyWith(db, observed);
    assert.equal(status, 1);
    assert.deepEqual(codes(out), ['evidence-wrong-target'], JSON.stringify(observed));
  }
});

test('false Production verification: DEV history never verifies main, and DEV proof alone never authorises it', { skip }, async () => {
  const db = appliedDb();
  const toMain = { expected: { ...read(PREFLIGHT).expected, target: 'main' }, observed: synthetic(MAIN) };
  const prodBinding = preflight(toMain).out.binding;
  assert.equal(prodBinding.role, 'prod');
  const asProd = await verifyWith(db, synthetic(DEV), { target: prodBinding });
  assert.equal(asProd.status, 1);
  assert.deepEqual(codes(asProd.out), ['evidence-wrong-target']);
  const devProof = await verifyWith(db, synthetic(DEV));
  assert.equal(devProof.out.verdict, 'verified');
  const { status, out } = preflight({ ...toMain, devEvidence: devProof.out });
  assert.equal(status, 1);
  assert.equal(out.requiresClearance, true);
  assert.deepEqual(codes(out), ['clearance-required', 'no-rollback'], 'DEV proof is accepted, but main still needs its rollback path and Production clearance');
});
