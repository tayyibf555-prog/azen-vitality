-- 0051_outreach_variants.sql
-- A/B message testing for segment outreach campaigns, with honest conversion
-- read-back per message. A campaign may carry TWO message angles; each enrolled
-- patient is deterministically assigned ONE variant ('a' or 'b') at draft time and
-- always keeps it; the campaign detail reads back sent / replied / booked per variant
-- so the owner can see which message converts. This is honest COUNTING only: no
-- auto-optimisation, no re-weighting, no "learning" - just per-message tallies.
--
-- Purely additive, POST-0012 locked posture (RLS already on from 0041; no new grants).
-- Nothing about how a message reaches a patient changes: consent, suppression, the
-- per-campaign daily cap, the shared drain and the kill switch are all untouched. The
-- variant only decides WHICH of the two angles the draft is written from.
--
-- DDL reality vs the target/touch that already exist (see 0041):
--   * outreach_target already has status 'replied'/'booked' (valid enum values) and an
--     ended_at, but NO dedicated replied_at / booked_at. status is mutable and mutually
--     exclusive (a 'replied' target that later books loses its 'replied' status), and
--     ended_at is also set on exhaustion, so neither gives a durable, unambiguous
--     attribution timestamp. We ADD replied_at / booked_at so the per-variant funnel
--     (sent >= replied >= booked) is honest and each stamp lands exactly once.
--   * variant did not exist on either the target or the touch, so both are ADDED.

-- Campaign: the optional second message angle. Null keeps a campaign single-angle
-- (everyone is variant 'a'); setting it turns the campaign into a two-message test.
alter table outreach_campaign
  add column if not exists message_angle_b text;

-- Target: the assigned variant plus durable attribution stamps. variant is written at
-- draft time in the sweep (deterministic per campaign+patient) and never changes.
-- replied_at / booked_at are stamped once, from the outreach reply/booking linkage.
alter table outreach_target
  add column if not exists variant text check (variant in ('a', 'b'));
alter table outreach_target
  add column if not exists replied_at timestamptz;
alter table outreach_target
  add column if not exists booked_at timestamptz;

-- Touch: the variant the message was drafted from, so a per-variant "sent" count can be
-- taken straight from the touch table (the same place the daily cap counts today's
-- outbound touches).
alter table outreach_touch
  add column if not exists variant text check (variant in ('a', 'b'));

-- Per-variant read-back scans: targets grouped by (campaign, variant) for assigned /
-- replied / booked, and sent touches grouped by (campaign, variant) for the sent count.
create index if not exists idx_outreach_target_campaign_variant
  on outreach_target (campaign_id, variant);
create index if not exists idx_outreach_touch_campaign_variant
  on outreach_touch (campaign_id, variant);
