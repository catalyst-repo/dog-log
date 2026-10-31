// Local stand-in for the google-calendar Apps Script bridge (automations/dannys_calendar/DogLog.gs), answering the
// same CORS-readable JSON the deployed web app returns. It never contacts Google.
//   - pair: first token wins; a different token gets already_paired (open: true accepts every token).
//   - sync: three owned milestone events (oneWeek -7d, oneDay -1d, runout 0d) with stable event ids per milestone.
//   - clear: deletes the owned events, or noop when there are none.
// queue entries inject one reply each, in order: { status, raw } for a raw HTTP reply, { json } for a JSON body,
// { hold } (a promise) to delay the reply, { hang: true } to never answer.
const CORS = { 'access-control-allow-origin': '*' };
const MILESTONES = [['oneWeek', 7], ['oneDay', 1], ['runout', 0]];

function shift(date, days) {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

class CalendarBridge {
  constructor({ open = false, token = null } = {}) {
    this.open = open;
    this.digest = token;   // the paired token (the real bridge stores only its SHA-256 digest)
    this.posts = [];       // parsed request bodies, in arrival order
    this.queue = [];
    this.events = {};      // milestone -> { id, date }
    this.inflight = 0;
    this.maxInflight = 0;
  }

  reply(b) {
    if (b.action === 'pair') {
      if (!b.token || String(b.token).length < 32) return { ok: false, error: 'token_too_short' };
      if (!this.open && this.digest && this.digest !== b.token) return { ok: false, error: 'already_paired' };
      if (!this.digest) this.digest = b.token;
      return { ok: true, paired: true };
    }
    if (!this.open && (!this.digest || b.token !== this.digest)) return { ok: false, error: 'unauthorized' };
    if (b.action === 'clear') {
      const deleted = Object.keys(this.events).length;
      this.events = {};
      return { ok: true, action: deleted ? 'delete' : 'noop', deleted };
    }
    if (b.action === 'sync') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date || ''))) return { ok: false, error: 'invalid_request', detail: 'date must be YYYY-MM-DD' };
      const milestones = {};
      for (const [k, n] of MILESTONES) {
        const date = shift(b.date, -n);
        const cur = this.events[k];
        const action = !cur ? 'create' : cur.date === date ? 'noop' : 'update';
        this.events[k] = { id: cur ? cur.id : `evt-${k}`, date };
        milestones[k] = { action, eventId: this.events[k].id, date };
      }
      return { ok: true, milestones, runoutDate: b.date };
    }
    return { ok: false, error: 'unsupported_action' };
  }

  async handle(route) {
    let body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) { /* recorded as {} */ }
    this.posts.push(body);
    this.inflight++;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
    try {
      const next = this.queue.shift();
      if (next && next.hang) return await new Promise(() => {});
      if (next && next.hold) await next.hold;
      if (next && (next.status || next.raw !== undefined)) return await route.fulfill({ status: next.status || 200, headers: CORS, body: next.raw || '' });
      const json = next && next.json ? next.json : this.reply(body);
      return await route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(json) });
    } catch (e) {
      // The page may have closed or aborted the request (timeout test); nothing to answer.
    } finally {
      this.inflight--;
    }
  }
}

module.exports = { CalendarBridge, shift };
