# Conversational Booking Agent — Design Spec

Date: 2026-06-20
Status: Approved (design). Build depth: real wiring (Claude live, Supabase, mock Dentally for slots/writes, SMS via the messaging layer). Built in phases.

## Context

The Azen x Vitality platform now sends outreach cadences (reactivation, treatment coordinator) over SMS/WhatsApp/email via the shared messaging layer. When a patient REPLIES, the inbound webhook (`/api/webhooks/twilio/inbound`) currently only pauses the cadence as a safe placeholder.

This spec replaces that placeholder with a **conversational booking agent**: an autonomous, tool-using AI agent that holds a real two-way conversation, answers the patient, and gets them booked into Dentally, escalating to a human when needed. It is the conversational layer the project always intended (see memory `whatsapp-agent-conversational`); SMS is the first channel, WhatsApp follows.

It reuses what exists: the inbound webhook as the trigger, the messaging layer to send replies, `DentallyClient` for diary/booking, Supabase for state, and Claude (Anthropic) for reasoning. It does NOT touch clinical data or give clinical advice.

## Decisions (locked)

- **Autonomy: autonomous with escalation.** The agent converses and books on its own and replies instantly. It hands over to a coordinator when it hits a clinical question, a complaint, an explicit "talk to a human", or its own low confidence.
- **Scope: full concierge, built in 3 phases.** Book, reschedule, cancel; discuss pricing/finance; handle recalls/follow-ups. Phase 1 ships the core (converse + find slots + book + escalation + guardrails + state); pricing and reschedule/cancel/recalls follow.
- **Turn-based agent.** Each inbound message is one turn: load thread + context, run Claude with tools, send one reply, persist. No long-running process.
- **Pricing never invented.** The agent quotes pricing/finance only from a lightweight canonical config keyed by treatment x site x NHS/private. The patient's record supplies their treatment and NHS/private status, which selects the right entry. Later this source swaps to the practice-brain knowledge base (the "second brain"); the agent's `get_pricing` tool is the seam so only its implementation changes.
- **Build depth.** Claude is live; conversation state is real in Supabase; Dentally diary reads and writes (book/reschedule/cancel) run against the mock (the API key is read-only, so real write-back waits for a read+write key); replies send via the messaging layer (dry-run safe). Live inbound needs a public URL (tunnel) for Twilio, same as the webhook step.
- **Channel: SMS first** (where replies land today), WhatsApp later. The agent is channel-agnostic; the transport is the messaging layer.
- **No clinical data or advice.** Operations only. Clinical questions are escalated, never answered.

## Architecture

```
patient reply (SMS) ──▶ POST /api/webhooks/twilio/inbound
   │  (not STOP)
   ▼
runAgentTurn(conversation, inboundText)               src/lib/agent/
   1. load conversation thread + patient context (treatment, NHS/private, upcoming appts)
   2. Claude (Sonnet) with system prompt (role + guardrails + context) and TOOLS:
        find_slots · get_pricing · book · reschedule · cancel · get_patient_appointments · escalate_to_human
   3. execute any tool calls (DentallyClient / pricing config / repo), feed results back to Claude
   4. Claude returns the reply text (or an escalation)
   5. send reply via the messaging layer (Twilio) ; persist the turn ; update status
```

### 1. Agent engine (`src/lib/agent/`)
- `types.ts` — `AgentTurnInput`, `AgentTurnResult`, `AgentTool`, conversation/message types, `ConversationStatus` (active | needs_human | booked | closed).
- `tools.ts` — the tool definitions (JSON schema for Claude) plus a pure `dispatchTool(name, args, deps)` that routes to the implementation. Deps (DentallyClient, pricing lookup, repo) are injected so the dispatcher is unit-testable with stubs.
- `prompt.ts` — `buildSystemPrompt(context)`: role, the hard guardrails, the patient context (name, treatment, NHS/private, consent), and how to use each tool. Pure; unit-tested for the guardrail clauses and no-em-dash rule.
- `run.ts` — `runAgentTurn(input, deps)`: the turn loop. Calls Claude with tools, executes tool calls (bounded iterations), returns `{ replyText, toolCalls, status, escalated }`. The Anthropic client and all I/O deps are injected.

### 2. Tools (what the agent can do)
- **find_slots**(siteId, treatment, fromDate, toDate) -> open diary slots. New `DentallyClient.getAvailability(...)` + a mock `v1/appointments/availability` route. The agent only ever offers returned slots.
- **get_pricing**(treatment, siteId, fundingType: nhs|private) -> `{ priceText, financeText, usps[] }` from the pricing config. Returns "no published price, a coordinator will confirm" when an entry is missing (never guesses).
- **book**(patientId, siteId, slot, treatment) -> `DentallyClient.createAppointment({..., booked_via_api:true})` (simulated on the mock). Requires explicit patient confirmation in the conversation first.
- **reschedule**(appointmentId, newSlot) / **cancel**(appointmentId) -> Dentally appointment edit/state change (Phase 3). Confirmation required.
- **get_patient_appointments**(patientId) -> upcoming/past, to ground reschedule/cancel.
- **escalate_to_human**(reason) -> sets the conversation `needs_human`, returns a hand-over signal.

