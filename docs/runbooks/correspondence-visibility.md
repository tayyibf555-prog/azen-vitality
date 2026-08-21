# Runbook — where a patient's messages actually live

**Read this before telling anyone at the practice "it's all in one place."** It is
not, and the platform now says so on the screen. This document is the long version of
that sentence: what syncs into Dentally, what does not, what Dentally holds that the
platform can see, and what nobody can see from either system.

The short answer:

> **Nothing this platform sends is written into Dentally.** A member of staff working
> in Dentally sees Dentally's own messages and nothing else. The platform's own
> Correspondence tab is the fullest record there is, and it now says so at the top of
> the screen in readable ink.
>
> Every send site now WRITES a record row — that claim is enumerated in section 4a and
> pinned by a test that crawls the source tree, because it was asserted for a year
> while four send paths bypassed it. **Writing a row is not the same as reaching the
> right patient.** A message sent to a number we could not match is keyed
> `lead:<number>` and the patient record read never looks there, which catches real
> patients on a landline, a work number or a shared family number (section 6). It does
> **not** hold every reply either: two kinds cannot be tied to a patient. All three
> exceptions are in section 6 and are named on the screen itself, rather than left for
> a reader to infer from an absence.

---

## 1. THE RULE

> **No POST / PUT / PATCH / DELETE to any live Dentally endpoint, ever, under any
> framing.** That includes `/v1/notes`, `/v1/sms`, `/v1/emails` and
> `/v1/patient_documents` — all four are undocumented, and `POST /v1/sms` in
> particular is far more likely to **send a real text to a real patient** than to file
> a log entry (Dentally sends its SMS through Twilio; rows carry a
> `twilio_error_response` message type). The only permitted live traffic is `GET`.
>
> The existence of a route may be established **only** by the recorded 403-vs-404 +
> `x-runtime` fingerprint, by documentation, or by a GET. Never by sending the write
> and seeing what happens.

`DentallyClient` is constructed with `readOnly: true` by `dentallyFromEnv()` and its
`assertWritable()` latch throws before any non-GET is built. The mock at
`/api/mock-dentally/v1/sms` deliberately implements **GET only**, so a write path
cannot be built and tested green against a route that must never be written to.

---

## 2. Why there is no write-back (the question that started this)

The ask was: file each message we send as a note or a correspondence entry on the
Dentally record, so a Dentally-only user sees one complete history. **It was not
built, and should not be**, for four independent reasons — any one of which is
sufficient.

| | Finding |
|---|---|
| **No supported route** | No documented Dentally endpoint accepts a correspondence or note write. `/v1/correspondences`, `/v1/communications`, `/v1/messages`, `/v1/letters`, `/v1/sms_messages`, `/v1/phone_calls` and a dozen similar names **do not exist** — they 404 with the byte-identical fingerprint of a nonsense control path. |
| **The one crack is unverified** | `/v1/notes` is recorded once as answering POST/PUT/PATCH/DELETE. That is a **single unreplicated probe**, and re-verifying it would require transmitting a POST, which the rule above forbids absolutely. Method existence cannot be established by GET. |
| **`POST /v1/sms` is probably a SEND** | Dentally texts through Twilio. "Logging" a message we already sent would **double-text the patient**, on the practice's own Twilio spend. This is the highest-consequence unknown in the whole area and is exactly why it must not be probed. |
| **Undocumented writes are barred by our own standing rule** | `DENTALLY-QUESTIONS.md`: do not write to an undocumented endpoint without written confirmation from Dentally. This is CQC Reg 17 governance reasoning, not a contract clause, and it binds here exactly as hard as it binds on charting. |

Two secondary reasons, recorded so nobody re-opens them as "small problems":

- **`/v1/notes` holds zero rows across 52,339 patients.** We would be the only writer
  into a table nobody uses, whose row shape has never been observed. There is no
  idempotency key on any of these routes, so a retry writes twice, and no retraction
  path we would trust for a GDPR erasure or a mis-sent message.
- **Attribution.** A written row is attributed to whichever human the API key belongs
  to. The record would name a member of staff as the sender of a message a robot
  sent. Weaker than the GDC 4.1.4 problem on clinical notes — an SMS log is an
  administrative record — but not absent.

