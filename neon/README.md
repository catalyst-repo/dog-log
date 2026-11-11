# Dog Log on an isolated Neon backend (WORK-274)

This folder and [`server/`](../server/) hold the first increment (I1) of Dog Log's move from the shared Supabase projects to its own Neon backend: a portable PostgreSQL schema, a server-side API skeleton and local synthetic tests.

**Nothing here is live.** Supabase stays the authoritative Production backend. `index.html` still talks to Supabase, and merging this folder applies, connects and deploys nothing: `.vercelignore` keeps `neon/` and `server/` out of every Vercel deployment.

| File | Purpose |
|---|---|
| `migrations/20261110120000_dog_log_portable_schema.sql` | The Supabase end-state (WORK-136, WORK-147, WORK-148 and the WORK-287 equal-time fix) as portable PostgreSQL, with a server-owned identity |
| `rollbacks/20261110120000_dog_log_portable_schema.rollback.sql` | Pre-adoption rollback; refuses once any account or state row exists |
| `../server/db.js` | Environment-safe connection: declared DEV target only, never in a Vercel Production deployment, the connection string never echoed |
| `../server/session.js` | Session-verifier interface; the auth provider is still to be chosen |
| `../server/api.js` | `POST /api/sync/seed` and `POST /api/sync`, which return the same JSON as today's `seed_state` / `sync` RPCs |
| `../tests/neon/` | Parity, differential, WORK-287, security, concurrency, rollback and API tests on disposable local PostgreSQL |

## How the schema differs from Supabase

The internal functions are copied verbatim from the live Supabase end-state, and `tests/neon/backend.test.js` fails if any of them drifts. Only four substitutions differ:

- **S1 Server-owned identity.**
  - `dog_log.app_user` is the owner key.
  - `dog_log.app_identity (provider, subject)` maps a verified session to it.
  - No Supabase `auth.users` id or provider is assumed. This is the mapping a later data migration and WORK-272 (Google sign-in, shared household) build on.
- **S2 Owner guard.** The internal guard in `_process_due_meals` reads the request owner, bound per transaction by the server entry point, instead of `auth.uid()`.
- **S3 Entry points.** `server_seed_state(p_owner, …)` and `server_sync(p_owner, …)` keep the `seed_state` / `sync` bodies. The owner comes from the verified session, never from the client.
- **S4 No client access.**
  - There are no browser roles, RLS policies or Realtime publication.
  - The NOLOGIN group role `dog_log_api` may only EXECUTE `server_resolve_owner`, `server_seed_state` and `server_sync`.
  - RLS is enabled with no policies as a backstop.
  - Realtime is deferred, per the operator's decision of 9 November 2026. Devices converge by syncing, as they do offline today.

**Trust boundary.** The database trusts `dog_log_api` to pass the owner of a session the server has verified. That role holds no table privilege and cannot run any internal function.

## Applying (not done by merging)

Each step below is a separate, governed act (`data.application-backend`):

1. **Backend declaration.**
   - Declare the Neon boundary in `.catalyst/app.yml` as `migrating`. Supabase remains the legacy, authoritative source.
   - The project and branch ids come from the operator's Neon Console (WORK-274 comment d76442e2), not from an AI provider read. Declaring them authorises no mutation.
   - Validate the declaration with `backend-preflight.js validate`.
2. **DEV apply.**
   - Apply the migration to the `dev` target only, after `backend-preflight.js preflight` passes for exactly that app, project, target and operation. Preflight needs a fresh provider read of the `dev` branch that matches the declared id.
   - Then verify the applied state from the same target.
   - The two requests are in `preflight/`:
     - `…dev.preflight.json` is the schema-migration request for change `20261110120000_dog_log_portable_schema` on `dev`.
     - `…dev.verify-applied.json` checks the same change on the same target afterwards.
   - As committed, both carry no observation and are refused (`no-observation`). Each file's `$comment` says what the executor fills in and the exact command to run.
   - Before applying, run verify-applied first. If it already returns `verified`, the change is applied and must not be applied again; a second run of the migration fails at `create schema dog_log` anyway.
   - **Open before the apply:** verify-applied reads the change id from the `dev` branch's own migration history. This migration does not record itself, and Dog Log has no history table on Neon yet. How the apply records the change on `dev` is a decision still to make, and until then verify-applied can only return `no-applied-history`.
3. **Runtime credential (human ADMIN only).**
   - Create a login role that is a member of `dog_log_api` on `dev`.
   - Install its connection string as the Vercel **Preview-only** server variable `DOG_LOG_DATABASE_URL`, together with `DOG_LOG_BACKEND_TARGET=dev` and `DOG_LOG_DATABASE_ENDPOINT=<dev endpoint id>`.
   - No credential value passes through an AI, a repository, Linear or chat.
4. **Production** (`main`) needs the completed DEV proof, a rollback path and explicit Production clearance for that exact operation. It is not part of I1.

## Tests

```sh
cd tests/neon && npm ci && npm test
```

The tests need PostgreSQL 15+ server binaries; set `PG_BINDIR` if they are not found. They create and delete their own temporary cluster, and never contact Supabase or Neon.

`preflight.test.js` checks the `preflight/` requests against the governance `backend-preflight.js` tool. It uses synthetic branch reads, never provider observations. Set `CATALYST_GOVERNANCE_DIR` to a checkout of catalyst-repo/governance to run it; without that, those checks are skipped.

```sh
cd tests/neon && CATALYST_GOVERNANCE_DIR=/path/to/governance npm test
```
