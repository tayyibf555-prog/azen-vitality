# Messaging Delivery Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make outreach actually send: a shared messaging layer that drains the outbox to Twilio (SMS + WhatsApp) and Resend (email), records delivery status, captures inbound replies (auto-pausing the cadence and honouring STOP), and runs on Vercel Cron.

**Architecture:** A module-agnostic `src/lib/messaging/` layer (provider adapters + a channel dispatcher + recipient resolution + suppression + Twilio signature check), driven by a `POST /api/messaging/drain` worker that reads `reactivation_outbox`, resolves the recipient from Dentally at send time, checks the local suppression list, sends, and records the provider message id. Two Twilio webhooks update delivery state and handle replies. Vercel Cron triggers the sweep and the drain. Provider calls use `fetch` (no SDKs); a `MESSAGING_DRY_RUN` guard keeps everything a safe no-op until credentials arrive.

**Tech Stack:** Next.js 16 (App Router), TypeScript strict, `@supabase/supabase-js`, Vitest. Twilio + Resend over `fetch`. No new npm dependencies.

Spec: `docs/superpowers/specs/2026-06-19-messaging-delivery-design.md`

---

## File structure (created/modified)

- Create `src/lib/messaging/types.ts` — channels, `OutboundMessage`, `SendResult`, `MessagingError`, `isDryRun`.
- Create `src/lib/messaging/providers/twilio.ts` — `sendViaTwilio` (SMS + WhatsApp).
- Create `src/lib/messaging/providers/resend.ts` — `sendViaResend` (email).
- Create `src/lib/messaging/send.ts` — `sendMessage` dispatcher.
- Create `src/lib/messaging/resolve.ts` — `parsePatientRef`, `recipientFromPatient`, `resolveRecipient`.
- Create `src/lib/messaging/suppression.ts` — `isStopKeyword`, `isSuppressed`, `addSuppression`.
- Create `src/lib/messaging/signature.ts` — `computeTwilioSignature`, `verifyTwilioSignature`.
- Modify `src/lib/reactivation/repository.ts` — add outbox-drain + inbound-lookup functions.
- Create `supabase/migrations/0005_messaging.sql` — `message_suppression` + 2 outbox columns + pilot RLS.
- Create `src/app/api/messaging/drain/route.ts` — the send worker.
- Create `src/app/api/webhooks/twilio/status/route.ts` — delivery status.
- Create `src/app/api/webhooks/twilio/inbound/route.ts` — replies (auto-pause + STOP).
- Create `vercel.json` — cron schedules.
- Modify `.env.example` — new messaging env vars.
- Test files alongside each pure unit.

Recipient phone/email are NEVER persisted except `reactivation_outbox.to_address` (set at send time, used to correlate inbound replies). No clinical data.

---

## PHASE A — Outbound

## Task 1: Env vars

**Files:**
- Modify: `.env.example`
- Modify (gitignored): `.env.local`

- [ ] **Step 1: Append to `.env.example`**

```
# Messaging (Twilio SMS + WhatsApp, Resend email)
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_SMS_FROM=
TWILIO_WHATSAPP_FROM=
RESEND_API_KEY=
RESEND_FROM=
RESEND_SUBJECT=A note from Vitality Dental
MESSAGING_DRY_RUN=true
CRON_SECRET=
PUBLIC_BASE_URL=http://localhost:3000
```

- [ ] **Step 2: Mirror the same keys into `.env.local`** with `MESSAGING_DRY_RUN=true` for now (real Twilio/Resend values added at go-live). Do NOT commit `.env.local`.

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "chore: messaging env vars"
```

---

## Task 2: Schema migration

**Files:**
- Create: `supabase/migrations/0005_messaging.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0005_messaging.sql
-- Local opt-out suppression + outbox send-tracking columns. Ops-only, no clinical data.

create table if not exists message_suppression (
  id uuid primary key default gen_random_uuid(),
  site_id text not null,
  channel text not null,
  to_ref text not null,
  reason text not null default 'stop',
  created_at timestamptz not null default now(),
  unique (site_id, channel, to_ref)
);
create index if not exists idx_suppression_lookup on message_suppression (site_id, channel, to_ref);

alter table reactivation_outbox add column if not exists to_address text;
alter table reactivation_outbox add column if not exists provider_message_id text;
create index if not exists idx_react_outbox_msgid on reactivation_outbox (provider_message_id);

alter table message_suppression enable row level security;

-- PILOT permissive RLS (mirrors 0004; replace before real data).
grant all on message_suppression to anon, authenticated;
create policy pilot_all_suppression on message_suppression for all to anon, authenticated using (true) with check (true);
```

- [ ] **Step 2: Apply** the migration to the Supabase project `qoiyaiiajdqydyrccixt` (Supabase MCP `apply_migration`, name `messaging`). Verify `message_suppression` exists and `reactivation_outbox` has `to_address` + `provider_message_id`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0005_messaging.sql
git commit -m "feat: messaging suppression table + outbox send-tracking columns (applied)"
```

---

## Task 3: Messaging types

**Files:**
- Create: `src/lib/messaging/types.ts`