**On the T&Cs.** The charting prohibition does **not** transfer wholesale, and it is
worth being precise because the two get conflated. Henry Schein One 20.1(k) forbids
software reading or writing **directly to their database**; using the published API is
not that, or every read already in production would breach it. 20.1(p) forbids using
the Services to build a competing product, which bites on the endgame, not on filing a
note. What actually stops this is the undocumented-endpoint rule and the Twilio risk —
technical and governance, not contractual. Verify any clause number against the
practice's actual signed contract before relying on it.

---

## 3. What Dentally DOES expose (the disclaimer that had gone stale)

The Correspondence tab used to state, in writing:

> ~~"Dentally does not expose its correspondence through the connection we have."~~

**That sentence was false.** `/v1/sms` returns a patient's full SMS history — every
reminder, confirmation, recall and portal message Dentally sent, plus the patient's
replies — and the practice's key already carries the (undocumented) `correspondence`
scope that gates it. The sentence was written in good faith as the honest answer to a
real question from the practice manager, and it quietly stopped being true. Same shape
of defect as the invented `/v1/patient_notes` path: a permanent claim about the
connection, made once, never re-checked.

It has been replaced with copy that describes **this screen** rather than what
Dentally can or cannot do, which is a claim this code can actually keep
(`CORRESPONDENCE_COPY` in `src/lib/patient/tabs.ts`, pinned by tests).

| Dentally resource | Status |
|---|---|
| `/v1/sms` | **Exists, readable, populated.** Keys: `id, archived, body, created_at, direction, from, read, read_at, sent_at, to, user_id, message_type`. `patient_id` is mandatory — there is **no practice-wide index** — and there is **no SMS webhook**, so it is a per-patient poll or nothing. |
| `/v1/emails` | Exists, readable, **empty for every patient**. Requires an `external_provider` parameter whose value it does not validate. Likely legacy. |
| `/v1/notes` | Exists, readable, **0 rows practice-wide**. |
| `/v1/patient_documents` | Exists, readable, **0 rows**. |
| Letters, scanned documents, phone calls, tasks, audit trail | **No endpoint exists.** |

---

## 4. What the Correspondence tab shows today

**Twelve platform sources**, read independently and each one caught, so the tab can
tell "none were sent" from "some sources are down" from "we know nothing".

> **Twelve sources is not the same claim as "every message".** It was read as one, and
> it was wrong. See section 4a: four live send paths went through none of these twelve.

| Source | Table | Shown as |
|---|---|---|
| Live two-way conversation | `agent_conversation` / `agent_message` | Conversation |
| Recall | `recall_touch` | Recall |
| Reactivation | `reactivation_touch` | Reactivation |
| No-show defence | `noshow_touch` | Appointment confirmation |
| Treatment coordinator | `coordinator_touch` | Treatment follow-up |
| Treatment-plan closer | `closer_touch` | Treatment plan follow-up |
| Aftercare check-in | `postop_touch` | Aftercare check-in |
| Review requests | `review_touch` | Review request |
| Balance reminders | `collection_touch` | Balance reminder |
| Segment campaigns | `outreach_touch` | Campaign |
| Appointment changes | `diary_touch` | Appointment change |
| First reply to an enquiry | `speed_to_lead_attempt` | New enquiry reply |

**Six of those twelve were missing until this change** — closer, collection, postop,
outreach, diary and speed-to-lead. The tab was headed "Messages sent from this
platform" and its empty state read "No messages have been sent to this patient from
this platform", which was printed as a fact about patients the balance agent had
texted three times.

Each row now carries **channel, direction, delivery status, and the human who
approved it**.

- **"Sent" means the network accepted it, not that the patient read it.** Delivery
  confirmation is a separate fact carried by the Twilio status webhook.
- **"Not delivered" is the one status that carries colour.** Before this change a
  message the network refused rendered byte-for-byte like one that arrived, so a
  coordinator read the words and concluded the patient had been told.
- **Drafts and discarded drafts are excluded.** Neither was ever said to the patient;
  they sit in the worklist of the module that wrote them.

### Adding a thirteenth module

Add it to `TOUCH_SOURCES` in `src/lib/inbox/repository.ts` **and** to `SOURCE_LABEL`
in `src/lib/inbox/delivery.ts`. A coverage test
(`src/lib/inbox/delivery.test.ts`) cross-checks the registry against
`DRAIN_SOURCE_TO_SLUG`, so a module that starts messaging patients and is not
registered here fails the build rather than quietly going missing from the record.

---

## 4a. The four senders that were not modules, and the check that now finds them

