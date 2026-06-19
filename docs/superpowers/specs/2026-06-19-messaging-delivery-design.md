# Messaging Delivery Layer — Design Spec

Date: 2026-06-19
Status: Approved (design). Build depth: real adapters (Twilio + Resend), mocked-provider unit tests, live calibration per channel as credentials arrive.

## Context

The Azen x Vitality platform drafts outreach with Claude and enqueues it to an outbox, but **sending is currently stubbed**: a queued `reactivation_outbox` row is immediately marked `sent` with `provider = "stub"` ("sent (simulated)"). This spec makes sending real.

It is a **shared messaging delivery layer** (`src/lib/messaging/`), module-agnostic, because both Reactivation and the Treatment Coordinator enqueue to the same outbox shape. It is wired into Reactivation's outbox this round; the Treatment Coordinator adopts it later by pointing its drain at the same layer.

**This is NOT the WhatsApp agent.** The WhatsApp agent [PILOT] module is a separate, stateful conversational AI agent (two-way conversations, booking/reschedule/cancel via Dentally, human takeover). This layer only does outbound channel sends plus basic inbound reply capture that auto-pauses a cadence. See the memory note `whatsapp-agent-conversational`.

## Decisions (locked)

- **Scope:** full — outbound SMS + WhatsApp + email, inbound reply capture (auto-pause the cadence), opt-out (STOP), and delivery-status tracking.
- **Providers:** Twilio for SMS and WhatsApp (Twilio is an approved WhatsApp BSP, one account covers both); **Resend** for email.
- **Scheduling:** **Vercel Cron** hits the cadence-sweep and the outbox-drain endpoints on a timer; both protected by `CRON_SECRET`. No Inngest this round.
- **Opt-out is local.** The Dentally key is read-only, so STOP suppression is stored in a Supabase `message_suppression` table checked before every send. When a read+write Dentally key lands, we additionally mirror `use_sms=false` back to Dentally (future, noted not built).
- **Recipient resolution at send time.** The outbox `to_ref` is `patient:<dentallyPatientId>`. The drain worker resolves the actual phone/email from Dentally (`getPatient` -> `mobile_phone` / `email_address`) at send time, so we do not persist phone/email PII in our store. WhatsApp reuses the mobile number as `whatsapp:+...`.
- **Dry-run safety.** A `MESSAGING_DRY_RUN` flag (and absent provider credentials) preserves today's no-op stub behaviour, so this merges safely and each channel flips live independently as its credentials arrive. SMS goes live first with the user's Twilio key; WhatsApp needs a WhatsApp sender + approved templates; email needs a Resend key + verified domain.
- **Email is outbound only.** Inbound reply handling (auto-pause, STOP) covers Twilio SMS/WhatsApp. Inbound email parsing is out of scope.
- **No clinical data.** Only operations fields (name, phone, email, message body) are handled; nothing clinical.

## Architecture

```
Vercel Cron ──▶ POST /api/reactivation/sweep     (existing: enqueue due cadence steps → reactivation_outbox)
Vercel Cron ──▶ POST /api/messaging/drain        (new send worker)
                   │  for each queued outbox row (per site):
                   │    1. resolve recipient: to_ref → DentallyClient.getPatient → mobile_phone / email_address
                   │    2. isSuppressed(to_ref|address, channel)?  → mark blocked, skip
                   │    3. sendMessage({ channel, to, body }) ──▶ provider adapter
                   │    4. persist provider_message_id + to_address; status sent | failed
                   ▼
        src/lib/messaging/send.ts  ──route by channel──▶  twilio-sms · twilio-whatsapp · resend-email

Twilio ──status callback──▶ POST /api/webhooks/twilio/status   → update outbox row by message SID
Twilio ──inbound reply───▶ POST /api/webhooks/twilio/inbound   → inbound touch + auto-pause cadence + STOP→suppress
```

### 1. Providers (`src/lib/messaging/providers/`)
- `twilio-sms.ts`, `twilio-whatsapp.ts`: POST to Twilio's Messages API (`Authorization: Basic <sid:token>`, `from`/`to`/`Body`, `StatusCallback`). WhatsApp prefixes `whatsapp:`. Injectable fetch for tests.
- `resend-email.ts`: POST to Resend's send API with the verified `from`. Injectable fetch.
- Each returns `{ providerMessageId, status }` or throws a typed `MessagingError`; each is a no-op that returns a synthetic id when `MESSAGING_DRY_RUN` is set or its credentials are absent.

### 2. Dispatcher + helpers (`src/lib/messaging/`)
- `types.ts`: `OutboundMessage` ({ channel, to, body, statusCallbackUrl? }), `SendResult`, `MessagingError`, channel enum.
- `send.ts`: `sendMessage(msg, deps?)` routes by channel to the right provider; central dry-run guard.
- `resolve.ts`: `resolveRecipient(toRef, channel, client)` — parses `patient:<id>`, fetches the patient, returns the phone (sms/whatsapp) or email. Pure mapping over a `getPatient` result; testable with a stub client.
- `suppression.ts`: `isSuppressed(...)`, `addSuppression(...)` over `message_suppression`; `isStopKeyword(body)` (STOP/STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT, case-insensitive). Pure keyword check is unit-tested.
- `signature.ts`: `verifyTwilioSignature(url, params, header, token)` — Twilio HMAC-SHA1 validation. Pure, unit-tested.

