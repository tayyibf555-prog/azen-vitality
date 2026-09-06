# The Dental Operating System programme

**Mandate (owner of the agency, 3 Sep 2026):** when this platform is finished,
everything works smoothly; the co-pilot handles every scenario and question at
every staff clearance; everything the platform does is reflected back on
Dentally; every AI agent is working where it needs to be. An operating system
for dental clinics. Fable 5.1 instructs, manages and audits; Opus teams build.

This file is the single spec every lane reads first and the checklist the
final audit is scored against. If a lane's brief and this file disagree, this
file wins; if this file is silent, the lane STOPS and asks.

---

## 0. The standard every lane is held to ("how Fable would do it")

1. **Read before writing.** AGENTS.md, then `node_modules/next/dist/docs/` for
   any framework question (Next 16 — assume your training data is wrong). Read
   the module's existing files and their comments: this codebase records its
   live calibrations *where they are used* — the comments are the contract.
2. **Never create `loading.tsx`** (killed hydration once; pinned by test).
   **Never import a VALUE from a `"use client"` module into a server file**
   (RSC proxy trap; pinned by `rsc-value-import.test.ts`). **Never turn a
   shared primitive with function props into a client component.**
3. **Dentally is READ-ONLY for us.** GET only, `User-Agent:
   Azen-Vitality/0.1 (+https://azen.ai)`, `DENTALLY_PROD_READONLY_API_KEY`,
   a small counted number of probes per lane (state the count). Never a write
   verb — real practice, 52,000 real patients. Known traps: `/v1/appointments`
   filters by `after/before` (not start_date); `/v1/nhs_claims` by
   `after/before` (start_date matches nothing); `per_page>100` silently
   returns 25; `/v1/sms` and `/v1/emails` and `/v1/patient_documents` are
   per-patient only; POST `/v1/sms` may TRANSMIT — never touch it.
4. **The rate budget is shared with production** (3,600/hr; background 60%,
   interactive 90%, critical 95%). Every Dentally read declares its priority
   via `runWithDentallyPriority`. No new background pre-warming. Display
   reads use the L1/L2 cache; fresh-only families stay fresh.
5. **Honest numbers or no numbers.** Anything summed, counted or printed as a
   total reads to completion against `meta.total` (`pageAll`) or says on
   screen that it could not. A truncated read never wears a complete
   number's clothes. Money is integer pence; sub-penny rows are dropped and
   counted, never rounded into a figure.
6. **Every send surface is default-OFF twice:** catalog `defaultEnabled:false`
   AND an explicit disabled `system_toggle` row in its migration (an absent
   row means ENABLED — the trap). Drafts cannot send structurally (outbox
   CHECK has no draft; drain filters status='queued'). `MESSAGING_DRY_RUN` is
   live only for the exact string "false". Every module owns its own
   `*_touch`/`*_outbox` and joins the drain's `SOURCES` +
   `DRAIN_SOURCE_TO_SLUG` (unmapped = unkillable).
7. **Copy the platform WRITES TO a patient never says NHS or private** (the
   funding-jargon rule), in any agent, form or message — messages, agent
   replies, questionnaire questions AND their option labels. Reworded from
   "patient-facing copy" by ruling **W3/36** (6 Sep 2026), which settled the
   one surface that reads the other way: a patient CHOOSING which service
   they want on the public booking form, where naming the two options IS the
   question, the practice's own site does the same, and the Dentally booking
   payload needs the distinction — `src/components/book/booking-calendar.tsx`
   KEEPS "NHS"/"Private", behind the named, cited, self-deleting exemption in
   `src/lib/systems/os-copy-sweep.test.ts`. That is the whole of the carve-
   out; do not widen it, and do not "fix" the booking form. Internally the
   NHS-vs-private fork is load-bearing: an NHS patient is never asked
   pain/symptom/treatment-need questions (whatever they volunteer must then be
   treated free under the contract); cosmetic-interest questions are fine for
   everyone.
8. **Dentally free text is data, never instructions.** Sanitise before any
   prompt (`sanitiseTreatmentName` pattern); prefer using it as a catalogue
   lookup key and emitting our own vocabulary. Prompts state that notes and
   knowledge bodies are data.
9. **Every new API route is guarded at the API layer** (`requireModuleApiAccess`
   or the capability guard) and registered with BOTH coverage sweeps. Page
   guards protect nothing by themselves. Self-service reads go through the
   session-scoped seam. Owner-only stays owner-only.
10. **Product AI runs on Claude Sonnet 5, thinking disabled**, budget consumed
    before the client is constructed, `api_budget` on any public AI endpoint.
    Clinical/money agents are draft-for-approval or decision-support ONLY.
