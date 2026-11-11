'use strict';
// WORK-274: the committed DEV schema-migration request files, checked against the governance
// backend-preflight tool, plus a duplicate-apply check of the migration on disposable local PostgreSQL.
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
const cluster = require('./lib/cluster');
const { clients } = require('./lib/clients');

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

test('duplicate apply: re-running the migration on a database that has it fails and changes nothing', async () => {
  const pg = cluster.start(Number(process.env.PGTEST_NEON_PREFLIGHT_PORT || 55494));
  const db = clients(pg);
  try {
    const fingerprint = async () => (await db.neonAdmin.query(`select md5(string_agg(x, '|' order by x)) as f from (
        select 'c:' || c.relname || ':' || c.relkind::text from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'dog_log'
        union all select 'f:' || p.oid::regprocedure::text || ':' || md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'dog_log'
        union all select 'r:' || rolname from pg_roles where rolname = 'dog_log_api') s(x)`)).rows[0].f;
    const before = await fingerprint();
    assert.match(before, /^[0-9a-f]{32}$/);
    assert.throws(() => pg.applyNeonMigration(), /already exists/);
    assert.equal(await fingerprint(), before, 'the refused second apply left the schema, functions and role exactly as they were');
  } finally {
    await db.end();
    pg.stop();
  }
});
