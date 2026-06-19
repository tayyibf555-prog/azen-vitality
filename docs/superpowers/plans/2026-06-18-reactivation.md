# Reactivation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Reactivation module: sync dormant patients from Dentally into Supabase across three cohorts (lapsed, overdue recall, stalled plan), rank by a blended value-and-winnability score, run a multi-step Claude-drafted cadence in a draft-and-approve flow, and book the re-engagement appointment back into Dentally.

**Architecture:** Reuses the Treatment Coordinator (TC) infrastructure. Sync Dentally (system of record, polled with `updated_after`) into lean Supabase `reactivation_target` snapshots plus module-owned tables (`reactivation_cadence`, `reactivation_touch`, `reactivation_outbox`); `sync_state` is shared with TC. Pure logic (scoring, cadence math, normalisation, prompt assembly) is TDD-tested; the extended `DentallyClient` is tested against mocked fetch. The UI reads/ranks from Supabase, drafts via Claude, advances the cadence via a manually-triggered sweep endpoint, and writes appointments back to Dentally. Auth stays mock; message sending is a stub adapter.

**Tech Stack:** Next.js 16 (App Router), TypeScript strict, Tailwind v4, `@supabase/supabase-js`, `@anthropic-ai/sdk`, Vitest. All already installed by the TC build. Existing foundation primitives in `src/components/primitives`; TC modules in `src/lib/coordinator` and `src/lib/dentally` are the templates.

Spec: `docs/superpowers/specs/2026-06-18-reactivation-design.md`

---

## Deviations from the spec (carried in, deliberate)

- **Dedicated `reactivation_outbox`.** The spec said reuse the shared `outbox`. On disk, `outbox.touch_id` has a foreign key to `coordinator_touch (id) on delete cascade`, so reactivation touches cannot live in it without breaking that cascade. Reactivation gets an identical-shape `reactivation_outbox` (FK to `reactivation_touch`). The send-stub adapter pattern is shared; the table is per-module. Lower risk, preserves isolation.
- **`sync_state` is reused** (keyed by `site_id, resource`), with `resource = 'reactivation'`. `getSyncState` / `setSyncState` are imported from `src/lib/coordinator/repository.ts` (DRY; they are resource-generic).
- Migrations mirror TC's split: `0003` (schema + enable RLS), `0004` (permissive pilot policies).

---

## File structure (created/modified)

- Create `src/lib/reactivation/types.ts` — domain types (ReactivationTarget, ReactivationCadence, ReactivationTouch, enums).
- Create `src/lib/reactivation/cadence.ts` — pure cadence definition + `stepDef` / `nextStep` / `dueAt` / `advanceAfter`.
- Create `src/lib/reactivation/scoring.ts` — pure `reactivationScore()` + `rankTargets()`.
- Create `src/lib/reactivation/normalise.ts` — pure `toReactivationTarget()` (cohort derivation + dedup + recoverable-value fallback; ops fields only).
- Create `src/lib/reactivation/draft.ts` — cohort-aware Claude prompt assembly + `draftReactivation()` caller.
- Create `src/lib/reactivation/repository.ts` — typed Supabase reads/writes for the reactivation tables.
- Modify `src/lib/dentally/client.ts` — add `listPatients`, `getPatientAppointments`, `getPatientInvoices`.
- Modify `src/app/api/mock-dentally/_fixtures.ts` + add `v1/patients` (list), `v1/appointments` (GET), `v1/invoices` mock routes — dormant-book fixtures and list endpoints (the calibration target; no live sandbox key yet).
- Create `supabase/migrations/0003_reactivation.sql` — schema + enable RLS.
- Create `supabase/migrations/0004_reactivation_pilot_rls.sql` — permissive pilot policies + grants.
- Create `src/app/api/sync/reactivation/route.ts` — sync endpoint.
- Create `src/app/api/reactivation/sweep/route.ts` — cadence sweep endpoint.
- Create `src/app/api/reactivation/[action]/route.ts` — enrol / draft / approve / send / pause / resume / book.
- Modify `src/app/c/[client]/reactivation/page.tsx` — replace placeholder; worklist + stats.
- Create `src/components/client/reactivation/worklist.tsx`, `target-drawer.tsx`, `cadence-timeline.tsx`, `draft-editor.tsx`.
- Modify `src/lib/nav.ts` — flip `reactivation` status to `live`.
- Modify `.env.example` — add the five reactivation env vars.

---

## Task 1: Env additions

**Files:**
- Modify: `.env.example`
- Modify (gitignored): `.env.local`

- [ ] **Step 1: Append the reactivation vars to `.env.example`**

Add these lines to the end of `.env.example`:

```
REACTIVATION_LAPSE_MONTHS=18
REACTIVATION_RECALL_GRACE_DAYS=60
REACTIVATION_STALE_DAYS=120
REACTIVATION_BASELINE_VALUE=80
REACTIVATION_AUTO_SEND_THRESHOLD=250
```

- [ ] **Step 2: Mirror the same five lines into `.env.local`** (real values; do NOT commit `.env.local`). The Supabase, Dentally, and Anthropic vars from the TC build are already present and reused.

- [ ] **Step 3: Commit** (`.env.example` only)

```bash
git add .env.example
git commit -m "chore: reactivation env vars"
```

---

## Task 2: Module domain types

**Files:**
- Create: `src/lib/reactivation/types.ts`

- [ ] **Step 1: Write the types** (no test; consumed by later tasks)

```ts
export type ReactivationReason = "lapsed" | "overdue_recall" | "stalled_plan";
export type ReactivationStatus = "dormant" | "in_cadence" | "converted" | "exhausted";
export type CadenceStatus =
  | "active"
  | "awaiting_approval"
  | "paused"
  | "converted"
  | "exhausted";
export type TouchChannel = "sms" | "email" | "whatsapp";
export type TouchStatus = "draft" | "approved" | "queued" | "sent" | "failed";
export type DraftedBy = "claude" | "human";

export interface ReactivationTarget {
  id: string;                  // `${siteId}:${dentallyPatientId}`
  siteId: string;
  dentallyPatientId: string;
  patientName: string;
  reason: ReactivationReason;
  dentallyPlanId: string | null;
  treatment: string | null;
  recoverableValue: number;    // GBP
  lastVisitAt: string | null;  // ISO
  recallDueAt: string | null;  // ISO
  priorAttempts: number;
  status: ReactivationStatus;
  reactivationScore: number;
  consent: { sms: boolean; email: boolean; marketing: boolean };
  updatedFromDentallyAt: string;
}

export interface ReactivationCadence {
  id: string;
  targetId: string;
  siteId: string;
  currentStep: number;         // last completed step; 0 = enrolled, none sent
  status: CadenceStatus;
  nextDueAt: string | null;    // ISO
  startedAt: string;
  endedAt: string | null;
  updatedAt: string;
}

export interface ReactivationTouch {
  id: string;
  targetId: string;
  cadenceId: string;
  siteId: string;
  step: number;
  channel: TouchChannel;
  direction: "outbound" | "inbound";
  body: string;
  draftedBy: DraftedBy;
  status: TouchStatus;
  approvedBy: string | null;
  createdAt: string;
  sentAt: string | null;
}

export interface ReactivationOutboxItem {
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
git add src/lib/reactivation/types.ts
git commit -m "feat: reactivation domain types"
```

---

## Task 3: Cadence engine (pure, TDD)

**Files:**
- Create: `src/lib/reactivation/cadence.ts`
- Test: `src/lib/reactivation/cadence.test.ts`

The cadence is an ordered list of steps. `currentStep` on a cadence is the last completed step (0 = enrolled, none sent). `waitDays` is the gap before a step relative to the previous step's send time (step 1 = 0, fires immediately on enrolment).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import {
  DEFAULT_CADENCE,
  stepDef,
  nextStep,
  dueAt,
  advanceAfter,
} from "./cadence";

const NOW = new Date("2026-06-18T09:00:00Z");

describe("cadence definition", () => {
  it("has three ordered steps ending in a final touch", () => {
    expect(DEFAULT_CADENCE.map((s) => s.step)).toEqual([1, 2, 3]);
    expect(DEFAULT_CADENCE[0].waitDays).toBe(0);
    expect(DEFAULT_CADENCE[2].purpose).toBe("final");
  });
});

describe("nextStep", () => {
  it("returns step 1 when nothing sent yet", () => {
    expect(nextStep(0)?.step).toBe(1);
  });
  it("returns null after the last step (exhausted)", () => {
    expect(nextStep(3)).toBeNull();
  });
});

describe("dueAt", () => {
  it("adds the step waitDays to the anchor time", () => {
    const step2 = stepDef(2)!;
    const due = dueAt(step2, NOW);
    const expected = new Date(NOW.getTime() + step2.waitDays * 86_400_000).toISOString();
    expect(due).toBe(expected);
  });
});

