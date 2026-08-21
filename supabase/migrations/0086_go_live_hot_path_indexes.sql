-- 0086_go_live_hot_path_indexes.sql
--
-- NOT APPLIED. Written as a file so it can be read, argued with, and applied
-- deliberately. Every statement is `create index if not exists`, adds no column,
-- drops nothing, and changes no behaviour: the same rows come back in the same
-- order, faster. Safe to apply in any order and safe to apply twice.
--
-- WHAT THIS IS FOR. Four things go live with real traffic (the smile assessment,
-- speed-to-lead, the SMS booking agent, the public booking calendar). The tables
-- behind them are near-empty today, so every query below is fast today and every
-- one of them is a sequential scan. They are the queries that run on a TIMER or on
-- an UNAUTHENTICATED public request, so their cost is set by table size and by
-- traffic, not by how often a person opens a page.
--
-- Each index below names the exact query it serves and where that query lives.
-- If a query moves, the index should move with it or be dropped.
--
-- ONE INDEX IS DELIBERATELY NOT HERE, at the end: see the note on
-- speed_to_lead_lead (site_id, phone).

-- ---------------------------------------------------------------------------
-- 1. The per-minute sweep's crash-recovery pass.
--
--   src/lib/speed-to-lead/repository.ts resetStaleContacting
--     update speed_to_lead_lead set stage = 'new'
--      where stage = 'contacting' and updated_at < now() - 10 min
--
-- Called by /api/speed-to-lead/sweep on EVERY tick, so once a minute for ever.
-- The only indexes on this table lead with site_id (0016) or with nurture_next_at
-- (0045), and this predicate has neither, so it is a full scan of every lead the
-- practice has ever taken — to find, almost always, nothing.
--
-- PARTIAL, on purpose. 'contacting' is a claim held for the seconds between the
-- atomic claim and the send, so this index covers a handful of rows at any moment
-- and is near-empty on disk. That also makes it nearly free on the write side:
-- a lead only enters and leaves the index at the two stage flips.
create index if not exists idx_stl_lead_contacting_stale
  on speed_to_lead_lead (updated_at)
  where stage = 'contacting';

-- ---------------------------------------------------------------------------
-- 2. The public intake rate-limit.
--
--   src/lib/speed-to-lead/repository.ts countRecentByContact
--     select count(*) from speed_to_lead_lead where created_at >= $1 and phone = $2
--     select count(*) from speed_to_lead_lead where created_at >= $1 and email = $2
--
-- TWO of these run on every submission to /api/speed-to-lead/intake and
-- /api/landing-lead — both unauthenticated, both live at go-live. There is
-- deliberately NO site filter (the point is to catch one number flooding the whole
-- group), so idx_stl_lead_site_created cannot serve it: its leading column is
-- absent. Every public form post therefore scans the whole lead table twice.
--
-- This is the one place on this list where the cost grows with BOTH table size and
-- traffic, which is the shape that turns a rate limiter into the thing being rate
-- limited.
--
-- Partial on `is not null` because the predicate is an equality against a real
-- phone/email: a lead with none can never match, and keeping them out keeps both
-- indexes to the rows that can.
create index if not exists idx_stl_lead_phone_created
  on speed_to_lead_lead (phone, created_at)
  where phone is not null;

create index if not exists idx_stl_lead_email_created
  on speed_to_lead_lead (email, created_at)
  where email is not null;

-- ---------------------------------------------------------------------------
-- 3. The messaging drain's queue read, on the four outboxes that never got one.
--
--   src/lib/{reactivation,recall,noshow,coordinator}/repository.ts listQueuedOutbox
--     select ... from <outbox>
--      where site_id = any($1) and status = 'queued'
--      order by created_at asc limit 100
--
-- /api/messaging/drain runs this for EVERY registered source every 5 minutes,
-- whether or not that module is switched on. The pattern was established at
-- migration 0026 (review_outbox) and carried into 0041, 0063 and 0085 — the four
-- tables created BEFORE it never got the equivalent, and each carries only an index
-- on provider_message_id, which serves the delivery webhook and nothing else.
--
-- These tables are append-only in practice: a row is written 'queued' and flipped
-- to 'sent' or 'failed' within minutes, and nothing deletes it. So the queue is
-- always a handful of rows inside a table that only grows, which is exactly the
-- case a PARTIAL index answers: it holds only the rows still queued, so the drain's
-- scan is bounded by the depth of the queue instead of by the history of every
-- message the practice has ever sent.
--
-- Partial rather than the (site_id, status, created_at) shape 0026 used, for that
-- reason — and because a partial index on a transient status shrinks back to
-- nothing as the queue drains, instead of doubling the row count of the table.
create index if not exists idx_react_outbox_queued
  on reactivation_outbox (site_id, created_at)
  where status = 'queued';

create index if not exists idx_recall_outbox_queued
  on recall_outbox (site_id, created_at)
  where status = 'queued';

create index if not exists idx_noshow_outbox_queued
  on noshow_outbox (site_id, created_at)
  where status = 'queued';

create index if not exists idx_outbox_queued
  on outbox (site_id, created_at)
  where status = 'queued';

-- ---------------------------------------------------------------------------
-- 4. The funnel drop-off summary.
--
--   src/lib/funnel/events.ts stepSummary
--     select step from funnel_event
--      where client_id = $1 and surface = $2 and created_at between $3 and $4
--      order by created_at asc, id asc
--
-- funnel_event is written from the assessment and the public booking calendar, so
-- it grows with PUBLIC traffic — the fastest-growing table in this list.
--
-- idx_funnel_event_client_surface_created (0042) already seeks the right rows, so
-- this is not about finding them. It is about the two things that index cannot do:
--   - `id` is the reader's second sort key (created_at alone is not unique on a
--     table that ingests a whole batch inside one millisecond), so without it in
--     the index every equal-timestamp group has to be sorted after the fact;
--   - `step` is the ONLY column selected, so with it included the read never
--     touches the heap at all.
-- Same shape, and for the same two reasons, as idx_assessment_step_event_-
-- campaign_version_created (0080), which was built this way from the start.
--
-- This does NOT fix the reader's OFFSET paging (`.range(scanned, ...)`), which
-- re-walks the whole matched set once per page and so costs O(n^2/page) over a
-- report. That is an application change (keyset paging, as assessment_step_event
-- already does) and is deliberately not smuggled into an index migration.
create index if not exists idx_funnel_event_summary
  on funnel_event (client_id, surface, created_at, id)
  include (step);

-- ---------------------------------------------------------------------------
-- WHAT IS DELIBERATELY NOT HERE
--
-- speed_to_lead_lead (site_id, phone) / (site_id, email), for
-- findOpenLeadByAddress and findEarlierOpenLead. Both run on the same public
-- intake path as #2 above and both look unindexed at a glance, but they are not:
-- they filter site_id AND created_at >= now() - 1 hour, which
-- idx_stl_lead_site_created (0016) serves directly. That bounds the scan to one
-- site's last hour however large the table gets, so an extra index would buy
-- nothing and cost a write on every insert.
--
-- agent_message (conversation_id, created_at, id). The booking agent's history
-- read is now newest-first with a LIMIT, which idx_agent_msg_conv (0006) already
-- serves as a backward index scan; adding id would only remove a cheap sort of the
-- few rows sharing a millisecond. Not worth a write on every inbound message.
