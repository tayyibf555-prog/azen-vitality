# Treatment Coordinator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Treatment Coordinator module: sync accepted-but-incomplete treatment from Dentally into Supabase, rank by recoverable value, draft finance re-presentation with Claude in a draft-and-approve flow, and book the next step back into Dentally.

**Architecture:** Sync Dentally (system of record, polled with `updated_after`) into lean Supabase `treatment_opportunity` snapshots plus module-owned tables (`coordinator_touch`, `outbox`, `sync_state`). Pure logic (scoring, normalisation, prompt assembly) is TDD-tested; the Dentally client is tested against mocked fetch. The UI reads/ranks from Supabase, drafts via Claude, and writes appointments back to Dentally. Auth stays mock; message sending is a stub adapter.

**Tech Stack:** Next.js 16 (App Router), TypeScript strict, Tailwind v4, `@supabase/supabase-js`, `@anthropic-ai/sdk`, Vitest for tests. Existing foundation primitives in `src/components/primitives`.

Spec: `docs/superpowers/specs/2026-06-18-treatment-coordinator-design.md`

---

## File structure (created/modified)

- `src/lib/coordinator/types.ts` — module domain types (TreatmentOpportunity, CoordinatorTouch, OutboxItem, enums).
- `src/lib/coordinator/scoring.ts` — pure `priorityScore()` + `rankOpportunities()`.
- `src/lib/coordinator/draft.ts` — Claude prompt assembly (`buildDraftPrompt`) + `draftOutreach()` caller.
- `src/lib/coordinator/repository.ts` — typed Supabase reads/writes for the three tables + sync_state.
- `src/lib/dentally/client.ts` — `DentallyClient` REST wrapper (auth, User-Agent, pagination, rate handling).
- `src/lib/dentally/normalise.ts` — pure `toOpportunity()` Dentally JSON -> snapshot (no clinical fields).
- `src/lib/supabase/server.ts` — service-role + anon server clients.
- `supabase/migrations/0001_treatment_coordinator.sql` — schema + RLS.
- `src/app/api/sync/dentally/route.ts` — sync endpoint.
- `src/app/api/coordinator/[action]/route.ts` — draft / approve / send-stub / book actions.
- `src/app/c/[client]/treatment-coordinator/page.tsx` — replaces placeholder; worklist + detail.
- `src/components/client/coordinator/*` — worklist table, opportunity drawer, draft editor.
- `vitest.config.ts`, `.env.example`, `.env.local` (gitignored).

---

## Task 1: Tooling — test runner, SDKs, env

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`, `.env.example`
- Create (gitignored): `.env.local`

- [ ] **Step 1: Install dependencies**

```bash
cd "/Users/tayyibarbab/Downloads/Vitality Dental Project"
npm install @supabase/supabase-js @anthropic-ai/sdk
npm install -D vitest
```

- [ ] **Step 2: Add a test script**

In `package.json` `"scripts"`, add: `"test": "vitest run"`, `"test:watch": "vitest"`.

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"] },
  resolve: { alias: { "@": resolve(__dirname, "src") } },
});
```

- [ ] **Step 4: Create `.env.example`**

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
DENTALLY_API_KEY=
DENTALLY_BASE_URL=https://api.sandbox.dentally.co
ANTHROPIC_API_KEY=
COORDINATOR_AUTO_SEND_THRESHOLD=250
```

- [ ] **Step 5: Create `.env.local`** with the real values (provided by the user). Confirm `.env*.local` is in `.gitignore` (create-next-app default includes `.env*`). Do NOT commit `.env.local`.

- [ ] **Step 6: Verify Vitest runs**

Run: `npx vitest run`
Expected: "No test files found" (exit 0) — runner works.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json vitest.config.ts .env.example
git commit -m "chore: add vitest, supabase + anthropic sdks, env template"
```

---

## Task 2: Module domain types

**Files:**
- Create: `src/lib/coordinator/types.ts`

- [ ] **Step 1: Write the types** (no test; consumed by later tasks)

