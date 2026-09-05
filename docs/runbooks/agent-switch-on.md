# Switching an agent on

What each of the platform's automated agents does on its **first tick**,
what it needs before that tick can work, how to see it working inside an hour,
and how to stop it.

Written for the person holding the owner login on go-live day. Every claim here
is pinned by `src/lib/agent-wiring/roster.test.ts` (shape: a section, a slug and
the gaps for every agent) and `src/lib/agent-wiring/runbook.test.ts` (facts: what
the scheduler holds, which switches ship off, what the pre-visit invite is), and
traced end to end by `src/lib/agent-wiring/scenarios.test.ts` — so a change to the
code that makes a sentence here false turns a test red.

---

## 0. Read this before you switch anything on

**Three things stand between an agent and a real patient's phone. All three have
to be open before anybody is messaged.**

1. **`MESSAGING_DRY_RUN`.** Live sending happens only when this env var is the
   exact string `false`. Absent, empty, `False`, `fales`, `false ` with a trailing
   space — all of those mean **dry run**, and every "send" is a synthetic result
   in the log. This is deliberate: a typo in the Vercel env screen must never be
   the thing that starts texting 51,000 people.
2. **The agent's own switch** in **System controls** — the sidebar item under
   *Staff & Ops*, not a page inside Settings. **Six** of the agents below ship OFF
   twice over (declared `defaultEnabled: false` in the catalog *and* seeded
   disabled by their migration), so they are off even in a database the seed never
   reached: `treatment-closer`, `balance-reminders`, `postop-checkin`,
   `pre-visit-triage`, `booking-reply-context`, `anomaly-alerts`. Four more ship
   seeded-off only: `outreach`, `whatsapp`, `fp17`, `staff-esign`. Three systems
   that are not agents ship off twice over too and have no section below to
   remind you: `equipment`, `it-desk`, and the master `dentally-write-back`.
   The live list is `DEFAULT_OFF_SLUGS` in `src/lib/systems/catalog.ts`, derived
   from the catalog itself; this paragraph is asserted against it, so a new
   default-off agent turns a test red until it is named here.
3. **The cron job that triggers it.** Registration is *not* uniform, and §2 is
   the list — read it before you switch anything on, because it cuts both ways.
   **`outreach` and `anomaly-alerts` are registered and have been firing for
   months** (every ten minutes and hourly), so for those two the switch is the
   only thing between them and their first tick. **Five sweeps have no job at
   all** — the closer, the collection run, post-op, and both pre-visit passes —
   and switching those toggles on does **nothing at all**, with no error
   anywhere, until the SQL in §2 is run.

**What a switch actually stops.** Switching a system OFF halts everything it
*does to patients*: its sweep, its drafting, its outbox, its agent replies, its
public intake. It does **not** stop the read-only Dentally sync, so the dashboard
stays current and the practice can preview a system before turning it on.

**Two things about switching off that surprise people.**

- **A switch-off takes effect within ten rows for eight sweeps, and at the end of
  the batch for the rest.** Eight of them re-read the switch every ten rows for
  the whole run — `recall`, `reactivation`, `no-show-defence`,
  `treatment-coordinator`, `reviews`, `speed-to-lead`, `pre-visit-triage` and
  `outreach` — so flipping one of those off mid-run stops the drafting within ten
  rows rather than at the end of a 300-second batch. Those eight are every sweep
  that can text a patient without a member of staff approving it first, which is
  the reason they are the eight. **The remaining sweeps read their switch once,
  at the top of the tick, and then run that batch out**: `treatment-closer`,
  `balance-reminders`, `postop-checkin` and `rota`. That costs less than it
  sounds — the first three have no cron at all (§2) and only ever draft for a
  person to approve, and `rota` runs once a day and texts staff, not patients —
  but if you flip one of the four off while its tick is running, that tick
  finishes its batch. **In every case nothing already drafted is delivered:** the
  drain re-reads the switch and refuses the source, so the rows sit queued
  instead. The last three sweeps — `anomaly-alerts`, the implant-mining pass and
  the landing-page promoter — message nobody at all, so the question does not
  arise for them.
- **A queued row survives 48 hours — except a pre-visit invite.** Rows the drain
  could not send (because the system was off) stay queued and are retired unsent
  only once they are 48 hours old. Switch a system off and back on the same
  afternoon and the backlog goes out. If you want the queue gone rather than
  paused, leave the system off for two days, or clear the outbox rows by hand.
  **The one exception is `pre-visit-triage`:** a queued invite is also retired the
  moment its own appointment starts, however young the row is, because "Before
  your visit, a few quick questions" cannot arrive after the visit (ruling W3/5).
  So a pre-visit backlog does *not* all flush when you switch back on — the links
  for appointments that have already begun are gone, and those patients are asked
  at the desk instead.

**And one about things going wrong.** Once `MESSAGING_DRY_RUN` is `false`, every
piece of uncertainty fails closed. If the platform cannot read a system's switch,
or cannot read the list of patients marked inactive / do-not-contact, the tick is
**skipped** and the response says which (`"skipped": "system off"` or
`"skipped": "exclusions unavailable"`). Nothing is drafted and nothing is sent.
The next tick retries. While dry-run is on, both of those degrade the old way
instead, so development against a partial database still works.