- [ ] **Step 1: Write the types** (no test; consumed by later tasks)

```ts
export type MessageChannel = "sms" | "whatsapp" | "email";

export interface OutboundMessage {
  channel: MessageChannel;
  to: string;                 // phone (sms/whatsapp) or email address
  body: string;
  subject?: string;           // email only
  statusCallbackUrl?: string; // sms/whatsapp delivery callback
}

export interface SendResult {
  providerMessageId: string;
  provider: string;           // "twilio" | "resend" | "dry-run"
  status: string;             // provider status, e.g. "queued"
}

export class MessagingError extends Error {
  constructor(public provider: string, public status: number, message: string) {
    super(`${provider} ${status}: ${message}`);
  }
}

/** Global safety switch: when true, providers no-op and return a synthetic id. */
export function isDryRun(): boolean {
  return process.env.MESSAGING_DRY_RUN === "true";
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/lib/messaging/types.ts
git commit -m "feat: messaging domain types"
```

---

## Task 4: Twilio provider (SMS + WhatsApp, mocked-fetch TDD)

**Files:**
- Create: `src/lib/messaging/providers/twilio.ts`
- Test: `src/lib/messaging/providers/twilio.test.ts`

`sendViaTwilio` posts to the Twilio Messages API with Basic auth. SMS and WhatsApp share the call; WhatsApp prefixes both the configured `from` (env already carries `whatsapp:`) and the `to` with `whatsapp:`. Returns the message SID. Dry-run (or missing creds / `from`) returns a synthetic id without calling fetch.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendViaTwilio } from "./twilio";

const CFG = {
  accountSid: "ACtest", authToken: "tok",
  smsFrom: "+441234567890", whatsappFrom: "whatsapp:+441234567890",
};

beforeEach(() => { delete process.env.MESSAGING_DRY_RUN; });
afterEach(() => { vi.restoreAllMocks(); });

describe("sendViaTwilio", () => {
  it("posts an SMS with Basic auth and returns the SID", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, status: 201,
      json: async () => ({ sid: "SM123", status: "queued" }),
      text: async () => "",
    });
    const r = await sendViaTwilio(
      { channel: "sms", to: "+447700900010", body: "Hi" },
      { ...CFG, fetchImpl },
    );
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain("/Accounts/ACtest/Messages.json");
    expect((init.headers as Record<string, string>)["Authorization"]).toMatch(/^Basic /);
    const body = String(init.body);
    expect(body).toContain("To=%2B447700900010");
    expect(body).toContain("From=%2B441234567890");
    expect(r).toEqual({ providerMessageId: "SM123", provider: "twilio", status: "queued" });
  });

  it("prefixes whatsapp: on both from and to", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, status: 201, json: async () => ({ sid: "SMwa", status: "queued" }), text: async () => "",
    });
    await sendViaTwilio({ channel: "whatsapp", to: "+447700900010", body: "Hi" }, { ...CFG, fetchImpl });
    const body = String(fetchImpl.mock.calls[0][1].body);
    expect(body).toContain("To=whatsapp%3A%2B447700900010");
    expect(body).toContain("From=whatsapp%3A%2B441234567890");
  });

  it("throws MessagingError on non-2xx", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}), text: async () => "bad" });
    await expect(
      sendViaTwilio({ channel: "sms", to: "+1", body: "x" }, { ...CFG, fetchImpl }),
    ).rejects.toThrow(/twilio 401/);
  });

  it("is a no-op in dry-run mode", async () => {
    process.env.MESSAGING_DRY_RUN = "true";
    const fetchImpl = vi.fn();
    const r = await sendViaTwilio({ channel: "sms", to: "+1", body: "x" }, { ...CFG, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.provider).toBe("dry-run");
  });
});
```

- [ ] **Step 2: Run, verify FAIL** — `npx vitest run src/lib/messaging/providers/twilio.test.ts`

- [ ] **Step 3: Implement**

```ts
import { MessagingError, isDryRun, type OutboundMessage, type SendResult } from "../types";

type FetchImpl = typeof fetch;

export interface TwilioConfig {
  accountSid?: string;
  authToken?: string;
  smsFrom?: string;
  whatsappFrom?: string;
  fetchImpl?: FetchImpl;
}

function envConfig(): TwilioConfig {
  return {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    smsFrom: process.env.TWILIO_SMS_FROM,
    whatsappFrom: process.env.TWILIO_WHATSAPP_FROM,
  };
}

