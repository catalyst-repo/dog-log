// Upgrade safety and unchanged local-only behaviour (no account, never signed in). The startup contract these specs pin,
// and why it is recorded rather than approved, is described at startupDoc in lib/helpers.js.
const { test, expect, fixture, CALENDAR_ENDPOINT, startupDoc, calendarSettled, g, raw } = require('../lib/helpers');

// A never-connected calendar: startup fills in the built-in endpoint and a new token, then pairs and syncs it.
const unpaired = () => fixture({ calendar: { endpoint: '', token: '', paired: false, lastSync: null, lastError: null } });

test('01 existing dog_food_stock_v2 is backed up verbatim before startup normalises it, and its data survives the upgrade', async ({ device, backend }) => {
  const input = unpaired();
  const rawIn = JSON.stringify(input);
  const { page } = await device({ raw: rawIn });
  await calendarSettled(page);
  const b = await g(page, () => backups());
  expect(b.filter(x => x.reason === 'pre-sync')).toHaveLength(1);
  expect(b[0].raw).toBe(rawIn); // R16: byte-for-byte, taken before any startup write
  expect(JSON.parse(await raw(page))).toEqual(startupDoc(input));
  await expect(page.locator('#fridgeVal')).toHaveValue('5');
  await expect(page.locator('#freezerVal')).toHaveValue('12');
  await expect(page.locator('#necksVal')).toHaveValue('3'); // legacy neckBags still maps to Chicken-neck packets
  await expect(page.locator('#syncBadge')).toHaveText('Saved locally');
  expect(backend.calls).toHaveLength(0);
});

test('02 signed-out startup never contacts Supabase, and ordinary use leaves the startup-normalised data unchanged', async ({ device, backend }) => {
  const input = unpaired();
  const { page } = await device({ raw: JSON.stringify(input) });
  await calendarSettled(page);
  const settled = await raw(page);
  expect(JSON.parse(settled)).toEqual(startupDoc(input));
  // The only traffic startup sends is the calendar bridge's pair and sync, to the built-in Production endpoint
  // (answered here by the emulator). That automatic contact is a follow-up concern, not approved behaviour.
  expect(await g(page, () => state.calendar.endpoint)).toBe(CALENDAR_ENDPOINT);
  expect(backend.calendar.posts.map(p => p.action)).toEqual(['pair', 'sync']);
  await g(page, () => { ['food', 'prep', 'plan', 'history', 'settings', 'food'].forEach(showView); tick(); render(); window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(500);
  expect(await raw(page)).toBe(settled);
  expect(backend.calendar.posts).toHaveLength(2); // ordinary use re-sends nothing
  expect(backend.calls).toHaveLength(0);
  expect(await g(page, () => [meta.mode, typeof window.supabase, localStorage.getItem('dog_log_outbox_v1')])).toEqual(['local', 'undefined', null]);
});

test('local mode keeps the WORK-135 behaviour: edits, history and prep batches stay on the device', async ({ device, backend }) => {
  const { page } = await device({ raw: JSON.stringify(fixture()) });
  await page.click(`button[onclick="adjust('fridge',1)"]`);
  await page.fill('#freezerVal', '10');
  await page.locator('#freezerVal').blur();
  await g(page, () => showView('prep'));
  await page.fill('#prepContainers', '4');
  await page.fill('#prepMinceStart', '2.5');
  await page.fill('#prepMinceLeft', '1');
  await page.fill('#prepNecksStart', '3');
  await page.fill('#prepNecksLeft', '1');
  await page.selectOption('#prepDestination', 'fridge');
  await page.click('#prep button.primary');
  const s = JSON.parse(await raw(page));
  expect(s.stock).toMatchObject({ fridge: 10, freezer: 10, minceKg: 1, neckPackets: 1 });
  expect(s.history.slice(0, 3).map(h => h.action)).toEqual(['Prep batch: 4 containers from 1.5 kg mince and 2 neck packets', 'Freezer set to 10 containers', 'Fridge +1']);
  expect(s.batches).toHaveLength(2);
  expect(backend.calls).toHaveLength(0);
});
