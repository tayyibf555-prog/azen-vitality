# CLAUDE.md — Azen x Vitality Dental

AI operating layer for a multi-site dental group, built on top of Dentally.

This file is the source of truth for the build. Read it before starting work. If a request would breach a boundary in the "Do not build" section, or expand scope beyond the current pilot, stop and ask before proceeding.

---

## 1. What this is

A centralised system that runs the business around the dentistry for the Vitality Dental Network. It does not replace Dentally (their practice management system); it reads from and writes to Dentally in real time and adds the active layer on top.

- **First client / pilot:** one Vitality clinic in London, then replicate to other sites if proven.
- **Decision makers:** Jawad Khursheed and Mohammad Siddiqui (Vitality). Built by Tayyib Arbab (Azen AI Ltd).
- **Model:** single-tenant, bespoke. The client owns the system and the IP. No shared multi-tenant pool, no black box.

## 2. Positioning (read this before deciding what to prioritise)

Azen is a **lifecycle and operations** layer, not an acquisition shop. Acquisition is the entry point, not the headline.

- Competitors like Dentology own the front of the funnel (ads, lead conversion) and stop at the booking. They explicitly do not do recall, retention, staff or operations.
- Azen's centre of gravity is everything **after** the patient exists: recall, reactivation, treatment follow-up, staff enablement, compliance, rotas, owner intelligence.
- The biggest leak in a practice is out the back (over half of accepted treatment is never completed), not the front. Build accordingly.
- When in doubt about where to invest effort, favour the lifecycle, staff and owner layers. They are the moat.

## 3. Core principles (non-negotiable)

1. **Built on Dentally.** Dentally is the system of record. Nothing migrates off it. We surface and act on its data.
2. **Clinical boundary.** We run the operations around the care. We never touch diagnosis, imaging, clinical charting, or treatment decisions. The Dentally API exposes no clinical data; keep it that way in our system too.
3. **Single-tenant, client-owns-IP.** Build for one client's ownership. Do not design for a shared data pool across practices.
4. **Outcome-measured.** Everything ties back to booked consultations, recovered revenue, and time saved. Instrument it.
5. **Human-in-the-loop where it matters.** AI handles routine and after-hours. Live high-ticket conversion and clinical judgement stay human, with AI assisting, not replacing.

---

## 4. Architecture (layers)

```
Acquisition  ->  Conversion  ->  Lifecycle  ->  Conversational  ->  Staff & Ops  ->  Owner
                              \________________ all on Dentally (live two-way) ________________/
```

## 5. Build scope

Tags: **[PILOT]** ships in the first London build (target 2 weeks, 3 max if the API causes issues). **[PHASE 2]** comes after the pilot proves out. Do not promise PHASE 2 items on the pilot timeline.

### Acquisition layer
- **Smile Assessment** [PILOT] — qualifying quiz delivered as an embeddable funnel widget (not a website build). Personalised per response. Scores each enquiry on treatment interest, timeline, budget readiness and location. High scorers fast-tracked to booking into Dentally; low scorers nurtured. Azen designs and owns the questions, scoring model and Dentally handoff. Qualifies for intent and fit only, never clinical suitability.
- **Speed-to-lead** [PILOT] — contact a new enquiry within ~30 seconds, multi-channel (SMS, email, WhatsApp). (Reference: 5+ minute delay correlates with ~9x lower conversion.)
- **Content support** [PHASE 2] — AI hook-variation generation (demographic-varied hooks for a single core ad) and an ad-scoring tool. Note: Azen does **not** run ad campaigns. Ad management is referred out or handled by Vitality's in-house team.