### 3. Drain worker (`src/app/api/messaging/drain/route.ts`)
- `POST`, `CRON_SECRET`-gated. For each vitality site: select `reactivation_outbox` rows with `status = 'queued'`; resolve recipient; check suppression (consent was already enforced at enqueue time by the sweep/action route, so the drain gate is the STOP suppression list); `sendMessage`; update the row (`status`, `provider`, `provider_message_id`, `to_address`, `sent_at`) and stamp the touch. Idempotent: only processes `queued` rows; a send failure marks `failed` (retried next drain up to a cap). Returns `{ drained, sent, failed, blocked }`.

### 4. Webhooks (`src/app/api/webhooks/twilio/`)
- `status/route.ts`: validate signature; update the `reactivation_outbox` row matched by `provider_message_id` to `delivered`/`failed`.
- `inbound/route.ts`: validate signature; match the sender's phone to the most recent outbound `to_address` to find the target + cadence; insert a `reactivation_touch` (`direction='inbound'`); set the active cadence to `paused`; if `isStopKeyword(body)`, `addSuppression(...)`. Returns empty TwiML 200.

### 5. Schema (migration `supabase/migrations/0005_messaging.sql`)
- `message_suppression`: `id`, `site_id`, `channel`, `to_ref` (or address), `reason` (default 'stop'), `created_at`. Unique on (site_id, channel, to_ref).
- `alter table reactivation_outbox add column to_address text, add column provider_message_id text;` plus an index on `provider_message_id`.
- RLS enabled; pilot-permissive policy mirroring `0004` (replace before real data).

### 6. Scheduling + config (`vercel.json`)
- Crons: `/api/reactivation/sweep` and `/api/messaging/drain` every few minutes (exact cadence configurable). Both require `CRON_SECRET` (Vercel sends it; the routes reject otherwise).
- New env: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_SMS_FROM`, `TWILIO_WHATSAPP_FROM`, `RESEND_API_KEY`, `RESEND_FROM`, `MESSAGING_DRY_RUN`, `CRON_SECRET`, `PUBLIC_BASE_URL` (for building `StatusCallback`/webhook URLs).

## Components and boundaries

- `src/lib/messaging/providers/*` — one provider each; depend on env + fetch; mocked-fetch tested.
- `src/lib/messaging/send.ts` — dispatcher; depends on the providers. 
- `src/lib/messaging/resolve.ts` — `to_ref` -> address via Dentally. Pure over a client.
- `src/lib/messaging/suppression.ts` — suppression repo + `isStopKeyword`. Keyword logic pure.
- `src/lib/messaging/signature.ts` — Twilio signature validation. Pure.
- `src/app/api/messaging/drain/route.ts` — the worker; I/O at the route layer.
- `src/app/api/webhooks/twilio/{status,inbound}/route.ts` — webhooks.
- Each unit has one purpose and a typed interface, understandable and testable on its own.

## Build phases (for the plan)

- **Phase A — outbound:** migration `0005`; types; provider adapters (mocked-tested); `send.ts` dispatcher; `resolve.ts`; `suppression.ts`; the drain route; dry-run guard; `.env.example`. Outcome: a queued message really sends (or dry-run no-ops) and records its provider id.
- **Phase B — webhooks:** signature validation; status webhook; inbound webhook (auto-pause + STOP suppression). Outcome: delivery state updates and replies pause the cadence.
- **Phase C — scheduling + go-live:** `vercel.json` crons + `CRON_SECRET` gating; live calibration with the user's Twilio key (SMS first), then WhatsApp/email as their creds arrive.

## Testing / verification

- Unit: each provider builds the correct API request and is a no-op in dry-run (mocked fetch); dispatcher routes by channel; `isStopKeyword` matches the keyword set; `verifyTwilioSignature` accepts a valid and rejects a tampered signature; `resolveRecipient` maps a patient to phone/email and refuses an unknown channel.
- Integration (dry-run): enqueue a reactivation message, run the drain, assert the row moves `queued -> sent` with a synthetic provider id and `to_address` populated; a suppressed recipient is marked blocked and not sent.
- Live calibration: with the real Twilio key and `MESSAGING_DRY_RUN=false`, drain sends one real SMS to a test handset; the status webhook flips it to `delivered`; replying `STOP` adds a suppression row and pauses the cadence; a normal reply pauses the cadence and logs an inbound touch.
- Build + typecheck pass clean.

## Out of scope (this round)

- Writing opt-out back to Dentally (read-only key; local suppression only for now).
- Inbound email reply parsing (email is outbound only).
- The WhatsApp conversational agent (separate module; this is transport only).
- Treatment Coordinator adoption of the shared layer (trivial follow-up; TC keeps its stub until then).
- Real Supabase auth + per-site RLS (pilot-permissive policies continue).
