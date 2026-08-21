-- 0093_anomaly_alerts.sql
-- Proactive anomaly alerts: the one table this module owns.
--
-- ===========================================================================
-- WHAT THIS IS, AND WHAT IT IS EMPHATICALLY NOT.
--
-- It is an alerting layer over figures the platform ALREADY computes. It reads
-- the dashboard's own assembled takings strip, the no-show module's risk table,
-- the speed-to-lead sweep's own uncontacted-enquiry query, and bounded counts
-- over the per-module approval and outbox tables. It computes no new number from
-- raw data, and it holds no clinical data, no patient identifier and no message
-- body.
--
-- It is NOT an agent, NOT a chatbot, and NOT a sending surface. There is no
-- outbox here, this module registers no source with the shared messaging drain,
-- and no row written here can reach a patient. The only delivery is the in-app
-- Notifications feed, which reads this table on page load. If an owner SMS or
-- email digest is ever wanted it goes through the shared drain with its own
-- per-module touch/outbox pair and its own toggle, exactly like every other
-- sending module — that is a separate build with separate consent questions, and
-- deliberately not this one.
--
-- ===========================================================================
-- THE HONESTY RULE, WHICH IS WHY THE TABLE LOOKS LIKE THIS.
--
-- An alert must never assert a number the underlying read could not prove. A
-- false "takings are down 40%" sends a practice owner into a panic over what was
-- actually a payment scan that ran out of pages.
--
-- The platform already has the machinery for this and this module reuses it
-- rather than restating it: the dashboard's contract is that a figure it cannot
-- source is NULL with a plain-English reason, never a plausible-looking zero
-- (see supabase/migrations/0062 and src/lib/dashboard/takings.ts). The takings
-- detector consumes the dashboard's own cells and refuses on a null total, so
-- there is no code path in which a short scan becomes a percentage.
--
-- Queue counts come from BOUNDED reads (ROW_CAP rows), and a capped read still
-- proves a floor — so those alerts say "At least 500", in words, in the stored
-- sentence. A cap is never reported as a total.
--
-- `sentence` is stored rather than composed at render time on purpose. It is the
-- exact wording that was true when the condition was detected, against readings
-- that no longer exist; recomposing it later from whatever the tables say now
-- would quietly change what the practice was told.
--
-- ===========================================================================
-- SAFE GATING (two independent OFFs, the house pattern).
--   1. CODE: 'anomaly-alerts' is declared defaultEnabled:false in
--      src/lib/systems/catalog.ts, so the ABSENCE of a system_toggle row means
--      DISABLED for EVERY client, in every environment, including one where this
--      migration has not run.
--   2. DATA: the explicit seed row at the foot of this file, for parity with how
--      0041 / 0047 / 0071 / 0077 / 0085 / 0090 / 0091 seeded their modules OFF.
--      `on conflict do nothing` is essential: re-running this migration must
--      never stamp OFF over an owner's later deliberate ON.
-- Mechanism 2 alone would NOT be sufficient (it covers one client, once), which
-- is exactly why mechanism 1 exists. Switching it off halts the pass AND hides
-- the alerts already raised, because the notifications source consults the same
-- switch — the flip is a complete revert, not a stop with residue on screen.
--
-- POST-0012 locked posture: RLS enabled, NO anon/authenticated grants. All access
-- is server-only via the service-role client, consistent with
-- 0026/0034/0049/0085/0090/0091.

-- ---------------------------------------------------------------------------
-- One row per CONDITION, not per observation.
--
-- That is the whole of the dedupe design. `dedupe_key` is the stable identity of
-- the thing that is wrong ("takings_trend:last7", "lead_sla:<lead id>",
-- "outbox_stuck:recall"), and the unique constraint below is what makes a daily
-- pass over a week-long problem produce one row rather than seven. A pass that
-- sees a condition already open REFRESHES it: newer wording, newer last_seen_at,
-- and first_raised_at left exactly as it was, because that field is the answer
-- to "how long has this been going on".
--
-- Most keys deliberately carry no date. One does: 'noshow_cluster:<day>', because
-- tomorrow's diary is a genuinely new problem needing a fresh round of phone
-- calls rather than yesterday's problem still open.
-- ---------------------------------------------------------------------------
create table if not exists anomaly_alert (
  id uuid primary key default gen_random_uuid(),

  -- The practice. Client-level, not site-level: an owner reads one feed, and a
  -- takings dip is a practice fact, not a site fact.
  client_id text not null,

  -- The stable identity of the condition. See the block above.
  dedupe_key text not null,

  -- Which detector raised it. The CHECK is the thing that stops a typo in a new
  -- detector becoming a row nobody can query and nobody notices is missing.
  kind text not null check (kind in (
    'takings_trend',
    'noshow_cluster',
    'lead_sla',
    'approval_backlog',
    'outbox_stuck',
    'send_failures'
  )),

  severity text not null check (severity in ('high', 'medium', 'low')),

  -- The one plain-English sentence a practice owner reads. Stored, not
  -- recomposed: see the honesty block above.
  sentence text not null,

  -- Module-relative deep link to the screen that shows the evidence, e.g.
  -- 'no-show-defence'. NULLABLE because three of the watched systems are
  -- headless and have no worklist page yet (balance reminders, post-op
  -- check-ins, and the closer's own queue which renders inside Treatment
  -- Coordinator). An alert about them is still worth raising, so the LINK is
  -- dropped rather than the alert.
  href text,

  -- The instant the condition is anchored to (the enquiry's arrival, the oldest
  -- stuck message), which is what the feed sorts on. Distinct from when we
  -- noticed: a lead that came in at 09:00 and was first alerted on at 10:05
  -- should read "2 hours ago", not "55 minutes ago".
  anchored_at timestamptz not null,

  -- When this condition was first raised, and when a pass last confirmed it is
  -- still true. A refresh moves only the second.
  first_raised_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),

  -- Null while the condition is still true. Set when a pass looked for it and
  -- did not find it — NOT when a pass could not look, which is a different thing
  -- and is why the sweep carries a list of unproven key prefixes.
  resolved_at timestamptz,

  -- One row per condition per practice. This constraint IS the dedupe.
  unique (client_id, dedupe_key)
);

-- The feed's read: open alerts for one client, newest condition first.
create index if not exists idx_anomaly_open
  on anomaly_alert (client_id, resolved_at, anchored_at desc);

alter table anomaly_alert enable row level security;
revoke all on anomaly_alert from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Seed the switch OFF for the pilot client. Mechanism 2 of the two above.
-- `on conflict do nothing` so re-running never overrides a deliberate ON.
-- ---------------------------------------------------------------------------
insert into system_toggle (client_id, module_slug, enabled, updated_by)
values ('vitality', 'anomaly-alerts', false, 'migration:0093')
on conflict (client_id, module_slug) do nothing;
