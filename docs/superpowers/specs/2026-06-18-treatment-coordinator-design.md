# Treatment Coordinator — Design Spec

Date: 2026-06-18
Status: Approved (design). Build depth: real wiring (Supabase + Dentally sandbox + Claude).

## Context

The Azen x Vitality platform is an AI operations layer built on top of Dentally for a
multi-site dental group. The foundation/shell is built (agency view + client dashboard
on mock data, module placeholders wired from `src/lib/nav.ts`).

This spec covers the first real module: the **Treatment Coordinator**, the spec's
highest-value module. The biggest revenue leak in a practice is out the back: over half
of accepted treatment is never completed. The Treatment Coordinator finds
accepted-but-incomplete treatment, ranks it by recoverable value, re-presents finance,
follows up, and books the next step.

It is NOT about new leads (Speed-to-lead / Conversion) or dormant patients (Reactivation).
It targets existing patients who already accepted treatment but have not finished it.

## Decisions (locked)

- **Target population:** ALL accepted-but-incomplete treatment, regardless of acceptance
  date (both recently stalled and long abandoned), ranked by outstanding value so the
  biggest recoverable money is always worked first.
- **Automation:** draft-and-approve. The system finds, ranks, and drafts outreach with
  Claude; a coordinator reviews/edits and sends. Routine low-value nudges may auto-queue;
  anything above a value threshold requires human approval. Matches the human-in-the-loop
  principle for high-ticket conversations.
- **Architecture:** sync Dentally data into Supabase as lean "opportunity" snapshots
  (approach B). The module reads/ranks/filters from Supabase instantly; opening a patient
  fetches fresh detail from Dentally; bookings write back to Dentally.
- **Auth stays mock this round.** Supabase is used as the database now; the real Supabase
  auth + RLS swap is a separate session. The existing mock `useAuth` still gates views.
- **Sending is stubbed.** Claude-drafted messages are queued to an outbox and marked
  "sent (simulated)". Real Twilio / WhatsApp Business API drops into the send adapter later
  (no messaging credentials this round).
- **No clinical data** is read or stored. Operations fields only (the Dentally API exposes
  no clinical data; keep it that way in our store too).

## Why approach B (sync into Supabase)

Dentally has no webhooks, so data is polled with `updated_after`; queries are paginated
and capped at 3 months per request. Ranking the WHOLE patient base by outstanding value on
every page load (approach A, on-demand pass-through) would be slow and hit rate limits, and
it cannot persist touch history. A full mirror (approach C) drifts toward being a system of
record, which the spec forbids. B persists only the lean fields needed to rank and display,
plus module-owned state (touches, drafts, outbox), and is the design the
"no webhooks + rank the whole book by value" requirement demands.

## Architecture

```
Dentally sandbox  --(poll, updated_after, per site_id)-->  Supabase
  (system of record)                                       treatment_opportunity (snapshot)
        ^                                                   coordinator_touch (outreach log)
        |  write appointments (book next step)              outbox (send queue)
        |                                                          |
        +----------------------------------------------------------+
                                  ^
                                  | read/rank/draft
                          Treatment Coordinator UI  --- Claude (draft + rationale)
                          /c/[client]/treatment-coordinator
```

### 1. Dentally integration layer (`src/lib/dentally/`)
- `DentallyClient`: typed REST wrapper. Required `User-Agent` header, bearer auth, sandbox
  base URL (`https://api.sandbox.dentally.co`), pagination (<=100/page), the <=3-month
  appointment window, token/rate-limit handling (back off, never crash). Reads patients,
  accounts (`planned_private_treatment_value`, `planned_nhs_treatment_value`), treatment
  plans, invoices (`amount_outstanding`, `treatment_plan_id`); creates/edits appointments.
- All requests carry `site_id`. Base URL + key from env (`DENTALLY_API_KEY`,
  `DENTALLY_BASE_URL`).
- A normaliser maps Dentally responses to our `TreatmentOpportunity` shape. No clinical fields.

### 2. Sync job (`src/app/api/sync/dentally/route.ts` for now)
- Polls Dentally per `site_id` with `updated_after` (high-water mark stored per site),
  upserts `treatment_opportunity` snapshots, recomputes `priority_score`. Idempotent and
  safe to re-run; never double-counts. Triggerable manually now; moved onto Inngest/cron in
  a later session. Logs what it pulled for instrumentation.

### 3. Supabase schema (new, this module)
- `treatment_opportunity`: `id`, `site_id`, `dentally_patient_id`, `dentally_plan_id`,
  `patient_name`, `treatment`, `planned_value`, `amount_outstanding`, `accepted_at`,
  `status` (accepted | in_progress | stalled | completed), `finance_presented` (bool),
  `last_touch_at`, `priority_score` (numeric), `updated_from_dentally_at`, timestamps.
