# Call transcript coverage ledger

Every capability, promise and instruction from the Vitality x Azen call (16 Jul), tracked to done.
All ✅ items are LIVE ON PRODUCTION (deployed 18 Jul, real data only - every sample/mock row and figure purged).
Legend: ✅ built and verified · 🔨 being built right now · 📋 queued (brief written) · 🫵 needs you · 🏥 needs the client · 🚫 not planned (was represented honestly in the call).

## The platform demo claims

| Transcript item | Status | Notes |
|---|---|---|
| Getting-started checklist unlocks real data | ✅ | Live; Blerta (manager) can now see and tick it |
| Co-pilot fully live, Ctrl+J | ✅ | Now a bottom ask-bar with starter prompts |
| Practice brain live, tiered passwords | ✅ | Pilot passwords documented; rotate after handover |
| Train it on the Chris Barrow zip | 🫵 | Mechanism ready (practice brain ingestion). Send me the zip file and I load it |
| Calendar / diary live from Dentally | ✅ | N15 live, all sites synced |
| Patient records, notes, treatment plans, history | ✅ | Live, 51k patients |
| Voice dictation on patient notes | 🫵 | Built; needs TRANSCRIPTION_API_KEY confirmed in prod before demoing |
| Notifications | ✅ | Mock-sourced ones now honestly tagged "Sample" |

## Growth features

| Transcript item | Status | Notes |
|---|---|---|
| Smile assessment: AI questions, per-treatment campaigns | ✅ | Live on the public site |
| 7-second SMS to new leads | ✅ | Live (measured ~7s in testing) |
| Booking via SMS conversation into the diary | ✅ | Live end-to-end, validated against real Dentally |
| Booking via WhatsApp | 🏥 | Built + sandbox-tested; blocked on the client's Meta business login |
| Leads view with source attribution | ✅ | Including the new "Abandoned booking" source |
| Capture people who abort booking (the dentology story) | ✅ | Two-step booking; abandoners become win-back leads |
| Funnel bottleneck analytics ("where do they fall off") | ✅ | Recording on quiz + booking + landing pages incl. per-section views; presented as numbers/tables per the no-graphs design law |
| Custom landing pages per campaign | ✅ | AI-generated, compliance-linted, real prices only |
| Landing page A/B testing with winner promotion | ✅ | 50/50 sticky split, live demo page seeded |
| Meta ads: campaign builder + AI ad copy + launch guide | ✅ | Built earlier; GDC/ASA-compliant copy |
| Meta ad library of live competitor ads + scoring | ✅🏥 | Creative Intelligence built: click a creative for AI score, why-it-works, compliance watch-outs and est. cost-per-lead range. Live competitor data still needs the client's Meta account |
| Publish campaigns to Meta / budget enforcement / metrics pulled back | 📋 | Adapter brief written; activates only once Meta is connected |
| "Recreate this ad with your branding" as a downloadable image | 📋🫵 | UNBLOCKED: powering with the Higgsfield API. Brief ready; needs the HIGGSFIELD_API_KEY added to the environment (not pasted in chat) |
| Nurture cycles for close-but-not-ready leads | ✅ | Built: 3 gentle touches (days 3/10/21), reply exits instantly, capped, opt-out safe, 60-day age guard |
| A/B testing of outreach messages with conversion tracking | 📋 | Variant tagging + attribution brief written; "self-learning" language retired |

## The campaigns machinery (the Shaq test)

| Transcript item | Status | Notes |
|---|---|---|
| Filter patients by treatment history + last visit ("private clean in 3 years, not in 3 months") | ✅ | Engine built; matches on Dentally's treatment labels (coarse: Exam, Scale & Polish etc. — fine-grained treatment names are not in the Dentally feed) |
| Preview the exact matched list before anything sends | ✅ | Campaigns screen shows every matched patient with masked number + why they matched + missing-data exclusion counts |
| Sidebar screen to set up campaigns with filters | ✅ | Built: treatment keywords, visit windows, age range, gender, practitioner picker, daily cap |
| Tell the co-pilot to run it in plain English | ✅ | Built: builds lists on request ("females around 30"), reads back segment + count, launches only on explicit yes with the switch on |
| Book into a SPECIFIC clinician's diary (Shaq) | ✅ | Agent prefers the campaign's practitioner's slots |
| Caps so patients are never spammed | ✅ | Per-campaign daily cap + one-message-per-patient-per-day across all systems |
| Fill Shaq's Saturday (the test itself) | 🫵🏥 | Needs: wave deployed + Outreach switch flipped + a few days of cadence. Deadline ~1 Aug |

## Costs and deliverability (the ClickSend conversation)

| Transcript item | Status | Notes |
|---|---|---|
| Twilio cost estimate from their Dentally SMS bills | 🫵 | Your task with your Twilio contact |
| Never pay for undeliverable texts (ClickSend point) | ✅ | LIVE: Lookup enabled in production; number-health chip on patient records + blocked count on campaigns |
| Email validation (NeverBounce) before emailing | 📋 | Seam being built; email itself is not configured in prod yet |
| WhatsApp/SMS preference form for patients | ✅ | Built: signed per-patient page; stop option routes through the real suppression machinery |

## Access and operations

| Transcript item | Status | Notes |
|---|---|---|
| Manager sees everything | ✅ | Blerta's coordinator login live |
| Staff see much less ("only what they'd have in Dentally") | 📋 | Third role tier brief written; lands after the design branch merges |
| System controls stay owner-only | ✅ | Live |
| Bug highlight → sent straight to us | ✅ | Feedback widget live; set FEEDBACK_WEBHOOK_URL to pipe into our chat |
| "Everything is tracked" usage metrics | 📋 | Funnel surfaces tracked today; product-wide telemetry brief written |
| Inactive patients: "WE decide who's excluded" | ✅ | Closed by the patient status control: owner/manager set active/inactive/do-not-contact per patient, written back to Dentally, excluded from all targeting |

## The website (separate project, not this platform)

| Transcript item | Status | Notes |
|---|---|---|
| Old logo emblem, "Dental" centred under "Vitality" | 🫵 | Website project |
| Kill the wrong-anatomy 3D tooth; smiles not teeth; no stock-image look | 🫵 | Website project |
| Pull content from New Smile London socials | 🫵 | Website project |
| Transparent pricing on the site | ✅/🫵 | Landing pages + funnel show real prices; website pages are the website project |

## Explicitly future (represented honestly in the call)

| Item | Status |
|---|---|
| Power dialer | 🚫 for now — needs telephony infrastructure; revisit with the South Africa calling plan |
| South Africa call centre recruitment | 🫵 business task |
| AI video (UGC) of real dentists | 📋 | Same Higgsfield integration can power this as a second phase, test-gated as agreed in the call |
| Dentology recon + dummy enquiry | 🫵 your task |
| Funnel screenshots on a Figma board | 🫵 I can generate the screenshots pack on request |

## Standing environment items

- STAFF_ALERT_PHONE — waiting on the number from you (handover alerts dormant until set)
- Meta business login — waiting on the client (unblocks WhatsApp + ads)
- TRANSCRIPTION_API_KEY — confirm before demoing dictation
- FEEDBACK_WEBHOOK_URL — set to our chat webhook to complete the feedback loop
- Dentally write-key rotation — still owed (key was pasted in chat once)
- Practice brain pilot passwords — rotate at handover