**Panic stop, no deploy needed.** Set `MESSAGING_DRY_RUN=true` in Vercel and
redeploy, or pause every sweep at once:

```sql
select cron.alter_job(j.jobid, active := false)
  from cron.job j where j.jobname like 'app-sweep-%';
```

---

## 1. Suggested order

Nothing here is a technical dependency; it is the order that lets a person read
the output before the next thing starts.

1. `speed-to-lead` and `smile-assessment` — already on; they are the reference for
   what "working" looks like.
2. `no-show-defence` — highest value, but read §3 first: day one is a **backlog**.
3. `recall`, then `reactivation` — both are capped per day, so they ramp.
4. `reviews` — needs `REVIEW_LINK_URL` or it no-ops entirely.
5. `treatment-coordinator`, then `treatment-closer` and `balance-reminders` —
   the last two are draft-for-approval, so switching them on sends nothing.
6. `postop-checkin` — draft-for-approval too, and the most compliance-sensitive.
7. `outreach` and `anomaly-alerts` last.

---

## 2. Cron registration — the silent prerequisite

This table is **registration truth**, not intention: every row was read from
`cron.job` on the production project, and the schedule column is the schedule the
scheduler is holding — not the one an ops file proposes.

| Job | Schedule | Route | Status |
|---|---|---|---|
| `app-drain` | `*/5 * * * *` | `/api/messaging/drain` | **registered** |
| `app-sweep-speed-to-lead` | `* * * * *` | `/api/speed-to-lead/sweep` | **registered** |
| `app-sweep-recall` | `*/10 * * * *` | `/api/recall/sweep` | **registered** |
| `app-sweep-reactivation` | `*/10 * * * *` | `/api/reactivation/sweep` | **registered** |
| `app-sweep-noshow` | `*/10 * * * *` | `/api/noshow/sweep` | **registered** |
| `app-sweep-coordinator` | `*/10 * * * *` | `/api/coordinator/sweep` | **registered** |
| `app-sweep-outreach` | `*/10 * * * *` | `/api/outreach/sweep` | **registered** |
| `app-sweep-reviews` | `*/15 * * * *` | `/api/reviews/sweep` | **registered** |
| `app-sweep-anomaly` | `45 * * * *` | `/api/anomaly/sweep` | **registered** |
| `app-sweep-rota` | `0 6 * * *` | `/api/rota/sweep` | **registered** |
| `app-sweep-landing-promote` | `17 3 * * *` | `/api/landing-pages/promote-sweep` | **registered** |
| `app-prewarm-dentally` | `40 * * * *` | `/api/dentally/prewarm` | **registered** |
| `app-purge-assessment-step-events` | `43 4 * * *` | (in-database delete, no route) | **registered** |
| `app-sync-reactivation` | `5 * * * *` | `/api/sync/reactivation` | **registered** |
| `app-sync-recall` | `10 * * * *` | `/api/sync/recall` | **registered** |
| `app-sync-noshow` | `15 * * * *` | `/api/sync/noshow` | **registered** |
| `app-sync-coordinator` | `20 * * * *` | `/api/sync/coordinator` | **registered** |
| `app-sync-patient-count` | `15 3 * * *` | `/api/sync/patient-count` | **registered** |
| `app-sync-dentally` | `0 * * * *` | `/api/sync/dentally` | **registered, INACTIVE** |
| `app-sweep-closer` | `17 * * * *` | `/api/closer/sweep` | **not registered** |
| `app-sweep-collection` | `40 6 * * *` | `/api/collection/sweep` | **not registered** |
| `app-sweep-postop` | `25 * * * *` | `/api/postop/sweep` | **not registered** |
| `app-sweep-previsit` | `*/10 * * * *` | `/api/previsit/sweep` | **not registered** |
| `app-sweep-previsit-mining` | `20 2 * * *` | `/api/previsit/mining-sweep` | **not registered** |

The schedule shown for the last five is a **proposal**: those jobs do not exist,
so nothing is running on it. `app-sync-dentally` is the one row in between — the
job exists but is switched off at the scheduler (last successful run: 5 July
2026), so it is not the same failure as an unregistered job and `cron.alter_job`
rather than `cron.schedule` is what revives it.

**Where this list comes from.** A read-only `select jobname, schedule, active
from cron.job` against the production project on **4 September 2026**, with
`cron.job_run_details` to confirm the jobs actually fire rather than merely exist:
`app-sweep-outreach` had 6,949 successful runs, the last at 19:30 UTC that day,
and `app-sweep-anomaly` 336, the last at 18:45. The same list is held as data in
`src/lib/agent-wiring/runbook.test.ts`, which asserts this table row by row, so
the two cannot drift apart quietly: when a job is registered later, change the
data there and this table in one edit.

