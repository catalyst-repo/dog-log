const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// WORK-282: a bridge reply verifies the desired calendar state only when it names all three milestone events
// on the dates the bridge derives from the run-out date (oneWeek -7d, oneDay -1d, runout 0d).
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
const pick = re => { const m = html.match(re); assert.ok(m, `${re} must remain extractable from index.html`); return m[0]; };
const context = {};
vm.createContext(context);
vm.runInContext([pick(/const CAL_TIMEOUT=[^\n]+/), pick(/function calShift\(date,days\)\{[^\n]+\}/), pick(/function calVerify\(want,body\)\{[^\n]+\}/), 'this.calShift = calShift; this.calVerify = calVerify;'].join('\n'), context);
const { calShift, calVerify } = context;

const want = { action: 'sync', date: '2026-12-12', preparedContainers: 83, containersPerDay: 2, finalMeal: 'Dinner' };
function reply(date = want.date, over = {}) {
  return { ok: true, runoutDate: date, milestones: {
    oneWeek: { action: 'noop', eventId: 'a', date: calShift(date, -7) },
    oneDay: { action: 'noop', eventId: 'b', date: calShift(date, -1) },
    runout: { action: 'noop', eventId: 'c', date },
    ...over,
  } };
}

test('calShift matches the bridge across month, year and Melbourne daylight-saving boundaries', () => {
  assert.equal(calShift('2026-12-12', -7), '2026-12-05');
  assert.equal(calShift('2026-12-12', -1), '2026-12-11');
  assert.equal(calShift('2027-01-03', -7), '2026-12-27');
  assert.equal(calShift('2026-03-01', -1), '2026-02-28');
  assert.equal(calShift('2028-03-01', -1), '2028-02-29');
  assert.equal(calShift('2026-10-10', -7), '2026-10-03'); // AEDT starts 2026-10-04
  assert.equal(calShift('2027-04-08', -7), '2027-04-01'); // AEDT ends 2027-04-04
});

test('the expected 2026-12-05 / 11 / 12 milestones for a 2026-12-12 run-out verify, with their event ids', () => {
  assert.deepEqual({ ...calVerify(want, reply()) }, { oneWeek: 'a', oneDay: 'b', runout: 'c' });
});

test('a reply for another run-out date, a missing milestone, a wrong date or a missing event id does not verify', () => {
  assert.equal(calVerify(want, reply('2026-12-11')), null);
  assert.equal(calVerify(want, { ok: true, runoutDate: want.date }), null);
  assert.equal(calVerify(want, reply(want.date, { oneDay: undefined })), null);
  assert.equal(calVerify(want, reply(want.date, { oneWeek: { eventId: 'a', date: '2026-12-04' } })), null);
  assert.equal(calVerify(want, reply(want.date, { runout: { eventId: '', date: want.date } })), null);
});

test('a clear verifies only on delete or noop', () => {
  assert.deepEqual({ ...calVerify({ action: 'clear' }, { ok: true, action: 'delete', deleted: 3 }) }, {});
  assert.deepEqual({ ...calVerify({ action: 'clear' }, { ok: true, action: 'noop', deleted: 0 }) }, {});
  assert.equal(calVerify({ action: 'clear' }, { ok: true }), null);
});
