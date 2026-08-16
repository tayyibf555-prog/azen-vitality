-- 0080_assessment_step_events.sql
-- STEP DROP-OFF: one row per screen a session reached inside an AUTHORED funnel,
-- so the practice can see which question loses people. Perspective charges for
-- this view; we get it native, off our own runtime.
--
-- ============================================================================
-- WRITTEN BUT NOT APPLIED, AND THAT IS THE POINT OF THIS HEADER.
--
-- Same convention as 0078 and 0079, and no other reason: a migration file is
-- written by the build and applied by a human who has read it. Do not apply this
-- to demonstrate the feature. What makes that safe is the second half.
--
-- RUNNING IT CHANGES NOTHING THAT IS LIVE. One new table, no column added to any
-- existing table, no backfill, no seed, no change to any RLS posture that exists.
-- Nothing reads it and nothing writes it until an owner opens the drop-off view,
-- and the browser half is not even wired up yet (see step-beacon.ts).
--
-- AND UNTIL IT IS APPLIED, THE CODE STILL WORKS, in both directions:
--
--   WRITES  the public beacon endpoint is fire-and-forget by construction — it
--           answers 202 for every outcome, including "that insert failed". On an
--           un-migrated database every post is silently dropped, which is what an
--           un-migrated database can honestly store. It cannot take the quiz down
--           because the quiz never reads the answer.
--   READS   the guarded GET turns "no such table" into a 503 NAMING THIS FILE, not
--           into an empty funnel. Same call setCampaignTheme makes for 0079 and for
--           the same reason: here the data IS the request, and answering "0 sessions,
--           0% completion" to an un-migrated database would tell an owner that
--           nobody uses their funnel. That is not a degraded answer, it is a wrong
--           one. aggregateStepEvents([]) is still the empty funnel — but it means
--           "nobody has been here yet", which is a different sentence.
-- ============================================================================
--
-- WHY A NEW TABLE AND NOT funnel_event (0042).
--
-- funnel_event already carries anonymous step telemetry for the public funnels,
-- and the honest question is why this is not four more `step` strings on it. Three
-- reasons, and any one of them alone would not have been enough:
--
--   1. IT ANSWERS A DIFFERENT QUESTION. funnel_event's `step` is an OPEN set of
--      strings (the landing tracker emits arbitrary `section_<name>` markers), so
--      its summary cannot be a single grouped count and pages the raw rows
--      instead (funnel/events.ts, funnelSummary). A funnel's steps are an ORDERED,
--      CLOSED, small integer range, and "between step 2 and step 3" is only a
--      meaningful sentence when the buckets are ordered. Storing an ordinal as a
--      string in an open set would make every read re-derive the order.
--   2. IT IS SCOPED TO A VERSION. A drop-off number is about ONE version of ONE
--      funnel. flow_version bumps on every save (0078), so mixing versions in a
--      single tally averages the funnel an owner just fixed with the one they
--      fixed it from — which is precisely the comparison the feature exists to
--      make possible, and precisely the answer it would destroy. funnel_event has
--      no version column and a reserved, always-null campaign_id.
--   3. IT HAS NO meta. funnel_event carries a jsonb `meta` bag, sanitised to small
--      scalars at the door. That sanitiser is good, and it is still a bag: the
--      guarantee is enforced by a function rather than by the shape of the table.
--      This table has NO free-form column at all, so there is no field for a
--      caller to put a name or a phone number in even if every check upstream were
--      removed. For a table fed by an unauthenticated public endpoint that is
--      worth a table of its own.
--
-- NO PII, BY CONSTRUCTION. Every column below is either an id the practice already
-- owns, a small integer, or an opaque client-generated nonce. There is no name, no
-- contact detail, no answer, no IP, no user agent and no free-text column — a
-- patient's ANSWERS live in smile_assessment_response, which is a record they
-- knowingly submitted with their name on it. This table is about screens, not
-- people, and cannot be joined to a person by anything stored here.
--
-- THE NONCE IS NOT A USER ID. It is a random value the browser mints per session
-- and forgets (step-beacon.ts). It exists for exactly one purpose: so that a
-- session that re-renders step 3 four times counts as ONE view of step 3, which is
-- the difference between a drop-off funnel and a render counter. It is not stored
-- anywhere else, is never returned to any client, and is deliberately not unique
-- across sessions of the same person on the same device.
--
-- APPEND-ONLY, AND WHY THE DEDUP IS NOT A UNIQUE INDEX. The natural key is
-- (campaign_id, flow_version, step_index, session_nonce) and a unique index on it
-- would enforce "one row per nonce per step" in the database. It is deliberately
-- NOT one:
--   - the endpoint is fire-and-forget, so a rejected insert is a silently dropped
--     BATCH (the whole multi-row insert fails), not a silently dropped duplicate;
--   - a unique index on a hot append path is a write cost paid on every event to
--     buy a read-side property the aggregation already guarantees for free
--     (aggregateStepEvents dedups on exactly that key, with tests for replay);
--   - and the honest reading of a duplicate row is "the beacon fired twice", which
--     is a fact about the client worth keeping rather than one to reject.
-- Nothing UPDATEs or DELETEs a row here in application code. The only intended
-- delete is a retention purge, which is why created_at is indexed on its own axis.
--
-- RETENTION. This is the one table in the schema that an anonymous stranger can
-- add rows to, so "how does it stop growing" is part of its design rather than an
-- afterthought. Two halves, and both are needed:
--   - the CEILING is in the app (step-event/route.ts): a per-campaign daily budget
--     bounds new rows at a number somebody can reason about, so the table cannot
--     grow faster than a known rate;
--   - the FLOOR is a purge, and it is written up as an ops runbook rather than as
--     code: supabase/ops/purge-assessment-step-events.sql, a pg_cron job deleting
--     events older than 180 days, NOT YET APPLIED, same convention as every other
--     file in supabase/ops. 180 days is chosen so a season-over-season comparison
--     of the same funnel still has both halves; a drop-off chart older than that
--     is describing a funnel nobody is running any more.
-- Deliberately NOT a trigger and NOT part of this migration: applying this file
-- must change nothing that runs, and a retention window is an operational choice
-- the practice makes, not a schema constraint.

