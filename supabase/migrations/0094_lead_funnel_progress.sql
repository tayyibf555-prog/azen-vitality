-- 0094_lead_funnel_progress.sql
-- WHERE IN THE FUNNEL THIS LEAD STOPPED. Six columns on speed_to_lead_lead so the
-- Leads worklist can say "Abandoned at question 3 of 5" or "Completed the
-- assessment" about a person who gave their contact details inside a Smile
-- Assessment funnel and then did, or did not, carry on.
--
-- ============================================================================
-- WRITTEN BUT NOT APPLIED, same convention as 0078-0083 and for the same reason:
-- a migration file is written by the build and applied by a human who has read it.
--
-- RUNNING IT CHANGES NOTHING THAT IS LIVE. Six nullable columns and one partial
-- index on a table that already exists. No backfill, no seed, no default that
-- rewrites a row, no constraint any existing row could violate, no change to the
-- RLS posture, and not one line of application code behaves differently for a lead
-- that has no funnel behind it (which is every lead in the table today).
--
-- AND UNTIL IT IS APPLIED, THE CODE STILL WORKS, in both directions:
--
--   WRITES  the capture stamp is its OWN UPDATE issued after the lead's insert
--           has committed (speed-to-lead/repository.ts, stampLeadFunnelCapture) —
--           deliberately not extra columns on insertLead, so an un-migrated
--           database can only lose a progress number, never a patient's enquiry.
--           PostgREST rejects the unknown columns, the stamp's own try/catch eats
--           it, and the submit route's "never fail the patient's submission"
--           posture holds either way.
--           The public progress endpoint is fire-and-forget by construction: it
--           answers the same opaque 202 for every outcome, including "no such
--           column", so an un-migrated database silently records no progress and
--           the quiz is unaffected.
--   READS   the worklist and the drawer render the progress line ONLY when the
--           lead carries one. An un-migrated row carries nothing, the mapper
--           defaults every field to null, and both surfaces render exactly the
--           markup they rendered before this file existed.
-- ============================================================================
--
-- WHY THIS IS COLUMNS ON THE LEAD AND NOT A JOIN TO assessment_step_event (0080).
--
-- 0080 already stores which screen a session reached. It is the obvious table to
-- join to, and joining to it is the one thing this feature must never do.
--
-- That table is ANONYMOUS BY CONSTRUCTION and its header says so at length: no
-- name, no contact detail, no answer, no IP, and a per-session nonce that "is not
-- a user id", is "never returned to any client", and is deliberately not stored
-- anywhere else. The moment a lead row carried that same nonce, every anonymous
-- step row belonging to that session would become joinable to a named person with
-- a phone number — retroactively, for every session already in the table, on the
-- strength of one column. The anonymity would be gone and nobody would have
-- decided to give it up.
--
-- So progress is written FORWARD onto the lead, from the funnel runtime, only
-- after contact details have been given, and the two nonces are DIFFERENT VALUES
-- FROM DIFFERENT MINTS: 0080's is minted in the browser and never leaves the
-- beacon (step-beacon.ts), while funnel_session_nonce below is minted on the
-- SERVER when the lead is created and handed back to that one browser session.
-- They can never collide, so the join does not exist to be written.
--
-- PRE-CONTACT VISITORS STAY ANONYMOUS. Nothing here changes that: a person who
-- leaves before the contact step has no lead, so there is no row to stamp.
--
-- NO NEW PII. Every column is a small integer, a timestamp, or an opaque
-- server-minted random. The lead's name and contact details were already on this
-- row; this file adds nothing about a person, only about a screen.

-- ---------------------------------------------------------------------------
-- THE COLUMNS.
-- ---------------------------------------------------------------------------

