-- Daily takings and UDA rollup, one row per site per day.
--
-- WHY THIS TABLE EXISTS
--
-- Dentally ignores every date filter on /v1/payments (filter[from], from and
-- dated_on_from all return the full 40,243 rows) and returns results newest
-- first. The only honest way to total a period live is therefore to page back
-- from today and stop once past the boundary. That is cheap for TODAY and
-- YESTERDAY and much too slow to do on a dashboard load for LAST 90 DAYS.
--
-- So a background job walks each day once, writes the day's totals here, and the
-- 7, 30 and 90 day cells of the takings strip read this table instead. Same for
-- the UDA figures, which are measured against an annual contract and would
-- otherwise mean paging 52,875 claims on every page view.
--
-- WHY source_complete EXISTS
--
-- A rollup built from a scan that ran out of pages, timed out, or hit a Dentally
-- error is a PARTIAL day. Summing it would print a real-looking takings figure
-- that is simply too low, and an understated takings total is worse than a blank
-- one. So a day is only written with source_complete = true when the scan
-- genuinely reached both ends of that day, and the aggregation refuses to report
-- any period containing an incomplete or missing day.
--
-- MONEY IS INTEGER PENCE, UDA IS INTEGER HUNDREDTHS
--
-- Dentally sends money as a string ("27.9") and UDA the same ("1.56"). Both are
-- parsed to integers before they reach here. Storing pence rather than numeric
-- pounds means ninety days of sums cannot drift by a penny, and a penny out on a
-- takings dashboard is a support call.
--
-- POSTURE
--
-- Same as every other post-0012 table: server-only access through the service
-- role, RLS enabled with NO policies, so the browser anon key can neither read
-- nor write it. Nothing patient-identifying is stored here; these are day totals.
--
-- NOT APPLIED. This file is written and left unapplied on purpose.

create table if not exists dashboard_daily_rollup (
  client_id text not null,
  -- Dentally site id, e.g. 'site-cc'. One row per site per day; the all-sites
  -- figure is the sum across sites, which is only trustworthy when every site
  -- has reported, hence the completeness check in the aggregation layer.
  site_id text not null,
  -- The Europe/London calendar day, matching Dentally's own `dated_on`. A date,
  -- never a timestamp: the practice's day is a local day, not a UTC window.
  day date not null,

  -- Takings. Whole pence. Refunds are included as negatives, because a refund
  -- genuinely reduces the day's takings. Deleted payments are excluded.
  takings_pence bigint not null,
  payment_count integer not null,
  -- Payment rows the parser could not read (a malformed `amount`, a missing
  -- `dated_on`). Recorded rather than hidden, so a day that quietly lost rows
  -- can be spotted and re-run instead of silently understating takings.
  payments_dropped integer not null default 0,

  -- Appointments, for the count beneath each takings figure and the donut.
  appointments_total integer not null,
  appointments_completed integer not null,
  appointments_cancelled integer not null,
  appointments_dna integer not null,
  -- Appointments whose Dentally state matched no recognised bucket. They are
  -- counted here and NOWHERE else, so an unfamiliar state can never inflate a
  -- donut slice; it shows up as a calibration job instead.
  appointments_unrecognised integer not null default 0,

  -- UDAs. Whole hundredths of a UDA (156 = 1.56 UDA).
  -- completed = awarded UDAs on claims that count toward the contract.
  -- invalid   = expected UDAs on claims that will not be credited.
  uda_completed_hundredths bigint not null default 0,
  uda_invalid_hundredths bigint not null default 0,
  nhs_claim_count integer not null default 0,
  -- Claims whose claim_status matched neither the valid nor the invalid set.
  -- Counted toward neither UDA figure, for the same reason as above.
  nhs_claims_unrecognised integer not null default 0,

  -- False when the day was built from a scan that did not reach both ends of it.
  -- The aggregation blanks any period containing such a day.
  source_complete boolean not null default false,
  built_at timestamptz not null default now(),

  primary key (client_id, site_id, day)
);

-- The takings strip reads a contiguous run of recent days for one client, across
-- every site, and the longest window is ninety days.
create index if not exists idx_dashboard_daily_rollup_client_day
  on dashboard_daily_rollup (client_id, day desc);

-- The rebuild job looks for days that were never written or came back partial.
create index if not exists idx_dashboard_daily_rollup_incomplete
  on dashboard_daily_rollup (client_id, day desc)
  where source_complete = false;

alter table dashboard_daily_rollup enable row level security;
-- No policies on purpose: all access is server-side via the service role, which
-- bypasses RLS. This keeps practice takings unreadable by the browser anon key.