export async function sendViaTwilio(
  msg: OutboundMessage,
  cfg: TwilioConfig = envConfig(),
): Promise<SendResult> {
  const from = msg.channel === "whatsapp" ? cfg.whatsappFrom : cfg.smsFrom;
  if (isDryRun() || !cfg.accountSid || !cfg.authToken || !from) {
    return { providerMessageId: `dry-${msg.channel}-${Date.now()}`, provider: "dry-run", status: "dry_run" };
  }
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const to = msg.channel === "whatsapp" ? `whatsapp:${msg.to}` : msg.to;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`;
  const params = new URLSearchParams({ From: from, To: to, Body: msg.body });
  if (msg.statusCallbackUrl) params.set("StatusCallback", msg.statusCallbackUrl);
  const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64");
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  if (!res.ok) throw new MessagingError("twilio", res.status, await res.text());
  const data = (await res.json()) as { sid: string; status: string };
  return { providerMessageId: data.sid, provider: "twilio", status: data.status };
}
```

- [ ] **Step 4: Run, verify PASS** — `npx vitest run src/lib/messaging/providers/twilio.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/lib/messaging/providers/twilio.ts src/lib/messaging/providers/twilio.test.ts
git commit -m "feat: twilio sms + whatsapp provider (dry-run safe)"
```

---

## Task 5: Resend provider (email, mocked-fetch TDD)

**Files:**
- Create: `src/lib/messaging/providers/resend.ts`
- Test: `src/lib/messaging/providers/resend.test.ts`

`sendViaResend` posts to Resend's email API with Bearer auth, using `RESEND_FROM` and a subject (message `subject` else `RESEND_SUBJECT` else a default). Dry-run / missing creds returns a synthetic id.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendViaResend } from "./resend";

const CFG = { apiKey: "re_test", from: "Vitality <hi@vitality.test>", subject: "Hello" };

beforeEach(() => { delete process.env.MESSAGING_DRY_RUN; });
afterEach(() => { vi.restoreAllMocks(); });

describe("sendViaResend", () => {
  it("posts an email with Bearer auth and returns the id", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "em123" }), text: async () => "" });
    const r = await sendViaResend(
      { channel: "email", to: "a@b.test", body: "Hi there", subject: "Your treatment" },
      { ...CFG, fetchImpl },
    );
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain("api.resend.com/emails");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer re_test");
    const payload = JSON.parse(String(init.body));
    expect(payload.to).toBe("a@b.test");
    expect(payload.from).toBe(CFG.from);
    expect(payload.subject).toBe("Your treatment");
    expect(payload.text).toBe("Hi there");
    expect(r).toEqual({ providerMessageId: "em123", provider: "resend", status: "sent" });
  });

  it("falls back to the configured subject when none is supplied", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "em2" }), text: async () => "" });
    await sendViaResend({ channel: "email", to: "a@b.test", body: "Hi" }, { ...CFG, fetchImpl });
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1].body)).subject).toBe("Hello");
  });

  it("throws MessagingError on non-2xx", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 422, json: async () => ({}), text: async () => "bad" });
    await expect(sendViaResend({ channel: "email", to: "a@b.test", body: "x" }, { ...CFG, fetchImpl })).rejects.toThrow(/resend 422/);
  });

  it("is a no-op in dry-run mode", async () => {
    process.env.MESSAGING_DRY_RUN = "true";
    const fetchImpl = vi.fn();
    const r = await sendViaResend({ channel: "email", to: "a@b.test", body: "x" }, { ...CFG, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.provider).toBe("dry-run");
  });
});
```

- [ ] **Step 2: Run, verify FAIL** — `npx vitest run src/lib/messaging/providers/resend.test.ts`

- [ ] **Step 3: Implement**

```ts
import { MessagingError, isDryRun, type OutboundMessage, type SendResult } from "../types";

type FetchImpl = typeof fetch;

export interface ResendConfig {
  apiKey?: string;
  from?: string;
  subject?: string;
  fetchImpl?: FetchImpl;
}

function envConfig(): ResendConfig {
  return {
    apiKey: process.env.RESEND_API_KEY,
    from: process.env.RESEND_FROM,
    subject: process.env.RESEND_SUBJECT ?? "A note from Vitality Dental",
  };
}

export async function sendViaResend(
  msg: OutboundMessage,
  cfg: ResendConfig = envConfig(),
): Promise<SendResult> {
  if (isDryRun() || !cfg.apiKey || !cfg.from) {
    return { providerMessageId: `dry-email-${Date.now()}`, provider: "dry-run", status: "dry_run" };
  }
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const res = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: cfg.from,
      to: msg.to,
      subject: msg.subject ?? cfg.subject ?? "A note from Vitality Dental",
      text: msg.body,
    }),
  });
  if (!res.ok) throw new MessagingError("resend", res.status, await res.text());
  const data = (await res.json()) as { id: string };
  return { providerMessageId: data.id, provider: "resend", status: "sent" };
}
```

- [ ] **Step 4: Run, verify PASS** — `npx vitest run src/lib/messaging/providers/resend.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/lib/messaging/providers/resend.ts src/lib/messaging/providers/resend.test.ts
git commit -m "feat: resend email provider (dry-run safe)"
```

---

## Task 6: Channel dispatcher (TDD)

**Files:**
- Create: `src/lib/messaging/send.ts`
- Test: `src/lib/messaging/send.test.ts`

`sendMessage` routes by channel: sms/whatsapp -> Twilio, email -> Resend. Tested in dry-run mode (no creds needed), asserting each channel returns a result and email is tagged distinctly via the dry id prefix.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { sendMessage } from "./send";

beforeEach(() => { process.env.MESSAGING_DRY_RUN = "true"; });

describe("sendMessage", () => {
  it("routes sms and whatsapp through the dry-run path", async () => {
    const sms = await sendMessage({ channel: "sms", to: "+1", body: "x" });
    const wa = await sendMessage({ channel: "whatsapp", to: "+1", body: "x" });
    expect(sms.providerMessageId).toMatch(/^dry-sms-/);
    expect(wa.providerMessageId).toMatch(/^dry-whatsapp-/);
  });

  it("routes email through the resend dry-run path", async () => {
    const em = await sendMessage({ channel: "email", to: "a@b.test", body: "x" });
    expect(em.providerMessageId).toMatch(/^dry-email-/);
  });
});
```

