-- =============================================================================
-- WORK-287: process an equal-time freezer-to-fridge transfer.
--
-- Defect (20260926130000, WORK-148): _process_due_meals skipped every slot due at
-- the same instant as the slot processed just before it. The walk compared each
-- slot with v_cursor, which it also advanced inside the loop, so once Dinner at
-- 18:00 had run, the transfer at 18:00 was treated as already processed. Both
-- default to 18:00, so with default settings the server never ran the daily
-- transfer, and the persisted cursor kept that day's transfer skipped.
--
-- Fix: compare each slot with the cursor as it stood when the walk started
-- (v_from), which is the function's stated contract: every event in
-- (meal_cursor, p_until] runs exactly once. v_cursor still advances to the last
-- due slot and is persisted as before. Exactly-once stays with the meal_events
-- primary key (owner_id, meal_date, slot); equal-time order stays Breakfast,
-- Dinner, then the transfer. Nothing else in the function changes.
--
-- Past days are not backfilled: their slots are at or before the stored cursor,
-- so this migration creates no historical transfer rows and changes no stock.
--
-- Applying is a separate, operator-approved act (ENVIRONMENT_LIFECYCLE 10).
-- Rollback: supabase/rollbacks/20261031213557_dog_log_fix_equal_time_transfer.rollback.sql
-- =============================================================================

create or replace function dog_log._process_due_meals(p_owner uuid, p_until timestamptz, p_device text)
returns boolean language plpgsql volatile set search_path = pg_catalog, pg_temp as $$
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
  if (select auth.uid()) is not null and (select auth.uid()) <> p_owner then
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

revoke all on function dog_log._process_due_meals(uuid, timestamptz, text) from public, anon, authenticated, service_role;
comment on function dog_log._process_due_meals(uuid, timestamptz, text) is
  'Internal exactly-once processor for configured Breakfast/Dinner meals and the independent daily freezer-to-fridge transfer (WORK-148; equal-time transfer fixed by WORK-287).';
notify pgrst, 'reload schema';
