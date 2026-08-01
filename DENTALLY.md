# Dentally: the reference we are replicating

Read alongside `PRODUCT.md`. That file says HOW to build; this one says WHAT Dentally actually contains, module by module.

## Why this exists

The client's endgame is to **replace Dentally entirely**. Today the platform sits on top of it, reading its API and writing back. Later it becomes the practice management system and Dentally goes.

Until then, looking like Dentally is a **staff-transition tactic, not a taste**. Roughly fifty people use Dentally all day. The less they have to relearn, the less the migration costs and the less it is resisted. So the test for any screen is not "is this a better design" but **"would a Dentally user recognise this instantly"**.

Source: a FigJam board of screenshots taken from the practice's own live Dentally account, annotated by the owner. Read 2026-08-01. The board is organised as one labelled row per module. Where an annotation appears below, it is the owner's words and it is a **request**, not a description.

A caution on the source: those screenshots contain real staff names, emails and patient records. This file records STRUCTURE only. Do not copy names, addresses or balances out of the board into code, fixtures or tests.

---

## Global chrome

Every screen shares it, so it is worth getting exactly right once.

- **One blue bar** across the top: the hamburger, the wordmark, a wide **"Search patients"** field in the centre, then the site selector ("N15 Vitality Dental"), the user's name, and a notification bell. Nothing else.
- **A narrow icon-only left rail**, roughly 36 to 40px, no labels. Top group: home, patients, transfers, recent, calendar, inbox (with an unread count badge), add-patient. Bottom group: tasks, send, reports, portal, documents, settings.
- **A page title row** under the bar: the title on the left with a view dropdown beside it, and the practice group name far right.
- Where a module has sub-sections they run as a **horizontal tab bar** under the title, never as an expanding sidebar. Settings shows this clearly: Home, Practice, Sites, Diary, Users, Treatment & Plans, Contacts, Templates, Automation, Marketplace, Developer.
- A quiet footer: Documentation, System Status, Support on the left; a version line on the right.

---

## Homepage (dashboard)

The panel layout is already documented in `PRODUCT.md` and rebuilt; see the takings strip, appointments donut, accounts, invoiced and patients/plans/UDA columns.

**Two things on the board we do NOT have, both requested:**

1. **Today's Visits** panel. Opens from the rail. Rows of Time / Patient / "for practitioner", each with a **Manage** action, plus a feedback button at the foot. The clock icon shows "No patients waiting" when empty.
   > "shows today's visits in home page"
2. **Recently viewed patients** dropdown. A list of patients with "viewed 10 minutes ago", "viewed 17 years ago" and so on. Straightforward and clearly used a lot.
   > "Shows recently viewed patients in home page"

---

## Patient info

Three screens, and this row carries the most work.

### Creating a new patient
A three-column form: **Basic Details**, **Address & Phone**, **Preferences**.

- Basic Details: ID, Title, First name\*, Middle name, Last name\*, Preferred name, Biological sex\*, Date of birth\*, NI number, NHS number with an "NHS number not provided" checkbox, Insurance number, Legacy ID.
- Address & Phone: Address lines 1 to 3, Town, County, Postcode with a lookup, Home / Work / Mobile phone with country flags, Preferred phone, Email, Doctor or specialist, Occupation.
- Preferences: Location, Payment plan, Dentist, Hygienist, Receive email, Receive SMS, Marketing consent, Dentist recall interval, Next dental recall, Hygienist recall interval, Next hygiene recall, Recall method, Acquisition source.

**This directly explains our live 422s on patient creation.** The asterisked fields are the required set: first name, last name, biological sex, date of birth. Our create paths were omitting several of them.

### The patient record
A tab strip: Details, Medical, **Chart**, Appointments, Recalls, Notes, Account, Perio, Correspondence, Tasks, Audit. Header shows name, date of birth with age, a Medical history flag, the site and practitioner, a plan tag and the account balance in red.

Pinned notes render as coloured sticky cards across the top, each with an author, an age, a Hide control and a star.
> "Patient notes with option to pin notes doesn't look good so we need to re design this but easy for dentists"

So: keep the capability, redesign the presentation, and optimise it for a dentist reading at speed.

### Charting (FDI) — THE API IS READ ONLY, and this is the decision to make first

Checked against `developer.dentally.co` on 2026-08-01. Of the 83 documented endpoints, every charting resource is **GET only**:

```
GET /v1/treatments                GET /v1/treatments/{id}
GET /v1/treatment_categories      GET /v1/treatment_categories/{id}
GET /v1/treatment_plans           GET /v1/treatment_plans/{id}
GET /v1/treatment_plan_items      GET /v1/treatment_plan_items/{id}
GET /v1/treatment_appointments    GET /v1/treatment_appointments/{id}
```