The twelve sources above answer "is every drain MODULE on the record?". Nobody had
asked the wider question: **is every SEND on the record?** They are not the same
question, and the gap between them held four live patient-facing paths.

| Send path | Where it lives | What it wrote before |
|---|---|---|
| Missed-call callback text | `src/app/api/webhooks/twilio/voice/route.ts` | Nothing. No outbox, no touch row, and the webhook returns before any conversation is written. |
| No-show YES / CANCEL reply | `src/app/api/webhooks/twilio/inbound/route.ts` | Nothing. The patient's own reply landed as a `noshow_touch` inbound row; **our answer to it did not.** |
| Aftercare acknowledgement | `src/app/api/webhooks/twilio/inbound/route.ts` | Nothing. Same shape: the reply was logged and triaged, the acknowledgement was not. |
| Co-pilot `send_sms` / `send_email` | `src/lib/copilot/tools.ts` | An audit row only. **A person deliberately texted a patient and their record showed nothing.** |

All four now call `recordOutbound` (`src/lib/inbox/record-outbound.ts`), which appends
the outbound turn to `agent_conversation` / `agent_message` — the `agent` source in the
table above, exactly as the Conversations inbox's human-takeover reply has always done.

**Recording fails soft, by contract.** It runs only after the provider has accepted the
message, and it never throws, never retries and cannot send. A logging failure therefore
cannot unsend, re-send or double-send anything; it logs at `error` level naming the
patient, and the co-pilot additionally tells the owner in its reply that the message is
not on the record. The alternative — retrying, or failing the caller — trades a missing
row for a duplicate text, which is strictly worse.

**And every caller guards the call anyway.** All four sites now `await recordOutbound(...)
.catch(() => false)`. The contract is not the guard: two of the four used to rely on the
promise alone, and on a Twilio webhook an escaped throw is a 500, which Twilio retries —
re-running a turn that has already cancelled the appointment and already texted the
patient. Pinned at each site by a test that mocks the recorder into throwing
(`structured-replies-on-record.test.ts`, `callback-on-record.test.ts`,
`send-on-record.test.ts`).

### The structural check

`src/lib/inbox/send-sites.ts` is a registry of **every** `sendMessage` call site in the
codebase, each with an audience and, for a patient-facing one, the correspondence source
that carries it. `src/lib/inbox/send-sites.test.ts` does not trust it: it **crawls the
source tree**, counts the call sites per file itself, and fails if the tree and the
registry disagree in either direction, including on the count within a file already
listed.

The crawl resolves each file's **local binding** from its import statement rather than
grepping for the literal name. It used to count `sendMessage(` as a string, which meant
`import { sendMessage as dispatch }` in a new patient-facing file passed every assertion
here with nothing on any record. The same resolution is applied to the provider check
below. It also asserts that `sendMessage` remains the only caller of the Twilio and
Resend providers, which is what makes the crawl a proof rather than a spot check.

The enumeration as it stands:

| Call site | Audience | Recorded where |
|---|---|---|
| `api/messaging/drain/route.ts` (x2) | Patient | The ten drain modules' own `*_touch` rows |
| `api/inbox/reply/route.ts` | Patient | `agent_conversation` |
| `api/webhooks/twilio/inbound/route.ts` (x4) | Patient | `agent_conversation` |
| `api/webhooks/twilio/voice/route.ts` | Patient | `agent_conversation` |
| `lib/copilot/tools.ts` | Patient | `agent_conversation` |
| `lib/speed-to-lead/contact.ts` | Patient | `agent_conversation` + `speed_to_lead_attempt` |
| `lib/speed-to-lead/nurture.ts` | Patient | `agent_conversation` + `speed_to_lead_attempt` |
| `api/rota/publish/route.ts` (x2) | **Staff** | Nowhere, deliberately |
| `api/rota/sweep/route.ts` | **Staff** | Nowhere, deliberately |
| `lib/agent/alerts.ts` | **Staff** | Nowhere, deliberately |

A staff send has no patient record to belong on, and filing one there would be its own
defect: a rota text to a nurse on the record of a patient with the same name.

**Adding a sender:** put it in `send-sites.ts`. If it is patient-facing it must land in
one of the twelve sources or in the agent store — there is no third option that leaves
the screen's wording true.

**And check the KEY, not just the table.** The registry proves a send writes a row; it
cannot prove the row is filed under the patient it went to. Anything keyed
`lead:<number>` is on a conversation the patient record read never opens, so a sender
that resolves its patient from a phone number inherits the identification gap in
section 6. Use `outboundPatientKey` (`src/lib/inbox/record-outbound.ts`) so at least the
key is the same one the inbound webhook uses and a later reply threads onto it.