-- WHICH SCREEN this session had reached, 0-based, in the canonical numbering of
-- the funnel they walked (src/lib/smile-assessment/step-numbering.ts — the same
-- one 0080's step_index uses, called from one module so the two cannot drift).
-- Stamped at capture with the CONTACT screen's ordinal and only ever raised
-- afterwards: the public update path refuses anything that is not strictly
-- greater. NOT the number of questions answered, which on a branched funnel is a
-- property of one patient's path rather than of the funnel.
alter table speed_to_lead_lead add column if not exists funnel_last_step int;

-- HOW MANY SCREENS that funnel has, so "N of M" is a fraction rather than a
-- number. Recorded per LEAD rather than read from the campaign at display time,
-- and that is the whole point of it being here: flow_version bumps on every save
-- (0078), so a funnel edited after this person walked it has a different length,
-- and reading M off the campaign later would quietly re-scale a fraction that was
-- true when it was written. A stored M is the M this patient actually saw.
alter table speed_to_lead_lead add column if not exists funnel_total_steps int;

-- WHICH SAVE of the funnel the two numbers above are about. It is not decoration:
-- the public update path requires the version on the post to equal this one, so a
-- session that is still walking v3 can never advance a lead whose N and M came
-- from v3 into a v4 ordinal that means a different screen. Without it, N and M
-- would drift apart across a republish and the fraction would lie.
alter table speed_to_lead_lead add column if not exists funnel_flow_version int;

-- WHEN THE PROGRESS LAST MOVED. Not updated_at, and that is deliberate twice over:
--   1. the public path must touch NOTHING but these columns, and updated_at is
--      load-bearing elsewhere — resetStaleContacting reclaims a lead stranded at
--      'contacting' by comparing updated_at to a cutoff, so a patient's browser
--      bumping it would postpone the practice's own failsafe;
--   2. "how long since they stopped" is the question the display asks, and
--      updated_at answers a different one (any edit at all, including a staff
--      member changing the stage), which would make a lead look freshly active
--      because somebody clicked "Mark booked" on it.
alter table speed_to_lead_lead add column if not exists funnel_last_step_at timestamptz;

-- SET ONCE, when the session reaches the funnel's LAST screen (the result). Its
-- presence is the whole difference between "Completed the assessment" and
-- "Abandoned at question N of M", so it is a timestamp rather than a boolean: the
-- practice's question is usually "when", and a boolean cannot be asked it later.
-- Stamped in the same conditional UPDATE that raises funnel_last_step to the final
-- ordinal, which can succeed at most once (the step guard refuses to run twice).
alter table speed_to_lead_lead add column if not exists funnel_completed_at timestamptz;

-- THE BEARER. An opaque, server-minted, per-lead random handed back to the browser
-- that submitted the contact step, and the ONLY thing that lets an unauthenticated
-- caller advance a lead's progress — it names the lead and authorises the write in
-- one value, so a caller without it cannot address any row at all.
--
-- MINTED ON THE SERVER, never accepted from the caller. A client-chosen value here
-- would be two bugs: an attacker could claim a nonce that already exists (the
-- unique index below would then fail the insert and lose a real patient's
-- enquiry), and the value's unguessability would rest on whatever PRNG the
-- patient's browser happens to have. crypto.randomUUID() on our side has neither
-- problem.
alter table speed_to_lead_lead add column if not exists funnel_session_nonce text;

-- ---------------------------------------------------------------------------
-- THE INDEX.
-- ---------------------------------------------------------------------------

-- UNIQUE, because "this nonce is a bearer for exactly ONE lead" is a security
-- property and belongs in the database rather than in a comment: without it a
-- duplicate value would make one post advance two people's leads, and the
-- application could not tell.
--
-- PARTIAL, because almost no lead has one. Missed calls, website forms, abandoned
-- bookings and every lead created before this file all carry null here, and a null
-- is not indexed at all under this predicate — so the index is the size of the
-- funnel leads rather than of the table, and the nulls are not competing for
-- uniqueness with each other either.
--
-- IT IS ALSO THE ONLY READ PATH. The public endpoint's single lookup is
-- `where funnel_session_nonce = $1`, and this makes it a unique-index seek. That
-- matters more than it looks: the endpoint is unauthenticated, so a stranger
-- posting a wrong nonce must cost one index probe and not a scan of the practice's
-- entire enquiry history.
create unique index if not exists idx_stl_lead_funnel_nonce
  on speed_to_lead_lead (funnel_session_nonce)
  where funnel_session_nonce is not null;

-- ---------------------------------------------------------------------------
-- POSTURE.
-- ---------------------------------------------------------------------------

-- RE-AFFIRMED, NOT CHANGED. speed_to_lead_lead has had RLS on and no
-- anon/authenticated grants since 0016 (in the post-0012 locked posture). These
-- lines are idempotent and restate it, because this file is what first lets an
-- UNAUTHENTICATED caller cause a write to this table, and "the browser can never
-- touch this table directly" stops being ceremonial the moment that is true: every
-- write still goes through the service-role client behind the budget-guarded
-- endpoint, which can address exactly one row and exactly six columns of it.
alter table speed_to_lead_lead enable row level security;
revoke all on speed_to_lead_lead from anon, authenticated;

-- NO SEED, NO BACKFILL. There is nothing to backfill: the position a past lead
-- reached in a funnel was never recorded anywhere it could be recovered from, and
-- inventing one would put a number on somebody's worklist that no patient ever
-- produced. Existing leads simply render no progress line, which is the honest
-- statement that we do not know.
