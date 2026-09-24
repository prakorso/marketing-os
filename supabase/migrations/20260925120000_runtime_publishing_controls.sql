-- =============================================================================
-- MVP-5.36 — Level-6 unattended runtime publishing controls (Decision #44)
--
--   1. publishing_runtime_control   — the DB runtime control / fast kill switch
--                                     (a single row; a missing row means OFF)
--   2. publishing_runtime_allowlist — the social accounts the runtime may act on
--   3. claim_runtime_publications   — the ONLY claim the Level-6 runtime uses:
--                                     control-gated, allowlisted, Instagram-only,
--                                     capped, atomic (FOR UPDATE SKIP LOCKED)
--   4. reconcile_stale_runtime_publications — provider-free local
--                                     reconciliation of stale runtime rows
--
-- The legacy global claim_due_publications (MVP-2.4) is left unchanged and
-- is not used by the Level-6 runtime.
--
-- Access: service_role only. No anon/authenticated grants and no RLS
-- policies, so browser roles can neither read nor change the control or
-- the allowlist.
-- =============================================================================

create table public.publishing_runtime_control (
  key text primary key check (key = 'instagram_scheduled_publishing'),
  enabled boolean not null default false,
  -- 'dry_run' (container creation + status only; the publish request is
  -- structurally impossible) or 'publish'. Anything but 'publish' is dry run.
  mode text not null default 'dry_run' check (mode in ('dry_run', 'publish')),
  note text,
  updated_at timestamptz not null default now()
);

comment on table public.publishing_runtime_control is
  'Level-6 runtime publishing control (Decision #44). Single row; a missing row, a read failure or enabled = false means OFF. Service-role only.';

create trigger set_publishing_runtime_control_updated_at
  before update on public.publishing_runtime_control
  for each row
  execute function public.set_updated_at();

create table public.publishing_runtime_allowlist (
  social_account_id uuid primary key,
  workspace_id uuid not null,
  created_at timestamptz not null default now(),
  constraint publishing_runtime_allowlist_account_fkey
    foreign key (social_account_id, workspace_id)
    references public.social_accounts (id, workspace_id)
    on delete cascade
);

comment on table public.publishing_runtime_allowlist is
  'Level-6 runtime allowlist (Decision #44): only publications of these social accounts can be claimed by the unattended runtime. Service-role only.';

create index publishing_runtime_allowlist_workspace_id_idx on public.publishing_runtime_allowlist (workspace_id);

alter table public.publishing_runtime_control enable row level security;
alter table public.publishing_runtime_allowlist enable row level security;

revoke all on table public.publishing_runtime_control from public, anon, authenticated;
revoke all on table public.publishing_runtime_allowlist from public, anon, authenticated;
grant select, insert, update, delete on table public.publishing_runtime_control to service_role;
grant select, insert, update, delete on table public.publishing_runtime_allowlist to service_role;

-- =============================================================================
-- claim_runtime_publications(p_cap)
--
-- Returns at most p_cap claimed rows (scheduled -> publishing), and nothing
-- at all unless the runtime control row is enabled. Only due, scheduled
-- publications of ALLOWLISTED Instagram social accounts in the SAME
-- workspace are candidates. The approval gate and lifecycle triggers stay
-- authoritative: a row whose transition is rejected is skipped (it stays
-- 'scheduled') and the next candidate is tried. The candidate window is
-- bounded so one permanently rejected row cannot starve the rest.
-- Initial Level 6 accepts p_cap = 1 only.
-- =============================================================================

create function public.claim_runtime_publications(p_cap integer)
returns setof public.publications
language plpgsql
security definer
set search_path = public
as $$
declare
  v_candidate record;
  v_claimed public.publications;
  v_count integer := 0;
begin
  if p_cap is null or p_cap <> 1 then
    raise exception 'claim_runtime_publications: cap must be 1 in the initial Level 6 (got %)', p_cap;
  end if;

  if not exists (
    select 1 from public.publishing_runtime_control c
    where c.key = 'instagram_scheduled_publishing' and c.enabled
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
    order by p.scheduled_at asc, p.id asc
    limit 20
    for update of p skip locked
  loop
    exit when v_count >= p_cap;
    begin
      update public.publications
      set status = 'publishing'
      where id = v_candidate.id and status = 'scheduled'
      returning * into v_claimed;
      if found then
        v_count := v_count + 1;
        return next v_claimed;
      end if;
    exception
      when others then
        -- Rejected by the approval/lifecycle triggers: leave it scheduled.
        continue;
    end;
  end loop;
  return;
end;
$$;

revoke all on function public.claim_runtime_publications(integer) from public, anon, authenticated;
grant execute on function public.claim_runtime_publications(integer) to service_role;

-- =============================================================================
-- reconcile_stale_runtime_publications(p_stale_seconds)
--
-- PROVIDER-FREE local reconciliation (Decision #44). Never calls a provider,
-- Vault or storage — it only reads and transitions local rows, using the
-- DATABASE clock for staleness. Does nothing unless the runtime control is
-- enabled. Scope: 'publishing' publications of allowlisted Instagram
-- accounts whose publication AND latest attempt are older than the
-- threshold. Rules (latest attempt):
--   none                  -> publication failed 'runtime_interrupted_before_attempt'
--                            (proof: for Instagram accounts the only code that can
--                            call the provider mutation endpoints starts an attempt
--                            first; the generic Instagram publish() is not_implemented)
--   validating / container_created / container_ready
--                         -> attempt failed + publication failed 'interrupted_before_publish'
--                            (no publish request was ever checkpointed, hence never sent)
--   publish_requested     -> attempt outcome_unknown 'interrupted_during_publish';
--                            publication stays publishing (never a provider retry)
--   published (+ media id)-> publication published from the durable media id
--   failed                -> publication failed with the attempt's error code
--   outcome_unknown       -> untouched (operator decision)
-- No attempt is ever created. Returns one row per inspected publication.
-- =============================================================================

create function public.reconcile_stale_runtime_publications(p_stale_seconds integer)
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
begin
  if p_stale_seconds is null or p_stale_seconds < 60 then
    raise exception 'reconcile_stale_runtime_publications: stale threshold must be >= 60 seconds';
  end if;

  if not exists (
    select 1 from public.publishing_runtime_control c
    where c.key = 'instagram_scheduled_publishing' and c.enabled
  ) then
    return;
  end if;

  v_threshold := now() - make_interval(secs => p_stale_seconds);

  for v_pub in
    select p.id, p.workspace_id
    from public.publications p
    join public.social_accounts sa
      on sa.id = p.social_account_id and sa.workspace_id = p.workspace_id
    join public.publishing_runtime_allowlist a
      on a.social_account_id = p.social_account_id and a.workspace_id = p.workspace_id
    where p.status = 'publishing'
      and sa.platform = 'instagram'
      and p.updated_at <= v_threshold
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
        update public.publications
        set status = 'failed',
            error_code = 'runtime_interrupted_before_attempt',
            error_message = 'Runtime execution stopped before any publish attempt started; no provider request was made',
            provider_response = jsonb_build_object('reconciliation', 'stale_no_attempt')
        where id = v_pub.id;
        action := 'failed_no_attempt';
      else
        attempt_id := v_attempt.id;
        if v_attempt.updated_at > v_threshold then
          action := 'skipped_attempt_recent';
        elsif v_attempt.stage in ('validating', 'container_created', 'container_ready') then
          update public.publication_attempts
          set stage = 'failed',
              error_code = 'interrupted_before_publish',
              error_message = 'Attempt was interrupted before the publish request'
          where id = v_attempt.id;
          update public.publications
          set status = 'failed',
              error_code = 'interrupted_before_publish',
              error_message = 'Publishing was interrupted before the publish request',
              provider_response = jsonb_build_object('attemptId', v_attempt.id, 'reconciliation', 'stale_pre_publish')
          where id = v_pub.id;
          action := 'failed_pre_publish';
        elsif v_attempt.stage = 'publish_requested' then
          update public.publication_attempts
          set stage = 'outcome_unknown',
              error_code = 'interrupted_during_publish',
              error_message = 'The process stopped after the publish request began; the remote outcome is unknown'
          where id = v_attempt.id;
          action := 'marked_outcome_unknown';
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

revoke all on function public.reconcile_stale_runtime_publications(integer) from public, anon, authenticated;
grant execute on function public.reconcile_stale_runtime_publications(integer) to service_role;