describe("advanceAfter", () => {
  it("schedules the next step while more remain", () => {
    const a = advanceAfter(1, NOW);
    expect(a.status).toBe("active");
    expect(a.currentStep).toBe(1);
    expect(a.nextDueAt).not.toBeNull();
    expect(a.endedAt).toBeNull();
  });
  it("exhausts after the final step", () => {
    const a = advanceAfter(3, NOW);
    expect(a.status).toBe("exhausted");
    expect(a.nextDueAt).toBeNull();
    expect(a.endedAt).toBe(NOW.toISOString());
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `npx vitest run src/lib/reactivation/cadence.test.ts`
Expected: FAIL ("DEFAULT_CADENCE is not defined" / imports missing).

- [ ] **Step 3: Implement**

```ts
import type { TouchChannel } from "./types";

export interface CadenceStep {
  step: number;                       // 1-based
  channel: TouchChannel;
  waitDays: number;                   // gap before this step (step 1 = 0)
  purpose: "nudge" | "offer" | "final";
}

export const DEFAULT_CADENCE: CadenceStep[] = [
  { step: 1, channel: "sms", waitDays: 0, purpose: "nudge" },
  { step: 2, channel: "email", waitDays: 5, purpose: "offer" },
  { step: 3, channel: "sms", waitDays: 7, purpose: "final" },
];

export function stepDef(step: number, def: CadenceStep[] = DEFAULT_CADENCE): CadenceStep | null {
  return def.find((s) => s.step === step) ?? null;
}

/** The next step to run given the last completed step. null = exhausted. */
export function nextStep(currentStep: number, def: CadenceStep[] = DEFAULT_CADENCE): CadenceStep | null {
  return def.find((s) => s.step === currentStep + 1) ?? null;
}

/** ISO due time for a step, anchored to `from` (previous send time or enrolment). */
export function dueAt(step: CadenceStep, from: Date): string {
  return new Date(from.getTime() + step.waitDays * 86_400_000).toISOString();
}

export interface CadenceAdvance {
  currentStep: number;
  status: "active" | "exhausted";
  nextDueAt: string | null;
  endedAt: string | null;
}

/** Cadence position after `sentStep` has been sent at `now`. */
export function advanceAfter(
  sentStep: number,
  now: Date,
  def: CadenceStep[] = DEFAULT_CADENCE,
): CadenceAdvance {
  const upcoming = nextStep(sentStep, def);
  if (upcoming) {
    return { currentStep: sentStep, status: "active", nextDueAt: dueAt(upcoming, now), endedAt: null };
  }
  return { currentStep: sentStep, status: "exhausted", nextDueAt: null, endedAt: now.toISOString() };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run src/lib/reactivation/cadence.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/lib/reactivation/cadence.ts src/lib/reactivation/cadence.test.ts
git commit -m "feat: reactivation cadence engine (sequence + advance)"
```

---

## Task 4: Ranking (pure, TDD)

**Files:**
- Create: `src/lib/reactivation/scoring.ts`
- Test: `src/lib/reactivation/scoring.test.ts`

Scoring formula (documented): `reactivationScore = recoverableValue * winnability`, where `recoverableValue` is precomputed on the target (Task 5), and `winnability = recencyWeight * attemptsPenalty`, clamped to `[0.25, 1.5]`. `recencyWeight` favours patients who lapsed/are overdue more recently (anchored on `recallDueAt` else `lastVisitAt`, decays over 365 days, floor 0.5, fresh 1.5). `attemptsPenalty` falls 0.2 per prior attempt (floor 0.5). Recoverable value dominates, so a large stalled plan always outranks a tiny checkup.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { reactivationScore, rankTargets } from "./scoring";
import type { ReactivationTarget } from "./types";

const NOW = new Date("2026-06-18T09:00:00Z");

function target(p: Partial<ReactivationTarget>): ReactivationTarget {
  return {
    id: "t", siteId: "s", dentallyPatientId: "p", patientName: "Test",
    reason: "lapsed", dentallyPlanId: null, treatment: null,
    recoverableValue: 1000, lastVisitAt: "2026-01-01T00:00:00Z", recallDueAt: null,
    priorAttempts: 0, status: "dormant", reactivationScore: 0,
    consent: { sms: true, email: true, marketing: true },
    updatedFromDentallyAt: NOW.toISOString(), ...p,
  };
}

describe("reactivationScore", () => {
  it("ranks higher recoverable value above lower, all else equal", () => {
    const big = reactivationScore(target({ recoverableValue: 4000 }), NOW);
    const small = reactivationScore(target({ recoverableValue: 1000 }), NOW);
    expect(big).toBeGreaterThan(small);
  });

  it("favours a more recently lapsed patient over a long-gone one", () => {
    const recent = reactivationScore(target({ lastVisitAt: "2026-05-01T00:00:00Z" }), NOW);
    const old = reactivationScore(target({ lastVisitAt: "2024-01-01T00:00:00Z" }), NOW);
    expect(recent).toBeGreaterThan(old);
  });

  it("penalises more prior attempts", () => {
    const fresh = reactivationScore(target({ priorAttempts: 0 }), NOW);
    const tired = reactivationScore(target({ priorAttempts: 3 }), NOW);
    expect(fresh).toBeGreaterThan(tired);
  });

  it("a large stalled plan outranks a tiny fresh checkup", () => {
    const plan = reactivationScore(
      target({ recoverableValue: 5000, priorAttempts: 2, lastVisitAt: "2024-06-01T00:00:00Z" }),
      NOW,
    );
    const checkup = reactivationScore(
      target({ recoverableValue: 80, priorAttempts: 0, lastVisitAt: "2026-06-01T00:00:00Z" }),
      NOW,
    );
    expect(plan).toBeGreaterThan(checkup);
  });
});

describe("rankTargets", () => {
  it("sorts descending by score and stamps reactivationScore", () => {
    const ranked = rankTargets(
      [target({ id: "a", recoverableValue: 200 }), target({ id: "b", recoverableValue: 5000 })],
      NOW,
    );
    expect(ranked.map((t) => t.id)).toEqual(["b", "a"]);
    expect(ranked[0].reactivationScore).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `npx vitest run src/lib/reactivation/scoring.test.ts`
Expected: FAIL ("reactivationScore is not a function").

- [ ] **Step 3: Implement**

```ts
import type { ReactivationTarget } from "./types";

const DAY = 86_400_000;

export function winnability(t: ReactivationTarget, now: Date): number {
  const anchorIso = t.recallDueAt ?? t.lastVisitAt;
  const sinceDays = anchorIso
    ? Math.max(0, (now.getTime() - new Date(anchorIso).getTime()) / DAY)
    : 365;
  const recencyWeight = Math.max(0.5, 1.5 - sinceDays / 365); // 1.5 fresh .. 0.5 old
  const attemptsPenalty = Math.max(0.5, 1 - t.priorAttempts * 0.2);
  const raw = recencyWeight * attemptsPenalty;
  return Math.min(1.5, Math.max(0.25, raw));
}

export function reactivationScore(t: ReactivationTarget, now: Date): number {
  return t.recoverableValue * winnability(t, now);
}

export function rankTargets(items: ReactivationTarget[], now: Date): ReactivationTarget[] {
  return items
    .map((t) => ({ ...t, reactivationScore: reactivationScore(t, now) }))
    .sort((a, b) => b.reactivationScore - a.reactivationScore);
}
```

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run src/lib/reactivation/scoring.test.ts`
Expected: PASS (all 5).

- [ ] **Step 5: Commit**

```bash
git add src/lib/reactivation/scoring.ts src/lib/reactivation/scoring.test.ts
git commit -m "feat: blended value-and-winnability ranking for reactivation"
```

---

## Task 5: Cohort normaliser (pure, TDD)

**Files:**
- Create: `src/lib/reactivation/normalise.ts`
- Test: `src/lib/reactivation/normalise.test.ts`

Maps a dormant-patient bundle into a `ReactivationTarget`, or `null` if the patient is not a reactivation target. Derives `reason` by priority `stalled_plan > overdue_recall > lapsed`:
- **stalled_plan** — has an open plan with `amountOutstanding > 0` accepted more than `staleDays` ago.
- **overdue_recall** — a dentist/hygienist recall date passed by more than `recallGraceDays`, and no future booking.
- **lapsed** — `archived_reason === 'lapsed'`, OR no visit in `lapseMonths` and no future booking.

`recoverableValue` fallback chain: outstanding plan value (stalled_plan) -> historic spend -> baseline. Only whitelisted ops fields are copied (no clinical data).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { toReactivationTarget, type ReactivationInput } from "./normalise";

const NOW = new Date("2026-06-18T09:00:00Z");

function base(p: Partial<ReactivationInput> = {}): ReactivationInput {
  return {
    siteId: "site-cc",
    patient: {
      id: "123", first_name: "Sarah", last_name: "Lindqvist",
      use_sms: true, use_email: false, marketing: 1,
      archived: false, archived_reason: null,
      dentist_recall_date: null, hygienist_recall_date: null,
    },
    lastVisitAt: "2024-06-01T00:00:00Z",
    futureBookingExists: false,
    plan: null,
    amountOutstanding: 0,
    historicSpend: 600,
    lastTouchAt: null,
    ...p,
  };
}

describe("toReactivationTarget", () => {
  it("maps core fields, GBP value and consent", () => {
    const t = toReactivationTarget(base(), NOW)!;
    expect(t.dentallyPatientId).toBe("123");
    expect(t.patientName).toBe("Sarah Lindqvist");
    expect(t.consent).toEqual({ sms: true, email: false, marketing: true });
    expect(t.id).toBe("site-cc:123");
  });

  it("classifies a long-gone patient as lapsed and falls back to historic spend", () => {
    const t = toReactivationTarget(base(), NOW)!;
    expect(t.reason).toBe("lapsed");
    expect(t.recoverableValue).toBe(600);
  });

  it("uses the baseline value when there is no plan and no historic spend", () => {
    const t = toReactivationTarget(base({ historicSpend: 0 }), NOW)!;
    expect(t.recoverableValue).toBe(80);
  });

  it("classifies an open, cold, outstanding plan as stalled_plan with outstanding value", () => {
    const t = toReactivationTarget(
      base({
        plan: { id: "pl-9", name: "Invisalign full arch", planned_private_treatment_value: 3400, accepted_at: "2026-01-01T00:00:00Z" },
        amountOutstanding: 3400,
      }),
      NOW,
    )!;
    expect(t.reason).toBe("stalled_plan");
    expect(t.recoverableValue).toBe(3400);
    expect(t.treatment).toBe("Invisalign full arch");
    expect(t.dentallyPlanId).toBe("pl-9");
  });

  it("classifies a long-overdue recall (no future booking) as overdue_recall", () => {
    const t = toReactivationTarget(
      base({
        lastVisitAt: "2026-05-01T00:00:00Z",
        patient: { ...base().patient, dentist_recall_date: "2026-01-01T00:00:00Z" },
      }),
      NOW,
    )!;
    expect(t.reason).toBe("overdue_recall");
    expect(t.recallDueAt).toBe("2026-01-01T00:00:00Z");
  });

  it("returns null when the patient is active and has none of the three signals", () => {
    const t = toReactivationTarget(
      base({ lastVisitAt: "2026-06-01T00:00:00Z", futureBookingExists: true }),
      NOW,
    );
    expect(t).toBeNull();
  });

  it("does not copy any field outside the whitelist (no clinical data)", () => {
    const dirty = base();
    (dirty.patient as Record<string, unknown>).medical_notes = "SECRET";
    const t = toReactivationTarget(dirty, NOW)!;
    expect(JSON.stringify(t)).not.toContain("SECRET");
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `npx vitest run src/lib/reactivation/normalise.test.ts`
Expected: FAIL ("toReactivationTarget is not a function").

- [ ] **Step 3: Implement**

```ts
import type { ReactivationReason, ReactivationTarget } from "./types";

export interface ReactivationConfig {
  lapseMonths: number;
  recallGraceDays: number;
  staleDays: number;
  baselineValue: number;
}

export const DEFAULT_CONFIG: ReactivationConfig = {
  lapseMonths: 18,
  recallGraceDays: 60,
  staleDays: 120,
  baselineValue: 80,
};

export interface ReactivationInput {
  siteId: string;
  // Fields mirror Dentally's real patient object (top-level consent booleans,
  // marketing as 0/1 or boolean, archived flags, recall dates).
  patient: {
    id: string;
    first_name: string;
    last_name: string;
    use_sms?: boolean;
    use_email?: boolean;
    marketing?: number | boolean;
    archived?: boolean;
    archived_reason?: string | null;
    dentist_recall_date?: string | null;
    hygienist_recall_date?: string | null;
  };
  lastVisitAt: string | null;          // most recent appointment date (past)
  futureBookingExists: boolean;        // any appointment in the future
  plan: { id: string; name: string; planned_private_treatment_value: number; accepted_at: string } | null;
  amountOutstanding: number;           // outstanding on the open plan (0 if none)
  historicSpend: number;               // sum of paid invoices, lifetime
  lastTouchAt: string | null;
}

const DAY = 86_400_000;

function daysBetween(fromIso: string, now: Date): number {
  return (now.getTime() - new Date(fromIso).getTime()) / DAY;
}

/** The recall date that is most overdue (earliest past date among the two set). */
function overdueRecallDate(i: ReactivationInput, now: Date, graceDays: number): string | null {
  const candidates = [i.patient.dentist_recall_date, i.patient.hygienist_recall_date]
    .filter((d): d is string => typeof d === "string" && d !== "")
    .filter((d) => daysBetween(d, now) > graceDays);
  if (candidates.length === 0) return null;
  return candidates.sort()[0]; // earliest = most overdue
}

function deriveReason(i: ReactivationInput, now: Date, cfg: ReactivationConfig): ReactivationReason | null {
  // Priority: stalled_plan > overdue_recall > lapsed.
  if (i.plan && i.amountOutstanding > 0 && daysBetween(i.plan.accepted_at, now) > cfg.staleDays) {
    return "stalled_plan";
  }
  if (!i.futureBookingExists && overdueRecallDate(i, now, cfg.recallGraceDays)) {
    return "overdue_recall";
  }
  const lapseDays = cfg.lapseMonths * 30;
  const noRecentVisit = !i.lastVisitAt || daysBetween(i.lastVisitAt, now) > lapseDays;
  if (i.patient.archived_reason === "lapsed" || (noRecentVisit && !i.futureBookingExists)) {
    return "lapsed";
  }
  return null;
}

function deriveValue(i: ReactivationInput, reason: ReactivationReason, cfg: ReactivationConfig): number {
  if (reason === "stalled_plan" && i.amountOutstanding > 0) return i.amountOutstanding;
  if (i.historicSpend > 0) return i.historicSpend;
  return cfg.baselineValue;
}

export function toReactivationTarget(
  i: ReactivationInput,
  now: Date,
  cfg: ReactivationConfig = DEFAULT_CONFIG,
): ReactivationTarget | null {
  const reason = deriveReason(i, now, cfg);
  if (!reason) return null;

  const recallDueAt = overdueRecallDate(i, now, cfg.recallGraceDays);

  return {
    id: `${i.siteId}:${i.patient.id}`,
    siteId: i.siteId,
    dentallyPatientId: i.patient.id,
    patientName: `${i.patient.first_name} ${i.patient.last_name}`.trim(),
    reason,
    dentallyPlanId: reason === "stalled_plan" && i.plan ? i.plan.id : null,
    treatment: reason === "stalled_plan" && i.plan ? i.plan.name : null,
    recoverableValue: deriveValue(i, reason, cfg),
    lastVisitAt: i.lastVisitAt,
    recallDueAt,
    priorAttempts: 0,
    status: "dormant",
    reactivationScore: 0,
    consent: {
      sms: Boolean(i.patient.use_sms),
      email: Boolean(i.patient.use_email),
      marketing: Boolean(i.patient.marketing),
    },
    updatedFromDentallyAt: now.toISOString(),
  };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run src/lib/reactivation/normalise.test.ts`
Expected: PASS (all 7).

- [ ] **Step 5: Commit**

```bash
git add src/lib/reactivation/normalise.ts src/lib/reactivation/normalise.test.ts
git commit -m "feat: reactivation cohort normaliser (ops fields only)"
```

---

## Task 6: Extend DentallyClient (mocked-fetch TDD)

**Files:**
- Modify: `src/lib/dentally/client.ts`
- Test: `src/lib/dentally/client-reactivation.test.ts`

Add three read methods for the dormant book, reusing the existing private `get<T>` (auth, User-Agent, base URL, error guard). Exact paths/params are confirmed against the mock in Task 11; the call sites do not change after that.

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

describe("DentallyClient dormant-book reads", () => {
  it("listPatients sends auth + User-Agent to the configured base URL", async () => {
    const fetchMock = mockFetch({ patients: [] });
    const c = new DentallyClient({ apiKey: "k", baseUrl: "https://api.sandbox.dentally.co", fetchImpl: fetchMock });
    await c.listPatients({ siteId: "site-cc", page: 1 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("https://api.sandbox.dentally.co");
    expect(String(url)).toContain("site_id=site-cc");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer k");
    expect((init.headers as Record<string, string>)["User-Agent"]).toBeTruthy();
  });

  it("getPatientAppointments and getPatientInvoices query by patient id", async () => {
    const fetchMock = mockFetch({ appointments: [] });
    const c = new DentallyClient({ apiKey: "k", baseUrl: "https://x", fetchImpl: fetchMock });
    await c.getPatientAppointments("123");
    await c.getPatientInvoices("123");
    expect(String(fetchMock.mock.calls[0][0])).toContain("patient_id=123");
    expect(String(fetchMock.mock.calls[1][0])).toContain("patient_id=123");
  });

  it("throws a DentallyError on non-2xx", async () => {
    const fetchMock = mockFetch({ error: "nope" }, false, 401);
    const c = new DentallyClient({ apiKey: "k", baseUrl: "https://x", fetchImpl: fetchMock });
    await expect(c.listPatients({ siteId: "s" })).rejects.toThrow(/401/);
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `npx vitest run src/lib/dentally/client-reactivation.test.ts`
Expected: FAIL ("listPatients is not a function").

- [ ] **Step 3: Implement** — add to `src/lib/dentally/client.ts`. Add the args interface near `ListPlansArgs`:

```ts
export interface ListPatientsArgs { siteId: string; updatedAfter?: string; page?: number; perPage?: number; }
```

And add these methods inside the `DentallyClient` class (next to `getAccountOutstanding`):

```ts
  listPatients(a: ListPatientsArgs) {
    return this.get<{ patients: unknown[] }>("/v1/patients", {
      site_id: a.siteId, updated_after: a.updatedAfter, page: a.page ?? 1, per_page: a.perPage ?? 100,
    });
  }
  getPatientAppointments(patientId: string) {
    return this.get<{ appointments: unknown[] }>("/v1/appointments", { patient_id: patientId });
  }
  getPatientInvoices(patientId: string) {
    return this.get<{ invoices: unknown[] }>("/v1/invoices", { patient_id: patientId });
  }
```

- [ ] **Step 4: Run, verify pass** (both the new and the existing client tests)

Run: `npx vitest run src/lib/dentally/client.test.ts src/lib/dentally/client-reactivation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dentally/client.ts src/lib/dentally/client-reactivation.test.ts
git commit -m "feat: dentally client reads for the dormant book"
```

---

## Task 7: Cohort-aware Claude draft (pure prompt, TDD) + caller

**Files:**
- Create: `src/lib/reactivation/draft.ts`
- Test: `src/lib/reactivation/draft.test.ts`

`buildDraftPrompt(target, channel, step)` returns `{ system, user }`. The system prompt enforces: warm advisor-to-patient tone, lead with first name, one clear next step, under ~90 words, GBP (£), and NO em-dashes. The cohort line branches on `target.reason`; the tone line branches on `step.purpose`. `draftReactivation()` calls Anthropic with that prompt and returns a cohort-appropriate rationale; tested separately with a mocked client.

- [ ] **Step 1: Write the failing test (prompt assembly only)**

```ts
import { describe, it, expect } from "vitest";
import { buildDraftPrompt } from "./draft";
import { stepDef } from "./cadence";
import type { ReactivationTarget } from "./types";

function target(p: Partial<ReactivationTarget>): ReactivationTarget {
  return {
    id: "t", siteId: "s", dentallyPatientId: "p", patientName: "Sarah Lindqvist",
    reason: "stalled_plan", dentallyPlanId: "pl", treatment: "Invisalign full arch",
    recoverableValue: 3400, lastVisitAt: null, recallDueAt: null, priorAttempts: 0,
    status: "in_cadence", reactivationScore: 1,
    consent: { sms: true, email: true, marketing: true }, updatedFromDentallyAt: "x", ...p,
  };
}

describe("buildDraftPrompt", () => {
  it("forbids em-dashes and requires GBP in the system prompt", () => {
    const { system } = buildDraftPrompt(target({}), "sms", stepDef(1)!);
    expect(system).not.toContain("—"); // em-dash
    expect(system.toLowerCase()).toContain("no em-dash");
    expect(system).toContain("£");
  });

  it("includes patient, channel, step purpose and the stalled-plan value", () => {
    const { user, system } = buildDraftPrompt(target({}), "whatsapp", stepDef(2)!);
    expect(user).toContain("Sarah Lindqvist");
    expect(user).toContain("whatsapp");
    expect(user).toContain("3400");
    expect(user.toLowerCase()).toContain("offer");      // step 2 purpose
    expect(system.toLowerCase()).toContain("finance");  // stalled_plan branch
  });

  it("uses a checkup invitation for a lapsed patient, not finance", () => {
    const { system } = buildDraftPrompt(target({ reason: "lapsed", treatment: null, recoverableValue: 80 }), "sms", stepDef(1)!);
    expect(system.toLowerCase()).toContain("checkup");
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `npx vitest run src/lib/reactivation/draft.test.ts`
Expected: FAIL ("buildDraftPrompt is not a function").

- [ ] **Step 3: Implement**

```ts
import Anthropic from "@anthropic-ai/sdk";
import type { CadenceStep } from "./cadence";
import type { ReactivationReason, TouchChannel, ReactivationTarget } from "./types";
import { gbp } from "@/lib/utils";

const REASON_GUIDANCE: Record<ReactivationReason, string> = {
  lapsed:
    "This patient has not visited in a long time. Warmly invite them back for a checkup. Say we have missed them. Do not mention money.",
  overdue_recall:
    "This patient is overdue for their dental or hygiene recall. Remind them their recall is due and invite them to book it in.",
  stalled_plan:
    "This patient accepted treatment but did not finish it. Reference the treatment, mention the outstanding value in GBP using the £ symbol, and offer to discuss finance or a payment plan.",
};

const PURPOSE_TONE: Record<CadenceStep["purpose"], string> = {
  nudge: "This is a first, gentle nudge. Keep it short and friendly.",
  offer: "This is a follow up. Add a concrete reason to act now, such as a free checkup or a flexible payment plan.",
  final: "This is a final, polite touch. Make it easy to say yes and signal we will not keep chasing.",
};

export function buildDraftPrompt(t: ReactivationTarget, channel: TouchChannel, step: CadenceStep) {
  const system = [
    "You are a warm, professional patient coordinator for a UK dental practice.",
    "Write a short re-engagement message to a dormant patient.",
    REASON_GUIDANCE[t.reason],
    PURPOSE_TONE[step.purpose],
    "Rules:",
    "- Lead with the patient by first name.",
    "- Give one clear next step (book a checkup, a call, or an appointment).",
    "- Under 90 words. Friendly, not pushy.",
    "- Any money figure is in GBP using the £ symbol.",
    "- Use no em-dash characters anywhere. Use commas or full stops.",
    "- Plain text only, suitable for the requested channel.",
  ].join("\n");

  const user = [
    `Channel: ${channel}`,
    `Cadence step: ${step.step} (${step.purpose})`,
    `Patient: ${t.patientName}`,
    `Reason: ${t.reason}`,
    `Treatment: ${t.treatment ?? "none on file"}`,
    `Recoverable value (GBP): ${t.recoverableValue}`,
    `Last visit: ${t.lastVisitAt ?? "unknown"}`,
    `Recall due: ${t.recallDueAt ?? "n/a"}`,
  ].join("\n");

  return { system, user };
}

const REASON_RATIONALE: Record<ReactivationReason, (t: ReactivationTarget) => string> = {
  lapsed: (t) => `Lapsed patient, last visit ${t.lastVisitAt ?? "unknown"}. Invite back for a checkup.`,
  overdue_recall: (t) => `Recall overdue since ${t.recallDueAt ?? "unknown"}. Book the recall.`,
  stalled_plan: (t) => `${gbp(t.recoverableValue)} outstanding on ${t.treatment ?? "treatment"}. Re-present finance.`,
};

export interface DraftResult { body: string; rationale: string; }

export async function draftReactivation(
  t: ReactivationTarget,
  channel: TouchChannel,
  step: CadenceStep,
  client: Anthropic = new Anthropic(),
): Promise<DraftResult> {
  const { system, user } = buildDraftPrompt(t, channel, step);
  const rationale = REASON_RATIONALE[t.reason](t);
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

Run: `npx vitest run src/lib/reactivation/draft.test.ts`
Expected: PASS (all 3).

- [ ] **Step 5: Commit**

```bash
git add src/lib/reactivation/draft.ts src/lib/reactivation/draft.test.ts
git commit -m "feat: cohort-aware reactivation drafting (GBP, no em-dash)"
```

---

## Task 8: Supabase schema migration + RLS

**Files:**
- Create: `supabase/migrations/0003_reactivation.sql`
- Create: `supabase/migrations/0004_reactivation_pilot_rls.sql`

- [ ] **Step 1: Write `0003_reactivation.sql`**

```sql
-- 0003_reactivation.sql
-- Reactivation module schema. Site-scoped, operations-only (no clinical data).
-- Reuses the shared sync_state table from 0001 (resource = 'reactivation').

create table if not exists reactivation_target (
  id text primary key,
  site_id text not null,
  dentally_patient_id text not null,
  patient_name text not null,
  reason text not null,
  dentally_plan_id text,
  treatment text,
  recoverable_value numeric not null default 0,
  last_visit_at timestamptz,
  recall_due_at timestamptz,
  prior_attempts integer not null default 0,
  status text not null default 'dormant',
  reactivation_score numeric not null default 0,
  consent jsonb not null default '{}'::jsonb,
  updated_from_dentally_at timestamptz not null default now()
);
create index if not exists idx_react_target_site on reactivation_target (site_id);
create index if not exists idx_react_target_rank on reactivation_target (site_id, reactivation_score desc);

create table if not exists reactivation_cadence (
  id uuid primary key default gen_random_uuid(),
  target_id text not null references reactivation_target (id) on delete cascade,
  site_id text not null,
  current_step integer not null default 0,
  status text not null default 'active',
  next_due_at timestamptz,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists idx_react_cadence_target on reactivation_cadence (target_id);
create index if not exists idx_react_cadence_due on reactivation_cadence (status, next_due_at);

create table if not exists reactivation_touch (
  id uuid primary key default gen_random_uuid(),
  target_id text not null references reactivation_target (id) on delete cascade,
  cadence_id uuid references reactivation_cadence (id) on delete cascade,
  site_id text not null,
  step integer not null default 0,
  channel text not null,
  direction text not null default 'outbound',
  body text not null,
  drafted_by text not null,
  status text not null default 'draft',
  approved_by text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists idx_react_touch_target on reactivation_touch (target_id);

create table if not exists reactivation_outbox (
  id uuid primary key default gen_random_uuid(),
  touch_id uuid not null references reactivation_touch (id) on delete cascade,
  site_id text not null,
  channel text not null,
  to_ref text not null,
  body text not null,
  status text not null default 'queued',
  provider text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists idx_react_outbox_touch on reactivation_outbox (touch_id);

-- Shared sync_state (created in 0001). Created here too so this migration is
-- order-independent if reactivation is ever applied before the coordinator one.
create table if not exists sync_state (
  site_id text not null,
  resource text not null,
  high_water_mark timestamptz,
  last_run_at timestamptz,
  primary key (site_id, resource)
);

-- RLS on, scoped by site_id. Real policies bind to auth once real auth lands;
-- the service role (used by the sync/sweep jobs and server actions) bypasses RLS.
alter table reactivation_target enable row level security;
alter table reactivation_cadence enable row level security;
alter table reactivation_touch enable row level security;
alter table reactivation_outbox enable row level security;
```

- [ ] **Step 2: Write `0004_reactivation_pilot_rls.sql`** (mirror `0002_pilot_permissive_rls.sql`)

```sql
-- 0004_reactivation_pilot_rls.sql
--
-- PILOT ONLY. Permissive RLS so the public (anon/publishable) key can read/write
-- the reactivation tables before real Supabase auth + per-site policies exist.
--
-- SECURITY: temporary shortcut for the pilot demo on mock/fixture data only.
-- REPLACE every policy below with auth-bound, site-scoped policies before any
-- real patient data or production deployment.

grant usage on schema public to anon, authenticated;
grant all on reactivation_target, reactivation_cadence, reactivation_touch, reactivation_outbox to anon, authenticated;

create policy pilot_all_react_target on reactivation_target for all to anon, authenticated using (true) with check (true);
create policy pilot_all_react_cadence on reactivation_cadence for all to anon, authenticated using (true) with check (true);
create policy pilot_all_react_touch on reactivation_touch for all to anon, authenticated using (true) with check (true);
create policy pilot_all_react_outbox on reactivation_outbox for all to anon, authenticated using (true) with check (true);
```

- [ ] **Step 3: Apply both migrations** to the Supabase project (Supabase MCP `apply_migration`, the SQL editor, or `supabase db push`). Verify the four `reactivation_*` tables exist.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0003_reactivation.sql supabase/migrations/0004_reactivation_pilot_rls.sql
git commit -m "feat: reactivation supabase schema + pilot RLS"
```

---

## Task 9: Repository (Supabase reads/writes)

**Files:**
- Create: `src/lib/reactivation/repository.ts`

Maps DB snake_case rows to/from the camelCase domain types. One responsibility: persistence. Reuses `serviceClient()` and re-exports `getSyncState` / `setSyncState` from the coordinator repository.

- [ ] **Step 1: Implement the repository**

```ts
import { serviceClient } from "@/lib/supabase/server";
import type {
  CadenceStatus,
  DraftedBy,
  ReactivationCadence,
  ReactivationOutboxItem,
  ReactivationReason,
  ReactivationStatus,
  ReactivationTarget,
  ReactivationTouch,
  TouchChannel,
  TouchStatus,
} from "./types";

// Re-export shared sync_state helpers (DRY: identical, resource-generic).
export { getSyncState, setSyncState } from "@/lib/coordinator/repository";

// ---------------------------------------------------------------------------
// Row shapes.
// ---------------------------------------------------------------------------

interface TargetRow {
  id: string;
  site_id: string;
  dentally_patient_id: string;
  patient_name: string;
  reason: string;
  dentally_plan_id: string | null;
  treatment: string | null;
  recoverable_value: number | string;
  last_visit_at: string | null;
  recall_due_at: string | null;
  prior_attempts: number | string;
  status: string;
  reactivation_score: number | string;
  consent: { sms?: boolean; email?: boolean; marketing?: boolean } | null;
  updated_from_dentally_at: string;
}

interface CadenceRow {
  id: string;
  target_id: string;
  site_id: string;
  current_step: number | string;
  status: string;
  next_due_at: string | null;
  started_at: string;
  ended_at: string | null;
  updated_at: string;
}

interface TouchRow {
  id: string;
  target_id: string;
  cadence_id: string | null;
  site_id: string;
  step: number | string;
  channel: string;
  direction: string;
  body: string;
  drafted_by: string;
  status: string;
  approved_by: string | null;
  created_at: string;
  sent_at: string | null;
}

interface OutboxRow {
  id: string;
  touch_id: string;
  site_id: string;
  channel: string;
  to_ref: string;
  body: string;
  status: string;
  provider: string | null;
  created_at: string;
  sent_at: string | null;
}

function num(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return typeof v === "number" ? v : Number(v);
}

// ---------------------------------------------------------------------------
// Mappers.
// ---------------------------------------------------------------------------

function rowToTarget(r: TargetRow): ReactivationTarget {
  return {
    id: r.id,
    siteId: r.site_id,
    dentallyPatientId: r.dentally_patient_id,
    patientName: r.patient_name,
    reason: r.reason as ReactivationReason,
    dentallyPlanId: r.dentally_plan_id,
    treatment: r.treatment,
    recoverableValue: num(r.recoverable_value),
    lastVisitAt: r.last_visit_at,
    recallDueAt: r.recall_due_at,
    priorAttempts: num(r.prior_attempts),
    status: r.status as ReactivationStatus,
    reactivationScore: num(r.reactivation_score),
    consent: {
      sms: r.consent?.sms ?? false,
      email: r.consent?.email ?? false,
      marketing: r.consent?.marketing ?? false,
    },
    updatedFromDentallyAt: r.updated_from_dentally_at,
  };
}

function targetToRow(t: ReactivationTarget): TargetRow {
  return {
    id: t.id,
    site_id: t.siteId,
    dentally_patient_id: t.dentallyPatientId,
    patient_name: t.patientName,
    reason: t.reason,
    dentally_plan_id: t.dentallyPlanId,
    treatment: t.treatment,
    recoverable_value: t.recoverableValue,
    last_visit_at: t.lastVisitAt,
    recall_due_at: t.recallDueAt,
    prior_attempts: t.priorAttempts,
    status: t.status,
    reactivation_score: t.reactivationScore,
    consent: t.consent,
    updated_from_dentally_at: t.updatedFromDentallyAt,
  };
}

function rowToCadence(r: CadenceRow): ReactivationCadence {
  return {
    id: r.id,
    targetId: r.target_id,
    siteId: r.site_id,
    currentStep: num(r.current_step),
    status: r.status as CadenceStatus,
    nextDueAt: r.next_due_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    updatedAt: r.updated_at,
  };
}

function rowToTouch(r: TouchRow): ReactivationTouch {
  return {
    id: r.id,
    targetId: r.target_id,
    cadenceId: r.cadence_id ?? "",
    siteId: r.site_id,
    step: num(r.step),
    channel: r.channel as TouchChannel,
    direction: r.direction as ReactivationTouch["direction"],
    body: r.body,
    draftedBy: r.drafted_by as DraftedBy,
    status: r.status as TouchStatus,
    approvedBy: r.approved_by,
    createdAt: r.created_at,
    sentAt: r.sent_at,
  };
}

function rowToOutbox(r: OutboxRow): ReactivationOutboxItem {
  return {
    id: r.id,
    touchId: r.touch_id,
    siteId: r.site_id,
    channel: r.channel as TouchChannel,
    toRef: r.to_ref,
    body: r.body,
    status: r.status as ReactivationOutboxItem["status"],
    provider: r.provider,
    createdAt: r.created_at,
    sentAt: r.sent_at,
  };
}

// ---------------------------------------------------------------------------
// Targets.
// ---------------------------------------------------------------------------

export async function upsertTargets(targets: ReactivationTarget[]): Promise<void> {
  if (targets.length === 0) return;
  const db = serviceClient();
  const { error } = await db
    .from("reactivation_target")
    .upsert(targets.map(targetToRow), { onConflict: "id" });
  if (error) throw error;
}

export async function listTargets(args: {
  siteIds: string[];
  reasons?: ReactivationReason[];
  statuses?: ReactivationStatus[];
}): Promise<ReactivationTarget[]> {
  const db = serviceClient();
  let q = db.from("reactivation_target").select("*").in("site_id", args.siteIds);
  if (args.reasons && args.reasons.length > 0) q = q.in("reason", args.reasons);
  if (args.statuses && args.statuses.length > 0) q = q.in("status", args.statuses);
  const { data, error } = await q.order("reactivation_score", { ascending: false });
  if (error) throw error;
  return (data as TargetRow[]).map(rowToTarget);
}

export async function getTarget(id: string): Promise<ReactivationTarget | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("reactivation_target")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToTarget(data as TargetRow) : null;
}

export async function setTargetStatus(id: string, status: ReactivationStatus): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("reactivation_target").update({ status }).eq("id", id);
  if (error) throw error;
}

export async function incrementPriorAttempts(id: string): Promise<void> {
  const db = serviceClient();
  const current = await getTarget(id);
  if (!current) return;
  const { error } = await db
    .from("reactivation_target")
    .update({ prior_attempts: current.priorAttempts + 1 })
    .eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Cadences.
// ---------------------------------------------------------------------------

export async function createCadence(input: {
  targetId: string;
  siteId: string;
  nextDueAt: string;
}): Promise<ReactivationCadence> {
  const db = serviceClient();
  const { data, error } = await db
    .from("reactivation_cadence")
    .insert({ target_id: input.targetId, site_id: input.siteId, next_due_at: input.nextDueAt })
    .select("*")
    .single();
  if (error) throw error;
  return rowToCadence(data as CadenceRow);
}

export async function getCadenceByTarget(targetId: string): Promise<ReactivationCadence | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("reactivation_cadence")
    .select("*")
    .eq("target_id", targetId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToCadence(data as CadenceRow) : null;
}

export async function listCadences(siteIds: string[]): Promise<ReactivationCadence[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("reactivation_cadence")
    .select("*")
    .in("site_id", siteIds);
  if (error) throw error;
  return (data as CadenceRow[]).map(rowToCadence);
}

export async function listDueCadences(nowIso: string): Promise<ReactivationCadence[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("reactivation_cadence")
    .select("*")
    .eq("status", "active")
    .lte("next_due_at", nowIso);
  if (error) throw error;
  return (data as CadenceRow[]).map(rowToCadence);
}

export async function updateCadence(
  id: string,
  fields: Partial<{
    currentStep: number;
    status: CadenceStatus;
    nextDueAt: string | null;
    endedAt: string | null;
  }>,
): Promise<void> {
  const db = serviceClient();
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (fields.currentStep !== undefined) row.current_step = fields.currentStep;
  if (fields.status !== undefined) row.status = fields.status;
  if (fields.nextDueAt !== undefined) row.next_due_at = fields.nextDueAt;
  if (fields.endedAt !== undefined) row.ended_at = fields.endedAt;
  const { error } = await db.from("reactivation_cadence").update(row).eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Touches + outbox.
// ---------------------------------------------------------------------------

export async function insertTouch(input: {
  targetId: string;
  cadenceId?: string | null;   // null when drafted before enrolment
  siteId: string;
  step: number;
  channel: TouchChannel;
  body: string;
  draftedBy: DraftedBy;
  status?: TouchStatus;
}): Promise<ReactivationTouch> {
  const db = serviceClient();
  const { data, error } = await db
    .from("reactivation_touch")
    .insert({
      target_id: input.targetId,
      cadence_id: input.cadenceId || null, // empty/missing -> SQL NULL (column is a nullable uuid)
      site_id: input.siteId,
      step: input.step,
      channel: input.channel,
      body: input.body,
      drafted_by: input.draftedBy,
      ...(input.status ? { status: input.status } : {}),
    })
    .select("*")
    .single();
  if (error) throw error;
  return rowToTouch(data as TouchRow);
}

export async function listTouches(targetId: string): Promise<ReactivationTouch[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("reactivation_touch")
    .select("*")
    .eq("target_id", targetId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data as TouchRow[]).map(rowToTouch);
}

export async function approveTouch(touchId: string, approvedBy: string): Promise<ReactivationTouch> {
  const db = serviceClient();
  const { data, error } = await db
    .from("reactivation_touch")
    .update({ status: "approved", approved_by: approvedBy })
    .eq("id", touchId)
    .select("*")
    .single();
  if (error) throw error;
  return rowToTouch(data as TouchRow);
}

export async function enqueueOutbox(input: {
  touchId: string;
  siteId: string;
  channel: TouchChannel;
  toRef: string;
  body: string;
}): Promise<ReactivationOutboxItem> {
  const db = serviceClient();
  const { data, error } = await db
    .from("reactivation_outbox")
    .insert({
      touch_id: input.touchId,
      site_id: input.siteId,
      channel: input.channel,
      to_ref: input.toRef,
      body: input.body,
    })
    .select("*")
    .single();
  if (error) throw error;
  return rowToOutbox(data as OutboxRow);
}

export async function markTouchSent(touchId: string): Promise<void> {
  const db = serviceClient();
  const nowIso = new Date().toISOString();
  const { error: tErr } = await db
    .from("reactivation_touch")
    .update({ status: "sent", sent_at: nowIso })
    .eq("id", touchId);
  if (tErr) throw tErr;
  const { error: oErr } = await db
    .from("reactivation_outbox")
    .update({ status: "sent", provider: "stub", sent_at: nowIso })
    .eq("touch_id", touchId);
  if (oErr) throw oErr;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/reactivation/repository.ts
git commit -m "feat: reactivation supabase repository"
```

---

## Task 10: Extend the mock Dentally for the dormant book

**Files:**
- Modify: `src/app/api/mock-dentally/_fixtures.ts`
- Create: `src/app/api/mock-dentally/v1/patients/route.ts`
- Modify: `src/app/api/mock-dentally/v1/appointments/route.ts` (add a GET handler)
- Create: `src/app/api/mock-dentally/v1/invoices/route.ts`

Context: there is no live Dentally sandbox key yet, so the existing local mock (`/api/mock-dentally`) is the calibration target. It currently serves only the Treatment Coordinator's needs (treatment plans by site, a single patient, payment plans, appointment create). Reactivation must enumerate the dormant book, so the mock needs a patients list, an appointments history (GET), and invoices, with fixtures that exercise all three cohorts. Reference "now" is 2026-06-18 (`src/lib/mock/clients.ts` NOW). Note the mock carries `accepted_at` and `amount_outstanding` directly on the treatment plan (see `_fixtures.ts` header), so stalled-plan detection reads from treatment plans, not payment plans.

- [ ] **Step 1: Extend `_fixtures.ts`.** Add `site_id` (and optional dormant fields) to `MockPatient`, give the existing nine patients a `site_id`, append three dormant patients, one stalled open plan, and appointment + invoice fixtures with lookups.

Add to the `MockPatient` interface:

```ts
  site_id: string;
  archived?: boolean;
  archived_reason?: string | null;
  dentist_recall_date?: string | null;
  hygienist_recall_date?: string | null;
```

Give the existing nine patients a `site_id` matching their treatment plan's site: pat-001 `site-cc`, pat-002 `site-rv`, pat-003 `site-ng`, pat-004 `site-cc`, pat-005 `site-rv`, pat-006 `site-ng`, pat-007 `site-cc`, pat-008 `site-rv`, pat-009 `site-ng`.

Append three dormant patients to `MOCK_PATIENTS`:

```ts
  {
    // LAPSED: archived as lapsed, no visit in ~2 years, has historic spend.
    id: "pat-010", first_name: "Harold", last_name: "Pemberton",
    email_address: "harold.pemberton@example.co.uk", mobile_phone: "+447700900010",
    use_sms: true, use_email: true, marketing: 1, active: false,
    site_id: "site-cc", archived: true, archived_reason: "lapsed",
    dentist_recall_date: null, hygienist_recall_date: null,
  },
  {
    // OVERDUE RECALL: recall date 5+ months past, no future booking.
    id: "pat-011", first_name: "Priya", last_name: "Sharma",
    email_address: "priya.sharma@example.co.uk", mobile_phone: "+447700900011",
    use_sms: true, use_email: true, marketing: 1, active: true,
    site_id: "site-rv", archived: false, archived_reason: null,
    dentist_recall_date: "2026-01-05T00:00:00Z", hygienist_recall_date: null,
  },
  {
    // STALLED PLAN: open high-value plan accepted ~200 days ago (see plan-010).
    id: "pat-012", first_name: "Marcus", last_name: "Bennett",
    email_address: "marcus.bennett@example.co.uk", mobile_phone: "+447700900012",
    use_sms: true, use_email: false, marketing: 1, active: true,
    site_id: "site-ng", archived: false, archived_reason: null,
    dentist_recall_date: null, hygienist_recall_date: null,
  },
```

Append a stalled open plan to `MOCK_TREATMENT_PLANS`:

```ts
  {
    id: "plan-010", patient_id: "pat-012", site_id: "site-ng",
    name: "Full mouth rehabilitation", planned_private_treatment_value: 7800,
    amount_outstanding: 7800, accepted_at: "2025-12-01T10:00:00Z", updated_at: "2026-06-10T09:00:00Z",
  },
```

Add appointment + invoice types, fixtures, and lookups:

```ts
export interface MockAppointment {
  id: string;
  patient_id: string;
  site_id: string;
  start_time: string; // ISO
  state: string;
}

export interface MockInvoice {
  id: string;
  patient_id: string;
  paid: number;
}

// Appointment history. Past visits set "last visit"; a future one marks an
// existing booking (which disqualifies a patient from the dormant book).
export const MOCK_APPOINTMENTS: MockAppointment[] = [
  { id: "appt-010a", patient_id: "pat-010", site_id: "site-cc", start_time: "2024-05-10T09:00:00Z", state: "completed" },
  { id: "appt-011a", patient_id: "pat-011", site_id: "site-rv", start_time: "2025-07-02T11:30:00Z", state: "completed" },
  { id: "appt-012a", patient_id: "pat-012", site_id: "site-ng", start_time: "2025-12-01T10:00:00Z", state: "completed" },
  // An active patient WITH a future booking (must NOT appear in the dormant book).
  { id: "appt-001a", patient_id: "pat-001", site_id: "site-cc", start_time: "2026-07-20T10:00:00Z", state: "booked" },
];

// Paid invoices = lifetime spend proxy.
export const MOCK_INVOICES: MockInvoice[] = [
  { id: "inv-010a", patient_id: "pat-010", paid: 1200 },
  { id: "inv-010b", patient_id: "pat-010", paid: 480 },
  { id: "inv-011a", patient_id: "pat-011", paid: 950 },
];

export function patientsForSite(siteId: string): MockPatient[] {
  return MOCK_PATIENTS.filter((p) => p.site_id === siteId);
}
export function appointmentsForPatient(patientId: string): MockAppointment[] {
  return MOCK_APPOINTMENTS.filter((a) => a.patient_id === patientId);
}
export function invoicesForPatient(patientId: string): MockInvoice[] {
  return MOCK_INVOICES.filter((i) => i.patient_id === patientId);
}
```

- [ ] **Step 2: Create `src/app/api/mock-dentally/v1/patients/route.ts`**

```ts
import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";
import { patientsForSite, MOCK_PATIENTS, type MockPatient } from "@/app/api/mock-dentally/_fixtures";

export const dynamic = "force-dynamic";

function serialise(p: MockPatient) {
  return {
    id: p.id, first_name: p.first_name, last_name: p.last_name,
    email_address: p.email_address, mobile_phone: p.mobile_phone,
    use_sms: p.use_sms, use_email: p.use_email, marketing: p.marketing, active: p.active,
    archived: p.archived ?? false, archived_reason: p.archived_reason ?? null,
    dentist_recall_date: p.dentist_recall_date ?? null,
    hygienist_recall_date: p.hygienist_recall_date ?? null,
    updated_at: "2026-06-17T00:00:00Z",
  };
}

// GET /api/mock-dentally/v1/patients?site_id=&page=&per_page=
export async function GET(request: Request): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;
  const url = new URL(request.url);
  const siteId = url.searchParams.get("site_id");
  const all = siteId ? patientsForSite(siteId) : MOCK_PATIENTS;
  return Response.json({ patients: all.map(serialise) });
}
```

- [ ] **Step 3: Add a GET handler to `src/app/api/mock-dentally/v1/appointments/route.ts`** (keep the existing POST). Add the import and handler:

```ts
import { appointmentsForPatient } from "@/app/api/mock-dentally/_fixtures";

// GET /api/mock-dentally/v1/appointments?patient_id=
export async function GET(request: Request): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;
  const url = new URL(request.url);
  const patientId = url.searchParams.get("patient_id") ?? "";
  return Response.json({ appointments: appointmentsForPatient(patientId) });
}
```

- [ ] **Step 4: Create `src/app/api/mock-dentally/v1/invoices/route.ts`**

```ts
import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";
import { invoicesForPatient } from "@/app/api/mock-dentally/_fixtures";

export const dynamic = "force-dynamic";

// GET /api/mock-dentally/v1/invoices?patient_id=
export async function GET(request: Request): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;
  const url = new URL(request.url);
  const patientId = url.searchParams.get("patient_id") ?? "";
  return Response.json({ invoices: invoicesForPatient(patientId) });
}
```

- [ ] **Step 5: Typecheck, build, commit**

```bash
npx tsc --noEmit && npm run build
git add src/app/api/mock-dentally/
git commit -m "feat: mock dentally dormant-book fixtures + list endpoints"
```

---

## Task 11: Sync route + mock calibration

**Files:**
- Create: `src/app/api/sync/reactivation/route.ts`

Mirrors the TC sync route. All assumptions about raw Dentally JSON live in a single CALIBRATION block, narrowed with small `pick*` helpers (no `any`). Open plans (with `accepted_at` + outstanding) are read from the site's treatment plans and indexed by patient.

- [ ] **Step 1: Implement the sync route**

```ts
import { DentallyClient } from "@/lib/dentally/client";
import {
  toReactivationTarget,
  DEFAULT_CONFIG,
  type ReactivationConfig,
  type ReactivationInput,
} from "@/lib/reactivation/normalise";
import { rankTargets } from "@/lib/reactivation/scoring";
import { upsertTargets, getSyncState, setSyncState } from "@/lib/reactivation/repository";
import { SITES } from "@/lib/mock/clients";

export const dynamic = "force-dynamic";

const RESOURCE = "reactivation";
const PER_PAGE = 100;

// ===========================================================================
// CALIBRATION: confirm these field paths against the live Dentally sandbox.
// Everything about the raw Dentally JSON shape lives in THIS block.
// Known unknowns to verify on calibration:
//   - patients[]      -> id, names, consent (use_sms/use_email/marketing),
//                        archived/archived_reason, dentist/hygienist recall dates
//   - appointments[]  -> start/date field; how past vs future is represented
//   - invoices[]      -> paid amount field (for historic spend)
//   - treatment_plans -> open plan id/name/value/accepted_at + outstanding
// ===========================================================================

type Raw = Record<string, unknown>;

function asRecord(v: unknown): Raw {
  return v && typeof v === "object" ? (v as Raw) : {};
}
function pickString(o: Raw, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string") return v;
    if (typeof v === "number") return String(v);
  }
  return undefined;
}
function pickNumber(o: Raw, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}
function pickBoolean(o: Raw, ...keys: string[]): boolean | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v === 1;
  }
  return undefined;
}

function patientUpdatedAt(p: Raw): string | undefined {
  return pickString(p, "updated_at", "updatedAt");
}

function mapPatient(p: Raw, fallbackId: string): ReactivationInput["patient"] {
  return {
    id: pickString(p, "id") ?? fallbackId,
    first_name: pickString(p, "first_name", "firstName") ?? "",
    last_name: pickString(p, "last_name", "lastName") ?? "",
    use_sms: pickBoolean(p, "use_sms", "sms"),
    use_email: pickBoolean(p, "use_email", "email"),
    marketing: pickBoolean(p, "marketing"),
    archived: pickBoolean(p, "archived"),
    archived_reason: pickString(p, "archived_reason", "archivedReason") ?? null,
    dentist_recall_date: pickString(p, "dentist_recall_date", "dentistRecallDate") ?? null,
    hygienist_recall_date: pickString(p, "hygienist_recall_date", "hygienistRecallDate") ?? null,
  };
}

/** Most recent past appointment date, and whether any future appointment exists. */
function summariseAppointments(payload: { appointments: unknown[] }, now: Date): {
  lastVisitAt: string | null;
  futureBookingExists: boolean;
} {
  const appts = Array.isArray(payload.appointments) ? payload.appointments : [];
  let lastVisitAt: string | null = null;
  let futureBookingExists = false;
  for (const raw of appts) {
    const a = asRecord(raw);
    const startIso = pickString(a, "start_time", "start", "date", "appointment_date");
    if (!startIso) continue;
    const t = new Date(startIso).getTime();
    if (t > now.getTime()) {
      futureBookingExists = true;
    } else if (!lastVisitAt || startIso > lastVisitAt) {
      lastVisitAt = startIso;
    }
  }
  return { lastVisitAt, futureBookingExists };
}

/** Sum of paid invoice amounts = lifetime spend proxy. */
function deriveHistoricSpend(payload: { invoices: unknown[] }): number {
  const invoices = Array.isArray(payload.invoices) ? payload.invoices : [];
  let total = 0;
  for (const raw of invoices) {
    const inv = asRecord(raw);
    total += pickNumber(inv, "paid", "amount_paid", "total_paid") ?? 0;
  }
  return total;
}

interface OpenPlan {
  plan: ReactivationInput["plan"];
  amountOutstanding: number;
}

/**
 * Index a site's treatment plans by patient id, keeping the open one
 * (outstanding > 0). The treatment plan carries accepted_at + outstanding,
 * which is what stalled-plan detection needs.
 */
function indexOpenPlansByPatient(rawPlans: unknown[]): Map<string, OpenPlan> {
  const byPatient = new Map<string, OpenPlan>();
  for (const raw of rawPlans) {
    const tp = asRecord(raw);
    const patientId = pickString(tp, "patient_id", "patientId");
    const outstanding = pickNumber(tp, "amount_outstanding", "outstanding", "balance") ?? 0;
    if (!patientId || outstanding <= 0) continue;
    byPatient.set(patientId, {
      plan: {
        id: pickString(tp, "id") ?? "",
        name: pickString(tp, "name", "title", "description") ?? "Treatment plan",
        planned_private_treatment_value:
          pickNumber(tp, "planned_private_treatment_value", "total", "value") ?? 0,
        accepted_at: pickString(tp, "accepted_at", "acceptedAt", "created_at") ?? new Date().toISOString(),
      },
      amountOutstanding: outstanding,
    });
  }
  return byPatient;
}

// ===========================================================================
// END CALIBRATION block.
// ===========================================================================

function config(): ReactivationConfig {
  return {
    lapseMonths: Number(process.env.REACTIVATION_LAPSE_MONTHS ?? DEFAULT_CONFIG.lapseMonths),
    recallGraceDays: Number(process.env.REACTIVATION_RECALL_GRACE_DAYS ?? DEFAULT_CONFIG.recallGraceDays),
    staleDays: Number(process.env.REACTIVATION_STALE_DAYS ?? DEFAULT_CONFIG.staleDays),
    baselineValue: Number(process.env.REACTIVATION_BASELINE_VALUE ?? DEFAULT_CONFIG.baselineValue),
  };
}

function vitalitySiteIds(): string[] {
  return SITES.filter((s) => s.clientId === "vitality").map((s) => s.id);
}

async function syncSite(
  client: DentallyClient,
  siteId: string,
  cfg: ReactivationConfig,
): Promise<{ siteId: string; pulled: number; upserted: number }> {
  const state = await getSyncState(siteId, RESOURCE);
  const updatedAfter = state?.highWaterMark ?? undefined;
  const now = new Date();

  // 1. Index the site's open treatment plans by patient (carries outstanding + accepted_at).
  const openByPatient = new Map<string, OpenPlan>();
  for (let pp = 1; ; pp++) {
    const res = await client.listTreatmentPlans({ siteId, page: pp, perPage: PER_PAGE });
    const rawPlans = Array.isArray(res.treatment_plans) ? res.treatment_plans : [];
    for (const [k, v] of indexOpenPlansByPatient(rawPlans)) openByPatient.set(k, v);
    if (rawPlans.length < PER_PAGE) break;
  }

  // 2. Page patients and classify each into a cohort.
  const targets = [];
  let highWaterMark = updatedAfter ?? null;
  let pulled = 0;
  let page = 1;

  for (;;) {
    const res = await client.listPatients({ siteId, updatedAfter, page, perPage: PER_PAGE });
    const rawPatients = Array.isArray(res.patients) ? res.patients : [];
    pulled += rawPatients.length;

    for (const rawPatient of rawPatients) {
      const p = asRecord(rawPatient);
      const patient = mapPatient(p, "");
      if (!patient.id) continue;

      const appts = summariseAppointments(await client.getPatientAppointments(patient.id), now);
      const historicSpend = deriveHistoricSpend(await client.getPatientInvoices(patient.id));
      const open = openByPatient.get(patient.id) ?? { plan: null, amountOutstanding: 0 };

      const input: ReactivationInput = {
        siteId,
        patient,
        lastVisitAt: appts.lastVisitAt,
        futureBookingExists: appts.futureBookingExists,
        plan: open.plan,
        amountOutstanding: open.amountOutstanding,
        historicSpend,
        lastTouchAt: null,
      };

      const target = toReactivationTarget(input, now, cfg);
      if (target) targets.push(target);

      const updated = patientUpdatedAt(p);
      if (updated && (!highWaterMark || updated > highWaterMark)) highWaterMark = updated;
    }

    if (rawPatients.length < PER_PAGE) break;
    page += 1;
  }

  const ranked = rankTargets(targets, now);
  await upsertTargets(ranked);
  await setSyncState(siteId, RESOURCE, highWaterMark ?? now.toISOString());
  return { siteId, pulled, upserted: ranked.length };
}

export async function POST() {
  const apiKey = process.env.DENTALLY_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "DENTALLY_API_KEY not set" }, { status: 503 });
  }
  const client = new DentallyClient({
    apiKey,
    baseUrl: process.env.DENTALLY_BASE_URL ?? "https://api.dentally.co",
  });
  const cfg = config();
  const perSite = [];
  for (const siteId of vitalitySiteIds()) {
    perSite.push(await syncSite(client, siteId, cfg));
  }
  return Response.json({ ok: true, perSite });
}
```

- [ ] **Step 2: Calibrate against the mock** (extended in Task 10). Set `DENTALLY_BASE_URL=http://localhost:3000/api/mock-dentally` and `DENTALLY_API_KEY` in `.env.local` (the same values the TC sync uses). Run the dev server and `curl -X POST http://localhost:3000/api/sync/reactivation`. The three dormant fixtures should classify as one cohort each: pat-010 lapsed, pat-011 overdue_recall, pat-012 stalled_plan; pat-001 (future booking) must NOT appear. Adjust the CALIBRATION block field names if needed. When a real sandbox key arrives later, only the CALIBRATION strings change.

Run: `curl -X POST http://localhost:3000/api/sync/reactivation`
Expected: `{ "ok": true, "perSite": [{ "upserted": <n>, ... }] }` with at least the three dormant targets, and rows in Supabase.

- [ ] **Step 3: Verify idempotency** — run twice; row count stable, no duplicates, high-water mark advanced.

- [ ] **Step 4: Commit**

```bash
git add src/lib/dentally/client.ts src/lib/reactivation/normalise.ts src/app/api/sync/reactivation/route.ts
git commit -m "feat: reactivation sync route (calibrated against mock)"
```

---

## Task 12: Cadence sweep route

**Files:**
- Create: `src/app/api/reactivation/sweep/route.ts`

Advances every due cadence by one step. Idempotent: an `awaiting_approval` or `paused` cadence is not `active`, so it is not picked up; a step that auto-sends advances `next_due_at` past now.

- [ ] **Step 1: Implement the sweep route**

```ts
import { draftReactivation } from "@/lib/reactivation/draft";
import { stepDef, advanceAfter } from "@/lib/reactivation/cadence";
import {
  listDueCadences,
  getTarget,
  insertTouch,
  approveTouch,
  enqueueOutbox,
  markTouchSent,
  incrementPriorAttempts,
  updateCadence,
  setTargetStatus,
} from "@/lib/reactivation/repository";
import type { ReactivationTarget, TouchChannel } from "@/lib/reactivation/types";

export const dynamic = "force-dynamic";

function autoSendThreshold(): number {
  return Number(process.env.REACTIVATION_AUTO_SEND_THRESHOLD ?? 250);
}

function channelConsented(t: ReactivationTarget, channel: TouchChannel): boolean {
  if (channel === "email") return t.consent.email;
  return t.consent.sms; // sms + whatsapp use sms consent as proxy
}

function patientToRef(t: ReactivationTarget): string {
  return `patient:${t.dentallyPatientId}`;
}

export async function POST() {
  const now = new Date();
  const due = await listDueCadences(now.toISOString());

  let drafted = 0;
  let queued = 0;
  let awaitingApproval = 0;
  let exhausted = 0;
  let paused = 0;

  for (const cadence of due) {
    const target = await getTarget(cadence.targetId);
    if (!target) continue;

    const step = stepDef(cadence.currentStep + 1);
    if (!step) {
      await updateCadence(cadence.id, { status: "exhausted", endedAt: now.toISOString() });
      await setTargetStatus(target.id, "exhausted");
      exhausted += 1;
      continue;
    }

    // Respect consent; pause if the step's channel is not consented.
    if (!channelConsented(target, step.channel)) {
      await updateCadence(cadence.id, { status: "paused" });
      paused += 1;
      continue;
    }

    const { body } = await draftReactivation(target, step.channel, step);
    const touch = await insertTouch({
      targetId: target.id,
      cadenceId: cadence.id,
      siteId: target.siteId,
      step: step.step,
      channel: step.channel,
      body,
      draftedBy: "claude",
      status: "draft",
    });
    drafted += 1;

    if (target.recoverableValue < autoSendThreshold()) {
      // Low value: auto approve, queue, send (stub), advance.
      await approveTouch(touch.id, "auto");
      await enqueueOutbox({
        touchId: touch.id,
        siteId: target.siteId,
        channel: step.channel,
        toRef: patientToRef(target),
        body,
      });
      await markTouchSent(touch.id);
      await incrementPriorAttempts(target.id);
      const adv = advanceAfter(step.step, now);
      await updateCadence(cadence.id, {
        currentStep: adv.currentStep,
        status: adv.status,
        nextDueAt: adv.nextDueAt,
        endedAt: adv.endedAt,
      });
      if (adv.status === "exhausted") await setTargetStatus(target.id, "exhausted");
      queued += 1;
    } else {
      // High value: hold for coordinator approval.
      await updateCadence(cadence.id, { status: "awaiting_approval" });
      awaitingApproval += 1;
    }
  }

  return Response.json({
    ok: true,
    swept: due.length,
    drafted,
    queued,
    awaitingApproval,
    paused,
    exhausted,
  });
}
```

- [ ] **Step 2: Smoke test.** Seed one low-value and one high-value target each with an `active` cadence whose `next_due_at` is in the past (insert via Supabase SQL editor or by enrolling through Task 13). `curl -X POST http://localhost:3000/api/reactivation/sweep`. Confirm the low-value one auto-queues and advances, the high-value one becomes `awaiting_approval`.

Run: `curl -X POST http://localhost:3000/api/reactivation/sweep`
Expected: `{ "ok": true, "swept": <n>, "queued": <n>, "awaitingApproval": <n>, ... }`.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/reactivation/sweep/route.ts
git commit -m "feat: reactivation cadence sweep (advance due steps)"
```

---

## Task 13: Action route (enrol / draft / approve / send / pause / resume / book)

**Files:**
- Create: `src/app/api/reactivation/[action]/route.ts`

Mirrors the TC action route, plus cadence enrol/pause/resume and send-advances-the-cadence.

- [ ] **Step 1: Implement the action route**

```ts
import { DentallyClient, DentallyError } from "@/lib/dentally/client";
import { draftReactivation } from "@/lib/reactivation/draft";
import { stepDef, advanceAfter } from "@/lib/reactivation/cadence";
import {
  getTarget,
  getCadenceByTarget,
  createCadence,
  updateCadence,
  insertTouch,
  approveTouch,
  enqueueOutbox,
  markTouchSent,
  incrementPriorAttempts,
  setTargetStatus,
} from "@/lib/reactivation/repository";
import type { ReactivationTarget, TouchChannel } from "@/lib/reactivation/types";

export const dynamic = "force-dynamic";

const VALID_CHANNELS: readonly TouchChannel[] = ["sms", "email", "whatsapp"];
function isChannel(v: unknown): v is TouchChannel {
  return typeof v === "string" && VALID_CHANNELS.includes(v as TouchChannel);
}
function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function autoSendThreshold(): number {
  return Number(process.env.REACTIVATION_AUTO_SEND_THRESHOLD ?? 250);
}
function channelConsented(t: ReactivationTarget, channel: TouchChannel): boolean {
  if (channel === "email") return t.consent.email;
  return t.consent.sms;
}
function patientToRef(t: ReactivationTarget): string {
  return `patient:${t.dentallyPatientId}`;
}
function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

async function handleEnrol(body: Record<string, unknown>): Promise<Response> {
  const targetId = body.targetId;
  if (typeof targetId !== "string" || targetId === "") return badRequest("targetId is required");
  const target = await getTarget(targetId);
  if (!target) return Response.json({ error: "Target not found" }, { status: 404 });

  let cadence = await getCadenceByTarget(targetId);
  if (!cadence) {
    cadence = await createCadence({
      targetId,
      siteId: target.siteId,
      nextDueAt: new Date().toISOString(),
    });
  }
  await setTargetStatus(targetId, "in_cadence");
  return Response.json({ ok: true, cadence });
}

async function handleDraft(body: Record<string, unknown>): Promise<Response> {
  const targetId = body.targetId;
  const channel = body.channel;
  if (typeof targetId !== "string" || targetId === "") return badRequest("targetId is required");
  if (!isChannel(channel)) return badRequest("channel must be one of sms, email, whatsapp");

  const target = await getTarget(targetId);
  if (!target) return Response.json({ error: "Target not found" }, { status: 404 });

  const cadence = await getCadenceByTarget(targetId);
  const stepNumber = (cadence?.currentStep ?? 0) + 1;
  const step = stepDef(stepNumber) ?? stepDef(1)!;

  const { body: draftBody, rationale } = await draftReactivation(target, channel, step);
  let touch = await insertTouch({
    targetId: target.id,
    cadenceId: cadence?.id ?? "",
    siteId: target.siteId,
    step: step.step,
    channel,
    body: draftBody,
    draftedBy: "claude",
    status: "draft",
  });

  const consented = channelConsented(target, channel);
  const underThreshold = target.recoverableValue < autoSendThreshold();
  let autoQueued = false;
  if (underThreshold && consented) {
    touch = await approveTouch(touch.id, "auto");
    await enqueueOutbox({
      touchId: touch.id,
      siteId: target.siteId,
      channel,
      toRef: patientToRef(target),
      body: draftBody,
    });
    touch = { ...touch, status: "queued" };
    autoQueued = true;
  }

  return Response.json({
    touch,
    rationale,
    step: step.step,
    autoQueued,
    consentBlocked: underThreshold && !consented,
  });
}

async function handleApprove(body: Record<string, unknown>): Promise<Response> {
  const touchId = body.touchId;
  const targetId = body.targetId;
  const channel = body.channel;
  const toRef = body.toRef;
  if (typeof touchId !== "string" || touchId === "") return badRequest("touchId is required");
  if (typeof targetId !== "string" || targetId === "") return badRequest("targetId is required");
  if (!isChannel(channel)) return badRequest("channel must be one of sms, email, whatsapp");
  if (toRef !== undefined && typeof toRef !== "string") return badRequest("toRef must be a string");

  const target = await getTarget(targetId);
  if (!target) return Response.json({ error: "Target not found" }, { status: 404 });

  const touch = await approveTouch(touchId, "coordinator");
  await enqueueOutbox({
    touchId: touch.id,
    siteId: target.siteId,
    channel,
    toRef: toRef ?? patientToRef(target),
    body: touch.body,
  });
  return Response.json({ ok: true });
}

async function handleSend(body: Record<string, unknown>): Promise<Response> {
  const touchId = body.touchId;
  const targetId = body.targetId;
  const step = body.step;
  if (typeof touchId !== "string" || touchId === "") return badRequest("touchId is required");
  if (typeof targetId !== "string" || targetId === "") return badRequest("targetId is required");
  if (typeof step !== "number") return badRequest("step (number) is required");

  const now = new Date();
  await markTouchSent(touchId);
  await incrementPriorAttempts(targetId);

  // Advance the cadence position past the step we just sent.
  const cadence = await getCadenceByTarget(targetId);
  if (cadence) {
    const adv = advanceAfter(step, now);
    await updateCadence(cadence.id, {
      currentStep: adv.currentStep,
      status: adv.status,
      nextDueAt: adv.nextDueAt,
      endedAt: adv.endedAt,
    });
    if (adv.status === "exhausted") await setTargetStatus(targetId, "exhausted");
  }

  return Response.json({ ok: true, sentVia: "stub" });
}

async function handlePauseResume(body: Record<string, unknown>, resume: boolean): Promise<Response> {
  const targetId = body.targetId;
  if (typeof targetId !== "string" || targetId === "") return badRequest("targetId is required");
  const cadence = await getCadenceByTarget(targetId);
  if (!cadence) return Response.json({ error: "No cadence for target" }, { status: 404 });
  await updateCadence(cadence.id, {
    status: resume ? "active" : "paused",
    ...(resume ? { nextDueAt: new Date().toISOString() } : {}),
  });
  return Response.json({ ok: true });
}

async function handleBook(body: Record<string, unknown>): Promise<Response> {
  const targetId = body.targetId;
  const start = body.start;
  if (typeof targetId !== "string" || targetId === "") return badRequest("targetId is required");
  if (typeof start !== "string" || start === "") return badRequest("start is required");

  const apiKey = process.env.DENTALLY_API_KEY;
  if (!apiKey) return Response.json({ error: "DENTALLY_API_KEY not set" }, { status: 503 });

  const target = await getTarget(targetId);
  if (!target) return Response.json({ error: "Target not found" }, { status: 404 });

  const client = new DentallyClient({
    apiKey,
    baseUrl: process.env.DENTALLY_BASE_URL ?? "https://api.dentally.co",
  });

  const { targetId: _omit, ...rest } = body;
  void _omit;
  const payload: Record<string, unknown> = { ...rest, booked_via_api: true };

  try {
    const { appointment } = await client.createAppointment(payload);
    const cadence = await getCadenceByTarget(targetId);
    if (cadence) {
      await updateCadence(cadence.id, { status: "converted", endedAt: new Date().toISOString() });
    }
    await setTargetStatus(targetId, "converted");
    await insertTouch({
      targetId: target.id,
      cadenceId: cadence?.id ?? "",
      siteId: target.siteId,
      step: 0,
      channel: "sms",
      body: "Booked re-engagement appointment",
      draftedBy: "human",
      status: "sent",
    });
    return Response.json({ ok: true, appointment });
  } catch (err) {
    const message =
      err instanceof DentallyError ? err.message : err instanceof Error ? err.message : "Dentally booking failed";
    return Response.json({ error: message }, { status: 502 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ action: string }> },
): Promise<Response> {
  const { action } = await params;
  let body: Record<string, unknown>;
  try {
    body = asRecord(await request.json());
  } catch {
    return badRequest("Request body must be valid JSON");
  }

  switch (action) {
    case "enrol":
      return handleEnrol(body);
    case "draft":
      return handleDraft(body);
    case "approve":
      return handleApprove(body);
    case "send":
      return handleSend(body);
    case "pause":
      return handlePauseResume(body, false);
    case "resume":
      return handlePauseResume(body, true);
    case "book":
      return handleBook(body);
    default:
      return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }
}
```

- [ ] **Step 2: Typecheck + smoke test** each action with `curl` against a seeded target (enrol -> draft -> approve -> send; pause/resume; book). Confirm a high-value target does not auto-queue on draft and a low-value one does.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/reactivation/
git commit -m "feat: reactivation actions (enrol, draft, approve, send, pause, resume, book)"
```

---

## Task 14: UI — worklist + target detail + cadence timeline

**Files:**
- Modify: `src/app/c/[client]/reactivation/page.tsx` (replace placeholder)
- Create: `src/components/client/reactivation/worklist.tsx`
- Create: `src/components/client/reactivation/cadence-timeline.tsx`
- Create: `src/components/client/reactivation/target-drawer.tsx`
- Create: `src/components/client/reactivation/draft-editor.tsx`
- Modify: `src/lib/nav.ts`

- [ ] **Step 1: Build the page** (server component) — replace the placeholder file entirely.

```tsx
import { RotateCcw, PoundSterling, Users, CheckCircle2, Send } from "lucide-react";
import { PageHeader, StatCard, EmptyState } from "@/components/primitives";
import { Worklist } from "@/components/client/reactivation/worklist";
import { getClient, getSites, NOW } from "@/lib/mock/clients";
import { listTargets, listCadences } from "@/lib/reactivation/repository";
import type { ReactivationCadence, ReactivationTarget } from "@/lib/reactivation/types";
import { gbp } from "@/lib/utils";

export const dynamic = "force-dynamic";

async function loadData(siteIds: string[]): Promise<{
  targets: ReactivationTarget[];
  cadences: ReactivationCadence[];
}> {
  try {
    const [targets, cadences] = await Promise.all([
      listTargets({ siteIds }),
      listCadences(siteIds),
    ]);
    return { targets, cadences };
  } catch {
    return { targets: [], cadences: [] };
  }
}

export default async function ReactivationPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  const client = getClient(clientSlug);

  if (!client) {
    return <PageHeader title="Reactivation" description="This client could not be found." />;
  }

  const siteIds = getSites(client.id).map((s) => s.id);
  const { targets, cadences } = await loadData(siteIds);

  const dormant = targets.filter((t) => t.status === "dormant" || t.status === "in_cadence");
  const converted = targets.filter((t) => t.status === "converted");
  const inCadence = targets.filter((t) => t.status === "in_cadence");
  const totalRecoverable = dormant.reduce((sum, t) => sum + t.recoverableValue, 0);

  return (
    <>
      <PageHeader
        title="Reactivation"
        description="Win back dormant patients. Lapsed visitors, overdue recalls and stalled treatment plans are ranked by recoverable value and worked through a multi step cadence."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Dormant patients" value={String(dormant.length)} icon={Users} hint="Open across all cohorts" />
        <StatCard label="Recoverable value" value={gbp(totalRecoverable)} icon={PoundSterling} hint="Across dormant patients" />
        <StatCard label="In cadence" value={String(inCadence.length)} icon={Send} hint="Active outreach sequences" />
        <StatCard label="Re-engaged" value={String(converted.length)} icon={CheckCircle2} hint="Booked back in" />
      </div>

      {targets.length === 0 ? (
        <EmptyState
          icon={RotateCcw}
          title="No dormant patients synced yet"
          description="Run the reactivation sync to pull lapsed patients, overdue recalls and stalled plans into this worklist. This view is mock safe, so it stays empty until real data lands."
        />
      ) : (
        <Worklist targets={targets} cadences={cadences} nowIso={NOW.toISOString()} />
      )}
    </>
  );
}
```

- [ ] **Step 2: Build `cadence-timeline.tsx`**

```tsx
"use client";

import { DEFAULT_CADENCE } from "@/lib/reactivation/cadence";
import { cn, relativeTime } from "@/lib/utils";
import { Check, Clock, Circle } from "lucide-react";
import type { ReactivationCadence } from "@/lib/reactivation/types";

export function CadenceTimeline({
  cadence,
  nowIso,
}: {
  cadence: ReactivationCadence | null;
  nowIso: string;
}) {
  const now = new Date(nowIso);
  const current = cadence?.currentStep ?? 0;

  return (
    <ol className="space-y-2">
      {DEFAULT_CADENCE.map((s) => {
        const done = current >= s.step;
        const isNext = current + 1 === s.step;
        const Icon = done ? Check : isNext ? Clock : Circle;
        return (
          <li key={s.step} className="flex items-center gap-3">
            <span
              className={cn(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
                done
                  ? "bg-success/10 text-success"
                  : isNext
                    ? "bg-blue-dark/10 text-blue-dark"
                    : "bg-card-muted text-muted",
              )}
            >
              <Icon size={14} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-navy capitalize">
                Step {s.step}: {s.purpose}
                <span className="ml-2 font-normal text-muted">{s.channel.toUpperCase()}</span>
              </p>
              {isNext && cadence?.nextDueAt ? (
                <p className="text-xs text-muted">Due {relativeTime(cadence.nextDueAt, now)}</p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
```

- [ ] **Step 3: Build `draft-editor.tsx`** (adapts the TC DraftEditor to the reactivation action route + step)

```tsx
"use client";

import { useState } from "react";
import { MessageSquare, Mail, Sparkles, Check, Send, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/primitives";
import { cn } from "@/lib/utils";
import type { TouchChannel, ReactivationTarget } from "@/lib/reactivation/types";

interface DraftResponse {
  touch?: { id: string; status: string; body?: string };
  rationale?: string;
  step?: number;
  autoQueued?: boolean;
  consentBlocked?: boolean;
  error?: string;
}

type Phase = "idle" | "drafting" | "drafted" | "approving" | "approved" | "sending" | "sent";

const CHANNELS: { value: TouchChannel; label: string; icon: typeof MessageSquare }[] = [
  { value: "sms", label: "SMS", icon: MessageSquare },
  { value: "email", label: "Email", icon: Mail },
  { value: "whatsapp", label: "WhatsApp", icon: MessageSquare },
];

export interface DraftSent {
  channel: TouchChannel;
  body: string;
}

export function DraftEditor({
  target,
  onSent,
}: {
  target: ReactivationTarget;
  onSent: (touch: DraftSent) => void;
}) {
  const [channel, setChannel] = useState<TouchChannel>("sms");
  const [phase, setPhase] = useState<Phase>("idle");
  const [body, setBody] = useState("");
  const [rationale, setRationale] = useState<string | null>(null);
  const [touchId, setTouchId] = useState<string | null>(null);
  const [step, setStep] = useState<number | null>(null);
  const [autoQueued, setAutoQueued] = useState(false);
  const [consentBlocked, setConsentBlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const busy = phase === "drafting" || phase === "approving" || phase === "sending";

  async function post(action: string, payload: Record<string, unknown>) {
    const res = await fetch(`/api/reactivation/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = (await res.json().catch(() => ({}))) as DraftResponse & { ok?: boolean };
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  async function generate() {
    setError(null);
    setPhase("drafting");
    setRationale(null);
    setAutoQueued(false);
    setConsentBlocked(false);
    try {
      const data = await post("draft", { targetId: target.id, channel });
      setBody(data.touch?.body ?? "");
      setRationale(data.rationale ?? null);
      setTouchId(data.touch?.id ?? null);
      setStep(data.step ?? null);
      setAutoQueued(Boolean(data.autoQueued));
      setConsentBlocked(Boolean(data.consentBlocked));
      setPhase(data.autoQueued ? "approved" : "drafted");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate the draft.");
      setPhase("idle");
    }
  }

  async function approve() {
    if (!touchId) return;
    setError(null);
    setPhase("approving");
    try {
      await post("approve", { touchId, targetId: target.id, channel });
      setPhase("approved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not approve the draft.");
      setPhase("drafted");
    }
  }

  async function send() {
    if (!touchId || step === null) return;
    setError(null);
    setPhase("sending");
    try {
      await post("send", { touchId, targetId: target.id, step });
      setPhase("sent");
      onSent({ channel, body });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the message.");
      setPhase("approved");
    }
  }

  async function approveAndSend() {
    if (!touchId || step === null) return;
    setError(null);
    setPhase("approving");
    try {
      if (phase !== "approved") await post("approve", { touchId, targetId: target.id, channel });
      setPhase("sending");
      await post("send", { touchId, targetId: target.id, step });
      setPhase("sent");
      onSent({ channel, body });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not approve and send.");
      setPhase("drafted");
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Channel</p>
        <div className="flex gap-2">
          {CHANNELS.map((c) => {
            const Icon = c.icon;
            const active = channel === c.value;
            return (
              <button
                key={c.value}
                type="button"
                disabled={phase === "sent"}
                onClick={() => setChannel(c.value)}
                className={cn(
                  "inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors disabled:opacity-50",
                  active
                    ? "border-blue-dark/30 bg-blue-dark/10 text-blue-dark"
                    : "border-line-strong bg-card text-muted hover:bg-card-muted",
                )}
              >
                <Icon size={14} />
                {c.label}
              </button>
            );
          })}
        </div>
      </div>

      {phase === "idle" ? (
        <Button onClick={generate} className="w-full" variant="primary">
          <Sparkles size={15} />
          Generate draft
        </Button>
      ) : null}

      {phase === "drafting" ? (
        <div className="flex items-center justify-center gap-2 rounded-lg border border-line bg-card-muted py-6 text-sm text-muted">
          <Loader2 size={16} className="animate-spin" />
          Drafting with Claude
        </div>
      ) : null}

      {body || rationale ? (
        <div className="space-y-3">
          {rationale ? (
            <div className="rounded-lg border border-blue-dark/20 bg-blue-dark/[0.06] px-3 py-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-blue-dark">Why now</p>
              <p className="mt-0.5 text-sm text-ink">{rationale}</p>
            </div>
          ) : null}

          {consentBlocked ? (
            <StatusPill tone="warning">No marketing consent for this channel</StatusPill>
          ) : null}
          {autoQueued ? <StatusPill tone="info">Auto queued, low value</StatusPill> : null}

          {body ? (
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">Draft message</p>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                disabled={phase === "sending" || phase === "sent"}
                rows={6}
                className="w-full resize-y rounded-lg border border-line-strong bg-card px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40 disabled:opacity-60"
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>
      ) : null}

      {phase === "sent" ? (
        <div className="flex items-center justify-center gap-2 rounded-lg border border-success/20 bg-success/10 py-3 text-sm font-semibold text-success">
          <Check size={16} />
          Sent (simulated)
        </div>
      ) : null}

      {(phase === "drafted" || phase === "approving" || phase === "approved" || phase === "sending") && touchId ? (
        <div className="flex gap-2">
          <Button onClick={approve} disabled={busy || phase === "approved"} variant="secondary" className="flex-1">
            {phase === "approving" ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
            {phase === "approved" ? "Approved" : "Approve"}
          </Button>
          {phase === "approved" || phase === "sending" ? (
            <Button onClick={send} disabled={busy} variant="primary" className="flex-1">
              {phase === "sending" ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
              Send
            </Button>
          ) : (
            <Button onClick={approveAndSend} disabled={busy} variant="primary" className="flex-1">
              <Send size={15} />
              Approve and send
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Build `target-drawer.tsx`**

```tsx
"use client";

import { useState } from "react";
import { X, CalendarPlus, Loader2, Check, Pause, Play, MessageSquare, Mail, CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusPill, type Tone } from "@/components/primitives";
import { gbp, relativeTime } from "@/lib/utils";
import type { ReactivationCadence, ReactivationReason, ReactivationTarget, TouchChannel } from "@/lib/reactivation/types";
import { CadenceTimeline } from "./cadence-timeline";
import { DraftEditor, type DraftSent } from "./draft-editor";

const REASON_TONE: Record<ReactivationReason, Tone> = {
  lapsed: "neutral",
  overdue_recall: "warning",
  stalled_plan: "info",
};
const REASON_LABEL: Record<ReactivationReason, string> = {
  lapsed: "Lapsed",
  overdue_recall: "Overdue recall",
  stalled_plan: "Stalled plan",
};
const CHANNEL_LABEL: Record<TouchChannel, string> = { sms: "SMS", email: "Email", whatsapp: "WhatsApp" };

interface SessionTouch {
  id: string;
  kind: "message" | "booking";
  channel?: TouchChannel;
  body: string;
  at: string;
}

function whyNow(t: ReactivationTarget): string {
  switch (t.reason) {
    case "stalled_plan":
      return `${gbp(t.recoverableValue)} outstanding on ${t.treatment ?? "treatment"}. Re-present finance.`;
    case "overdue_recall":
      return `Recall overdue since ${t.recallDueAt ? new Date(t.recallDueAt).toLocaleDateString("en-GB") : "unknown"}. Book it in.`;
    case "lapsed":
      return `Last visit ${t.lastVisitAt ? new Date(t.lastVisitAt).toLocaleDateString("en-GB") : "unknown"}. Invite back for a checkup.`;
  }
}

export function TargetDrawer({
  target,
  cadence,
  nowIso,
  onClose,
}: {
  target: ReactivationTarget;
  cadence: ReactivationCadence | null;
  nowIso: string;
  onClose: () => void;
}) {
  const now = new Date(nowIso);
  const [touches, setTouches] = useState<SessionTouch[]>([]);
  const [paused, setPaused] = useState(cadence?.status === "paused");
  const [pausing, setPausing] = useState(false);
  const [showBook, setShowBook] = useState(false);
  const [start, setStart] = useState("");
  const [booking, setBooking] = useState(false);
  const [bookError, setBookError] = useState<string | null>(null);
  const [bookOk, setBookOk] = useState(false);

  function logSent(touch: DraftSent) {
    setTouches((prev) => [
      ...prev,
      { id: `t-${prev.length}`, kind: "message", channel: touch.channel, body: touch.body, at: new Date().toISOString() },
    ]);
  }

  async function action(path: string, payload: Record<string, unknown>) {
    const res = await fetch(`/api/reactivation/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 503) throw new Error("Dentally is not connected yet.");
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  async function togglePause() {
    setPausing(true);
    try {
      await action(paused ? "resume" : "pause", { targetId: target.id });
      setPaused(!paused);
    } catch {
      // surfaced inline elsewhere; keep the toggle state unchanged on failure
    } finally {
      setPausing(false);
    }
  }

  async function book() {
    if (!start) return;
    setBookError(null);
    setBooking(true);
    try {
      await action("book", { targetId: target.id, start: new Date(start).toISOString() });
      setBookOk(true);
      setShowBook(false);
      setTouches((prev) => [
        ...prev,
        { id: `b-${prev.length}`, kind: "booking", body: `Re-engagement booked for ${new Date(start).toLocaleString("en-GB")}`, at: new Date().toISOString() },
      ]);
    } catch (err) {
      setBookError(err instanceof Error ? err.message : "Could not book the appointment.");
    } finally {
      setBooking(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50">
      <button type="button" aria-label="Close panel" onClick={onClose} className="absolute inset-0 bg-navy/40 backdrop-blur-[1px]" />
      <aside className="absolute right-0 top-0 flex h-full w-full max-w-[480px] flex-col overflow-y-auto border-l border-line bg-card shadow-2xl">
        <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-line bg-card px-6 py-5">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-extrabold text-navy">{target.patientName}</h2>
            <p className="mt-0.5 text-sm text-muted">{REASON_LABEL[target.reason]}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-card-muted hover:text-navy"
          >
            <X size={18} />
          </button>
        </header>

        <div className="flex-1 space-y-6 px-6 py-5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={REASON_TONE[target.reason]}>{REASON_LABEL[target.reason]}</StatusPill>
            <StatusPill tone="neutral">{gbp(target.recoverableValue)} recoverable</StatusPill>
            {target.priorAttempts > 0 ? (
              <StatusPill tone="neutral">{target.priorAttempts} prior attempts</StatusPill>
            ) : null}
          </div>

          <div className="rounded-lg border border-blue-dark/20 bg-blue-dark/[0.06] px-3 py-2.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-blue-dark">Why now</p>
            <p className="mt-0.5 text-sm text-ink">{whyNow(target)}</p>
          </div>

          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-extrabold text-navy">Cadence</h3>
              {cadence ? (
                <Button onClick={togglePause} variant="ghost" size="sm" disabled={pausing}>
                  {pausing ? <Loader2 size={14} className="animate-spin" /> : paused ? <Play size={14} /> : <Pause size={14} />}
                  {paused ? "Resume" : "Pause"}
                </Button>
              ) : null}
            </div>
            <CadenceTimeline cadence={cadence} nowIso={nowIso} />
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-extrabold text-navy">Outreach</h3>
            <DraftEditor target={target} onSent={logSent} />
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-extrabold text-navy">Book re-engagement</h3>
            {!showBook ? (
              <Button onClick={() => setShowBook(true)} variant="secondary" className="w-full">
                <CalendarPlus size={15} />
                Book appointment
              </Button>
            ) : (
              <div className="space-y-2 rounded-lg border border-line bg-card-muted/40 p-3">
                <label className="block text-xs font-semibold uppercase tracking-wide text-muted">Appointment start</label>
                <input
                  type="datetime-local"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                  className="w-full rounded-lg border border-line-strong bg-card px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40"
                />
                <div className="flex gap-2">
                  <Button onClick={() => setShowBook(false)} variant="ghost" className="flex-1" disabled={booking}>
                    Cancel
                  </Button>
                  <Button onClick={book} variant="primary" className="flex-1" disabled={booking || !start}>
                    {booking ? <Loader2 size={15} className="animate-spin" /> : <CalendarPlus size={15} />}
                    Confirm
                  </Button>
                </div>
              </div>
            )}
            {bookOk ? (
              <div className="flex items-center gap-2 rounded-lg border border-success/20 bg-success/10 px-3 py-2 text-sm font-semibold text-success">
                <Check size={15} />
                Re-engagement booked
              </div>
            ) : null}
            {bookError ? (
              <p className="rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-sm text-[#9a6700]">{bookError}</p>
            ) : null}
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-extrabold text-navy">Activity</h3>
            {touches.length === 0 ? (
              <p className="rounded-lg border border-dashed border-line-strong bg-card-muted/40 px-3 py-4 text-center text-sm text-muted">
                No activity in this session yet. Sent messages and bookings will appear here.
              </p>
            ) : (
              <ol className="space-y-3">
                {touches.map((t) => {
                  const Icon = t.kind === "booking" ? CalendarClock : t.channel === "email" ? Mail : MessageSquare;
                  return (
                    <li key={t.id} className="flex gap-3">
                      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-card-muted text-blue-dark">
                        <Icon size={14} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold text-navy">
                          {t.kind === "booking" ? "Booking" : `${t.channel ? CHANNEL_LABEL[t.channel] : "Message"} sent (simulated)`}
                          <span className="ml-2 font-normal text-muted">{relativeTime(t.at, now)}</span>
                        </p>
                        <p className="mt-0.5 line-clamp-3 text-sm text-ink">{t.body}</p>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        </div>
      </aside>
    </div>
  );
}
```

- [ ] **Step 5: Build `worklist.tsx`**

```tsx
"use client";

import { useMemo, useState } from "react";
import { SectionCard, StatusPill, DataTable, EmptyState, type Column, type Tone } from "@/components/primitives";
import { cn, gbp, relativeTime } from "@/lib/utils";
import { Filter } from "lucide-react";
import type { ReactivationCadence, ReactivationReason, ReactivationTarget } from "@/lib/reactivation/types";
import { TargetDrawer } from "./target-drawer";

const REASON_TONE: Record<ReactivationReason, Tone> = {
  lapsed: "neutral",
  overdue_recall: "warning",
  stalled_plan: "info",
};
const REASON_LABEL: Record<ReactivationReason, string> = {
  lapsed: "Lapsed",
  overdue_recall: "Overdue recall",
  stalled_plan: "Stalled plan",
};

type FilterValue = "all" | ReactivationReason;
const FILTERS: { value: FilterValue; label: string }[] = [
  { value: "all", label: "All" },
  { value: "stalled_plan", label: "Stalled plan" },
  { value: "overdue_recall", label: "Overdue recall" },
  { value: "lapsed", label: "Lapsed" },
];

export function Worklist({
  targets,
  cadences,
  nowIso,
}: {
  targets: ReactivationTarget[];
  cadences: ReactivationCadence[];
  nowIso: string;
}) {
  const now = useMemo(() => new Date(nowIso), [nowIso]);
  const [filter, setFilter] = useState<FilterValue>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const cadenceByTarget = useMemo(() => {
    const map = new Map<string, ReactivationCadence>();
    for (const c of cadences) map.set(c.targetId, c);
    return map;
  }, [cadences]);

  const ranked = useMemo(
    () => [...targets].sort((a, b) => b.reactivationScore - a.reactivationScore),
    [targets],
  );
  const rows = useMemo(
    () => (filter === "all" ? ranked : ranked.filter((t) => t.reason === filter)),
    [ranked, filter],
  );
  const rankByIndex = useMemo(() => {
    const map = new Map<string, number>();
    ranked.forEach((t, i) => map.set(t.id, i + 1));
    return map;
  }, [ranked]);

  const selected = useMemo(() => targets.find((t) => t.id === selectedId) ?? null, [targets, selectedId]);
  const selectedCadence = selected ? cadenceByTarget.get(selected.id) ?? null : null;

  const columns: Column<ReactivationTarget>[] = [
    {
      key: "rank",
      header: "#",
      cell: (t) => <span className="font-semibold text-muted tabular-nums">{rankByIndex.get(t.id)}</span>,
      className: "w-10",
    },
    { key: "patient", header: "Patient", cell: (t) => <span className="font-semibold text-navy">{t.patientName}</span> },
    {
      key: "reason",
      header: "Cohort",
      cell: (t) => <StatusPill tone={REASON_TONE[t.reason]}>{REASON_LABEL[t.reason]}</StatusPill>,
    },
    {
      key: "value",
      header: "Recoverable",
      cell: (t) => <span className="font-semibold text-navy tabular-nums">{gbp(t.recoverableValue)}</span>,
      align: "right",
    },
    {
      key: "last",
      header: "Last visit / recall",
      cell: (t) => {
        const iso = t.recallDueAt ?? t.lastVisitAt;
        return <span className="text-muted">{iso ? relativeTime(iso, now) : "Unknown"}</span>;
      },
      align: "right",
    },
    {
      key: "step",
      header: "Cadence",
      cell: (t) => {
        const c = cadenceByTarget.get(t.id);
        return <span className="text-muted tabular-nums">{c ? `${c.currentStep} of 3` : "Not started"}</span>;
      },
      align: "right",
    },
    {
      key: "next",
      header: "Next due",
      cell: (t) => {
        const c = cadenceByTarget.get(t.id);
        return <span className="text-muted">{c?.nextDueAt ? relativeTime(c.nextDueAt, now) : "—"}</span>;
      },
      align: "right",
    },
  ];

  return (
    <>
      <SectionCard
        title="Worklist"
        description="Ranked by recoverable value and winnability. Open any patient to run their cadence."
        actions={
          <div className="flex items-center gap-2">
            <Filter size={14} className="text-muted" />
            <div className="flex flex-wrap gap-1">
              {FILTERS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => setFilter(f.value)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-semibold transition-colors",
                    filter === f.value
                      ? "border-blue-dark/30 bg-blue-dark/10 text-blue-dark"
                      : "border-line-strong bg-card text-muted hover:bg-card-muted",
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
        }
        bodyClassName="p-0"
      >
        <DataTable
          columns={columns}
          rows={rows}
          getRowKey={(t) => t.id}
          onRowClick={(t) => setSelectedId(t.id)}
          className="px-2 py-1"
          empty={<EmptyState title="Nothing matches this filter" description="Try a different cohort." className="m-4" />}
        />
      </SectionCard>

      {selected ? (
        <TargetDrawer target={selected} cadence={selectedCadence} nowIso={nowIso} onClose={() => setSelectedId(null)} />
      ) : null}
    </>
  );
}
```

- [ ] **Step 6: Flip the nav status** in `src/lib/nav.ts` — change the `reactivation` item's `status: "placeholder"` to `status: "live"`. (Leave its `note` and other fields unchanged.)

- [ ] **Step 7: Verify build + typecheck**

Run: `npx tsc --noEmit && npm run build`
Expected: clean build; route `/c/[client]/reactivation` present.

- [ ] **Step 8: Manual E2E via preview** (preview MCP): worklist renders ranked with cohort badges; open a target; cadence timeline + "why now" show; Generate draft loads a cohort-appropriate message; Approve/Send logs the touch; Pause/Resume toggles; "Book appointment" with `DENTALLY_API_KEY` set creates a sandbox appointment and converts the target. With no DB data, the page shows the empty state (mock safe).

- [ ] **Step 9: Commit**

```bash
git add src/app/c/[client]/reactivation/ src/components/client/reactivation/ src/lib/nav.ts
git commit -m "feat: reactivation UI (worklist + cadence + draft-and-approve)"
```

---

## Task 15: Full test + verification pass

- [ ] **Step 1: Run all unit tests**

Run: `npx vitest run`
Expected: all suites pass (cadence, scoring, normalise, draft, client, plus the existing coordinator suites).

- [ ] **Step 2: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 3: Confirm spec acceptance** against `docs/superpowers/specs/2026-06-18-reactivation-design.md`: three cohorts synced + deduped by strongest reason; ranked by blended value and winnability; cadence advances via the sweep with the auto-send threshold gating approval; pause/resume and book-and-convert work; book writes back to Dentally; no clinical fields stored; no em-dashes in generated copy; auth still mock; sending still stubbed.

- [ ] **Step 4: Final commit (if anything outstanding)**

```bash
git add -A
git commit -m "test: reactivation verification pass"
```

---

## Notes for the implementer

- Dentally exact endpoint paths and field names are the main unknown; Task 11 Step 2 is where they get pinned against the mock (and later a live sandbox). Everything upstream is structured so only the CALIBRATION block strings change.
- Never commit `.env.local`. Secrets stay local.
- `site_id` on every row and query. Multi-site by default.
- Respect `consent` before any (stub) send; the sweep pauses a cadence whose due step has no consented channel.
- Dedupe is by strongest reason in the normaliser (`stalled_plan > overdue_recall > lapsed`), so a patient never appears twice; the boundary thresholds (`REACTIVATION_LAPSE_MONTHS`, `REACTIVATION_RECALL_GRACE_DAYS`, `REACTIVATION_STALE_DAYS`) are the handoff line to Recall and the Treatment Coordinator.
- Pre-existing oversight, out of scope: the TC module's `nav.ts` status is still `placeholder` though it is built. This plan flips only `reactivation` to `live`; consider flipping `treatment-coordinator` in a follow-up.
- Keep files focused: pure logic in `lib/reactivation`; persistence in `repository.ts`; I/O at the route layer; presentation in components.