**An ops file's header is not evidence.** The SQL for the closer, the collection
run and post-op is in `supabase/ops/register-*-cron.sql`, written and deliberately
not applied. Two of those files — `register-outreach-cron.sql` and
`register-anomaly-cron.sql` — still describe themselves as *"NOT YET APPLIED"*
even though their jobs have been running for months. A file states its status on
the day it was written; `cron.job` states it today. Read the table, not the
header. Note also that `register-anomaly-cron.sql` schedules minute **40** while
the live job runs at minute **45**, and `cron.schedule()` on an existing job name
*updates* it — so running that file now would move a job that is already working.

**The two pre-visit jobs have no ops file at all**, so their SQL is here. Neither
can be triggered any other way: both routes require the scheduler's secret, and
the sweep is the only writer of `previsit_outbox`, so until this is run the
`pre-visit-triage` switch prepares the module and sends nothing.

```sql
-- app-sweep-previsit — the pre-visit questionnaire sweep.
-- Flags upcoming appointments and queues one fixed-template link each, 24 hours
-- ahead by default and only inside 08:00-20:00 Europe/London. */10 matches the
-- other lifecycle sweeps: there is ONE send instant per appointment, so the
-- cadence is simply the precision with which that instant is hit.
-- Safe to register before the system is switched on — 'pre-visit-triage' is
-- default-off, so every run returns {"ok":true,"skipped":"system off"} until an
-- owner enables it. CRON_SECRET is not written here; it lives inside
-- public.trigger_app_cron(), exactly as every other job relies on.
select cron.schedule(
  'app-sweep-previsit',
  '*/10 * * * *',
  $$select public.trigger_app_cron('/api/previsit/sweep')$$
);
```

```sql
-- app-sweep-previsit-mining — the implant-interest scan behind "People who might
-- want to hear about implants". Read-only against Dentally, bounded (30 days of
-- book and 120 patient reads per run), resumable, background priority, and it
-- messages nobody.
-- NIGHTLY because the engine is built around it: each run walks 30 more days
-- backwards (MINING_DAYS_PER_RUN), so about five weeks of nights reach the
-- three-year horizon (MINING_HORIZON_DAYS = 1095). 02:20 keeps it clear of the
-- 03:xx daily jobs and of the hourly Dentally prewarm.
-- WHAT A NIGHT COSTS, so that nobody registers this blind. The scan reads the
-- book ONE DAY AT A TIME per site, because a day it did not read is a day it must
-- not claim. That is
--     31 days x 3 mapped sites = about 93 appointment requests
-- a run (a day carrying more than 100 appointments adds a page, up to 12), plus
--     at most 120 patient reads (MINING_MAX_PATIENT_READS_PER_RUN)
-- split evenly between the sites so that none starves another (ruling W3/25).
-- All of it at BACKGROUND priority against the shared 3,600/hour Dentally
-- budget, so it yields to the diary and to anything a member of staff is waiting
-- on, and a run that is refused simply resumes tomorrow having lost nothing.
-- If that is too much for this practice the lever is MINING_DAYS_PER_RUN in
-- src/lib/triage/mining.ts — read a smaller window, never a coarser slice: the
-- day-at-a-time reading is what makes the coverage sentence on screen true.
-- It shares the 'pre-visit-triage' switch. There is a second, owner-only door
-- onto the same engine — POST /api/previsit/mining-run, gated on the owner's
-- session and on that switch — and it takes the same lease, so a manual run
-- during a scheduled one is answered rather than doubling the practice's
-- Dentally reads. THAT DOOR NOW HAS ITS BUTTON: "Build / refresh candidates" on
-- the pre-visit page, owner-only on screen as well as at the route, and disabled
-- with the route's own sentence while 'pre-visit-triage' is off, because the scan
-- reads real patient history (rulings W3/8, W3/21, W3/27). So an owner can fill
-- the list by hand today; registering this job is what makes it fill itself
-- overnight instead of a window at a time, by hand.
select cron.schedule(
  'app-sweep-previsit-mining',
  '20 2 * * *',
  $$select public.trigger_app_cron('/api/previsit/mining-sweep')$$
);
```

The app's Supabase role is read-only on the `cron.job` **table**, so use the
`cron.*` functions (they are `SECURITY DEFINER`), never a plain `update`.
`cron.schedule()` on an existing job updates the schedule but keeps the current
active flag — use `cron.alter_job` to (de)activate.

Watch any of them:

```sql
select jobname, status, return_message, start_time
  from cron.job_run_details order by start_time desc limit 20;
```

---

## 3. The agents

Each section: **slug** · what switching it on starts · what it needs first ·
how to verify in the first hour · how to stop it · residual gaps.

---

### Smile Assessment — `smile-assessment`

**Switch:** `smile-assessment` (plus `speed-to-lead`, see gaps).
**Trigger:** `src/app/api/smile-assessment/submit/route.ts`.

**Day one.** The public `/assess` pages come online. A submission that clears the
follow-up band becomes a speed-to-lead lead and is texted **inside the request** —
there is no queue and no delay.

**Volume bound.** One message per submission, and only for a submission the
follow-up config selects. A medium-band enquiry lands on the task queue for a
person to decide instead.

**Needs first.** `SMILE_ASSESSMENT_SUBMIT_KEY` set in prod (without it the
auto-contact fails closed), `PUBLIC_BASE_URL`.