---

## 5. The Dentally SMS read — DEFAULT OFF, and what switching it on takes

`DENTALLY_SMS_READ_ENABLED=true` folds Dentally's own SMS into the same timeline,
labelled `Dentally`. **It is off, and it should stay off until a human has calibrated
it against live.**

Why off: `/v1/sms` is undocumented, its collection key and row fields come from one
recorded read-only session, and that session cannot be re-run from a development
machine. Shipping it on would be repeating the `/v1/patient_notes` mistake — a read
nobody could verify, mocked locally, green in dev, wrong in production.

**Switch-on procedure.**

1. From an environment whose User-Agent Dentally accepts, run a read-only
   `GET /v1/sms?patient_id=<a real patient>&per_page=5`. Confirm: HTTP 200, an `sms`
   array, and rows carrying `body` / `created_at` / `direction` / `sent_at`.
2. Set `DENTALLY_SMS_READ_ENABLED=true`.
3. Open two or three patient records. Confirm Dentally-origin rows appear labelled
   `Dentally`, and that the scope band at the top of the tab has switched to the
   "SMS sent or received through Dentally is also included" wording.
4. If anything is off, unset the variable. The read **fails soft** either way: a shape
   change is caught and rendered as "Dentally's own SMS history could not be read just
   now" — never as an empty history.

**What it costs.** One extra Dentally GET per patient-record open. The resource has no
practice-wide index, so there is no cheaper shape. It is classified **interactive**, so
it draws on the display ceiling and can never starve booking or the background sweeps.

**De-duplication.** Both systems can hold the same text. A Dentally row collapses into
a platform row only on an **exact body match, same direction, within 30 minutes**;
identical words a week apart are a genuine second chase and both are shown. The
platform row is the survivor because it is strictly richer (module, status, approver),
and it is flagged **"Also in Dentally"** so nothing is dropped without a word.

---

## 6. Messages nobody can see on a record

Recorded because they are real, not because they are acceptable. This table is the
residue after section 4a: everything the platform sends is now on the record **except**
the rows below, and the tab's own wording is written to match this table rather than to
round it away. **Read the first row before quoting the rest of this document at anyone**
— it is the only one that can hide a message sent to a patient who is fully on file, and
it is the one a manager is most likely to be caught by.

### What the platform SENT

| Gap | Why | Fix |
|---|---|---|
| **Anything we sent to a number that could not be matched to a patient record** — including messages to people who ARE patients | Threaded under `lead:<number>`, and the patient record read (`loadAgentMessagesForPatient`) filters `dentally_patient_id` to `[<id>, "patient:<id>"]`, so it never sees a `lead:` row. Two ROUTINE triggers, not edge cases: `identifyByPhone` matches on **`mobile_phone` only** (`src/lib/agent/identify.ts`), so a landline, a work number or a shared family number never resolves; and the missed-call lookup is capped at `withTimeout(..., 3000, null)` so the caller does not hear an application error, which means a Dentally slowdown silently demotes a patient we could have named. | **Nothing automatic, and it does not fix itself later.** There is no re-key: `adoptConversationPatientId` (`src/app/api/webhooks/twilio/inbound/route.ts`) fires only when the agent REGISTERS a brand-new patient mid-thread, never on identifying an existing one — and per `dentally-createpatient-422` that registration path is failing against live anyway. Visible in the Conversations inbox and in Speed-to-lead, under the number. The tab's scope band names this exception and its empty state points at the inbox; pinned by `src/lib/inbox/record-outbound.test.ts`. |
| **No-show waitlist slot offers** | `noshow_touch.target_id` is nullable, and a waitlist offer is not tied to a defended target. The row carries no patient identity of any kind. | Schema change. Visible meanwhile in the no-show module's own view. |
| **Appointment-change notices whose move was deleted** | `diary_touch.move_id` and `diary_move.patient_id` are both nullable. | Schema change. |
| **A message whose record write failed after the send succeeded** | Recording fails soft on purpose: the patient already has the text, so retrying would risk a duplicate (section 4a). | Nothing automatic. Logged at `error` level naming the source and the patient; grep `[correspondence]`. The co-pilot also tells the owner at the time. |
| **A missed-call callback whose provider send had not resolved within 6 seconds** | The call leg must be answered inside Twilio's voice timeout, so the record write is left running rather than awaited. It usually still lands; on a runtime that freezes the function after the response, it does not. | Rare and bounded. The capture row in the After-hours worklist still shows the call. |
| **Anything sent by these four paths BEFORE this change** | The rows were never written; nothing can reconstruct them. | None. Only affects the dry-run period, during which nothing reached a patient. |
| **Staff messages: rota shifts, handover alerts** | Deliberate. They go to staff, not patients (section 4a). | None wanted. Filing them on a patient record would be a defect. |
| **Anything sent from Dentally while the read is off** | Section 5. | Switch the read on. |
| **Letters, email, scanned documents from Dentally** | No endpoint exists (section 3). | Only Dentally shows these. |

