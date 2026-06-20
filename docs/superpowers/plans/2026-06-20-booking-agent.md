# Conversational Booking Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a patient replies to outreach, an autonomous Claude agent holds the conversation, proposes real diary slots, books them into Dentally, quotes pricing only from a config, and escalates to a human when needed.

**Architecture:** A turn-based Claude tool-use agent in `src/lib/agent/`. The inbound Twilio webhook routes each reply to `runAgentTurn`, which loads the conversation thread, calls Claude with a guardrailed system prompt and a small tool set (find_slots / book / escalate, then get_pricing / reschedule / cancel in later phases), executes tool calls against `DentallyClient` and a pricing config, sends the reply via the messaging layer, and persists the turn to Supabase. All external dependencies (Claude, Dentally, repo) are injected so every unit is testable.

**Tech Stack:** Next.js 16, TypeScript strict, `@anthropic-ai/sdk` (tool use, model `claude-sonnet-4-6`), `@supabase/supabase-js`, Vitest. Reuses the messaging layer, `DentallyClient`, and the inbound webhook. No new npm dependencies.

Spec: `docs/superpowers/specs/2026-06-20-booking-agent-design.md`

---

## File structure (created/modified)

- Create `supabase/migrations/0006_booking_agent.sql` — `agent_conversation` + `agent_message` + pilot RLS.
- Create `src/lib/agent/types.ts` — domain types + `ConversationStatus`.
- Create `src/lib/agent/tools.ts` — tool definitions (`AGENT_TOOLS`) + `makeDispatch`.
- Create `src/lib/agent/prompt.ts` — `buildSystemPrompt` (role + guardrails + context).
- Create `src/lib/agent/run.ts` — `runAgentTurn` (the Claude tool-use loop).
- Create `src/lib/agent/repository.ts` — conversation/message persistence.
- Modify `src/lib/dentally/client.ts` — add `getAvailability` (Phase 1); appointment edit/cancel (Phase 3).
- Create `src/app/api/mock-dentally/v1/appointments/availability/route.ts` — mock open slots.
- Modify `src/app/api/webhooks/twilio/inbound/route.ts` — route replies to the agent.
- Create `src/lib/pricing/config.ts` — pricing/USP source of truth (Phase 2).
- Test files alongside each pure unit.

No clinical fields anywhere. The agent's external deps are injected.

---

# PHASE 1 — Core conversation + booking

## Task 1: Schema migration

**Files:**
- Create: `supabase/migrations/0006_booking_agent.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0006_booking_agent.sql
-- Conversational booking agent state. Ops-only, no clinical data.

create table if not exists agent_conversation (
  id uuid primary key default gen_random_uuid(),
  site_id text not null,
  dentally_patient_id text not null,
  patient_name text not null,
  channel text not null default 'sms',
  status text not null default 'active',          -- active | needs_human | booked | closed
  treatment text,
  funding_type text,                              -- nhs | private | null
  last_inbound_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_agent_conv_patient on agent_conversation (site_id, dentally_patient_id, channel);

create table if not exists agent_message (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references agent_conversation (id) on delete cascade,
  role text not null,                             -- patient | agent | system | tool
  body text not null,
  tool_name text,
  created_at timestamptz not null default now()
);
create index if not exists idx_agent_msg_conv on agent_message (conversation_id, created_at);

alter table agent_conversation enable row level security;
alter table agent_message enable row level security;

-- PILOT permissive RLS (mirrors prior migrations; replace before real data).
grant all on agent_conversation, agent_message to anon, authenticated;
create policy pilot_all_agent_conv on agent_conversation for all to anon, authenticated using (true) with check (true);
create policy pilot_all_agent_msg on agent_message for all to anon, authenticated using (true) with check (true);
```

- [ ] **Step 2: Apply** to Supabase project `qoiyaiiajdqydyrccixt` (MCP `apply_migration`, name `booking_agent`). Verify both tables exist.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0006_booking_agent.sql
git commit -m "feat: booking agent conversation schema (applied)"
```

---

## Task 2: Agent domain types

**Files:**
- Create: `src/lib/agent/types.ts`

- [ ] **Step 1: Write the types** (no test; consumed later)

```ts
export type ConversationStatus = "active" | "needs_human" | "booked" | "closed";
export type MessageRole = "patient" | "agent" | "system" | "tool";

