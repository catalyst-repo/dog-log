// WORK-282: the calendar is reported synced only after the bridge confirms the exact desired state, and failed writes
// are retried durably. Local-mode Dog Log against the bridge emulator (lib/calendar-bridge.js); no cloud, no Google.
// Timers run on Playwright's clock so backoff and timeouts can be fast-forwarded.
const base = require('@playwright/test');
const { APP, fixture } = require('../lib/helpers');
const { CalendarBridge, shift } = require('../lib/calendar-bridge');

const expect = base.expect;
const TOKEN = 'device-secret-token-0123456789abcdef'; // fixture()'s paired device token
const OTHER = 'another-device-token-0123456789abcdef0';
const unpaired = () => fixture({ calendar: { endpoint: 'https://script.google.com/macros/s/AKfy-local-test/exec', token: '', paired: false, lastSync: null, lastError: null } });

const test = base.test.extend({
  bridge: async ({}, use) => { await use(new CalendarBridge({ token: TOKEN })); },
  // device(opts) -> { context, page, logs, urls }. opts.data seeds dog_food_stock_v2; opts.context opens another tab in it.
  device: async ({ browser, bridge }, use) => {
    const made = [];
    await use(async (opts = {}) => {
      let context = opts.context;
      if (!context) {
        context = await browser.newContext({ serviceWorkers: 'block', timezoneId: 'Australia/Melbourne', locale: 'en-AU' });
        made.push(context);
        await context.clock.install();
        await context.route(() => true, route => {
          const u = route.request().url();
          if (u.startsWith(APP()) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
          if (u.startsWith('https://script.google.com/')) return bridge.handle(route);
          return route.abort('blockedbyclient');
        });
      }
      const page = await context.newPage();
      const logs = [], urls = [];
      page.on('console', m => logs.push(m.text()));
      page.on('pageerror', e => logs.push(String(e)));
      page.on('request', r => urls.push(r.url()));
      page.on('dialog', d => d.accept());
      if (opts.data !== undefined) {
        await page.goto(APP() + '/manifest.json');
        await page.evaluate(raw => { localStorage.clear(); localStorage.setItem('dog_food_stock_v2', raw); }, JSON.stringify(opts.data));
      }
      await page.goto(APP() + '/');
      return { context, page, logs, urls };
    });
    for (const c of made) await c.close();
  },
});

const status = page => page.evaluate(() => calendarStatus.textContent);
const detail = page => page.evaluate(() => calendarDetail.textContent);
const cal = page => page.evaluate(() => JSON.parse(localStorage.getItem('dog_food_stock_v2')).calendar);
const retryCode = async page => ((await cal(page)).retry || {}).code;
const desired = page => page.evaluate(() => calDesired());
const syncs = bridge => bridge.posts.filter(p => p.action === 'sync');
const SYNCED = /^Synced · verified /;

test('a sync is reported only after the bridge confirms all three milestone events on the expected dates', async ({ device, bridge }) => {
  const { page } = await device({ data: fixture() });
  await expect.poll(() => status(page)).toMatch(SYNCED);
  const want = await desired(page);
  expect(want.action).toBe('sync');
  expect(syncs(bridge).at(-1)).toEqual({ ...want, token: TOKEN });
  const c = await cal(page);
  expect(c.verified.ids).toEqual({ oneWeek: 'evt-oneWeek', oneDay: 'evt-oneDay', runout: 'evt-runout' });
  expect(c.verified.key).toBe(JSON.stringify(want));
  expect(c.lastError).toBeNull();
  expect(c.retry).toBeNull();
  expect([bridge.events.oneWeek.date, bridge.events.oneDay.date, bridge.events.runout.date]).toEqual([shift(want.date, -7), shift(want.date, -1), want.date]);
  expect(bridge.posts.filter(p => p.action === 'pair')).toHaveLength(0); // an already-paired device is not re-paired at startup
  expect(await status(page)).not.toBe('Automatic');
});

test('an empty HTTP 200 (the old no-cors false positive) is never success', async ({ device, bridge }) => {
  bridge.queue.push({ status: 200, raw: '' });
  const { page } = await device({ data: fixture() });
  await expect.poll(() => status(page)).toMatch(/^Retrying at /);
  const c = await cal(page);
  expect(c.verified).toBeNull();
  expect(c.lastSync).toBeNull();
  expect(c.retry).toMatchObject({ n: 1, code: 'unreadable', terminal: false });
  expect(await detail(page)).toContain('unreadable');
});

test('a reply that does not name the expected events and dates is not verified', async ({ device, bridge }) => {
  bridge.queue.push({ json: { ok: true, milestones: { runout: { eventId: 'evt-runout', date: '2000-01-01' } }, runoutDate: '2000-01-01' } });
  const { page } = await device({ data: fixture() });
  await expect.poll(() => retryCode(page)).toBe('unverified');
  expect((await cal(page)).verified).toBeNull();
  expect(await status(page)).toMatch(/^Retrying at /);
});

test('unauthorized is terminal: action needed, the pairing is dropped and nothing is retried quickly', async ({ device, bridge }) => {
  bridge.digest = OTHER;
  const { page, context } = await device({ data: fixture() });
  await expect.poll(() => status(page)).toBe('Action needed');
  const c = await cal(page);
  expect(c.paired).toBe(false);
  expect(c.retry).toMatchObject({ code: 'unauthorized', terminal: true });
  expect(await detail(page)).toContain('Reconnect');
  await expect(page.locator('#syncBadge')).toHaveText('Calendar issue');
  const n = bridge.posts.length;
  await context.clock.fastForward('30:00');
  await page.evaluate(() => { tick(); return syncCalendar(); });
  expect(bridge.posts.length).toBe(n);
});

test('a 5xx is retried with backoff until the bridge confirms the write', async ({ device, bridge }) => {
  bridge.queue.push({ status: 503, raw: 'busy' });
  const { page, context } = await device({ data: fixture() });
  await expect.poll(() => retryCode(page)).toBe('http_503');
  expect(await status(page)).toMatch(/^Retrying at /);
  await context.clock.fastForward(7000); // first backoff is 5 s ± 25%
  await expect.poll(() => status(page)).toMatch(SYNCED);
  expect(syncs(bridge)).toHaveLength(2);
  expect((await cal(page)).retry).toBeNull();
});

test('a request that never answers times out and is retried', async ({ device, bridge }) => {
  bridge.queue.push({ hang: true });
  const { page, context } = await device({ data: fixture() });
  await expect.poll(() => syncs(bridge).length).toBe(1);
  await context.clock.fastForward(21000);
  await expect.poll(() => retryCode(page)).toBe('timeout');
  await context.clock.fastForward(7000);
  await expect.poll(() => status(page)).toMatch(SYNCED);
  expect(syncs(bridge)).toHaveLength(2);
});

test('offline changes are not sent; coming back online retries at once and verifies the latest state', async ({ device, bridge }) => {
  const { page, context } = await device({ data: fixture() });
  await expect.poll(() => status(page)).toMatch(SYNCED);
  const before = syncs(bridge).length;
  await context.setOffline(true);
  await page.evaluate(() => adjust('fridge', 1));
  await expect.poll(() => retryCode(page)).toBe('offline');
  expect(await status(page)).toMatch(/^Retrying at /);
  expect(syncs(bridge)).toHaveLength(before);
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => status(page)).toMatch(SYNCED);
  expect(syncs(bridge)).toHaveLength(before + 1);
  expect((await cal(page)).verified.key).toBe(JSON.stringify(await desired(page)));
});