```ts
export type OpportunityStatus = "accepted" | "in_progress" | "stalled" | "completed";
export type TouchChannel = "sms" | "email" | "whatsapp";
export type TouchStatus = "draft" | "approved" | "queued" | "sent" | "failed";
export type DraftedBy = "claude" | "human";

export interface TreatmentOpportunity {
  id: string;
  siteId: string;
  dentallyPatientId: string;
  dentallyPlanId: string;
  patientName: string;
  treatment: string;
  plannedValue: number;       // GBP
  amountOutstanding: number;  // GBP
  acceptedAt: string;         // ISO
  status: OpportunityStatus;
  financePresented: boolean;
  lastTouchAt: string | null; // ISO
  priorityScore: number;
  consent: { sms: boolean; email: boolean; marketing: boolean };
  updatedFromDentallyAt: string;
}

export interface CoordinatorTouch {
  id: string;
  opportunityId: string;
  siteId: string;
  channel: TouchChannel;
  direction: "outbound" | "inbound";
  body: string;
  draftedBy: DraftedBy;
  status: TouchStatus;
  approvedBy: string | null;
  createdAt: string;
  sentAt: string | null;
}

export interface OutboxItem {
  id: string;
  touchId: string;
  siteId: string;
  channel: TouchChannel;
  toRef: string;
  body: string;
  status: "queued" | "sent" | "failed";
  provider: string | null;
  createdAt: string;
  sentAt: string | null;
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/lib/coordinator/types.ts
git commit -m "feat: treatment coordinator domain types"
```

---

## Task 3: Ranking (pure, TDD)

**Files:**
- Create: `src/lib/coordinator/scoring.ts`
- Test: `src/lib/coordinator/scoring.test.ts`

Scoring formula (documented): `priorityScore = amountOutstanding * recencyWeight * stalenessWeight * financeBonus`, where `recencyWeight` favours more recently accepted plans (decays over 180 days, floor 0.5), `stalenessWeight` rises with days since last touch (no touch = max), `financeBonus = 1.15` when finance not yet presented else 1.0. Outstanding value dominates; the rest are multipliers in a bounded range so a large plan always outranks a tiny one.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { priorityScore, rankOpportunities } from "./scoring";
import type { TreatmentOpportunity } from "./types";

const NOW = new Date("2026-06-18T09:00:00Z");

function opp(p: Partial<TreatmentOpportunity>): TreatmentOpportunity {
  return {
    id: "o", siteId: "s", dentallyPatientId: "p", dentallyPlanId: "pl",
    patientName: "Test", treatment: "Invisalign", plannedValue: 3000,
    amountOutstanding: 3000, acceptedAt: "2026-06-01T00:00:00Z", status: "stalled",
    financePresented: false, lastTouchAt: null, priorityScore: 0,
    consent: { sms: true, email: true, marketing: true },
    updatedFromDentallyAt: NOW.toISOString(), ...p,
  };
}

describe("priorityScore", () => {
  it("ranks higher outstanding value above lower, all else equal", () => {
    const big = priorityScore(opp({ amountOutstanding: 4000 }), NOW);
    const small = priorityScore(opp({ amountOutstanding: 1000 }), NOW);
    expect(big).toBeGreaterThan(small);
  });

  it("gives a bonus when finance not yet presented", () => {
    const noFinance = priorityScore(opp({ financePresented: false }), NOW);
    const withFinance = priorityScore(opp({ financePresented: true }), NOW);
    expect(noFinance).toBeGreaterThan(withFinance);
  });

  it("a large plan outranks a tiny recent one", () => {
    const large = priorityScore(opp({ amountOutstanding: 5000, acceptedAt: "2026-01-01T00:00:00Z" }), NOW);
    const tiny = priorityScore(opp({ amountOutstanding: 200, acceptedAt: "2026-06-17T00:00:00Z" }), NOW);
    expect(large).toBeGreaterThan(tiny);
  });
});