- [ ] **Step 2: Run, verify FAIL** — `npx vitest run src/lib/messaging/send.test.ts`

- [ ] **Step 3: Implement**

```ts
import type { OutboundMessage, SendResult } from "./types";
import { sendViaTwilio } from "./providers/twilio";
import { sendViaResend } from "./providers/resend";

export async function sendMessage(msg: OutboundMessage): Promise<SendResult> {
  switch (msg.channel) {
    case "sms":
    case "whatsapp":
      return sendViaTwilio(msg);
    case "email":
      return sendViaResend(msg);
  }
}
```

- [ ] **Step 4: Run, verify PASS** — `npx vitest run src/lib/messaging/send.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/lib/messaging/send.ts src/lib/messaging/send.test.ts
git commit -m "feat: channel-routing message dispatcher"
```

---

## Task 7: Recipient resolution (TDD)

**Files:**
- Create: `src/lib/messaging/resolve.ts`
- Test: `src/lib/messaging/resolve.test.ts`

Resolves an outbox `to_ref` (`patient:<id>`) to a phone (sms/whatsapp) or email (email) by reading the patient from Dentally. Pure helpers `parsePatientRef` and `recipientFromPatient` are unit-tested; `resolveRecipient` is tested with a stub client.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { parsePatientRef, recipientFromPatient, resolveRecipient } from "./resolve";

describe("parsePatientRef", () => {
  it("extracts the patient id", () => {
    expect(parsePatientRef("patient:pat-010")).toBe("pat-010");
  });
  it("returns null for an unknown ref shape", () => {
    expect(parsePatientRef("site:123")).toBeNull();
  });
});

describe("recipientFromPatient", () => {
  const p = { mobile_phone: "+447700900010", email_address: "a@b.test" };
  it("uses mobile for sms and whatsapp", () => {
    expect(recipientFromPatient(p, "sms")).toBe("+447700900010");
    expect(recipientFromPatient(p, "whatsapp")).toBe("+447700900010");
  });
  it("uses email for email", () => {
    expect(recipientFromPatient(p, "email")).toBe("a@b.test");
  });
  it("returns null when the field is missing", () => {
    expect(recipientFromPatient({}, "sms")).toBeNull();
  });
});

