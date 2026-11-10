'use strict';
// Database clients for the WORK-274 Neon tests: the Supabase reference end-state called the way the
// browser calls it today (role authenticated, a JWT subject, the seed_state / sync RPCs), and the Neon
// schema called the way the server API calls it (a login member of dog_log_api, the server_* functions).
const { Pool } = require('pg');

const RPC = {
  seed_state: { supa: 'select dog_log.seed_state($1, $2, $3, $4) as result', neon: 'select dog_log.server_seed_state($1, $2, $3, $4, $5) as result' },
  sync: { supa: 'select dog_log.sync($1, $2, $3) as result', neon: 'select dog_log.server_sync($1, $2, $3, $4) as result' },
};

function clients(cluster) {
  const supaAdmin = new Pool({ ...cluster.config('supa'), max: 4 });
  const neonAdmin = new Pool({ ...cluster.config('neon'), max: 4 });
  const runtime = new Pool({ ...cluster.config('neon', 'dog_log_runtime_test'), max: 4 });

  // One Supabase RPC as an authenticated user, in its own transaction (as PostgREST runs it).
  async function supa(uid, fn, args) {
    const c = await supaAdmin.connect();
    try {
      await c.query('begin');
      await c.query('set local role authenticated');
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: 'authenticated' })]);
      const r = await c.query(RPC[fn].supa, args);
      await c.query('commit');
      return r.rows[0].result;
    } catch (e) {
      await c.query('rollback').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  // The same call on Neon: the owner is passed by the server, as server/api.js does after verifying a session.
  async function neon(uid, fn, args) {
    const r = await runtime.query(RPC[fn].neon, [uid, ...args]);
    return r.rows[0].result;
  }

  // A synthetic account on both sides with the same id.
  async function createUser(uid) {
    await supaAdmin.query('insert into auth.users (id, email) values ($1, $2)', [uid, `${uid}@test.invalid`]);
    await neonAdmin.query('insert into dog_log.app_user (id) values ($1)', [uid]);
  }

  async function end() {
    await Promise.all([supaAdmin.end(), neonAdmin.end(), runtime.end()]);
  }

  return { supaAdmin, neonAdmin, runtime, supa, neon, createUser, end };
}

// Everything derived from the transaction clock differs between two databases by milliseconds, so it is
// replaced before comparing: ISO timestamps within the run window, and the purely clock-valued keys.
const CLOCK_KEYS = new Set(['server_now', 'processed_at', 'applied_at', 'taken_at', 'created_at', 'updated_at']);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
function normalise(value, since) {
  const from = since - 120000;
  const to = Date.now() + 120000;
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v instanceof Date) return v.getTime() >= from && v.getTime() <= to ? '<clock>' : v.toISOString();
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v).sort()) o[k] = CLOCK_KEYS.has(k) ? '<clock>' : walk(v[k]);
      return o;
    }
    if (typeof v === 'string' && ISO.test(v)) {
      const t = Date.parse(v);
      if (t >= from && t <= to) return '<clock>';
    }
    return v;
  };
  return walk(value);
}

module.exports = { clients, normalise };