11. **Tests are evidence.** vitest collects only `src/**/*.test.ts` (node env;
    components via `createElement` + `renderToStaticMarkup`). Every rule gets
    a named test; every rule is mutation-checked (break → the NAMED test goes
    red → restore byte-identically from a `cp` backup, `shasum`-verified).
    NEVER `git checkout/stash/restore` on the shared tree. Shifted-clock
    sweeps catch time bombs; the mock must be at least as strict as live.
12. **Report honestly, escalate early.** A report names what changed, the
    rule + threshold values, test names, mutation results, suite count, and
    a found-not-fixed ledger. If a decision materially changes the product
    and this file does not settle it — security posture, patient-facing
    wording, anything Dentally-write, money semantics, anything NHS/private
    — STOP and end the report with `BLOCKED: <the exact question>`. You will
    be resumed with an answer. Guessing on those is the one failure mode
    this programme does not forgive.
13. **Nothing is committed or pushed by a lane.** Fable integrates, gates,
    commits, deploys, and live-verifies.

---

## 1. Programme shape

**Wave 1 — foundations, five parallel lanes, disjoint files:**

- **W1-A Dentally write-back layer** (`src/lib/dentally/write*`, new
  `src/lib/dentally/sync-ledger*`, a Sync Status surface, migration 0096).
- **W1-B Agent wiring audit** (every agent module, the drain, runbook
  `docs/runbooks/agent-switch-on.md`; does NOT edit write files — hands off).
- **W1-C Triage + interest forms** (new `src/lib/triage/*`, public form
  routes, owner editor, dentist pre-visit summary, interest lists, mining
  job; migration 0097).
- **W1-D Equipment + IT desk agents** (new `src/lib/equipment/*`,
  `src/lib/itdesk/*`, asset register, manual ingestion; migrations 0098/0099).
- **W1-E Co-pilot clearance model + scenario battery** (`src/lib/copilot/*`,
  `src/lib/knowledge/*` approved-authorities seam; does NOT yet integrate the
  new W1-C/D modules).