There is no POST, PUT, PATCH or DELETE on any of them. Compare `/v1/appointments`, which documents POST, PATCH and DELETE. The `treatment_plan_item` object carries **Teeth** and **Surfaces**, so the chart itself is fully readable.

**So we can mirror Dentally's chart, and we cannot write to it.** The board's annotation asks for charting that "needs to connect with dentally too", and half of that is not currently possible through the public API.

This is a clinical-safety fork, not a technical inconvenience. If a dentist charts an extraction here and Dentally never learns of it, the next clinician reading Dentally sees the tooth present. Two sources of truth for clinical data is the worst outcome available, and it is worse than either extreme.

The three ways out:
1. **Read-only mirror.** Chart renders from Dentally; charting still happens in Dentally. Safe, immediately useful, no divergence. Does not satisfy "dentists chart here".
2. **Chart here, ours only,** with the divergence stated loudly on screen. Fast to build, and the risk above is real from the first day two people use different systems.
3. **Get a write path** before anyone charts: ask Dentally for a private or partner endpoint, or wait for the practice to move charting wholesale and stop using Dentally's chart.

The build below is the same UI in all three cases. What changes is where a click WRITES.

### Charting (FDI)
Full FDI tooth chart, upper and lower, both quadrants numbered outward from the midline (8..1 | 1..8, repeated top and bottom, with R and L marked at both ends).

**Each tooth** is a crown diagram (cream) plus a **five-region surfaces grid**: four trapezoids around a centre square, which is the standard mesial / distal / buccal / lingual / occlusal layout. A charted surface is filled; the observed chart shows yellow across the occlusal of the six upper anteriors, and a grey centre square on one upper molar. The two surface rows sit on a faint banded background.

**Left panel**, top to bottom:
- A segmented control: **PD** (permanent dentition, selected), **DD** (deciduous), **Base** (base chart, disabled unless in base mode), a dropdown chevron for chart preferences, and a collapse control.
- Tabs: **Treatment List** and **Plan Templates**.
- A category filter, defaulting to "All".
- A search box with a **sort** button beside it.
- The treatment list: a **favourite star**, the code, and the name (0000 Bridge Abutment, 103 NuSmile Consultation, 121 NHS Urgent Filling, and so on). Alphabetical by default.
- A vertical **quick-link index rail** down the right of the list: star, then 0 1 2 3 4 5 6 7 8 9, then letters, jumping to that group.

**Bottom right of the chart**: Cloud Gallery, Images, **BPE** (carrying a red dot when a BPE is due), History, Base Chart, and a settings cog.

**Bottom left**: a round blue **+** which creates a new treatment plan. Each open plan gets its own tab; completed plans live in History.

**Beneath the chart**, two cards: "Add a treatment plan and appointment" with a **New treatment plan** button and the note that every plan must have at least one appointment; and "Use a treatment plan template" with **Select template**.

**The charting interaction, from Dentally's own documentation:**
- **Left click charts the first surface. RIGHT click adds further surfaces.** This is the single most important mechanic on the screen and is easy to get wrong.
- **Hovering a tooth** shows that tooth's history in a tooltip.
- **History** (lower right) opens the full clinical history: filterable, searchable, expandable, exportable. Every line carries a `TP: ****` button naming the treatment plan it belongs to, which opens that plan.
- **Base Chart** switches into base-chart mode, where the same treatment list edits the patient's base dentition. Dentally's own recommended route for tooth status is the socket selection menu rather than this.
- **BPE** shows the whole basic perio exam history and holds "Record New BPE / BEWE".
- Chart preferences (via the chevron or the cog) include **locked chart**, **combined chart** and **hover chart**.
- A practitioner's patient records open on **Chart** by default; everyone else opens on Details.
- Treatment list sorting: search, category, favourites (or favourites-on-top), a sort-by preference, and the alphabet rail.
> "this is a must for dentists as well as admin all this information seen right now needs to be replicated and needs to connect with dentally too"

Note the second half: charting must **write back to Dentally**, not just display.

---

## Calendar

The multiday diary: day columns with the practitioner's initials on a second header line, a time grid, coloured appointment blocks, grey for non-working.
> "Drag and drop feature here as explained in call this needs to be replicated"

Already built. See the diary work.

---

## Communication

An inbox with four tabs, each carrying its own unread dot: **Your SMS, Unassigned SMS, Your Email, Unassigned Email**. A count of everything found (31,697 at the time), a site filter and a folder filter. Rows: patient avatar, patient name as a link, message preview, timestamp. The practice's SMS number is shown top right.

The "Unassigned" tabs matter: messages arrive without an owner and somebody has to claim them.

---

## Support

Dentally's own support menu: Help Centre, Status Page, Contact Support, Dentally Community, Dentally Academy.
> "Lets make this azen support with our standard support features and a chat bot to help users understand the software easier and how they can use ai to help tem"

