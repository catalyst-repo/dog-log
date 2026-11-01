// Shared fixtures: one emulated backend per test, and "devices" (browser contexts) with seeded localStorage.
const fs = require('fs');
const path = require('path');
const base = require('@playwright/test');
const { Backend } = require('./backend');

const APP = () => process.env.DOGLOG_APP_URL;
const EMAIL = 'household@dog-log.test';
const PASSWORD = 'correct horse battery staple';

// The six WORK-148 schedule settings the server's _norm_doc materialises into every cloud doc.settings, with their
// migration defaults (supabase/migrations/20260926130000_dog_log_configurable_food_schedule.sql). Pinned here, not read
// from index.html, so a drift in either the client or the server is caught.
const SCHEDULE_DEFAULTS = Object.freeze({ breakfastTime: '09:00', dinnerTime: '18:00', fridgeTransferTime: '18:00', fridgeTransferCount: 2, maxFreezerContainers: 70, maxFridgeContainers: null });
// The exact cloud doc.settings for an owner who set only these fields (schedule fields left at their defaults).
const cloudSettings = (own = {}) => ({ ...own, ...SCHEDULE_DEFAULTS });

// The app's built-in calendar bridge: the Production Apps Script web app (index.html CALENDAR_ENDPOINT). The tests only
// ever reach it through the emulator (lib/backend.js, lib/network-guard.js).
const CALENDAR_ENDPOINT = fs.readFileSync(path.join(__dirname, '../../../index.html'), 'utf8').match(/const CALENDAR_ENDPOINT='([^']+)'/)[1];

// WORK-286 startup contract (operator decision A, 2026-11-01). Startup is not data-unchanged. It first takes the
// verbatim pre-sync backup (R16), then persists normalised local data and connects the calendar bridge:
//   - stock.neckPackets is materialised from the legacy neckBags, which is kept;
//   - tracking.transferLog is initialised (WORK-147);
//   - an empty calendar endpoint becomes CALENDAR_ENDPOINT, a missing pairing token is generated, and the device pairs
//     and syncs, recording want/verified/retry (WORK-282).
// The specs pin this as the current behaviour, not as approved behaviour: the non-verbatim pre-adopt backup and the
// automatic Apps Script contact of a signed-out device are follow-up concerns recorded on WORK-286.
// startupDoc(input) is the stored dog_food_stock_v2 once startup has settled against the always-accepting emulator.
const ISO = base.expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
function startupDoc(input) {
  const c = input.calendar || {};
  const want = { rev: 1, key: base.expect.any(String), payload: { action: 'sync', date: base.expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), preparedContainers: base.expect.any(Number), containersPerDay: base.expect.any(Number), finalMeal: base.expect.any(String) } };
  return {
    ...input,
    stock: { ...input.stock, neckPackets: input.stock.neckPackets != null ? input.stock.neckPackets : input.stock.neckBags },
    tracking: { ...input.tracking, transferLog: {} },
    calendar: {
      ...c,
      endpoint: c.endpoint || CALENDAR_ENDPOINT,
      token: c.token || base.expect.stringMatching(/^[0-9a-f]{64}$/),
      paired: true, lastSync: ISO, lastError: null, want,
      verified: { rev: 1, key: base.expect.any(String), at: ISO, ids: { oneWeek: 'evt-oneWeek', oneDay: 'evt-oneDay', runout: 'evt-runout' } },
      retry: null,
    },
  };
}
// Startup's calendar connection has finished: the desired state is verified and nothing is in flight, so local data
// stays put until the next recheck (6 h) or a change.
async function calendarSettled(page) {
  await base.expect.poll(() => page.evaluate(() => calInSync() && !calFlight && !calSending), { timeout: 15000 }).toBe(true);
}

