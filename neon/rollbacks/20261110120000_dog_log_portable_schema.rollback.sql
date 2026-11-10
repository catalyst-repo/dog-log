-- =============================================================================
-- Rollback for neon/migrations/20261110120000_dog_log_portable_schema.sql (WORK-274)
--
-- Pre-adoption only. It removes the dog_log schema from a Neon target that holds
-- no Dog Log account or state yet. Once any app_user or state row exists, it
-- refuses: that target may hold the only copy of real Dog Log data, and dropping
-- it would destroy that data. Removing an adopted target is a separate, explicitly
-- approved act: export first, then delete the rows, and only then run this file.
--
-- The NOLOGIN group role dog_log_api is kept. Its login member (the runtime
-- credential) is managed by the human ADMIN outside this file, so the role is
-- removed by hand after that member is revoked. Re-applying the migration reuses it.
--
-- Running this file is a separate, governed act, like applying the migration.
-- =============================================================================
begin;

lock table dog_log.app_user, dog_log.app_identity, dog_log.state in access exclusive mode;

do $$
begin
  if exists (select 1 from dog_log.state) or exists (select 1 from dog_log.app_user) then
    raise exception 'rollback refused: dog_log holds account or state rows; export and remove them under explicit approval first';
  end if;
end $$;

drop schema dog_log cascade;

commit;
