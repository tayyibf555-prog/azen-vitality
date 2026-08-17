# Runbook — the authorised live booking re-confirmation write

**Status: not yet run on the current code — but this is a RE-CONFIRMATION, not a
first unknown.** A materially identical live write **already succeeded on
2026-07-25**: the public booking funnel registered patient **56194** ("Tayyib
Arbab") on the **Romford Road** site (`site-ng`, Dentally
`5855c8c1-2c3b-46c3-8c0f-36a9a774d2e6`) and wrote appointment **1070037012** at
exactly 30 minutes. That appointment was rolled back and now reads state
**"Cancelled"**. The patient record was not — Dentally has no patient delete — so it
is **still on file**; see "Rollback" in section 4 before you enter test details.

So the payload shape is **not** an open question, and this document must not be read
as if it were. What section 4 covers is a **re-confirmation on the current code**:
three defects were found and fixed after that write (section 1), so today's write
path is not the byte-identical path that succeeded in July, and the point of the
exercise is to show it still lands. It is still a **human** who performs it, after
explicit authorisation.

The calibration in section 1 was itself produced without issuing a single write to
live Dentally: everything there is from GET-only probes of the live API (2026-08-17)
plus the local mock.

---

## THE RULE

> **No POST / PUT / PATCH / DELETE to any live Dentally endpoint, ever, under any
> framing — "just one test write" included.** The only permitted live Dentally
> traffic is `GET` with the existing read key. All write-path testing runs against
> the local mock (`DENTALLY_BASE_URL=http://localhost:3002/api/mock-dentally`, the
> `azen-web-mockwrite-3002` launch profile). `DENTALLY_WRITE_*` is never pointed at
> a live URL anywhere, including ad-hoc env vars in a test command.
>
> — `docs/superpowers/plans/2026-08-17-go-live-activation.md`

This runbook is the **single, deliberate exception**, and it is an exception only
when a human with authority to authorise it runs the steps in section 4 themselves.
No agent, script, cron or test may perform it. Until then the checklist in section 3
stays unticked and `DENTALLY_WRITE_ENABLED` stays off in production.

---

## 1. What the calibration already proved, without writing

These were read from the live API with `DENTALLY_PROD_READONLY_API_KEY`
(`Authorization: Bearer <key>` plus `User-Agent: Azen-Vitality/0.1
(+https://azen.ai)` — the key 403s without a User-Agent).

| Claim in the code | Live reading (2026-08-17) | Verdict |
|---|---|---|
| `payment_plan` 1 = NHS, 2 = Private | `GET /v1/payment_plans`: 15 active; id 1 **is** "NHS", id 2 **is** "Private" | confirmed |
| Titles are Mr/Mrs/Miss/Ms/Master | `GET /v1/patients` ×800: those five are 99.6%; tail is `Dr` (2), `Rev` (1) | confirmed |
| `gender` is a boolean, true = male | 800/800 boolean. Zero strings, zero integers | confirmed |
| Title → sex is "proven" | `Mr` → male 227, **female 5**. Mrs/Miss/Ms → female 387/387 | **was overstated; comment corrected** |
| `date_of_birth` is `YYYY-MM-DD` | 800/800 matched, none null | confirmed |
| The 7 booking reasons are accepted | `GET /v1/appointment_reasons`: 16 rows; ours are positions 1–7, spelled exactly | confirmed |
| `mobile_phone=` filters patients | **It does not** — live returns an unfiltered page. `query=<mobile>` is the real lookup | already correct in `client.ts`; the **mock** was wrong and is fixed |

Three defects were found and fixed during this pass; all three would have produced
a live failure that the local suite was structurally incapable of catching:

1. **`payment_plan_id` could vanish from the payload.** Both whitelists were bare
   object lookups, so `funding: "constructor"` returned `Object` — not `undefined`,
   so it passed the guard — and `JSON.stringify` then silently dropped the field,
   producing exactly the live 422 `payment_plan: seems to be missing`. Public and
   unauthenticated. Fixed with a null-prototype map plus a `typeof` check.
2. **Live gender was being discarded on read.** `normaliseGender` handled strings
   and integers but not booleans, so against live data *every* patient normalised to
   "no gender on file" — an outreach campaign with a gender filter would have matched
   zero patients and reported them all as missing-data. Silent; nothing threw.