So we replace it with our own: help centre, status, contact, community, academy, plus an assistant that teaches the software and shows people how to use the AI features.

**Caution:** the platform itself is unnamed and must never be branded after the agency. A support surface can be credited to the agency, but the product must not become "Azen".

---

## Users & roles

Under Settings. Tabs: **Users, Practitioners, Practitioner Groups**. Filters for active users and location, a search, and "+ New user". The table: user with avatar, email, location, **permission level**, security (a 2FA state), and an edit control.

Permission levels are a **four-level ladder**: 1 Reception, 2 Standard Practitioner, 3 Practice Manager, 4 Administrator.

We currently have three roles (`client_owner`, `client_coordinator`, `agency_admin`) and the practice manager is represented as a coordinator. If we are replacing Dentally, this ladder is what staff expect, and per-user 2FA state is visible to whoever administers it.

---

## Reporting

A tiled index grouped by category, every tile starrable as a favourite, some padlocked (not in the practice's plan).

- **Financial**: Takings, Income, Patient Accounts, Invoices, Sundries, Invoice Timeline, Payment Allocations, Payment Allocation Totals, Private Forecast, NHS Activity, NHS UDA Forecast, Monthly Accounts.
- **Patient**: Patients, New Patients per Month, Age Groups, Lapsed Patients, Birthdays.
- **Appointment**: Recall Effectiveness, Recalls, Appointments, Per Month, Chair Utilisation, Waiting Lists.
- **Treatment**: Treatment Plans, Completed but Not Closed, Unbooked Treatments, Unfinished Treatments, NHS Claims, Complex Care Pathways, Practitioner Activity, Radiograph Audit.
- **Practice**: Audit, Report Runs.

Every report follows one shape: a **left filter panel**, a title, **Export**, and a table. Examples read from the board:

- **Takings**: filters for location, from, until, allocation, method, payment plan, practitioner. View switcher: Transactions Detail / Payment Method / Payment Plan / Practitioner, then Print and Export. The detail table carries date, payer, patient, amount with an allocation status dot, allocated, unallocated, payment plan, payment method. Underneath, **Summary by Payment Method** across Credit Card, Debit Card, Amex, Cash, Cheque, BACS, Bank Transfer, Finance, Stripe, Insurance, Other.
- **Income**: filters for location, date range, payment plan, practitioner, sundries included, zero-value items excluded. Table of invoiced items by treatment code with quantity and total. This is the per-treatment revenue breakdown.
- **Patient Accounts**: filters for location, account state, whether to include inactive patients, sort field and direction. Columns: ID, patient, **Planned NHS**, **Planned Private**, balance.

**Custom Reports** is a real query builder, not a fixed list: pick a base segment, then "Match all filters" over a checkbox tree of patient fields (patient id, active, title, first name, middle name, last name, preferred name, biological sex, date of birth and more), each field expanding to conditions such as is / is not / has any value / is unknown. Add Filter, Save. The result is a table with a column picker and a Messages action.

That last point matters: **a saved report segment is the input to bulk messaging.**

---

## Bulk messaging (campaigns)

Three states in the filter panel: **Draft, Sending, Completed**. At the time of capture: 270 completed, 2 drafts.

Table: title, **segment**, owner, type (SMS or CSV), updated, status, and a progress bar.

The segments are the practice's real recall work, named by hand: recall lists per dentist, NHS children by site and month, "no future appointment", "private patients not seen in a year", and so on.

**"+ New message" is a four-step wizard:**
1. Choose the report segment. Segments render as cards with a live patient count and are disabled at zero.
2. Choose the channel: **Letter** (requires Dentally Mail), **Email**, **SMS**.
3. Choose the message template.
4. Review and send.

This is the single most important row for understanding what our platform is FOR. The practice is already running recall and reactivation by hand: build a segment, export a CSV, send a batch, watch a progress bar. Our recall, reactivation, coordinator and outreach modules automate exactly this work. When we replicate it we should reproduce the wizard's shape, because it is what they know, while the automation runs underneath.

---

## What this changes about our roadmap

Ordered by how much of the practice's day it touches.

1. **Charting (FDI)** is the largest missing piece and is called a must. It also has to write back.
2. **Bulk messaging with segments** exists in Dentally and is used constantly; ours is automated but has no segment builder or campaign list.
3. **Custom Reports**: a filter-tree query builder over patients, feeding both a table and a campaign.
4. **The reports catalogue**: roughly thirty named reports in five categories. Ours has a fraction.
5. **Communication inbox** including the unassigned queues.
6. **Today's Visits** and **recently viewed patients** on the home screen.
7. **Four-level permissions** plus per-user 2FA, against our three roles.
8. **Pinned patient notes**, redesigned.
9. **Support**, replaced with ours plus a teaching assistant.