describe("resolveRecipient", () => {
  it("fetches the patient and returns the phone for sms", async () => {
    const client = { getPatient: async (id: string) => ({ patient: { id, mobile_phone: "+447700900010", email_address: "a@b.test" } }) };
    const r = await resolveRecipient("patient:pat-010", "sms", client as never);
    expect(r).toBe("+447700900010");
  });
  it("returns null for a bad ref without calling the client", async () => {
    let called = false;
    const client = { getPatient: async () => { called = true; return { patient: {} }; } };
    const r = await resolveRecipient("nope", "sms", client as never);
    expect(r).toBeNull();
    expect(called).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify FAIL** — `npx vitest run src/lib/messaging/resolve.test.ts`

- [ ] **Step 3: Implement**

```ts
import type { DentallyClient } from "@/lib/dentally/client";
import type { MessageChannel } from "./types";

export interface PatientContact {
  mobile_phone?: string;
  email_address?: string;
}

export function parsePatientRef(toRef: string): string | null {
  const m = /^patient:(.+)$/.exec(toRef);
  return m ? m[1] : null;
}

export function recipientFromPatient(p: PatientContact, channel: MessageChannel): string | null {
  if (channel === "email") return p.email_address ?? null;
  return p.mobile_phone ?? null; // sms + whatsapp
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function pickString(o: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string") return v;
  }
  return undefined;
}

export async function resolveRecipient(
  toRef: string,
  channel: MessageChannel,
  client: Pick<DentallyClient, "getPatient">,
): Promise<string | null> {
  const id = parsePatientRef(toRef);
  if (!id) return null;
  const res = await client.getPatient(id);
  const p = asRecord((res as { patient?: unknown }).patient);
  return recipientFromPatient(
    {
      mobile_phone: pickString(p, "mobile_phone", "mobilePhone", "phone"),
      email_address: pickString(p, "email_address", "emailAddress", "email"),
    },
    channel,
  );
}
```

- [ ] **Step 4: Run, verify PASS** — `npx vitest run src/lib/messaging/resolve.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/lib/messaging/resolve.ts src/lib/messaging/resolve.test.ts
git commit -m "feat: outbox recipient resolution from dentally"
```

---

## Task 8: Suppression (TDD for keyword; repo for storage)

**Files:**
- Create: `src/lib/messaging/suppression.ts`
- Test: `src/lib/messaging/suppression.test.ts`

`isStopKeyword` is a pure, unit-tested keyword check. `isSuppressed`/`addSuppression` use `serviceClient()` over `message_suppression` (not unit-tested; exercised in the drain/webhook integration steps).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { isStopKeyword } from "./suppression";

describe("isStopKeyword", () => {
  it("matches the opt-out keywords case-insensitively and trimmed", () => {
    for (const w of ["STOP", "stop", " Stop ", "UNSUBSCRIBE", "cancel", "END", "quit", "stopall"]) {
      expect(isStopKeyword(w)).toBe(true);
    }
  });
  it("does not match normal replies", () => {
    for (const w of ["yes please", "stop by tomorrow", "ok", ""]) {
      expect(isStopKeyword(w)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run, verify FAIL** — `npx vitest run src/lib/messaging/suppression.test.ts`

- [ ] **Step 3: Implement**

```ts
import { serviceClient } from "@/lib/supabase/server";
import type { MessageChannel } from "./types";

const STOP_KEYWORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);

export function isStopKeyword(body: string): boolean {
  return STOP_KEYWORDS.has(body.trim().toLowerCase());
}

export async function isSuppressed(siteId: string, channel: MessageChannel, toRef: string): Promise<boolean> {
  const db = serviceClient();
  const { data, error } = await db
    .from("message_suppression")
    .select("id")
    .eq("site_id", siteId)
    .eq("channel", channel)
    .eq("to_ref", toRef)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export async function addSuppression(
  siteId: string,
  channel: MessageChannel,
  toRef: string,
  reason = "stop",
): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("message_suppression")
    .upsert({ site_id: siteId, channel, to_ref: toRef, reason }, { onConflict: "site_id,channel,to_ref" });
  if (error) throw error;
}
```

- [ ] **Step 4: Run, verify PASS** — `npx vitest run src/lib/messaging/suppression.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/lib/messaging/suppression.ts src/lib/messaging/suppression.test.ts
git commit -m "feat: opt-out suppression (stop keywords + store)"
```

---

## Task 9: Outbox repository functions

**Files:**
- Modify: `src/lib/reactivation/repository.ts`

Add the functions the drain and the webhooks need. Keep the existing row mappers; these return the lean fields each caller uses.

- [ ] **Step 1: Append these functions to `src/lib/reactivation/repository.ts`** (after the existing outbox/touch functions). They use the existing `serviceClient` import.

```ts
// ---------------------------------------------------------------------------
// Outbox drain + inbound correlation (messaging layer).
// ---------------------------------------------------------------------------

export interface QueuedOutbox {
  id: string;
  touchId: string;
  siteId: string;
  channel: TouchChannel;
  toRef: string;
  body: string;
}

export async function listQueuedOutbox(siteIds: string[]): Promise<QueuedOutbox[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("reactivation_outbox")
    .select("id, touch_id, site_id, channel, to_ref, body")
    .in("site_id", siteIds)
    .eq("status", "queued")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data as Array<{
    id: string; touch_id: string; site_id: string; channel: string; to_ref: string; body: string;
  }>).map((r) => ({
    id: r.id, touchId: r.touch_id, siteId: r.site_id, channel: r.channel as TouchChannel, toRef: r.to_ref, body: r.body,
  }));
}

export async function recordOutboxSent(
  outboxId: string,
  touchId: string,
  fields: { provider: string; providerMessageId: string; toAddress: string },
): Promise<void> {
  const db = serviceClient();
  const nowIso = new Date().toISOString();
  const { error: oErr } = await db
    .from("reactivation_outbox")
    .update({
      status: "sent",
      provider: fields.provider,
      provider_message_id: fields.providerMessageId,
      to_address: fields.toAddress,
      sent_at: nowIso,
    })
    .eq("id", outboxId);
  if (oErr) throw oErr;
  const { error: tErr } = await db
    .from("reactivation_touch")
    .update({ status: "sent", sent_at: nowIso })
    .eq("id", touchId);
  if (tErr) throw tErr;
}

export async function markOutboxFailed(outboxId: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("reactivation_outbox").update({ status: "failed" }).eq("id", outboxId);
  if (error) throw error;
}

export async function markOutboxBlocked(outboxId: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("reactivation_outbox").update({ status: "failed", provider: "suppressed" }).eq("id", outboxId);
  if (error) throw error;
}

export async function updateOutboxStatusByMessageId(providerMessageId: string, status: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("reactivation_outbox")
    .update({ status })
    .eq("provider_message_id", providerMessageId);
  if (error) throw error;
}

/** Find the most recent outbound row sent to an address, with its target (via the touch). */
export async function findTargetByAddress(
  toAddress: string,
): Promise<{ targetId: string; siteId: string } | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("reactivation_outbox")
    .select("touch_id, site_id")
    .eq("to_address", toAddress)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as { touch_id: string; site_id: string };
  const { data: touch, error: tErr } = await db
    .from("reactivation_touch")
    .select("target_id")
    .eq("id", row.touch_id)
    .maybeSingle();
  if (tErr) throw tErr;
  if (!touch) return null;
  return { targetId: (touch as { target_id: string }).target_id, siteId: row.site_id };
}

export async function insertInboundTouch(input: {
  targetId: string;
  cadenceId: string | null;
  siteId: string;
  channel: TouchChannel;
  body: string;
}): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("reactivation_touch").insert({
    target_id: input.targetId,
    cadence_id: input.cadenceId,
    site_id: input.siteId,
    channel: input.channel,
    direction: "inbound",
    body: input.body,
    drafted_by: "human",
    status: "sent",
  });
  if (error) throw error;
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/lib/reactivation/repository.ts
git commit -m "feat: outbox drain + inbound correlation repository functions"
```

---

## Task 10: Drain worker route + dry-run integration test

**Files:**
- Create: `src/app/api/messaging/drain/route.ts`

The drain reads queued `reactivation_outbox` rows for the vitality sites, resolves each recipient from Dentally, checks suppression, sends, and records the result. `CRON_SECRET`-gated. With `MESSAGING_DRY_RUN=true`, the providers no-op but the row still advances to `sent` with the synthetic id and a `to_address` — that is the integration check.

- [ ] **Step 1: Implement the route**

```ts
import { DentallyClient } from "@/lib/dentally/client";
import { sendMessage } from "@/lib/messaging/send";
import { resolveRecipient } from "@/lib/messaging/resolve";
import { isSuppressed } from "@/lib/messaging/suppression";
import type { MessageChannel } from "@/lib/messaging/types";
import {
  listQueuedOutbox,
  recordOutboxSent,
  markOutboxFailed,
  markOutboxBlocked,
} from "@/lib/reactivation/repository";
import { SITES } from "@/lib/mock/clients";

export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // unset in local dev
  const header = request.headers.get("authorization");
  return header === `Bearer ${secret}`;
}

function vitalitySiteIds(): string[] {
  return SITES.filter((s) => s.clientId === "vitality").map((s) => s.id);
}

export async function POST(request: Request): Promise<Response> {
  if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const apiKey = process.env.DENTALLY_API_KEY;
  if (!apiKey) return Response.json({ error: "DENTALLY_API_KEY not set" }, { status: 503 });
  const client = new DentallyClient({ apiKey, baseUrl: process.env.DENTALLY_BASE_URL ?? "https://api.dentally.co" });

  const base = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
  const statusCallbackUrl = `${base}/api/webhooks/twilio/status`;

  const rows = await listQueuedOutbox(vitalitySiteIds());
  let sent = 0, failed = 0, blocked = 0;

  for (const row of rows) {
    const channel = row.channel as MessageChannel;
    try {
      const to = await resolveRecipient(row.toRef, channel, client);
      if (!to) { await markOutboxFailed(row.id); failed += 1; continue; }
      if (await isSuppressed(row.siteId, channel, row.toRef)) { await markOutboxBlocked(row.id); blocked += 1; continue; }

      const result = await sendMessage({
        channel,
        to,
        body: row.body,
        statusCallbackUrl: channel === "email" ? undefined : statusCallbackUrl,
      });
      await recordOutboxSent(row.id, row.touchId, {
        provider: result.provider,
        providerMessageId: result.providerMessageId,
        toAddress: to,
      });
      sent += 1;
    } catch {
      await markOutboxFailed(row.id);
      failed += 1;
    }
  }

  return Response.json({ ok: true, drained: rows.length, sent, failed, blocked });
}
```

- [ ] **Step 2: Dry-run integration check.** Ensure `MESSAGING_DRY_RUN=true` and `DENTALLY_BASE_URL` points at the mock. Seed one queued outbox row for a real dormant target (via the reactivation action route or SQL): enrol + draft + approve on `site-cc:pat-010` so a `reactivation_outbox` row exists with `status='queued'`. Then `curl -s -X POST http://localhost:3000/api/messaging/drain`. Expect `{ ok:true, drained:1, sent:1, ... }`; verify via Supabase MCP that the row is now `status='sent'`, `provider='dry-run'`, `to_address='+447700900010'` (pat-010's mobile), and the linked touch is `sent`. Then clean up the seeded rows.

Run: `curl -s -X POST http://localhost:3000/api/messaging/drain`
Expected: `{ "ok": true, "drained": <n>, "sent": <n>, "failed": 0, "blocked": 0 }`

- [ ] **Step 3: Typecheck + build, then commit**

```bash
npx tsc --noEmit && npm run build
git add src/app/api/messaging/drain/
git commit -m "feat: outbox drain worker (resolve, suppress, send)"
```

---

## PHASE B — Webhooks

## Task 11: Twilio signature verification (TDD)

**Files:**
- Create: `src/lib/messaging/signature.ts`
- Test: `src/lib/messaging/signature.test.ts`

Twilio signs each webhook: `base64(HMAC-SHA1(authToken, url + concat(sortedKey + value)))`. We recompute and constant-compare.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { computeTwilioSignature, verifyTwilioSignature } from "./signature";

// Canonical example from Twilio's docs.
const URL = "https://mycompany.com/myapp.php?foo=1&bar=2";
const PARAMS = { Caller: "+14158675309", Digits: "1234", From: "+14158675309", To: "+18005551212" };
const TOKEN = "12345";
// Canonical value from Twilio's request-validation docs. If this exact string
// is not the one Twilio documents for this URL+params+token, copy the current
// documented value verbatim — do NOT relax the assertion to match your code.
const EXPECTED = "RSOYDt4T1cUTdK1PDd93/VVr8B8=";

describe("twilio signature", () => {
  it("computes the documented signature", () => {
    expect(computeTwilioSignature(URL, PARAMS, TOKEN)).toBe(EXPECTED);
  });
  it("verifies a valid signature and rejects a tampered one", () => {
    expect(verifyTwilioSignature(URL, PARAMS, EXPECTED, TOKEN)).toBe(true);
    expect(verifyTwilioSignature(URL, PARAMS, "wrong", TOKEN)).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify FAIL** — `npx vitest run src/lib/messaging/signature.test.ts`

- [ ] **Step 3: Implement**

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function computeTwilioSignature(
  url: string,
  params: Record<string, string>,
  authToken: string,
): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
}

export function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  header: string,
  authToken: string,
): boolean {
  const expected = computeTwilioSignature(url, params, authToken);
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

- [ ] **Step 4: Run, verify PASS.** If the documented vector differs from your implementation, recompute `EXPECTED` from a Twilio reference and keep the assertion exact (do not relax the test).

- [ ] **Step 5: Commit**

```bash
git add src/lib/messaging/signature.ts src/lib/messaging/signature.test.ts
git commit -m "feat: twilio webhook signature verification"
```

---

## Task 12: Delivery-status webhook

**Files:**
- Create: `src/app/api/webhooks/twilio/status/route.ts`

Twilio POSTs form-encoded `MessageSid` + `MessageStatus`. We validate the signature (when a token is set), map the Twilio status to our outbox status, and update the row by `provider_message_id`.

- [ ] **Step 1: Implement the route**

```ts
import { verifyTwilioSignature } from "@/lib/messaging/signature";
import { updateOutboxStatusByMessageId } from "@/lib/reactivation/repository";

export const dynamic = "force-dynamic";

function publicUrl(path: string): string {
  return `${process.env.PUBLIC_BASE_URL ?? "http://localhost:3000"}${path}`;
}

export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) params[k] = String(v);

  const token = process.env.TWILIO_AUTH_TOKEN;
  if (token) {
    const sig = request.headers.get("x-twilio-signature") ?? "";
    if (!verifyTwilioSignature(publicUrl("/api/webhooks/twilio/status"), params, sig, token)) {
      return Response.json({ error: "bad signature" }, { status: 403 });
    }
  }

  const sid = params["MessageSid"];
  const status = params["MessageStatus"]; // queued|sent|delivered|undelivered|failed
  if (sid && status) {
    const mapped = status === "delivered" ? "delivered" : status === "undelivered" || status === "failed" ? "failed" : "sent";
    await updateOutboxStatusByMessageId(sid, mapped);
  }
  return new Response(null, { status: 204 });
}
```

- [ ] **Step 2: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean; `/api/webhooks/twilio/status` present.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/webhooks/twilio/status/
git commit -m "feat: twilio delivery-status webhook"
```

---

## Task 13: Inbound-reply webhook (auto-pause + STOP)

**Files:**
- Create: `src/app/api/webhooks/twilio/inbound/route.ts`

Twilio POSTs form-encoded `From` (the patient), `Body`, and (for WhatsApp) a `whatsapp:`-prefixed `From`. We validate the signature, strip any `whatsapp:` prefix, find the target by the most recent outbound `to_address`, log an inbound touch, pause the active cadence, and suppress on STOP.

- [ ] **Step 1: Implement the route**

```ts
import { verifyTwilioSignature } from "@/lib/messaging/signature";
import { isStopKeyword, addSuppression } from "@/lib/messaging/suppression";
import type { MessageChannel } from "@/lib/messaging/types";
import {
  findTargetByAddress,
  insertInboundTouch,
  getCadenceByTarget,
  updateCadence,
} from "@/lib/reactivation/repository";

export const dynamic = "force-dynamic";

function publicUrl(path: string): string {
  return `${process.env.PUBLIC_BASE_URL ?? "http://localhost:3000"}${path}`;
}

export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) params[k] = String(v);

  const token = process.env.TWILIO_AUTH_TOKEN;
  if (token) {
    const sig = request.headers.get("x-twilio-signature") ?? "";
    if (!verifyTwilioSignature(publicUrl("/api/webhooks/twilio/inbound"), params, sig, token)) {
      return Response.json({ error: "bad signature" }, { status: 403 });
    }
  }

  const rawFrom = params["From"] ?? "";
  const isWhatsapp = rawFrom.startsWith("whatsapp:");
  const channel: MessageChannel = isWhatsapp ? "whatsapp" : "sms";
  const from = rawFrom.replace(/^whatsapp:/, "");
  const body = params["Body"] ?? "";

  const match = await findTargetByAddress(from);
  if (match) {
    const cadence = await getCadenceByTarget(match.targetId);
    await insertInboundTouch({
      targetId: match.targetId,
      cadenceId: cadence?.id ?? null,
      siteId: match.siteId,
      channel,
      body,
    });
    if (cadence && cadence.status === "active") {
      await updateCadence(cadence.id, { status: "paused" });
    }
    if (isStopKeyword(body)) {
      await addSuppression(match.siteId, channel, `patient:${match.targetId.split(":")[1]}`, "stop");
    }
  }

  // Empty TwiML so Twilio does not send an auto-reply.
  return new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}
```

Note on the STOP suppression key: the outbox `to_ref` is `patient:<dentallyPatientId>`, and a target id is `<siteId>:<dentallyPatientId>`, so `targetId.split(":")[1]` recovers the patient id to build the same `to_ref` the drain checks. Keep these two derivations consistent.

- [ ] **Step 2: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean; `/api/webhooks/twilio/inbound` present.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/webhooks/twilio/inbound/
git commit -m "feat: twilio inbound-reply webhook (auto-pause + STOP)"
```

---

## PHASE C — Scheduling + go-live

## Task 14: Vercel Cron + cron-secret gating

**Files:**
- Create: `vercel.json`
- Modify: `src/app/api/reactivation/sweep/route.ts` (add the same `CRON_SECRET` gate as the drain)

- [ ] **Step 1: Create `vercel.json`**

```json
{
  "crons": [
    { "path": "/api/reactivation/sweep", "schedule": "*/10 * * * *" },
    { "path": "/api/messaging/drain", "schedule": "*/5 * * * *" }
  ]
}
```

- [ ] **Step 2: Gate the sweep** — in `src/app/api/reactivation/sweep/route.ts`, add the same `authorized(request)` helper used by the drain (read `CRON_SECRET`; allow if unset; else require `Authorization: Bearer <secret>`), and change `export async function POST()` to `export async function POST(request: Request)` returning 401 when not authorized. (Vercel Cron sends the secret automatically; manual local calls with the secret unset still work.)

```ts
function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}
```

- [ ] **Step 3: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean. Confirm both cron paths exist as routes.

- [ ] **Step 4: Commit**

```bash
git add vercel.json src/app/api/reactivation/sweep/route.ts
git commit -m "feat: vercel cron for sweep + drain, cron-secret gating"
```

---

## Task 15: Full test + go-live calibration

- [ ] **Step 1: Run all unit tests**

Run: `npx vitest run`
Expected: all suites pass (messaging providers, dispatcher, resolve, suppression, signature, plus existing reactivation/dentally suites).

- [ ] **Step 2: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean; routes present: `/api/messaging/drain`, `/api/webhooks/twilio/status`, `/api/webhooks/twilio/inbound`.

- [ ] **Step 3: Live SMS calibration (when the Twilio key arrives).** In `.env.local` set `TWILIO_ACCOUNT_SID/AUTH_TOKEN/SMS_FROM`, `PUBLIC_BASE_URL` (a public tunnel for webhooks, e.g. an ngrok URL), and `MESSAGING_DRY_RUN=false`. Temporarily point one dormant target's `mobile_phone` at a test handset (in the mock fixtures), enrol + draft + approve to enqueue, then `curl -X POST .../api/messaging/drain`. Confirm: a real SMS arrives; the outbox row is `sent` with a real `SM...` id; Twilio's status callback flips it to `delivered`; replying a normal message pauses the cadence and logs an inbound touch; replying `STOP` adds a suppression row and a subsequent drain marks that recipient `blocked`. Revert `MESSAGING_DRY_RUN=true` afterwards.

- [ ] **Step 4: Confirm spec acceptance** against `docs/superpowers/specs/2026-06-19-messaging-delivery-design.md`: outbound on all three channels (live per available creds, dry-run otherwise); recipient resolved from Dentally at send time; suppression checked before send; delivery status tracked; inbound replies pause the cadence and STOP suppresses; cron triggers sweep + drain; no clinical data stored; no new npm deps.

- [ ] **Step 5: Final commit (if anything outstanding)**

```bash
git add -A
git commit -m "test: messaging delivery verification pass"
```

---

## Notes for the implementer

- WhatsApp and email go live only once their own credentials exist (a WhatsApp-enabled Twilio sender + approved templates; a Resend key + verified domain). Until then the dry-run guard returns synthetic ids so the pipeline still runs end to end. SMS is the first live channel.
- Opt-out is local only (read-only Dentally key). When a read+write key lands, also write `use_sms=false` back to Dentally on STOP — out of scope here.
- Never commit `.env.local`. `site_id` on every row and query. Respect suppression before every send.
- The Treatment Coordinator can adopt this layer later by pointing a TC drain at `outbox` with the same functions; not in scope here.
- A concurrent session works other files (owner/overview/practice-brain) via separate worktrees — stage only the files each task lists; never `git add -A` except the final verification step on a clean tree.
