// WORK-136 PR-B client sync tests. Serial (one shared disposable database), Chromium only.
const { defineConfig } = require('@playwright/test');
const { launchOptions } = require('./lib/network-guard');

module.exports = defineConfig({
  testDir: './specs',
  globalSetup: require.resolve('./lib/global-setup.js'),
  workers: 1,
  fullyParallel: false,
  timeout: 60000,
  expect: { timeout: 10000 },
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    launchOptions,
    timezoneId: 'Australia/Melbourne',
    locale: 'en-AU',
    actionTimeout: 10000,
  },
});
