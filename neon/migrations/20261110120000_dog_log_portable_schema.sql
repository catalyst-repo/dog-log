-- =============================================================================
-- Dog Log on an isolated Neon backend: portable schema (WORK-274, Increment I1)
--
-- What this is: the end-state of the four Supabase migrations in supabase/migrations
-- (WORK-136 base, WORK-147, WORK-148 and the WORK-287 equal-time transfer fix), made
-- portable to plain PostgreSQL. Every internal function body is copied verbatim
-- from that end-state; tests/neon/parity.test.js fails if any of them drifts.
--
-- Supabase coupling replaced. These four substitutions are the only differences:
--   S1  Identity is server-owned. dog_log.app_user is the owner key and
--       dog_log.app_identity maps a verified (provider, subject) to it, so no
--       Supabase auth.users id or auth provider is assumed.
--   S2  The internal owner guard in _process_due_meals reads the request owner
--       bound by the server entry point (dog_log._request_owner()), not auth.uid().
--   S3  dog_log.server_seed_state / dog_log.server_sync are seed_state / sync with
--       the owner passed in by the server API from the verified session.
--   S4  There are no client roles, RLS policies or Realtime publication. Browsers
--       never connect to the database. One NOLOGIN group role, dog_log_api, may
--       only EXECUTE the three server_* functions. Its login member, the runtime
--       credential, is created by the human ADMIN outside this file.
--
-- Trust boundary: the database trusts dog_log_api to pass the owner of a session
-- the server API has verified (server/). It holds no table privilege and cannot
-- execute any internal function.
--
-- Applying is a separate, governed act; merging applies nothing. Apply only to
-- the declared Dog Log Neon DEV target `dev`, after a backend declaration in
-- .catalyst/app.yml and a passing backend preflight (data.application-backend).
-- Never apply to `main` (Production) without explicit Production clearance for
-- that exact operation. Supabase stays the authoritative Production backend.
-- Rollback: neon/rollbacks/20261110120000_dog_log_portable_schema.rollback.sql
--
-- Applied history: this file is one transaction (begin ... commit). Its last act
-- records its change id in dog_log_migrations.schema_migrations, so the schema and
-- that record commit together or not at all. The record's primary key refuses a
-- second apply. backend-preflight verify-applied reads this table on the same
-- branch. Apply the file as one script; it needs no psql --single-transaction.
-- =============================================================================

begin;

-- The runtime group role. NOLOGIN: it carries no password or credential.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'dog_log_api') then
    create role dog_log_api nologin;
  end if;
end $$;

create schema dog_log;
comment on schema dog_log is 'Dog Log cloud sync on Neon (WORK-274). Writes only through dog_log.server_seed_state / dog_log.server_sync, called by the server API.';

revoke all on schema dog_log from public;
grant usage on schema dog_log to dog_log_api;

-- Schema-level defaults only remove grants added at schema level. The protection
-- that holds is the explicit per-object revoke at the end of this file.
alter default privileges in schema dog_log revoke all on tables from public;
alter default privileges in schema dog_log revoke all on sequences from public;
alter default privileges in schema dog_log revoke execute on functions from public;

-- -----------------------------------------------------------------------------
-- Identity (S1)
-- -----------------------------------------------------------------------------

create table dog_log.app_user (
  id         uuid        primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);
comment on table dog_log.app_user is 'One row per Dog Log account. Its id is the owner key of every Dog Log row; it is independent of any auth provider.';

