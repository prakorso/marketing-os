-- Marketing OS — MVP-2.4: Distribution — Scheduled Execution (claim function)
--
-- Adds the single database object this milestone requires: an atomic,
-- bounded claim RPC for due scheduled publications, used by the trusted
-- system scheduler path (src/server/services/publication-scheduler.ts).
-- This is additive — it does not modify the Foundation, Storage, Brand,
-- Content, Storage RBAC, Social Accounts, Publications, or Publication
-- Execution migrations, and does not add any table, column, enum, or
-- retry mechanism.
--
-- Why a database function is required (not expressible via PostgREST):
-- a bounded, ordered, `FOR UPDATE SKIP LOCKED` claim cannot be expressed
-- through the Supabase JS client's query builder — PostgREST has no way
-- to express row-locking clauses or an ORDER BY/LIMIT scoped subquery on
-- an UPDATE. This function is the minimal, narrowly-scoped way to get
-- that exact semantic, matching the approved MVP-2.4 concurrency decision.

-- =============================================================================
-- claim_due_publications(p_batch_size)
--
-- Claims up to p_batch_size publications where status = 'scheduled' and
-- scheduled_at is due (IS NOT NULL AND <= now()), ordered by scheduled_at,
-- transitioning each to 'publishing'. Uses FOR UPDATE SKIP LOCKED so two
-- overlapping invocations never claim the same row (the second simply
-- skips rows the first is holding).
--
-- Each row is claimed with its own UPDATE inside a per-row exception
-- handler (a PL/pgSQL BEGIN/EXCEPTION block implicitly creates a
-- savepoint) rather than one flat multi-row UPDATE. This matters because
-- enforce_publication_approval_gate and enforce_publication_lifecycle_
-- transitions both still fire on every claim attempt (SECURITY DEFINER
-- does not disable triggers) — if a single flat UPDATE affecting several
-- rows hit a row whose approval was revoked (a later content_approvals
-- decision superseding an earlier 'approved' one, Database Architecture
-- §17) after it was scheduled, the trigger's raised exception would abort
-- the ENTIRE statement, silently failing to claim every other otherwise-
-- valid row in the same batch. Isolating each claim in its own exception
-- scope means a poisoned row is skipped (remains 'scheduled', reconsidered
-- next run) without blocking the rest of the batch. This does not weaken
-- either trigger — it only prevents one row's rejection from masking
-- every other row's legitimate claim.
--
-- Intentionally has no workspace_id parameter or filter: this is a
-- system-level, cross-workspace scheduler operation by design, not a
-- per-tenant one — the same authorization boundary point already
-- established for Vault access (server-side, service_role only) applies
-- here. It must never be called with a browser-supplied workspace_id or
-- publication_id; the caller (publication-scheduler.ts) only ever uses
-- what this function itself returns.
-- =============================================================================

create function public.claim_due_publications(p_batch_size integer default 10)
returns setof public.publications
language plpgsql
security definer
set search_path = public
as $$
declare
  v_candidate record;
  v_claimed public.publications;
begin
  for v_candidate in
    select p.id
    from public.publications p
    where p.status = 'scheduled'
      and p.scheduled_at is not null
      and p.scheduled_at <= now()
    order by p.scheduled_at asc
    limit p_batch_size
    for update skip locked
  loop
    begin
      update public.publications
      set status = 'publishing'
      where id = v_candidate.id
      returning * into v_claimed;

      return next v_claimed;
    exception
      when others then
        -- This row's transition was rejected (e.g. by the approval gate,
        -- most likely because a later content_approvals decision
        -- superseded an earlier approval after scheduling). Skip it —
        -- it remains 'scheduled' and will be reconsidered on the next
        -- run — without aborting the rest of this batch.
        continue;
    end;
  end loop;

  return;
end;
$$;

revoke all on function public.claim_due_publications(integer) from public;
grant execute on function public.claim_due_publications(integer) to service_role;