**Verify in the first hour.** Leads → the new lead appears with a first-contact
attempt. Conversations → the outbound turn. The submit route's response body
carries the contact outcome.

**Stop.** Switch off `smile-assessment` (the public pages 503) or `speed-to-lead`
(the form stays up, nobody is texted).

**Gaps.** DOUBLE-GATED on purpose: auto-contact needs **both** switches. Turning
`smile-assessment` on alone publishes the form and contacts nobody, which looks
exactly like a broken integration.

---

### Speed-to-lead — `speed-to-lead`

**Switch:** `speed-to-lead`. **Trigger:** `src/app/api/speed-to-lead/sweep/route.ts`
(every minute) and `src/app/api/speed-to-lead/intake/route.ts` (in-request).

**Day one.** Every uncontacted lead inside the 48-hour window is drafted and
texted on the next minute's tick. The nurture cadence then follows up the ones
who never replied.

**Volume bound.** Leads are taken in age order. A lead whose delivery fails is
retried at most 3 times and then left in the worklist for a person.

**Needs first.** `SPEED_TO_LEAD_INTAKE_KEY`, a configured Twilio sender,
`PUBLIC_BASE_URL` (without it no delivery-status callback is attached and the
undelivered-retry path is dead).

**Verify in the first hour.** Leads worklist → stage moves `new` → `contacted`,
with an attempt row and a first-response time.

**Stop.** Switch off `speed-to-lead`. Public intake is rejected and nothing is
auto-contacted.

**Gaps.** `contactLead` reads no toggle itself; all four callers gate it, which
is now pinned by a source crawl rather than by a guard inside the function.

---

### Missed-call text-back — `missed-call-bridge`

**Switch:** `after-hours`. **Trigger:** `src/app/api/webhooks/twilio/voice/route.ts`.

**Day one.** A missed call is captured and the caller is texted back. Where the
number is new it also becomes a speed-to-lead lead, so the booking agent picks up
whatever they reply.

**Volume bound.** One text per call, deduped against an existing open lead for
the same number.

**Needs first — and this is the one that has never been done.**

1. The practice's Twilio number's **Voice** webhook pointed at
   `/api/webhooks/twilio/voice`.
2. `PUBLIC_BASE_URL` byte-matching the URL in the Twilio console — a mismatch
   makes the signature check 403 every call.
3. The practice's real line forwarding on no-answer to the Twilio number (their
   telephony provider does this, not us).
4. `STAFF_ALERT_PHONE`, so an escalation reaches a person; without it the
   platform falls back to an urgent task rather than going silent.

**Verify in the first hour.** Ring the practice line, let it ring out. After-hours
worklist → the capture row. Conversations → the outbound callback text. Twilio
console → the Voice webhook returning 200.

**Stop.** Switch off `after-hours`.

**Gaps.** This path has never run end to end against a real call. The Twilio
number on file is a UK mobile and may not be voice-capable.

---

### Abandoned-booking rescue — `abandoned-booking-rescue`

**Switch:** none of its own — it runs inside the speed-to-lead sweep.
**Trigger:** `src/lib/booking/abandoned-holds.ts`.

**Day one.** A booking hold abandoned for 20 minutes becomes a lead, which the
same sweep then first-contacts like any other enquiry.

**Volume bound.** At most 25 holds converted per tick.

**Needs first.** Both `speed-to-lead` and `online-booking` switched on. An owner
who has turned online booking off has turned off the page this text invites the
patient back to, so the rescue stops with it (ruling W1-B/4, 3 Sep 2026).

**Verify in the first hour.** Start a booking on `/book`, abandon it, wait 20
minutes. Leads → a lead sourced from the booking page with an attempt row.

**Stop.** Switch off **either** `speed-to-lead` or `online-booking` — the rescue
needs both to be on.

**Gaps.** None outstanding. The basis is deliberately narrow: the patient typed
their number into the booking form under microcopy about *that* booking, so they
get exactly **one** transactional follow-up about it and are excluded from the
three-touch nurture cadence. The lead records `consent.source = "booking-form"`
and never carries marketing consent.

---

### Online booking — `online-booking`

**Switch:** `online-booking`. **Trigger:** `src/app/api/booking/create/route.ts`.

**Day one.** The public `/book` page starts creating real Dentally appointments
from held slots. It says nothing to the patient; the confirmation they get is
Dentally's.

**Volume bound.** One appointment per completed hold. Holds expire after 20
minutes.

**Needs first.** `DENTALLY_DEFAULT_PAYMENT_PLAN_ID`, a Dentally key with write
scope, and `DENTALLY_WRITE_ENABLED`.

**Verify in the first hour.** Book a slot yourself. The diary shows it; the route
returns the Dentally appointment id.

**Stop.** Switch off `online-booking`. Availability stays viewable — that is
deliberate — but nothing can be booked.

**Gaps.** The create route reads the switch fail-**closed** while the hold route
reads it fail-open, on purpose: a hold is reversible and a booking is not. Slot
duration against live Dentally is still uncalibrated — see
`docs/runbooks/booking-live-calibration.md`.

---

### Booking agent (SMS) — `booking-agent`

