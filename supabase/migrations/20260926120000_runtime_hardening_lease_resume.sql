-- =============================================================================
-- MVP-5.36H1 — Level-6 runtime hardening: scheduler slot lease, resumable
-- attempt metadata, lease-aware single-flight claim, resume selection and a
-- resumability-aware reconciler (H0 Option C: lease-serialized, resumable,
-- single-flight). ADDITIVE ONLY:
--   * the v1 claim_runtime_publications(p_cap) and
--     reconcile_stale_runtime_publications(p_stale_seconds) are unchanged and
--     remain the functions the currently deployed runtime calls;
--   * the new functions are overloads / new names the H2 runtime will adopt.
--
-- Invariants (DB clock only):
--   * scheduler delivery is AT-LEAST-ONCE: at most ONE worker (lease holder)
--     per 5-minute logical slot; duplicates never acquire;
--   * a lease is "valid" for its holder while uncompleted and acquired less
--     than 60 s ago (> the 30 s scheduled-function ceiling); while one is
--     valid no other lease can be acquired (cross-slot overlap guard);
--   * single-flight: at most ONE in-flight ('publishing') runtime publication
--     per runtime key; claim returns nothing while one exists, so RESUME
--     necessarily takes precedence over CLAIM;
--   * container readiness may span invocations for READINESS_MAX = 15 min.
-- All lease/claim/resume/reconcile entry points serialize on one advisory
-- transaction lock per runtime key.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Slot lease
-- -----------------------------------------------------------------------------

create table public.publishing_runtime_slot_lease (
  runtime_key text not null check (runtime_key = 'instagram_scheduled_publishing'),
  slot_start timestamptz not null,
  run_id uuid not null,
  acquired_at timestamptz not null default now(),
  completed_at timestamptz null,
  outcome text null check (outcome is null or outcome ~ '^[a-z0-9_]{1,64}$'),
  duplicate_count integer not null default 0 check (duplicate_count >= 0),
  constraint publishing_runtime_slot_lease_pkey primary key (runtime_key, slot_start),
  constraint publishing_runtime_slot_lease_completion_check check ((completed_at is null) = (outcome is null))
);

comment on table public.publishing_runtime_slot_lease is
  'Level-6 scheduler slot lease (MVP-5.36H1): one row per DB-clock 5-minute slot; only its holder (run_id) may work in that slot. Duplicate deliveries increment duplicate_count. Rows are evidence and are never deleted by the runtime. Service-role only.';

create index publishing_runtime_slot_lease_open_idx
  on public.publishing_runtime_slot_lease (runtime_key, acquired_at desc)
  where completed_at is null;

create unique index publishing_runtime_slot_lease_run_id_key
  on public.publishing_runtime_slot_lease (run_id);

alter table public.publishing_runtime_slot_lease enable row level security;

-- Explicit ACL: do not rely on (hosted) default privileges.
revoke all on table public.publishing_runtime_slot_lease from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.publishing_runtime_slot_lease to service_role;

-- -----------------------------------------------------------------------------
-- 2. Resumable attempt metadata (no new stages)
-- -----------------------------------------------------------------------------

alter table public.publication_attempts
  add column container_create_requested_at timestamptz null,
  add column container_created_at timestamptz null,
  add column status_poll_count integer not null default 0,
  add column last_run_id uuid null;

alter table public.publication_attempts
  add constraint publication_attempts_status_poll_count_check check (status_poll_count >= 0),
  add constraint publication_attempts_container_created_at_check
    check (container_created_at is null or jsonb_array_length(container_ids) > 0);

comment on column public.publication_attempts.container_create_requested_at is
  'MVP-5.36H1: committed BEFORE the container-creation request (G1) is dispatched. Set + no recorded container = G1 outcome unknown; never re-dispatched.';
comment on column public.publication_attempts.container_created_at is
  'MVP-5.36H1: when the container id was recorded; READINESS_MAX (15 min) is measured from here.';
comment on column public.publication_attempts.last_run_id is
  'MVP-5.36H1: runId of the lease holder that last selected/worked this attempt.';

-- -----------------------------------------------------------------------------
-- 3. Internal helpers (not granted to any API role)
-- -----------------------------------------------------------------------------

