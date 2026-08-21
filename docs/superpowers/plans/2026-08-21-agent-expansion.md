# Agent Expansion Plan — every department, carefully

Principle: an agent earns its place by revenue-per-build or by closing a
loss the practice already accepts silently. No agent for its own sake. Every
new send routes through the existing choke points (consent, suppression,
quiet hours, frequency cap, kill switch, atomic claim, MESSAGING_DRY_RUN) and
every patient-facing word through the GDC/ASA compliance scan. No agent gives
clinical advice; the line is triage-and-route, never diagnose.

## Wave 0 — light up what is already built (no new agents, days not weeks)
The cheapest revenue in the building is dark features, not new ones.
- **Missed-call text-back.** Fully coded (webhooks/twilio/voice). Needs: the
  practice's Twilio number Voice webhook pointed at the route, PUBLIC_BASE_URL
  exact-match, and the `after-hours` toggle on. Highest ROI per hour of work.
- **WhatsApp agent.** Built; blocked on the client's Meta Business login (the
  same login that unlocks their real ad performance data).
- **Reviews requests.** Built; toggle off.
Wave 0 is configuration + the client's own accounts, not code.

## Wave 1 — the two money agents (build next, in this order)

### 1. Treatment-plan closer  [highest value]
Conversational follow-up on UNACCEPTED treatment plans. The coordinator module
already surfaces these opportunities; nothing closes them, and unaccepted
treatment is the largest untapped pool in any practice.
- Seam: the coordinator opportunity list is the trigger source; reuse
  contactLead + the nurture cadence shape, a dedicated closer cadence.
- Guardrails: never quotes a clinical outcome; frames value + next step +
  booking link; no funding jargon; the plan's own figures only, never invented.
- Ships in DRAFT-for-approval first (staff sees the message before it sends),
  then auto after tone is trusted.
- New: coordinator_closer touch/outbox tables (per-module messaging pattern,
  hidden FKs), a cadence, a worklist column. Its own toggle.

### 2. Outstanding-balance collection agent
The platform already computes who owes what (listOutstanding). Polite, capped
reminder conversations with a hard escalation to a human on any dispute.
- Guardrails: tone locked (never threatening), a strict per-patient frequency
  cap, escalate-not-argue, stops on any "wrong"/"dispute"/"already paid".
- DRAFT-for-approval first, always. Money + patients = maximum caution.
- New: collection touch/outbox tables, a cadence, its own toggle.

## Wave 2 — loyalty + loop-closing (lower risk, real retention)

### 3. Post-op check-in agent
Next-day aftercare check after flagged procedures (extraction, implant, surgical).
- The hard rule: ANY symptom word in the reply -> instant human escalation
  (task queue + optional alert). The agent triages, never advises. This is the
  compliance-critical one; its escape hatch is wider than any other agent's.
- New: a procedure-completed trigger (from the diary sync), a one-touch check,
  a symptom classifier that fails SAFE (unsure -> escalate).

### 4. Recall-aware booking replies  [enhancement, small]
When a recall/reactivation text gets a "yes", the booking agent should already
know which appointment type to book. Closes the loop on ~18,000 queued recall
targets so the reply -> booking is one step, not a fresh conversation.
- Seam: thread the recall context into the inbound agent's opening state.

## Wave 3 — intelligence, not chat

### 5. Manager co-pilot (scoped)
Blerta-tier co-pilot: operational questions only (diary, patients, tasks,
leads), NO financials/strategy, reusing the owner co-pilot's tools behind a
role-scoped tool allowlist. Already designed, never built.

### 6. Proactive anomaly alerts
Not a chatbot: a daily/hourly pass over data already computed that pings the
owner when something looks wrong — takings off trend, a cluster of high no-show
risks this afternoon, a lead uncontacted past SLA. An alerting layer on the
co-pilot's own read tools.

## Deliberately NOT building (and why)
- Voice-AI receptionist: missed-call text-back captures most of the value at a
  fraction of the complexity and compliance exposure.
- Clinical diagnosis / charting AI: GDC line. We stay decision-support.
- Generic social-content bots: no data advantage; the ad recreator already
  covers the real creative need.
- HR automation: the records module is enough; automating it adds risk not value.

## Cross-cutting build discipline
- Each agent = a pure classifier/decider module + a thin route, Opus-built,
  adversarially verified, mutation-checked, committed local, deployed on the
  user's word. Toggles ship OFF.
- DRAFT-for-approval as the default first mode for anything touching money or a
  patient's clinical state; auto-send is a second, separately-approved step.
- Shared infra to build once: a per-agent cadence/outbox is the repeated shape;
  consider a small generator so agent N is a config, not a copy-paste.

## Sequencing recommendation
Wave 0 (config, this week) -> Treatment-plan closer -> Collection agent ->
Post-op check-in -> Recall-aware replies -> Manager co-pilot -> Anomaly alerts.
Stop after each; measure; the practice's own data will re-rank the tail.
