# Dog Log client sync tests (WORK-136 PR-B)

Browser tests for the cloud-sync client in `index.html` and the `dog-log-v9` service worker.

They **never contact Supabase DEV or PROD**:

- **Database.** A disposable local PostgreSQL cluster is created for the run. It loads `supabase/tests/local/supabase_stub.sql` and the real migration `supabase/migrations/20260924225253_dog_log_create_sync_schema.sql`, so the app talks to the actual `dog_log.seed_state` and `dog_log.sync` functions and their privileges.
- **Supabase emulator.** `lib/backend.js` stands in for Supabase through Playwright request and WebSocket routing:
  - Auth password and refresh grants;
  - PostgREST RPC, executed as `authenticated` with `request.jwt.claims`;
  - Realtime `postgres_changes` over Phoenix vsn 2.0.0.
- **Network guard.** Every other request outside the app origin is aborted.
- **App server.** `lib/static-server.js` serves the repository root on `127.0.0.1`, a secure context, so service workers run.

## Run

```sh
cd tests/sync
npm ci                     # @playwright/test 1.56.1, pg
# needs PostgreSQL 15+ server binaries (PG_BINDIR, pg_config, or /usr/lib/postgresql/<v>/bin) and Chromium for Playwright
npx playwright test
```

## Calendar bridge suite (WORK-282)

`calendar/` runs local-mode Dog Log against `lib/calendar-bridge.js`, a stand-in for the google-calendar Apps Script bridge that answers the same CORS-readable JSON as the deployed web app. It needs no PostgreSQL and never contacts Google:

```sh
npm run test:calendar      # or: npx playwright test -c playwright.calendar.config.js
```

It covers verified success, unreadable or unconfirmed replies, terminal errors, 5xx and timeout retries with backoff, offline recovery, reload with a pending retry, changes made mid-write, clear, pairing, a second device, two tabs and token redaction. The main suite uses the same emulator for its calendar traffic.

The package lives here, not at the repository root, so Vercel's static deployment is unaffected.

## Vendored library

`vendor/supabase-js-2.116.0.min.js` is `@supabase/supabase-js@2.116.0` `dist/umd/supabase.js`, unmodified (MIT).

- npm integrity: `sha512-YyWmKXt2NspV9iO8FPnlswUFJIRnrLd3oTCb+3ZyYRuKZtBH0xCUDgnUqoyA0fGUxpM/UhfwDjYf/dht/9bp7g==`
- sha256: `84ee9bf45695c1dd3ba1595b6bcfb0f09672434631351ffc8ebe9140545d5ff6` (asserted by `specs/08-secrets.spec.js`)

The file name carries the version, and it is precached by `sw.js`. Upgrading it means a new file name **and** a new `CACHE` name.