test('a pending retry survives a reload and resumes on its stored schedule', async ({ device, bridge }) => {
  bridge.queue.push({ status: 500 });
  const { page, context } = await device({ data: fixture() });
  await expect.poll(() => retryCode(page)).toBe('http_500');
  await page.reload();
  expect(await retryCode(page)).toBe('http_500');
  expect(syncs(bridge)).toHaveLength(1); // the reload waits out the stored backoff instead of re-sending at once
  await context.clock.fastForward(7000);
  await expect.poll(() => status(page)).toMatch(SYNCED);
  expect(syncs(bridge)).toHaveLength(2);
});

test('a change made while a write is in flight is sent next; the earlier reply never verifies the newer state', async ({ device, bridge }) => {
  let releaseFirst, releaseSecond;
  bridge.queue.push({ hold: new Promise(r => { releaseFirst = r; }) }, { hold: new Promise(r => { releaseSecond = r; }) });
  const { page } = await device({ data: fixture() });
  await expect.poll(() => syncs(bridge).length).toBe(1);
  const first = syncs(bridge)[0];
  await page.evaluate(() => adjust('fridge', 1));
  releaseFirst();
  await expect.poll(() => syncs(bridge).length).toBe(2);
  const second = syncs(bridge)[1];
  expect(second.preparedContainers).toBe(first.preparedContainers + 1);
  expect(await page.evaluate(() => calInSync())).toBe(false);
  expect(await status(page)).not.toMatch(SYNCED);
  releaseSecond();
  await expect.poll(() => status(page)).toMatch(SYNCED);
  expect((await cal(page)).verified.key).toBe(JSON.stringify(await desired(page)));
  expect(bridge.maxInflight).toBe(1);
});

