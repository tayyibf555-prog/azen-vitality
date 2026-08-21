-- 0087_closer_discard_reason.sql
-- The approval surface for the treatment-plan closer (migration 0085 built the
-- engine; this is the one column its human half needs).
--
-- WHY A COLUMN AND NOT A NOTE SOMEWHERE.
--
-- A rejected draft is not one thing. "The wording is off" and "we have already
-- spoken to this patient" are opposite instructions, and an unreasoned Discard
-- button has to guess between them for every case, silently: it would either keep
-- re-drafting at a patient the practice has already dealt with, or retire an
-- opportunity from the cadence for good because somebody disliked a sentence.
--
-- So the reason a human gives is an INPUT to the closer's decider, not a note for
-- the audit trail. src/lib/closer/discard.ts resolves each reason to either a
-- cool-off (closer_state stays 'active' behind retry_not_before) or a terminal stop
-- (closer_state 'stopped' with a real stop_reason). This column records which
-- reason produced that, so the state and the human's words cannot drift apart.
--
-- closer_state.stop_reason gains one new value, 'staff_stopped', written when a
-- human discards with "do not follow this patient up". It is deliberately its own
-- value: 'excluded' would claim the patient's admin status excludes them and
-- 'opted_out' would claim the patient asked us to stop, and neither is true. The
-- column has no check constraint (see 0085), so no constraint change is needed —
-- the closed set lives in the TypeScript union, where it is under test.
--
-- No new grants, no RLS change: closer_touch is already RLS-on and server-only
-- (0085, the post-0012 posture). Additive and idempotent, so a re-run is a no-op.

alter table closer_touch add column if not exists discard_reason text;

comment on column closer_touch.discard_reason is
  'Only ever set on a status=discarded row: the reason a human gave for rejecting the draft. Resolves to a cool-off or a terminal stop via src/lib/closer/discard.ts. approved_by carries the actor for BOTH the approve and the discard transitions.';