**Switch:** `booking-agent`. **Trigger:** `src/app/api/webhooks/twilio/inbound/route.ts`.

**Day one.** Every inbound SMS gets an agent reply within the request. STOP is
honoured whether the agent is on or off.

**Volume bound.** A per-sender budget (`AGENT_SENDER_BUDGET_LIMIT` per
`AGENT_SENDER_BUDGET_WINDOW`) stops one number consuming the practice's spend.

**Needs first.** A Twilio sender, and the number's **Messaging** webhook pointed
at `/api/webhooks/twilio/inbound`. For booking into real Dentally,
`DENTALLY_DEFAULT_PAYMENT_PLAN_ID`.

**Verify in the first hour.** Text the practice number. Conversations → a
two-way thread with agent turns.

**Stop.** Switch off `booking-agent`. Inbound messages are flagged for a human;
opt-out still works.

**Gaps.** Without `DENTALLY_DEFAULT_PAYMENT_PLAN_ID` the agent refuses to
register a new patient early and routes them to the onboarding form, rather than
hitting a 422 mid-conversation.

---

### WhatsApp agent (inbound) — `whatsapp-agent`

**Switch:** `whatsapp-agent`. Note this is a **different** switch from `whatsapp`,
which controls outbound routing only. Switching sending off must never silently
swallow an inbound patient message.

**Day one.** Inbound WhatsApp messages get an agent reply, on the same route as
SMS.

**Needs first.** The client's Meta Business login, and `TWILIO_WHATSAPP_FROM`.
Without a WhatsApp sender configured, a patient's WhatsApp preference is a no-op
and everything routes to SMS.

**Verify in the first hour.** Message the WhatsApp number. Conversations → a
thread whose channel reads WhatsApp.

**Stop.** Switch off `whatsapp-agent`.

**Gaps.** Blocked on the client's Meta login; only the Twilio sandbox has ever
been exercised.

---

### Booking reply context — `booking-reply-context`

**Switch:** `booking-reply-context` (ships OFF twice over).

**Day one.** The booking agent starts recognising which invite a "yes" is
answering, instead of opening a fresh conversation. It sends nothing itself.

**Volume bound.** One resolved context per inbound message, and never one more
than 30 days old.

**Needs first.** `recall` or `reactivation` switched on, or there is no invite for
it to recognise.

**Verify in the first hour.** Reply "yes" to a recall text. The agent's answer
should name the appointment type the invite offered.

**Stop.** Switch it off. With no context resolved the agent is byte-for-byte its
old self, so this is an exact revert.

**Gaps.** Post-op check-ins deliberately never prime the agent.

---

### Recall concierge — `recall`

**Switch:** `recall`. **Trigger:** `src/app/api/recall/sweep/route.ts` (every 10 min).

**Day one.** Up to `RECALL_DAILY_CONTACT_LIMIT` (default **25**) due patients are
drafted, auto-approved and queued. The drain sends them within five minutes.

**Volume bound.** 25 per Europe/London day across the whole 51k book. Capped
cadences stay due and continue tomorrow, so it ramps rather than blasts.

**Needs first.** Nothing external. Consider setting `RECALL_DAILY_CONTACT_LIMIT`
lower for the first week; `0` is a valid "paused" value.

**Verify in the first hour.** Recall worklist → touches move draft → approved →
sent. The drain's response reports `perSource.recall.sent`.

**Stop.** Switch off `recall`. Queued rows stay queued and drain when it is
switched back on — see the 48-hour note in §0.

**Gaps.** A row queued while recall was off still goes out if the system comes
back on inside 48 hours.

---

### Reactivation — `reactivation`

**Switch:** `reactivation`. **Trigger:** `src/app/api/reactivation/sweep/route.ts`.

**Day one.** Lapsed patients scoring above `REACTIVATION_AUTO_SEND_THRESHOLD` are
drafted, approved and queued. Everyone below it waits in the worklist for a
person.

**Volume bound.** The `reactivation_settings` daily contact limit, enforced
*before* drafting so a capped run costs no model calls.

**Needs first.** Decide `REACTIVATION_MAX_LAPSE_MONTHS`. It is **uncapped** by
default, which on this book means patients last seen many years ago are in scope.

**Verify in the first hour.** Reactivation worklist → touches reach sent; drain
reports `perSource.reactivation`.

**Stop.** Switch off `reactivation`.

**Gaps.** Its four tables were created out-of-band and have no migration, so
their real constraints are invisible from the repo. Same per-run toggle read as
recall.

---

### No-show defence — `no-show-defence`

**Switch:** `no-show-defence`. **Trigger:** `src/app/api/noshow/sweep/route.ts`.

**Day one — read this twice.** Confirmations go out for every appointment already
inside its T-48h / T-24h / T-3h window. On a practice with a full diary that is a
**backlog**, not a trickle. The sweep is two-pass on purpose: it settles
unsendable targets first, then sends at most `NOSHOW_MAX_SENDS_PER_RUN`
(default 25) ordered by soonest appointment.

**Volume bound.** 25 per ten-minute tick. Lower it for the first day.

**Needs first.** `NOSHOW_MAX_SENDS_PER_RUN`, `NOSHOW_OFFER_TTL_HOURS` (default 4).