3. **The kill switch failed OPEN on the write path.** `/api/booking/create` read the
   owner's switch with `isSystemEnabled`; a transient Supabase error while booking
   was switched **off** would have let a stranger's appointment into a real diary.
   Now `isSystemEnabledStrict` (fail closed) — see section 5.

The mock's patient-create endpoint now rejects exactly what live rejects, so it can
no longer pass a payload production would refuse
(`src/app/api/mock-dentally/v1/patients/route.ts`).

---

## 2. What the 2026-07-25 write already settled, and the one thing it did not

### Settled by the 2026-07-25 write — patient 56194 / appointment 1070037012

These are **facts, not risks**. An earlier revision of this runbook listed all three
as open unknowns; that was wrong, and the framing is withdrawn.

- **`gender` IS accepted as a boolean on WRITE.** It was sent as a boolean derived
  from the title, it was accepted, and it reads back as the boolean it was sent as
  on patient 56194. Dentally's 422 wording "gender: must be male or female" states
  the *requirement*, not the wire encoding. This field was previously called "the
  single highest-risk field in the payload" — it is not a risk at all, and nothing
  in section 4 should be treated as testing it.
- **`booked_via_api: true` is accepted** on this practice's account. It survived onto
  appointment 1070037012.
- **The 30-minute `finish_time` is honoured exactly.** Appointment 1070037012 was
  written at 30 minutes and was **not** silently re-derived from the practice's own
  default appointment length.

Alongside them, the same write confirmed `title`, `date_of_birth` and
`payment_plan_id` are accepted in the shapes this route sends. Source: memory
`dentally-createpatient-422` — "Verified end to end against real Dentally: patient
56194 created with correct title/dob/gender/payment_plan, appointment 1070037012
written at exactly 30 minutes."

### The one genuinely open question