test('no prepared stock sends clear, and the clear is confirmed', async ({ device, bridge }) => {
  const { page } = await device({ data: fixture({ stock: { fridge: 0, freezer: 0, minceKg: 2.5, neckBags: 3, necksOnly: 1, minceOnly: 0, lykaPackets: 4, scratchPackets: 2 } }) });
  await expect.poll(() => status(page)).toMatch(SYNCED);
  expect(bridge.posts.at(-1)).toEqual({ action: 'clear', token: TOKEN });
  expect((await cal(page)).verified.ids).toEqual({});
});

test('a new device pairs first, is marked paired only on the bridge confirmation, then syncs', async ({ device, bridge }) => {
  bridge.digest = null;
  const { page } = await device({ data: unpaired() });
  await expect.poll(() => status(page)).toMatch(SYNCED);
  const [pair, sync] = bridge.posts;
  expect(pair.action).toBe('pair');
  expect(sync.action).toBe('sync');
  expect(pair.token).toMatch(/^[0-9a-f]{64}$/);
  expect(sync.token).toBe(pair.token);
  expect((await cal(page)).paired).toBe(true);
});

test('a second device is told the calendar is paired elsewhere, without a false success or an alarm', async ({ device, bridge }) => {
  bridge.digest = OTHER;
  const { page } = await device({ data: unpaired() });
  await expect.poll(() => status(page)).toBe('Paired with another device');
  const c = await cal(page);
  expect(c.paired).toBe(false);
  expect(c.lastError).toBeNull();
  expect(c.retry).toMatchObject({ code: 'already_paired', terminal: true });
  expect(syncs(bridge)).toHaveLength(0);
  await expect(page.locator('#syncBadge')).toHaveText('Saved locally');
});

test('two tabs never write to the bridge at the same time', async ({ device, bridge }) => {
  let release;
  bridge.queue.push({ hold: new Promise(r => { release = r; }) });
  const a = await device({ data: fixture() });
  await expect.poll(() => syncs(bridge).length).toBe(1);
  const b = await device({ context: a.context });
  await b.page.evaluate(() => syncCalendar());
  expect(bridge.posts).toHaveLength(1); // the second tab waits for the Web Lock instead of writing
  release();
  await expect.poll(() => status(a.page)).toMatch(SYNCED);
  await a.context.clock.fastForward(11000);
  await expect.poll(() => status(b.page)).toMatch(SYNCED);
  expect(bridge.maxInflight).toBe(1);
});

test('the pairing token never reaches the console, an error message or a URL', async ({ device, bridge }) => {
  bridge.queue.push({ json: { ok: false, error: 'invalid_request', detail: 'boom' } });
  const { page, context, logs, urls } = await device({ data: fixture() });
  await expect.poll(() => retryCode(page)).toBe('invalid_request');
  await context.clock.fastForward(7000);
  await expect.poll(() => status(page)).toMatch(SYNCED);
  expect(logs.join('\n')).not.toContain(TOKEN);
  expect(urls.some(u => u.includes(TOKEN))).toBe(false);
  const c = await cal(page);
  expect(JSON.stringify([c.lastError, c.retry, c.want, c.verified])).not.toContain(TOKEN);
});