**Verify in the first hour.** No-show worklist → confirmations sent. The drain
reports `perSource.noshow`; this source is *transactional*, so it drains second
and is never blocked by the daily cap.

**Stop.** Switch off `no-show-defence`. Confirmations, reminders **and waitlist
fill** all stop — the fill guard now lives inside `offerSlotToNextCandidate`
itself, so every path that could offer a freed slot is covered.

**Gaps.** Waitlist slot offers carry a NULL `target_id`, so they show in the
no-show module's own view but on nobody's patient record; fixing that needs a
schema change. Above roughly 300 in-window appointments the sync's run cap can
mark live appointments cancelled — watch that on day one.

---

### Treatment Coordinator — `treatment-coordinator`

**Switch:** `treatment-coordinator`. **Trigger:** `src/app/api/coordinator/sweep/route.ts`.

**Day one.** Unfinished treatment opportunities scoring above
`COORDINATOR_AUTO_SEND_THRESHOLD` are drafted and queued; the rest wait for
approval.

**Volume bound.** The sweep's own per-run cap, then the drain's cross-module
once-per-day-per-patient cap.

**Verify in the first hour.** Treatment Coordinator worklist → touches sent;
drain `perSource.coordinator`.

**Stop.** Switch off `treatment-coordinator`.

**Gaps.** It is the only module whose outbox is the bare legacy `outbox` table.
`src/app/api/sync/coordinator/route.ts` reads no toggle, but it only mirrors
opportunities — no touch, no outbox, no send — which is the same posture as every
other read-only sync.

---

### Treatment-plan closer — `treatment-closer`

**Switch:** `treatment-closer` (ships OFF twice over).
**Trigger:** `src/app/api/closer/sweep/route.ts`.

**Day one. NOTHING IS SENT.** The sweep drafts follow-ups on unaccepted plans for
a human to approve. Approval is the only thing that ever writes `closer_outbox`,
and that is structural: the outbox CHECK constraint has no `draft` value at all.

**Volume bound.** `CLOSER_DRAFT_BUDGET_LIMIT` drafts per
`CLOSER_DRAFT_BUDGET_WINDOW`; `CLOSER_COOLDOWN_HOURS` between chases to one
patient.

**Needs first.** **Register the cron** (`supabase/ops/register-closer-cron.sql`,
not applied). Set `CLOSER_BOOKING_URL`.

**Verify in the first hour.** The closer queue in the coordinator worklist fills
with drafts. Nothing leaves until somebody approves one.

**Stop.** Switch off `treatment-closer`.

**Gaps.** Switching the toggle on alone does nothing until the cron is
registered. It drains immediately after the coordinator, so on a day where both
have something for the same patient the coordinator wins and the closer's message
is blocked by the daily cap rather than arriving as a second chase.

---

### Balance reminders — `balance-reminders`

**Switch:** `balance-reminders` (ships OFF twice over).
**Trigger:** `src/app/api/collection/sweep/route.ts`.

**Day one. NOTHING IS SENT.** Reminders about unpaid invoices are drafted for
approval, and **no figure is quoted** by default.

**Volume bound.** `COLLECTION_DRAFT_BUDGET_LIMIT` per window;
`COLLECTION_COOLDOWN_HOURS` between reminders to one patient.

**Needs first.** Register the cron (`supabase/ops/register-collection-cron.sql`,
not applied). Set `COLLECTION_PAYMENT_URL`. **Reconcile one real Dentally invoice
by hand before `COLLECTION_QUOTE_AMOUNT` is ever set** — pounds-versus-pence is
unresolved against live data, and a reminder quoting the wrong figure is worse
than one quoting none.

**Verify in the first hour.** The balance queue fills with drafts.

**Stop.** Switch off `balance-reminders`.

**Gaps.** Cron unregistered. The tone is locked and the module's own compliance
scan refuses any word that would make it a collections chase; that scan is not
optional and must not be relaxed.

---

### Post-op check-in — `postop-checkin`

**Switch:** `postop-checkin` (ships OFF twice over).
**Trigger:** `src/app/api/postop/sweep/route.ts`.

**Day one. NOTHING IS SENT.** One check-in per flagged procedure (extraction,
implant, surgical) is drafted for approval. **Replies are triaged and escalated
whether the system is on or off** — a switch flipped afterwards must never be the
reason a patient's symptom went unseen.

**Volume bound.** One check-in per flagged appointment, retired unsent after 48
hours. It is *not* transactional, so it yields the patient's daily slot to a
recall or a review request.

**Needs first.** Register the cron (`supabase/ops/register-postop-cron.sql`, not
applied). Set `STAFF_ALERT_PHONE`.

**Verify in the first hour.** The post-op queue fills. Reply to a check-in with a
symptom word and an escalation appears immediately.

**Stop.** Switch off `postop-checkin`. Drafting and sending stop; triage does not.

**Gaps.** There is **no model anywhere on the reply path**, by design — the
message is a fixed template and the triage is a classifier that fails safe.
Adding a drafter, or a staff edit box, re-opens the clinical-advice risk that
design closes. Do not add one.