### What the patient SENT BACK

The tab's scope sentence deliberately does **not** claim completeness for the inbound
half, because of exactly these two. Both are named on the screen itself
(`CORRESPONDENCE_COPY.inboundGaps`).

| Gap | Why | Fix |
|---|---|---|
| **A reply to a waitlist offer of a cancelled slot** | The offer branch of `handleNoshowInbound` writes no inbound touch: a slot offer is not tied to a defended target, so there is nothing to hang the reply on. Our answer to it IS recorded (section 4a), so the record can show a reply with no visible question. | Schema change, same one as the outbound waitlist gap above. Visible meanwhile in the No-show list. |
| **A STOP from a number that was in no campaign** | The opt-out path records the suppression and returns before any conversation is written. When the number correlates to a live cadence the STOP does land, as that module's inbound touch; when it correlates to nothing, it lands nowhere on the timeline. | Visible in the opt-out list. Recording it on the timeline would mean writing a conversation for every opt-out, including from numbers that are not patients. |

Bounded at the **400 most recent rows per source**. A patient with more than 400
messages from a single module will not see the oldest of them here, and the tab says so.

---

## 7. Making the platform's history visible to Dentally-only staff

Since write-back is out, the honest options, in order of preference:

1. **Train on the tab.** It is the fullest record there is, it names its own gaps on
   the screen (all three of them), and it says at the top that this history is not in
   Dentally. Train the gaps too, especially the one that bites hardest in practice: an
   empty Correspondence tab does **not** mean the patient has not been contacted, and
   the panel itself now says to check the Conversations inbox. This is the whole fix
   for most of the need.
2. **A daily digest or CSV export** of platform correspondence, if a Dentally-only
   user genuinely cannot open the platform.
3. **Do NOT squeeze message text into `appointment.notes`.** It is a shared,
   single-value field that reception also uses; writing to it is a silent data-loss
   path, and it is a supported write, which makes it tempting and therefore worth
   naming here as forbidden.

---

## 8. The question only the practice can settle

`DENTALLY-QUESTIONS.md` already drafts the email. Question 3 now has a concrete,
answerable form. Vitality must send it **as the customer**, never us as a vendor:

> Our API key carries a `correspondence` scope that is not in your published scope
> table, and `GET /v1/sms` returns our patients' message history. Is that endpoint
> supported for customer use? And is `POST /v1/sms` a **send** or a **log**? We want to
> display the history, not send anything through it.

Until that comes back **in writing**: read it, never write it.

---

## Where the code is

| | |
|---|---|
| Source registry (12 sources) | `src/lib/inbox/repository.ts` |
| Delivery-status vocabulary + labels | `src/lib/inbox/delivery.ts` |
| Composition (platform + Dentally) | `src/lib/inbox/correspondence.ts` |
| De-duplication rule | `src/lib/inbox/dentally-merge.ts` |
| Dentally SMS read + flag | `src/lib/dentally/sms.ts` |
| Dentally SMS shape guards | `src/lib/dentally/sms-shape.ts` |
| Mock (GET only) | `src/app/api/mock-dentally/v1/sms/route.ts` |
| Screen copy | `src/lib/patient/tabs.ts` (`CORRESPONDENCE_COPY`) |
| The tab | `src/components/client/patients/record/tab-correspondence.tsx` |
| What the tab actually RENDERS, per state | `src/components/client/patients/record/tab-correspondence.test.ts` |
| Recording an out-of-band send | `src/lib/inbox/record-outbound.ts` |
| Registry of every send site | `src/lib/inbox/send-sites.ts` |
| The source-tree crawl that pins it | `src/lib/inbox/send-sites.test.ts` |
