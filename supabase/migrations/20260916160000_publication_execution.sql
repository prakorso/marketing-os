-- Marketing OS — MVP-2.3: Distribution — Provider Execution Foundation
--
-- Adds the narrow Vault credential-read path required to resolve a social
-- account's live credential immediately before a (mocked, this phase)
-- provider call, plus a database-level lifecycle-transition gate covering
-- publishing/published/failed, layered on top of (not replacing) the
-- existing approval and cancellation gates from the publications
-- migration (20260916140000). This migration is additive — it does not
-- modify the Foundation, Storage, Brand, Content, Storage RBAC, Social
-- Accounts, or Publications migrations.
--
-- Out of scope, per MVP-2.3 decisions: real provider API calls, OAuth,
-- retries, queue/worker/cron infrastructure, and any UI. See
-- src/server/services/publication-execution.ts for the execution
-- orchestration this migration supports.

-- =============================================================================
-- Vault credential read — read_social_account_vault_secret()
--
-- PostgREST does not expose the `vault` schema to any role (see the two
-- existing wrappers in 20260916120000_social_accounts.sql for the same
-- reasoning). This is the third and final wrapper needed for the
-- Social Accounts / Publications credential lifecycle: create (connect),
-- delete (disconnect), and now read (resolve immediately before a
-- provider call, Engineering Blueprint §16). Grantee-restricted to
-- service_role only — never callable by `authenticated`/`anon`. Returns
-- the decrypted secret as plain text; callers must never return this
-- value from an exported function, a Server Action, or any API response.
-- =============================================================================

create function public.read_social_account_vault_secret(p_secret_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret text;
begin
  select decrypted_secret
  into v_secret
  from vault.decrypted_secrets
  where id = p_secret_id;

  return v_secret;
end;
$$;

revoke all on function public.read_social_account_vault_secret(uuid) from public;
grant execute on function public.read_social_account_vault_secret(uuid) to service_role;

-- =============================================================================
-- Lifecycle transition gate — enforce_publication_lifecycle_transitions()
--
-- MVP-2.3 decision: a publication may enter 'publishing' ONLY from
-- 'scheduled'; 'published' ONLY from 'publishing'; 'failed' ONLY from
-- 'publishing'. This is layered on top of (not a replacement for) the
-- existing enforce_publication_approval_gate, which still independently
-- requires the latest content_approvals decision to be 'approved' before
-- entering scheduled/publishing/published — both triggers fire on the
-- same statement and both must pass. A direct INSERT can never land on
-- publishing/published/failed (there is no prior state to satisfy the
-- "only from X" requirement), mirroring how the existing cancellation
-- gate rejects a direct INSERT at 'cancelled'. This also closes the
-- double-invocation gap: publishing -> publishing is rejected because
-- OLD.status ('publishing') is not 'scheduled'.
--
-- Enforced regardless of role, including a service-role connection that
-- bypasses RLS — the trigger fires for every writer.
-- =============================================================================

create function public.enforce_publication_lifecycle_transitions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'publishing' then
    if tg_op = 'INSERT' then
      raise exception 'Cannot insert publication % directly with status=publishing; it must transition from scheduled', new.id;
    end if;
    if old.status is distinct from 'scheduled' then
      raise exception 'Cannot transition publication % to publishing from %: only scheduled -> publishing is allowed', new.id, old.status;
    end if;
  elsif new.status = 'published' then
    if tg_op = 'INSERT' then
      raise exception 'Cannot insert publication % directly with status=published; it must transition from publishing', new.id;
    end if;
    if old.status is distinct from 'publishing' then
      raise exception 'Cannot transition publication % to published from %: only publishing -> published is allowed', new.id, old.status;
    end if;
  elsif new.status = 'failed' then
    if tg_op = 'INSERT' then
      raise exception 'Cannot insert publication % directly with status=failed; it must transition from publishing', new.id;
    end if;
    if old.status is distinct from 'publishing' then
      raise exception 'Cannot transition publication % to failed from %: only publishing -> failed is allowed', new.id, old.status;
    end if;
  end if;

  return new;
end;
$$;

create trigger enforce_publication_lifecycle_transitions
  before insert or update on public.publications
  for each row
  execute function public.enforce_publication_lifecycle_transitions();