export interface AgentConversation {
  id: string;
  siteId: string;
  dentallyPatientId: string;
  patientName: string;
  channel: string;
  status: ConversationStatus;
  treatment: string | null;
  fundingType: "nhs" | "private" | null;
  lastInboundAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentMessageRow {
  id: string;
  conversationId: string;
  role: MessageRole;
  body: string;
  toolName: string | null;
  createdAt: string;
}

/** Patient context handed to the agent for a turn. */
export interface AgentContext {
  patientId: string;
  siteId: string;
  patientName: string;
  treatment: string | null;
  fundingType: "nhs" | "private" | null;
}

export interface AgentTurnResult {
  replyText: string;
  toolCalls: { name: string; input: Record<string, unknown> }[];
  escalated: boolean;
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/lib/agent/types.ts
git commit -m "feat: booking agent domain types"
```

---

## Task 3: Dentally availability read + mock route

**Files:**
- Modify: `src/lib/dentally/client.ts`
- Test: `src/lib/dentally/client-availability.test.ts`
- Create: `src/app/api/mock-dentally/v1/appointments/availability/route.ts`

- [ ] **Step 1: Write the failing test** `src/lib/dentally/client-availability.test.ts`

```ts
import { describe, it, expect, vi } from "vitest";
import { DentallyClient } from "./client";

function mockFetch(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({ ok, status, json: async () => body, text: async () => JSON.stringify(body) });
}

describe("DentallyClient.getAvailability", () => {
  it("queries availability by site with auth + User-Agent", async () => {
    const fetchMock = mockFetch({ availability: [] });
    const c = new DentallyClient({ apiKey: "k", baseUrl: "https://api.sandbox.dentally.co", fetchImpl: fetchMock });
    await c.getAvailability({ siteId: "site-cc", fromDate: "2026-06-22", toDate: "2026-06-29" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/v1/appointments/availability");
    expect(String(url)).toContain("site_id=site-cc");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer k");
    expect((init.headers as Record<string, string>)["User-Agent"]).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run, verify FAIL** — `npx vitest run src/lib/dentally/client-availability.test.ts`

- [ ] **Step 3: Implement** — add to `src/lib/dentally/client.ts`. Add the args interface near `ListPatientsArgs`:

```ts
export interface AvailabilityArgs { siteId: string; fromDate?: string; toDate?: string; duration?: number; }
```

And add this method inside the `DentallyClient` class (next to `getPatientInvoices`):

```ts
  getAvailability(a: AvailabilityArgs) {
    return this.get<{ availability: unknown[] }>("/v1/appointments/availability", {
      site_id: a.siteId, start_date: a.fromDate, finish_date: a.toDate, duration: a.duration,
    });
  }
```

- [ ] **Step 4: Run, verify PASS** (new + existing client tests): `npx vitest run src/lib/dentally/client.test.ts src/lib/dentally/client-availability.test.ts`

- [ ] **Step 5: Create the mock route** `src/app/api/mock-dentally/v1/appointments/availability/route.ts`

```ts
import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";

export const dynamic = "force-dynamic";

// GET /api/mock-dentally/v1/appointments/availability?site_id=&start_date=&finish_date=
// Returns a few fixed open slots over the next several days (UTC, on the hour).
export async function GET(request: Request): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;
  const url = new URL(request.url);
  const siteId = url.searchParams.get("site_id") ?? "site-cc";
  const base = url.searchParams.get("start_date") ?? "2026-06-22";
  const day = (offset: number) => {
    const d = new Date(`${base}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  };
  const availability = [
    { start_time: `${day(0)}T09:00:00Z`, duration: 30, site_id: siteId },
    { start_time: `${day(0)}T15:30:00Z`, duration: 30, site_id: siteId },
    { start_time: `${day(1)}T11:00:00Z`, duration: 30, site_id: siteId },
    { start_time: `${day(3)}T17:00:00Z`, duration: 30, site_id: siteId },
  ];
  return Response.json({ availability });
}
```

- [ ] **Step 6: Build check + commit**

```bash
npx tsc --noEmit && npm run build
git add src/lib/dentally/client.ts src/lib/dentally/client-availability.test.ts src/app/api/mock-dentally/v1/appointments/availability/
git commit -m "feat: dentally availability read + mock slots route"
```

> Note: exact Dentally availability path/params are confirmed against the sandbox later; the mock matches the client's assumed shape so the agent works end to end now.

---

## Task 4: Tool definitions + dispatcher (TDD)

**Files:**
- Create: `src/lib/agent/tools.ts`
- Test: `src/lib/agent/tools.test.ts`

`AGENT_TOOLS` are the Claude tool schemas. `makeDispatch(deps)` returns an async `(name, input) -> Promise<string>` that runs a tool and returns its result as a JSON string. Deps (Dentally + the patient context) are injected.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { AGENT_TOOLS, makeDispatch } from "./tools";

describe("AGENT_TOOLS", () => {
  it("exposes find_slots, book and escalate_to_human", () => {
    expect(AGENT_TOOLS.map((t) => t.name).sort()).toEqual(["book", "escalate_to_human", "find_slots"]);
  });
});

describe("makeDispatch", () => {
  const context = { patientId: "pat-010", siteId: "site-cc", patientName: "Harold", treatment: "Invisalign", fundingType: "private" as const };

  it("find_slots returns the diary slots from Dentally", async () => {
    const dentally = {
      getAvailability: vi.fn().mockResolvedValue({ availability: [{ start_time: "2026-06-22T09:00:00Z" }] }),
      createAppointment: vi.fn(),
    };
    const dispatch = makeDispatch({ dentally: dentally as never, context });
    const out = await dispatch("find_slots", { treatment: "Invisalign" });
    expect(dentally.getAvailability).toHaveBeenCalledWith(expect.objectContaining({ siteId: "site-cc" }));
    expect(out).toContain("2026-06-22T09:00:00Z");
  });

  it("book calls createAppointment with booked_via_api and the patient/site", async () => {
    const dentally = {
      getAvailability: vi.fn(),
      createAppointment: vi.fn().mockResolvedValue({ appointment: { id: "appt-1" } }),
    };
    const dispatch = makeDispatch({ dentally: dentally as never, context });
    const out = await dispatch("book", { slotStart: "2026-06-22T09:00:00Z", treatment: "Invisalign" });
    const payload = dentally.createAppointment.mock.calls[0][0];
    expect(payload).toMatchObject({ patient_id: "pat-010", site_id: "site-cc", booked_via_api: true });
    expect(out).toContain("appt-1");
  });

  it("escalate_to_human acknowledges without external calls", async () => {
    const dispatch = makeDispatch({ dentally: { getAvailability: vi.fn(), createAppointment: vi.fn() } as never, context });
    const out = await dispatch("escalate_to_human", { reason: "clinical question" });
    expect(out).toContain("escalated");
  });

  it("returns an error string for an unknown tool", async () => {
    const dispatch = makeDispatch({ dentally: { getAvailability: vi.fn(), createAppointment: vi.fn() } as never, context });
    expect(await dispatch("nope", {})).toContain("unknown");
  });
});
```

- [ ] **Step 2: Run, verify FAIL** — `npx vitest run src/lib/agent/tools.test.ts`

- [ ] **Step 3: Implement** `src/lib/agent/tools.ts`

```ts
import type Anthropic from "@anthropic-ai/sdk";
import type { DentallyClient } from "@/lib/dentally/client";
import type { AgentContext } from "./types";

export const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: "find_slots",
    description:
      "Find open appointment slots for the patient's treatment at their site. Only ever offer slots this returns; never invent a time.",
    input_schema: {
      type: "object",
      properties: {
        treatment: { type: "string", description: "The treatment to book for" },
        fromDate: { type: "string", description: "ISO date to search from (optional)" },
        toDate: { type: "string", description: "ISO date to search to (optional)" },
      },
      required: ["treatment"],
    },
  },
  {
    name: "book",
    description:
      "Book a confirmed appointment. Only call after the patient has explicitly confirmed the date, time, site and treatment in the conversation.",
    input_schema: {
      type: "object",
      properties: {
        slotStart: { type: "string", description: "ISO datetime of the chosen slot, exactly as returned by find_slots" },
        treatment: { type: "string" },
      },
      required: ["slotStart", "treatment"],
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Hand the conversation to a human coordinator. Use for any clinical question, a complaint, an explicit request for a person, or anything you are unsure about.",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
    },
  },
];

export interface ToolDeps {
  dentally: Pick<DentallyClient, "getAvailability" | "createAppointment">;
  context: AgentContext;
}

export function makeDispatch(deps: ToolDeps) {
  return async function dispatch(name: string, input: Record<string, unknown>): Promise<string> {
    switch (name) {
      case "find_slots": {
        const res = await deps.dentally.getAvailability({
          siteId: deps.context.siteId,
          fromDate: typeof input.fromDate === "string" ? input.fromDate : undefined,
          toDate: typeof input.toDate === "string" ? input.toDate : undefined,
        });
        const slots = Array.isArray(res.availability) ? res.availability : [];
        return JSON.stringify({ slots });
      }
      case "book": {
        const { appointment } = await deps.dentally.createAppointment({
          patient_id: deps.context.patientId,
          site_id: deps.context.siteId,
          start_time: input.slotStart,
          treatment: input.treatment,
          booked_via_api: true,
        });
        return JSON.stringify({ booked: true, appointmentId: appointment.id });
      }
      case "escalate_to_human":
        return JSON.stringify({ escalated: true, reason: input.reason ?? "" });
      default:
        return JSON.stringify({ error: `unknown tool: ${name}` });
    }
  };
}
```

- [ ] **Step 4: Run, verify PASS** (all). `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/tools.ts src/lib/agent/tools.test.ts
git commit -m "feat: booking agent tools (find_slots, book, escalate) + dispatcher"
```

---

## Task 5: System prompt (TDD)

**Files:**
- Create: `src/lib/agent/prompt.ts`
- Test: `src/lib/agent/prompt.test.ts`

`buildSystemPrompt(context)` returns the agent's system string: role, the hard guardrails, and the patient context. Phase 2 extends it with pricing guidance.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "./prompt";

const ctx = { patientId: "pat-010", siteId: "site-cc", patientName: "Harold Pemberton", treatment: "Invisalign", fundingType: "private" as const };

describe("buildSystemPrompt", () => {
  it("includes the patient context and core guardrails, with no em-dash", () => {
    const s = buildSystemPrompt(ctx);
    expect(s).toContain("Harold Pemberton");
    expect(s).toContain("Invisalign");
    expect(s.toLowerCase()).toContain("no em-dash");
    expect(s.toLowerCase()).toContain("clinical");      // clinical-boundary clause
    expect(s.toLowerCase()).toContain("find_slots");    // never invent slots
    expect(s.toLowerCase()).toContain("confirm");       // confirm before booking
    expect(s).not.toContain("—");                   // no em-dash char
    expect(s).toContain("£");                            // GBP symbol present in money rule
  });
});
```

- [ ] **Step 2: Run, verify FAIL** — `npx vitest run src/lib/agent/prompt.test.ts`

- [ ] **Step 3: Implement** `src/lib/agent/prompt.ts`

```ts
import type { AgentContext } from "./types";

export function buildSystemPrompt(ctx: AgentContext): string {
  const funding = ctx.fundingType ? ` (${ctx.fundingType.toUpperCase()})` : "";
  return [
    "You are the booking assistant for Vitality Dental, a UK dental practice. You reply to patients by text.",
    "Your job: have a warm, natural conversation and get the patient booked in for the treatment they were interested in.",
    "",
    `Patient: ${ctx.patientName}.`,
    `Treatment of interest: ${ctx.treatment ?? "not specified"}${funding}.`,
    "",
    "Hard rules:",
    "- Never give clinical advice, a diagnosis, or an opinion on treatment suitability. If asked anything clinical, call escalate_to_human and tell the patient a clinician will follow up.",
    "- Never invent an appointment time. Offer only slots returned by find_slots.",
    "- Confirm the exact date, time, site and treatment with the patient before you call book.",
    "- Never invent a price. (Pricing tools arrive in a later phase; for now, if asked about cost, say a coordinator will confirm the exact price.)",
    "- Use no em-dash characters anywhere. Use commas or full stops. Money is in GBP using the £ symbol.",
    "- Keep replies short and friendly, suitable for SMS. Stay on the topic of booking and the practice.",
    "- If the patient is upset, complains, asks for a human, or you are unsure, call escalate_to_human.",
  ].join("\n");
}
```

- [ ] **Step 4: Run, verify PASS.** `npx tsc --noEmit`. Confirm `grep -c "—" src/lib/agent/prompt.ts` is 0 (no em-dash literal).

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/prompt.ts src/lib/agent/prompt.test.ts
git commit -m "feat: booking agent system prompt + guardrails"
```

---

## Task 6: Agent turn loop (TDD with mocked Claude)

**Files:**
- Create: `src/lib/agent/run.ts`
- Test: `src/lib/agent/run.test.ts`

`runAgentTurn(messages, deps)` runs the Claude tool-use loop: call Claude with the system prompt and tools; while Claude returns `tool_use`, execute the tools via `deps.dispatch` and feed results back; return the final text reply. Bounded to `MAX_ROUNDS`. On exhausting rounds with no text, it returns escalated with an empty reply (the caller sends a safe fallback).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { runAgentTurn } from "./run";

function toolUseMessage(id: string, name: string, input: object) {
  return { stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }] };
}
function textMessage(text: string) {
  return { stop_reason: "end_turn", content: [{ type: "text", text }] };
}

describe("runAgentTurn", () => {
  it("executes a tool call then returns the final reply", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(toolUseMessage("tu1", "find_slots", { treatment: "Invisalign" }))
      .mockResolvedValueOnce(textMessage("Hi Harold, we have Monday 9am or Tuesday 11am. Which suits?"));
    const dispatch = vi.fn().mockResolvedValue(JSON.stringify({ slots: [{ start_time: "2026-06-22T09:00:00Z" }] }));
    const deps = { anthropic: { messages: { create } } as never, dispatch, systemPrompt: "sys", tools: [] };

    const r = await runAgentTurn([{ role: "user", content: "yes please" }], deps);
    expect(dispatch).toHaveBeenCalledWith("find_slots", { treatment: "Invisalign" });
    expect(r.replyText).toContain("Which suits?");
    expect(r.toolCalls.map((t) => t.name)).toEqual(["find_slots"]);
    expect(r.escalated).toBe(false);
  });

  it("flags escalation when the agent calls escalate_to_human", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(toolUseMessage("tu1", "escalate_to_human", { reason: "complaint" }))
      .mockResolvedValueOnce(textMessage("Thanks, a member of our team will be in touch shortly."));
    const dispatch = vi.fn().mockResolvedValue(JSON.stringify({ escalated: true }));
    const deps = { anthropic: { messages: { create } } as never, dispatch, systemPrompt: "sys", tools: [] };

    const r = await runAgentTurn([{ role: "user", content: "this is terrible" }], deps);
    expect(r.escalated).toBe(true);
    expect(r.replyText).toContain("team will be in touch");
  });

  it("returns escalated with empty reply if it never stops calling tools", async () => {
    const create = vi.fn().mockResolvedValue(toolUseMessage("tu", "find_slots", { treatment: "x" }));
    const dispatch = vi.fn().mockResolvedValue("{}");
    const deps = { anthropic: { messages: { create } } as never, dispatch, systemPrompt: "sys", tools: [] };

    const r = await runAgentTurn([{ role: "user", content: "hi" }], deps);
    expect(r.replyText).toBe("");
    expect(r.escalated).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify FAIL** — `npx vitest run src/lib/agent/run.test.ts`

- [ ] **Step 3: Implement** `src/lib/agent/run.ts`

```ts
import type Anthropic from "@anthropic-ai/sdk";
import type { AgentTurnResult } from "./types";

export interface AgentRunDeps {
  anthropic: Anthropic;
  dispatch: (name: string, input: Record<string, unknown>) => Promise<string>;
  systemPrompt: string;
  tools: Anthropic.Tool[];
}

const MAX_ROUNDS = 4;
const MODEL = "claude-sonnet-4-6";

export async function runAgentTurn(
  history: Anthropic.MessageParam[],
  deps: AgentRunDeps,
): Promise<AgentTurnResult> {
  const messages: Anthropic.MessageParam[] = [...history];
  const toolCalls: { name: string; input: Record<string, unknown> }[] = [];
  let escalated = false;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const msg = await deps.anthropic.messages.create({
      model: MODEL,
      max_tokens: 700,
      system: deps.systemPrompt,
      tools: deps.tools,
      messages,
    });

    const toolUses = (msg.content as Anthropic.ContentBlock[]).filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (msg.stop_reason !== "tool_use" || toolUses.length === 0) {
      const replyText = (msg.content as Anthropic.ContentBlock[])
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      return { replyText, toolCalls, escalated };
    }

    messages.push({ role: "assistant", content: msg.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const input = (tu.input ?? {}) as Record<string, unknown>;
      toolCalls.push({ name: tu.name, input });
      if (tu.name === "escalate_to_human") escalated = true;
      const result = await deps.dispatch(tu.name, input);
      results.push({ type: "tool_result", tool_use_id: tu.id, content: result });
    }
    messages.push({ role: "user", content: results });
  }

  return { replyText: "", toolCalls, escalated: true };
}
```

- [ ] **Step 4: Run, verify PASS** (all 3). `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/run.ts src/lib/agent/run.test.ts
git commit -m "feat: booking agent turn loop (claude tool-use)"
```

---

## Task 7: Conversation repository

**Files:**
- Create: `src/lib/agent/repository.ts`

Maps snake_case rows to the domain types; one responsibility: persistence. Uses `serviceClient()`.

- [ ] **Step 1: Implement** `src/lib/agent/repository.ts`

```ts
import { serviceClient } from "@/lib/supabase/server";
import type { AgentConversation, AgentMessageRow, ConversationStatus, MessageRole } from "./types";

interface ConvRow {
  id: string; site_id: string; dentally_patient_id: string; patient_name: string; channel: string;
  status: string; treatment: string | null; funding_type: string | null;
  last_inbound_at: string | null; created_at: string; updated_at: string;
}
interface MsgRow {
  id: string; conversation_id: string; role: string; body: string; tool_name: string | null; created_at: string;
}

function toConv(r: ConvRow): AgentConversation {
  return {
    id: r.id, siteId: r.site_id, dentallyPatientId: r.dentally_patient_id, patientName: r.patient_name,
    channel: r.channel, status: r.status as ConversationStatus,
    treatment: r.treatment, fundingType: (r.funding_type as "nhs" | "private" | null) ?? null,
    lastInboundAt: r.last_inbound_at, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function toMsg(r: MsgRow): AgentMessageRow {
  return { id: r.id, conversationId: r.conversation_id, role: r.role as MessageRole, body: r.body, toolName: r.tool_name, createdAt: r.created_at };
}

export async function findOrCreateConversation(input: {
  siteId: string; dentallyPatientId: string; patientName: string; channel: string;
  treatment: string | null; fundingType: "nhs" | "private" | null;
}): Promise<AgentConversation> {
  const db = serviceClient();
  const { data: existing, error: selErr } = await db
    .from("agent_conversation")
    .select("*")
    .eq("site_id", input.siteId)
    .eq("dentally_patient_id", input.dentallyPatientId)
    .eq("channel", input.channel)
    .not("status", "in", "(closed)")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (selErr) throw selErr;
  if (existing) return toConv(existing as ConvRow);

  const { data, error } = await db
    .from("agent_conversation")
    .insert({
      site_id: input.siteId, dentally_patient_id: input.dentallyPatientId, patient_name: input.patientName,
      channel: input.channel, treatment: input.treatment, funding_type: input.fundingType,
    })
    .select("*")
    .single();
  if (error) throw error;
  return toConv(data as ConvRow);
}

export async function listMessages(conversationId: string): Promise<AgentMessageRow[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("agent_message").select("*").eq("conversation_id", conversationId).order("created_at", { ascending: true });
  if (error) throw error;
  return (data as MsgRow[]).map(toMsg);
}

export async function appendMessage(input: {
  conversationId: string; role: MessageRole; body: string; toolName?: string | null;
}): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("agent_message").insert({
    conversation_id: input.conversationId, role: input.role, body: input.body, tool_name: input.toolName ?? null,
  });
  if (error) throw error;
}

export async function setConversationStatus(id: string, status: ConversationStatus): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("agent_conversation")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

export async function stampInbound(id: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("agent_conversation")
    .update({ last_inbound_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/lib/agent/repository.ts
git commit -m "feat: booking agent conversation repository"
```

---

## Task 8: Inbound routing into the agent

**Files:**
- Modify: `src/app/api/webhooks/twilio/inbound/route.ts`

After the existing inbound-touch logging and STOP handling, route a non-STOP reply from a known patient to the agent. Build the thread from prior messages, run the turn, send the reply via the messaging layer, persist, and update status. A `needs_human` conversation stops auto-replying. Any failure escalates with a safe fallback.

- [ ] **Step 1: Implement the routing.** Add these imports at the top of the route:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { DentallyClient } from "@/lib/dentally/client";
import { sendMessage } from "@/lib/messaging/send";
import { buildSystemPrompt } from "@/lib/agent/prompt";
import { AGENT_TOOLS, makeDispatch } from "@/lib/agent/tools";
import { runAgentTurn } from "@/lib/agent/run";
import {
  findOrCreateConversation, listMessages, appendMessage, setConversationStatus, stampInbound,
} from "@/lib/agent/repository";
import type { AgentContext } from "@/lib/agent/types";
import { getTargetContext } from "@/lib/reactivation/repository"; // see Step 2
```

Then, inside the existing `if (match) { ... }` block, AFTER the STOP check, replace the bare cadence-pause with agent routing (keep the STOP early-out: if `isStopKeyword(body)`, suppress and return as today, do NOT run the agent):

```ts
    if (isStopKeyword(body)) {
      await addSuppression(match.siteId, channel, `patient:${match.targetId.split(":")[1]}`, "stop");
      return twiml();
    }

    // Pause any active cadence; a live conversation supersedes it.
    if (cadence && cadence.status === "active") {
      await updateCadence(cadence.id, { status: "paused" });
    }

    const patientId = match.targetId.split(":")[1];
    const ctxRow = await getTargetContext(match.targetId); // { patientName, treatment, fundingType } | null
    const conversation = await findOrCreateConversation({
      siteId: match.siteId, dentallyPatientId: patientId, patientName: ctxRow?.patientName ?? "there",
      channel, treatment: ctxRow?.treatment ?? null, fundingType: ctxRow?.fundingType ?? null,
    });
    await appendMessage({ conversationId: conversation.id, role: "patient", body });
    await stampInbound(conversation.id);

    if (conversation.status === "needs_human") {
      return twiml(); // already handed over; log only, do not auto-reply
    }

    const context: AgentContext = {
      patientId, siteId: match.siteId, patientName: conversation.patientName,
      treatment: conversation.treatment, fundingType: conversation.fundingType,
    };

    let replyText = "";
    let escalated = false;
    try {
      const apiKey = process.env.DENTALLY_API_KEY ?? "";
      const dentally = new DentallyClient({ apiKey, baseUrl: process.env.DENTALLY_BASE_URL ?? "https://api.dentally.co" });
      const prior = await listMessages(conversation.id);
      const history = prior.map((m) => ({
        role: m.role === "patient" ? ("user" as const) : ("assistant" as const),
        content: m.body,
      }));
      const result = await runAgentTurn(history, {
        anthropic: new Anthropic(),
        dispatch: makeDispatch({ dentally, context }),
        systemPrompt: buildSystemPrompt(context),
        tools: AGENT_TOOLS,
      });
      replyText = result.replyText;
      escalated = result.escalated;
      const booked = result.toolCalls.some((t) => t.name === "book");
      if (escalated || !replyText) {
        await setConversationStatus(conversation.id, "needs_human");
      } else if (booked) {
        await setConversationStatus(conversation.id, "booked");
      }
    } catch {
      escalated = true;
      await setConversationStatus(conversation.id, "needs_human");
    }

    const outbound = replyText || "Thanks, a member of our team will be in touch shortly.";
    await appendMessage({ conversationId: conversation.id, role: "agent", body: outbound });
    await sendMessage({ channel, to: from, body: outbound });
    return twiml();
```

Add a small `twiml()` helper near the top of the file (replacing the inline TwiML return) so all return paths share it:

```ts
function twiml(): Response {
  return new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
    status: 200, headers: { "Content-Type": "text/xml" },
  });
}
```

Ensure the existing final return and the no-match path also use `twiml()`.

- [ ] **Step 2: Add `getTargetContext` to `src/lib/reactivation/repository.ts`** (the agent needs the patient's name + treatment + funding from the reactivation target):

```ts
export async function getTargetContext(
  targetId: string,
): Promise<{ patientName: string; treatment: string | null; fundingType: "nhs" | "private" | null } | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("reactivation_target")
    .select("patient_name, treatment, reason")
    .eq("id", targetId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as { patient_name: string; treatment: string | null; reason: string };
  // Funding type is not modelled on the target yet; default null (Phase 2 wires NHS/private).
  return { patientName: row.patient_name, treatment: row.treatment, fundingType: null };
}
```

- [ ] **Step 3: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean; `/api/webhooks/twilio/inbound` present.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/webhooks/twilio/inbound/route.ts src/lib/reactivation/repository.ts
git commit -m "feat: route inbound replies into the booking agent"
```

---

## Task 9: Phase 1 integration + verification

- [ ] **Step 1: Run all unit tests** — `npx vitest run` (agent tools/prompt/run + existing suites pass).

- [ ] **Step 2: Typecheck + build** — `npx tsc --noEmit && npm run build` (clean; mock availability route present).

- [ ] **Step 3: Live agent turn (mock Dentally + live Claude, dry-run send).** Set `DENTALLY_BASE_URL` to the mock and `MESSAGING_DRY_RUN=true`; ensure `ANTHROPIC_API_KEY` is set; restart the dev server. Seed an `agent_conversation` for a mock patient (e.g. `site-cc` / `pat-010` / treatment "Invisalign") via the Supabase MCP, then drive a turn by calling the agent path. Two ways to exercise it:
  - **Direct:** write a one-off script/route that calls `runAgentTurn` with a scripted history (e.g. patient says "yes, what have you got next week?"); confirm Claude calls `find_slots`, gets the mock slots, and replies proposing real times; then "Tuesday 11am please" leads to a `book` call and the conversation flips to `booked`.
  - **Via webhook:** POST a simulated inbound to `/api/webhooks/twilio/inbound` (form `From=<a number whose outbox to_address maps to a target>&Body=yes please`), and confirm an `agent_message` (role agent) is written and (dry-run) "sent". Use the Supabase MCP to inspect `agent_conversation` / `agent_message`.

Confirm: the agent proposes only mock slots, books on confirmation, and a clinical question ("is the implant safe for me?") triggers `escalate_to_human` and a hand-over reply with `status = needs_human`.

- [ ] **Step 4: Clean up** any seeded conversation/message rows.

- [ ] **Step 5: Confirm Phase 1 spec acceptance:** autonomous reply; only tool-returned slots offered; book writes (simulated) with `booked_via_api`; clinical/complaint/uncertain escalates; no em-dashes; no clinical data stored.

- [ ] **Step 6: Commit (if anything outstanding)**

```bash
git add -A
git commit -m "test: booking agent phase 1 verification"
```

---

# PHASE 2 — Pricing & finance

## Task 10: Pricing/USP config (TDD)

**Files:**
- Create: `src/lib/pricing/config.ts`
- Test: `src/lib/pricing/config.test.ts`

A canonical, editable config keyed by treatment x site x funding type. `getPricing` returns a safe miss when there is no entry, so the agent never guesses.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { getPricing } from "./config";

describe("getPricing", () => {
  it("returns the entry for a known treatment/site/funding", () => {
    const p = getPricing({ treatment: "Invisalign", siteId: "site-cc", fundingType: "private" });
    expect(p.found).toBe(true);
    expect(p.priceText).toContain("£");
    expect(Array.isArray(p.usps)).toBe(true);
  });
  it("returns a safe miss (found=false) for an unknown entry", () => {
    const p = getPricing({ treatment: "Time travel", siteId: "site-cc", fundingType: "private" });
    expect(p.found).toBe(false);
    expect(p.priceText.toLowerCase()).toContain("coordinator");
  });
});
```

- [ ] **Step 2: Run, verify FAIL** — `npx vitest run src/lib/pricing/config.test.ts`

- [ ] **Step 3: Implement** `src/lib/pricing/config.ts`. Define the type and a seeded `PRICING` array, then `getPricing`. PILOT figures below are placeholders to be replaced with Vitality's real prices; keep the shape exactly.

```ts
export interface PricingEntry {
  treatment: string;
  siteId: string | "*";          // "*" = all sites
  fundingType: "nhs" | "private" | "*";
  priceText: string;             // GBP, with £
  financeText: string;
  usps: string[];
}

// PILOT placeholder pricing. Replace figures with Vitality's actual prices.
export const PRICING: PricingEntry[] = [
  { treatment: "Invisalign", siteId: "*", fundingType: "private", priceText: "Invisalign starts from £2,500.", financeText: "0% finance over 12 months is available.", usps: ["Clear, removable aligners", "Free initial scan"] },
  { treatment: "Dental implant", siteId: "*", fundingType: "private", priceText: "A single implant is from £2,200.", financeText: "Spread the cost with finance from £95 a month.", usps: ["Permanent, natural looking", "Led by our implant team"] },
  { treatment: "Porcelain veneers", siteId: "*", fundingType: "private", priceText: "Porcelain veneers are from £650 per tooth.", financeText: "Finance available on full smile cases.", usps: ["Bespoke shade matching", "Minimal prep options"] },
  { treatment: "Teeth whitening", siteId: "*", fundingType: "private", priceText: "Professional whitening is from £350.", financeText: "", usps: ["Home and in chair options"] },
  { treatment: "Composite bonding", siteId: "*", fundingType: "private", priceText: "Composite bonding is from £180 per tooth.", financeText: "", usps: ["Same day, no drilling"] },
  { treatment: "Checkup", siteId: "*", fundingType: "private", priceText: "A private checkup is £65.", financeText: "", usps: ["Includes a full oral health review"] },
  { treatment: "Checkup", siteId: "*", fundingType: "nhs", priceText: "An NHS checkup is £27.40 (Band 1).", financeText: "", usps: ["NHS banded pricing"] },
];
```

Then the lookup:

```ts
export interface PricingResult { found: boolean; priceText: string; financeText: string; usps: string[]; }

export function getPricing(args: { treatment: string; siteId: string; fundingType: "nhs" | "private" | null }): PricingResult {
  const t = args.treatment.trim().toLowerCase();
  const match = PRICING.find(
    (e) => e.treatment.toLowerCase() === t
      && (e.siteId === "*" || e.siteId === args.siteId)
      && (e.fundingType === "*" || e.fundingType === args.fundingType),
  );
  if (!match) {
    return { found: false, priceText: "We do not have a published price to hand, a coordinator will confirm the exact cost.", financeText: "", usps: [] };
  }
  return { found: true, priceText: match.priceText, financeText: match.financeText, usps: match.usps };
}
```

(Use realistic placeholder figures, clearly marked as pilot values to be replaced; no em-dashes; `£` for money.)

- [ ] **Step 4: Run, verify PASS.** Commit.

```bash
git add src/lib/pricing/config.ts src/lib/pricing/config.test.ts
git commit -m "feat: lightweight pricing/USP source of truth"
```

---

## Task 11: get_pricing tool + funding context + prompt

**Files:**
- Modify: `src/lib/agent/tools.ts`, `src/lib/agent/prompt.ts`, `src/lib/dentally/normalise.ts`

- [ ] **Step 1:** Add a `get_pricing` entry to `AGENT_TOOLS` (input: `treatment`, optional; uses the patient's funding from context) and a `case "get_pricing"` to `makeDispatch` that calls `getPricing({ treatment: input.treatment ?? context.treatment, siteId: context.siteId, fundingType: context.fundingType })` and returns the JSON. Add a unit test mirroring Task 4's style (asserts a hit returns `£` text and a miss returns the coordinator fallback).

- [ ] **Step 2:** Update `buildSystemPrompt` to replace the "pricing tools arrive later" clause with: quote pricing/finance ONLY from `get_pricing`; if `found` is false, say a coordinator will confirm; cite the £ figure and the finance option when present. Update the prompt test to assert `get_pricing` is mentioned.

- [ ] **Step 3:** Wire funding type into the patient context. In `src/lib/dentally/normalise.ts` (reactivation normaliser), derive `fundingType` from the Dentally account values (`planned_private_treatment_value` vs `planned_nhs_treatment_value`) when present, and carry it through so `getTargetContext` can return it. (If the target does not model funding, default `private` for the pilot and note it.) Add/extend a unit test for the funding derivation.

- [ ] **Step 4:** `npx vitest run && npx tsc --noEmit && npm run build`. Commit.

```bash
git add src/lib/agent/tools.ts src/lib/agent/tools.test.ts src/lib/agent/prompt.ts src/lib/agent/prompt.test.ts src/lib/dentally/normalise.ts src/lib/dentally/normalise.test.ts
git commit -m "feat: agent pricing tool + NHS/private context"
```

---

# PHASE 3 — Manage (reschedule / cancel) + lifecycle

## Task 12: Reschedule & cancel

**Files:**
- Modify: `src/lib/dentally/client.ts`, `src/app/api/mock-dentally/v1/appointments/route.ts`, `src/lib/agent/tools.ts`, `src/lib/agent/prompt.ts`

- [ ] **Step 1:** Add `DentallyClient.updateAppointment(id, payload)` (PUT `/v1/appointments/:id`) and `cancelAppointment(id)` (sets state to `cancelled`), each throwing `DentallyError` on non-2xx, with mocked-fetch tests mirroring `client.test.ts`.

- [ ] **Step 2:** Extend the mock `v1/appointments/route.ts` with `PUT`/`PATCH` (echo the updated appointment) and a cancel path, plus a `GET ?patient_id=` that returns the patient's upcoming appointments (so `get_patient_appointments` and reschedule/cancel have something to act on).

- [ ] **Step 3:** Add `reschedule`, `cancel`, and `get_patient_appointments` to `AGENT_TOOLS` + `makeDispatch` (using `DentallyClient` + `getPatientAppointments`), with unit tests. Require explicit confirmation in the prompt before reschedule/cancel.

- [ ] **Step 4:** Update `buildSystemPrompt` to describe reschedule/cancel and recalls/follow-ups handling (offer to rebook a missed recall; confirm before changing anything). Update the prompt test.

- [ ] **Step 5:** `npx vitest run && npx tsc --noEmit && npm run build`. Commit.

```bash
git add src/lib/dentally/ src/app/api/mock-dentally/ src/lib/agent/
git commit -m "feat: agent reschedule/cancel + appointment lookup"
```

---

## Task 13: Full test + verification pass

- [ ] **Step 1:** `npx vitest run` (all suites pass).
- [ ] **Step 2:** `npx tsc --noEmit && npm run build` (clean; routes present: inbound webhook, mock availability).
- [ ] **Step 3:** Confirm full spec acceptance: autonomous concierge converses, finds slots, books/reschedules/cancels (simulated), quotes pricing only from the config, escalates on clinical/complaint/uncertain; no clinical data; no em-dashes; SMS via the messaging layer; state in Supabase.
- [ ] **Step 4:** Final commit if anything outstanding.

---

## Notes for the implementer

- The Anthropic tool-use loop is the heart of this: Claude returns `stop_reason: "tool_use"` with `tool_use` blocks; you push the assistant message, run each tool, push a `user` message of `tool_result` blocks, and loop until a text reply. `run.test.ts` pins this with a mocked client, so the live SDK shape must match (`@anthropic-ai/sdk` `Anthropic.Tool`, `ToolUseBlock`, `ToolResultBlockParam`).
- Exact Dentally availability/edit/cancel paths are the calibration unknown (like the sync). The mock matches the client's assumed shapes so the agent runs end to end now; only the CALIBRATION strings change against the real sandbox.
- The Dentally key is read-only: book/reschedule/cancel are simulated on the mock until a read+write key lands. Live inbound replies need a public URL for Twilio.
- Never commit `.env.local`. `site_id` on every row. Respect consent/STOP (already gated). No em-dashes in any agent output; `£` for money.
- A concurrent session works other files via separate worktrees; stage only the files each task lists; never `git add -A` except the final verification step on a clean tree.
- Production implications to carry forward (per project rule): real read+write Dentally key, public tunnel, real auth/RLS, Claude cost/rate controls, full audit logging of agent actions and transcripts, and human review of agent conversations before unsupervised live use on real patients.
```