### Conversion layer
- **Power dialler** [PILOT] — auto-dials several leads at once, staggered so two never connect simultaneously, routes the first answered call to a free coordinator and drops the rest. Configurable concurrency (e.g. 4 for a small team). Lets reception across multiple sites share load through one system.
- **Task-queue engine** [PILOT] — feeds coordinators the next prioritised task instead of a drag-and-drop pipeline. Follow-up cadence baked in (fast first touch, then spaced retries before a lead goes cold). Removes "who do I call next" decision-making from the rep.
- **Live booking co-pilot** [PHASE 2] — at the booking moment, surfaces the right USPs, pricing, financing and objection-handling for that treatment and that site (e.g. London pricing for a London enquiry, Invisalign talking points for an Invisalign enquiry).
- **Canonical pricing & USP source of truth** [PILOT, lightweight] — one config layer so pricing and USPs are consistent everywhere. Configurable at service and location level.
- **Payment-link race handling** [PHASE 2] — if a patient pays late and the slot is gone, auto-rebook or offer alternatives rather than leaving a coordinator to untangle it.

### Lifecycle layer (core)
- **Recall concierge** [PILOT] — reads the exact recall dates clinicians set in Dentally (dentist and hygienist) and books patients back in via SMS/email.
- **Reactivation** [PILOT] — revives lapsed/dormant patients and unfinished treatment plans from the existing database.
- **AI Treatment Coordinator** [PILOT] — finds accepted-but-incomplete treatment, ranks by value, re-presents finance, follows up and books the next step. This is the highest-value module.
- **Missed-call & after-hours capture** [PILOT] — answers and books calls **after hours and on genuine overflow only**. An AI voice agent for live reception hours is explicitly out of scope (both sides agreed it is not suitable for live high-ticket calls yet).
- **No-show defence** [PILOT] — smart confirmations and reminders driven off the live diary.

### Conversational layer
- **WhatsApp agent** [PILOT] — booking, rescheduling, cancelling, reminders, recalls and follow-ups, with human escalation and takeover. Connected live to Dentally. Runs on the WhatsApp Business API. Azen builds and owns the agent and its logic.

### Staff & operations layer (the moat, none of this is in a competitor's acquisition product)
- **Daily intelligence brief** [PILOT] — every morning, reads the diary and hands each role a prioritised action list (who to chase, gaps to fill, no-show risks, high-value treatment arriving today).
- **Practice brain** [PHASE 2 for full version; PILOT for a basic knowledge base] — internal AI trained on protocols, scripts, pricing and Dentally workflows. Replaces ad-hoc ChatGPT use. One standard answer across every site.
- **CQC compliance centralisation** [PHASE 2] — high-value, not covered by Dentally. Centralise compliance evidence and tracking.
- **Custom rota module** [PHASE 2] — staff scheduling, replacing the per-head third-party app (~40 staff).

### Owner layer
- **Management dashboard** [PILOT] — real-time, cross-site, full-funnel: leads in, consultations booked, cost per booking, recall and treatment recovery, site by site.
- **Owner copilot** [PHASE 2] — query the data in natural language; individual patient lookup.
- **Diagnostic copilot** [PHASE 2] — runs a troubleshooting workflow (is this an ads problem or a sales problem), drills into the weakest performer, audits the relevant data, and outputs specific action items.

### Foundation
- **Dentally integration** [PILOT] — REST/JSON API, read and write on patients and appointments. Confirmed feasible. Single-tenant. Nothing migrates.

---

## 6. Do not build

- **No clinical AI.** No diagnosis, imaging analysis, clinical charting, or treatment-decision logic.
- **No live-hours AI receptionist.** After-hours and overflow only.
- **No ad campaign management.** Hook generation and scoring are fine; running spend is referred out.
- **No recruitment / staff-placement service.** This is a people-business outside Azen's remit. Close the human-execution gap with software (dialler, task queue, co-pilot), not by hiring reps for the client.
- **No multi-tenant shared data pool.** Single-tenant only.

## 7. Tech stack (working assumption, adjust if needed)

