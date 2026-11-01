# Dog Log client sync tests (WORK-136 PR-B)

Browser tests for the cloud-sync client in `index.html` and the `dog-log-v9` service worker.

They **never contact Supabase DEV or PROD, or the Production Apps Script calendar bridge**:

- **Database.** A disposable local PostgreSQL cluster is created for the run. It loads `supabase/tests/local/supabase_stub.sql` and the real `supabase/migrations` in order (`20260924225253` base, `20260926005200` WORK-147, `20260926130000` WORK-148, `20261031213557` WORK-287 equal-time transfer fix; listed in `lib/pgcluster.js`), so the app talks to the actual `dog_log.seed_state`, `dog_log.sync` and scheduled-meal functions and their privileges.
- **Supabase emulator.** `lib/backend.js` stands in for Supabase through Playwright request and WebSocket routing:
  - Auth password and refresh grants;
  - PostgREST RPC, executed as `authenticated` with `request.jwt.claims`;
  - Realtime `postgres_changes` over Phoenix vsn 2.0.0.
- **Calendar emulator.** `lib/calendar-bridge.js` answers the app's Apps Script calendar traffic.
- **Network guard.** Every other request outside the app origin is aborted. `lib/network-guard.js`, used by both Playwright configs, closes two gaps:
  - Requests a service worker makes itself are routed like page requests (`PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1`). Without this, the v8 worker in spec 26 forwarded the app's calendar sync straight to the real Production Apps Script.
  - Chromium resolves no host name (`--host-resolver-rules`), so anything routing misses fails locally instead of leaving the machine.

## Startup contract

Startup is not data-unchanged. `startupDoc` and `calendarSettled` in `lib/helpers.js` pin the contract that specs 01, 02, 03, 06 and 26 assert:

- The `pre-sync` backup is taken first, byte-for-byte.
- Startup then persists `stock.neckPackets` (legacy `neckBags` is kept) and `tracking.transferLog`.
- It fills an empty calendar endpoint with the built-in Production Apps Script URL, generates a missing pairing token, and pairs and syncs, even when the device is signed out.
- No Supabase traffic is sent before sign-in.

These assertions record current behaviour. They do not approve it. Two follow-up concerns are open on WORK-286:

- The `pre-adopt` backup holds the already-normalised data, not the original.
- A signed-out device contacts the Production Apps Script on load.
- **App server.** `lib/static-server.js` serves the repository root on `127.0.0.1`, a secure context, so service workers run.

## Run

```sh
cd tests/sync
npm ci                     # @playwright/test 1.56.1, pg
# needs PostgreSQL 15+ server binaries (PG_BINDIR, pg_config, or /usr/lib/postgresql/<v>/bin) and Chromium for Playwright
npx playwright test
```

Windows (PowerShell), with the PostgreSQL 15+ binaries unpacked anywhere:

```powershell
cd tests\sync
npm ci
$env:PG_BINDIR = 'C:\path\to\pgsql\bin'
npx playwright test
```

Where the disposable cluster listens:

- **Linux/macOS:** a private Unix-socket directory under the temp directory, with no TCP listener.
- **Windows:** loopback TCP only (`127.0.0.1`), because node-postgres cannot use a `C:\` path as a socket host. Set `DOGLOG_PG_TCP=1` to use the same loopback TCP path on Linux or macOS.

The ports default to 55461 (PostgreSQL) and 55462 (app server); override them with `DOGLOG_PGPORT_BASE` and `DOGLOG_APP_PORT`. `pg_ctl start` runs with no inherited stdio (the started server would otherwise hold the pipes open and the run would hang on Windows); a failed start reports the server log and removes its temporary `doglog-pg-*` directory. The vendored library's bytes are protected from line-ending conversion by `.gitattributes`, so `core.autocrlf=true` checkouts and `git archive` copies keep the pinned hash.

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