create table if not exists assessment_step_event (
  id uuid primary key default gen_random_uuid(),
  -- The practice, so a retention purge and any cross-campaign read can be scoped
  -- without a join. text, matching every other client_id in this schema.
  client_id text not null,
  -- The campaign whose funnel this step belongs to. SOFT LINK, no foreign key,
  -- exactly as smile_assessment_response.campaign_id is (0018) and for the same
  -- stated reason: the modules stay decoupled. It matters more here than there —
  -- this row is written from an unauthenticated public endpoint, and an FK would
  -- turn "that campaign was deleted a second ago" into a failed insert on a path
  -- whose whole contract is that it never fails loudly. The route resolves the
  -- campaign before inserting, so the id is real when it is written.
  campaign_id uuid not null,
  -- WHICH VERSION OF THE FUNNEL was on screen. Reason 2 in the header: a tally
  -- that mixes versions is an average of a funnel and its own replacement. Matches
  -- smile_assessment_campaign.flow_version (0078), which starts at 0 and only ever
  -- increases, and smile_assessment_response.flow_version, so a drop-off funnel
  -- and the submissions that came out of it are talking about the same thing.
  flow_version int not null,
  -- The screen's ordinal within the walk, 0-based. NOT the node id: node ids are
  -- author-chosen strings that change when a step is renamed, and a chart of them
  -- would silently re-label itself mid-campaign. The ordinal is what "step 3" on
  -- the chart means. Bounded in the app (MAX_STEP_INDEX) rather than by a CHECK,
  -- the same call 0059/0078/0079 made: one owner for the rule, not two that drift.
  step_index int not null,
  -- Opaque, client-generated, per-session. See "THE NONCE IS NOT A USER ID".
  -- Format and length are enforced at the door (isValidNonce); the column is plain
  -- text so a future nonce shape is not a migration.
  session_nonce text not null,
  created_at timestamptz not null default now()
);

-- THE AGGREGATION READ PATH, and the only query the owner view runs: every event
-- for one campaign, one flow version, over a date range. Leading (campaign_id,
-- flow_version) makes it an exact-prefix seek rather than a scan of the practice's
-- whole telemetry, and created_at serves the range on top of it.
--
-- The INCLUDE columns are the other half: with id in the key, the four key columns
-- plus these two are every field the read selects, so this is an index-only scan
-- and the heap is never touched. On a table this write-heavy and this read-narrow
-- that is the difference between a report and a table scan.
--
-- WHY id IS A FOURTH KEY COLUMN AND NOT AN INCLUDE. The read is paged, and it pages
-- by KEYSET rather than by OFFSET — each page asks for the rows strictly older than
-- the last row of the page before it, so a concurrent insert (this table is written
-- to by a public endpoint while the report runs) cannot shift a row across a page
-- boundary and have it silently skipped. That cursor is (created_at, id), because
-- created_at alone is not unique on a table that ingests whole batches inside one
-- millisecond, and the reader's order is exactly:
--   order by created_at desc, id desc
-- An INCLUDE column is payload: it can be RETURNED from the index but it does not
-- order it. With id merely included, the index would settle rows only as far as
-- created_at, and every group of same-millisecond rows — precisely the groups this
-- table creates, one per posted batch — would have to be sorted to satisfy that
-- ORDER BY, and the `created_at = cursor AND id < cursor_id` half of the keyset
-- predicate would be a filter applied after the fact rather than a seek. As a key
-- column, id makes the index's own order the reader's order: no sort node, and the
-- cursor lands by seek. It is still returned, so the index-only scan is unchanged,
-- and it costs the same 16 bytes either way. (A btree reads backwards just as
-- cheaply as forwards, so a descending read needs no second index.)
create index if not exists idx_assessment_step_event_campaign_version_created
  on assessment_step_event (campaign_id, flow_version, created_at, id)
  include (step_index, session_nonce);

-- The SECOND axis, and not a duplicate of the first: retention. A purge ("delete
-- everything older than N days", per practice) and any future cross-campaign
-- rollup filter on client_id + created_at and cannot use the index above, whose
-- leading column is the campaign. Cheap to carry, and the alternative — a purge
-- that seq-scans the largest table in the schema — is the expensive one.
create index if not exists idx_assessment_step_event_client_created
  on assessment_step_event (client_id, created_at);

-- Server-only: RLS on, no policies, no anon/authenticated grants (consistent with
-- 0012 / 0042 / 0067 / 0072 / 0076 / 0077). Every write comes through the
-- service-role client behind the budget-guarded public endpoint; every read comes
-- through the module-guarded owner route. The table is fed by an unauthenticated
-- caller, so "the browser can never touch this table directly" is load-bearing
-- rather than ceremonial.
alter table assessment_step_event enable row level security;
revoke all on assessment_step_event from anon, authenticated;

-- NO SEED. Running this records no step, changes no page and turns nothing on
-- beyond giving the already-wired beacon a table to land in: the deterministic
-- quiz emits step views (deterministic-assessment-quiz.tsx via step-beacon.ts),
-- and until this file is applied the endpoint's insert fails silently by design.
