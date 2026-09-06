-- 0023_api_budget.sql
-- A shared, atomic per-window call budget for public AI endpoints (the adaptive
-- Smile Assessment funnel calls Haiku on every step). The previous guard was an
-- in-process per-IP Map keyed off a client-spoofable X-Forwarded-For, so it did
-- not actually bound spend on serverless. This adds a GLOBAL budget that caps the
-- total call rate regardless of IP spoofing or how many lambda instances are warm.
--
-- consume_rate_budget(key, limit, window_seconds) atomically increments the key's
-- counter for the current window and returns TRUE if still within `limit`. The
-- whole increment+check is one statement so concurrent callers cannot race past it.
--
-- Post-0012 locked posture: RLS on, no grants; the function + table are reached
-- only via the service-role client.
--
-- THE REVOKE AT THE FOOT OF THIS FILE NAMES `public` FIRST, AND DID NOT ALWAYS.
-- As shipped it read `from anon, authenticated`, which does nothing: Postgres
-- grants EXECUTE on a new function to PUBLIC by default, and anon/authenticated
-- hold it THROUGH that PUBLIC grant rather than through one of their own, so
-- revoking the two by name removes nothing and leaves PUBLIC's in place. Read
-- live on 6 September 2026, years after this ran: anon and authenticated could
-- both still execute it. Same defect ruling W3/35 found on
-- `verify_practice_brain_password` and 0104 fixed the same way.
--
-- Corrected here so a database replayed from scratch arrives at the right grant,
-- and carried to the ALREADY-APPLIED database by
-- 0105_consume_rate_budget_execute_grants.sql — which also records what the reach
-- was (nil: this function is not SECURITY DEFINER and anon holds nothing on
-- api_budget, so an anon call was admitted and then failed 42501) and why it was
-- worth fixing anyway. Correcting this file alone would never reach production;
-- 0105 alone would leave a fresh replay wrong. Both, exactly as 0101/0102 did.

create table if not exists api_budget (
  key text primary key,
  window_start timestamptz not null default now(),
  count integer not null default 0
);

alter table api_budget enable row level security;

create or replace function consume_rate_budget(p_key text, p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql
as $$
declare
  v_count integer;
begin
  insert into api_budget (key, window_start, count)
  values (p_key, now(), 1)
  on conflict (key) do update set
    count = case
      when api_budget.window_start < now() - make_interval(secs => p_window_seconds) then 1
      else api_budget.count + 1
    end,
    window_start = case
      when api_budget.window_start < now() - make_interval(secs => p_window_seconds) then now()
      else api_budget.window_start
    end
  returning count into v_count;
  return v_count <= p_limit;
end;
$$;

revoke all on function consume_rate_budget(text, integer, integer)
  from public, anon, authenticated;
grant execute on function consume_rate_budget(text, integer, integer) to service_role;