---

### Pre-visit questions — `pre-visit-triage`

**Switch:** `pre-visit-triage` (ships OFF twice over).
**Trigger:** `src/app/api/previsit/sweep/route.ts`.

**Day one.** Patients with an appointment coming up are sent a link to a short
questionnaire. It is **its own text**, sent before the appointment and separate
from the medical-history link the practice already sends — one extra message per
appointment. Two links do not fit in one SMS credit, so the handover lives in the
journey instead: when the medical-history form is enabled, the pre-visit form's
completion screen offers it as the next step. `src/lib/triage/copy.ts` is where
that decision is recorded, and it is the contract for this wording.

**Volume bound.** One invite per upcoming appointment, bounded per site by the
sweep's own page cap. It drains as **transactional**, so it is exempt from the
once-per-day outreach cap — a patient can receive this and a recall on the same
day.

**Needs first — and this one is a hard stop.** `/api/previsit/sweep` **has no
cron job** (§2 carries the exact SQL). The sweep is the only writer of
`previsit_outbox` and the route answers only the scheduler, so until that SQL is
run, switching `pre-visit-triage` on prepares the module and sends nothing at all,
silently: no invite, no queue row, no error. Also `PUBLIC_BASE_URL`, so the link
the text carries resolves.

**Verify in the first hour.** The patient's Correspondence tab shows the invite.
A completed form appears as the **pre-visit summary on the patient's record**,
above the appointment list on their Appointments tab — what the viewer may read
is decided server-side by role, so a manager sees a symptom count and a
discomfort flag rather than the patient's words.

**Stop.** Switch off `pre-visit-triage`. The sweep, the queue **and the public
form** all stop — a link already sent stops opening, so the flip is a complete
revert rather than a stop with a live form still collecting answers. This is the
one module where the 48-hour queue rule in §0 does not simply pause the backlog:
a queued invite is retired the moment its own appointment starts, so switching
back on the next morning sends nothing to anyone whose appointment has already
begun (ruling W3/5 — the invite may never arrive after the visit). Those patients
are asked at the desk.

**Gaps.** Which questions a patient is asked forks on their payment plan,
server-side, and the form never says which. That fork is load-bearing and is not
a switch: read the module's own notes before changing anything about it. The
implant-candidate mining pass shares this switch and is the second job with no
cron (§2, which carries its SQL as well), so the implant-candidate list does not
build or refresh itself overnight. **It can be built by hand in the meantime:**
the owner-only **Build / refresh candidates** button on the pre-visit page posts
to `POST /api/previsit/mining-run` — the same engine as the nightly job, taking
the same lease — and prints what that run actually read rather than a spinner.
A practice manager does not see it, and while `pre-visit-triage` is off the
button is disabled and says so, because the scan reads real patient history
(rulings W3/8, W3/21, W3/27). One press is one window, not a finish: the list
grows about a month of book at a time, so until that cron is registered somebody
has to keep pressing it.

---

### Reviews — `reviews`

**Switch:** `reviews`. **Trigger:** `src/app/api/reviews/sweep/route.ts` (every 15 min).

**Day one.** Patients who attended more than `REVIEW_DELAY_HOURS` ago are asked
for a review, inside the `REVIEW_MORNING_HOUR`–`REVIEW_CUTOFF_HOUR` window only.

**Volume bound.** One request per attended appointment. It drains after the
lifecycle messages, so it yields the daily slot to all of them.

**Needs first.** `REVIEW_LINK_URL` — **without it the sweep no-ops entirely**, so
a switched-on reviews system that appears to do nothing is almost always this.
Also `REVIEW_PRACTICE_NAME`.

**Verify in the first hour.** The drain reports `perSource.reviews.sent`; request
rows move to sent.

**Stop.** Switch off `reviews`, or unset `REVIEW_LINK_URL`.

**Gaps.** Templated deliberately: a model must never paraphrase a review link or
an incentive, for ASA/CMA reasons.

---

### Segment outreach — `outreach`

**Switch:** `outreach` (seeded disabled since migration 0041).
**Trigger:** `src/app/api/outreach/sweep/route.ts`.

**Day one.** Campaigns that have already been built start drafting and queueing
to their targets.

**Volume bound.** Per-campaign target caps. It drains **last**, so it yields its
once-per-day slot to every automatic lifecycle message.

**Needs first.** Nothing. `app-sweep-outreach` **is registered and firing every
ten minutes** (§2), so this switch is the only thing between a built campaign and
its first drafted message. Read that sentence twice before flipping it.

**Already running with the switch off.** The build-continuation pass at the top of
the route is deliberately **ungated** — it advances any campaign left in
`building` to `ready`, and reads Dentally to do it, on every tick regardless of
the switch. Only sending is gated. So "nothing is happening yet" is not true of
this route even today.

**Verify in the first hour.** The campaign's own progress counters; drain
`perSource.outreach`.

**Stop.** Switch off `outreach`. Campaign **building** deliberately continues —
building is not sending — and only the sending stops.

**Gaps.** It has only ever run in supervised tests.

---

### Diary appointment moves — `diary-notify`

