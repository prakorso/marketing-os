-- Marketing OS — MVP-5.10E: Analytics Metric State + Observation Timestamp
-- Provenance
--
-- Implements the physical representation for the canonical semantics
-- recorded in Decisions #33/#37 (per-metric state: reported/unsupported/
-- unavailable, additive JSONB, not a relational child table) and #34/#38
-- (captured_at = best available observation time, with knowable
-- provenance distinguishing a true provider-reported time from a Marqos
-- fallback). Additive only — does not modify, rename, or drop any existing
-- column, table, policy, or grant from 20260916200000_analytics.sql, which
-- is not touched by this migration (its "Derived performance scores"
-- comment is a known, separately-tracked wording artifact — see
-- Decision #31 and the MVP-5.10D checkpoint report; cleaning it up is out
-- of scope for an additive migration).
--
-- Safety: publication_metric_snapshots has zero rows in every environment
-- this migration has been verified against before being written (checked
-- via a local read-only query immediately before drafting this file).
-- Both new columns are added NOT NULL with no DEFAULT: on a table with
-- existing rows this would fail fast at migration time (a safe failure,
-- not silent data corruption) rather than requiring an invented backfill
-- value for historical rows this project has no evidence to construct
-- honestly. No row is deleted, rewritten, or backfilled by this migration.

-- =============================================================================
-- Enum
-- =============================================================================

-- Decision #38: captured_at is either the provider's own reported
-- observation time, or — only when the provider does not expose one — the
-- Marqos collection/sync time. This enum is the physical record of which
-- one produced a given row's captured_at; it must never be inferred or
-- left ambiguous.
create type public.metric_timestamp_provenance as enum ('provider', 'marqos_fallback');

-- =============================================================================
-- Validation function (Decision #33/#37)
-- =============================================================================

-- Enforces, per publication_metric_snapshots row:
--   1. metric_states carries exactly the eight canonical metric keys
--      (Decision #29) — no more, no less;
--   2. each metric's "state" is one of reported/unsupported/unavailable —
--      unknown values are rejected, not silently accepted;
--   3. a metric is in the "reported" state if and only if its
--      corresponding normalized numeric column is non-null — "unsupported"
--      and "unavailable" never carry a numeric value, and "reported"
--      (including a legitimate zero) never leaves its column null.
-- IMMUTABLE: depends only on its arguments, safe to use in a CHECK
-- constraint and to be inlined/cached by the planner.
create or replace function public.validate_publication_metric_states(
  p_metric_states jsonb,
  p_impressions bigint,
  p_reach bigint,
  p_views bigint,
  p_likes bigint,
  p_comments bigint,
  p_shares bigint,
  p_saves bigint,
  p_clicks bigint
) returns boolean
language sql
immutable
as $$
  select
    (
      select array_agg(key order by key)
      from jsonb_object_keys(p_metric_states) as key
    ) = array['clicks', 'comments', 'impressions', 'likes', 'reach', 'saves', 'shares', 'views']
    and (p_metric_states -> 'impressions' ->> 'state') in ('reported', 'unsupported', 'unavailable')
    and (p_metric_states -> 'reach' ->> 'state') in ('reported', 'unsupported', 'unavailable')
    and (p_metric_states -> 'views' ->> 'state') in ('reported', 'unsupported', 'unavailable')
    and (p_metric_states -> 'likes' ->> 'state') in ('reported', 'unsupported', 'unavailable')
    and (p_metric_states -> 'comments' ->> 'state') in ('reported', 'unsupported', 'unavailable')
    and (p_metric_states -> 'shares' ->> 'state') in ('reported', 'unsupported', 'unavailable')
    and (p_metric_states -> 'saves' ->> 'state') in ('reported', 'unsupported', 'unavailable')
    and (p_metric_states -> 'clicks' ->> 'state') in ('reported', 'unsupported', 'unavailable')
    and ((p_metric_states -> 'impressions' ->> 'state' = 'reported') = (p_impressions is not null))
    and ((p_metric_states -> 'reach' ->> 'state' = 'reported') = (p_reach is not null))
    and ((p_metric_states -> 'views' ->> 'state' = 'reported') = (p_views is not null))
    and ((p_metric_states -> 'likes' ->> 'state' = 'reported') = (p_likes is not null))
    and ((p_metric_states -> 'comments' ->> 'state' = 'reported') = (p_comments is not null))
    and ((p_metric_states -> 'shares' ->> 'state' = 'reported') = (p_shares is not null))
    and ((p_metric_states -> 'saves' ->> 'state' = 'reported') = (p_saves is not null))
    and ((p_metric_states -> 'clicks' ->> 'state' = 'reported') = (p_clicks is not null));
$$;

comment on function public.validate_publication_metric_states is
  'Decision #33/#37: validates publication_metric_snapshots.metric_states carries exactly the eight canonical metric keys, each with a reported/unsupported/unavailable state, and that "reported" agrees exactly with the corresponding normalized column being non-null. Used by a CHECK constraint, not application code, so no insert/update can silently bypass it.';

-- =============================================================================
-- Additive columns on publication_metric_snapshots
-- =============================================================================

alter table public.publication_metric_snapshots
  add column metric_states jsonb not null,
  add column captured_at_provenance public.metric_timestamp_provenance not null;

comment on column public.publication_metric_snapshots.metric_states is
  'Decision #33/#37: per-metric state (reported/unsupported/unavailable) for each of the eight canonical metrics, additive alongside the existing normalized numeric columns — not a replacement for them. A "reported" metric always has a non-null value in its own column (zero is a legitimate reported value); "unsupported"/"unavailable" always have a null value there. Validated by validate_publication_metric_states via a CHECK constraint below.';
comment on column public.publication_metric_snapshots.captured_at_provenance is
  'Decision #34/#38: whether captured_at is the provider''s own reported observation time (''provider'') or a Marqos collection/sync-time fallback used because the provider did not expose one (''marqos_fallback''). Never inferred after the fact — always set explicitly at insert time by the Analytics Normalizer.';

alter table public.publication_metric_snapshots
  add constraint publication_metric_snapshots_metric_states_valid
  check (
    public.validate_publication_metric_states(
      metric_states, impressions, reach, views, likes, comments, shares, saves, clicks
    )
  );