create function public.runtime_slot_lease_lock()
returns void
language sql
security definer
set search_path = public
as $$
  select pg_advisory_xact_lock(hashtextextended('publishing_runtime:instagram_scheduled_publishing', 0));
$$;

-- True only for the holder of the currently valid lease (uncompleted, < 60 s).
create function public.runtime_lease_is_valid_holder(p_run_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_run_id is not null and exists (
    select 1 from public.publishing_runtime_slot_lease l
    where l.runtime_key = 'instagram_scheduled_publishing'
      and l.run_id = p_run_id
      and l.completed_at is null
      and l.acquired_at > now() - interval '60 seconds'
  );
$$;

create function public.runtime_control_enabled_mode()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select c.mode from public.publishing_runtime_control c
  where c.key = 'instagram_scheduled_publishing' and c.enabled;
$$;

revoke all on function public.runtime_slot_lease_lock() from public, anon, authenticated, service_role;
revoke all on function public.runtime_lease_is_valid_holder(uuid) from public, anon, authenticated, service_role;
revoke all on function public.runtime_control_enabled_mode() from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 4. acquire_runtime_slot_lease
-- -----------------------------------------------------------------------------

create function public.acquire_runtime_slot_lease(p_run_id uuid)
returns table (acquired boolean, slot_start timestamptz, holder_run_id uuid, reason text, mode text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_slot timestamptz := date_bin('5 minutes', now(), timestamptz '2000-01-01 00:00:00+00');
  v_mode text;
  v_existing public.publishing_runtime_slot_lease;
begin
  if p_run_id is null then
    raise exception 'acquire_runtime_slot_lease: run id required';
  end if;

  v_mode := public.runtime_control_enabled_mode();
  if v_mode is null then
    return query select false, v_slot, null::uuid, 'control_off'::text, null::text;
    return;
  end if;

  perform public.runtime_slot_lease_lock();

  select * into v_existing from public.publishing_runtime_slot_lease l
  where l.runtime_key = 'instagram_scheduled_publishing' and l.slot_start = v_slot;
  if found then
    if v_existing.run_id = p_run_id then
      return query select v_existing.completed_at is null, v_slot, v_existing.run_id, 'already_held'::text, v_mode;
      return;
    end if;
    update public.publishing_runtime_slot_lease l
    set duplicate_count = l.duplicate_count + 1
    where l.runtime_key = 'instagram_scheduled_publishing' and l.slot_start = v_slot;
    return query select false, v_slot, v_existing.run_id, 'duplicate_slot'::text, v_mode;
    return;
  end if;

  select * into v_existing from public.publishing_runtime_slot_lease l
  where l.runtime_key = 'instagram_scheduled_publishing'
    and l.completed_at is null
    and l.acquired_at > now() - interval '60 seconds'
  order by l.acquired_at desc
  limit 1;
  if found then
    return query select false, v_slot, v_existing.run_id, 'overlap_active'::text, v_mode;
    return;
  end if;

  insert into public.publishing_runtime_slot_lease (runtime_key, slot_start, run_id)
  values ('instagram_scheduled_publishing', v_slot, p_run_id);
  return query select true, v_slot, p_run_id, 'acquired'::text, v_mode;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. complete_runtime_slot_lease
-- -----------------------------------------------------------------------------

create function public.complete_runtime_slot_lease(p_run_id uuid, p_outcome text)
returns table (completed boolean, reason text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lease public.publishing_runtime_slot_lease;
begin
  if p_run_id is null then
    raise exception 'complete_runtime_slot_lease: run id required';
  end if;
  if p_outcome is null or p_outcome !~ '^[a-z0-9_]{1,64}$' then
    raise exception 'complete_runtime_slot_lease: outcome must match ^[a-z0-9_]{1,64}$';
  end if;

  select * into v_lease from public.publishing_runtime_slot_lease l
  where l.runtime_key = 'instagram_scheduled_publishing' and l.run_id = p_run_id
  for update;
  if not found then
    return query select false, 'not_holder'::text;
    return;
  end if;
  if v_lease.completed_at is not null then
    -- Idempotent: the first completion wins; nothing changes.
    return query select false, 'already_completed'::text;
    return;
  end if;

  update public.publishing_runtime_slot_lease l
  set completed_at = now(), outcome = p_outcome
  where l.runtime_key = 'instagram_scheduled_publishing' and l.run_id = p_run_id;
  return query select true, 'completed'::text;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. select_runtime_resume
-- -----------------------------------------------------------------------------

create function public.select_runtime_resume(p_run_id uuid)
returns table (publication_id uuid, workspace_id uuid, attempt_id uuid, stage public.publication_attempt_stage)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
begin
  perform public.runtime_slot_lease_lock();
  if not public.runtime_lease_is_valid_holder(p_run_id) then
    return;
  end if;
  if public.runtime_control_enabled_mode() is null then
    return;
  end if;

  select p.id as pub_id, p.workspace_id as ws_id, t.id as att_id, t.stage as att_stage
  into v_row
  from public.publications p
  join public.social_accounts sa
    on sa.id = p.social_account_id and sa.workspace_id = p.workspace_id
  join public.publishing_runtime_allowlist a
    on a.social_account_id = p.social_account_id and a.workspace_id = p.workspace_id
  join public.publication_attempts t
    on t.publication_id = p.id and t.workspace_id = p.workspace_id
  where p.status = 'publishing'
    and sa.platform = 'instagram'
    and t.attempt_number = (select max(x.attempt_number) from public.publication_attempts x where x.publication_id = p.id)
    and t.stage in ('container_created', 'container_ready')
    and t.container_created_at is not null
    and t.container_created_at > now() - interval '15 minutes'
  order by t.container_created_at asc, t.id asc
  limit 1
  for update of p, t skip locked;

  if not found then
    return;
  end if;

  update public.publication_attempts set last_run_id = p_run_id where id = v_row.att_id;
  publication_id := v_row.pub_id;
  workspace_id := v_row.ws_id;
  attempt_id := v_row.att_id;
  stage := v_row.att_stage;
  return next;
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. claim_runtime_publications v3 (overload: p_cap, p_run_id)
-- -----------------------------------------------------------------------------

create function public.claim_runtime_publications(p_cap integer, p_run_id uuid)
returns setof public.publications
language plpgsql
security definer
set search_path = public
as $$
declare
  v_candidate record;
  v_claimed public.publications;
begin
  if p_cap is null or p_cap <> 1 then
    raise exception 'claim_runtime_publications: cap must be 1 in the initial Level 6 (got %)', p_cap;
  end if;

  perform public.runtime_slot_lease_lock();
  if not public.runtime_lease_is_valid_holder(p_run_id) then
    return;
  end if;
  if public.runtime_control_enabled_mode() is null then
    return;
  end if;

  -- Single-flight: nothing new while ANY runtime publication is in flight
  -- (status 'publishing' on an allowlisted Instagram account: resumable,
  -- mid-run, outcome_unknown or awaiting reconciliation). Resume therefore
  -- always takes precedence over claim.
  if exists (
    select 1
    from public.publications p
    join public.social_accounts sa
      on sa.id = p.social_account_id and sa.workspace_id = p.workspace_id
    join public.publishing_runtime_allowlist a
      on a.social_account_id = p.social_account_id and a.workspace_id = p.workspace_id
    where p.status = 'publishing' and sa.platform = 'instagram'
  ) then
    return;
  end if;

  for v_candidate in
    select p.id
    from public.publications p
    join public.social_accounts sa
      on sa.id = p.social_account_id and sa.workspace_id = p.workspace_id
    join public.publishing_runtime_allowlist a
      on a.social_account_id = p.social_account_id and a.workspace_id = p.workspace_id
    where p.status = 'scheduled'
      and p.scheduled_at is not null
      and p.scheduled_at <= now()
      and sa.platform = 'instagram'
      and sa.status = 'connected'
    order by p.scheduled_at asc, p.id asc
    limit 20
    for update of p skip locked
  loop
    begin
      update public.publications
      set status = 'publishing'
      where id = v_candidate.id and status = 'scheduled'
      returning * into v_claimed;
      if found then
        return next v_claimed;
        return; -- cap = 1
      end if;
    exception
      when others then
        continue; -- rejected by the approval/lifecycle triggers: stays scheduled
    end;
  end loop;
  return;
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. reconcile_stale_runtime_publications v2 (overload: p_stale_seconds, p_run_id)
-- -----------------------------------------------------------------------------

create function public.reconcile_stale_runtime_publications(p_stale_seconds integer, p_run_id uuid)
returns table (publication_id uuid, workspace_id uuid, attempt_id uuid, action text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pub record;
  v_attempt public.publication_attempts;
  v_has_attempt boolean;
  v_threshold timestamptz;
  v_deadline timestamptz := now() - interval '15 minutes';
begin
  if p_stale_seconds is null or p_stale_seconds < 60 then
    raise exception 'reconcile_stale_runtime_publications: stale threshold must be >= 60 seconds';
  end if;

  perform public.runtime_slot_lease_lock();
  if not public.runtime_lease_is_valid_holder(p_run_id) then
    return;
  end if;
  if public.runtime_control_enabled_mode() is null then
    return;
  end if;

  v_threshold := now() - make_interval(secs => p_stale_seconds);

  for v_pub in
    select p.id, p.workspace_id, p.updated_at
    from public.publications p
    join public.social_accounts sa
      on sa.id = p.social_account_id and sa.workspace_id = p.workspace_id
    join public.publishing_runtime_allowlist a
      on a.social_account_id = p.social_account_id and a.workspace_id = p.workspace_id
    where p.status = 'publishing' and sa.platform = 'instagram'
    order by p.updated_at asc, p.id asc
    limit 20
    for update of p skip locked
  loop
    publication_id := v_pub.id;
    workspace_id := v_pub.workspace_id;
    attempt_id := null;

    select * into v_attempt
    from public.publication_attempts pa
    where pa.publication_id = v_pub.id
    order by pa.attempt_number desc
    limit 1
    for update;
    v_has_attempt := found;

    begin
      if not v_has_attempt then
        if v_pub.updated_at <= v_threshold then
          update public.publications
          set status = 'failed',
              error_code = 'runtime_interrupted_before_attempt',
              error_message = 'Runtime execution stopped before any publish attempt started; no provider request was made',
              provider_response = jsonb_build_object('reconciliation', 'stale_no_attempt')
          where id = v_pub.id;
          action := 'failed_no_attempt';
        else
          action := 'skipped_publication_recent';
        end if;
      else
        attempt_id := v_attempt.id;
        if v_attempt.last_run_id is not null and (
             v_attempt.last_run_id = p_run_id
             or exists (select 1 from public.publishing_runtime_slot_lease l
                        where l.runtime_key = 'instagram_scheduled_publishing'
                          and l.run_id = v_attempt.last_run_id
                          and l.completed_at is null
                          and l.acquired_at > now() - interval '60 seconds')) then
          action := 'skipped_active_run';
        elsif v_attempt.stage = 'validating' then
          if v_attempt.updated_at > v_threshold then
            action := 'skipped_attempt_recent';
          elsif v_attempt.container_create_requested_at is null then
            update public.publication_attempts
            set stage = 'failed', error_code = 'interrupted_before_publish',
                error_message = 'Attempt was interrupted before the container request'
            where id = v_attempt.id;
            update public.publications
            set status = 'failed', error_code = 'interrupted_before_publish',
                error_message = 'Publishing was interrupted before any provider request',
                provider_response = jsonb_build_object('attemptId', v_attempt.id, 'reconciliation', 'stale_pre_provider')
            where id = v_pub.id;
            action := 'failed_pre_provider';
          else
            -- G1 may have been dispatched; its outcome is unknown. Never re-dispatch.
            -- Known-not-published: no publish request can target an unrecorded container.
            update public.publication_attempts
            set stage = 'failed', error_code = 'container_create_outcome_unknown',
                error_message = 'Container creation was requested but its outcome is unknown; not retried'
            where id = v_attempt.id;
            update public.publications
            set status = 'failed', error_code = 'container_create_outcome_unknown',
                error_message = 'Container creation outcome unknown; no publish request was made',
                provider_response = jsonb_build_object('attemptId', v_attempt.id, 'reconciliation', 'stale_g1_unknown')
            where id = v_pub.id;
            action := 'failed_g1_unknown';
          end if;
        elsif v_attempt.stage in ('container_created', 'container_ready') then
          if v_attempt.container_created_at is null then
            -- Legacy (pre-H1) row: v1 semantics.
            if v_attempt.updated_at > v_threshold then
              action := 'skipped_attempt_recent';
            else
              update public.publication_attempts
              set stage = 'failed', error_code = 'interrupted_before_publish',
                  error_message = 'Attempt was interrupted before the publish request'
              where id = v_attempt.id;
              update public.publications
              set status = 'failed', error_code = 'interrupted_before_publish',
                  error_message = 'Publishing was interrupted before the publish request',
                  provider_response = jsonb_build_object('attemptId', v_attempt.id, 'reconciliation', 'stale_pre_publish')
              where id = v_pub.id;
              action := 'failed_pre_publish';
            end if;
          elsif v_attempt.container_created_at > v_deadline then
            action := 'skipped_resumable';
          else
            update public.publication_attempts
            set stage = 'failed',
                error_code = case when v_attempt.stage = 'container_created' then 'container_not_ready' else 'publish_window_expired' end,
                error_message = case when v_attempt.stage = 'container_created'
                                     then 'Container did not become ready within the readiness window'
                                     else 'Container was ready but not published within the readiness window' end
            where id = v_attempt.id;
            update public.publications
            set status = 'failed',
                error_code = case when v_attempt.stage = 'container_created' then 'container_not_ready' else 'publish_window_expired' end,
                error_message = 'Readiness window expired; no publish request was made',
                provider_response = jsonb_build_object('attemptId', v_attempt.id, 'reconciliation', 'readiness_expired')
            where id = v_pub.id;
            action := case when v_attempt.stage = 'container_created' then 'failed_container_not_ready' else 'failed_publish_window_expired' end;
          end if;
        elsif v_attempt.stage = 'publish_requested' then
          if v_attempt.updated_at > v_threshold then
            action := 'skipped_attempt_recent';
          else
            update public.publication_attempts
            set stage = 'outcome_unknown', error_code = 'interrupted_during_publish',
                error_message = 'The process stopped after the publish request began; the remote outcome is unknown'
            where id = v_attempt.id;
            action := 'marked_outcome_unknown';
          end if;
        elsif v_attempt.stage = 'published' and v_attempt.external_media_id is not null then
          update public.publications
          set status = 'published',
              published_at = now(),
              external_publication_id = v_attempt.external_media_id,
              external_url = null,
              provider_response = jsonb_build_object(
                'attemptId', v_attempt.id,
                'containerId', v_attempt.container_ids ->> 0,
                'mediaId', v_attempt.external_media_id,
                'provider', v_attempt.provider,
                'reconciliation', 'finalized_from_published_attempt')
          where id = v_pub.id;
          action := 'finalized_published';
        elsif v_attempt.stage = 'failed' then
          update public.publications
          set status = 'failed',
              error_code = coalesce(v_attempt.error_code, 'attempt_failed'),
              error_message = coalesce(v_attempt.error_message, 'Publish attempt failed'),
              provider_response = jsonb_build_object('attemptId', v_attempt.id, 'reconciliation', 'failed_attempt')
          where id = v_pub.id;
          action := 'failed_from_attempt';
        else
          action := 'outcome_unknown_requires_operator';
        end if;
      end if;
    exception
      when others then
        action := 'error';
    end;
    return next;
  end loop;
  return;
end;
$$;

-- -----------------------------------------------------------------------------
-- 9. Grants: explicit; service_role only
-- -----------------------------------------------------------------------------

revoke all on function public.acquire_runtime_slot_lease(uuid) from public, anon, authenticated;
revoke all on function public.complete_runtime_slot_lease(uuid, text) from public, anon, authenticated;
revoke all on function public.select_runtime_resume(uuid) from public, anon, authenticated;
revoke all on function public.claim_runtime_publications(integer, uuid) from public, anon, authenticated;
revoke all on function public.reconcile_stale_runtime_publications(integer, uuid) from public, anon, authenticated;

grant execute on function public.acquire_runtime_slot_lease(uuid) to service_role;
grant execute on function public.complete_runtime_slot_lease(uuid, text) to service_role;
grant execute on function public.select_runtime_resume(uuid) to service_role;
grant execute on function public.claim_runtime_publications(integer, uuid) to service_role;
grant execute on function public.reconcile_stale_runtime_publications(integer, uuid) to service_role;