- `coordinator_touch`: `id`, `opportunity_id`, `site_id`, `channel` (sms|email|whatsapp),
  `direction` (outbound|inbound), `body`, `drafted_by` (claude|human), `status`
  (draft | approved | queued | sent | failed), `approved_by`, `created_at`, `sent_at`.
- `outbox`: `id`, `touch_id`, `site_id`, `channel`, `to_ref`, `body`, `status`
  (queued | sent | failed), `provider` (null until real), `created_at`, `sent_at`.
- `sync_state`: `site_id`, `resource`, `high_water_mark` (last `updated_after`), `last_run_at`.
- RLS policies scoped by `site_id` written from day one (enforced once real auth lands;
  service role used by the sync job).

### 4. Ranking + AI
- Deterministic `priority_score` so ranking is explainable and cheap. Inputs: outstanding
  value (dominant), recency of acceptance, days since last touch, finance-not-yet-presented
  bonus. Documented formula in `src/lib/coordinator/scoring.ts`.
- Claude (Sonnet) drafts channel-aware outreach copy per opportunity and a short "why now"
  rationale. Prompt enforces: lead with the patient context, cite the outstanding value and
  treatment, offer finance, clear next step, under ~90 words, GBP, no em-dashes. Drafts
  cached per opportunity + channel so we do not redraft on every view.

### 5. Outreach flow (draft-and-approve)
- For each top opportunity the system creates a `coordinator_touch` in `draft` (Claude body).
- Low-value (below a configurable threshold) may auto-advance to `queued`; high-value stays
  `draft` until a coordinator approves. Approve -> `approved` -> push to `outbox` -> stub
  marks `sent` (simulated) and stamps `last_touch_at` on the opportunity.
- "Book next step" creates a Dentally appointment (write-back), sets `booked_via_api`.

### 6. UI — `/c/[client]/treatment-coordinator`
Replaces the current placeholder page.
- Header stat cards: total recoverable value, open opportunities, recovered-to-date,
  average days stalled.
- Ranked worklist table: priority, patient, treatment, planned value, outstanding,
  days stalled, last touch, status pill. Sort/filter by site and status. Row click opens detail.
- Opportunity detail (drawer or panel): plan summary + outstanding value, the "why now"
  rationale, the Claude-drafted message (editable textarea, channel selector), approve/send,
  touch-history timeline, "book next step" action.
- Consent respected before any outbound (use_sms / use_email / marketing flags carried on
  the snapshot). No-em-dash copy rule throughout. Loading + empty + error states for every panel.

## Components and boundaries

- `src/lib/dentally/client.ts` — REST wrapper. Depends on env + fetch. Testable with mocked fetch.
- `src/lib/dentally/normalise.ts` — Dentally -> `TreatmentOpportunity`. Pure, unit-testable.
- `src/lib/supabase/server.ts` + `client.ts` — Supabase clients (service role for sync,
  anon for reads). New.
- `src/lib/coordinator/scoring.ts` — pure ranking function. Unit-testable.
- `src/lib/coordinator/draft.ts` — Claude drafting + rationale. Depends on Anthropic SDK + key.
- `src/lib/coordinator/repository.ts` — typed Supabase reads/writes for the three tables.
- `src/app/api/sync/dentally/route.ts` — sync endpoint.
- `src/app/api/coordinator/*` — actions (draft, approve, send-stub, book).
- `src/app/c/[client]/treatment-coordinator/*` — UI.
- Each unit has one purpose, communicates via typed interfaces, and can be understood and
  tested on its own.

## Environment variables (new)

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
DENTALLY_API_KEY=
DENTALLY_BASE_URL=https://api.sandbox.dentally.co
ANTHROPIC_API_KEY=
COORDINATOR_AUTO_SEND_THRESHOLD=250   # GBP; below this, low-value nudges may auto-queue
```

## Testing / verification

- Unit: `scoring.ts` (ordering by value/recency/touch), `normalise.ts` (Dentally JSON ->
  opportunity, no clinical fields leak), draft prompt assembly (no em-dashes, GBP).
- Integration: sync route against the Dentally sandbox populates `treatment_opportunity`;
  re-running is idempotent (no duplicates, high-water mark advances).
- E2E (manual via preview): worklist renders ranked by value; open an opportunity; Claude
  draft appears; edit + approve moves it to outbox and stamps last touch; "book next step"
  creates a sandbox appointment with `booked_via_api`.
- Build + typecheck pass clean.

## Out of scope (this round)

- Real Supabase auth + RLS enforcement (own session).
- Real Twilio / WhatsApp sending (adapter stub only).
- Inngest/cron scheduling of the sync (manual/triggered now).
- Inbound reply handling and full conversation threading (later).
- Other modules.
