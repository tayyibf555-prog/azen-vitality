# Reactivation — Design Spec

Date: 2026-06-18
Status: Approved (design). Build depth: real wiring (Supabase + Dentally sandbox + Claude), matching the Treatment Coordinator spec.

## Context

The Azen x Vitality platform is an AI operations layer built on top of Dentally for a
multi-site dental group. The foundation/shell is built (agency view + client dashboard on
mock data, module placeholders wired from `src/lib/nav.ts`). The first real module, the
**Treatment Coordinator** (TC), is specced and planned
(`docs/superpowers/specs/2026-06-18-treatment-coordinator-design.md`).

This spec covers the second lifecycle module: **Reactivation**, the unified re-engagement
worklist for patients who have gone dormant. Per the product doc, the biggest revenue leak
is out the back of the practice. Recall concierge keeps on-time patients cycling; the
Treatment Coordinator recovers active accepted treatment. Reactivation catches everyone who
has fallen through the cracks of both: lapsed patients, patients whose recall has gone
significantly overdue, and accepted treatment plans that have gone fully cold.

Reactivation reuses most of the TC infrastructure (Dentally client, Supabase clients, Claude
drafting, the outbox + send-stub adapter, the worklist/drawer UI). What makes it a distinct
module: a broader target population across three cohorts, a blended value-and-winnability
ranking that works for patients with no active plan, and a multi-step **cadence engine** that
sequences outreach over time.

## Decisions (locked)

- **Target population (three cohorts, one ranked list):**
  - **Lapsed** — Dentally `archived_reason = lapsed`, OR no appointment in `REACTIVATION_LAPSE_MONTHS`
    (default 18) with no future booking.
  - **Overdue recall** — `dentist_recall_date` or `hygienist_recall_date` passed by more than a
    grace window (`REACTIVATION_RECALL_GRACE_DAYS`, default 60) with no resulting booking, so
    Recall concierge has already had its run.
  - **Stalled plan** — an accepted-but-incomplete plan gone fully cold (no touch / no movement
    beyond a staleness threshold, `REACTIVATION_STALE_DAYS`, default 120), past the TC active range.
- **Boundary / no double-working:** a patient is a Reactivation target only when the dedicated
  live module no longer owns them. The sync computes a single `reactivation_reason` per patient
  (the strongest applicable cohort, in priority order: stalled plan > overdue recall > lapsed)
  and **dedupes**, so a patient appears once, with one reason, and never in two modules at once.
  When Recall concierge and the Treatment Coordinator graduate from placeholder to live, the
  thresholds above are the contractual handoff line; this spec defines that line now so the
  modules compose cleanly.
- **Ranking:** deterministic `reactivationScore = recoverableValue × winnability`. Explainable
  and cheap, mirroring the TC scoring approach. (See Ranking section.)
- **Outreach:** a multi-step **cadence** per patient. Default 3 steps (nudge -> offer ->
  final) with spaced waits, then auto-give-up (`exhausted`). The system advances the cadence
  when a step is due; Claude drafts each step; low-value steps may auto-queue, high-value steps
  wait for coordinator approval (same threshold model as TC). A booking converts the patient and
  exits the cadence immediately.