**Switch:** `calendar-writes`. **Trigger:** `src/app/api/calendar/appointment/[id]/route.ts`.

**Day one.** Moving an appointment in the diary texts the patient their new time.
This is the most time-critical message the platform sends, so it drains **first**,
ahead of even the no-show confirmations.

**Volume bound.** One notice per move.

**Needs first.** The site's public phone number. The reschedule text refuses to
draft without one, and the confirmation dialog says so before anyone commits.

**Verify in the first hour.** Move an appointment. The patient's Correspondence
tab shows the notice.

**Stop.** Switch off `calendar-writes`. The move **and** its text stop together —
switching the write off but leaving the notice on would text a patient about a
change that never happened.

**Gaps.** A move whose `diary_move` row is deleted resolves to no patient and
drops off the record.

---

### Proactive alerts — `anomaly-alerts`

**Switch:** `anomaly-alerts` (ships OFF twice over).
**Trigger:** `src/app/api/anomaly/sweep/route.ts`.

**Day one.** The first hourly pass raises alerts for takings dips, no-show
clusters, uncontacted-enquiry SLA breaches and stuck queues. **It never messages
anyone** — it writes rows the in-app Notifications feed reads.

**Volume bound.** Deduped per condition. An alert resolves only on evidence the
condition **ended**, never because the collector failed to look.

**Needs first.** Nothing. `app-sweep-anomaly` **is registered and active**,
hourly at minute **45** (§2) — not minute 40, which is what its ops file would
set if anybody ran it now.

**Verify in the first hour.** Notifications → the alerts appear with their
evidence.

**Stop.** Switch off `anomaly-alerts`. The pass stops **and** alerts already
raised stop showing, so a flip is a complete revert with no residue.

**Gaps.** Alerts are client-scoped while the notifications feed is site-scoped —
a product call, not a security one. It ships off so a week of its output can be
read by a person before anybody relies on it; the cron has been running the whole
time, returning `{"ok":true,"skipped":"system off"}` on every pass.

---

### Staff rota notifications — `rota-notify`

**Switch:** `rota`. **Trigger:** `src/app/api/rota/publish/route.ts` (manual) and
`src/app/api/rota/sweep/route.ts` (daily 06:00 UTC).

**Day one.** Publishing a rota texts and emails every member of staff their own
shifts. The daily sweep then texts each of them their upcoming list.

**Volume bound.** One message per member of staff per publication, one per day
from the sweep.

**Needs first.** Staff mobile numbers on the `rota_staff` rows, and a Twilio
sender. Publishing also needs an approver role and the `rota.publish` capability.

**Verify in the first hour.** The publish response reports `notifiedStaff`,
`notifiedShifts` and `sendFailures`.

**Stop.** Switch off `rota`. Auto-generation and the staff texts stop together.

**Gaps.** These are **staff** messages and are deliberately kept off patient
records. Filing a nurse's shift text under a patient of the same name would be
its own defect.

---

## 4. Where to look when an agent seems dead

| Symptom | Almost always |
|---|---|
| Switched on, nothing happens, ever | Its cron is not registered (§2). Today that is the closer, the collection run, post-op, and both pre-visit jobs — and nothing on screen says so |
| Reviews sends nothing | `REVIEW_LINK_URL` unset |
| Drafts appear, nothing sends | Draft-for-approval by design (closer, balance, post-op) — or `MESSAGING_DRY_RUN` is not the exact string `false` |
| Queued rows, nothing sends | The system's own switch is off, or the drain's toggle read failed while messaging is live (it fails **closed**: the whole tick is skipped) |
| `"skipped": "exclusions unavailable"` | The patient-override table could not be read while messaging is live. Nobody is drafted until it can be. Check Supabase, then wait a tick |
| One patient gets nothing | Suppressed (STOP), no consent on that channel, or another module already used their one message today |
| A burst of old messages | A system switched off and back on inside 48 hours (§0) |
| Missed calls do nothing | The Twilio Voice webhook, or `PUBLIC_BASE_URL` not byte-matching the console |
| Agent refuses to register a patient | `DENTALLY_DEFAULT_PAYMENT_PLAN_ID` unset |

## 5. The cross-module rules that surprise people

- **One outreach message per patient per London day, across every module.** The
  drain enforces it on the resolved address, so SMS and WhatsApp to the same
  handset are one message. Transactional confirmations (diary moves, no-show)
  are exempt from being blocked but still stamp the day, so outreach yields to
  them.
- **Drain order is a policy, not an accident:** diary → no-show → pre-visit →
  recall → reactivation → coordinator → closer → post-op → reviews → balance →
  outreach. It is a ranking of what a patient should receive if only one thing
  may arrive. The first three are *transactional* — a patient expects them about
  an appointment they already have — so they are exempt from the daily cap, while
  still stamping the day so the outreach agents yield to them.
- **A draft cannot send.** For the approval modules this is structural in three
  independent ways: the outbox CHECK constraint has no `draft` value, the insert
  writes only the touch table, and the drain lists only `status='queued'`.
- **Patient-facing copy never says NHS or private**, in any agent, any form, any
  message. The output guardrail in the drain blocks the row rather than sending
  it, and logs loudly.
