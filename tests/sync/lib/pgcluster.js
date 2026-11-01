// Disposable local PostgreSQL for the sync tests: loads the local Supabase stub and the real dog_log
// migration, so the tests exercise the exact server functions the app talks to. Never touches Supabase.
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SUPA = path.resolve(__dirname, '../../../supabase');
const MIGRATIONS = [
  path.join(SUPA, 'migrations/20260924225253_dog_log_create_sync_schema.sql'),
  path.join(SUPA, 'migrations/20260926005200_dog_log_add_evening_freezer_transfer.sql'),
  path.join(SUPA, 'migrations/20260926130000_dog_log_configurable_food_schedule.sql'),
  path.join(SUPA, 'migrations/20261031213557_dog_log_fix_equal_time_transfer.sql'),
];
const STUB = path.join(SUPA, 'tests/local/supabase_stub.sql');

function binDir() {
  if (process.env.PG_BINDIR) return process.env.PG_BINDIR;
  try { return execFileSync('pg_config', ['--bindir']).toString().trim(); } catch (e) { /* fall through */ }
  const base = '/usr/lib/postgresql';
  const v = fs.existsSync(base) ? fs.readdirSync(base).sort((a, b) => b - a)[0] : null;
  if (!v) throw new Error('PostgreSQL 15+ server binaries not found; set PG_BINDIR');
  return path.join(base, v, 'bin');
}

// Where the cluster listens. Unix: a private socket directory with no TCP listener. Windows: node-postgres cannot use a
// C:\ path as a socket host, so the cluster listens on loopback TCP only. DOGLOG_PG_TCP=1 selects loopback TCP on any
// platform (so the Windows connection path can be exercised on Linux as well).
const TCP = process.platform === 'win32' || process.env.DOGLOG_PG_TCP === '1';
const LOOPBACK = '127.0.0.1';

// initdb refuses to run as root; in a root container run the server as "nobody".
// opts.stdio 'ignore' runs the command with no inherited pipes (used for pg_ctl start, below).
function run(cmd, args, opts = {}) {
  const root = process.getuid && process.getuid() === 0;
  const spawnOpts = { encoding: 'utf8', ...(opts.stdio ? { stdio: opts.stdio } : {}) };
  const r = root
    ? spawnSync('su', ['nobody', '-s', '/bin/sh', '-c', [cmd, ...args].map(a => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')], spawnOpts)
    : spawnSync(cmd, args, spawnOpts);
  if (r.error || r.status !== 0) throw new Error(`${cmd} failed: ${r.error ? r.error.message : (r.stderr || r.stdout || `exit ${r.status}`)}`);
  return r.stdout;
}

function logTail(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(-20).join('\n'); } catch (e) { return '(no server log)'; }
}

function start(port) {
  const bin = binDir();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'doglog-pg-'));
  const data = path.join(work, 'data'), log = path.join(work, 'log');
  const host = TCP ? LOOPBACK : work;
  const pgctl = (args, opts) => run(path.join(bin, 'pg_ctl'), ['-D', data, ...args], opts);
  const stop = () => { try { pgctl(['-m', 'immediate', 'stop']); } catch (e) { /* not running */ } fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); };
  try {
    fs.chmodSync(work, 0o777);
    for (const f of [STUB, ...MIGRATIONS]) { fs.copyFileSync(f, path.join(work, path.basename(f))); fs.chmodSync(path.join(work, path.basename(f)), 0o644); }
    run(path.join(bin, 'initdb'), ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8']);
    // Unix keeps its socket in the private work directory (never the system default); on Windows no -k is passed.
    const listen = TCP
      ? `-c listen_addresses=${LOOPBACK}` + (process.platform === 'win32' ? '' : ` -k ${work}`)
      : `-k ${work} -c listen_addresses=''`;
    // The started server would inherit any pipes pg_ctl was given and hold them open, so with piped stdio spawnSync
    // never returns on Windows. Start with no inherited stdio; -w waits for readiness and the server logs to -l.
    try {
      pgctl(['-o', `-p ${port} ${listen}`, '-l', log, '-w', 'start'], { stdio: 'ignore' });
    } catch (e) {
      throw new Error(`${e.message}\nPostgreSQL server log (${log}):\n${logTail(log)}`);
    }
    const psql = (file) => run(path.join(bin, 'psql'), ['-h', host, '-p', String(port), '-U', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-f', path.join(work, path.basename(file))]);
    psql(STUB);
    for (const migration of MIGRATIONS) psql(migration);
  } catch (e) {
    stop(); // never leave a half-started cluster or its temporary directory behind
    throw e;
  }
  return { host, port, stop };
}

module.exports = { start };
