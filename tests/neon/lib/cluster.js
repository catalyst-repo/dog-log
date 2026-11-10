'use strict';
// Disposable local PostgreSQL for the WORK-274 Neon tests. One throwaway cluster holds two databases:
//   supa — the local Supabase stub plus the four live Supabase migrations (the reference end-state);
//   neon — the portable Neon schema only, with no Supabase stub at all.
// It never contacts Supabase or Neon. Same platform handling as tests/sync/lib/pgcluster.js (WORK-286).
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../..');
const SUPA = path.join(ROOT, 'supabase');
const SUPABASE_FILES = [
  path.join(SUPA, 'tests/local/supabase_stub.sql'),
  path.join(SUPA, 'migrations/20260924225253_dog_log_create_sync_schema.sql'),
  path.join(SUPA, 'migrations/20260926005200_dog_log_add_evening_freezer_transfer.sql'),
  path.join(SUPA, 'migrations/20260926130000_dog_log_configurable_food_schedule.sql'),
  path.join(SUPA, 'migrations/20261031213557_dog_log_fix_equal_time_transfer.sql'),
];
const NEON_MIGRATION = path.join(ROOT, 'neon/migrations/20261110120000_dog_log_portable_schema.sql');
const NEON_ROLLBACK = path.join(ROOT, 'neon/rollbacks/20261110120000_dog_log_portable_schema.rollback.sql');

// Hostile global defaults, as in the Supabase stub: every new table and function would be granted to PUBLIC.
// The tests prove the migration's explicit revokes still hold.
const HOSTILE_DEFAULTS = [
  'alter default privileges grant all on tables to public;',
  'alter default privileges grant all on sequences to public;',
  'alter default privileges grant execute on functions to public;',
].join('\n');

function binDir() {
  if (process.env.PG_BINDIR) return process.env.PG_BINDIR;
  try { return execFileSync('pg_config', ['--bindir']).toString().trim(); } catch (e) { /* fall through */ }
  const base = '/usr/lib/postgresql';
  const v = fs.existsSync(base) ? fs.readdirSync(base).sort((a, b) => b - a)[0] : null;
  if (!v) throw new Error('PostgreSQL 15+ server binaries not found; set PG_BINDIR');
  return path.join(base, v, 'bin');
}

const TCP = process.platform === 'win32' || process.env.DOGLOG_PG_TCP === '1';
const LOOPBACK = '127.0.0.1';

// initdb refuses to run as root; in a root container run the server tools as "nobody".
function run(cmd, args, opts = {}) {
  const root = process.getuid && process.getuid() === 0;
  const spawnOpts = { encoding: 'utf8', ...(opts.stdio ? { stdio: opts.stdio } : {}) };
  const r = root
    ? spawnSync('su', ['nobody', '-s', '/bin/sh', '-c', [cmd, ...args].map(a => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')], spawnOpts)
    : spawnSync(cmd, args, spawnOpts);
  if (r.error || r.status !== 0) throw new Error(`${cmd} failed: ${r.error ? r.error.message : (r.stderr || r.stdout || `exit ${r.status}`)}`);
  return r.stdout;
}

function start(port) {
  const bin = binDir();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'doglog-neon-'));
  const data = path.join(work, 'data');
  const log = path.join(work, 'log');
  const host = TCP ? LOOPBACK : work;
  const pgctl = (args, opts) => run(path.join(bin, 'pg_ctl'), ['-D', data, ...args], opts);
  const stop = () => {
    try { pgctl(['-m', 'immediate', 'stop']); } catch (e) { /* not running */ }
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  // psql reads files as the server user, so each one is copied into the world-readable work directory.
  const local = (file) => {
    const dest = path.join(work, path.basename(file));
    if (!fs.existsSync(dest)) { fs.copyFileSync(file, dest); fs.chmodSync(dest, 0o644); }
    return dest;
  };
  const psqlArgs = (db) => ['-h', host, '-p', String(port), '-U', 'postgres', '-d', db, '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
  const psqlFile = (db, file, single = true) =>
    run(path.join(bin, 'psql'), [...psqlArgs(db), ...(single ? ['--single-transaction'] : []), '-f', local(file)]);
  const psqlSql = (db, sql) => run(path.join(bin, 'psql'), [...psqlArgs(db), '-c', sql]);
  try {
    fs.chmodSync(work, 0o777);
    run(path.join(bin, 'initdb'), ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8']);
    const listen = TCP
      ? `-c listen_addresses=${LOOPBACK}` + (process.platform === 'win32' ? '' : ` -k ${work}`)
      : `-k ${work} -c listen_addresses=''`;
    pgctl(['-o', `-p ${port} ${listen}`, '-l', log, '-w', 'start'], { stdio: 'ignore' });
    psqlSql('postgres', 'create database supa');
    psqlSql('postgres', 'create database neon');
    for (const f of SUPABASE_FILES) psqlFile('supa', f);
    psqlSql('neon', HOSTILE_DEFAULTS);
    psqlFile('neon', NEON_MIGRATION);
    // The runtime credential's stand-in: a login member of the NOLOGIN group role (no password, local trust only).
    psqlSql('neon', 'create role dog_log_runtime_test login in role dog_log_api');
  } catch (e) {
    stop();
    throw e;
  }
  return {
    host, port, stop,
    applyNeonMigration: () => psqlFile('neon', NEON_MIGRATION),
    // The rollback file carries its own begin/commit, so it runs without --single-transaction.
    applyNeonRollback: () => psqlFile('neon', NEON_ROLLBACK, false),
    config: (database, user = 'postgres') => ({ host, port, user, database }),
  };
}

module.exports = { start, NEON_MIGRATION, NEON_ROLLBACK };
