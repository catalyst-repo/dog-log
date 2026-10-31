// Starts only the static app server (no database) for suites that never reach Supabase; returns its teardown.
const app = require('./static-server');

module.exports = async () => {
  const server = await app.start(Number(process.env.DOGLOG_APP_PORT || 55472));
  process.env.DOGLOG_APP_URL = server.url;
  return async () => { await server.close(); };
};