describe("rankOpportunities", () => {
  it("sorts descending by score and stamps priorityScore", () => {
    const ranked = rankOpportunities([opp({ id: "a", amountOutstanding: 500 }), opp({ id: "b", amountOutstanding: 5000 })], NOW);
    expect(ranked.map((o) => o.id)).toEqual(["b", "a"]);
    expect(ranked[0].priorityScore).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `npx vitest run src/lib/coordinator/scoring.test.ts`
Expected: FAIL ("priorityScore is not a function").

- [ ] **Step 3: Implement**

```ts
import type { TreatmentOpportunity } from "./types";

const DAY = 86_400_000;

export function priorityScore(o: TreatmentOpportunity, now: Date): number {
  const ageDays = Math.max(0, (now.getTime() - new Date(o.acceptedAt).getTime()) / DAY);
  const recencyWeight = Math.max(0.5, 1 - ageDays / 180);
  const sinceTouchDays = o.lastTouchAt
    ? Math.max(0, (now.getTime() - new Date(o.lastTouchAt).getTime()) / DAY)
    : 30;
  const stalenessWeight = 1 + Math.min(sinceTouchDays, 30) / 30; // 1..2
  const financeBonus = o.financePresented ? 1 : 1.15;
  return o.amountOutstanding * recencyWeight * stalenessWeight * financeBonus;
}

export function rankOpportunities(items: TreatmentOpportunity[], now: Date): TreatmentOpportunity[] {
  return items
    .map((o) => ({ ...o, priorityScore: priorityScore(o, now) }))
    .sort((a, b) => b.priorityScore - a.priorityScore);
}
```

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run src/lib/coordinator/scoring.test.ts`
Expected: PASS (all 4).

- [ ] **Step 5: Commit**

```bash
git add src/lib/coordinator/scoring.ts src/lib/coordinator/scoring.test.ts
git commit -m "feat: priority ranking for treatment opportunities"
```

---

## Task 4: Dentally normaliser (pure, TDD)

**Files:**
- Create: `src/lib/dentally/normalise.ts`
- Test: `src/lib/dentally/normalise.test.ts`

Maps a Dentally patient + account + plan + outstanding amount into a `TreatmentOpportunity`. Derives `status`: `completed` if outstanding <= 0; `in_progress` if any payment made (outstanding < planned); `stalled` if no touch and accepted > 30 days ago; else `accepted`. Asserts no clinical fields are copied (only the whitelisted fields below).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { toOpportunity, type DentallyPlanInput } from "./normalise";

const NOW = new Date("2026-06-18T09:00:00Z");

const input: DentallyPlanInput = {
  siteId: "site-cc",
  patient: { id: "123", first_name: "Sarah", last_name: "Lindqvist",
    contact_details: { sms_marketing: true, email_marketing: false }, marketing: true },
  plan: { id: "pl-9", name: "Invisalign full arch", planned_private_treatment_value: 3400,
    accepted_at: "2026-05-28T00:00:00Z" },
  amountOutstanding: 3400,
  lastTouchAt: null,
};

describe("toOpportunity", () => {
  it("maps core fields and GBP values", () => {
    const o = toOpportunity(input, NOW);
    expect(o.dentallyPatientId).toBe("123");
    expect(o.patientName).toBe("Sarah Lindqvist");
    expect(o.plannedValue).toBe(3400);
    expect(o.amountOutstanding).toBe(3400);
    expect(o.consent).toEqual({ sms: true, email: false, marketing: true });
  });

  it("derives stalled when accepted over 30 days ago with no touch", () => {
    expect(toOpportunity(input, NOW).status).toBe("stalled");
  });

  it("derives completed when nothing outstanding", () => {
    expect(toOpportunity({ ...input, amountOutstanding: 0 }, NOW).status).toBe("completed");
  });

  it("does not copy any field outside the whitelist (no clinical data)", () => {
    const dirty = { ...input, patient: { ...input.patient, medical_notes: "SECRET" } as never };
    const o = toOpportunity(dirty, NOW);
    expect(JSON.stringify(o)).not.toContain("SECRET");
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `npx vitest run src/lib/dentally/normalise.test.ts`
Expected: FAIL ("toOpportunity is not a function").

- [ ] **Step 3: Implement**

```ts
import type { OpportunityStatus, TreatmentOpportunity } from "@/lib/coordinator/types";

export interface DentallyPlanInput {
  siteId: string;
  patient: {
    id: string; first_name: string; last_name: string;
    contact_details?: { sms_marketing?: boolean; email_marketing?: boolean };
    marketing?: boolean;
  };
  plan: { id: string; name: string; planned_private_treatment_value: number; accepted_at: string };
  amountOutstanding: number;
  lastTouchAt: string | null;
}

const DAY = 86_400_000;

function deriveStatus(i: DentallyPlanInput, now: Date): OpportunityStatus {
  if (i.amountOutstanding <= 0) return "completed";
  if (i.amountOutstanding < i.plan.planned_private_treatment_value) return "in_progress";
  const ageDays = (now.getTime() - new Date(i.plan.accepted_at).getTime()) / DAY;
  if (!i.lastTouchAt && ageDays > 30) return "stalled";
  return "accepted";
}

export function toOpportunity(i: DentallyPlanInput, now: Date): TreatmentOpportunity {
  return {
    id: `${i.siteId}:${i.plan.id}`,
    siteId: i.siteId,
    dentallyPatientId: i.patient.id,
    dentallyPlanId: i.plan.id,
    patientName: `${i.patient.first_name} ${i.patient.last_name}`.trim(),
    treatment: i.plan.name,
    plannedValue: i.plan.planned_private_treatment_value,
    amountOutstanding: i.amountOutstanding,
    acceptedAt: i.plan.accepted_at,
    status: deriveStatus(i, now),
    financePresented: false,
    lastTouchAt: i.lastTouchAt,
    priorityScore: 0,
    consent: {
      sms: Boolean(i.patient.contact_details?.sms_marketing),
      email: Boolean(i.patient.contact_details?.email_marketing),
      marketing: Boolean(i.patient.marketing),
    },
    updatedFromDentallyAt: now.toISOString(),
  };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run src/lib/dentally/normalise.test.ts`
Expected: PASS (all 4).

- [ ] **Step 5: Commit**

```bash
git add src/lib/dentally/normalise.ts src/lib/dentally/normalise.test.ts
git commit -m "feat: dentally -> opportunity normaliser (ops fields only)"
```

---

## Task 5: Claude draft prompt assembly (pure, TDD) + caller

**Files:**
- Create: `src/lib/coordinator/draft.ts`
- Test: `src/lib/coordinator/draft.test.ts`

`buildDraftPrompt(opportunity, channel)` returns `{ system, user }`. The system prompt enforces: advisor-to-patient tone, cite outstanding value + treatment, offer finance, one clear next step, under ~90 words, GBP (£), and NO em-dashes. `draftOutreach()` calls Anthropic with that prompt; tested separately with a mocked client.

- [ ] **Step 1: Write the failing test (prompt assembly only)**

```ts
import { describe, it, expect } from "vitest";
import { buildDraftPrompt } from "./draft";
import type { TreatmentOpportunity } from "./types";

const o: TreatmentOpportunity = {
  id: "o", siteId: "s", dentallyPatientId: "p", dentallyPlanId: "pl",
  patientName: "Sarah Lindqvist", treatment: "Invisalign full arch", plannedValue: 3400,
  amountOutstanding: 3400, acceptedAt: "2026-05-28T00:00:00Z", status: "stalled",
  financePresented: false, lastTouchAt: null, priorityScore: 1,
  consent: { sms: true, email: true, marketing: true }, updatedFromDentallyAt: "x",
};

describe("buildDraftPrompt", () => {
  it("forbids em-dashes and requires GBP in the system prompt", () => {
    const { system } = buildDraftPrompt(o, "sms");
    expect(system).not.toContain("—"); // no em-dash in our own instructions
    expect(system.toLowerCase()).toContain("no em-dash");
    expect(system).toContain("£");
  });

  it("includes patient, treatment, outstanding value and channel in the user message", () => {
    const { user } = buildDraftPrompt(o, "whatsapp");
    expect(user).toContain("Sarah Lindqvist");
    expect(user).toContain("Invisalign full arch");
    expect(user).toContain("3400");
    expect(user).toContain("whatsapp");
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `npx vitest run src/lib/coordinator/draft.test.ts`
Expected: FAIL ("buildDraftPrompt is not a function").

- [ ] **Step 3: Implement**

```ts
import Anthropic from "@anthropic-ai/sdk";
import type { TouchChannel, TreatmentOpportunity } from "./types";

export function buildDraftPrompt(o: TreatmentOpportunity, channel: TouchChannel) {
  const system = [
    "You are a warm, professional treatment coordinator for a UK dental practice.",
    "Write a short outreach message to a patient who accepted treatment but has not completed it.",
    "Rules:",
    "- Lead with the patient by first name and the specific treatment.",
    "- Reference the outstanding value in GBP using the £ symbol.",
    "- Offer to discuss finance or a payment plan.",
    "- Give one clear next step (book a call or an appointment).",
    "- Under 90 words. Friendly, not pushy.",
    "- Use no em-dash characters anywhere. Use commas or full stops.",
    "- Plain text only, suitable for the requested channel.",
  ].join("\n");

  const user = [
    `Channel: ${channel}`,
    `Patient: ${o.patientName}`,
    `Treatment: ${o.treatment}`,
    `Planned value (GBP): ${o.plannedValue}`,
    `Outstanding (GBP): ${o.amountOutstanding}`,
    `Accepted at: ${o.acceptedAt}`,
    `Finance already presented: ${o.financePresented ? "yes" : "no"}`,
  ].join("\n");

  return { system, user };
}

export interface DraftResult { body: string; rationale: string; }

export async function draftOutreach(
  o: TreatmentOpportunity,
  channel: TouchChannel,
  client: Anthropic = new Anthropic(),
): Promise<DraftResult> {
  const { system, user } = buildDraftPrompt(o, channel);
  const rationale =
    `£${o.amountOutstanding} outstanding on ${o.treatment}, ` +
    `${o.financePresented ? "finance presented" : "finance not yet presented"}.`;
  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 400,
    system,
    messages: [{ role: "user", content: user }],
  });
  const body = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  return { body, rationale };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run src/lib/coordinator/draft.test.ts`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add src/lib/coordinator/draft.ts src/lib/coordinator/draft.test.ts
git commit -m "feat: claude outreach drafting with prompt rules (GBP, no em-dash)"
```

---

## Task 6: DentallyClient (mocked-fetch TDD)

**Files:**
- Create: `src/lib/dentally/client.ts`
- Test: `src/lib/dentally/client.test.ts`

Wraps fetch with: `Authorization: Bearer <key>`, required `User-Agent`, base URL from env, query building, pagination helper, and a guard that throws a typed `DentallyError` on non-2xx (never crashes the app caller). Read methods: `listTreatmentPlans({ siteId, updatedAfter, page })`, `getPatient(id)`, `getAccountOutstanding(patientId)`. Write: `createAppointment(payload)`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { DentallyClient } from "./client";

function mockFetch(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok, status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

describe("DentallyClient", () => {
  it("sends auth + User-Agent headers to the configured base URL", async () => {
    const fetchMock = mockFetch({ treatment_plans: [] });
    const c = new DentallyClient({ apiKey: "k", baseUrl: "https://api.sandbox.dentally.co", fetchImpl: fetchMock });
    await c.listTreatmentPlans({ siteId: "site-cc" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("https://api.sandbox.dentally.co");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer k");
    expect((init.headers as Record<string, string>)["User-Agent"]).toBeTruthy();
  });

  it("throws a DentallyError on non-2xx", async () => {
    const fetchMock = mockFetch({ error: "nope" }, false, 401);
    const c = new DentallyClient({ apiKey: "k", baseUrl: "https://x", fetchImpl: fetchMock });
    await expect(c.listTreatmentPlans({ siteId: "s" })).rejects.toThrow(/401/);
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `npx vitest run src/lib/dentally/client.test.ts`
Expected: FAIL ("DentallyClient is not a constructor").

- [ ] **Step 3: Implement**

```ts
type FetchImpl = typeof fetch;

export class DentallyError extends Error {
  constructor(public status: number, message: string) {
    super(`Dentally ${status}: ${message}`);
  }
}

interface Opts { apiKey: string; baseUrl: string; fetchImpl?: FetchImpl; userAgent?: string; }

export interface ListPlansArgs { siteId: string; updatedAfter?: string; page?: number; perPage?: number; }

export class DentallyClient {
  private fetchImpl: FetchImpl;
  private userAgent: string;
  constructor(private opts: Opts) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.userAgent = opts.userAgent ?? "Azen-Vitality/0.1 (+https://azen.ai)";
  }

  private async get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(path, this.opts.baseUrl);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.opts.apiKey}`, "User-Agent": this.userAgent, Accept: "application/json" },
    });
    if (!res.ok) throw new DentallyError(res.status, await res.text());
    return (await res.json()) as T;
  }

  listTreatmentPlans(a: ListPlansArgs) {
    return this.get<{ treatment_plans: unknown[] }>("/v1/treatment_plans", {
      site_id: a.siteId, updated_after: a.updatedAfter, page: a.page ?? 1, per_page: a.perPage ?? 100,
    });
  }
  getPatient(id: string) { return this.get<{ patient: unknown }>(`/v1/patients/${id}`); }
  getAccountOutstanding(patientId: string) {
    return this.get<{ payment_plans: unknown[] }>("/v1/payment_plans", { patient_id: patientId });
  }

  async createAppointment(payload: Record<string, unknown>) {
    const url = new URL("/v1/appointments", this.opts.baseUrl);
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`, "User-Agent": this.userAgent,
        "Content-Type": "application/json", Accept: "application/json",
      },
      body: JSON.stringify({ appointment: payload }),
    });
    if (!res.ok) throw new DentallyError(res.status, await res.text());
    return (await res.json()) as { appointment: { id: string } };
  }
}
```

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run src/lib/dentally/client.test.ts`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add src/lib/dentally/client.ts src/lib/dentally/client.test.ts
git commit -m "feat: dentally REST client (auth, user-agent, error guard)"
```

> Note: exact Dentally paths/param names (`/v1/treatment_plans`, `updated_after`, payment-plan outstanding) must be confirmed against live sandbox responses in Task 9. The client is structured so only the path/param strings change, not the call sites.

---

## Task 7: Supabase schema migration + clients

**Files:**
- Create: `supabase/migrations/0001_treatment_coordinator.sql`
- Create: `src/lib/supabase/server.ts`

- [ ] **Step 1: Write the migration SQL**

```sql
-- 0001_treatment_coordinator.sql
create table if not exists treatment_opportunity (
  id text primary key,
  site_id text not null,
  dentally_patient_id text not null,
  dentally_plan_id text not null,
  patient_name text not null,
  treatment text not null,
  planned_value numeric not null default 0,
  amount_outstanding numeric not null default 0,
  accepted_at timestamptz,
  status text not null,
  finance_presented boolean not null default false,
  last_touch_at timestamptz,
  priority_score numeric not null default 0,
  consent jsonb not null default '{}'::jsonb,
  updated_from_dentally_at timestamptz not null default now()
);
create index if not exists idx_opp_site on treatment_opportunity (site_id);
create index if not exists idx_opp_rank on treatment_opportunity (site_id, priority_score desc);

create table if not exists coordinator_touch (
  id uuid primary key default gen_random_uuid(),
  opportunity_id text not null references treatment_opportunity (id) on delete cascade,
  site_id text not null,
  channel text not null,
  direction text not null default 'outbound',
  body text not null,
  drafted_by text not null,
  status text not null default 'draft',
  approved_by text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists idx_touch_opp on coordinator_touch (opportunity_id);

create table if not exists outbox (
  id uuid primary key default gen_random_uuid(),
  touch_id uuid not null references coordinator_touch (id) on delete cascade,
  site_id text not null,
  channel text not null,
  to_ref text not null,
  body text not null,
  status text not null default 'queued',
  provider text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create table if not exists sync_state (
  site_id text not null,
  resource text not null,
  high_water_mark timestamptz,
  last_run_at timestamptz,
  primary key (site_id, resource)
);

-- RLS on, scoped by site_id. Real policies bind to auth once real auth lands;
-- the service role (used by the sync job and server actions) bypasses RLS.
alter table treatment_opportunity enable row level security;
alter table coordinator_touch enable row level security;
alter table outbox enable row level security;
alter table sync_state enable row level security;
```

- [ ] **Step 2: Apply the migration** to the Supabase project (via the Supabase MCP `apply_migration`, the SQL editor, or `supabase db push`). Verify the four tables exist.

- [ ] **Step 3: Create the Supabase server clients**

```ts
// src/lib/supabase/server.ts
import { createClient } from "@supabase/supabase-js";

export function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

export function anonServerClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } },
  );
}
```

- [ ] **Step 4: Typecheck + commit** (migration + client; never commit `.env.local`)

```bash
npx tsc --noEmit
git add supabase/migrations/0001_treatment_coordinator.sql src/lib/supabase/server.ts
git commit -m "feat: supabase schema + server clients for coordinator"
```

---

## Task 8: Repository (Supabase reads/writes)

**Files:**
- Create: `src/lib/coordinator/repository.ts`

Maps DB snake_case rows to/from the camelCase domain types. One responsibility: persistence. Functions: `upsertOpportunities`, `listOpportunities({ siteId, statuses })`, `getOpportunity(id)`, `insertTouch`, `listTouches(opportunityId)`, `approveTouch`, `enqueueOutbox`, `markTouchSent`, `setFinancePresented`, `getSyncState`, `setSyncState`.

- [ ] **Step 1: Implement the repository** (row mappers + the functions above, using `serviceClient()`; each returns typed domain objects). Keep all column names matching the migration exactly.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/coordinator/repository.ts
git commit -m "feat: coordinator supabase repository"
```

---

## Task 9: Sync route + live sandbox calibration

**Files:**
- Create: `src/app/api/sync/dentally/route.ts`

- [ ] **Step 1: Implement the sync route** (`POST`): for each `site_id` in the client, read `sync_state` high-water mark, page `listTreatmentPlans` with `updated_after`, fetch outstanding per patient, `toOpportunity(...)`, `rankOpportunities(...)`, `upsertOpportunities(...)`, advance `sync_state`. Return a JSON summary `{ pulled, upserted, siteId }`. Idempotent (upsert by `id`).

- [ ] **Step 2: Calibrate against the live sandbox.** With `.env.local` set, call `POST /api/sync/dentally`. Inspect the real Dentally JSON; fix the exact paths/param names in `DentallyClient` and field names in `normalise.ts` to match actual sandbox responses. Re-run until `treatment_opportunity` is populated.

Run: `curl -X POST http://localhost:3000/api/sync/dentally`
Expected: `{ "upserted": <n>, ... }` and rows visible in Supabase.

- [ ] **Step 3: Verify idempotency** — run the sync twice; row count stable, no duplicates, high-water mark advanced.

- [ ] **Step 4: Commit**

```bash
git add src/lib/dentally/client.ts src/lib/dentally/normalise.ts src/app/api/sync/dentally/route.ts
git commit -m "feat: dentally sync route, calibrated against sandbox"
```

---

## Task 10: Coordinator action route (draft / approve / send-stub / book)

**Files:**
- Create: `src/app/api/coordinator/[action]/route.ts`

- [ ] **Step 1: Implement the action route** (`POST /api/coordinator/[action]`):
  - `draft`: load opportunity, `draftOutreach(...)`, `insertTouch(status:"draft", draftedBy:"claude")`, return body + rationale.
  - `approve`: `approveTouch(touchId, approver)` then `enqueueOutbox(...)`.
  - `send`: stub adapter — mark outbox `sent`, `provider:"stub"`, `markTouchSent`, stamp `last_touch_at` on the opportunity. Respect consent for the channel; refuse if not consented.
  - `book`: `DentallyClient.createAppointment(...)` with `booked_via_api: true`; on success record a touch and update status.
  - Auto-send rule: if `amount_outstanding < COORDINATOR_AUTO_SEND_THRESHOLD`, `draft` may immediately approve+enqueue; otherwise it stays `draft`.

- [ ] **Step 2: Typecheck + smoke test** each action with `curl` against a seeded opportunity. Confirm a high-value opportunity stays `draft` and a low-value one auto-queues.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/coordinator/
git commit -m "feat: coordinator actions (draft, approve, send-stub, book)"
```

---

## Task 11: UI — worklist + opportunity detail

**Files:**
- Modify: `src/app/c/[client]/treatment-coordinator/page.tsx` (replace placeholder)
- Create: `src/components/client/coordinator/worklist.tsx`, `opportunity-drawer.tsx`, `draft-editor.tsx`

- [ ] **Step 1: Build the page** (server component): read opportunities via the repository for the client's sites, ranked. Header `StatCard`s: total recoverable value (sum outstanding), open opportunities, recovered-to-date (sum sent touches' opportunity value or completed), average days stalled. Render `<Worklist>`.

- [ ] **Step 2: Build `Worklist`** ("use client"): `DataTable` over opportunities (priority, patient, treatment, planned, outstanding, days stalled, last touch via `relativeTime`, status `StatusPill`). Row click opens `<OpportunityDrawer>`. Filter by status; site filter reuses the topbar switcher.

- [ ] **Step 3: Build `OpportunityDrawer` + `DraftEditor`**: show plan + outstanding, "why now" rationale; a channel selector + editable textarea seeded by calling `POST /api/coordinator/draft`; Approve/Send buttons calling the action route; touch-history timeline; "Book next step" calling `book`. Loading + empty + error states. No em-dashes in any copy.

- [ ] **Step 4: Verify build + typecheck**

Run: `npx tsc --noEmit && npm run build`
Expected: clean build; route `/c/[client]/treatment-coordinator` present.

- [ ] **Step 5: Manual E2E via preview** (preview MCP): worklist ranked by value; open an opportunity; Claude draft loads; edit + approve moves it to outbox and stamps last touch; "book next step" creates a sandbox appointment.

- [ ] **Step 6: Commit**

```bash
git add src/app/c/[client]/treatment-coordinator/ src/components/client/coordinator/
git commit -m "feat: treatment coordinator UI (worklist + draft-and-approve)"
```

---

## Task 12: Full test + verification pass

- [ ] **Step 1: Run all unit tests**

Run: `npx vitest run`
Expected: all suites pass (scoring, normalise, draft, client).

- [ ] **Step 2: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 3: Confirm spec acceptance** against `docs/superpowers/specs/2026-06-18-treatment-coordinator-design.md`: opportunities synced + ranked by value; draft-and-approve works with threshold; book writes back to Dentally; no clinical fields stored; no em-dashes in copy; auth still mock; sending still stubbed.

- [ ] **Step 4: Final commit (if anything outstanding)**

```bash
git add -A
git commit -m "test: treatment coordinator verification pass"
```

---

## Notes for the implementer

- Dentally exact endpoint paths and field names are the main unknown; Task 9 Step 2 is where they get pinned against the live sandbox. Everything upstream is structured so only strings in `client.ts` / `normalise.ts` change.
- Never commit `.env.local`. Secrets stay local.
- `site_id` on every row and query. Multi-site by default.
- Respect `consent` before any (stub) send.
- Keep files focused: pure logic in `lib/coordinator` and `lib/dentally`; persistence in `repository.ts`; I/O at the route layer; presentation in components.
