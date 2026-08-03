# PLAN-PANEL.md — the treatment plan panel: build spec

The working half of Dentally's charting screen. Everything built so far is the arch; this is what
a clinician actually operates during an appointment.

Reference: the owner's full-resolution Dentally screenshot (2026-08-02). Layout notes below are
measured off it, not invented.

---

## 1. The reference layout

```
[+] [688300 ▼]                          Cloud Gallery | Images | BPE ● | History | Base Chart | ⚙

ℹ NHS Exemption: Universal credit

┌ Appt. 1   📷 Acquire Images      <practitioner>   Today at 16:00   ⚡Completed |||  ⌄  ⋮ ┐
│ 📄 View note  🎤  [Draft]  <note text>                        Last updated: 42 minutes ago│
│ ⌄  Sun 02 Aug 26          Intraoral Periapical Image     ZH (Private)    0 min   £0.00  ☑ │
│ ⌄  Sun 02 Aug 26    Urgent Assessment - Problem Focused  ZH  NHS        15 min          ☐ │
│ ⌄  Sun 02 Aug 26    UL6  RCT stage 1                     ZH  NHS        30 min          ☐ │
│                                                          45 min       £0.00               │
└───────────────────────────────────────────────────────────────────────────────────────────┘

                                   ⊞  add appointment

[icon row]              Total Price: £0.00   Uncharged: £0.00
                        [Charge]  [Complete treatment plan]  [Submit claim]
```

Row anatomy, left to right: expand chevron · date · **tooth** · treatment name · practitioner
initials · funding badge (NHS / Private) · duration · price · completed checkbox.

## 2. The data model, VERIFIED LIVE (2026-08-02, not inferred)

```
treatment_plan        id · nickname · completed · completed_at · start_date · end_date
                      payment_plan_id · practitioner_id · import_id
                      private_treatment_value · nhs_uda_value · nhs_completed_uda_value
  └─ treatment_appointment   id · position · appointment_id · notes · bookable
                             patient_id · treatment_plan_id
       └─ treatment_plan_item   teeth · surfaces · region · base_chart
                                duration · price · value · completed · completed_at · charged
                                practitioner_id · payment_plan_id · invoice_id
                                uda_band · nhs_treatment_cat · nomenclature · notes
```

**Both resources also list practice-wide, live-verified 2026-08-03.** `GET /v1/treatment_plan_items` returns 989,292 rows and `GET /v1/treatment_plans` 85,341, with no patient scope required; plan items also carry `invoice_id`. This panel is deliberately per-patient, so nothing here changes — it is recorded because elsewhere the repo claimed these were per-patient only, and the reports work needs to know they are not.

Confirmed mappings:
- **`position` is the card number.** `position: 0` renders as "Appt. 1". Do not invent numbering.
- **The `688300` chip is the treatment_plan id.** A live sample returned `688308`, same range.
- **`treatment_appointment.notes` is the note in the card header.** It is readable.
- **`appointment_id`** links the card to a real diary appointment — that is where the date, time
  and practitioner in the card header come from, not from the treatment_appointment itself.
- `payment_plan_id` 1 = NHS, 2 = Private. Live sample: 73 NHS / 27 Private.
- `uda_band` and `nhs_treatment_cat` are populated only on NHS items (86/100 were null).

## 3. THE FINDING THAT SHAPES THE BUILD

**Only 17 of 100 live plan items carry a `treatment_appointment_id`.**

83% of items belong to no appointment card. Build this as pure "Appt. 1 / Appt. 2" groups and
most of a real patient's plan silently disappears — the same class of failure as the blank
surfaces and the unparsed Palmer teeth, and the most dangerous kind, because the screen looks
complete.

**Required:** items with no appointment render in their own clearly-labelled group, counted, with
the reason stated. Never dropped, never quietly folded into the first card. Follow the existing
precedent on this screen: the `unplaced` teeth affordance and the chart status bar.

Also `charged` was **false on all 100** items sampled. "Uncharged" will equal the total in
practice — do not treat a zero charged-total as a bug, and do not hide the line when it is zero.

## 4. Readable vs gated

**Readable, build fully:** plan header and nickname, the plan chip, appointment cards with
position/date/time/practitioner, the appointment note, every item row (tooth, name, funding,
duration, price, completed), per-card duration and price totals, plan-level totals from
`private_treatment_value` / `nhs_uda_value` / `nhs_completed_uda_value`, and completion state.

**Gated — rendered, disabled, each with its rendered explanation sentence:**
`+ add appointment` · `Charge` · `Complete treatment plan` · `Submit claim` · the item completed
checkboxes · the note's Draft/mic editing affordances.

Why each is impossible today: no POST on `treatment_appointments`; no PUT on `treatment_plans`
(verified 404); `nhs_claims` is GET-only.

**`Charge` stays disabled even if a route is found.** It moves money. It does not ship without
the owner's explicit written sign-off, separately from charting. Do not let a future contributor
wire it because the API happened to allow it.

**NHS exemption banner** — source not yet verified. Probe the patient object before building it;
if the field cannot be found, omit the banner rather than inventing one. An exemption shown
wrongly is a claim problem.

## 5. Constraints specific to this panel

- **The client boundary.** `boundary.test.ts` pins that `tab-chart.tsx` may import only
  `chart-workspace` and `plan-cards` from the chart directory. The panel is overwhelmingly static
  display: keep it **server-safe**, isolate collapse/expand into one small client leaf, and update
  the boundary test deliberately rather than by accident. A shared component with function props
  must not gain `"use client"` — that bug has shipped here before.
- **Money is `tabular-nums`, right-aligned, and never rounded away.** Prices come as pence.
- **Duration totals are summed from items**, not stored. A card's total must equal its rows.
- Pure logic in `.ts` — grouping, totals, funding rollup, the unassigned bucket. vitest cannot
  reach `.tsx`.
- Read-only mirror: **no Dentally write call anywhere.**

## 6. File ownership

| owner | files |
|---|---|
| **A — logic** | `src/lib/charting/plan-panel.ts` + `plan-panel.test.ts` |
| **B — data** | `src/lib/dentally/client.ts` (add the GET methods), `src/lib/dentally/charting-read.ts`, mock fixtures under `src/app/api/mock-dentally/` |
| **C — UI** | `chart/plan-panel.tsx`, `chart/appointment-card.tsx`, `chart/plan-footer.tsx`, `chart/plan-cards.tsx` |
| **integrator** | `tab-chart.tsx`, `boundary.test.ts`, reconciliation, gates |