### 3. Pricing/USP config (`src/lib/pricing/`)
- `config.ts` — typed `PricingEntry[]` keyed by `{ treatment, siteId, fundingType }` with `{ priceText, financeText, usps[] }`, plus `getPricing(args)` lookup. Seeded with the pilot treatments (Invisalign, implant, veneers, whitening, bonding, checkup) for the Vitality sites; NHS vs private where relevant. Editable in one place. Pure, unit-tested.
- Patient context carries `treatment` and `fundingType` (NHS/private). For Dentally this derives from `planned_private_treatment_value` vs `planned_nhs_treatment_value`; the mock patient records carry it directly. The normaliser maps it; no clinical fields.

### 4. Conversation state (Supabase migration `0006_booking_agent.sql`)
- `agent_conversation`: `id`, `site_id`, `dentally_patient_id`, `patient_name`, `channel`, `status` (active | needs_human | booked | closed), `treatment`, `funding_type`, `last_inbound_at`, `created_at`, `updated_at`. One open conversation per patient+channel.
- `agent_message`: `id`, `conversation_id`, `role` (patient | agent | system | tool), `body`, `tool_name` (nullable), `created_at`. The full thread, ordered.
- RLS on, pilot-permissive policy mirroring prior migrations (replace before real data).

### 5. Inbound routing (`src/app/api/webhooks/twilio/inbound/route.ts`)
- After logging the inbound touch and the STOP check: if the sender maps to a patient and the message is not STOP, find-or-create the `agent_conversation`, persist the patient message, call `runAgentTurn`, send the reply via the messaging layer, and persist the agent message. If `needs_human`, send the hand-over line and stop auto-replying (further inbounds are logged but not answered until a human re-opens). Cadence stays paused (a live conversation supersedes the cadence).
- A failed turn (Claude/tool error) escalates to `needs_human` and sends a safe fallback ("Thanks, a member of our team will be in touch"), never a broken or empty reply.

### 6. Guardrails (system prompt + code)
- No clinical advice or diagnosis. Clinical questions -> `escalate_to_human`, with a line offering a clinician callback.
- Never invent a slot or a price: slots come only from `find_slots`, prices only from `get_pricing`.
- Confirm explicitly before any write action (book/reschedule/cancel); read back the date, time, site, and treatment.
- Respect consent and STOP (the suppression list already gates outbound).
- No em-dash characters anywhere in agent output. GBP with the £ symbol.
- Stay on task: booking and the practice. Decline unrelated requests politely.
- Bounded tool-iteration per turn (e.g. max 4) so a turn always terminates.

## Components and boundaries
- `src/lib/agent/{types,prompt,tools,run}.ts` — the agent; pure prompt/tool-dispatch logic unit-tested, the turn loop tested with a mocked Anthropic client.
- `src/lib/pricing/config.ts` — pricing source of truth; pure lookup, unit-tested.
- `src/lib/agent/repository.ts` — Supabase reads/writes for conversations/messages.
- `src/lib/dentally/client.ts` — add `getAvailability`; (Phase 3) appointment edit/cancel.
- `src/app/api/mock-dentally/v1/appointments/availability/route.ts` — mock open slots.
- `src/app/api/webhooks/twilio/inbound/route.ts` — route replies to the agent.
- Each unit has one purpose and a typed interface; the agent's external dependencies (Claude, Dentally, repo, messaging) are injected so every piece is testable in isolation.

## Build phases (for the plan)
- **Phase 1 — core conversation + booking:** migration, types, prompt, find_slots (+ mock availability), book, escalate, the turn loop (mocked-Claude tests), conversation repository, inbound routing, guardrails. Outcome: a patient can text back, the agent proposes real (mock) slots and books, or escalates.
- **Phase 2 — pricing/finance:** pricing config + `get_pricing`, patient NHS/private context, pricing discussion in the prompt.
- **Phase 3 — manage + lifecycle:** reschedule/cancel tools (+ Dentally methods + mock), recalls/follow-ups handling.

## Testing / verification
- Unit: prompt assembly (guardrail clauses present, no em-dash, GBP); `dispatchTool` routing with stub deps; pricing lookup (hit, miss -> safe fallback, NHS vs private); availability/normalise mapping.
- Agent loop: with a mocked Anthropic client scripted to call a tool then reply, assert the tool runs, the result feeds back, and the final reply is returned; an error path escalates.
- Integration (mock Dentally + live Claude, dry-run send): simulate an inbound "yes, Tuesday works" -> agent calls find_slots -> proposes -> on confirm calls book -> conversation `booked`; a "what will it cost?" -> get_pricing quote; a clinical question -> `needs_human` + hand-over line.
- E2E (when the public URL + read+write key land): a real reply from the test handset drives a real booking.
- Build + typecheck pass clean.

## Out of scope / production implications (flagged per project rule)
- Real Dentally **read+write** key for live booking/reschedule/cancel (currently read-only -> simulated on the mock).
- Public URL/tunnel for Twilio to deliver inbound replies live.
- WhatsApp channel (SMS first; the agent is channel-agnostic).
- The pricing source swap to the practice-brain "second brain" once real pricing is loaded.
- Real Supabase auth + per-site RLS (pilot-permissive policies continue).
- Cost/rate controls on Claude, full audit logging of agent actions and transcripts, and human review of agent conversations before unsupervised live use on real patients.
