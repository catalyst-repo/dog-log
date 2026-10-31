// Network guard shared by both Playwright configs (WORK-286). Routing (lib/backend.js) answers or aborts every request
// outside the app origin, but two gaps let a request leave the machine:
//   - a request a service worker makes itself (the v8 worker in spec 26 forwards cross-origin POSTs) never reaches
//     context.route unless PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS is set, so it went to the real network;
//   - anything else routing missed would resolve and connect.
// So service-worker traffic is routed like page traffic, and Chromium resolves no host name: the app server is the
// 127.0.0.1 literal, and a request routing misses fails locally instead of reaching Supabase or the Production Apps Script.
// Set here, before any worker launches a browser (config files load in the runner and in every worker).
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

const launchOptions = {
  args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
  ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}),
};

module.exports = { launchOptions };
