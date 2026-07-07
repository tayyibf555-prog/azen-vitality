-- Cross-module outbound frequency cap.
--
-- Each module (recall, reactivation, no-show, coordinator, reviews) dedupes within
-- itself, but nothing stopped two DIFFERENT modules texting the same patient the same
-- day. This table is the shared record of "who was messaged today": the shared drain
-- checks it before sending an OUTREACH row and stamps it after ANY send. Transactional
-- appointment confirmations always send but still stamp the day, so same-day outreach
-- yields to them. Keyed by the resolved recipient ADDRESS so it dedupes SMS + WhatsApp
-- (same number) and by the Europe/London calendar day.
create table if not exists public.message_daily_log (
  id uuid primary key default gen_random_uuid(),
  site_id text not null,
  address text not null,
  sent_on date not null,
  source text not null,
  created_at timestamptz not null default now(),
  unique (site_id, address, sent_on)
);

create index if not exists message_daily_log_lookup
  on public.message_daily_log (site_id, address, sent_on);

-- Server-only: written and read exclusively by the service-role drain. RLS on with no
-- policies (the service role bypasses RLS; anon/auth roles get no access), matching the
-- other messaging tables.
alter table public.message_daily_log enable row level security;