- **Architecture:** sync Dentally data into Supabase as lean "reactivation target" snapshots
  (TC's approach B). The module reads/ranks/filters from Supabase instantly; opening a patient
  fetches fresh detail from Dentally; bookings write back to Dentally.
- **Auth stays mock this round.** Supabase is the database; the real Supabase auth + RLS swap is
  a separate session. The existing mock `useAuth` still gates views.
- **Sending is stubbed.** Claude-drafted messages queue to the shared `outbox` and are marked
  "sent (simulated)". Real Twilio / WhatsApp Business API drops into the existing send adapter
  later (no messaging credentials this round).
- **Scheduling is manual this round.** The cadence sweep is a manually-triggered endpoint.
  Inngest/cron to run it automatically is deferred, exactly like the TC sync.
- **No clinical data** is read or stored. Operations fields only.

## Why this builds on approach B (sync into Supabase)

The same forces that drove TC to approach B apply, more strongly: Dentally has no webhooks
(poll with `updated_after`), queries are paginated and capped at 3 months per request, and
Reactivation must rank the WHOLE dormant book by value plus persist cadence state and touch
history across days. On-demand pass-through (approach A) cannot persist a cadence; a full
mirror (approach C) drifts toward a system of record, which the product forbids. B persists
only the lean fields needed to rank, display, and run the cadence, plus module-owned state.

## Architecture

```
Dentally sandbox  --(poll, updated_after, per site_id)-->  Supabase
  (system of record)                                       reactivation_target  (snapshot)
        ^                                                   reactivation_cadence (per-patient state)
        |  write appointments (book re-engagement)          reactivation_touch   (outreach log)
        |                                                    outbox               (shared send queue)
        +----------------------------------------------------------+
                                  ^                ^
                                  | read/rank      | sweep: advance due steps, draft, queue/approve
                          Reactivation UI ---------+--- Claude (cohort-aware draft + rationale)
                          /c/[client]/reactivation
```

### 1. Dentally integration layer (extends `src/lib/dentally/`)
- Extend `DentallyClient` with reads for the dormant book: archived/lapsed patients
  (`archived`, `archived_reason`), recall fields (`dentist_recall_date`, `dentist_recall_interval`,
  `hygienist_recall_date`, `hygienist_recall_interval`), last/most-recent appointment, and
  historic invoiced value (sum of paid invoices) as the lifetime-spend proxy. Reuses the
  existing auth / User-Agent / pagination / 3-month-window / rate-limit handling.
- New normaliser `toReactivationTarget(input, now)`: maps Dentally responses to our
  `ReactivationTarget` shape, derives `reactivationReason` (the deduped strongest cohort) and
  `recoverableValue`. Pure, unit-testable. Whitelisted ops fields only; no clinical data.

### 2. Sync job (`src/app/api/sync/reactivation/route.ts`)
- Polls Dentally per `site_id` with `updated_after` (high-water mark in the shared `sync_state`,
  `resource = 'reactivation'`), classifies each patient into a cohort (or none), upserts
  `reactivation_target` snapshots, recomputes `reactivationScore`. Idempotent and safe to re-run;
  never double-counts. Triggerable manually now; onto Inngest/cron later. Logs what it pulled.

### 3. Cadence sweep (`src/app/api/reactivation/sweep/route.ts`)
- `POST`. Finds `reactivation_cadence` rows where `status = 'active'` and `next_due_at <= now`.
  For each: compute the next step from the cadence definition, draft the message with Claude,
  create a `reactivation_touch` (`draft`). If `recoverableValue < REACTIVATION_AUTO_SEND_THRESHOLD`,
  auto-approve + enqueue to `outbox`; else set the cadence `awaiting_approval` and leave the touch
  as `draft`. Advance `current_step` and set the next `next_due_at` (or `exhausted` after the last
  step). Returns a summary `{ swept, drafted, queued, awaitingApproval, exhausted }`. Idempotent:
  a step already drafted for the current cadence position is not re-drafted.

### 4. Supabase schema (new migration `0002_reactivation.sql`)
- `reactivation_target`: `id` (`<site_id>:<dentally_patient_id>`), `site_id`,
  `dentally_patient_id`, `patient_name`, `reactivation_reason` (lapsed | overdue_recall |
  stalled_plan), `dentally_plan_id` (nullable), `treatment` (nullable), `recoverable_value`
  (numeric; outstanding plan value, else historic spend, else baseline), `last_visit_at`
  (nullable), `recall_due_at` (nullable), `prior_attempts` (int, default 0), `status`
  (dormant | in_cadence | converted | exhausted), `reactivation_score` (numeric),
  `consent` (jsonb: sms/email/marketing), `updated_from_dentally_at`, timestamps.
- `reactivation_cadence`: `id` (uuid), `target_id` (fk -> reactivation_target, cascade),
  `site_id`, `current_step` (int, default 0), `status` (active | awaiting_approval | paused |
  converted | exhausted), `next_due_at` (timestamptz), `started_at`, `ended_at`, `updated_at`.
- `reactivation_touch`: same shape as `coordinator_touch` — `id` (uuid), `target_id`,
  `cadence_id`, `site_id`, `step` (int), `channel` (sms|email|whatsapp), `direction`
  (outbound|inbound), `body`, `drafted_by` (claude|human), `status` (draft | approved | queued |
  sent | failed), `approved_by`, `created_at`, `sent_at`.
- Reuses the shared `outbox` and `sync_state` tables created by the TC migration. (If
  Reactivation ships before TC, this migration creates them; written with `if not exists` so the
  two migrations are order-independent.)
- RLS enabled, scoped by `site_id`, from day one (enforced once real auth lands; the service role
  used by the sync/sweep jobs bypasses RLS).

### 5. Ranking + AI
- Deterministic `reactivationScore = recoverableValue × winnability` in
  `src/lib/reactivation/scoring.ts`. `recoverableValue` = outstanding plan value (stalled_plan
  cohort), else historic invoiced spend (proxy), else a small baseline (`REACTIVATION_BASELINE_VALUE`,
  default 80, e.g. a checkup). `winnability` = bounded multiplier (e.g. 0.5..1.5) that rises for
  more recently lapsed / more recently overdue and falls with `prior_attempts`. Documented formula;
  outstanding value still dominates so big stalled plans top the list.
- Cadence definition in `src/lib/reactivation/cadence.ts`: an ordered array of steps
  `{ step, channel, waitDays, purpose }` plus pure helpers `nextStep(cadence, def)` and
  `dueAt(step, def, from)`. No I/O; unit-testable. Default sequence: step 1 nudge (sms),
  step 2 offer (email, +5d), step 3 final (sms, +7d), then exhausted.
- Claude (Sonnet) drafts cohort-aware outreach copy + a short "why now" rationale per step. The
  prompt branches on `reactivation_reason` (missed-you nudge for lapsed, recall reminder for
  overdue_recall, finance re-presentation for stalled_plan) and on the cadence step (warmer ->
  more direct). Enforces: lead with patient context, one clear next step, under ~90 words, GBP (£),
  no em-dashes. Drafts cached per target + step so we do not redraft on every view.

### 6. Outreach flow (cadence + draft-and-approve)
- A dormant target with consent and `status = 'dormant'` is enrolled into a `reactivation_cadence`
  (`current_step = 0`, `next_due_at = now`), target -> `in_cadence`.
- The sweep advances due steps: draft -> (auto-queue if low value | `awaiting_approval` if high
  value). Approve -> `approved` -> push to shared `outbox` -> stub marks `sent` (simulated),
  increments `prior_attempts`, stamps the step's `sent_at`.
- After the final step with no response, cadence -> `exhausted`, target -> `exhausted`.
- "Book re-engagement" creates a Dentally appointment (write-back, `booked_via_api`), cadence ->
  `converted`, target -> `converted`, exits the sequence. Appointment type is cohort-appropriate
  (checkup for lapsed/overdue, consult to resume for stalled_plan).
- Consent (`use_sms` / `use_email` / `marketing`) is respected before any (stub) send; a channel
  with no consent is skipped and the step falls back to the next consented channel, or pauses.

### 7. UI — `/c/[client]/reactivation`
Replaces the current placeholder page.
- Header stat cards: dormant patients, total recoverable value, re-engaged-to-date (converted),
  patients in cadence.
- Ranked worklist table: priority, patient, **cohort badge** (lapsed | overdue recall | stalled
  plan), recoverable value, last visit / recall due, cadence step (e.g. "2 of 3"), next due,
  status pill. Sort/filter by site, cohort, and status. Row click opens detail.
- Target detail (drawer or panel): patient summary + reason + recoverable value, the "why now"
  rationale, the **cadence timeline** (steps done / current / upcoming with due dates), the
  Claude-drafted next message (editable textarea, channel selector), approve/send, pause/resume
  cadence, and "book re-engagement". Loading + empty + error states for every panel.
- No-em-dash copy rule throughout.

## Components and boundaries

- `src/lib/dentally/client.ts` — extended with dormant-book read methods. Testable with mocked fetch.
- `src/lib/dentally/normalise-reactivation.ts` — `toReactivationTarget(...)`. Pure, unit-testable.
- `src/lib/reactivation/types.ts` — domain types (ReactivationTarget, ReactivationCadence,
  ReactivationTouch, enums).
- `src/lib/reactivation/scoring.ts` — pure `reactivationScore()` + `rankTargets()`. Unit-testable.
- `src/lib/reactivation/cadence.ts` — pure cadence definition + `nextStep` / `dueAt`. Unit-testable.
- `src/lib/reactivation/draft.ts` — cohort-aware Claude drafting + rationale. Depends on Anthropic SDK.
- `src/lib/reactivation/repository.ts` — typed Supabase reads/writes for the three new tables + sync_state.
- `src/lib/supabase/server.ts` — reused from the TC build.
- `src/app/api/sync/reactivation/route.ts` — sync endpoint.
- `src/app/api/reactivation/sweep/route.ts` — cadence sweep endpoint.
- `src/app/api/reactivation/[action]/route.ts` — actions (enrol, draft, approve, send-stub, pause, book).
- `src/app/c/[client]/reactivation/*` + `src/components/client/reactivation/*` — UI.
- Each unit has one purpose, communicates via typed interfaces, and is understandable and testable
  on its own.

## Environment variables (new; in addition to the TC set)

```
REACTIVATION_LAPSE_MONTHS=18           # no appointment in this window (and no future booking) = lapsed
REACTIVATION_RECALL_GRACE_DAYS=60      # recall overdue beyond this (no booking) = overdue_recall cohort
REACTIVATION_STALE_DAYS=120            # accepted plan cold beyond this = stalled_plan cohort
REACTIVATION_BASELINE_VALUE=80         # GBP fallback recoverable value (e.g. a checkup) when no plan/spend
REACTIVATION_AUTO_SEND_THRESHOLD=250   # GBP; below this, cadence steps may auto-queue without approval
```

(Reuses the TC env: Supabase URL/keys, `DENTALLY_API_KEY`, `DENTALLY_BASE_URL`, `ANTHROPIC_API_KEY`.)

## Testing / verification

- Unit: `scoring.ts` (ordering by value/winnability; recently-lapsed outranks long-gone; fewer
  prior attempts ranks higher); `cadence.ts` (`nextStep` advances and stops at the end; `dueAt`
  spacing); `normalise-reactivation.ts` (cohort derivation + dedup priority; recoverable-value
  fallback chain; no clinical fields leak); draft prompt assembly (cohort branch, no em-dashes, GBP).
- Integration: sync route against the Dentally sandbox populates `reactivation_target` with correct
  cohorts; re-running is idempotent (no duplicates, high-water mark advances). Sweep route advances a
  seeded active cadence, drafts the next step, and respects the auto-send threshold.
- E2E (manual via preview): worklist renders ranked, cohort badges correct; open a target; cadence
  timeline + Claude draft appear; edit + approve queues the step and stamps the touch; running the
  sweep advances a due cadence; "book re-engagement" creates a sandbox appointment with
  `booked_via_api` and converts the target.
- Build + typecheck pass clean.

## Out of scope (this round)

- Real Supabase auth + RLS enforcement (own session).
- Real Twilio / WhatsApp sending (adapter stub only, shared with TC).
- Inngest/cron scheduling of the sync and the cadence sweep (manual/triggered now).
- Inbound reply handling and full conversation threading (a reply currently does not auto-pause the
  cadence; coordinators pause manually). Auto-pause-on-reply lands with inbound handling later.
- Per-site customisation of the cadence definition (single default sequence this round).
- Other modules.
