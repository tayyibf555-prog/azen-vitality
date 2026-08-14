# Demo runbook — Blerta, Tue 4 Aug, 14:30

Runs on **your laptop**, against **mock patient data**. Nothing touches real
Dentally, nothing can message a real patient. Say that out loud early — it is
the strongest trust line you have.

---

## Before she arrives (5 minutes)

1. Start the server:

   The demo profile is `azen-web-mockwrite-3002` in `.claude/launch.json`
   (mock Dentally + writes on against the mock + messaging dry-run).
   If it is already running on port 3002, leave it.

2. Open `http://localhost:3002/login` and sign in with the credentials in
   `DEMO-LOGIN.txt` (Demo Owner). Do this BEFORE she sits down — a login
   screen is a bad opening shot.

3. Land on `http://localhost:3002/c/vitality`. **Not** `/owner/vitality`.
   Both now render the same shell, but `/c` is the staff view she will
   actually live in.

4. Set the site switcher (top right) to **N15 Vitality Dental** if you plan to
   compare against her Dentally screen. Ours scopes to the selected site;
   Dentally's dashboard was showing the whole umbrella. Mismatched numbers
   read as "yours is wrong" unless you say this first.

---

## The walkthrough

Order matters — lead with what is finished, not with what is new.

### 1. Overview (the front door)
The practice dashboard: takings by period, appointments donut, accounts in
debt, invoiced, patients and plans, then **Next actions** — the cross-module
work queue. This is the "one front door" idea: she should not need to visit
seven screens to find out what needs doing.

### 2. Calendar (the diary)
- Clinician columns, working hours, funding and notes.
- **Drag an appointment** to another time or another clinician. It completes,
  because this is the mock. Say plainly: *on the live system this is switched
  off until she says otherwise.*
- Point out the continuing-treatment rule: a course of treatment cannot be
  dragged across clinicians, and an unclear reason is refused rather than
  guessed. This was her own worry on the call.
- Per-column capacity: "6h free · longest 2h 40m at 08:45".

### 3. Patients → open a record
- The record is Dentally-shaped: eleven tabs, pinned notes band, quick view
  from the diary.
- **Chart tab** — FDI chart, treatment plan panel, appointment cards.
- **Perio tab** — BPE grid, six-point chart, staging and grading.
- **Notes tab** — practice notes (typed + dictation) are ours and work. The
  Dentally clinical-notes panel is honest that it is not connected. See
  "what to say" below.

### 4. Holiday & absence (NEW — her list)
Operations → Holiday & absence. Request, approve, refuse. Approved leave
feeds the rota so nobody is rostered while away. She approves — the
permissions were built around her being the practice manager, not the owner.

### 5. Staff check-in (NEW — her list)
Clock in and out. Append-only log, so a missed clock-out shows as a visible
exception rather than a silently corrected row. Compares against the rota:
"clocked in, no shift" and "shift, no clock-in".

### 6. Reports → Payment allocation (NEW — the big one)
Money received, attributed to the clinician on the invoice line it settled.
Read the calibration banner WITH her — it is the point, not a disclaimer.
Then the honest buckets: money not allocated in Dentally, shared invoices on
part payment, and so on. Every pound reconciles or the report refuses to show
a total.

**Do not call this the pay run.** See below.

---

## What to say — the five lines that matter

**Opening, before you touch anything:**
> "Everything here is running on a copy, not your live system. Nothing I do
> in this session can change a single record in Dentally."

**On the diary drag:**
> "On the live system, writing back into Dentally is switched off deliberately
> while we're in front of your real patient records. When you're ready, we
> turn it on — and this is exactly how it will behave."

**On clinical notes:**
> "Notes are in two halves. The notes your team writes here — typed or
> dictated — are live and yours. Pulling your existing clinical notes out of
> Dentally is the half we haven't connected: Dentally doesn't publish those
> over its integration the way it publishes appointments and invoices. We've
> got a question in with them."

**On the payment allocation report:**
> "This is your money in, split by the dentist who did the work, and it's
> real. What it deliberately won't do yet is tell you what to pay someone —
> because about a fifth of the money your practice took in the last two months
> isn't allocated to anything inside Dentally itself, and I'd rather show you
> nothing than a number you'd pay a dentist from."

Never say Dentally cannot provide it. She uses Dentally's own Payment
Allocations report; she will know.

**On the audit tab:**
> "This records what happens in this platform. It does not yet span what
> happens inside Dentally — so it won't catch a receptionist reversing a card
> payment as cash the way yours does today."

---

## Do not demo

- **Anything on production** (`azen-vitality.vercel.app`). Tonight's work is
  committed but deliberately NOT pushed.
- **Compass / NHS submission** — not built, and the licensing question is
  still open.
- **NFC tap-to-clock** — schema is ready, the tag path is not built.
- **Missed-call routing** — the code works, but no phone number is wired to
  it yet and Vitality's line does not forward anywhere.

---

## If something breaks

The server is a dev server. A page that errors usually recovers on refresh.
If a screen looks wrong, move on rather than debugging in front of her — you
have a briefing full of things that do work.

`DEMO-BRIEFING-2026-08-04.md` (sent separately) has the longer version of
every limitation and the exact words for each.

---

## After the demo

Tonight's two commits (`99d7c2d`, `391599f`) are on `aesthetic-shell`,
unpushed. Migrations 0067–0069 ARE applied to the live database (additive
only: two new tables, one widened role constraint, no existing row changed).

When you give the word, pushing that branch deploys everything to production
and reconnects it to real Dentally — with writes still off until you decide
otherwise.

Also owed before handover: delete the demo login, and rotate
`DENTALLY_PROD_READONLY_API_KEY` (it carries full write scopes over 51,000
real patient records and is protected only by a User-Agent check).