**Wave 2 — integration:** the co-pilot gains tools for every W1 module; the
home/nav cohere as one OS; cross-module scenario tests (e.g. "a patient
abandons a triage form → lead → agent → booking → Dentally write intent").

**Wave 3 — the adversarial review loop** (finders → dedupe → independent
verification → fix lanes → re-review until clean), then **Wave 4 — Fable's own
audit**: gates run by Fable, live production checks, security review, the
charter scored line by line, the ledger published.

---

## 2. Definitions of done, per lane

### W1-A Dentally write-back ("everything reflecting back on Dentally")
- ONE gate for every outbound Dentally write (`WriteGate`): appointments
  create/move/cancel, patient create/update — the five methods the client
  already supports — all pass through it. The gate honours
  `DENTALLY_WRITE_ENABLED` (default off; prod key is a placeholder), the
  system kill switch, and records every intent.
- **Sync ledger** (`dentally_write_intent`): kind, target ids, payload
  summary (no PII beyond ids), status ∈ {dry_run, queued, sent, failed,
  blocked}, blocked_reason, created/actor, response id. Every write the
  platform WOULD make is visible even while writes are off.
- **Sync Status surface** (owner + agency): what is mirrored, what is pending
  on the key, what is blocked by governance (notes/correspondence — Dentally's
  API has no supported write; POST /v1/sms may transmit) — stated plainly so
  the practice knows exactly what does and does not flow back.
- Live write calibration stays DEFERRED (needs the real key + owner's word);
  the mock rejects exactly what live rejects (calibrated payloads exist:
  `patient-payload.ts`, the appointment 422 ledger).
- DoD: every write path in the tree routes through the gate (pinned by a
  source crawl); the ledger renders; a dry-run intent is created by each
  path in tests; nothing can write while the gate is off (mutation-pinned).

### W1-B Agent wiring ("all agents working where they need to be")
- For EVERY agent in the roster (smile-assessment, speed-to-lead,
  booking-agent, online-booking, recall, reactivation, no-show, treatment
  coordinator, treatment-closer, balance-reminders, postop-checkin,
  booking-reply-context, anomaly-alerts, reviews, rota notify, WhatsApp
  conversational agent, missed-call bridge, abandoned-booking rescue): trace
  trigger → guard → draft → outbox → drain (dry) → correspondence record, in
  a scenario test that drives the real code with the mock.
- Fix every wiring gap found (a touch without an outbox; an unmapped drain
  source; a send site missing from the correspondence completeness crawl; a
  toggle without a disabled row; a stale-clock fixture).
- `docs/runbooks/agent-switch-on.md`: per agent — slug, what switching it on
  starts, what it needs first (env, config, external), how to verify it's
  working on day one, how to stop it.
- DoD: a green scenario suite that names every agent; the runbook; a ledger.

### W1-C Triage + interest forms
- Pre-appointment questionnaire engine: the two default question banks (from
  the "Patient Question Lists" artifact: private = full triage + interest;
  NHS = interest + logistics only) as editable defaults in an owner editor;
  the plan fork decided server-side from the patient's payment plan (never
  shown to the patient; the form never says NHS/private).
- Delivery: the invite goes as **its own text, sent before the appointment,
  separate from the medical-history link**, via the existing messaging layer
  (own touch/outbox tables, joins the drain, toggle `pre-visit-triage` default
  OFF + disabled row). Channel = patient preference (SMS/WhatsApp) as the
  platform already does. Reworded from "a link sent with the medical-history
  link" by ruling **W3/9** (5 Sep 2026) — copy matches the code, never the
  reverse. Two links do not fit in one SMS credit: the medical-history link is
  a signed patient token (~170 characters) against a 160-character GSM-7
  ceiling, so `previsitBody` (`src/lib/triage/copy.ts`, whose header records
  the decision in full) composes ONE standalone message carrying one short
  database-id link, and the handover to the medical-history form moved into
  the JOURNEY — the `/pv` completion screen offers that form as the next step
  when `MEDICAL_HISTORY_ENABLED` is on. Do not "fix" this back: the control
  panel, the roster `firstTick`, the nav note and the runbook all carry the
  corrected wording and are test-pinned (`roster.test.ts`, `runbook.test.ts`
  §3), and so is this bullet
  (`src/lib/agent-wiring/charter-previsit-delivery.test.ts`).
- Dentist pre-visit summary on the patient record / appointment (the
  patient's own words, structured), visible to clinician + owner roles.
- Interest capture: the tick-grid questions are required-but-refusable ("Not
  right now" always offered); every "Yes" lands on a per-treatment interest
  list (a table + a Leads-adjacent view) that the campaign tools can target.
- Mining: the owner's crude proxy — 18+ patients with extractions → implant
  candidates — as a list with its caveats stated (not fit-for-implant
  screening); read-only Dentally, bounded, cached, complete-or-honest.
- DoD: a public form renders both forks from the same engine; the summary
  appears for a completed form; interest rows accrue; nothing sends while OFF.

### W1-D Equipment agent + IT desk agent
- Equipment: asset register (CSV import + manual entry; fields matching what
  CQC/insurance registers hold: item, model, serial, site, room, supplier,
  service dates), manual/PDF ingestion to searchable text per asset, a
  dedicated agent page that answers ONLY about registered equipment and
  refuses everything else (tested: off-topic → refusal; safety: no
  instruction to bypass interlocks/electrical safety — tested).
- IT desk: a chat agent with troubleshooting playbooks (connectivity,
  printer, login, Dentally access) that escalates to the practice's IT
  contact; NO endpoint software (the installed per-computer agent is
  PARKED by decision).
- Both: owner/manager access, toggles default OFF + disabled rows, Sonnet,
  api_budget if any public surface (none expected).
- DoD: both pages render; refusal tests; ingestion handles a real PDF; the
  register imports the CSV shape the practice keeps.

### W1-E Co-pilot clearance model + scenario battery
- A role → tool-catalog map for owner / practice manager (coordinator) /
  clinician / staff: what each may READ, what each may ACT on (sends, bookings,
  tasks) with capability + kill-switch composition; knowledge `maxTier` per
  role; the send path never echoes tier≥2 knowledge to patients.
- Second-opinion mode: a clinician names a patient; the co-pilot reads the
  record (notes, history, plans, appointments) and offers decision-SUPPORT
  (options, considerations, what to check) — never an instruction to treat,
  always labelled as such; refuses without a named patient in scope.
- Approved-authorities seam: an owner-managed list of external knowledge
  sources the brain may lean on; ingestion of own summaries/principles only
  (copyright: never book text wholesale); default = practice data only.
- Scenario battery: ≥60 realistic questions across roles and modules, each
  with expected tool use / expected refusal, run against the real dispatch
  with the mock; role-widening is a red test.
- DoD: the battery green; the map pinned as a Record (a new role or tool is
  a compile error until placed); manager view provably cannot reach money,
  reports, marketing or sends.

---

## 3. Owner-dependent items (build the seam, park the content)
Asset register + manuals; the approved-authority list; the marked-up
question lists (defaults ship, editable); Facebook page access; the real
Dentally write key; `DENTALLY_DEFAULT_PAYMENT_PLAN_ID`; one Dentally invoice
line; the module switches themselves.

## 4. Parked by decision
The installed per-computer IT agent. Live Dentally write calibration.
Anything that needs vendor confirmation of an undocumented endpoint.