- **Frontend / app:** Next.js 15 (App Router), TypeScript, Tailwind.
- **Data / auth:** Supabase (Postgres + auth + RLS for per-site access).
- **Background jobs & scheduling:** Inngest (recall sweeps, follow-up cadences, the daily brief, polling Dentally for changes).
- **AI:** Anthropic API (Claude) for the agents, briefs, copilots and scoring. Sonnet for high-volume classification, Opus for reasoning-heavy tasks.
- **Voice / dialler:** Twilio (programmable voice for the power dialler and after-hours capture).
- **Messaging:** WhatsApp Business API (via an approved provider), plus SMS/email for speed-to-lead and lifecycle.
- **Integration:** Dentally API as the system of record.

## 8. Dentally API notes (build essentials)

- REST/JSON, v1. Production `https://api.dentally.co`. **Sandbox `https://api.sandbox.dentally.co`** — build and test here first.
- OAuth scopes per resource (e.g. `patient:read`, `patient:update`, appointment scopes). A practice-issued API key from Settings -> Developer Settings is enough to build and run the pilot, and must have **read and write** on Patients and Appointments (write is essential or bookings fail).
- Key is tied to a user and site, revocable instantly, and **expires if unused for ~2 weeks**. Needs a Level 4 admin to issue.
- **Appointments:** availability endpoint (paginate, small `per_page`), create/edit; state machine (Pending, Confirmed, Arrived, In surgery, Completed, Cancelled, Did not attend) powers no-show and closed-loop logic; `booked_via_api` flag.
- **Patients:** `dentist_recall_date`/interval and `hygienist_recall_date`/interval (recall concierge); `recall_method`/`use_sms`/`use_email`/`marketing` (consent/GDPR); `archived_reason = lapsed` (reactivation); `acquisition_source_id` and `/acquisition_sources` (attribution); `metadata` (up to 3 keys, stamp campaign/quiz IDs).
- **Accounts:** `planned_private_treatment_value` and `planned_nhs_treatment_value` (treatment-coordinator targeting).
- **Invoices:** `amount_outstanding`/`paid`, `treatment_plan_id` (revenue tracking).
- `site_id` is on everything — this is what makes the cross-site dashboard possible.
- **Constraints:** appointments queries limited to <=3 months per request; paginate (<=100/page); **no webhooks**, so poll with `updated_after`; a `User-Agent` header is required.
- **The API sends no SMS/WhatsApp and holds no clinical data.** Use Twilio / WhatsApp Business API for messaging. The absence of clinical data fits our boundary; do not work around it.

## 9. Conventions

- **Copy rule:** no em-dashes anywhere in user-facing copy, messages or generated content. Use commas, full stops, or rephrase.
- **Multi-site by default.** Every entity, query and dashboard view is scoped by `site_id`. Never hardcode a single site.
- **Consent and GDPR.** Respect `use_sms`/`use_email`/`marketing` flags before any outbound message. Log consent basis.
- **Idempotency.** Polling and cadence jobs must be safe to re-run; never double-book or double-message.
- **Instrument everything.** Every action a module takes should be measurable against bookings, recovered revenue, or time saved.
- **Brand tokens (for any UI):**
  - Navy `#0A0E1A`, off-white/cream `#EEEAE4`, card `#FFFFFF` / `#F6F3EE`, light blue `#5BC4F7`, dark blue `#2B8AC0`, ink `#333B4D`, WhatsApp green `#25D366`.
  - Font: Plus Jakarta Sans (ExtraBold for headings).

## 10. Open decisions (resolve with Tayyib before building these)

- **Call transcription / QA.** Vitality already has an AI VoIP system (Voice Stack) that transcribes and lets them query calls by intent. Decide whether Azen builds transcription/QA, integrates with Voice Stack, or leaves it. Currently unowned.
- **Pilot pricing.** No figure agreed. A reference point in the market is a productised licence around 18k/year. Agree a paid pilot number before building; the pilot is a paid engagement, not free spec work.
- **Exclusivity / partnership / equity.** Parked until after the pilot proves out. Do not let build work proceed as an implicit down payment on an exclusivity or shareholder deal. Any such agreement goes past a solicitor and accountant first.