// WORK-135-shape local data, including the legacy neckBags field.
function fixture(overrides = {}) {
  return {
    stock: { fridge: 5, freezer: 12, minceKg: 2.5, neckBags: 3, necksOnly: 1, minceOnly: 0, lykaPackets: 4, scratchPackets: 2 },
    settings: { totalContainers: 40, containersPerDay: 2, mincePurchaseIncrementKg: 0.5 },
    tracking: { lastAutoDate: null, mealCursor: Date.now(), mealTrackingSince: new Date(Date.now() - 86400000 * 3).toISOString(), mealLog: {} },
    batches: [{ at: '2026-09-20T01:00:00.000Z', containers: 10, minceUsedKg: 4, neckPacketsUsed: 5, minceLeftKg: 2.5, neckPacketsLeft: 3 }],
    history: [{ at: '2026-09-24T01:00:00.000Z', action: 'Fridge +1' }],
    calendar: { endpoint: 'https://script.google.com/macros/s/AKfy-local-test/exec', token: 'device-secret-token-0123456789abcdef', paired: true, lastSync: null, lastError: null },
    ...overrides,
  };
}

const test = base.test.extend({
  backend: async ({}, use) => {
    const b = new Backend();
    await b.resetDb();
    await use(b);
    await b.close();
  },
  // device(opts) -> { context, page, dialogs }. opts.raw seeds dog_food_stock_v2 before the app first loads.
  device: async ({ browser, backend }, use) => {
    const made = [];
    await use(async (opts = {}) => {
      const context = await browser.newContext({ serviceWorkers: opts.serviceWorkers || 'block', viewport: opts.viewport, userAgent: opts.userAgent, timezoneId: 'Australia/Melbourne', locale: 'en-AU' });
      made.push(context);
      const ctl = await backend.install(context, APP());
      const page = await context.newPage();
      const dialogs = [];
      page.on('dialog', d => { dialogs.push(d.message()); const answer = dialogs.answers ? dialogs.answers.shift() : true; return answer === false ? d.dismiss() : d.accept(); });
      dialogs.answers = [];
      if (opts.raw !== undefined || opts.storage) {
        await page.goto(APP() + '/manifest.json');
        await page.evaluate(([raw, storage]) => {
          localStorage.clear();
          if (raw != null) localStorage.setItem('dog_food_stock_v2', raw);
          Object.entries(storage || {}).forEach(([k, v]) => localStorage.setItem(k, v));
        }, [opts.raw === undefined ? null : opts.raw, opts.storage || null]);
      }
      if (opts.load !== false) await page.goto(APP() + '/');
      return { context, page, dialogs, ctl };
    });
    for (const c of made) await c.close();
  },
});

// Page helpers (the app's top-level bindings are readable from page.evaluate).
const g = (page, expr) => page.evaluate(expr);
async function signIn(page, email = EMAIL, password = PASSWORD) {
  await page.evaluate(() => showView('settings'));
  await page.fill('#authEmail', email);
  await page.fill('#authPassword', password);
  await page.click('#cloudSignedOut button.primary');
}
async function waitSynced(page) {
  await base.expect.poll(() => page.evaluate(() => meta.mode === 'synced' && !syncing && pendingFor().length === 0), { timeout: 15000 }).toBe(true);
}
// Take one device off / back on the network (its Supabase traffic, navigator.onLine and the online event).
async function setOffline(d, on) {
  d.ctl.down = on;
  await d.context.setOffline(on);
  if (!on) await d.page.evaluate(() => window.dispatchEvent(new Event('online')));
}
function raw(page) { return page.evaluate(() => localStorage.getItem('dog_food_stock_v2')); }
function outboxOps(page) { return page.evaluate(() => JSON.parse(localStorage.getItem('dog_log_outbox_v1') || '[]').map(o => o.op)); }

// Seed the cloud as the household account through a first device (explicit confirmation), returning its owner id.
async function seededDevice({ device, backend }, localData = fixture(), opts = {}) {
  const owner = backend.users.get(EMAIL) ? backend.users.get(EMAIL).id : await backend.createUser(EMAIL, PASSWORD);
  const d = await device({ raw: JSON.stringify(localData), ...opts });
  await signIn(d.page);
  await base.expect(d.page.locator('#seedPanel button.primary')).toBeVisible();
  await d.page.click('#seedPanel button.primary');
  await waitSynced(d.page);
  await d.page.evaluate(() => showView('food'));
  return { ...d, owner };
}

module.exports = { test, expect: base.expect, APP, EMAIL, PASSWORD, fixture, SCHEDULE_DEFAULTS, cloudSettings, CALENDAR_ENDPOINT, startupDoc, calendarSettled, g, signIn, waitSynced, raw, outboxOps, seededDevice, setOffline };