**2.1 — The exact 422 envelope.** The four field/message pairs are observed
(`date_of_birth`, `title`, `payment_plan` → "seems to be missing"; `gender` → "must
be male or female"); the JSON object they were wrapped in was never recorded. The
mock reconstructs it as `{error:{type,message,errors}}`, and only a real response can
confirm that nesting.

Note the shape of this: it can only be answered by a write that **fails**. A
successful re-confirmation write produces no envelope at all, so section 4 succeeding
leaves 2.1 exactly as open as it is now — which is the correct outcome, not a gap.
**This is the only open question in this document.**

---

## 3. Switch-on checklist

Every line below is an action a **human** takes; the `HUMAN:` marker is the gate, and
it is structural — if a step is not prefixed with it, it is not a step in this
runbook. No agent, script, cron or test performs any of them.

Tick every line **before** section 4. Each is independently sufficient to block a
booking, which is the design — the funnel fails closed at five separate points.

- [ ] **HUMAN:** set **`DENTALLY_WRITE_ENABLED=true`** in the target environment.
- [ ] **HUMAN:** set **`DENTALLY_WRITE_API_KEY`** to a real write key.
      *Note the outstanding security item: `DENTALLY_PROD_READONLY_API_KEY` is
      misnamed and already carries full umbrella write scopes over ~51k real
      patients, protected only by a User-Agent check. Rotation is still owed. Do not
      reuse it here just because it would work.*
- [ ] **HUMAN:** set **`DENTALLY_WRITE_BASE_URL`** explicitly.
      `isDentallyWriteEnabled()` requires all three; requiring the base URL is what
      stops "enable writes" from silently defaulting to `https://api.dentally.co`.
- [ ] **HUMAN:** confirm the **owner kill switch `online-booking` is ON** for the
      client (`system_toggle` row, or the owner's Systems screen).
- [ ] **HUMAN:** confirm **the campaign carries a booking block** on the result
      screen being tested, and that the campaign's site matches the `?site=` in its
      booking URL — a mismatch renders no calendar at all rather than a calendar for
      the wrong building.
- [ ] **HUMAN:** agree **a named victim slot with the practice**: a real time in a
      real diary that a real clinician will not be at. Agree it with Blerta first,
      out of hours, and write down the practitioner and time here before starting.
- [ ] **HUMAN:** set `MESSAGING_DRY_RUN=true`, so the test booking does not text
      anybody.

---

## 4. The one authorised write

Run it **through the funnel in a browser**, not with curl. The point is to exercise
the path a patient takes, including the page token, the live slot revalidation and
the payload builder. A hand-rolled curl proves only that Dentally accepts a payload
somebody typed.

Every numbered step here is prefixed **HUMAN:**. That is the gate: a step without the
marker is not part of this runbook, and no agent, script, cron or test may perform
any of them.

1. **HUMAN:** open the public booking page for the campaign under test.
2. **HUMAN:** pick the agreed victim slot.
3. **HUMAN:** enter details that are unmistakably a test and that no real patient
   shares — but read "Rollback" below first, because a test record from 2026-07-25 is
   still on file and the route deduplicates on mobile number:

   | field | value |
   |---|---|
   | Title | `Mr` |
   | First name | `Calibration` |
   | Last name | `Test` |
   | Date of birth | `1990-01-01` |
   | Mobile | a handset you hold |
   | Email | your own |
   | Funding | `NHS` |
   | Interest | `Check-up` |

4. **HUMAN:** submit.

**The payload this produces** for exactly the inputs in the table above (assembled
server-side; every field re-derived, none trusted from the browser):

```jsonc
// POST /v1/patients
{ "patient": {
  "first_name": "Calibration", "last_name": "Test",
  "title": "Mr",                     // whitelisted
  "date_of_birth": "1990-01-01",     // YYYY-MM-DD, anchored both ends
  "payment_plan_id": 1,              // NHS, confirmed live
  "gender": true,                    // BOOLEAN, derived from title, server-side
  "email_address": "...", "mobile_phone": "+447...",
  "site_id": "3286d822-68c5-48ff-b1a2-065780dfcd15",  // the Dentally UUID
  "use_sms": true, "use_email": true
}}

// POST /v1/appointments  (only if the above succeeded)
{ "appointment": {
  "patient_id": "<from the response above>",
  "start_time": "<the LIVE slot's own start>",
  "finish_time": "<start + 30 minutes>",
  "practitioner_id": "<the LIVE slot's own practitioner>",
  "reason": "Exam",                  // Check-up -> Exam, via TREATMENT_REASONS
  // The interest RIDES ALONG in the notes. With Interest = "Check-up" the route
  // sends exactly this string — the patient's own whitelisted wording, appended
  // after a full stop. The bare "Booked online via Smile Assessment" is sent only
  // when no interest was chosen at all.
  "notes": "Booked online via Smile Assessment. Patient interest: Check-up",
  "booked_via_api": true             // accepted; survived onto 1070037012
}}
```

### Expected success

- The page shows its confirmation state.
- `POST /api/booking/create` returns `200` with
  `{ ok: true, patientCreated: <true|false>, booked: { start, finish, practitionerId } }`.
- If `patientCreated` is `true`, a new patient exists in Dentally with the title,
  DOB, plan and sex above. If it is `false`, the mobile matched an existing record on
  one of this client's own sites and that record was reused instead — see "Rollback".
- An appointment exists at exactly the agreed slot, **30 minutes long** (already
  proven on 1070037012; here it is a regression check, not a discovery).

**HUMAN:** record the patient id and appointment id **immediately** — you need them
for rollback, and `patientCreated` tells you whether there is a new patient record to
account for at all.

### If it fails

The patient sees only *"We could not complete the booking. Please call the practice
and we will find you a time."* The cause is server-side only, in the logs:

```
[booking/create] <stage> failed for site <siteId> (HTTP <status>): <name>: <message> | <body>
```

`<stage>` is the whole diagnosis, and it is why that line exists:

- **`createPatient`** — the registration was refused. Dentally never saw an
  appointment. Nothing to roll back. **This is also the only path that can answer
  §2.1**: capture the whole response body verbatim, compare the `errors` map against
  §2.1 and against `liveRejections()` in the mock, then fix the mock first and the
  route second.
- **`createAppointment`** — **the patient WAS created and the appointment was not.**
  There is now an orphan patient record in Dentally. Roll it back (below) or the
  practice inherits a stray "Calibration Test".

Source: `src/app/api/booking/create/route.ts`, the catch block after
`createAppointment`. Dentally's error body is logged but is never returned to the
patient.

### Rollback

**Read before step 3 above — there is already a stray test record on file.** The
2026-07-25 write left patient **56194 ("Tayyib Arbab")** in live Dentally on the
**Romford Road** site. Its appointment (1070037012) was cancelled; the patient record
could not be deleted, because Dentally has no patient delete, so it is still there.
Two consequences for whoever runs section 4:

- **Do not blindly create a second test patient.** The practice's dedup hygiene
  applies to our own test litter first. Prefer reusing / updating the existing 56194
  context over adding a near-duplicate "Calibration Test" alongside it, and if a
  second record genuinely is needed, agree that with the practice up front.
- **Reuse may happen whether you intend it or not.** The route matches on mobile
  number across **all of this client's sites**, not just the one being booked (see
  step (h) in `src/app/api/booking/create/route.ts`), and Romford Road is one of
  them. So reusing the 2026-07-25 handset books against 56194 and returns
  `patientCreated: false` — which exercises the appointment write but **not** the
  registration write. Use a different handset only if re-proving `createPatient` is
  the point, and then expect a second record to clean up.

1. **HUMAN:** cancel **the appointment** in the **Dentally UI**. Do not script it, do
   not call the API: this runbook authorises exactly one write and that write has
   already been spent.
2. **HUMAN:** deal with **the patient record** — Dentally has no patient delete.
   Leave it and tell the practice, or ask them to archive it, alongside 56194. Agree
   in advance who does this.
3. **HUMAN:** set `DENTALLY_WRITE_ENABLED` back to `false` unless the decision is to
   stay live.

---

## 5. After it succeeds

Short by design. `gender`-as-boolean, `booked_via_api` and the 30-minute
`finish_time` were settled on 2026-07-25 (section 2) and are **not** re-opened here;
a re-confirmation write that succeeds simply agrees with them.

- [ ] **HUMAN:** **if the write FAILED**, capture the 422 envelope verbatim — status
      line, headers, whole body — and align `liveRejections()` / `unprocessable()` in
      the mock with it. This is the only way §2.1 can ever be closed, so a failure
      here is worth more than a success. A write that succeeds produces no envelope
      and leaves §2.1 open; that is expected, and is not a missed step.
- [ ] **HUMAN:** re-run the full suite. The mock is the calibrated artefact; any
      drift between it and what you just observed is a bug in the mock, not in the
      note.
- [ ] **HUMAN:** record the run here — date, patient id, appointment id,
      `patientCreated` — the way 2026-07-25 is recorded at the top, so the next
      person also inherits a fact instead of an unknown.

### A decision the owner still owes

The booking page offers **NHS** and **Private** only. Live registrations run
**NHS 276, UDC 185, Private 39** per 500 — so the practice's second-biggest plan is
one the funnel cannot select, and those patients are currently registered as NHS or
Private. Adding UDC (id `47752`) is a change to what patients are *asked*, not a code
default, so it waits on the owner. See `FUNDING_PLAN_IDS` in
`src/app/api/booking/create/route.ts`.

### On the fail-closed switch

`/api/booking/create` now reads the owner's kill switch through
`isSystemEnabledStrict`, which treats an **unreadable** switch as **off**. This is
deliberate and it will occasionally refuse a booking that could have succeeded — if
Supabase is briefly unreachable, patients get the "please call the practice" line.
That trade is correct for the only public endpoint that writes to a real patient
record: a refused booking self-heals on the next click, an appointment written into
a diary against the owner's explicit instruction does not.

`/api/booking/hold` deliberately keeps the fail-**open** reader. It writes only to
our own table, so an abandoned hold is harmless and becomes a callback lead.

---

## Provenance

- Probes, code fixes and tests: `src/app/api/booking/create/live-calibration.test.ts`
  (every reference value above is pinned there, with its probe cited).
- End-to-end proof against the strengthened mock:
  `src/app/api/booking/in-funnel-booking-e2e.test.ts`.
- Mock/live 422 parity, both directions:
  `src/app/api/mock-dentally/v1/patients/patients-create-parity.test.ts`.
- Background: `DENTALLY.md`, and the memories `dentally-createpatient-422`,
  `dentally-readonly-key-is-not-readonly`, `prod-live-state-audit`.
