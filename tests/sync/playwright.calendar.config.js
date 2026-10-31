// WORK-282 calendar bridge tests. Local-mode Dog Log against the local bridge emulator: no database, no Supabase,
// no Google. Runs without PostgreSQL: `npx playwright test -c playwright.calendar.config.js`.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './calendar',
  globalSetup: require.resolve('./lib/app-setup.js'),
  workers: 1,
  fullyParallel: false,
  timeout: 60000,
  expect: { timeout: 10000 },
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
    timezoneId: 'Australia/Melbourne',
    locale: 'en-AU',
    actionTimeout: 10000,
  },
});
