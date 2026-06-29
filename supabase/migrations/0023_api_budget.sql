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

revoke all on function consume_rate_budget(text, integer, integer) from anon, authenticated;