create table dog_log.app_identity (
  provider   text        not null check (provider ~ '^[a-z][a-z0-9_-]{0,39}$'),
  subject    text        not null check (length(subject) between 1 and 255),
  user_id    uuid        not null references dog_log.app_user (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (provider, subject)
);
comment on table dog_log.app_identity is 'Maps a verified auth identity (provider, subject) to its app user. Created only by an administrative act, never by a runtime function.';
create index app_identity_user_id_idx on dog_log.app_identity (user_id);

-- -----------------------------------------------------------------------------
-- Sync tables: the Supabase end-state, except that state.owner_id references
-- dog_log.app_user instead of auth.users (S1). Constraint names match the end-state.
-- -----------------------------------------------------------------------------

create table dog_log.state (
  owner_id            uuid        not null,
  doc                 jsonb       not null,
  revision            bigint      not null default 1,
  schema_version      integer     not null default 1,
  min_client_version  integer     not null default 1,
  time_zone           text        not null default 'Australia/Melbourne',
  meal_cursor         timestamptz,
  meal_tracking_since timestamptz,
  seed_id             uuid        not null,
  seeded_from_device  text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  updated_by_device   text,
  constraint state_pkey primary key (owner_id),
  constraint state_owner_id_fkey foreign key (owner_id) references dog_log.app_user (id) on delete cascade,
  constraint state_doc_check check (jsonb_typeof(doc) = 'object'),
  constraint state_revision_check check (revision >= 1)
);
comment on table dog_log.state is 'One authoritative Dog Log state row per owner. doc is mutated only by server-applied operations; revision increases once per changing transaction.';

create table dog_log.meal_events (
  owner_id                uuid        not null,
  meal_date               date        not null,
  slot                    text        not null,
  outcome                 text        not null,
  source_container        text,
  slot_at                 timestamptz not null,
  processed_at            timestamptz not null default now(),
  processed_by_device     text,
  state_revision          bigint,
  origin                  text        not null,
  freezer_to_fridge_count smallint,
  constraint meal_events_pkey primary key (owner_id, meal_date, slot),
  constraint meal_events_owner_id_fkey foreign key (owner_id) references dog_log.state (owner_id) on delete cascade,
  constraint meal_events_slot_check check (slot in ('breakfast', 'dinner', 'transfer')),
  constraint meal_events_outcome_check check (outcome in ('fed', 'no-stock', 'before-tracking', 'transferred')),
  constraint meal_events_source_container_check check (source_container in ('fridge', 'freezer')),
  constraint meal_events_origin_check check (origin in ('server', 'seed')),
  -- a server-fed meal always records which container it used; seed-imported history may not know it
  constraint meal_events_check check (outcome = 'fed' or source_container is null),
  constraint meal_events_check1 check (origin = 'seed' or outcome <> 'fed' or source_container is not null),
  constraint meal_events_slot_outcome_check check (
    case when slot = 'transfer' then outcome in ('transferred', 'before-tracking') and source_container is null
         else outcome <> 'transferred' end),
  constraint meal_events_freezer_to_fridge_count_check check (freezer_to_fridge_count between 0 and 100)
);
comment on table dog_log.meal_events is 'Exactly-once scheduled events: one row per owner + Australia/Melbourne date + slot (breakfast, dinner, transfer).';
comment on column dog_log.meal_events.freezer_to_fridge_count is 'Full Containers moved Freezer to Fridge. WORK-147 dinner rows: moved inside Dinner (0..2). WORK-148 transfer rows: moved by the daily transfer. NULL = no transfer recorded on this row.';
create index meal_events_owner_slot_at_idx on dog_log.meal_events (owner_id, slot_at);

create table dog_log.mutations (
  owner_id          uuid        not null,
  mutation_id       uuid        not null,
  device_id         text,
  op_type           text,
  client_created_at timestamptz,
  applied_at        timestamptz not null default now(),
  status            text        not null,
  detail            jsonb,
  result_revision   bigint,
  constraint mutations_pkey primary key (owner_id, mutation_id),
  constraint mutations_owner_id_fkey foreign key (owner_id) references dog_log.state (owner_id) on delete cascade,
  constraint mutations_status_check check (status in ('applied', 'applied-clamped', 'conflict', 'rejected', 'expired'))
);
comment on table dog_log.mutations is 'Idempotency ledger: a mutation_id is applied at most once per owner; retries return the recorded result.';

create table dog_log.state_snapshots (
  id        bigint      generated always as identity,
  owner_id  uuid        not null,
  taken_at  timestamptz not null default now(),
  reason    text        not null,
  revision  bigint      not null,
  doc       jsonb       not null,
  constraint state_snapshots_pkey primary key (id),
  constraint state_snapshots_owner_id_fkey foreign key (owner_id) references dog_log.state (owner_id) on delete cascade,
  constraint state_snapshots_reason_check check (reason in ('pre-replace', 'pre-restore', 'seed'))
);
comment on table dog_log.state_snapshots is 'Server-side recovery copies taken at seed and before any replace/restore. Newest 20 per owner kept.';
create index state_snapshots_owner_id_idx on dog_log.state_snapshots (owner_id, id desc);

-- -----------------------------------------------------------------------------
-- Internal helpers: the Supabase end-state bodies, verbatim (no client EXECUTE)
-- -----------------------------------------------------------------------------
create function dog_log._num(p jsonb, p_default numeric DEFAULT 0)
returns numeric language plpgsql immutable
set search_path = pg_catalog, pg_temp as $$
begin
  if p is null or jsonb_typeof(p) = 'null' then return p_default; end if;
  -- Values are bounded to +/-1e9 so no later arithmetic can overflow.
  if jsonb_typeof(p) = 'number' then return least(greatest((p #>> '{}')::numeric, -1000000000), 1000000000); end if;
  if jsonb_typeof(p) = 'string' and length(p #>> '{}') <= 40 and (p #>> '{}') ~ '^\s*-?(\d+\.?\d*|\.\d+)\s*$' then
    return least(greatest(trim(p #>> '{}')::numeric, -1000000000), 1000000000);
  end if;
  return 0;
end $$;

create function dog_log._count(p numeric)
returns numeric language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select round(least(greatest(coalesce(p, 0), 0), 1000000))
$$;

create function dog_log._kg(p numeric)
returns numeric language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select round(least(greatest(coalesce(p, 0), 0), 1000000), 3)
$$;

create function dog_log._is_count_key(p_key text)
returns boolean language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select coalesce(p_key in ('fridge', 'freezer', 'neckPackets', 'necksOnly', 'minceOnly', 'lykaPackets', 'scratchPackets'), false)
$$;

create function dog_log._is_stock_key(p_key text)
returns boolean language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select coalesce(p_key = 'minceKg', false) or dog_log._is_count_key(p_key)
$$;

create function dog_log._stock_val(p_key text, p numeric)
returns numeric language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select case when p_key = 'minceKg' then dog_log._kg(p) else dog_log._count(p) end
$$;

create function dog_log._try_ts(p text)
returns timestamp with time zone language plpgsql stable
set search_path = pg_catalog, pg_temp as $$
begin
  return p::timestamptz;
exception when others then
  return null;
end $$;

create function dog_log._iso(p timestamp with time zone)
returns text language sql stable
set search_path = pg_catalog, pg_temp as $$
  select to_char(p at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;

create function dog_log._setting(p_doc jsonb, p_field text)
returns jsonb language plpgsql immutable
set search_path = pg_catalog, pg_temp as $$
declare
  v jsonb := p_doc -> 'settings' -> p_field;
  n numeric;
begin
  if p_field in ('breakfastTime', 'dinnerTime', 'fridgeTransferTime') then
    if jsonb_typeof(v) = 'string' and (v #>> '{}') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      return v;
    end if;
    return to_jsonb(case p_field when 'breakfastTime' then '09:00' else '18:00' end);
  end if;
  if p_field in ('fridgeTransferCount', 'maxFreezerContainers', 'maxFridgeContainers') then
    if jsonb_typeof(v) = 'number' then
      n := (v #>> '{}')::numeric;
      if n = round(n) and n >= 0 and n <= (case p_field when 'fridgeTransferCount' then 100 else 1000000 end) then
        return to_jsonb(round(n));
      end if;
    end if;
    return case p_field when 'fridgeTransferCount' then '2'::jsonb
                        when 'maxFreezerContainers' then '70'::jsonb
                        else 'null'::jsonb end;
  end if;
  return null;
end; $$;

create function dog_log._sched_time(p_doc jsonb, p_slot text)
returns time without time zone language sql stable
set search_path = pg_catalog, pg_temp as $$
  select (dog_log._setting(p_doc, case p_slot when 'breakfast' then 'breakfastTime'
                                              when 'dinner' then 'dinnerTime'
                                              else 'fridgeTransferTime' end) #>> '{}')::time
$$;

create function dog_log._slot_at(p_date date, p_slot text, p_tz text)
returns timestamp with time zone language sql stable
set search_path = pg_catalog, pg_temp as $$
  select (p_date + case p_slot when 'breakfast' then time '09:00' else time '18:00' end) at time zone p_tz
$$;

create function dog_log._fmt_day(p timestamp with time zone, p_tz text)
returns text language sql stable
set search_path = pg_catalog, pg_temp as $$
  select to_char(p at time zone p_tz, 'Dy FMDD ')
      || (array['Jan','Feb','Mar','Apr','May','June','July','Aug','Sept','Oct','Nov','Dec'])[extract(month from p at time zone p_tz)::int]
      || case when extract(year from p at time zone p_tz) <> extract(year from now() at time zone p_tz)
              then ' ' || extract(year from p at time zone p_tz)::int::text else '' end
$$;

create function dog_log._history_push(p_doc jsonb, p_at timestamp with time zone, p_action text)
returns jsonb language sql stable
set search_path = pg_catalog, pg_temp as $$
  select jsonb_set(p_doc, '{history}',
    (select coalesce(jsonb_agg(e order by ord), '[]'::jsonb)
       from (select e, ord from (
               select jsonb_build_object('at', dog_log._iso(p_at), 'action', left(p_action, 500)) as e, 0::bigint as ord
               union all
               select h.e, h.ord from jsonb_array_elements(coalesce(p_doc -> 'history', '[]'::jsonb)) with ordinality as h(e, ord)
             ) x order by ord limit 150) y))
$$;

create function dog_log._norm_doc(p jsonb)
returns jsonb language plpgsql stable
set search_path = pg_catalog, pg_temp as $$
declare
  s        jsonb := case when jsonb_typeof(p -> 'stock') = 'object' then p -> 'stock' else '{}'::jsonb end;
  st       jsonb := case when jsonb_typeof(p -> 'settings') = 'object' then p -> 'settings' else '{}'::jsonb end;
  tr       jsonb := case when jsonb_typeof(p -> 'tracking') = 'object' then p -> 'tracking' else '{}'::jsonb end;
  cal      jsonb := case when jsonb_typeof(p -> 'calendar') = 'object' then p -> 'calendar' else '{}'::jsonb end;
  necks    jsonb := coalesce(nullif(s -> 'neckPackets', 'null'::jsonb), s -> 'neckBags');
  sd       jsonb := jsonb_build_object('settings', st);
  batches  jsonb;
  history  jsonb;
  inc      numeric;
  endpoint text;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'at',              case when jsonb_typeof(b -> 'at') = 'string' then left(b ->> 'at', 40) else null end,
           'containers',      dog_log._kg(dog_log._num(b -> 'containers')),
           'minceUsedKg',     dog_log._kg(dog_log._num(b -> 'minceUsedKg')),
           'neckPacketsUsed', dog_log._kg(dog_log._num(b -> 'neckPacketsUsed')),
           'minceLeftKg',     dog_log._kg(dog_log._num(b -> 'minceLeftKg')),
           'neckPacketsLeft', dog_log._kg(dog_log._num(b -> 'neckPacketsLeft'))
         ) order by ord), '[]'::jsonb)
    into batches
    from (select b, ord from jsonb_array_elements(case when jsonb_typeof(p -> 'batches') = 'array' then p -> 'batches' else '[]'::jsonb end)
                 with ordinality as t(b, ord)
           where jsonb_typeof(b) = 'object' order by ord limit 50) x;

  select coalesce(jsonb_agg(jsonb_build_object(
           'at',     case when jsonb_typeof(h -> 'at') = 'string' then left(h ->> 'at', 40) else null end,
           'action', left(h ->> 'action', 500)
         ) order by ord), '[]'::jsonb)
    into history
    from (select h, ord from jsonb_array_elements(case when jsonb_typeof(p -> 'history') = 'array' then p -> 'history' else '[]'::jsonb end)
                 with ordinality as t(h, ord)
           where jsonb_typeof(h) = 'object' and jsonb_typeof(h -> 'action') = 'string' order by ord limit 150) x;

  inc := dog_log._kg(dog_log._num(st -> 'mincePurchaseIncrementKg', 0.5));
  if inc = 0 then inc := 0.5; end if;          -- client: Number(x)||.5
  inc := least(greatest(0.1, inc), 1000);      -- client: Math.max(.1, ...); bounded
  endpoint := case when jsonb_typeof(cal -> 'endpoint') = 'string'
                     and (cal ->> 'endpoint') ~ '^https://script\.google\.com/macros/s/[^/\s]+/exec$'
                     and length(cal ->> 'endpoint') <= 500
                   then cal ->> 'endpoint' else '' end;

  return jsonb_build_object(
    'stock', jsonb_build_object(
      'fridge',         dog_log._count(dog_log._num(s -> 'fridge')),
      'freezer',        dog_log._count(dog_log._num(s -> 'freezer')),
      'minceKg',        dog_log._kg(dog_log._num(s -> 'minceKg')),
      'neckPackets',    dog_log._count(dog_log._num(necks)),
      'necksOnly',      dog_log._count(dog_log._num(s -> 'necksOnly')),
      'minceOnly',      dog_log._count(dog_log._num(s -> 'minceOnly')),
      'lykaPackets',    dog_log._count(dog_log._num(s -> 'lykaPackets')),
      'scratchPackets', dog_log._count(dog_log._num(s -> 'scratchPackets'))),
    'settings', jsonb_build_object(
      'totalContainers',          round(least(greatest(dog_log._num(st -> 'totalContainers', 40), 0), 1000000), 2),
      'mincePurchaseIncrementKg', inc,
      'maxFreezerContainers',     dog_log._setting(sd, 'maxFreezerContainers'),
      'maxFridgeContainers',      dog_log._setting(sd, 'maxFridgeContainers'),
      'fridgeTransferCount',      dog_log._setting(sd, 'fridgeTransferCount'),
      'fridgeTransferTime',       dog_log._setting(sd, 'fridgeTransferTime'),
      'breakfastTime',            dog_log._setting(sd, 'breakfastTime'),
      'dinnerTime',               dog_log._setting(sd, 'dinnerTime')),
    'batches',  batches,
    'history',  history,
    'calendar', jsonb_build_object('endpoint', endpoint),
    'legacy',   jsonb_build_object(
      'containersPerDay', case when jsonb_typeof(st -> 'containersPerDay') = 'number' then to_jsonb(dog_log._num(st -> 'containersPerDay')) else '2'::jsonb end,
      'lastAutoDate',     case when jsonb_typeof(tr -> 'lastAutoDate') = 'string' then to_jsonb(left(tr ->> 'lastAutoDate', 40)) else 'null'::jsonb end));
end; $$;

-- S2: the owner the current server entry point is acting for, bound for this
-- transaction only. It replaces auth.uid() in the internal owner guard.
create function dog_log._request_owner()
returns uuid language sql stable
set search_path = pg_catalog, pg_temp as $$
  select nullif(pg_catalog.current_setting('dog_log.request_owner', true), '')::uuid
$$;

create function dog_log._bind_request_owner(p_owner uuid)
returns uuid language plpgsql volatile
set search_path = pg_catalog, pg_temp as $$
begin
  if p_owner is null then
    return null;
  end if;
  perform pg_catalog.set_config('dog_log.request_owner', p_owner::text, true);
  return p_owner;
end $$;

-- Scheduled meal and transfer processor, WORK-287 equal-time fix included.
-- Only change (S2): the owner guard reads dog_log._request_owner() instead of auth.uid().
create function dog_log._process_due_meals(p_owner uuid, p_until timestamp with time zone, p_device text)
returns boolean language plpgsql volatile
set search_path = pg_catalog, pg_temp as $$
declare
  r           dog_log.state%rowtype;
  v_doc       jsonb;
  v_tz        text;
  v_cursor    timestamptz;
  v_from      timestamptz;
  v_day       date;
  v_slot      text;
  v_slots     text[];
  v_label     text;
  v_at        timestamptz;
  v_fridge    numeric;
  v_freezer   numeric;
  v_outcome   text;
  v_source    text;
  v_ins       int;
  v_entries   text[] := '{}';
  v_fed       int := 0;
  v_meals     int := 0;
  v_transfers int := 0;
  v_want      numeric;
  v_move      numeric := 0;
  v_moved     numeric := 0;
  v_ttime     text;
  v_changed   boolean := false;
begin
  if (select dog_log._request_owner()) is not null and (select dog_log._request_owner()) <> p_owner then
    raise exception 'owner_mismatch' using errcode = '42501';
  end if;
  if p_until > now() then
    raise exception 'meal processing time is in the future' using errcode = '22023';
  end if;

  select * into r from dog_log.state where owner_id = p_owner for update;
  if not found then return false; end if;
  v_doc := r.doc; v_tz := r.time_zone; v_cursor := r.meal_cursor;
  v_want  := (dog_log._setting(v_doc, 'fridgeTransferCount') #>> '{}')::numeric;
  v_ttime := dog_log._setting(v_doc, 'fridgeTransferTime') #>> '{}';
  select array_agg(x.s order by dog_log._sched_time(v_doc, x.s), x.o) into v_slots
    from (values ('breakfast', 0), ('dinner', 1), ('transfer', 2)) x(s, o);

  -- First run (WORK-135): start tracking now; today's already-passed slots are 'before-tracking'.
  if v_cursor is null then
    v_day := (p_until at time zone v_tz)::date;
    foreach v_slot in array v_slots loop
      v_at := (v_day + dog_log._sched_time(v_doc, v_slot)) at time zone v_tz;
      if v_at <= p_until then
        insert into dog_log.meal_events (owner_id, meal_date, slot, outcome, slot_at, processed_by_device, state_revision, origin)
        values (p_owner, v_day, v_slot, 'before-tracking', v_at, p_device, r.revision + 1, 'server')
        on conflict do nothing;
      end if;
    end loop;
    v_doc := dog_log._history_push(v_doc, now(),
      'Meal schedule started: Breakfast ' || (dog_log._setting(v_doc, 'breakfastTime') #>> '{}') ||
      ' and Dinner ' || (dog_log._setting(v_doc, 'dinnerTime') #>> '{}') ||
      ' each use 1 Full Container. Existing stock kept as recorded.');
    update dog_log.state
       set doc = v_doc, meal_cursor = p_until, meal_tracking_since = coalesce(meal_tracking_since, p_until)
     where owner_id = p_owner;
    return true;
  end if;

  if p_until <= v_cursor then return false; end if;
  -- Bound the catch-up walk (at most ~1200 events) so a corrupt or ancient cursor can
  -- never make every sync time out; older slots are beyond meal_events retention anyway.
  v_cursor := greatest(v_cursor, p_until - interval '400 days');
  v_from := v_cursor;     -- WORK-287: due means after the cursor the walk started from

  for v_day in select d::date from generate_series((v_cursor at time zone v_tz)::date, (p_until at time zone v_tz)::date, interval '1 day') d loop
    foreach v_slot in array v_slots loop
      v_at := (v_day + dog_log._sched_time(v_doc, v_slot)) at time zone v_tz;
      continue when v_at <= v_from or v_at > p_until;

      v_fridge  := coalesce((v_doc #>> '{stock,fridge}')::numeric, 0);
      v_freezer := coalesce((v_doc #>> '{stock,freezer}')::numeric, 0);

      if v_slot = 'transfer' then
        v_ins := 0;
        -- A WORK-147 Dinner already moved this day's containers: never transfer twice.
        if not exists (select 1 from dog_log.meal_events
                        where owner_id = p_owner and meal_date = v_day and slot = 'dinner'
                          and freezer_to_fridge_count is not null) then
          v_move := least(greatest(v_freezer, 0), v_want);
          insert into dog_log.meal_events (owner_id, meal_date, slot, outcome, freezer_to_fridge_count, slot_at, processed_by_device, state_revision, origin)
          values (p_owner, v_day, 'transfer', 'transferred', v_move::smallint, v_at, p_device, r.revision + 1, 'server')
          on conflict do nothing;
          get diagnostics v_ins = row_count;
        end if;
        if v_ins = 1 then
          if v_move > 0 then
            v_doc := jsonb_set(v_doc, '{stock,freezer}', to_jsonb(v_freezer - v_move));
            v_doc := jsonb_set(v_doc, '{stock,fridge}',  to_jsonb(v_fridge + v_move));
          end if;
          if v_want > 0 then
            v_transfers := v_transfers + 1;
            v_moved := v_moved + v_move;
            v_label := v_ttime || ' freezer-to-fridge transfer ' || dog_log._fmt_day(v_at, v_tz);
            if v_move = 0 then
              v_entries := v_entries || (v_label || ': no Full Containers available in Freezer');
            elsif v_move = 1 then
              v_entries := v_entries || (v_label || ': 1 Full Container moved from Freezer to Fridge');
            else
              v_entries := v_entries || (v_label || ': ' || v_move::bigint || ' Full Containers moved from Freezer to Fridge');
            end if;
          end if;
        end if;
      else
        if v_fridge + v_freezer > 0 then
          v_outcome := 'fed';
          v_source  := case when v_fridge > 0 then 'fridge' else 'freezer' end;
        else
          v_outcome := 'no-stock';
          v_source  := null;
        end if;

        insert into dog_log.meal_events (owner_id, meal_date, slot, outcome, source_container, slot_at, processed_by_device, state_revision, origin)
        values (p_owner, v_day, v_slot, v_outcome, v_source, v_at, p_device, r.revision + 1, 'server')
        on conflict do nothing;
        get diagnostics v_ins = row_count;

        if v_ins = 1 then
          v_meals := v_meals + 1;
          v_label := case v_slot when 'breakfast' then 'Breakfast' else 'Dinner' end || ' ' || dog_log._fmt_day(v_at, v_tz);
          if v_outcome = 'fed' then
            -- client deductPrepared(1): fridge first, remainder from freezer
            v_doc := jsonb_set(v_doc, '{stock,fridge}', to_jsonb(greatest(v_fridge - least(v_fridge, 1), 0)));
            if v_fridge < 1 then
              v_doc := jsonb_set(v_doc, '{stock,freezer}', to_jsonb(greatest(v_freezer - least(v_freezer, 1 - v_fridge), 0)));
            end if;
            v_fed := v_fed + 1;
            v_entries := v_entries || (v_label || ': 1 Full Container used (' || v_source || ')');
          else
            v_entries := v_entries || (v_label || ': no Full Container available');
          end if;
        end if;
      end if;
      v_cursor := v_at;       -- the cursor advances past every due slot, processed or not
      v_changed := true;
    end loop;
  end loop;

  if v_meals > 6 then
    -- Push the transfer summary first so the meal catch-up summary remains the newest entry.
    if v_transfers > 0 then
      v_doc := dog_log._history_push(v_doc, now(),
        'Automatic ' || v_ttime || ' freezer-to-fridge transfers caught up: ' || v_moved::bigint ||
        ' Full Containers moved across ' || v_transfers || ' days');
    end if;
    v_doc := dog_log._history_push(v_doc, now(),
      'Scheduled meals caught up: ' || v_meals || ' meals, ' || v_fed || ' Full Containers used');
  else
    for i in 1 .. coalesce(cardinality(v_entries), 0) loop
      v_doc := dog_log._history_push(v_doc, now(), v_entries[i]);
    end loop;
  end if;

  if v_changed then
    update dog_log.state set doc = v_doc, meal_cursor = v_cursor where owner_id = p_owner;
  end if;
  return v_changed;
end; $$;

create function dog_log._apply_op(p_owner uuid, p_op jsonb, p_cc timestamp with time zone, p_start_revision bigint)
returns jsonb language plpgsql volatile
set search_path = pg_catalog, pg_temp as $$
declare
  r          dog_log.state%rowtype;
  v_doc      jsonb;
  v_type     text := p_op ->> 'type';
  v_key      text;
  v_label    text := case when jsonb_typeof(p_op -> 'label') = 'string' and length(p_op ->> 'label') > 0 then left(p_op ->> 'label', 500) end;
  v_cur      numeric;
  v_val      numeric;
  v_exp      numeric;
  v_delta    numeric;
  v_new      numeric;
  v_fed      numeric;
  v_transferred numeric := 0;
  v_effect   numeric := 0;
  v_move     numeric := 0;
  v_event    record;
  v_status   text := 'applied';
  v_detail   jsonb := '{}'::jsonb;
  v_conf     jsonb := '[]'::jsonb;
  v_dest     text;
  v_n        int;
  v_text     text;
  v_before   timestamptz;
  v_snapshot text;
  v_jcur     jsonb;
  v_jval     jsonb;
  v_jexp     jsonb;
  v_ok       boolean;
begin
  select * into r from dog_log.state where owner_id = p_owner for update;
  v_doc := r.doc;

  if v_type = 'adjust' then
    v_key := p_op ->> 'key';
    if not dog_log._is_stock_key(v_key) or jsonb_typeof(p_op -> 'delta') is distinct from 'number' then
      return jsonb_build_object('status', 'rejected', 'detail', jsonb_build_object('reason', 'invalid adjust'));
    end if;
    v_delta := (p_op ->> 'delta')::numeric;
    if abs(v_delta) > 1000000 then
      return jsonb_build_object('status', 'rejected', 'detail', jsonb_build_object('reason', 'delta out of range'));
    end if;
    if dog_log._is_count_key(v_key) and v_delta <> round(v_delta) then
      return jsonb_build_object('status', 'rejected', 'detail', jsonb_build_object('reason', 'count delta must be an integer'));
    end if;
    v_cur := coalesce((v_doc #>> array['stock', v_key])::numeric, 0);
    v_new := dog_log._stock_val(v_key, v_cur + v_delta);
    if v_cur + v_delta < 0 then v_status := 'applied-clamped'; end if;
    v_doc := jsonb_set(v_doc, array['stock', v_key], to_jsonb(v_new));
    v_detail := jsonb_build_object('key', v_key, 'before', v_cur, 'after', v_new);

  elsif v_type = 'set' then
    -- Conditional recount rebased to its own time (R2).
    v_key := p_op ->> 'key';
    if not dog_log._is_stock_key(v_key) or jsonb_typeof(p_op -> 'value') is distinct from 'number' or jsonb_typeof(p_op -> 'expected') is distinct from 'number' then
      return jsonb_build_object('status', 'rejected', 'detail', jsonb_build_object('reason', 'invalid set'));
    end if;
    v_cur := coalesce((v_doc #>> array['stock', v_key])::numeric, 0);
    v_val := dog_log._stock_val(v_key, (p_op ->> 'value')::numeric);
    v_exp := dog_log._stock_val(v_key, (p_op ->> 'expected')::numeric);
    v_fed := 0;
    v_transferred := 0;
    v_effect := 0;
    if v_key in ('fridge', 'freezer') then
      select count(*) filter (where outcome = 'fed' and source_container = v_key),
             coalesce(sum(freezer_to_fridge_count), 0)
        into v_fed, v_transferred
        from dog_log.meal_events
       where owner_id = p_owner and slot_at > p_cc;
      -- Net server-side stock effect since the recount: meals consume from their recorded
      -- source; transfers (WORK-147 dinner rows and WORK-148 transfer rows) add to fridge
      -- and subtract from freezer.
      v_effect := case when v_key = 'fridge'
                       then -v_fed + v_transferred
                       else -v_fed - v_transferred end;
    end if;
    if dog_log._stock_val(v_key, v_cur - v_effect) <> v_exp then
      return jsonb_build_object('status', 'conflict', 'detail', jsonb_build_object(
        'key', v_key, 'current', v_cur, 'attempted', v_val, 'expected', v_exp,
        'rebased', dog_log._stock_val(v_key, v_val + v_effect),
        'fed_since', v_fed, 'transferred_since', v_transferred));
    end if;
    v_new := dog_log._stock_val(v_key, v_val + v_effect);
    if v_val + v_effect < 0 then v_status := 'applied-clamped'; end if;
    v_doc := jsonb_set(v_doc, array['stock', v_key], to_jsonb(v_new));
    v_detail := jsonb_build_object('key', v_key, 'before', v_cur, 'after', v_new,
                                   'fed_since', v_fed, 'transferred_since', v_transferred);

  elsif v_type = 'prep_batch' then
    v_dest := p_op ->> 'destination';
    if coalesce(v_dest, '') not in ('fridge', 'freezer') or jsonb_typeof(p_op -> 'containers') is distinct from 'number'
       or (p_op ->> 'containers')::numeric <= 0 or (p_op ->> 'containers')::numeric <> round((p_op ->> 'containers')::numeric)
       or jsonb_typeof(p_op -> 'batch') is distinct from 'object' then
      return jsonb_build_object('status', 'rejected', 'detail', jsonb_build_object('reason', 'invalid prep_batch'));
    end if;
    -- The batch and its containers are additive facts: always applied.
    v_doc := jsonb_set(v_doc, '{batches}',
      (select coalesce(jsonb_agg(e order by ord), '[]'::jsonb) from (
         select e, ord from (
           select (dog_log._norm_doc(jsonb_build_object('batches', jsonb_build_array(p_op -> 'batch'))) -> 'batches' -> 0) as e, 0::bigint as ord
           union all
           select b.e, b.ord from jsonb_array_elements(v_doc -> 'batches') with ordinality as b(e, ord)
         ) x order by ord limit 50) y));
    v_cur := coalesce((v_doc #>> array['stock', v_dest])::numeric, 0);
    v_doc := jsonb_set(v_doc, array['stock', v_dest], to_jsonb(dog_log._count(v_cur + (p_op ->> 'containers')::numeric)));
    -- Ingredient left-overs are conditional sets, each able to conflict independently.
    foreach v_key in array array['minceKg', 'neckPackets'] loop
      v_text := case v_key when 'minceKg' then 'minceLeftKg' else 'neckPacketsLeft' end;
      if jsonb_typeof(p_op -> v_text) = 'number' then
        v_cur := coalesce((v_doc #>> array['stock', v_key])::numeric, 0);
        v_val := dog_log._stock_val(v_key, (p_op ->> v_text)::numeric);
        v_exp := case when jsonb_typeof(p_op -> case v_key when 'minceKg' then 'expectedMinceKg' else 'expectedNeckPackets' end) = 'number'
                      then dog_log._stock_val(v_key, (p_op ->> case v_key when 'minceKg' then 'expectedMinceKg' else 'expectedNeckPackets' end)::numeric) end;
        if v_exp is not null and v_cur = v_exp then
          v_doc := jsonb_set(v_doc, array['stock', v_key], to_jsonb(v_val));
        else
          v_conf := v_conf || jsonb_build_object('key', v_key, 'current', v_cur, 'attempted', v_val, 'expected', v_exp, 'rebased', v_val);
        end if;
      end if;
    end loop;
    v_detail := jsonb_build_object('destination', v_dest, 'containers', (p_op ->> 'containers')::numeric);
    if jsonb_array_length(v_conf) > 0 then
      v_status := 'conflict';
      v_detail := v_detail || jsonb_build_object('partial', true, 'conflicts', v_conf);
    end if;

  elsif v_type = 'settings' and (p_op ->> 'field') in ('totalContainers', 'mincePurchaseIncrementKg') then
    v_key := p_op ->> 'field';
    if jsonb_typeof(p_op -> 'value') is distinct from 'number' or jsonb_typeof(p_op -> 'expected') is distinct from 'number' then
      return jsonb_build_object('status', 'rejected', 'detail', jsonb_build_object('reason', 'invalid settings'));
    end if;
    v_cur := coalesce((v_doc #>> array['settings', v_key])::numeric, 0);
    if v_key = 'totalContainers' then
      v_val := round(greatest((p_op ->> 'value')::numeric, 0), 2);
      v_exp := round(greatest((p_op ->> 'expected')::numeric, 0), 2);
    else
      v_val := greatest(0.1, dog_log._kg((p_op ->> 'value')::numeric));
      v_exp := dog_log._kg((p_op ->> 'expected')::numeric);
    end if;
    if v_cur <> v_exp then
      return jsonb_build_object('status', 'conflict', 'detail', jsonb_build_object(
        'field', v_key, 'current', v_cur, 'attempted', v_val, 'expected', v_exp, 'rebased', v_val));
    end if;
    v_doc := jsonb_set(v_doc, array['settings', v_key], to_jsonb(v_val));
    v_detail := jsonb_build_object('field', v_key, 'before', v_cur, 'after', v_val);

  elsif v_type = 'settings' then
    -- WORK-148 Food settings: conditional on the effective (defaulted) current value.
    v_key  := p_op ->> 'field';
    v_jval := p_op -> 'value';
    v_jexp := p_op -> 'expected';
    if coalesce(v_key, '') in ('breakfastTime', 'dinnerTime', 'fridgeTransferTime') then
      v_ok := jsonb_typeof(v_jval) = 'string' and (v_jval #>> '{}') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
              and jsonb_typeof(v_jexp) = 'string';
    elsif coalesce(v_key, '') in ('fridgeTransferCount', 'maxFreezerContainers', 'maxFridgeContainers') then
      -- Nested checks: the numeric cast only ever sees a JSON number.
      v_ok := false;
      if jsonb_typeof(v_jval) = 'number' then
        v_val := (v_jval #>> '{}')::numeric;
        if v_val = round(v_val) and v_val between 0 and (case v_key when 'fridgeTransferCount' then 100 else 1000000 end) then
          v_ok := true;
          v_jval := to_jsonb(round(v_val));
        end if;
      elsif v_key = 'maxFridgeContainers' and jsonb_typeof(v_jval) = 'null' then
        v_ok := true;
      end if;
      v_ok := v_ok and (jsonb_typeof(v_jexp) = 'number' or (v_key = 'maxFridgeContainers' and jsonb_typeof(v_jexp) = 'null'));
    else
      v_ok := false;
    end if;
    if not coalesce(v_ok, false) then
      return jsonb_build_object('status', 'rejected', 'detail', jsonb_build_object('reason', 'invalid settings'));
    end if;
    v_jcur := dog_log._setting(v_doc, v_key);
    if v_jcur is distinct from v_jexp then
      return jsonb_build_object('status', 'conflict', 'detail', jsonb_build_object(
        'field', v_key, 'current', v_jcur, 'attempted', v_jval, 'expected', v_jexp, 'rebased', v_jval));
    end if;
    v_doc := jsonb_set(v_doc, '{settings}',
      case when jsonb_typeof(v_doc -> 'settings') = 'object' then v_doc -> 'settings' else '{}'::jsonb end
      || jsonb_build_object(v_key, v_jval));
    v_detail := jsonb_build_object('field', v_key, 'before', v_jcur, 'after', v_jval);

  elsif v_type = 'calendar_endpoint' then
    if jsonb_typeof(p_op -> 'value') is distinct from 'string' or jsonb_typeof(p_op -> 'expected') is distinct from 'string'
       or not ((p_op ->> 'value') = '' or (p_op ->> 'value') ~ '^https://script\.google\.com/macros/s/[^/\s]+/exec$') then
      return jsonb_build_object('status', 'rejected', 'detail', jsonb_build_object('reason', 'invalid calendar_endpoint'));
    end if;
    if coalesce(v_doc #>> '{calendar,endpoint}', '') <> (p_op ->> 'expected') then
      return jsonb_build_object('status', 'conflict', 'detail', jsonb_build_object(
        'field', 'calendar.endpoint', 'current', coalesce(v_doc #>> '{calendar,endpoint}', ''),
        'attempted', p_op ->> 'value', 'expected', p_op ->> 'expected'));
    end if;
    v_doc := jsonb_set(v_doc, '{calendar}', jsonb_build_object('endpoint', p_op ->> 'value'));

  elsif v_type = 'clear_history' then
    v_before := dog_log._try_ts(p_op ->> 'before');
    if v_before is null then
      return jsonb_build_object('status', 'rejected', 'detail', jsonb_build_object('reason', 'invalid clear_history'));
    end if;
    -- Only entries at or before the clear time go; entries synced later from another device survive.
    v_doc := jsonb_set(v_doc, '{history}',
      (select coalesce(jsonb_agg(h.e order by h.ord), '[]'::jsonb)
         from jsonb_array_elements(v_doc -> 'history') with ordinality as h(e, ord)
        where dog_log._try_ts(h.e ->> 'at') > v_before));

  elsif v_type = 'replace_state' then
    -- Explicit restore only; revision-checked against the revision the client observed.
    if jsonb_typeof(p_op -> 'doc') is distinct from 'object' or jsonb_typeof(p_op -> 'expected_revision') is distinct from 'number' then
      return jsonb_build_object('status', 'rejected', 'detail', jsonb_build_object('reason', 'invalid replace_state'));
    end if;
    if (p_op ->> 'expected_revision')::bigint <> p_start_revision then
      return jsonb_build_object('status', 'conflict', 'detail', jsonb_build_object(
        'current_revision', p_start_revision, 'expected_revision', (p_op ->> 'expected_revision')::bigint));
    end if;
    v_before := null;
    if coalesce((p_op ->> 'subtract_meals_since')::boolean, false) then
      v_before := dog_log._try_ts(p_op ->> 'backup_created_at');
      if v_before is null then
        return jsonb_build_object('status', 'rejected', 'detail', jsonb_build_object('reason', 'backup_created_at required'));
      end if;
    end if;
    v_snapshot := case when p_op ->> 'reason' = 'restore-backup' then 'pre-restore' else 'pre-replace' end;
    insert into dog_log.state_snapshots (owner_id, reason, revision, doc) values (p_owner, v_snapshot, r.revision, r.doc);
    -- The server meal cursor and meal_events are kept; the backup's own tracking is ignored (R8).
    v_doc := dog_log._norm_doc(p_op -> 'doc');
    v_n := 0;
    v_transferred := 0;
    if v_before is not null then
      -- Replay in processing order: at an equal time a meal precedes the transfer.
      for v_event in
        select outcome, freezer_to_fridge_count
          from dog_log.meal_events
         where owner_id = p_owner and slot_at > v_before
         order by slot_at, case slot when 'transfer' then 1 else 0 end
      loop
        if v_event.outcome = 'fed' then
          v_cur := (v_doc #>> '{stock,fridge}')::numeric;
          if v_cur > 0 then
            v_doc := jsonb_set(v_doc, '{stock,fridge}', to_jsonb(v_cur - 1));
          else
            v_doc := jsonb_set(v_doc, '{stock,freezer}', to_jsonb(greatest((v_doc #>> '{stock,freezer}')::numeric - 1, 0)));
          end if;
          v_n := v_n + 1;
        end if;
        if v_event.freezer_to_fridge_count is not null then
          v_cur := (v_doc #>> '{stock,freezer}')::numeric;
          v_move := least(v_cur, v_event.freezer_to_fridge_count);
          if v_move > 0 then
            v_doc := jsonb_set(v_doc, '{stock,freezer}', to_jsonb(v_cur - v_move));
            v_doc := jsonb_set(v_doc, '{stock,fridge}',
              to_jsonb((v_doc #>> '{stock,fridge}')::numeric + v_move));
            v_transferred := v_transferred + v_move;
          end if;
        end if;
      end loop;
    end if;
    v_detail := jsonb_build_object('snapshot', v_snapshot, 'meals_subtracted', v_n,
                                   'containers_transferred', v_transferred);

  else
    return jsonb_build_object('status', 'rejected', 'detail', jsonb_build_object('reason', 'unknown operation type'));
  end if;

  if v_label is not null then
    v_doc := dog_log._history_push(v_doc, p_cc, v_label);
  end if;
  update dog_log.state set doc = v_doc where owner_id = p_owner;
  return jsonb_build_object('status', v_status, 'detail', v_detail);
end; $$;

create function dog_log._state_json(p_owner uuid)
returns jsonb language sql stable
set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'revision', s.revision,
    'schema_version', s.schema_version,
    'min_client_version', s.min_client_version,
    'time_zone', s.time_zone,
    'doc', s.doc,
    'meal_cursor', s.meal_cursor,
    'meal_tracking_since', s.meal_tracking_since,
    'recent_meals', coalesce((
      select jsonb_agg(jsonb_build_object(
               'meal_date', m.meal_date, 'slot', m.slot, 'outcome', m.outcome,
               'source_container', m.source_container, 'freezer_to_fridge_count', m.freezer_to_fridge_count,
               'slot_at', m.slot_at, 'processed_at', m.processed_at,
               'processed_by_device', m.processed_by_device, 'origin', m.origin)
             order by m.slot_at, case m.slot when 'transfer' then 1 else 0 end)
        from dog_log.meal_events m
       where m.owner_id = s.owner_id
         and m.meal_date >= (now() at time zone s.time_zone)::date - 13), '[]'::jsonb),
    'server_now', now())
  from dog_log.state s
  where s.owner_id = p_owner
$$;

-- -----------------------------------------------------------------------------
-- Server entry points (EXECUTE for dog_log_api only)
-- -----------------------------------------------------------------------------

-- S1: the server API maps a verified session (provider, subject) to the app user.
-- Linking identities is an administrative act; no runtime function creates one.
create function dog_log.server_resolve_owner(p_provider text, p_subject text)
returns uuid language sql stable security definer
set search_path = pg_catalog, pg_temp as $$
  select i.user_id from dog_log.app_identity i where i.provider = p_provider and i.subject = p_subject
$$;

-- S3: First-device seed. The body is dog_log.seed_state verbatim, except that the owner is p_owner,
-- supplied by the server API from the verified session, instead of auth.uid().
create function dog_log.server_seed_state(p_owner uuid, p_seed_id uuid, p_doc jsonb, p_device_id text DEFAULT NULL::text, p_client_version integer DEFAULT 1)
returns jsonb language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp set lock_timeout = '3s' as $$
declare
  v_owner    uuid := dog_log._bind_request_owner(p_owner);
  v_device   text := left(p_device_id, 100);
  v_doc      jsonb;
  v_ms       numeric;
  v_cursor   timestamptz;
  v_since    timestamptz;
  v_existing uuid;
  v_inserted int;
  v_day      text;
  v_meals    jsonb;
  v_slot     text;
  v_status   text;
  v_out      text;
  v_at       timestamptz;
  v_ledger   boolean := coalesce(p_doc #> '{tracking,transferLedger}' = 'true'::jsonb, false);
begin
  if v_owner is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if coalesce(p_client_version, 0) < 1 then
    raise exception 'client_outdated' using errcode = '22023', hint = 'min_client_version=1';
  end if;
  if p_seed_id is null or p_doc is null or jsonb_typeof(p_doc) <> 'object' then
    raise exception 'invalid_seed' using errcode = '22023';
  end if;

  v_doc := dog_log._norm_doc(p_doc);
  v_ms := case when jsonb_typeof(p_doc #> '{tracking,mealCursor}') = 'number' then (p_doc #>> '{tracking,mealCursor}')::numeric end;
  v_cursor := case when v_ms is not null and v_ms between -8.64e15 and 8.64e15
                   then greatest(least(now(), to_timestamp(v_ms / 1000.0)), now() - interval '400 days') end;
  v_since := case when v_cursor is not null then coalesce(dog_log._try_ts(p_doc #>> '{tracking,mealTrackingSince}'), v_cursor) end;

  insert into dog_log.state (owner_id, doc, seed_id, seeded_from_device, meal_cursor, meal_tracking_since, updated_by_device)
  values (v_owner, v_doc, p_seed_id, v_device, v_cursor, v_since, v_device)
  on conflict (owner_id) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted = 0 then
    -- Nothing is overwritten: a retry of this seed, or another device's cloud copy.
    select seed_id into v_existing from dog_log.state where owner_id = v_owner;
    v_status := case when v_existing = p_seed_id then 'already-seeded' else 'cloud-exists' end;
    return jsonb_build_object('status', v_status) || jsonb_build_object('state', dog_log._state_json(v_owner));
  end if;

  if v_cursor is not null then
    -- Import the device's recent meal log so those slots can never be processed again.
    v_meals := case when jsonb_typeof(p_doc #> '{tracking,mealLog}') = 'object' then p_doc #> '{tracking,mealLog}' else '{}'::jsonb end;
    for v_day in select k from jsonb_object_keys(v_meals) k where k ~ '^\d{4}-\d{2}-\d{2}$' loop
      continue when dog_log._try_ts(v_day) is null;
      continue when v_day::date < (now() at time zone 'Australia/Melbourne')::date - 13;
      continue when jsonb_typeof(v_meals -> v_day) is distinct from 'object';
      foreach v_slot in array array['breakfast', 'dinner', 'transfer'] loop
        v_out := v_meals -> v_day ->> v_slot;
        if v_slot = 'transfer' then
          v_out := case when v_out in ('transferred', 'legacy') then 'transferred'
                        when v_out = 'before-tracking' then v_out end;
        elsif v_out not in ('fed', 'no-stock', 'before-tracking') then
          v_out := null;
        end if;
        v_at := (v_day::date + dog_log._sched_time(v_doc, v_slot)) at time zone 'Australia/Melbourne';
        if v_out is not null and v_at <= v_cursor then
          insert into dog_log.meal_events (owner_id, meal_date, slot, outcome, slot_at, processed_by_device, state_revision, origin)
          values (v_owner, v_day::date, v_slot, v_out, v_at, v_device, 1, 'seed')
          on conflict do nothing;
          if v_slot = 'dinner' and not v_ledger and v_out <> 'before-tracking' then
            insert into dog_log.meal_events (owner_id, meal_date, slot, outcome, slot_at, processed_by_device, state_revision, origin)
            values (v_owner, v_day::date, 'transfer', 'transferred', v_at, v_device, 1, 'seed')
            on conflict do nothing;
          end if;
        end if;
      end loop;
    end loop;
  else
    -- Device never started meal tracking: initialise exactly as WORK-135's first run.
    perform dog_log._process_due_meals(v_owner, now(), v_device);
  end if;

  insert into dog_log.state_snapshots (owner_id, reason, revision, doc)
  select owner_id, 'seed', revision, doc from dog_log.state where owner_id = v_owner;

  return jsonb_build_object('status', 'seeded', 'state', dog_log._state_json(v_owner));
end; $$;

-- S3: The single sync write path. The body is dog_log.sync verbatim, except that the owner is p_owner,
-- supplied by the server API from the verified session, instead of auth.uid().
create function dog_log.server_sync(p_owner uuid, p_mutations jsonb DEFAULT '[]'::jsonb, p_device_id text DEFAULT NULL::text, p_client_version integer DEFAULT 1)
returns jsonb language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp set lock_timeout = '3s' as $$
declare
  v_owner    uuid := dog_log._bind_request_owner(p_owner);
  v_device   text := left(p_device_id, 100);
  r0         dog_log.state%rowtype;
  r1         dog_log.state%rowtype;
  v_m        jsonb;
  v_id       uuid;
  v_cc       timestamptz;
  v_prior    dog_log.mutations%rowtype;
  v_res      jsonb;
  v_results  jsonb := '[]'::jsonb;
  v_ord      bigint;
  v_cursor   timestamptz;
  v_revision bigint;
begin
  if v_owner is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if p_mutations is null then p_mutations := '[]'::jsonb; end if;
  if jsonb_typeof(p_mutations) <> 'array' then
    raise exception 'invalid_mutations' using errcode = '22023';
  end if;
  if jsonb_array_length(p_mutations) > 50 then
    raise exception 'too_many_mutations' using errcode = '22023';
  end if;

  select * into r0 from dog_log.state where owner_id = v_owner for update;
  if not found then
    return jsonb_build_object('status', 'no-cloud-state');
  end if;
  if coalesce(p_client_version, 0) < r0.min_client_version then
    raise exception 'client_outdated' using errcode = '22023',
      hint = 'min_client_version=' || r0.min_client_version;
  end if;

  -- Section 7/R1: ops are applied in the order the user made them (client_created_at),
  -- ties and unparsable times in submitted order.
  for v_m, v_ord in select e, ord from jsonb_array_elements(p_mutations) with ordinality as t(e, ord)
              order by dog_log._try_ts(case when jsonb_typeof(e) = 'object' then e ->> 'client_created_at' end) nulls last, ord loop
    v_id := null;
    begin
      v_id := (v_m ->> 'mutation_id')::uuid;
    exception when others then
      v_id := null;
    end;
    if v_id is null or jsonb_typeof(v_m) <> 'object' then
      v_results := v_results || jsonb_build_object('_ord', v_ord, 'mutation_id', v_m -> 'mutation_id', 'status', 'rejected',
                                                   'detail', jsonb_build_object('reason', 'invalid mutation_id'));
      continue;
    end if;

    select * into v_prior from dog_log.mutations where owner_id = v_owner and mutation_id = v_id;
    if found then
      v_results := v_results || jsonb_build_object('_ord', v_ord, 'mutation_id', v_id, 'status', 'duplicate',
        'original_status', v_prior.status, 'detail', v_prior.detail, 'result_revision', v_prior.result_revision);
      continue;
    end if;

    v_cc := dog_log._try_ts(v_m ->> 'client_created_at');
    if v_cc is null or v_cc > now() + interval '1 day' then
      v_res := jsonb_build_object('status', 'rejected', 'detail', jsonb_build_object('reason', 'invalid client_created_at'));
    elsif v_cc < now() - interval '30 days' then
      v_res := jsonb_build_object('status', 'expired', 'detail', jsonb_build_object('reason', 'older than 30 days'));
    else
      -- R1: first process meals due up to the moment the user acted, then apply the op.
      select meal_cursor into v_cursor from dog_log.state where owner_id = v_owner;
      perform dog_log._process_due_meals(v_owner, least(greatest(v_cc, coalesce(v_cursor, v_cc)), now()), v_device);
      begin
        v_res := dog_log._apply_op(v_owner, v_m, least(v_cc, now()), r0.revision);
      exception
        when lock_not_available or query_canceled then raise;   -- retryable: propagate to the client
        when others then
          v_res := jsonb_build_object('status', 'rejected', 'detail', jsonb_build_object('reason', 'invalid operation', 'sqlstate', sqlstate));
      end;
    end if;

    insert into dog_log.mutations (owner_id, mutation_id, device_id, op_type, client_created_at, status, detail)
    values (v_owner, v_id, coalesce(left(v_m ->> 'device_id', 100), v_device), left(v_m ->> 'type', 50), v_cc,
            v_res ->> 'status', v_res -> 'detail');
    v_results := v_results || (jsonb_build_object('_ord', v_ord, 'mutation_id', v_id) || v_res);
  end loop;
  -- Results are returned in submitted order, whatever order the ops were applied in.
  select coalesce(jsonb_agg(x - '_ord' order by (x ->> '_ord')::bigint), '[]'::jsonb) into v_results
    from jsonb_array_elements(v_results) x;

  perform dog_log._process_due_meals(v_owner, now(), v_device);

  select * into r1 from dog_log.state where owner_id = v_owner;
  v_revision := r0.revision;
  if r1.doc is distinct from r0.doc or r1.meal_cursor is distinct from r0.meal_cursor
     or r1.meal_tracking_since is distinct from r0.meal_tracking_since then
    v_revision := r0.revision + 1;
    update dog_log.state set revision = v_revision, updated_at = now(), updated_by_device = v_device
     where owner_id = v_owner;
  end if;
  update dog_log.mutations set result_revision = v_revision
   where owner_id = v_owner and result_revision is null;

  -- Retention (section 9, R11).
  delete from dog_log.mutations
   where owner_id = v_owner and applied_at < now() - interval '90 days'
     and (client_created_at is null or client_created_at < now() - interval '90 days');
  delete from dog_log.meal_events where owner_id = v_owner and slot_at < now() - interval '400 days';
  delete from dog_log.state_snapshots
   where owner_id = v_owner
     and id not in (select id from dog_log.state_snapshots where owner_id = v_owner order by id desc limit 20);

  return jsonb_build_object('status', 'ok', 'results', v_results) || dog_log._state_json(v_owner);
end $$;

-- -----------------------------------------------------------------------------
-- Privileges (S4). Revoke explicitly on every object, because PostgreSQL grants
-- EXECUTE on new functions to PUBLIC and global defaults may add more. Then grant
-- dog_log_api EXECUTE on the three server entry points and nothing else.
-- -----------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select c.oid::regclass as obj, c.relkind from pg_catalog.pg_class c
            where c.relnamespace = 'dog_log'::regnamespace and c.relkind in ('r', 'S') loop
    execute format('revoke all on %s %s from public, dog_log_api',
                   case r.relkind when 'S' then 'sequence' else 'table' end, r.obj);
  end loop;
  for r in select p.oid::regprocedure as fn from pg_catalog.pg_proc p
            where p.pronamespace = 'dog_log'::regnamespace loop
    execute format('revoke all on function %s from public, dog_log_api', r.fn);
  end loop;
end $$;

grant execute on function
  dog_log.server_resolve_owner(text, text),
  dog_log.server_seed_state(uuid, uuid, jsonb, text, integer),
  dog_log.server_sync(uuid, jsonb, text, integer)
  to dog_log_api;

-- Row level security with no policies: any role other than the table owner that
-- somehow gains a table privilege still sees and changes no row. The server
-- entry points run as the owner (SECURITY DEFINER) and enforce ownership themselves.
alter table dog_log.app_user        enable row level security;
alter table dog_log.app_identity    enable row level security;
alter table dog_log.state           enable row level security;
alter table dog_log.meal_events     enable row level security;
alter table dog_log.mutations       enable row level security;
alter table dog_log.state_snapshots enable row level security;

-- -----------------------------------------------------------------------------
-- Applied history. A minimal ledger that backend-preflight verify-applied reads to
-- confirm an apply. It lives outside dog_log, so a pre-adoption rollback can drop
-- dog_log and keep the ledger, less this change's row. Only the owner reads or
-- writes it; neither PUBLIC nor dog_log_api has any privilege on it.
-- -----------------------------------------------------------------------------
create schema if not exists dog_log_migrations;
comment on schema dog_log_migrations is 'Applied-migration ledger for the Dog Log Neon schema (WORK-274). Written only by migration and rollback files, inside their own transaction.';
revoke all on schema dog_log_migrations from public;

create table if not exists dog_log_migrations.schema_migrations (
  version    text        not null,
  applied_at timestamptz not null default now(),
  constraint schema_migrations_pkey primary key (version),
  constraint schema_migrations_version_check check (version ~ '^[0-9]{14}_dog_log_[a-z0-9_]+$')
);
revoke all on table dog_log_migrations.schema_migrations from public, dog_log_api;

-- The record commits with everything above, or not at all.
insert into dog_log_migrations.schema_migrations (version)
values ('20261110120000_dog_log_portable_schema');

commit;
